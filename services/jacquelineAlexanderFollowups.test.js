// Jacqueline Alexander, 2026-10-13: removed doctors came back in the export, the current plan was pinned when
// she said not to, and one reply with "yes" + corrections dropped her current plan, ignored the "yes" and left
// the confirmed Regalado match unchecked.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const E = require('../artifacts/comparison-export.js');

const PASTE = 'Jacqueline Alexander · ZIP 33186\nDoctors: Natalie Regalado - Baptist Medical Group; Andrew Sable - Gastro Health; Pasquel DeSantis - Endocrinologist - Baptist; German Ojeda-Correal - Baptist Spine Specialist; Patricia Mueller; Charles Kaiser; Elvin Silvestry - Dental Associates; Neeta Erinjerri - Surgeon at Baptist Cancer Institute; Alan Chu; James Esserman\nMeds: Atorvastatin; Gabapentin; Levothyroxine; Metoprolol; Ozempic; Pantoprazole; Telmisartan; Rinvoq\nPlans: H5420-001';
const A1 = [
  '**Comparison results**',
  'Answer these first — the results below are not final:',
  '1. No exact match for:',
  '• "Pasquel DeSantis - Endocrinologist - Baptist" — closest: Joseph Desantis, ARNP (Nurse Practitioner, Pediatrics, Miami); Paul Desantis, OD (Optometrist, Port St Lucie)',
  '• "Neeta Erinjerri - Surgeon at Baptist Cancer Institute" — did you mean Neeta Jane Erinjeri, MD (Surgery, Surgical Oncology, Miami)? (looks like a spelling difference)',
  'Reply "yes" to use the spelling found, or "Pasquel DeSantis - Endocrinologist - Baptist = Dr. Full Name". Also: Confirm the doctor match (their In/Out stays ❔ not confirmed until you do): Natalie Regalado - Baptist Medical Group → Natalie C Regalado Dc (NPI 1396060109). Right doctor? If not, tell me who (no NPI needed).',
  '2. No single plan has all the doctors. Which doctors are must-keep?',
].join('\n');
const REPLY = 'yes\nPasquel DeSantis - Endocrinologist - Baptist = Dr. Pascual De Santis, MD\nYes, Natalie C Regalado Dc';
const msgs = (reply) => [{ role: 'user', content: PASTE }, { role: 'assistant', content: A1 }, { role: 'user', content: reply }];
const mk = (n, extra) => ({ requestedName: n, doctorName: n, status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: [], outOfNetworkPlans: [], ...(extra || {}) });

test('1. export: removing doctors keeps the newer, smaller table (no resurrected rows)', () => {
  const t = (rows) => `| Doctor | UHC MedicareMax · H5420-001 | Doctors DrMax · H4140-022 |\n|---|---|---|\n${rows.map((r) => `| ${r} | ✅ In | ✅ In |`).join('\n')}`;
  const wide = t(['Alan Chu', 'Andrew Sable', 'Charles Kaiser', 'James Esserman']);
  const small = t(['Alan Chu', 'Andrew Sable']);
  const removed = E.latestChatTable([{ role: 'assistant', content: wide }, { role: 'user', content: 'remove Dr. Kaiser and Dr. Esserman' }, { role: 'assistant', content: small }], (x) => x);
  assert.equal(removed.rows.length, 2);
  assert.ok(!removed.rows.some((r) => /Kaiser|Esserman/.test(r.name)));
  // A narrow follow-up with no remove wording still merges into the wide base (old behavior).
  const narrow = E.latestChatTable([{ role: 'assistant', content: wide }, { role: 'user', content: 'try Alan Chu again' }, { role: 'assistant', content: small }], (x) => x);
  assert.equal(narrow.rows.length, 4);
  const html = require('fs').readFileSync(require('path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /She removed doctors after the wide table/);
});

test('2. default pin: skipped / terminating / "without the current plan" is not pinned', () => {
  const docs = ['A One', 'B Two'].map((n) => mk(n));
  const base = 'Her current plan: H5420-001.\nMaria ZIP 33186.';
  assert.equal(N.selectComparison(docs, base, {}).columns[0].planId, 'H5420-001');
  for (const extra of ['Compare without H5420-001.', 'H5420-001 is terminating.', 'Compare without the current plan.', 'not that plan']) {
    const cols = N.selectComparison(docs, `${base}\n${extra}`, {}).columns.map((c) => c.planId);
    assert.ok(!cols.some((id) => id.startsWith('H5420-001')), `${extra} → ${cols.join(',')}`);
  }
});

test('3. her current plan stays the first column on the follow-up turn', () => {
  const ask = N.comparisonAskText(msgs(REPLY));
  assert.match(ask, /^Her current plan: H5420-001\./m);
  const docs = ['A One', 'B Two'].map((n) => mk(n));
  assert.equal(N.selectComparison(docs, ask, {}).columns[0].planId, 'H5420-001');
  // Plan set carried from the previous table's other columns (six plans, current plan missing): it is added back first.
  const named = ['H4140-022', 'H1609-093', 'H4140-023', 'H5431-001', 'H1290-001', 'H1035-017'].map((planId) => ({ planId, name: planId }));
  const sel = N.selectComparison(docs, ask, { named });
  assert.equal(sel.columns[0].planId, 'H5420-001', sel.columns.map((c) => c.planId).join(','));
  assert.equal(sel.columns.length, 3);
});

test('4. a bare "yes" line accepts the suggested spelling alongside other corrections', () => {
  for (const reply of [REPLY, 'Pasquel DeSantis - Endocrinologist - Baptist = Dr. Pascual De Santis, MD\nyes\nYes, Natalie C Regalado Dc']) {
    const fu = N.comparisonFollowUp(msgs(reply));
    assert.ok(fu);
    assert.ok(fu.doctors.includes('Neeta Jane Erinjeri'), fu.doctors.join(' | '));
    assert.ok(!fu.doctors.some((d) => /Erinjerri/.test(d)));
    assert.ok(fu.doctors.some((d) => /Pascual De Santis/.test(d)));
  }
});

test('5. "Yes, Natalie C Regalado Dc" looks her up by the confirmed NPI and keeps the match confirmed', () => {
  const fu = N.comparisonFollowUp(msgs(REPLY));
  assert.equal(fu.npis['Natalie Regalado - Baptist Medical Group'], '1396060109');
  const ask = N.comparisonAskText(msgs(REPLY));
  const nat = mk('Natalie Regalado - Baptist Medical Group', { doctorName: 'Natalie C Regalado Dc', npi: '1396060109', inNetworkPlans: ['H5420-001'], carriersIn: ['UHC'] });
  const sel = N.selectComparison([nat, mk('B Two')], ask, {});
  assert.equal(sel.doctors[0].identityPending, '');
  assert.deepEqual(sel.doctors[0].inNetworkPlans, ['H5420-001']);
  // No confirmation → no NPI forced.
  const fu2 = N.comparisonFollowUp(msgs('yes\nPasquel DeSantis - Endocrinologist - Baptist = Dr. Pascual De Santis, MD'));
  assert.ok(!fu2.npis);
});

test('regression: carrier words do not count as removing doctors in the export', () => {
  const t = (rows) => `| Doctor | UHC MedicareMax · H5420-001 | Doctors DrMax · H4140-022 |\n|---|---|---|\n${rows.map((r) => `| ${r} | ✅ In | ✅ In |`).join('\n')}`;
  const wide = t(['Alan Chu', 'Andrew Sable', 'Charles Kaiser', 'James Esserman']);
  const one = t(['Alan Dal Pra']);
  const run = (say, small) => E.latestChatTable([{ role: 'assistant', content: wide }, { role: 'user', content: say }, { role: 'assistant', content: small || one }], (x) => x);
  assert.equal(run('exclude Humana, try Alan Dal Pra').rows.length, 4);
  assert.equal(run('without Aetna please').rows.length, 4);
  const two = t(['Alan Chu', 'Andrew Sable']);
  assert.equal(run('without Dr. Kaiser', two).rows.length, 2);
  assert.equal(run('drop Kaiser and Esserman', two).rows.length, 2);
});

test('regression: "it" in a reply does not drop the current plan', () => {
  const docs = ['A One', 'B Two'].map((n) => mk(n));
  const base = 'Her current plan: H5420-001.\nMaria ZIP 33186.';
  for (const extra of ["no it's Zubair Ansari", 'drop it']) {
    assert.equal(N.selectComparison(docs, `${base}\n${extra}`, {}).columns[0].planId, 'H5420-001', extra);
  }
  for (const extra of ['without this plan', 'exclude the current plan']) {
    const cols = N.selectComparison(docs, `${base}\n${extra}`, {}).columns.map((c) => c.planId);
    assert.ok(!cols.some((id) => id.startsWith('H5420-001')), extra);
  }
});
