// Padron 8-doctor regression: doctors run in parallel, a stuck carrier never
// holds the batch past its deadline, and cut-off work lands in the cache.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const knobs = {
  carrierMs: 50,
  npiMs: 20,
  hangHumanaFor: new Set(),
  hangNpiFor: new Set(),
  sunfireCalls: [],
  humanaCalls: 0,
  resolveHumana: [],
};

function stub(modName, exportsObj) {
  const file = require.resolve(path.join(__dirname, modName));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

const NPI_BY_NAME = {};
function npiFor(name) {
  if (!NPI_BY_NAME[name]) NPI_BY_NAME[name] = String(1000000000 + Object.keys(NPI_BY_NAME).length + 1);
  return NPI_BY_NAME[name];
}

const { cleanDoctorQuery } = require('./npiRegistry');
delete require.cache[require.resolve('./npiRegistry')];
stub('npiRegistry', {
  cleanDoctorQuery,
  resolveNpiRecords: async ({ doctorName, npi }) => {
    if (knobs.hangNpiFor.has(doctorName)) await new Promise(() => {});
    await sleep(knobs.npiMs);
    if (/nobody/i.test(doctorName)) return [];
    const number = npi || npiFor(doctorName);
    return [{ number, basic: { first_name: doctorName.split(' ')[0], last_name: doctorName.split(' ').slice(-1)[0] }, taxonomies: [{ primary: true, desc: 'Internal Medicine' }], addresses: [] }];
  },
  displayName: (p) => `${p.basic.first_name} ${p.basic.last_name}`,
  allLocationAddresses: () => [{ address_1: '1 Main St', city: 'Weston', postal_code: '33332' }],
});
stub('doctorsHcp', { queryDoctorsHcp: async () => { await sleep(knobs.carrierMs); return { inNetwork: false }; }, PLAN_LABEL: 'Doctors HealthCare Plans' });
stub('aetnaPublicSearch', { queryAetnaPublic: async () => { await sleep(knobs.carrierMs); return { inNetwork: false, plans: [] }; }, CARRIER_LABEL: 'Aetna' });
stub('simplyFindcare', { querySimplyFindcare: async () => { await sleep(knobs.carrierMs); return { inNetwork: false, plans: [] }; }, CARRIER_LABEL: 'Simply' });
stub('uhcGuestSearch', {
  queryUhcGuest: async () => { await sleep(knobs.carrierMs); return { inNetwork: true, plans: ['UHC Preferred MA FL-0002 (HMO) (H1045-005)'], outOfNetworkPlans: [], year: '2027' }; },
  CARRIER_LABEL: 'UnitedHealthcare',
  PLAN_YEAR: '2027',
  formatUhcAgentNote: () => 'UHC note',
});
stub('humanaFindcare', {
  queryHumanaFindcare: async (npi) => {
    knobs.humanaCalls += 1;
    const name = Object.keys(NPI_BY_NAME).find((k) => NPI_BY_NAME[k] === npi);
    if (knobs.hangHumanaFor.has(name)) {
      await new Promise((resolve) => knobs.resolveHumana.push(resolve));
    } else {
      await sleep(knobs.carrierMs);
    }
    return { inNetwork: true, plans: ['Humana Gold Plus (H1036-065C)'], outOfNetworkPlans: [], checks: [{ status: 'in_network' }], year: '2027' };
  },
  CARRIER_LABEL: 'Humana',
  isHumanaLabel: (l) => /humana/i.test(l),
  formatHumanaAgentNote: () => 'Humana note',
});
stub('solisDirectory', { formatSolisNote: () => 'Solis: county PDF only.' });
stub('sunfireProvider', {
  querySunfireProviderList: async (opts) => {
    knobs.sunfireCalls.push(opts);
    return { ok: false, error: 'empty_json', plans: [] };
  },
  inNetworkLabelsFromSunfirePlans: () => [],
});

const originalFetch = global.fetch;
global.fetch = async () => ({ ok: false, json: async () => ({}) }); // FHIR misses

const { lookupProviderNetwork, clearProviderCache, normalizeDoctorList } = require('./providerNetwork');

const PADRON = [
  'Ernesto Padron', 'Oswaldo Sandoval', 'Carlos Sarduy', 'Eye Surgery Associates',
  'Michael Glassman', 'Jorge Diaz', 'Howard Bush', 'Alfred Desimone',
];

describe('lookup_provider_network batch (Padron 8 doctors)', () => {
  beforeEach(() => {
    clearProviderCache();
    knobs.carrierMs = 50;
    knobs.hangHumanaFor = new Set();
    knobs.hangNpiFor = new Set();
    knobs.sunfireCalls = [];
    knobs.humanaCalls = 0;
    knobs.resolveHumana = [];
  });
  after(() => {
    global.fetch = originalFetch;
  });

  it('runs all 8 doctors in parallel, not one after another', async () => {
    knobs.carrierMs = 200;
    const started = Date.now();
    const out = await lookupProviderNetwork({ doctors: PADRON.map((doctorName) => ({ doctorName })), zip: '33332' }, { deadlineAt: Date.now() + 5000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1200, `8 doctors took ${elapsed}ms — serial would be ~1.8s+`);
    assert.equal(out.expand.length, 8);
    assert.equal(out.structured.finished, 8);
    assert.match(out.text, /Finished: 8\/8/);
    for (const name of PADRON) assert.ok(out.text.includes(name), `${name} missing from batch text`);
  });

  it('returns by the deadline with NOT CONFIRMED for a stuck carrier and caches the late finish', async () => {
    knobs.hangHumanaFor = new Set(['Howard Bush']);
    const started = Date.now();
    const out = await lookupProviderNetwork({ doctors: PADRON.map((doctorName) => ({ doctorName })), zip: '33332' }, { deadlineAt: Date.now() + 600 });
    assert.ok(Date.now() - started < 1000, 'batch must not wait for the stuck Humana check');
    const bush = out.expand.find((d) => d.requestedName === 'Howard Bush');
    assert.equal(bush.status, 'partial');
    assert.ok(bush.pending.includes('Humana Find Care'));
    assert.match(out.text, /NOT CONFIRMED/);
    assert.equal(out.structured.finished, 7);

    // Humana answers after the chat wait; the next ask gets it from cache, no new Humana call.
    knobs.resolveHumana.forEach((r) => r());
    await sleep(80);
    const callsBefore = knobs.humanaCalls;
    const again = await lookupProviderNetwork({ doctors: [{ doctorName: 'Howard Bush' }, { doctorName: 'Jorge Diaz' }], zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(knobs.humanaCalls, callsBefore, 'resend must reuse cached lookups');
    assert.equal(again.structured.finished, 2);
    const bush2 = again.expand.find((d) => d.requestedName === 'Howard Bush');
    assert.equal(bush2.status, 'done');
    assert.ok(bush2.networks.find((n) => n.carrier === 'Humana').inNetwork);
  });

  it('marks a doctor whose NPI search never returns as NOT CONFIRMED (timeout)', async () => {
    knobs.hangNpiFor = new Set(['Carlos Sarduy']);
    const out = await lookupProviderNetwork({ doctors: [{ doctorName: 'Carlos Sarduy' }, { doctorName: 'Jorge Diaz' }], zip: '33332' }, { deadlineAt: Date.now() + 400 });
    const sarduy = out.expand.find((d) => d.requestedName === 'Carlos Sarduy');
    assert.equal(sarduy.status, 'timeout');
    assert.match(out.text, /Carlos Sarduy: NOT CONFIRMED/);
  });

  it('calls Sunfire without retry on the doctor path', async () => {
    await lookupProviderNetwork({ doctorName: 'Jorge Diaz', zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(knobs.sunfireCalls.length, 1);
    assert.equal(knobs.sunfireCalls[0].retry, false);
  });

  it('keeps the single-doctor shape for the UI export', async () => {
    const out = await lookupProviderNetwork({ doctorName: 'Jorge Diaz', zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(out.expand, undefined);
    assert.equal(out.structured.doctorName, 'Jorge Diaz');
    assert.ok(Array.isArray(out.structured.networks));
  });

  it('dedupes doctors and merges doctorName with doctors[]', () => {
    const list = normalizeDoctorList({ doctorName: 'Jorge Diaz', doctors: [{ doctorName: 'Jorge Diaz' }, 'Howard Bush', { npi: '1234567890' }] });
    assert.deepEqual(list.map((d) => d.doctorName), ['Jorge Diaz', 'Howard Bush', '1234567890']);
  });
  it('Padron output: carriers per doctor, no Cigna for 2027, coverage counts, narrowing questions', async () => {
    global.fetch = async (url) => (/cigna/.test(String(url))
      ? { ok: true, json: async () => ({ total: 1, entry: [{}] }) }
      : { ok: false, json: async () => ({}) });
    try {
      const out = await lookupProviderNetwork(
        { doctors: PADRON.map((doctorName) => ({ doctorName })), zip: '33332' },
        { deadlineAt: Date.now() + 3000, messages: [{ role: 'user', content: 'Maria & Gaspar Padron, ZIP 33332. Check these doctors In/Out and suggest 2-3 2027 plans' }] },
      );
      for (const d of out.expand) assert.ok(!d.carriersIn.includes('Cigna'), 'Cigna must not be a 2027 option');
      assert.doesNotMatch(out.text.split('Carrier-only hits')[0], /Cigna/);
      assert.match(out.text, /Humana Gold Plus \(H1036-065C\) — 8 in · 0 out · 0 unchecked/);
      assert.match(out.text, /Why these plans: \d+ eligible plans checked in Broward\./);
      assert.doesNotMatch(out.text.split('Why these plans')[1], /\b\d+\/8\b/, 'plan counts are "X in · Y out · Z unchecked", never "X/8"');
      assert.match(out.text, /Do Maria and Gaspar have Medicaid/);
      assert.match(out.text, /HMO OK|meds/i);
      assert.ok(out.text.length < 6000, `tool text should be compact, was ${out.text.length}`);
    } finally {
      global.fetch = async () => ({ ok: false, json: async () => ({}) });
    }
  });
  it('stops asking once the agent answered the narrowing questions', async () => {
    const messages = [
      { role: 'user', content: 'Maria & Gaspar Padron ZIP 33332, check doctors, suggest 2-3 plans' },
      { role: 'assistant', content: 'To narrow to 2–3 plans: 1. Medicaid or a Medicare Savings Program? 2. must-keep doctors? 3. HMO or PPO?' },
      { role: 'user', content: '1 no 2 Ernesto and Howard 3 HMO ok' },
    ];
    const out = await lookupProviderNetwork({ doctors: [{ doctorName: 'Ernesto Padron' }, { doctorName: 'Howard Bush' }], zip: '33332' }, { deadlineAt: Date.now() + 2000, messages });
    assert.match(out.text, /already answered the narrowing questions — present the table above \(2–3 plans\)/);
    assert.deepEqual(out.structured.questions, []);
  });
  it('runs every doctor\'s best NPI before anyone\'s backup NPI (Howard Bush fix)', async () => {
    const { createLimiter } = require('./providerNetwork');
    const run = createLimiter(1);
    const order = [];
    const job = (tag) => () => { order.push(tag); return sleep(5); };
    // Doctors 1..3 each enqueue NPI #1 (priority 0) then NPI #2 (priority 1), doctor by doctor.
    await Promise.all([
      run(job('d1-best'), 0), run(job('d1-backup'), 1),
      run(job('d2-best'), 0), run(job('d2-backup'), 1),
      run(job('d3-best'), 0), run(job('d3-backup'), 1),
    ]);
    assert.deepEqual(order, ['d1-best', 'd2-best', 'd3-best', 'd1-backup', 'd2-backup', 'd3-backup']);
  });
  it('a reopened workup name ("HOWARD BUSH M.D.") reuses the finished lookup', async () => {
    await lookupProviderNetwork({ doctors: [{ doctorName: 'Howard Bush Cardio' }, { doctorName: 'Jorge Diaz PCP' }], zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    const before = knobs.humanaCalls;
    const again = await lookupProviderNetwork({ doctors: [{ doctorName: 'HOWARD BUSH M.D.' }, { doctorName: 'Jorge Diaz' }], zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(knobs.humanaCalls, before, 'should come from cache');
    assert.equal(again.structured.finished, 2);
  });
});

describe('Padron narrowing constraints + grid', () => {
  const n = require('./doctorPlanNarrow');
  const ask = 'Maria & Gaspar Padron, ZIP 33332. Current plan H5420-014 terminating 2027. No Medicaid. HMO ok. Skip R0759-001 (non-commissionable). David Shenassa (must-keep). Meds: metformin';
  const mk = (nm, pl, out = []) => ({ requestedName: nm, doctorName: `${nm.toUpperCase()} M.D.`, status: 'done', carriersIn: ['UHC'], inNetworkPlans: pl, outOfNetworkPlans: out });
  const P = 'AARP Medicare Advantage from UHC FL-0031 (Regional PPO) (R0759-001)';
  const D = 'UHC Dual Complete FL-Q1 (PPO D-SNP) (H1889-002)';
  const H = 'UHC Preferred Medicare Advantage FL-0002 (HMO) (H1045-005)';
  const G = 'Humana Gold Plus (H1036-065C)';
  const T = 'UHC MedicareMax Complete Care FL-30 (H5420-014)';

  it('reads No Medicaid, skipped and terminating plans from the ask', () => {
    const c = n.askConstraints(ask);
    assert.equal(c.noMedicaid, true);
    assert.deepEqual([...c.skip].sort(), ['H5420-014', 'R0759-001']);
  });

  it('fallback is a doctor × plan table without D-SNP, skipped or terminating plans', () => {
    const text = n.fallbackAnswer([mk('Ernesto Padron', [P, D, H, G, T]), mk('Howard Bush', [P, D, H], [G])], ask);
    assert.match(text, /\| Doctor \| UHC Preferred MA FL-0002 HMO · H1045-005 \| Humana Gold Plus · H1036-065C \|/);
    assert.match(text, /\| Howard Bush \| ✅ In \| ❌ Out \|/);
    assert.doesNotMatch(text, /H1889-002|R0759-001|H5420-014|NPI|M\.D\./);
  });
});

describe('named plans become the columns', () => {
  const n = require('./doctorPlanNarrow');
  it('uses the 3 plans she named, not Max\'s own top 3', () => {
    const ask = 'Maria & Gaspar Padron, ZIP 33332. Current plan H5420-014 terminating 2027. No Medicaid. Meds: metformin. Compare Humana Gold Plus H1036-065C, Aetna Medicare Select H1609-018, Devoted C-SNP Enhanced H1290-073 — every doctor In/Out and the meds.';
    const doc = { requestedName: 'Howard Bush', doctorName: 'HOWARD BUSH M.D.', status: 'done', carriersIn: ['Devoted Health', 'Aetna Medicare', 'UnitedHealthcare'], inNetworkPlans: ['AARP Medicare Advantage from UHC FL-0031 (Regional PPO) (R0759-001)'], outOfNetworkPlans: ['Humana Gold Plus (H1036-065C)'] };
    const text = n.fallbackAnswer([doc], ask);
    assert.match(text, /\| Doctor \| Humana Gold Plus · H1036-065C \| Aetna Medicare Select · H1609-018 \| Devoted C-SNP Enhanced · H1290-073 \|/);
    assert.match(text, /\| Howard Bush \| ❌ Out \| ✅ In\* \| ✅ In \|/);
    assert.doesNotMatch(text, /R0759|H5420-014 ·|To narrow/);
  });
});

describe('follow-up plan edits + Devoted single network', () => {
  const n = require('./doctorPlanNarrow');
  const first = 'Maria & Gaspar Padron, ZIP 33332. Current plan H5420-014 terminating 2027. No Medicaid. Compare Humana Gold Plus H1036-065C, Aetna Medicare Select H1609-018, Devoted C-SNP Enhanced H1290-073.';
  it('"remove devoted, add H1045-005 instead" keeps Humana + Aetna and adds UHC', () => {
    const t = `${first}\nremove devoted from comparison, lets add UHC Preferred MA FL-0002 HMO · H1045-005 instead`;
    assert.deepEqual(n.namedPlansFromAsk(t, n.askConstraints(t)).map((p) => p.planId), ['H1036-065C', 'H1609-018', 'H1045-005']);
  });
  it('a fresh "compare X and Y" replaces the set', () => {
    const t = `${first}\ncompare H1036-065C and H1045-005`;
    assert.deepEqual(n.namedPlansFromAsk(t, n.askConstraints(t)).map((p) => p.planId), ['H1036-065C', 'H1045-005']);
  });
  it('a Devoted directory hit is ✅ In for the Devoted plan (one network for all plans)', () => {
    const doc = { requestedName: 'Howard Bush', status: 'done', carriersIn: ['Devoted Health'], inNetworkPlans: [], outOfNetworkPlans: [] };
    assert.match(n.fallbackAnswer([doc], first), /\| Howard Bush \| ❔ not confirmed \| ❔ not confirmed \| ✅ In \|/);
  });
});
