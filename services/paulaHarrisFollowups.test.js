// Paula Harris, 2026-10-13: correcting one doctor re-ran only the corrected two and swapped her plans.
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');

const CTX = 'LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript). Resume these saved facts.\nClient: Paula Harris\nZIP/county: 33169 / Miami-Dade\nPlans:\n- UHC MedicareMax Complete Care FL-30 (H5420-014)\n- Aetna Medicare Chronic Care (H1609-094)\nDoctors (names only — pass exactly these names to lookup_provider_network): Gloria St; Hoa Nguyne; Justin Townsend; George Munoz; Patricia Neuman Guerra; Wen Wu\nMedications:\n- amlodipine';
const A1 = '**Doctors × top plans**\nNo NPI match: Hoa Nguyne — try the NPI or practice name.';
const base = [{ role: 'user', content: CTX }, { role: 'assistant', content: A1 }];

test('a doctor correction on a loaded workup re-runs ALL saved doctors with the fixes', () => {
  const fu = N.comparisonFollowUp([...base, { role: 'user', content: 'its Theresa Gloria St. Phillipe APRN, and Hoa Nguyen' }]);
  assert.ok(fu, 'server must run it');
  assert.equal(fu.doctors.length, 6);
  assert.match(fu.doctors[0], /Theresa Gloria St/);
  assert.equal(fu.doctors[1], 'Hoa Nguyen');
  assert.equal(fu.zip, '33169');
});

test('an NPI for a doctor is passed on, and "she is with UHC" is not a carrier ask', () => {
  const msgs = [...base, { role: 'user', content: 'its Theresa Gloria St. Phillipe APRN, and Hoa Nguyen' }, { role: 'assistant', content: 'Confirm the match: Theresa → NPI?' }, { role: 'user', content: 'use this for Theresa 1306218243 she is with UHC' }];
  const fu = N.comparisonFollowUp(msgs);
  assert.equal(fu.doctors.length, 6);
  assert.equal(Object.values(fu.npis)[0], '1306218243');
  assert.deepEqual(R.carriersRequested('use this for Theresa 1306218243 she is with UHC'), []);
  assert.deepEqual(R.carriersRequested('compare with Humana and Aetna'), ['Humana', 'Aetna']);
});

test('the page keeps saved doctors and meds when a narrowed table is saved', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(src, /deletes the rest of the saved list: Paula Harris/);
});

test('"add her primary Dr. Kelys Caballero" on a loaded workup adds her to the six saved doctors', () => {
  const fu = N.comparisonFollowUp([...base, { role: 'user', content: 'it didnt add her primary... dr. Kelys Caballero' }]);
  assert.ok(fu);
  assert.equal(fu.doctors.length, 7);
  assert.equal(fu.doctors[6], 'Kelys Caballero');
});

test('a typed NPI settles a "different name" flag', () => {
  const doc = (npi) => ({ requestedName: 'Theresa Gloria St. Phillipe, APRN', doctorName: 'Theresa Gloria St Philippe', npi, status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: ['UHC X (H5420-014)'], outOfNetworkPlans: [] });
  const ask = 'Named plan set: UHC X (H5420-014).\nuse this for Theresa 1306218243';
  const out = N.selectComparison([doc('1306218243')], ask, {});
  assert.ok(!out.docs || !out.docs.some((d) => d.identityPending));
});

test('Excel meds print the on-screen Meds table words (Paula Harris export, 2026-10-13)', () => {
  const E = require('../artifacts/comparison-export.js');
  const grid = R.gridPlansForCounty('Miami-Dade');
  const plans = ['H5420-014', 'H1609-094'].map((id) => grid.find((p) => p.planId === id));
  const reply = [
    '| Doctor | UHC · H5420-014 | Aetna · H1609-094 |', '|---|---|---|',
    '| Hoa N. Nguyen · NPI 1669452983 | ✅ In | ✅ In |', '| Doctors | 1 in | 1 in |', '',
    'Meds', '', '| Drug | UHC · H5420-014 | Aetna · H1609-094 |', '|---|---|---|',
    '| Gabapentin | ❔ check Medicare.gov (strength not confirmed) | ❔ check Medicare.gov (strength not confirmed) |',
    '| Ergocalciferol | 1.25 mg: T2 $0 · supplemental | ❔ check Medicare.gov (strength not confirmed) |',
  ].join('\n');
  const msgs = [{ role: 'user', content: 'Doctors: Hoa Nguyen\nMedications: gabapentin, ergocalciferol' }, { role: 'assistant', content: reply }];
  const tbl = E.latestChatTable(msgs);
  assert.equal(tbl.meds.length, 2);
  const payload = E.buildExportPayload(plans, msgs.map((m) => m.content).join('\n'), { chatTable: tbl, planSetFixed: true });
  const gaba = payload.drugs.find((d) => /gabapentin/i.test(d.name));
  assert.equal(gaba.screen['H5420-014'], 'Check Medicare.gov (strength not confirmed)');
  const ergo = payload.drugs.find((d) => /ergocalciferol/i.test(d.name));
  assert.equal(ergo.screen['H1609-094'], 'Check Medicare.gov (strength not confirmed)');
  assert.equal(ergo.screen['H5420-014'], '1.25 mg: T2 $0 · supplemental');
});

test('doctor names with an office / specialty after a dash search by the name alone (Jackie Alexander, 2026-10-13)', () => {
  const { cleanDoctorQuery } = require('./npiRegistry');
  assert.equal(cleanDoctorQuery('Natalie Regalado - Baptist Medical Group'), 'Natalie Regalado');
  assert.equal(cleanDoctorQuery('Pasquel DeSantis - Endocrinologist - Baptist'), 'Pasquel DeSantis');
  assert.equal(cleanDoctorQuery('Charles Kaiser - Ophthalmologist'), 'Charles Kaiser');
  assert.equal(cleanDoctorQuery('Neeta Erinjerri - Surgeon at Baptist Cancer Institute'), 'Neeta Erinjerri');
  assert.equal(cleanDoctorQuery('Dr. Mary Smith'), 'Mary Smith');
});

test('a combination product answering a single-drug ask is flagged, never priced as the drug (Melmoth, 2026-10-13)', () => {
  const plans = [{ planId: 'H5420-001', name: 'UHC MedicareMax' }];
  const row = { planId: 'H5420-001', verified: true, coverage: 'covered', tier: 2, costShare: '$0' };
  const combo = N.medsTable([{ drugName: 'Tramadol-Acetaminophen', byPlanId: { 'H5420-001': row }, lookups: [row] }], plans, ['Tramadol']);
  assert.match(combo, /Tramadol ⚠️/);
  assert.doesNotMatch(combo, /T2/);
  const plain = N.medsTable([{ drugName: 'Tramadol HCL', byPlanId: { 'H5420-001': row }, lookups: [row] }], plans, ['Tramadol']);
  assert.match(plain, /T2/);
});

test('"Try Alan Dal Pra" answers the single "No exact match" doctor and keeps the other doctors (Melmoth, 2026-10-13)', () => {
  const ask = 'Melmoth Leslie Alexander · ZIP 33186\nDoctors: Elias Feanny *; Alan Chu; Robert Puig; Alan Del Par; John Morytko\nMeds: Metformin; Omeprazole\nPlans: H5420-001';
  const reply = '1. No exact match for:\n• "Alan Del Par" — not found. Spelling, or specialty / office?\nReply "Alan Del Par = Dr. Full Name".\nDoctors × top plans';
  const fu = N.comparisonFollowUp([{ role: 'user', content: ask }, { role: 'assistant', content: reply }, { role: 'user', content: 'Try Alan Dal Pra' }]);
  assert.ok(fu, 'server must re-run');
  assert.equal(fu.doctors.length, 5);
  assert.ok(fu.doctors.includes('Alan Dal Pra') && !fu.doctors.includes('Alan Del Par'), JSON.stringify(fu.doctors));
});

test('"yes Zubair Ansari" confirms the doctor match without the canonical question wording (Melmoth, 2026-10-13)', () => {
  const doc = { requestedName: 'Dr. Zubain Ansari', doctorName: 'Zubair Ansari', npi: '1992124929', status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: ['UHC MedicareMax (H5420-001)'], outOfNetworkPlans: [] };
  const plain = N.selectComparison([doc], 'Named plan set: UHC MedicareMax (H5420-001).\nZubain Ansari', {});
  const yes = N.selectComparison([doc], 'Named plan set: UHC MedicareMax (H5420-001).\nZubain Ansari\nyes Zubair Ansari', {});
  const flagged = (o) => (o.docs || []).some((d) => d.identityPending);
  assert.ok(flagged(plain) || !yes.docs || !flagged(yes));
  assert.ok(!yes.docs || !flagged(yes));
});

test('"change to Alan Dal Pra" / "switch to …" / "should be …" all answer the one unmatched doctor', () => {
  const ask = 'Melmoth Leslie Alexander · ZIP 33186\nDoctors: Elias Feanny; Alan Chu; Alan Del Par; John Morytko\nMeds: Metformin\nPlans: H5420-001';
  const reply = '1. No exact match for:\n• "Alan Del Par" — not found. Spelling, or specialty / office?\nDoctors × top plans';
  for (const said of ['change to Alan Dal Pra', 'switch to Alan Dal Pra', 'should be Alan Dal Pra', 'Dr Alan Dal Pra']) {
    const fu = N.comparisonFollowUp([{ role: 'user', content: ask }, { role: 'assistant', content: reply }, { role: 'user', content: said }]);
    assert.ok(fu, said);
    assert.deepEqual(fu.doctors, ['Elias Feanny', 'Alan Chu', 'Alan Dal Pra', 'John Morytko'], said);
  }
});

test('a chiropractor matched for "Natalie Regalado - Baptist Medical Group" is flagged to confirm, never shown as her result', () => {
  const mk = (requestedName, doctorName) => ({ requestedName, doctorName, npi: '1396060109', status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: [], outOfNetworkPlans: ['UHC MedicareMax (H5420-001)'] });
  const out = N.selectComparison([mk('Natalie Regalado - Baptist Medical Group', 'Natalie C Regalado Dc')], 'Named plan set: UHC MedicareMax (H5420-001).', {});
  assert.ok((out.doctors || []).some((d) => d.identityPending === 'confirm'), JSON.stringify(out.doctors && out.doctors.map((d) => d.identityPending)));
  const dental = N.selectComparison([mk('Elvin Silvestry - Dental Associates', 'Elvin J Silvestry Dds')], 'Named plan set: UHC MedicareMax (H5420-001).', {});
  assert.ok(!(dental.docs || []).some((d) => d.identityPending));
});

test('export keeps the full doctor table when a later follow-up table shows only one doctor', () => {
  const ex = require('../artifacts/comparison-export.js');
  const full = '| Doctor | A · H5420-001 | B · H1609-093 |\n|---|---|---|\n| Ann One · NPI 1111111111 | ✅ In | ✅ In |\n| Bob Two · NPI 2222222222 | ❌ Not in network (not listed) | ✅ In |\n| Doctors | 1 in | 2 in |\n';
  const narrow = '| Doctor | B · H1609-093 | A · H5420-001 |\n|---|---|---|\n| Bob Two · NPI 2222222222 | ✅ In | ✅ In |\n| Doctors | 1 in | 1 in |\n';
  const t = ex.latestChatTable([{ role: 'assistant', content: full }, { role: 'user', content: 'x' }, { role: 'assistant', content: narrow }], (x) => x);
  assert.strictEqual(t.rows.length, 2);
  assert.deepStrictEqual(t.planIds, ['H5420-001', 'H1609-093']);
  assert.strictEqual(t.rows[0].byPlan['H1609-093'], 'In network');
  assert.strictEqual(t.rows[1].byPlan['H5420-001'], 'In network');
});

test('Jackie: "yes. X = Dr. Y" applies both the spelling and the correction, and the pasted Plans line stays her current plan', () => {
  const D = require('./doctorPlanNarrow');
  const first = 'Jacqueline Alexander · ZIP 33186\nDoctors: Pasquel DeSantis - Endocrinologist - Baptist; Neeta Erinjerri - Surgeon at Baptist Cancer Institute; Alan Chu\nMeds: Rinvoq\nPlans: H5420-001\nComparison results';
  const q = 'Answer these first:\n1. No exact match for:\n• "Pasquel DeSantis - Endocrinologist - Baptist" — closest: Joseph Desantis, ARNP (Nurse Practitioner, Miami)\n• "Neeta Erinjerri - Surgeon at Baptist Cancer Institute" — did you mean Neeta Jane Erinjeri, MD (Surgery, Miami)? (looks like a spelling difference)\nReply "yes" to use the spelling found.';
  const msgs = [{ role: 'user', content: first }, { role: 'assistant', content: q }, { role: 'user', content: 'yes. Pasquel DeSantis - Endocrinologist - Baptist = Dr. Pascual De Santis, MD' }];
  const r = D.comparisonFollowUp(msgs);
  assert.ok(r.doctors.some((n) => /^Pascual De Santis/.test(n)), JSON.stringify(r.doctors));
  assert.ok(r.doctors.includes('Neeta Jane Erinjeri'), JSON.stringify(r.doctors));
  assert.ok(/^Her current plan: H5420-001\./m.test(D.comparisonAskText(msgs)));
});

test('Jackie: earlier "yes" + "X = Y" corrections stay applied on a later confirmation turn (no duplicate doctors)', () => {
  const D = require('./doctorPlanNarrow');
  const first = 'Jacqueline Alexander · ZIP 33186\nDoctors: Natalie Regalado - Baptist; Pasquel DeSantis - Endocrinologist - Baptist; Neeta Erinjerri - Surgeon at Baptist Cancer Institute; Alan Chu\nMeds: Rinvoq\nPlans: H5420-001\nComparison results';
  const q = '1. No exact match for:\n• "Pasquel DeSantis - Endocrinologist - Baptist" — closest: Joseph Desantis, ARNP (Nurse Practitioner, Miami)\n• "Neeta Erinjerri - Surgeon at Baptist Cancer Institute" — did you mean Neeta Jane Erinjeri, MD (Surgery, Miami)? (looks like a spelling difference)\nReply "yes" to use the spelling found.';
  const msgs = [
    { role: 'user', content: first }, { role: 'assistant', content: q },
    { role: 'user', content: 'yes. Pasquel DeSantis - Endocrinologist - Baptist = Dr. Pascual De Santis, MD' },
    { role: 'assistant', content: 'Doctors × top plans\n2. Is Natalie C Regalado Dc the doctor you meant?' },
    { role: 'user', content: 'YES, Dr. Natalie C Regalado Dc' },
  ];
  const r = D.comparisonFollowUp(msgs);
  assert.strictEqual(r.doctors.length, 4, JSON.stringify(r.doctors));
  assert.ok(r.doctors.some((n) => /^Pascual De Santis/.test(n)) && r.doctors.includes('Neeta Jane Erinjeri'));
  assert.ok(!r.doctors.some((n) => /Pasquel|Erinjerri/.test(n)));
});
