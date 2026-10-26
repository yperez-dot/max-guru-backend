// Regression: surname-only doctors stay on reload; H####-##-# normalizes;
// a named current 2026 Doctors PBP becomes the 2027 column (2026-10-26).
// Synthetic names only — Elena Vargas, Nora Ellison, Priya Shah, Luis Navarro,
// Hannah Cho, Dr. Voss. No real client, doctor, or NPI.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const C = require('./compareJobs');
const N = require('./doctorPlanNarrow');
const { withRecoveredDoctors } = require('./workups');
const W = require('../artifacts/client-workups.js');

const PERSON = 'Elena Vargas';
const ZIP = '33166';
const FIVE = ['Nora Ellison', 'Priya Shah', 'Luis Navarro', 'Hannah Cho', 'Voss'];
const ASK = `${PERSON}, ${ZIP}, Dr. Nora Ellison, Dr. Priya Shah, Dr. Luis Navarro, Dr. Hannah Cho, Dr. Voss, meds: dicyclomine. Client is on DrSelect (HMO) (H4140-12-0) and is comparing against Humana Gold Plus H1036-054C. Please include those two only on plan comparison.`;

function doc(name, extra = {}) {
  return {
    requestedName: name,
    doctorName: name,
    npi: extra.npi || '',
    status: extra.status || 'not_found',
    pending: [],
    failed: [],
    inNetworkPlans: extra.inNetworkPlans || [],
    outOfNetworkPlans: extra.outOfNetworkPlans || [],
    carriersIn: extra.carriersIn || [],
    networks: extra.networks || [],
    suggestions: extra.suggestions || [],
    ...extra,
  };
}

describe('1. Surname-only titled doctor is kept', () => {
  it('parseCompareAsk keeps Dr. Voss with the four full names', () => {
    const f = C.parseCompareAsk(ASK);
    assert.deepEqual(f.doctors.map((d) => d.name), FIVE);
    assert.deepEqual(f.unreadDoctors, []);
    assert.equal(f.doctorCount, 5);
    assert.equal(f.zip, ZIP);
    assert.equal(f.clientName, PERSON);
    assert.deepEqual(f.meds, ['dicyclomine']);
  });

  it('reloading a workup that dropped the surname-only doctor adds it back', () => {
    const saved = FIVE.slice(0, 4).map((name) => ({ name, byPlanId: {} }));
    const w = withRecoveredDoctors({ originalQuery: ASK, zip: ZIP, doctors: saved, history: [] });
    assert.deepEqual(w.doctors.map((d) => d.name), FIVE);
    assert.deepEqual(w.recoveredDoctors, ['Voss']);
    const note = W.recoveredDoctorsNote(w);
    assert.match(note, /Added back Voss from the original request.*Checking all 5 doctors now/);
    assert.doesNotMatch(note, /Couldn't read/);
  });

  it('an unresolved surname-only doctor stays in the table and asks for a full name', () => {
    const docs = FIVE.map((name) => doc(name, { status: 'not_found' }));
    const sel = N.selectComparison(docs, `ZIP ${ZIP} Miami-Dade.\nHer current plan: H4140-012.\nCompare H4140-012, H1036-054C.`, {});
    assert.ok(sel.doctors.some((d) => /voss/i.test(d.requestedName || d.doctorName)));
    const q = `${sel.doctorQuestion || ''} ${(sel.questions || []).join(' ')}`;
    assert.match(q, /Voss/i);
    assert.match(q, /full name|not found|specialty \/ office/i);
  });
});

describe('2. H####-##-# normalizes; named current plan stays', () => {
  it('H4140-12-0 normalizes to H4140-012', () => {
    assert.equal(C.normalizePlanIds('Client is on DrSelect (HMO) (H4140-12-0)'), 'Client is on DrSelect (HMO) (H4140-012)');
    const f = C.parseCompareAsk(ASK);
    assert.ok(f.plans.includes('H4140-012') || f.plans.includes('H4140-023'), f.plans.join(','));
    assert.ok(f.currentPlans.includes('H4140-012') || f.currentPlans.includes('H4140-023'), String(f.currentPlans));
    assert.ok(f.plans.includes('H1036-054C'));
  });

  it('H4140-012 is the 2026 DrSelect PBP; 2027 comparison uses H4140-023', () => {
    const r = N.yearPlanId('H4140-012', 2027);
    assert.equal(r.id, 'H4140-023');
    assert.equal(r.from, 'H4140-012');
    assert.match(r.notice, /H4140-012.*H4140-023/);
    assert.equal(N.applyYearPlanId('H4140-12-0'.replace(/\b([HR]\d{4})-(\d{1,3})(?:-\d)?(?=[^\dA-Za-z-]|$)/gi, (m, a, b) => `${a.toUpperCase()}-${b.padStart(3, '0')}`), 2027), 'H4140-023');
    const row = N.gridRowFor('H4140-023', 'Miami-Dade');
    assert.ok(row);
    assert.match(String(row.planName || ''), /DrSelect/i);
    assert.equal(N.gridRowFor('H4140-012', 'Miami-Dade'), null);
  });

  it('explicit current H4140-012 and Humana H1036-054C are both columns in Miami-Dade', () => {
    const docs = [doc('Nora Ellison', { status: 'done', inNetworkPlans: ['Doctors DrSelect-SFL (H4140-023)', 'Humana Gold Plus (H1036-054C)'] })];
    const sel = N.selectComparison(docs, `ZIP ${ZIP} Miami-Dade.\nHer current plan: H4140-012.\nCompare H4140-012, H1036-054C.`, {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.ok(ids.includes('H4140-023'), ids.join(','));
    assert.ok(ids.includes('H1036-054'), ids.join(','));
    assert.ok(!ids.includes('H4140-012'), ids.join(','));
    assert.ok(!sel.flags.some((f) => /Not offered in Miami-Dade: H4140-012/.test(f)), sel.flags.join('\n'));
    assert.ok(sel.flags.some((f) => /H4140-012/.test(f) && /H4140-023/.test(f)), sel.flags.join('\n'));
  });

  it('a named current plan is never dropped by the county filter', () => {
    const docs = [doc('Nora Ellison', { status: 'done', inNetworkPlans: ['Humana Gold Plus (H1036-054C)'] })];
    const sel = N.selectComparison(docs, `ZIP ${ZIP} Miami-Dade.\nHer current plan: H4140-012.\nCompare H4140-012, H1036-054C.`, {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.ok(ids.includes('H4140-023') || ids.includes('H4140-012'), ids.join(','));
    assert.ok(ids.includes('H1036-054'), ids.join(','));
  });

  it('an off-county plan that is not the current plan is still dropped', () => {
    const docs = [doc('Nora Ellison', { status: 'done', inNetworkPlans: ['UHC Preferred MA FL-0002 (H1045-005)'] })];
    const sel = N.selectComparison(docs, 'ZIP 33322 Broward. Compare UHC H1045-005 and HealthSun H5431-017', {});
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.ok(!ids.includes('H5431-017'));
    assert.ok(sel.flags.some((f) => /Not offered in Broward: H5431-017/.test(f)), sel.flags.join('\n'));
  });
});
