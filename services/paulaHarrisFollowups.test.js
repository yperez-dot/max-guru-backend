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
