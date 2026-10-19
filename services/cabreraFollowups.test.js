// Tony & Gerry Cabrera, 2026-10-19 (live after #235). Fresh asks listed "Med Eye Associates" among the doctors; the
// "Med" was read as the meds label, so the doctors after it became drug rows and the real "Medications" list (one per
// line) was dropped. Gerry's loaded workup then: levothyroxine split by strength with "varies by product" although
// every strength was T1 $0; "Pinecrest Dentisry is Dr. Salome Fraga" renamed the client and re-ran only Fraga; the
// confirmed dose (0.2 mg) never reached the table / export. The golden scenarios cover the end-to-end runs; these are
// the unit rules.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const { parseCompareAsk } = require('./compareJobs');
const { WorkupStore } = require('./workups');

const TONY = 'Tony Cabrera, 33186, Dr. Alix Salvant, Joaquin Maury-Ochoa, Ignacio Rua, Francisco Borja, Med Eye Associates, Brian Dougherty, Pinecrest Modern Dentistry, Ramon Quesada, Michael Fili. Medications amlodipine\nfolic acid\nglipizide\nlisinopril\nmemantine\nmetformin\nmetoprolol\nsimvastatin. Current plan is UHC MedicareMax Medicare Advantage FL-0028 (HMO) (H5420-1-0)';
const GERRY = 'Gerry Cabrera, 33186, Dr. Alix Salvant, Ignacio Rua, Robert Puig, Med Eye Associates, Brian Dougherty, Pinecrest Modern Dentistry, Michael Fili, Martin Madorsky, Abilio Armand Coello. Meds: fluticasone, hydrochlorothiazide\nlatanoprost\nlevothyroxine\nocuvite\npotassium citrate. Current plan is UHC MedicareMax Medicare Advantage FL-0028 (HMO) (H5420-1-0)';

describe('meds label is a whole word, never the start of a name', () => {
  it('Tony: 9 doctors incl. Med Eye Associates, all 8 meds, no names in meds', () => {
    const f = parseCompareAsk(TONY);
    assert.equal(f.clientName, 'Tony Cabrera');
    assert.deepEqual(f.doctors.map((d) => d.name), ['Alix Salvant', 'Joaquin Maury-Ochoa', 'Ignacio Rua', 'Francisco Borja', 'Med Eye Associates', 'Brian Dougherty', 'Pinecrest Modern Dentistry', 'Ramon Quesada', 'Michael Fili']);
    assert.deepEqual(f.meds, ['amlodipine', 'folic acid', 'glipizide', 'lisinopril', 'memantine', 'metformin', 'metoprolol', 'simvastatin']);
    assert.deepEqual(R.medsFromAsk(TONY), f.meds);
  });
  it('Gerry: Med Eye Associates stays a doctor; the 6 meds after "Meds:" one per line', () => {
    const f = parseCompareAsk(GERRY);
    assert.ok(f.doctors.some((d) => d.name === 'Med Eye Associates'));
    assert.equal(f.doctors.length, 9);
    assert.deepEqual(R.medsFromAsk(GERRY), ['fluticasone', 'hydrochlorothiazide', 'latanoprost', 'levothyroxine', 'ocuvite', 'potassium citrate']);
  });
  it('"Med Center" / "Rx Pharmacy" are names; "Meds metformin, lisinopril" and "Takes Eliquis" still read', () => {
    assert.deepEqual(R.medsFromAsk('Jane Roe 33186. Doctors: Kendall Med Center, Rx Pharmacy Plus. No meds.'), []);
    assert.deepEqual(R.medsFromAsk('Jane Roe 33186. Meds metformin, lisinopril'), ['metformin', 'lisinopril']);
    assert.deepEqual(R.medsFromAsk('Jane Roe 33186. Takes Eliquis'), ['Eliquis']);
    assert.deepEqual(R.medsFromAsk('Jane Roe 33186. Meds: folic acid, Potassium Citrate'), ['folic acid', 'Potassium Citrate']);
  });
  it('a doctor or practice she listed is never a drug row', () => {
    assert.deepEqual(R.dropDoctorNamesFromMeds(['Brian Dougherty', 'Eye Associates', 'glipizide'], [{ name: 'Brian Dougherty' }]), ['glipizide']);
  });
  it('"H5420-1-0" is her current plan H5420-001 in the chat path too', () => {
    assert.deepEqual(N.currentPlanIdsIn('Current plan is UHC MedicareMax Medicare Advantage FL-0028 (HMO) (H5420-1-0)'), ['H5420-001']);
  });
});

describe('client name on a doctor mapping / dose answer', () => {
  it('"Pinecrest Dentisry is Dr. Salome Fraga" / "X = Dr. Y" / "Levothyroxine Sodium is 0.2 mg" name no client', () => {
    for (const t of ['Pinecrest Dentisry is Dr. Salome Fraga.', 'Pinecrest Modern Dentistry = Dr. Salome Fraga', 'Levothyroxine Sodium is 0.2 mg.']) {
      assert.equal(parseCompareAsk(t).clientName, '', t);
    }
  });
  it('a saved workup keeps its client name; a doctor / practice name is never saved as the client', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabrera-'));
    const store = new WorkupStore({ filePath: path.join(dir, 'w.json') });
    const owner = 'agent@example.com';
    const plans = [{ planId: 'H5420-001' }, { planId: 'H4140-022' }];
    const doctors = [{ name: 'Alix Salvant' }, { name: 'Pinecrest Modern Dentistry' }];
    const a = await store.upsert(owner, { clientName: 'Gerry Cabrera', plans, doctors, medications: [{ name: 'Levothyroxine Sodium' }] });
    const b = await store.upsert(owner, { id: a.id, clientName: 'Pinecrest Modern Dentistry', plans, doctors });
    assert.equal(b.id, a.id, 'same workup — not split off as a new client');
    assert.equal(b.clientName, 'Gerry Cabrera');
    const c = await store.upsert(owner, { id: a.id, clientName: 'Pinecrest Dentisry Is Dr', plans, doctors, medications: [{ name: 'Levothyroxine Sodium 0.2 mg', byPlanId: { 'H5420-001': { verified: true, tier: 1, costShare: '$0' } } }] });
    assert.equal(c.clientName, 'Gerry Cabrera');
    // The confirmed dose renames the saved med (one row, that strength).
    assert.deepEqual(c.medications.map((m) => m.name), ['Levothyroxine Sodium 0.2 mg']);
    const d = await store.upsert(owner, { id: a.id, plans, doctors, medications: [{ name: 'Levothyroxine Sodium' }] });
    assert.deepEqual(d.medications.map((m) => m.name), ['Levothyroxine Sodium 0.2 mg'], 'a dose-less re-read never undoes it');
  });
});

describe('confirmed dose', () => {
  it('"Levothyroxine Sodium is 0.2 mg" → the saved med reads "Levothyroxine Sodium 0.2 mg"', () => {
    assert.deepEqual(LW.applyConfirmedDoses('Levothyroxine Sodium is 0.2 mg.', ['Latanoprost', 'Levothyroxine Sodium']), ['Latanoprost', 'Levothyroxine Sodium 0.2 mg']);
    assert.deepEqual(LW.applyConfirmedDoses('levothyroxine 0.2mg', ['Levothyroxine Sodium 0.1 mg']), ['Levothyroxine Sodium 0.2 mg']);
    assert.deepEqual(LW.applyConfirmedDoses('Pinecrest Dentisry is Dr. Salome Fraga.', ['Levothyroxine Sodium']), ['Levothyroxine Sodium']);
  });
});

describe('strength cells: just tier · cost unless it really differs', () => {
  const col = [{ planId: 'H5420-001', name: 'UHC' }, { planId: 'H4140-022', name: 'DrMax' }];
  const v = (strength, extra) => ({ strength, verified: true, coverage: 'covered', tier: 1, costShare: '$0', source: 'medicare_gov', restrictionsKnown: true, ...extra });
  const levo = (strengths) => ({
    drugName: 'Levothyroxine Sodium',
    lookups: [],
    byPlanId: Object.fromEntries(col.map((c) => [c.planId, { planId: c.planId, verified: true, coverage: 'covered', tier: 1, costShare: '$0', source: 'medicare_gov', restrictionsKnown: true, strengths }])),
  });
  it('Gerry: 0.1/0.175/0.2 mg "varies by product" + 0.3 mg, all T1 $0 → "T1 $0", no strength warning', () => {
    const r = levo([v('0.1 mg', { mixedProducts: true }), v('0.175 mg', { mixedProducts: true }), v('0.2 mg', { mixedProducts: true }), v('0.3 mg')]);
    const row = N.medsTable([r], col).split('\n')[2];
    assert.match(row, /\| T1 \$0 \| T1 \$0 \|$/);
    assert.doesNotMatch(row, /varies|‖|mg:/);
    assert.deepEqual(N.strengthNotes([r], col.map((c) => c.planId)), []);
  });
  it('a real difference keeps the split and the "confirm dose" note', () => {
    const r = levo([v('0.1 mg'), v('0.3 mg', { tier: 2, costShare: '$5' })]);
    assert.match(N.medsTable([r], col).split('\n')[2], /‖/);
    assert.equal(N.strengthNotes([r], col.map((c) => c.planId)).length, 1);
  });
  it('a confirmed dose in the name never gets the strength warning', () => {
    const r = { ...levo([v('0.1 mg'), v('0.3 mg', { tier: 2, costShare: '$5' })]), drugName: 'Levothyroxine Sodium 0.2 mg' };
    assert.deepEqual(N.strengthNotes([r], col.map((c) => c.planId)), []);
  });
});

describe('Excel / PDF column A', () => {
  const src = fs.readFileSync(path.join(__dirname, '../artifacts/comparison-export.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  it('PDF first column is left-aligned too; the page carries the same export code', () => {
    assert.match(src, /columnStyles: \{ 0: \{ cellWidth: 120, fontStyle: "bold", halign: "left" \} \}/);
    assert.match(src, /if \(data\.column\.index === 0\) data\.cell\.styles\.halign = "left";/);
    assert.ok(html.includes('horizontal: c === 0 ? "left" : "center"'), 'run scripts/sync_html_artifacts.js');
  });
});
