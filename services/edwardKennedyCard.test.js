// Edward Kennedy, 2026-10-17 (live after #233): loaded workup, ZIP 33193, 3 saved plans (H1036-054C, H5420-001,
// H4140-022). The comparison card's grid had all 3 plans, but (1) its header still said "Plans: H5420-001" and
// (2) the yellow "Answer these first — the results below are not final" box (no exact match for "Martin Ciro",
// must-keep doctors) sat ABOVE the grid in the same card. Rule (Yahoska): the grid is its own bubble; questions and
// notes go in a separate bubble AFTER it. Plus: a loaded workup shows her ORIGINAL request.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCompareAsk, normalizeInput, runJob } = require('./compareJobs');
const { WorkupStore } = require('./workups');
const W = require('../artifacts/client-workups.js');

const HTML = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
const ASK = 'Edward Kennedy, ZIP 33193. Doctors: Martin Ciro, Ana Lopez. Current plan UHC MedicareMax FL-0028 H5420-001. No Medicaid. Wondering if there is something better.';
const PLANS_IN = ['Humana Gold Plus (HMO) (H1036-054C)', 'UHC MedicareMax Medicare Advantage FL-0028 (HMO) (H5420-001)', 'Doctors HealthCare DrMax-Dade (HMO) (H4140-022)'];
const fakeDoctor = async ({ doctorName }) => (/ciro/i.test(doctorName)
  ? { status: 'not_found', structured: { doctorName, networks: [] } }
  : { status: 'done', structured: { doctorName: doctorName.toUpperCase(), npi: '1234567890', carriersIn: ['Humana', 'UnitedHealthcare', 'Doctors HealthCare'], inNetworkPlans: PLANS_IN, outOfNetworkPlans: [], networks: [] } });
const fakeRx = async ({ drugName }) => ({ drugName, lookups: [], byPlanId: {} });

async function edwardJob() {
  const f = parseCompareAsk(ASK);
  const job = { input: normalizeInput({ ...f, plans: ['H5420-001'], wantsAlternatives: true }), progress: { doctors: { done: 0, total: 2 }, meds: { done: 0, total: 0 } }, result: {} };
  await runJob(job, { lookupOneDoctor: fakeDoctor, lookupRx: fakeRx });
  return job;
}

describe('Edward Kennedy comparison card', () => {
  it('the card\'s "Plans:" line lists every grid column, not just the typed H5420-001', async () => {
    const job = await edwardJob();
    const ids = job.result.planIds;
    assert.ok(ids.length >= 2 && ids.includes('H5420-001'), `grid columns: ${ids}`);
    assert.equal(job.result.planLabels.length, ids.length);
    ids.forEach((id, i) => assert.match(job.result.planLabels[i], new RegExp(`${id}\\)?$`)));
    const line = W.comparePlansLine(job.result, ['H5420-001']);
    for (const id of ids) assert.match(line, new RegExp(id));
    assert.notEqual(line, 'H5420-001');
    // Before it runs, the line is what she typed; an older saved result with planIds only still lists them.
    assert.equal(W.comparePlansLine(null, ['H5420-001']), 'H5420-001');
    assert.equal(W.comparePlansLine({ planIds: ['H1036-054C', 'H5420-001', 'H4140-022'] }, ['H5420-001']), 'H1036-054C, H5420-001, H4140-022');
  });

  it('questions ("Martin Ciro" no match) and notes come out as a separate follow-up, questions first', async () => {
    const job = await edwardJob();
    const shown = job.result.planIds[1];
    const fu = W.compareFollowUpLines({ ...job.result, couldNotVerify: { count: 1, plans: [{ name: 'X', planId: shown }] }, flags: ['⚠️ note'] });
    assert.ok(fu.questions.some((q) => /Martin Ciro/i.test(q)), `questions: ${JSON.stringify(fu.questions)}`);
    assert.deepEqual(fu.notes, [`Could not verify 1 plan (most doctors unchecked): ${shown}.`, '⚠️ note']);
    // A plan outside the grid never gets a note (Tony & Gerry Cabrera, 2026-10-19: H1035-017).
    const out = W.compareFollowUpLines({ ...job.result, couldNotVerify: { count: 1, plans: [{ name: 'X', planId: 'H1035-017' }] } });
    // The only note left: the ranking left the unconfirmed doctor out (ranked tables say so — Robert and Andrea, 2026-10-19).
    assert.deepEqual(out.notes, ["Ranking left out Martin Ciro (not confirmed yet). Confirm the doctor and I'll re-check every plan in the table and re-rank."]);
    const skip = W.compareFollowUpLines({ questions: ['Does the client have a C-SNP qualifying chronic condition, confirmed by diagnosis?', 'Q2?'] }, { skipQuestion: /C-SNP qualifying chronic condition/ });
    assert.deepEqual(skip.questions, ['Q2?']);
    assert.deepEqual(W.compareFollowUpLines({}), { questions: [], notes: [] });
  });

  it('page: the grid card holds no questions/notes; CompareFollowUp is its own bubble AFTER the card', () => {
    const card = HTML.slice(HTML.indexOf('function CompareResult('), HTML.indexOf('// Questions and notes from a comparison card'));
    assert.doesNotMatch(card, /Answer these first|result\.questions|couldNotVerify|result\.flags/);
    assert.match(HTML, /\{stage === "done" && result && <CompareFollowUp result=\{result\} askedEligibility \/>\}\n  <\/>\);/);
    assert.match(HTML, /<CompareResult result=\{m\.result\} \/>\n\s*<\/div>\n\s*<\/div>\n\s*<CompareFollowUp result=\{m\.result\} \/>/);
    assert.match(HTML, /window\.MaxClientWorkups\.comparePlansLine\(stage === "done" \? result : null, linesOf\(f\.plans\)\)/);
  });
});

describe('loaded workup shows her ORIGINAL request', () => {
  const OWNER = 'yperez@healthexps.com';
  const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-orig-')); return { store: new WorkupStore({ filePath: path.join(dir, 'w.json') }), done: () => fs.rmSync(dir, { recursive: true, force: true }) }; };

  it('saved when the workup is created, kept (never replaced) on later saves', () => {
    const { store, done } = tmp();
    try {
      const a = store.upsert(OWNER, { clientName: 'Edward Kennedy', zip: '33193', plans: [], originalQuery: ASK });
      assert.equal(a.workup ? a.workup.originalQuery : a.originalQuery, ASK);
      const id = (a.workup || a).id;
      const b = store.upsert(OWNER, { id, clientName: 'Edward Kennedy', zip: '33193', plans: [], originalQuery: 'is Martin Ciro in on H5420-001?' });
      assert.equal((b.workup || b).originalQuery, ASK);
    } finally { done(); }
  });

  it('an existing workup with none never gets a later message passed off as the original', () => {
    const { store, done } = tmp();
    try {
      const a = store.upsert(OWNER, { clientName: 'Edward Kennedy', zip: '33193', plans: [] });
      const id = (a.workup || a).id;
      assert.equal((a.workup || a).originalQuery, '');
      const b = store.upsert(OWNER, { id, clientName: 'Edward Kennedy', zip: '33193', plans: [], originalQuery: 'check Ciro again' });
      assert.equal((b.workup || b).originalQuery, '');
    } finally { done(); }
  });

  it('banner text: saved original, else this browser\'s New-client paste, else nothing (never made up)', () => {
    assert.equal(W.originalQueryFor({ originalQuery: ASK }, { rawText: 'other' }), ASK);
    assert.equal(W.originalQueryFor({}, { rawText: '  ' + ASK + ' ' }), ASK);
    assert.equal(W.originalQueryFor({ clientName: 'Edward Kennedy' }, null), '');
    assert.equal(W.originalQueryIsLong(ASK), false);
    assert.equal(W.originalQueryIsLong('x'.repeat(300)), true);
    assert.equal(W.originalQueryIsLong('a\nb\nc\nd'), true);
    assert.match(HTML, /data-testid="workup-original-query"/);
    assert.match(HTML, /<details data-testid="workup-original-query"/);
  });

  it('chat-started workup: the first message she typed (not the loaded-workup context, not images)', () => {
    const ctx = W.compactWorkupContext({ clientName: 'Edward Kennedy', zip: '33193', plans: [], doctors: [], medications: [] });
    assert.equal(W.firstUserQuery([{ role: 'assistant', content: 'hi' }, { role: 'user', content: ASK }, { role: 'user', content: 'later' }]), ASK);
    assert.equal(W.firstUserQuery([{ role: 'user', content: ctx }, { role: 'user', content: 'later' }]), 'later');
    assert.equal(W.firstUserQuery([]), '');
    assert.match(HTML, /originalQuery: rawText \}\);/);
    assert.match(HTML, /if \(!prev\) \{\n\s*const first = window\.MaxClientWorkups\.firstUserQuery\(messagesRef\.current, userMessageText\);/);
  });
});

describe('Edward Kennedy export: current plan first, clean doctor names', () => {
  const exp = require('../artifacts/comparison-export.js');
  const PLANS = [
    { planId: 'H1036-054C', carrier: 'Humana', planName: 'Humana Gold Plus', county: 'Miami-Dade' },
    { planId: 'H5420-001', carrier: 'UnitedHealthcare', planName: 'UHC MedicareMax FL-0028', county: 'Miami-Dade' },
    { planId: 'H4140-022', carrier: 'Doctors HealthCare', planName: 'Doctors DrMax-Dade', county: 'Miami-Dade' },
  ];
  const WK = {
    clientName: 'Edward Kennedy', zip: '33193', county: 'Miami-Dade', currentPlanIds: ['H5420-001'], plans: PLANS,
    doctors: [
      { name: 'Dr. David A Rodriguez M D', npi: '1111111111', byPlanId: { 'H5420-001': 'IN', 'H1036-054C': 'OUT' } },
      { name: 'Dr. Miami Healthy Smiles', npi: '1306462213', byPlanId: { 'H4140-022': 'IN' } },
    ],
    medications: [],
  };
  const header = (model) => model.aoa.find((r) => r.some((c) => /H5420-001|H1036-054C/.test(String(c))));

  it('saved workup export (Export buttons on the loaded card): UHC H5420-001 is the first plan column', () => {
    const payload = W.workupToExportPayload(WK, PLANS);
    assert.deepEqual(payload.currentPlanIds, ['H5420-001']);
    for (const keep of [false, true]) {
      const model = exp.buildComparisonModel({ ...payload, keepPlanOrder: keep });
      assert.deepEqual(model.payload.plans.map((p) => p.planId), ['H5420-001', 'H1036-054C', 'H4140-022'], `keepPlanOrder=${keep}`);
      const h = header(model);
      assert.ok(h && /H5420-001/.test(String(h[1])), `first column: ${h && h[1]}`);
    }
  });

  it('doctor statuses stay with their plan after the reorder', () => {
    const model = exp.buildComparisonModel({ ...W.workupToExportPayload(WK, PLANS), keepPlanOrder: true });
    const dr = model.payload.doctors.find((d) => /Rodriguez/.test(d.name));
    assert.match(String(dr.statuses[0]), /^in network/i, 'H5420-001 (first column) is In');
    assert.match(String(dr.statuses[1]), /^(?:out|not in network)/i, 'H1036-054C (second column) is Out');
  });

  it('no current plan known: order unchanged; said in her words: that plan first', () => {
    assert.deepEqual(exp.currentPlanFirst(PLANS, []).map((p) => p.planId), ['H1036-054C', 'H5420-001', 'H4140-022']);
    assert.deepEqual(exp.currentPlanIdsFromText('his current plan is UHC MedicareMax H5420-001'), ['H5420-001']);
  });

  it('names: no "Dr." on a practice; degrees dropped when "Dr." is added', () => {
    const model = exp.buildComparisonModel(W.workupToExportPayload(WK, PLANS));
    const names = model.payload.doctors.map((d) => d.name);
    assert.ok(names.includes('Dr. David A Rodriguez'), names.join(' | '));
    assert.ok(names.includes('Miami Healthy Smiles'), names.join(' | '));
    const f = exp.formatDoctorExportName;
    assert.equal(f('Dr. David A Rodriguez M D'), 'Dr. David A Rodriguez');
    assert.equal(f('Dr. DAVID A RODRIGUEZ MD'), 'Dr. David A Rodriguez');
    assert.equal(f('Dr. Jose Ruiz, M.D.'), 'Dr. Jose Ruiz');
    assert.equal(f('Dr. Ana Lopez DO'), 'Dr. Ana Lopez');
    assert.equal(f('Dr. John Smith Jr'), 'Dr. John Smith Jr');
    assert.equal(f('Dr. Miami Healthy Smiles'), 'Miami Healthy Smiles');
    assert.equal(f('Dr. Eye Surgery Associates'), 'Eye Surgery Associates');
    assert.equal(f('Dr. Ana Lopez', { entityType: 'NPI-2' }), 'Ana Lopez');
    assert.equal(f('Dr. Maria Pa Lopez'), 'Dr. Maria Pa Lopez');
    assert.equal(f('Ana Lopez'), 'Ana Lopez');
  });
});
