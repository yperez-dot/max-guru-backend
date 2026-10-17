// Maura / Enrique Soley (2026-10-07): switching workups re-saved thin facts over the full record —
// doctors, meds and the saved table vanished and a doctor's name became the client name.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkupStore } = require('./workups');
const workupsUi = require('../artifacts/client-workups.js');
const exp = require('../artifacts/comparison-export.js');
const N = require('./doctorPlanNarrow');

const OWNER = 'yperez@healthexps.com';
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-workups-merge-'));
  return { store: new WorkupStore({ filePath: path.join(dir, 'w.json') }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const PLANS = [
  { planId: 'H1045-001', planName: 'UHC Preferred Care Preferred MA (HMO)', carrier: 'UnitedHealthcare', county: 'Miami-Dade' },
  { planId: 'H1609-093', planName: 'Aetna Medicare Select Care (HMO)', carrier: 'Aetna', county: 'Miami-Dade' },
];
function maura() {
  return {
    clientName: 'Maura Soley', zip: '33018', plans: PLANS, currentPlanIds: ['H1045-001'],
    doctors: [
      { name: 'Dr. Cheryl Case-Diaz', npi: '1184615874', role: 'PCP', byPlanId: { 'H1045-001': 'in' } },
      { name: 'Dr. Nathan Hirsch', npi: '1720196454', role: 'Cardiologist', byPlanId: {} },
      { name: 'Dr. Cynthia Golomb', npi: '1619900388', role: 'Dermatologist', byPlanId: { 'H1609-093': 'in' } },
    ],
    medications: [
      { name: 'Hydrochlorothiazide 12.5 mg', byPlanId: { 'H1045-001': { verified: true, tier: 1, coverage: 'covered' } } },
      { name: 'Losartan 25 mg', byPlanId: {} },
      { name: 'Rosuvastatin 20 mg', byPlanId: {} },
    ],
    compareResult: { planIds: ['H1045-001', 'H1609-093'], doctors: [{ name: 'Case-Diaz' }, { name: 'Hirsch' }, { name: 'Golomb' }], drugs: [{ name: 'Losartan' }] },
  };
}

describe('workup saves merge, never replace', () => {
  it('a thin re-save keeps every doctor (with NPI and role), every med and the fuller saved table', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, maura());
    const thin = store.upsert(OWNER, {
      id: first.id, clientName: 'Maura Soley', zip: '33018', plans: [PLANS[0], PLANS[1]],
      doctors: [], medications: [{ name: 'PCP', byPlanId: {} }],
      compareResult: { planIds: ['H1045-001'], doctors: [], drugs: [{ name: 'PCP' }] },
    });
    assert.equal(thin.id, first.id);
    assert.deepEqual(thin.doctors.map((d) => d.name), ['Dr. Cheryl Case-Diaz', 'Dr. Nathan Hirsch', 'Dr. Cynthia Golomb']);
    assert.equal(thin.doctors[1].npi, '1720196454');
    assert.equal(thin.doctors[1].role, 'Cardiologist');
    assert.deepEqual(thin.medications.map((m) => m.name), ['Hydrochlorothiazide 12.5 mg', 'Losartan 25 mg', 'Rosuvastatin 20 mg'], '"PCP" is never a med');
    assert.equal(thin.compareResult.doctors.length, 3, 'the thinner result never replaces the saved one');
    assert.deepEqual(thin.currentPlanIds, ['H1045-001']);
    assert.equal(thin.history.length, 1, 'the earlier version is kept');
    assert.equal(thin.history[0].doctors.length, 3);
  });

  it('another client\'s save never overwrites this record (Enrique over Maura)', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const m = store.upsert(OWNER, maura());
    const e = store.upsert(OWNER, { id: m.id, clientName: 'Enrique Soley', zip: '33018', plans: PLANS, medications: [{ name: 'Atorvastatin 40 mg', byPlanId: {} }] });
    assert.notEqual(e.id, m.id);
    const back = store.get(OWNER, m.id);
    assert.equal(back.clientName, 'Maura Soley');
    assert.equal(back.doctors.length, 3);
    assert.equal(back.medications.length, 3);
  });

  it('a doctor\'s name saved as the client ("Cheryl Case") can be corrected in place', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const bad = store.upsert(OWNER, { ...maura(), clientName: 'Cheryl Case' });
    const fixed = store.upsert(OWNER, { id: bad.id, clientName: 'Maura Soley', zip: '33018', plans: PLANS });
    assert.equal(fixed.id, bad.id);
    assert.equal(fixed.clientName, 'Maura Soley');
    assert.equal(fixed.doctors.length, 3);
  });
});

describe('client name is never a doctor', () => {
  it('"Cheryl Case-Diaz (PCP)" is not the client — and is never cut to "Cheryl Case"', () => {
    assert.equal(exp.extractClientName('Cheryl Case-Diaz (PCP)\nBarbara Martinez\nNathan Bruce Hirsch'), '');
    assert.equal(exp.extractClientName('Maura Soley, ZIP 33018. Current plan H1045-001.\nDoctors: Cheryl L Case-Diaz, Barbara Martinez'), 'Maura Soley');
    assert.equal(exp.extractClientName('Client: Maura Soley\nDr. Cheryl Case-Diaz is In'), 'Maura Soley');
    assert.equal(exp.extractClientName('Maria & Gaspar Padron, ZIP 33332'), 'Maria & Gaspar Padron');
  });
});

describe('only the plan she is on is her current plan', () => {
  const thread = 'Maura Soley, ZIP 33018. Current plan UHC Preferred Care Preferred MA H1045-001. Compare her current plan with Aetna H1609-093.';
  it('the saved workup tags H1045-001 current, not the Aetna comparison column', () => {
    const w = workupsUi.buildWorkupFromExport({ plans: PLANS, doctors: [], drugs: [] }, { threadText: thread });
    assert.deepEqual(w.currentPlanIds, ['H1045-001']);
    const ctx = workupsUi.compactWorkupContext(w);
    assert.match(ctx, /^Current plan: H1045-001$/m);
    assert.doesNotMatch(ctx, /Plans listed below are the client's CURRENT/);
  });

  it('a carrier ask keeps her current plan in the ask (it stays a column)', () => {
    const ctx = workupsUi.compactWorkupContext(workupsUi.buildWorkupFromExport({ plans: PLANS, doctors: [{ name: 'Cheryl Case-Diaz' }, { name: 'Cynthia Golomb' }], drugs: [] }, { threadText: thread, zip: '33018' }));
    const msgs = [{ role: 'user', content: ctx }, { role: 'user', content: 'show me doctors healthcare plans' }];
    const ask = N.comparisonAskText(msgs);
    assert.match(ask, /^Her current plan: H1045-001\.$/m);
    assert.doesNotMatch(ask, /Her current plan: [^\n]*H1609-093/);
  });

  it('doctor NPIs and roles ride into the resume context', () => {
    const w = workupsUi.buildWorkupFromExport({ plans: PLANS, doctors: [{ name: 'Inbar Saporta', npi: '1234567893', role: 'Cardiologist' }], drugs: [{ name: 'Meloxicam 7.5 mg' }] }, { threadText: thread });
    assert.equal(w.doctors[0].npi, '1234567893');
    assert.deepEqual(w.medications.map((m) => m.name), ['Meloxicam 7.5 mg'], 'an unverified med is kept');
    assert.match(workupsUi.compactWorkupContext(w), /Inbar Saporta \(Cardiologist\) NPI 1234567893/);
  });
});

describe('a full final table replaces the saved doctor list (Jackie, 2026-10-13)', () => {
  it('replaceDoctors drops the old misspelled rows; a merge save replaces respelled rows too', () => {
    const { store, cleanup } = tempStore();
    try {
      const first = store.upsert(OWNER, { ...maura(), clientName: 'Jackie', doctors: [
        { name: 'Pasquel DeSantis - Endocrinologist - Baptist', byPlanId: {} },
        { name: 'Neeta Erinjerri - Surgeon at Baptist Cancer Institute', byPlanId: {} },
      ] });
      const id = (first.workup || first).id;
      const fixed = [
        { name: 'Pascual De Santis', npi: '1225156565', byPlanId: { 'H1045-001': 'in' } },
        { name: 'Neeta Jane Erinjeri', npi: '1427310424', byPlanId: { 'H1045-001': 'in' } },
      ];
      const merged = store.upsert(OWNER, { ...maura(), id, clientName: 'Jackie', doctors: fixed });
      // A respelled doctor replaces the saved misspelled row even on a merge save: the screen spelling is the truth
      // (Jacqueline Alexander, 2026-10-17: "Pasquel DeSantis" / "Neeta Erinjerri" stayed next to the fixed rows).
      assert.deepEqual((merged.workup || merged).doctors.map((d) => d.name), ['Pascual De Santis', 'Neeta Jane Erinjeri']);
      const replaced = store.upsert(OWNER, { ...maura(), id, clientName: 'Jackie', doctors: fixed, replaceDoctors: true });
      assert.deepEqual((replaced.workup || replaced).doctors.map((d) => d.name), ['Pascual De Santis', 'Neeta Jane Erinjeri']);
    } finally { cleanup(); }
  });
});

describe('saved meds keep the on-screen wording', () => {
  const { slimMedications, mergeMedications } = require('./workups');
  it('slimMedications keeps screen strings and a newer screen replaces the older wording', () => {
    const slim = slimMedications([{ name: 'Gabapentin', byPlanId: {}, screen: { 'H5420-001': 'Check Medicare.gov', 'H4140-022': '80 mg: T1 $0' } }]);
    assert.equal(slim[0].screen['H5420-001'], 'Check Medicare.gov');
    const merged = mergeMedications(slim, slimMedications([{ name: 'Gabapentin', byPlanId: {}, screen: { 'H5420-001': 'T3 $25' } }]));
    assert.equal(merged[0].screen['H5420-001'], 'T3 $25');
    assert.equal(merged[0].screen['H4140-022'], '80 mg: T1 $0');
  });
  it('a reopened workup hands the screen strings back to the export', () => {
    const W = require('../artifacts/client-workups.js');
    const out = W.workupToExportPayload({ plans: [], medications: [{ name: 'Gabapentin', byPlanId: {}, screen: { 'H5420-001': 'Check Medicare.gov' } }] }, []);
    assert.equal(out.drugs[0].screen['H5420-001'], 'Check Medicare.gov');
  });
});
