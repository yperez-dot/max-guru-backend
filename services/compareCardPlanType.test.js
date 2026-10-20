// The compare card ("Comparison results") reads plan-type asks exactly like chat (Yahoska, 2026-10-19: "only PPOs" on
// the card still showed the saved HMO plans). Robert and Andrea, Miami-Dade 33186, current plan UHC H5420-001 (HMO).
// Shared helpers: doctorPlanNarrow.textPlanTypeAsk / planTypeAsk (reading the ask) and planTypeAskLines (the ask lines
// selectComparison ranks from) — the card's compareJobs.askTextFor and the chat's comparisonAskText both use them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');
const C = require('./compareJobs');
const H = require('./golden/harness');
const W = require('../artifacts/client-workups.js');
const exp = require('../artifacts/comparison-export.js');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/scenarios', f), 'utf8'));
const SC = load('robert-andrea-only-ppos-doctor-candidates.json');
const PPOS = ['H7617-107', 'H7617-110', 'H7617-145', 'R0759-001'];
const PASTE = 'Robert and Andrea, 33186, Dr. Nathalie Regalado, Dr. Michael Weitz, Dr. Starr Koslow Mautner, Dr. Austin Bach, '
  + 'Dr. Yekutil Sandman, Dr. Ian Del Conde Pozzi, Dr. Daid Taub. Medicines: anastrozole 1mg, prolia, latanoprost, rosuvastatin, '
  + 'lisinopril, metoprolol succinate, amlodipine. Current plan UHC H5420-001.';

/** The card's own path: paste → /compare/parse → the job body the card sends (buildQueueJobBody) → the job. */
async function runCard(paste, extra = {}) {
  const f = C.parseCompareAsk(paste);
  const input = C.normalizeInput({
    clientName: f.clientName, zip: f.zip, doctors: f.doctors, meds: f.meds, plans: f.plans, terminatingPlan: f.terminatingPlan,
    planType: f.planType, planTop: f.planTop, currentPlans: f.currentPlans, wantsAlternatives: f.wantsAlternatives,
    carriers: f.carriers, noMedicaid: true, eligibility: { medicaid: 'none', csnp: 'none' }, year: f.year, ...extra,
  });
  const job = { input, status: 'queued', progress: { doctors: { done: 0, total: input.doctors.length }, meds: { done: 0, total: input.meds.length } }, result: {} };
  await C.runJob(job, { lookupOneDoctor: H.stubDoctorLookup(SC), lookupRx: H.stubRx(SC) });
  assert.equal(job.status, 'done', job.error || '');
  return { fields: f, input, result: job.result, follow: W.compareFollowUpLines(job.result) };
}

test('card paste "only PPOs": the 4 Dade PPOs, each its own column, no UHC H5420-001, one line saying why', async () => {
  for (const ask of ['Only PPOs.', 'only ppos', 'PPO only.', 'Show me the PPOs.', "just the PPO's", 'top 5 PPOs']) {
    const run = await runCard(`${PASTE} ${ask}`);
    assert.equal(run.fields.planType, 'ppo', ask);
    assert.deepEqual(run.fields.currentPlans, ['H5420-001'], ask);
    assert.deepEqual(run.result.planIds, PPOS, ask);
    assert.deepEqual(H.gridHeaderIds(run.result.doctorTable), PPOS, ask);
    assert.equal(run.result.sameNetwork.length, 0, `${ask}: no Humana Choice folded into another column`);
    assert.ok(run.follow.notes.includes('Current plan (UHC H5420-001, HMO) left out since you asked for PPOs only.'), ask);
    assert.ok(!run.result.planIds.some((id) => R.snpKind(N.gridRowFor(id, 'Miami-Dade') || {})), `${ask}: no SNP`);
  }
});

test('card "only PPOs": near-match doctor candidates (name, specialty, city, NPI) and the ranking note', async () => {
  const run = await runCard(`${PASTE} Only PPOs.`);
  const bubble = [...run.follow.questions, ...run.follow.notes].join('\n');
  assert.match(bubble, /"Yekutil Sandman" — closest: Yekutiel Sandman, MD \(Urology, Miami, NPI 1013111491\)/);
  assert.match(bubble, /"Daid Taub" — closest: David Andrew Taub, MD \(Urology, Boca Raton, NPI 1891804696\)/);
  assert.match(bubble, /Ranking left out Yekutil Sandman and Daid Taub \(not confirmed yet\)\./);
  assert.doesNotMatch(bubble, /providers below|Why these plans/i);
  assert.doesNotMatch(run.result.doctorTable, /closest:|No exact match/);
});

test('card "compare all HMOs": HMOs only, current UHC first; no type said: unchanged (HMO default, current first)', async () => {
  const hmo = await runCard(`${PASTE} Compare all HMOs.`);
  assert.equal(hmo.fields.planType, 'hmo');
  assert.equal(hmo.result.planIds[0], 'H5420-001');
  assert.ok(!hmo.result.planIds.some((id) => PPOS.includes(id)), hmo.result.planIds.join(','));
  assert.ok(!hmo.follow.notes.some((n) => /left out since/.test(n)));
  const plain = await runCard(`${PASTE} Is there something better?`);
  assert.equal(plain.fields.planType, '');
  assert.equal(plain.result.planIds[0], 'H5420-001');
  assert.ok(!plain.result.planIds.some((id) => PPOS.includes(id)));
});

test('a plan-type control / the Plans field: "PPO", "PPOs", "hmo only", any case', () => {
  const base = { zip: '33186', doctors: ['Michael Weitz'], plans: ['H5420-001'] };
  for (const v of ['PPO', 'ppos', "PPO's", 'Only PPOs', 'ppo only']) assert.equal(C.normalizeInput({ ...base, planType: v }).planType, 'ppo', v);
  for (const v of ['HMO', 'hmos', 'HMO ONLY']) assert.equal(C.normalizeInput({ ...base, planType: v }).planType, 'hmo', v);
  assert.equal(C.normalizeInput({ ...base, plans: ['H5420-001', 'only PPOs'] }).planType, 'ppo', 'typed in the Plans field');
  for (const v of ['', 'any', 'either is fine', 'HMO or PPO']) assert.equal(C.normalizeInput({ ...base, planType: v }).planType, '', v);
  assert.equal(C.normalizeInput({ ...base, planType: 'PPOs', planTop: 3 }).planTop, 3);
  // A plan ID or a carrier makes it a named / carrier ask, as in chat.
  assert.equal(C.parseCompareAsk('Robert 33186 Dr. Michael Weitz. Run humana ppo H7617-107.').planType, '');
  assert.equal(C.parseCompareAsk('Robert 33186 Dr. Michael Weitz. Show me humana ppos.').planType, '');
});

test('card named plans + "only PPOs": current plan out (HMO), the named plan a column, then the rest of the type', async () => {
  const run = await runCard(`${PASTE} Also R0759-001. Only PPOs.`);
  assert.equal(run.fields.planType, 'ppo');
  assert.equal(run.result.planIds[0], 'R0759-001', 'named plan right after the (left out) current plan');
  assert.deepEqual([...run.result.planIds].sort(), [...PPOS].sort());
});

test('the card and the chat give the same columns for the same ask', async () => {
  const cases = [
    ['robert-andrea-only-ppos-doctor-candidates.json', ['only PPOs']],
    ['robert-andrea-only-ppos-doctor-candidates.json', ['show me the PPOs']],
    ['robert-andrea-only-ppos-doctor-candidates.json', ['PPOs']],
    ['robert-andrea-only-ppos-doctor-candidates.json', ['compare all HMOs']],
    ['robert-andrea-only-ppos-doctor-candidates.json', ['rank the HMOs, top 5']],
    ['robert-andrea-only-ppos-doctor-candidates.json', ['rank the HMOs, top 5', 'only PPOs']],
    ['robert-andrea-only-ppos-doctor-candidates.json', ['only PPOs', 'compare all HMOs']],
    ['robert-andrea-only-ppos-confirm-candidates.json', null],
    ['robert-andrea-hmos-then-ppos.json', null],
    ['robert-andrea-ppos-then-hmos.json', null],
  ];
  for (const [file, messages] of cases) {
    const sc = load(file);
    const run = await H.runScenario(messages ? { ...sc, messages } : sc);
    const label = `${file} ${JSON.stringify(messages || sc.messages)}`;
    assert.deepEqual(H.gridHeaderIds(run.job.result.doctorTable), H.gridHeaderIds(run.chat.grid), label);
    // Same notes about the current plan and the ranking.
    const card = W.compareFollowUpLines(run.job.result).notes.filter((n) => /left out since|^Ranking left out/.test(n));
    const chat = String(run.chat.followUp || '').split('\n').filter((n) => /left out since|^Ranking left out/.test(n));
    assert.deepEqual(card, chat, label);
  }
});

test('card Export: the PPO table exports the PPO columns only — no current HMO added back', () => {
  const plans = PPOS.map((id) => { const g = N.gridRowFor(id, 'Miami-Dade') || {}; return { planId: id, carrier: g.carrier, planName: g.planName, county: 'Miami-Dade' }; });
  const history = [{ role: 'user', content: 'Robert and Andrea. ZIP 33186. 2027 plans.' }];
  // currentPlanIds as the card now sends it: her plan only when it is one of this table's columns.
  const cols = PPOS.map((x) => x.slice(0, 9));
  const current = ['H5420-001'].filter((id) => cols.includes(id));
  assert.deepEqual(current, []);
  const payload = exp.buildExportPayload(plans, 'Robert and Andrea. ZIP 33186. 2027 plans.', { currentPlanIds: current, userMessages: [history[0].content] });
  assert.deepEqual(payload.plans.map((p) => String(p.planId).toUpperCase().slice(0, 9)), PPOS);
});
