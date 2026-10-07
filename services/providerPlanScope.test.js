// Maura (Miami-Dade, 2026-10-07): current plan UHC Preferred Care Preferred MA H1045-001 vs Humana
// H1036-054C / H1036-305.
//  1. Every doctor read "not confirmed" on H1045-001: the tool's planId named only the Humana
//     plan, so the UHC guest check was limited to H1036-054C and checked no UHC plan at all.
//  2. "YIKES, HUMANA WONT WORK THEN. check on another plan" was read as a Humana ask, so the
//     next table was Humana-only again.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const { planIdsFrom, guestPlanIdsFor } = require('./providerNetwork');
const { queryUhcGuest, resetSessionCache, formatUhcAgentNote, unreliableMiss } = require('./uhcGuestSearch');

describe('UHC guest check scope (bug 1)', () => {
  it('planIdsFrom reads every ID in a comma list / array, not just the first', () => {
    assert.deepEqual(planIdsFrom('H1036-054C, H1036-305, H1045-001'), ['H1036-054C', 'H1036-305', 'H1045-001']);
    assert.deepEqual(planIdsFrom(['H1045-001'], undefined, 'h1036-054c'), ['H1045-001', 'H1036-054C']);
    assert.deepEqual(planIdsFrom(undefined, ''), []);
  });

  it('a Humana-only planId also checks the UHC plan named in her comparison', () => {
    const ask = 'Maura, ZIP 33165. Current plan UHC Preferred Care Preferred MA H1045-001. Compare with Humana H1036-054C and H1036-305.';
    assert.deepEqual(guestPlanIdsFor(['H1036-054C'], ask), ['H1036-054C', 'H1045-001', 'H1036-305']);
    assert.deepEqual(guestPlanIdsFor([undefined, ''], ask), [], 'no planId = every THEI plan is checked');
  });

  function jsonRes(body, cookies = []) {
    return { ok: true, status: 200, headers: { getSetCookie: () => cookies }, json: async () => body };
  }
  const PREFERRED_001 = {
    planName: 'UHC Preferred Medicare Advantage FL-0001 (HMO)', planIdentifier: 'H1045-001-000',
    medicarePlanType: 'INDIVIDUAL', searchDirectory: 'COSMOS', years: [{ planYear: '2027', reciprocityId: '115' }],
  };
  const searched = [];
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/api/create-guest-session')) return jsonRes({ success: true }, ['PSX_GUEST_SESSION=abc; Path=/']);
    if (u.includes('/api/authorize-guest-session')) return jsonRes({ authorized: true });
    const body = JSON.parse(options.body || '{}');
    if (body.operationName === 'GetLocation') return jsonRes({ data: { location: { features: [{ center: ['-80.36', '25.68'], stateCode: 'FL' }] } } });
    if (body.operationName === 'GetPostalPoint') return jsonRes({ data: { getPostalPoint: { county_proper: 'Miami-Dade', county_id: '12086', state: 'FL' } } });
    if (body.operationName === 'GetPlanDefinitions') return jsonRes({ data: { getPlanDefinitions: { planDetails: [PREFERRED_001] } } });
    if (body.operationName === 'ProviderSearch') {
      searched.push(body.variables.rulesPackageKey);
      return jsonRes({ data: { providerSearch: { providers: [{ npi: '1184615874', firstName: 'Cheryl', lastName: 'Case-Diaz' }] } } });
    }
    throw new Error(`unexpected ${u}`);
  };
  beforeEach(() => { resetSessionCache(); searched.length = 0; });

  it('queryUhcGuest with only a Humana ID checks the UHC plans instead of none', async () => {
    const r = await queryUhcGuest('1184615874', { zip: '33165', planIds: ['H1036-054C'] }, fetchImpl);
    assert.deepEqual(searched, ['H1045-001-000']);
    assert.ok(r.plans.some((p) => /H1045-001/.test(p)), JSON.stringify(r.plans));
  });

  it('a UHC ID in the list still limits the check to that plan', async () => {
    const r = await queryUhcGuest('1184615874', { zip: '33165', planIds: ['H1036-054C', 'H1045-001'] }, fetchImpl);
    assert.deepEqual(searched, ['H1045-001-000']);
    assert.equal(r.inNetwork, true);
  });

  it('a Preferred Care Partners (H1045) miss is not confirmed, never Out', async () => {
    const r = await queryUhcGuest('1720196454', { zip: '33018', planIds: ['H1045-001'] }, fetchImpl);
    assert.equal(r.inNetwork, false);
    assert.deepEqual(r.outOfNetworkPlans, []);
    assert.equal(r.notListedPlans.length, 1);
    const note = formatUhcAgentNote(r);
    assert.match(note, /NOT CONFIRMED, never Out/);
    assert.doesNotMatch(note, /Out of network:/);
    assert.equal(unreliableMiss('H5420-001-000'), false, 'other UHC contracts keep a hard Out');
  });
});

describe('"Humana won\'t work, check another plan" (bug 2)', () => {
  afterEach(() => R.setGridForTests(null));

  it('rejecting a carrier is not asking for it', () => {
    assert.deepEqual(R.carriersRequested('YIKES, HUMANA WONT WORK THEN. check on another plan'), []);
    assert.deepEqual(R.carriersRejected('YIKES, HUMANA WONT WORK THEN. check on another plan'), ['Humana']);
    assert.equal(R.wantsOtherCarrier('check on another plan'), true);
    assert.deepEqual(R.carriersRequested('instead of humana show me aetna'), ['Aetna']);
    assert.deepEqual(R.carriersRejected('not humana, check aetna'), ['Humana']);
    assert.deepEqual(R.carriersRequested('show me humana and aetna'), ['Humana', 'Aetna'], 'a plain ask is unchanged');
    assert.deepEqual(R.carriersRejected('show me humana and aetna'), []);
  });

  const msgs = [
    { role: 'user', content: 'Maura Lopez, ZIP 33165. Current plan UHC Preferred Care Preferred MA H1045-001. No Medicaid. Compare her current plan with Humana H1036-054C and H1036-305.\nDoctors: Cheryl L Case-Diaz, Barbara Martinez, Nathan Bruce Hirsch, Cynthia Golomb, Gibbons Fell. Meds: Eliquis.' },
    { role: 'assistant', content: '**Doctors × your plans** … Humana: Golomb In on both; the other 3 Out.' },
    { role: 'user', content: 'YIKES, HUMANA WONT WORK THEN. check on another plan' },
  ];
  const AETNA = 'Aetna Medicare Select Care (HMO) (H1609-093)';
  const UHC001 = 'UHC Preferred Care Preferred MA (HMO) (H1045-001)';
  const UHC028 = 'UHC MedicareMax FL-0028 (HMO) (H5420-001)';
  const HUM054 = 'Humana Gold Plus (HMO) (H1036-054C)';
  const HUM305 = 'Humana Gold Plus Giveback (HMO) (H1036-305)';
  const doc = (req, name, npi, ins, outs = []) => ({
    requestedName: req, doctorName: name, npi, status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: ins, outOfNetworkPlans: outs,
  });
  const DOCS = [
    doc('Cheryl L Case-Diaz', 'CHERYL L CASE-DIAZ', '1184615874', [AETNA, UHC001, UHC028], [HUM054, HUM305]),
    doc('Barbara Martinez', 'BARBARA MARTINEZ', '1093938532', [], [AETNA, UHC001, UHC028, HUM054, HUM305]),
    doc('Nathan Bruce Hirsch', 'NATHAN BRUCE HIRSCH', '1720196454', [AETNA], [UHC001, UHC028, HUM054, HUM305]),
    doc('Cynthia Golomb', 'CYNTHIA GOLOMB', '1619900388', [AETNA, HUM054, HUM305], [UHC001, UHC028]),
    doc('Gibbons Fell', 'GIBBONS FELL', '1000000099', [], []),
  ];

  it('the ask text drops the Humana lock and keeps her current plan + ZIP', () => {
    const ask = N.comparisonAskText(msgs);
    assert.doesNotMatch(ask, /Carriers requested: Humana/);
    assert.match(ask, /^Carriers excluded: Humana\.$/m);
    assert.match(ask, /^Wants another carrier\.$/m);
    assert.match(ask, /^Her current plan: H1045-001\.$/m);
    assert.match(ask, /33165/);
  });

  it('the table re-checks the other carriers: current plan first, Aetna next, no Humana', () => {
    const sel = N.selectComparison(DOCS, N.comparisonAskText(msgs), {});
    const ids = sel.columns.map((c) => c.planId);
    assert.equal(ids[0], 'H1045-001', ids.join(','));
    assert.ok(ids.includes('H1609-093'), ids.join(','));
    assert.ok(!ids.some((id) => id.startsWith('H1036')), ids.join(','));
    assert.equal(sel.named, false);
    assert.deepEqual(sel.carriers, []);
    assert.match(sel.whyLine, /Left out: Humana/);
    // Eligibility filters still apply: no C-SNP (condition not confirmed), no D-SNP (no Medicaid).
    assert.ok(!sel.columns.some((c) => c.snp === 'csnp' || c.snp === 'dsnp' || c.snp === 'qmb'));
    // Every doctor, including Gibbons Fell, is a row; her meds are queued for the new plans.
    assert.equal(sel.doctors.length, 5);
    assert.deepEqual(sel.medsToCheck.planIds, ids);
  });

  it('the server re-runs the comparison for that message (all 5 doctors, her ZIP)', () => {
    const f = N.comparisonFollowUp(msgs);
    assert.ok(f, 'follow-up expected');
    assert.match(f.reason, /another carrier \(not Humana\)/);
    assert.equal(f.doctors.length, 5);
    assert.ok(f.doctors.includes('Gibbons Fell'));
    assert.equal(f.zip, '33165');
  });

  it('"instead of humana show me aetna" → Aetna columns, Humana out', () => {
    const m2 = [...msgs.slice(0, 2), { role: 'user', content: 'instead of humana show me aetna' }];
    const ask = N.comparisonAskText(m2);
    assert.match(ask, /Carriers requested: Aetna\./);
    const sel = N.selectComparison(DOCS, ask, {});
    assert.ok(sel.columns.every((c) => !c.planId.startsWith('H1036')), sel.columns.map((c) => c.planId).join(','));
    assert.ok(sel.columns.some((c) => c.planId === 'H1609-093'));
  });

  it('a later "show me humana" brings Humana back', () => {
    const m3 = [...msgs, { role: 'assistant', content: 'table' }, { role: 'user', content: 'ok show me humana again' }];
    const ask = N.comparisonAskText(m3);
    assert.match(ask, /Carriers requested: Humana\./);
    assert.doesNotMatch(ask, /Carriers excluded/);
  });
});
