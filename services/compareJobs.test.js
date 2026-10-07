const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCompareAsk, normalizeInput, runJob, createJob, getJob } = require('./compareJobs');

const PADRON_ASK = 'Maria & Gaspar Padron, ZIP 33332. Current plan H5420-014 terminating 2027. No Medicaid. Doctors: Ernesto Padron PCP, Oswaldo Sandoval PCP, Carlos Sarduy GYN, Eye Surgery Associates, Michael Glassman, Jorge Diaz PCP, Howard Bush Cardio, Alfred Desimone Ortho, David Shenassa (must-keep). Meds: Jardiance 10mg, Mounjaro 10mg, atorvastatin 20mg, hydrochlorothiazide 25mg, levothyroxine, metformin. Compare Humana Gold Plus H1036-065C, Aetna Medicare Select H1609-018, Devoted C-SNP Enhanced H1290-073 — every doctor In/Out and the meds.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDoctor(plansIn, plansOut = []) {
  return async ({ doctorName }) => {
    await sleep(10);
    if (/nobody/i.test(doctorName)) return { status: 'not_found', structured: { doctorName, networks: [] } };
    return {
      status: 'done',
      structured: { doctorName: doctorName.toUpperCase(), npi: '1234567890', carriersIn: ['Humana'], inNetworkPlans: plansIn, outOfNetworkPlans: plansOut, networks: [] },
    };
  };
}

const fakeRx = async ({ drugName, planIds }) => {
  await sleep(5);
  const byPlanId = {};
  for (const id of planIds) byPlanId[id] = { planId: id, verified: true, tier: 1, coverage: 'covered', costShare: '$0' };
  return { drugName, lookups: Object.values(byPlanId), byPlanId };
};

describe('compare mode: parse the ask', () => {
  it('pulls client, ZIP, 9 doctors, 6 meds, 3 named plans, terminating plan, No Medicaid', () => {
    const f = parseCompareAsk(PADRON_ASK);
    assert.equal(f.clientName, 'Maria & Gaspar Padron');
    assert.equal(f.zip, '33332');
    assert.equal(f.doctors.length, 9);
    assert.deepEqual(f.doctors[8], { name: 'David Shenassa', mustKeep: true });
    assert.deepEqual(f.meds, ['Jardiance 10mg', 'Mounjaro 10mg', 'atorvastatin 20mg', 'hydrochlorothiazide 25mg', 'levothyroxine', 'metformin']);
    assert.deepEqual(f.plans, ['H1036-065C', 'H1609-018', 'H1290-073']);
    assert.equal(f.terminatingPlan, 'H5420-014');
    assert.equal(f.noMedicaid, true);
  });
});

describe('compare mode: job', () => {
  it('runs doctors + meds, uses the named plans, builds both tables and export toolResults', async () => {
    const job = {
      input: normalizeInput({ ...parseCompareAsk(PADRON_ASK) }),
      progress: { doctors: { done: 0, total: 9 }, meds: { done: 0, total: 6 } },
      result: {},
    };
    await runJob(job, { lookupOneDoctor: fakeDoctor(['Humana Gold Plus (H1036-065C)']), lookupRx: fakeRx });
    assert.equal(job.status, 'done');
    assert.equal(job.progress.doctors.done, 9);
    assert.equal(job.progress.meds.done, 6);
    assert.deepEqual(job.result.planIds, ['H1036-065C', 'H1609-018', 'H1290-073']);
    assert.match(job.result.doctorTable, /\| Ernesto Padron Pcp · NPI 1234567890 \| ✅ In \|/);
    assert.match(job.result.whyLine, /^Why these plans: the 3 plans you named/);
    assert.match(job.result.medsTable, /\| Jardiance 10mg \| T1 \$0 \| T1 \$0 \| T1 \$0 \|/);
    assert.equal(job.result.toolResults.filter((t) => t.tool === 'lookup_provider_network').length, 9);
    assert.equal(job.result.toolResults.filter((t) => t.tool === 'lookup_formulary').length, 6);
  });

  it('with no named plans, picks the top 3 by doctors in — never a D-SNP when No Medicaid', async () => {
    const job = {
      input: normalizeInput({ zip: '33332', noMedicaid: true, doctors: ['A Doc', 'B Doc'], meds: ['metformin'] }),
      progress: { doctors: { done: 0, total: 2 }, meds: { done: 0, total: 1 } },
      result: {},
    };
    await runJob(job, {
      lookupOneDoctor: fakeDoctor(['UHC Dual Complete FL-Q1 (PPO D-SNP) (H1889-002)', 'UHC Preferred Medicare Advantage FL-0002 (HMO) (H1045-005)']),
      lookupRx: fakeRx,
    });
    // never the D-SNP, and always at least 2 plans
    assert.ok(job.result.planIds.length >= 2);
    assert.ok(job.result.planIds.includes('H1045-005'));
    assert.ok(!job.result.planIds.includes('H1889-002'));
    assert.equal(job.result.planSource, 'top_doctor_coverage');
  });

  it('requires a ZIP and something to check; jobs are private to their owner', () => {
    assert.throws(() => createJob({ doctors: ['A'] }, 'a@x.com'), /ZIP/);
    assert.throws(() => createJob({ zip: '33332' }, 'a@x.com'), /doctor or medication/);
    const job = createJob({ zip: '33332', meds: ['metformin'] }, 'a@x.com', { lookupOneDoctor: fakeDoctor([]), lookupRx: fakeRx });
    assert.ok(getJob(job.id, 'a@x.com'));
    assert.equal(getJob(job.id, 'b@x.com'), null);
  });
});

describe('comparison queue: 2 at a time', () => {
  it('runs two jobs, holds the third as queued #1, then starts it when a slot frees', async () => {
    const { queueState, publicJob } = require('./compareJobs');
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowDoctor = async (d) => { await gate; return fakeDoctor([])(d); };
    const deps = { lookupOneDoctor: slowDoctor, lookupRx: fakeRx };
    const mk = (name) => createJob({ zip: '33332', clientName: name, doctors: ['A Doc'], meds: [] }, 'q@x.com', deps);
    const [a, b, c] = [mk('A'), mk('B'), mk('C')];
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(a.status, 'doctors');
    assert.equal(b.status, 'doctors');
    assert.equal(c.status, 'queued');
    assert.equal(publicJob(c).queuePosition, 1);
    assert.equal(queueState().active, 2);
    release();
    for (let i = 0; i < 100 && c.status !== 'done'; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.status, 'done');
    assert.equal(publicJob(c).queuePosition, 0);
    assert.equal(queueState().active, 0);
  });
});

describe('Dr. titles', () => { it('keeps full doctor names written with a Dr. title', () => {
  const ask = parseCompareAsk('Carmen Lopez, ZIP 33021, Broward\nDoctors: Dr. Jorge Perez (primary care), Dra. Maria Sanchez (orthopedics)\nMeds: Xarelto 20mg, Jardiance 10mg');
  assert.deepEqual(ask.doctors.map((d) => d.name), ['Jorge Perez (primary care)', 'Maria Sanchez (orthopedics)']);
  assert.deepEqual(ask.meds, ['Xarelto 20mg', 'Jardiance 10mg']);
}); });

describe('parseCompareAsk — free-form paste', () => {
  const PASTE = 'Marilyn and Angus butler. 33076.   Ashwin Mehta, Vivian Aguiar, Jorge G. Ruiz, Nathan Boire, Jose Guzman, Barry Sarkell, Marc Bosem, Jordan Elman. no meds. no medicaid. for 2026 they have UHC Preferred Medicare Advantage FL-0002 (HMO) (H1045-5-0). theyre wondering if theres something better. add their 2027 plan to the comparison too';
  it('reads a lowercase surname, unlabeled doctors, middle initials and short plan ids', () => {
    const f = parseCompareAsk(PASTE);
    assert.equal(f.clientName, 'Marilyn and Angus Butler');
    assert.equal(f.zip, '33076');
    assert.deepEqual(f.doctors.map((d) => d.name), ['Ashwin Mehta', 'Vivian Aguiar', 'Jorge G. Ruiz', 'Nathan Boire', 'Jose Guzman', 'Barry Sarkell', 'Marc Bosem', 'Jordan Elman']);
    assert.deepEqual(f.meds, []);
    assert.deepEqual(f.plans, ['H1045-005']);
    assert.equal(f.noMedicaid, true);
  });
  it('"Marilyn Angus butler." keeps the full name', () => {
    assert.equal(parseCompareAsk('Marilyn Angus butler. 33076. Ashwin Mehta, Vivian Aguiar. no meds').clientName, 'Marilyn Angus Butler');
  });
});

describe('parseCompareAsk — unlabeled doctors with Dr. and unlabeled meds', () => {
  it('reads "Dr." doctors and a plain meds sentence after the ZIP', () => {
    const f = parseCompareAsk('Maria Gonzalez, 33178. Dr. Jorge Perez, Ana Lee, Carlos Ruiz. Eliquis, metformin.');
    assert.deepEqual(f.doctors.map((d) => d.name), ['Jorge Perez', 'Ana Lee', 'Carlos Ruiz']);
    assert.deepEqual(f.meds, ['Eliquis', 'metformin']);
  });
  it('keeps doses and does not mistake "no meds / no medicaid" or doctor names for meds', () => {
    const a = parseCompareAsk('Test Client, 33178. Niraj Mehta, Jose L Ruiz. Eliquis, metformin 500mg. No medicaid.');
    assert.deepEqual(a.meds, ['Eliquis', 'metformin 500mg']);
    const b = parseCompareAsk('Marilyn Butler. 33076. Ashwin Mehta, Vivian Aguiar. no meds. no medicaid.');
    assert.deepEqual(b.meds, []);
    assert.equal(b.doctors.length, 2);
  });
});
