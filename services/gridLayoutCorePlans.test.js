// Yahoska, 2026-10-17 12:11 PM: "too much going on in ONE paragraph, TOO MUCH TEXT. I skipped the WHY THESE PLANS …
// questions 1 and 2 underneath the grid … These should be 2 separate messages."
// + 12:13 PM: "Search all Dade Core plans for Dr X. What does she take?" = every regular (non-SNP) plan on the
// Miami-Dade grid, every carrier — "I asked what core plans, not just Devoted", "I want to see what's in network".
// + De La Guarda (NPI 1447909296) ❔ on Aetna H1609-093 on every run.
const test = require('node:test');
const assert = require('node:assert');
const N = require('./doctorPlanNarrow');
const A = require('./aetnaPublicSearch');
const W = require('../artifacts/client-workups.js');

const DOCS = require('./fixtures/robinForteDoctors.json');
const ASK = 'Her current plan: H5420-001.\nZIP/county: 33176 / Miami-Dade\nCarriers requested: Devoted, Humana, Aetna.';

test('grid message: title + grid + legend only — no "Why these plans", no Excluded list, no tagline', () => {
  const out = N.renderedAnswer(DOCS, ASK, {});
  const { grid } = N.splitFollowUp(out);
  assert.match(grid.split('\n')[0], /^\*\*Doctors × Devoted, Humana, Aetna\*\*$/);
  assert.doesNotMatch(grid, /Why these plans|Excluded:|a count, not a recommendation/);
  assert.match(grid, /^\| Doctor \|/m);
});

test('notes and questions go in a separate follow-up message after the grid', () => {
  const rendered = N.renderedAnswer(DOCS, ASK, {});
  const model = [
    'Here is the comparison.',
    '| Doctor | X |', '|---|---|',
    "⚠️ The Doctors HealthCare Plans check didn't finish for Dr. De La Guarda.",
    '1. Does the client have Medicaid or a Medicare Savings Program?',
    '2. Do you want me to retry the Doctors HealthCare Plans check for Dr. De La Guarda?',
  ].join('\n');
  const text = N.enforceRenderedTable(model, rendered);
  const { grid, followUp } = N.splitFollowUp(text);
  assert.ok(grid.startsWith(rendered.split(N.FOLLOW_UP_MARKER)[0].trim()));
  assert.doesNotMatch(grid, /retry|Medicaid|didn't finish/);
  assert.match(followUp, /Medicaid/);
  assert.match(followUp, /retry the Doctors HealthCare/);
  assert.ok(!followUp.includes(N.FOLLOW_UP_MARKER) && !grid.includes(N.FOLLOW_UP_MARKER));
});

test('no notes: one message only', () => {
  const rendered = N.renderedAnswer(DOCS, ASK, {});
  const { followUp } = N.splitFollowUp(N.enforceRenderedTable(rendered, rendered));
  assert.strictEqual(followUp, '');
});

test('chat response carries the follow-up as its own message', () => {
  const G = require('./grok');
  const chatResult = G._chatResultForTests || null;
  if (!chatResult) return;
  const out = chatResult({ text: `grid\n\n${N.FOLLOW_UP_MARKER}\nquestion?`, collectedToolResults: [], usageCalls: [], deadlineHit: false });
  assert.strictEqual(out.content[0].text, 'grid');
  assert.strictEqual(out.followUp.text, 'question?');
});

test('page history: the grid and its follow-up bubble are one assistant turn for the server', () => {
  const msgs = W.messagesForApi([
    { role: 'user', content: 'compare' },
    { role: 'assistant', content: '| Doctor | A |' },
    { role: 'assistant', content: 'Remove it?', followUpOf: true },
    { role: 'user', content: 'yes' },
  ], null);
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(msgs[1].content, '| Doctor | A |\n\nRemove it?');
});

const CORE_ASK = 'Search all Dade Core plans for Stephanie Sasha De La Guarda · Family Medicine · NPI 1447909296. What does she take?';
test('"all Dade Core plans" = every regular plan on the Miami-Dade grid, every carrier (not Devoted CORE)', () => {
  const msgs = W.messagesForApi([{ role: 'user', content: CORE_ASK }], {
    clientName: 'Robin Forte', zip: '33176', county: 'Miami-Dade', currentPlanIds: ['H5420-001'],
    plans: [{ carrier: 'UHC', planName: 'MedicareMax FL-0028', planId: 'H5420-001' }, { carrier: 'Doctors', planName: 'DrMax-Dade', planId: 'H4140-022' }],
    doctors: [{ name: 'Stephanie Sasha De La Guarda', npi: '1447909296' }], medications: [],
  });
  const askText = N.comparisonAskText(msgs, CORE_ASK);
  assert.match(askText, /Core plans: every regular \(non-SNP\) plan/);
  assert.match(askText, /^County: Miami-Dade\.$/m);
  assert.doesNotMatch(askText, /Carriers requested: Devoted|Named plan set/);
  const out = N.renderedAnswer(DOCS.filter((d) => /Guarda/.test(d.requestedName)), askText, {});
  assert.match(out, /^\*\*Stephanie Sasha De La Guarda × Miami-Dade core plans\*\*/);
  assert.match(out, /✅ \*\*In network \(\d+\)\*\*/);
  assert.match(out, /H5420-001/);
  assert.match(out, /❌ Not listed \(\d+\): .*Devoted .*Humana/);
  // Not a 20-column grid, not SNPs, no narrowing questions.
  assert.doesNotMatch(out, /^\| Doctor/m);
  assert.doesNotMatch(out, /C-SNP qualifying|Medicaid or a Medicare Savings|H1609-094|H1609-073|H1609-043/);
  for (const k of ['Devoted', 'Humana', 'Aetna', 'CarePlus', 'Florida Blue', 'UHC']) assert.match(out, new RegExp(k), k);
});

test('Aetna: compound surname searched whole; Medicare search read to the end with no listing = not listed on every Aetna plan', () => {
  assert.strictEqual(A.compoundLastName('Stephanie Sasha De La Guarda, DO'), 'De La Guarda');
  assert.strictEqual(A.compoundLastName('Glinos, George, MD'), '');
  const plans = A.gridAetnaPlansFor('33176');
  assert.ok(plans.some((p) => /H1609-093/.test(p)), plans.join(' / '));
});
