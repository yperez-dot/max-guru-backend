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
