// Robin Forte, 2026-10-17 12:31 PM ET (live after #232): she loaded the saved workup — 4 plans (UHC H5420-001, Devoted
// H1290-001, Humana H1036-054C, Aetna H1609-093), doctors De La Guarda + Glinos — and got a one-column grid
// ("Plans: H5420-001") that still printed "Why these plans: the 1 plan you named — no plans added or swapped."
// Rules (Yahoska): a follow-up on a loaded workup keeps ALL saved plans and re-runs ALL saved doctors unless she gives
// a clear new set ("only H5420-001", "compare X and Y"). Mentioning one plan or one doctor never narrows. No
// "Why these plans" line anywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('./doctorPlanNarrow');
const W = require('../artifacts/client-workups.js');
const { conversationAskText } = require('./planYear');
const { normalizeWorkupInput } = require('./workups');

const SAVED = ['H5420-001', 'H1290-001', 'H1036-054C', 'H1609-093'];
const WORKUP = {
  clientName: 'Robin Forte', zip: '33176', county: 'Miami-Dade', currentPlanIds: ['H5420-001'],
  planIds: SAVED,
  plans: [
    { carrier: 'UHC', planName: 'UHC MedicareMax FL-0028', planId: 'H5420-001' },
    { carrier: 'Devoted', planName: 'Devoted CORE 001', planId: 'H1290-001' },
    { carrier: 'Humana', planName: 'Humana Gold Plus', planId: 'H1036-054C' },
    { carrier: 'Aetna', planName: 'Aetna Medicare Select Care', planId: 'H1609-093' },
  ],
  doctors: [{ name: 'Stephanie Sasha De La Guarda', npi: '1447909296' }, { name: 'George Demetrios Glinos', npi: '1881199586' }],
  medications: [],
};
const DOCS = require('./fixtures/robinForteDoctors.json');
const msgsFor = (text) => W.messagesForApi([{ role: 'user', content: text }], WORKUP);
const askFor = (text) => { const m = msgsFor(text); return N.comparisonAskText(m, conversationAskText(m)); };
const plansFor = (text) => { const t = askFor(text); return N.namedPlansFromAsk(t, N.askConstraints(t)).map((p) => p.planId); };

const MENTIONS = ['check Glinos on H5420-001', 'is Glinos in on UHC FL-0028?', 'add George Glinos', 'just check Glinos on H5420-001', 'What does De La Guarda take?'];

for (const msg of MENTIONS) {
  test(`loaded Robin workup + "${msg}" keeps all 4 saved plans`, () => {
    assert.deepEqual(plansFor(msg), SAVED);
  });
}

for (const msg of ['check Glinos on H5420-001', 'is Glinos in on UHC FL-0028?', 'add George Glinos']) {
  test(`"${msg}" re-runs both saved doctors (not just Glinos)`, () => {
    const f = N.comparisonFollowUp(msgsFor(msg));
    assert.ok(f, 'the server must re-run the comparison');
    assert.deepEqual(f.doctors, ['Stephanie Sasha De La Guarda', 'George Demetrios Glinos']);
    assert.equal(f.zip, '33176');
  });
}

test('the grid for "check Glinos on H5420-001" has all 4 saved plans as columns, and no "Why these plans"', () => {
  const out = N.renderedAnswer(DOCS, askFor('check Glinos on H5420-001'), {});
  const head = out.split('\n').find((l) => /^\| Doctor/.test(l));
  for (const id of SAVED) assert.match(head, new RegExp(id), `missing ${id}: ${head}`);
  assert.doesNotMatch(out, /Why these plans|Excluded:/);
});

test('a plan she adds joins the saved 4; a doctor she adds joins the run', () => {
  assert.deepEqual(plansFor('check Glinos on H5420-001 and H1045-005'), [...SAVED, 'H1045-005']);
  const f = N.comparisonFollowUp(msgsFor('add Dr. Jane Roe'));
  assert.deepEqual(f.doctors, ['Stephanie Sasha De La Guarda', 'George Demetrios Glinos', 'Jane Roe']);
});

test('only a clear new set narrows: "only", "just these", "compare X and Y", "lets do X, Y"; removals still remove', () => {
  assert.deepEqual(plansFor('only H5420-001'), ['H5420-001']);
  assert.deepEqual(plansFor('just H5420-001'), ['H5420-001']);
  assert.deepEqual(plansFor('compare H5420-001 and H1609-093'), ['H5420-001', 'H1609-093']);
  assert.deepEqual(plansFor('lets do H5420-001, H1609-093'), ['H5420-001', 'H1609-093']);
  assert.deepEqual(plansFor('drop H1290-001'), ['H5420-001', 'H1036-054C', 'H1609-093']);
  assert.deepEqual(plansFor('do they take H5420-001 and H1609-093?'), SAVED, '"do they take …" is a question, not a new set');
});

test('no "Why these plans" in any reply text: grid, fallback, model tool text, chat response', () => {
  const ask = askFor('check Glinos on H5420-001');
  assert.doesNotMatch(N.renderedAnswer(DOCS, ask, {}), /Why these plans/);
  assert.doesNotMatch(N.fallbackAnswer(DOCS, ask, {}), /Why these plans|^Excluded:/m);
  assert.doesNotMatch(N.batchSummaryForModel(DOCS, ask, {}).text, /^\**\s*Why these plans/m);
  const G = require('./grok');
  const out = G._chatResultForTests({
    text: '**Doctors × top plans**\nWhy these plans: the 1 plan you named — no plans added or swapped.\n\n| Doctor | A |\n|---|---|\n| X | ✅ In |\n\n' +
      `${N.FOLLOW_UP_MARKER}\n**Why these plans:** best of 9.\nExcluded: D-SNPs.\nAny meds?`,
    collectedToolResults: [], usageCalls: [], deadlineHit: false,
  });
  assert.doesNotMatch(out.content[0].text, /Why these plans/);
  assert.match(out.content[0].text, /\| X \| ✅ In \|/);
  assert.equal(out.followUp.text, 'Any meds?');
});

test('compare-job card: the page never renders result.whyLine, and saved results drop it', () => {
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.doesNotMatch(html, /result\.whyLine/);
  const saved = normalizeWorkupInput({ clientName: 'Robin Forte', compareResult: { planIds: ['H5420-001'], whyLine: 'Why these plans: the 1 plan you named — no plans added or swapped.', header: 'x' } });
  assert.equal(saved.compareResult.whyLine, undefined);
  assert.equal(saved.compareResult.header, 'x');
});

test('reopening the workup: the old 1-plan grid is stale against 4 saved plans and is not shown', () => {
  const old = { planIds: ['H5420-001'] };
  assert.deepEqual(W.stalePlansForResult(WORKUP, old), ['H1290-001', 'H1036-054C', 'H1609-093']);
  assert.match(W.staleResultNote(WORKUP, old), /only had H5420-001\. .*all 4 saved plans/);
  assert.deepEqual(W.stalePlansForResult(WORKUP, { planIds: SAVED }), []);
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /missingFrom\(wsResult\)\.length\) next\.push\(staleNote\(wsResult\)\)/);
  assert.match(html, /missingFrom\(workup\.compareResult\)\.length\) next\.push\(staleNote\(workup\.compareResult\)\)/);
});
