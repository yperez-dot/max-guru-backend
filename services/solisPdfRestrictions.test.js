// Solis H0982-007: the Solis 2027 Comprehensive Formulary PDF (data/solis-formulary-2027.json) supplies
// PA / ST / QL when medicare.gov prices a drug, and answers tier + PA / ST / QL when medicare.gov
// cannot confirm it. medicare.gov keeps tier / cost; its "not covered" is never overridden.
// RxNorm / medicare.gov are stubbed with what they returned live for H0982-007 (2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.SUNFIRE_JWT;

const F = require('./formularyLookup');
const N = require('./doctorPlanNarrow');
const D = require('./drugNames');
const S = require('./solisFormulary');

const PLAN = 'H0982-007';
const EXACT = { esomeprazole: '283742', rosuvastatin: '301542', trazodone: '82112', acyclovir: '281', tadalafil: '358263' };
const CONCEPTS = {
  283742: [['606726', 'esomeprazole 20 MG Delayed Release Oral Capsule'], ['606730', 'esomeprazole 40 MG Delayed Release Oral Capsule']],
  301542: [['859424', 'rosuvastatin calcium 10 MG Oral Tablet'], ['859419', 'rosuvastatin calcium 40 MG Oral Tablet']],
  82112: [['856364', 'trazodone hydrochloride 50 MG Oral Tablet']],
  281: [['197311', 'acyclovir 400 MG Oral Tablet'], ['197313', 'acyclovir 800 MG Oral Tablet'], ['197312', 'acyclovir 0.05 MG/MG Topical Ointment'], ['197310', 'acyclovir 200 MG Oral Capsule']],
  358263: [['403957', 'tadalafil 5 MG Oral Tablet'], ['484814', 'tadalafil 10 MG Oral Tablet']],
};
const NDCS = {
  606726: ['00093645056'], 606730: ['00093645156'], 859424: ['00093744898'], 859419: ['00093745098'], 856364: ['00378347301'],
  197311: ['00378025301'], 197313: ['00378025401'], 197312: ['00472008216'], 197310: ['00378025201'], 403957: ['00093301730'], 484814: ['13668056730'],
};
const NAME_OF_NDC = {};
for (const list of Object.values(CONCEPTS)) for (const [rxcui, name] of list) for (const ndc of NDCS[rxcui] || []) NAME_OF_NDC[ndc] = name;
// medicare.gov on H0982-007: prices the oral generics; no answer for the ointment or tadalafil.
// acyclovir 200 mg capsule: medicare.gov reads it not covered (the book lists "acyclovir cap 200 mg" T2).
const NOT_COVERED = new Set(['00378025201']);
const COST = { '00093645056': 2, '00093645156': 2, '00093744898': 1, '00093745098': 1, '00378347301': 1, '00378025301': 2, '00378025401': 2 };

function stubFetch() {
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  return async (url, opts = {}) => {
    const u = String(url);
    const q = (k) => decodeURIComponent((u.match(new RegExp(`[?&]${k}=([^&]+)`)) || [])[1] || '').replace(/\+/g, ' ');
    if (/\/drugs\/cost$/.test(u)) {
      const body = JSON.parse(opts.body);
      const ndcs = body.prescriptions.map((x) => x.ndc);
      return json({ plans: body.plans.map((plan) => ({
        plan,
        costs: [{ drug_costs: [
          ...ndcs.filter((n) => COST[n]).map((n) => ({ ndc: n, tier: COST[n], covered: true, coverage_reason: 'COVERED' })),
          ...ndcs.filter((n) => NOT_COVERED.has(n)).map((n) => ({ ndc: n, tier: null, covered: false, coverage_reason: 'NOT_IN_FORMULARY' })),
        ] }],
        restrictions: [],
        excluded_drugs: [],
      })) });
    }
    if (u.includes('/rxcui.json?name=')) { const id = EXACT[q('name')]; return json({ idGroup: id ? { rxnormId: [id] } : {} }); }
    if (u.includes('/approximateTerm.json')) return json({ approximateGroup: {} });
    if (u.includes('/drugs/autocomplete')) { const id = EXACT[q('name')]; return json({ drugs: id ? [{ rxcui: id, name: q('name') }] : [] }); }
    const rel = u.match(/\/rxcui\/(\d+)\/related\.json\?tty=SCD/);
    if (rel) return json({ relatedGroup: { conceptGroup: [{ tty: 'SCD', conceptProperties: (CONCEPTS[rel[1]] || []).map(([rxcui, name]) => ({ rxcui, name, tty: 'SCD' })) }] } });
    const nd = u.match(/\/rxcui\/(\d+)\/ndcs\.json/);
    if (nd) return json({ ndcGroup: { ndcList: { ndc: NDCS[nd[1]] || [] } } });
    if (u.includes('/ndcproperties.json')) return json({ ndcPropertyList: { ndcProperty: [{ propertyConceptList: { propertyConcept: [{ propName: 'LABEL_TYPE', propValue: 'HUMAN PRESCRIPTION DRUG' }] } }] } });
    if (u.includes('/ndcstatus.json')) return json({ ndcStatus: { conceptName: NAME_OF_NDC[q('ndc')] || null } });
    return json({}, 404);
  };
}

async function price(drugName) {
  D._nameCache.clear();
  return F.lookupFormulary({ drugName, planIds: [PLAN], year: 2027 }, stubFetch());
}
const cell = (r) => N.medsTable([r], [{ planId: PLAN, name: 'Solis Healthy Living' }]).split('\n')[2].split(' | ').slice(1).join(' | ').replace(/ \|$/, '');

test('esomeprazole magnesium DR capsule 20/40 mg: T2 · QL 30/30 (medicare.gov tier, PDF restrictions)', async () => {
  const r = await price('esomeprazole');
  assert.equal(cell(r), 'T2 $0 · QL 30/30');
  assert.equal(r.byPlanId[PLAN].source, 'medicare_gov');
  for (const p of ['esomeprazole 20 MG Delayed Release Oral Capsule', 'esomeprazole 40 MG Delayed Release Oral Capsule']) {
    const s = S.solisRestrictions({ productName: p }, PLAN, 2027);
    assert.deepEqual([s.pdfTier, s.pa, s.qlText], [2, false, 'QL 30/30'], p);
  }
});

test('rosuvastatin: typed 10 mg → T1 · QL 45/30; no strength → split by QL', async () => {
  assert.equal(cell(await price('rosuvastatin 10 mg')), 'T1 $0 · QL 45/30');
  assert.equal(cell(await price('rosuvastatin')), '5/10/20 mg: T1 $0 · QL 45/30 ‖ 40 mg: T1 $0 · QL 30/30');
});

test('acyclovir tablet 400/800 mg: T2 · no PA/QL (known, no marker)', async () => {
  const r = await price('acyclovir tablets');
  assert.equal(cell(r), 'T2 $0');
  assert.equal(r.byPlanId[PLAN].restrictionsKnown, true);
  assert.equal(S.solisRestrictions({ productName: 'acyclovir 800 MG Oral Tablet' }, PLAN, 2027).pdfTier, 2);
});

test('acyclovir ointment 5%: medicare.gov cannot confirm → PDF row: T4 · PA · QL 30 grams/30 days', async () => {
  const r = await price('acyclovir ointment');
  const row = r.byPlanId[PLAN];
  assert.equal(cell(r), 'T4 40% · PA · QL 30/30');
  assert.match(row.source, /^Solis 2027 Comprehensive Formulary PDF/);
  assert.equal(row.restrictionRow, 'acyclovir oint 5%');
  // Never an oral row for an ointment ask, and RxNorm's "0.05 MG/MG" is the book's 5%.
  assert.equal(S.solisRestrictions({ drugName: 'acyclovir ointment', productName: 'acyclovir 0.05 MG/MG Topical Ointment' }, PLAN, 2027).matchedName, 'acyclovir oint 5%');
});

test('trazodone and tadalafil: unchanged', async () => {
  assert.equal(cell(await price('trazodone')), '50/100/150 mg: T1 $0 ‖ 300 mg: T3 $15');
  assert.equal(cell(await price('tadalafil')),
    '2.5/5 mg: T4 40% · PA (verify indication) · QL 30/30 ‖ 10/20 mg: T6 $0 · QL 8/30 · supplemental ‖ 20 mg (PAH): T4 40% · PA · QL 60/30');
  assert.equal(cell(await price('tadalafil 10 mg')), 'Covered — supplemental benefit (excluded drug; not counted toward Part D OOP max) · T6 $0 · QL 8/30');
});

test('no matching row: no answer from the book ("PA/QL ?" stays)', () => {
  assert.equal(S.solisRestrictions({ drugName: 'zetamol 10 mg' }, PLAN, 2027), null);
  assert.equal(S.solisRestrictions({ drugName: 'rosuvastatin' }, PLAN, 2027), null, 'strengths disagree on QL: no single answer');
  assert.equal(S.solisRestrictions({ drugName: 'rosuvastatin 15 mg' }, PLAN, 2027), null, 'no row at that strength');
  assert.equal(S.solisRestrictions({ drugName: 'trazodone' }, 'H1019-001', 2027), null, 'Solis only');
});

test('a medicare.gov "not covered" is never overridden by the book (acyclovir 200 mg capsule)', async () => {
  assert.equal(S.solisRestrictions({ drugName: 'acyclovir 200 mg capsule' }, PLAN, 2027).pdfTier, 2, 'the book does list it');
  const r = await price('acyclovir 200 mg capsule');
  const row = r.byPlanId[PLAN];
  assert.equal(row.coverage, 'not_covered');
  assert.equal(row.source, 'medicare_gov');
  assert.equal(row.restrictionRow, undefined);
  assert.notEqual(row.tier, 2);
});

test('strengths that differ only in ST or QL still split', () => {
  assert.ok(F.strengthsDiffer([{ coverage: 'covered', tier: 1, qlText: 'QL 45/30' }, { coverage: 'covered', tier: 1, qlText: 'QL 30/30' }]));
  assert.ok(F.strengthsDiffer([{ coverage: 'covered', tier: 1, st: true }, { coverage: 'covered', tier: 1, st: false }]));
  assert.ok(!F.strengthsDiffer([{ coverage: 'covered', tier: 1, qlText: 'QL 30/30' }, { coverage: 'covered', tier: 1, qlText: 'QL 30/30' }]));
});
