// HealthSun 2027 formulary PDF (HS-CY-2027-Formulary-Abridged-and-Comprehensive-Rev.-0821.pdf,
// updated 08/21/2026, HPMS formulary ID 27026 v8) as the PA / ST / QL source for HealthSun plans.
// medicare.gov stays the tier / cost source; it never reports restrictions, so these cells read
// "PA/QL ?" before. RxNorm / medicare.gov are stubbed with the answers they gave live (2026-10-09).
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.SUNFIRE_JWT;

const F = require('./formularyLookup');
const N = require('./doctorPlanNarrow');
const D = require('./drugNames');
const H = require('./healthsunFormulary');

const EXACT = { esomeprazole: '283742', rosuvastatin: '301542', trazodone: '82112', acyclovir: '281', tadalafil: '358263', zetamol: '999101' };
const CONCEPTS = {
  283742: [['606726', 'esomeprazole 20 MG Delayed Release Oral Capsule']],
  301542: [['859424', 'rosuvastatin calcium 10 MG Oral Tablet']],
  82112: [['856364', 'trazodone hydrochloride 50 MG Oral Tablet']],
  281: [['197311', 'acyclovir 400 MG Oral Tablet'], ['197312', 'acyclovir 0.05 MG/MG Topical Ointment']],
  358263: [
    ['757707', 'tadalafil 2.5 MG Oral Tablet'], ['403957', 'tadalafil 5 MG Oral Tablet'], ['484814', 'tadalafil 10 MG Oral Tablet'],
    ['402019', 'tadalafil 20 MG Oral Tablet'], ['2123194', 'Pulmonary Hypertension tadalafil 20 MG Oral Tablet'],
  ],
  // Not in the HealthSun book at all.
  999101: [['999111', 'zetamol 10 MG Oral Tablet']],
};
const NDCS = {
  606726: ['00093645056'], 859424: ['00093744898'], 856364: ['00378347301'], 197311: ['00378025301'], 197312: ['00472008216'],
  757707: ['00093301630'], 403957: ['00093301730'], 484814: ['13668056730'], 402019: ['13668056830'], 2123194: ['13668058130'],
  999111: ['99910000011'],
};
const NAME_OF_NDC = {};
for (const list of Object.values(CONCEPTS)) for (const [rxcui, name] of list) for (const ndc of NDCS[rxcui] || []) NAME_OF_NDC[ndc] = name;
// medicare.gov on H5431-006 / H5431-012 (live, 2026-10-09); H5431-012 stubbed with the ointment not covered.
const COVERED = { tier: null, covered: false, reason: 'NOT_IN_FORMULARY' };
const COST = {
  'H5431-006': {
    '00093645056': { tier: 2 }, '00093744898': { tier: 1 }, '00378347301': { tier: 1 }, '00378025301': { tier: 1 }, '00472008216': { tier: 2 },
    '00093301630': COVERED, '00093301730': { tier: 4 }, '13668056730': { tier: 6 }, '13668056830': { tier: 6 }, '13668058130': { tier: 4 },
    '99910000011': { tier: 3 },
  },
  'H5431-012': { '00472008216': { covered: false, reason: 'NOT_COVERED' }, '00378347301': { tier: 1 } },
};
const EXCLUDED = { 'H5431-006': ['13668056730', '13668056830'] };

function stubFetch(log = []) {
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  return async (url, opts = {}) => {
    const u = String(url);
    const q = (k) => decodeURIComponent((u.match(new RegExp(`[?&]${k}=([^&]+)`)) || [])[1] || '').replace(/\+/g, ' ');
    if (/\/drugs\/cost$/.test(u)) {
      const body = JSON.parse(opts.body);
      const ndcs = body.prescriptions.map((x) => x.ndc);
      log.push(...ndcs);
      const plans = body.plans.map((plan) => {
        const id = `${plan.contract_id}-${plan.plan_id}`;
        const costs = COST[id] || {};
        return {
          plan,
          costs: [{ drug_costs: ndcs.filter((n) => costs[n]).map((n) => ({ ndc: n, tier: costs[n].tier || null, covered: costs[n].covered !== false, coverage_reason: costs[n].reason || 'COVERED' })) }],
          restrictions: [],
          excluded_drugs: EXCLUDED[id] || [],
        };
      });
      return json({ plans });
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

async function price(drugName, planIds = ['H5431-006'], log = []) {
  D._nameCache.clear();
  return F.lookupFormulary({ drugName, planIds, year: 2027 }, stubFetch(log));
}
const cell = (r, planId = 'H5431-006') => N.medsTable([r], [{ planId, name: planId }]).split('\n')[2].split(' | ').slice(1).join(' | ').replace(/ \|$/, '');

// ─── the index built from the PDF ─────────────────────────────────────────────

test('index: source, plans covered, and the rows exactly as the book prints them', () => {
  const idx = H._loadIndex();
  assert.equal(idx.formularyId, '27026');
  assert.equal(idx.version, '8');
  assert.equal(idx.asOf, '08/21/2026');
  assert.equal(idx.source, 'HS-CY-2027-Formulary-Abridged-and-Comprehensive-Rev.-0821.pdf');
  for (const id of ['H5431-001', 'H5431-006', 'H5431-012', 'H5431-017', 'H5431-018', 'H5431-019', 'H5431-021', 'H5431-026']) assert.ok(idx.plans.includes(id), id);
  const row = (name) => idx.rows.find((r) => r.name === name);
  assert.deepEqual([row('esomeprazole magnesium oral capsule delayed release (rx)').tier, row('esomeprazole magnesium oral capsule delayed release (rx)').req], [2, 'QL (30 per 30 days); MO; 90D']);
  assert.deepEqual([row('tadalafil oral tablet 10 mg, 20 mg').tier, row('tadalafil oral tablet 10 mg, 20 mg').req], [6, 'QL (6 per 30 days); ED']);
  assert.deepEqual([row('tadalafil oral tablet 5 mg').tier, row('tadalafil oral tablet 5 mg').req], [4, 'PA; QL (30 per 30 days); MO']);
  assert.deepEqual([row('tadalafil (pah)').tier, row('tadalafil (pah)').req], [4, 'PA; QL (60 per 30 days)']);
  // Wrapped requirements and decimal quantity limits stay on their own row.
  assert.equal(row('meperidine hcl oral solution').req, 'PA; QL (900 per 30 days); NEDS; HRM');
  assert.equal(row('teriparatide subcutaneous solution pen-injector 560 mcg/2.24ml').qlText, 'QL 2.24/28');
  assert.equal(row('tolvaptan oral tablet').tier, 5);
});

test('reader: only plans the book covers; none for CarePlus', () => {
  assert.ok(H.isHealthSunFormularyPlan('H5431-006', 2027));
  assert.ok(H.isHealthSunFormularyPlan('H5431-012', 2027));
  assert.ok(!H.isHealthSunFormularyPlan('H1019-001', 2027));
  assert.ok(!H.isHealthSunFormularyPlan('H5431-006', 2026));
});

// ─── H5431-006: the exact facts ──────────────────────────────────────────────

test('H5431-006 cells: medicare.gov tier/cost + the book\'s PA/ST/QL', async () => {
  assert.equal(cell(await price('esomeprazole')), 'T2 $0 · QL 30/30');
  assert.equal(cell(await price('rosuvastatin')), 'T1 $0 · QL 30/30');
  assert.equal(cell(await price('trazodone')), 'T1 $0', 'trazodone hcl oral is "MO; 100D" only: known, no PA/QL');
  assert.equal(cell(await price('acyclovir tablets')), 'T1 $0');
  assert.equal(cell(await price('acyclovir ointment')), 'T2 $0 · PA · QL 30/30');
});

test('H5431-006 tadalafil: per-strength rows stay separate; supplemental label stays', async () => {
  const split = await price('tadalafil');
  assert.equal(cell(split),
    '2.5 mg: ❌ not covered ‖ 5 mg: T4 25% · PA (verify indication) · QL 30/30 ‖ 10/20 mg: T6 $0 · QL 6/30 · supplemental ‖ 20 mg (PAH): T4 25% · PA · QL 60/30');
  assert.equal(cell(await price('tadalafil 20 mg')),
    'Covered — supplemental benefit (excluded drug; not counted toward Part D OOP max) · T6 $0 · QL 6/30');
  assert.equal(cell(await price('tadalafil 10 mg')),
    'Covered — supplemental benefit (excluded drug; not counted toward Part D OOP max) · T6 $0 · QL 6/30');
  assert.equal(cell(await price('tadalafil 5 mg')), 'Covered · PA required (verify indication) · T4 25% · PA · QL 30/30');
  assert.equal(cell(await price('tadalafil 20 mg pah')), 'Covered — Part D for BPH/PAH only (PA required, verify diagnosis) · T4 25% · PA · QL 60/30');
  const r = (await price('tadalafil 20 mg')).byPlanId['H5431-006'];
  assert.equal(r.source, 'medicare_gov', 'tier and cost stay medicare.gov');
  assert.match(r.restrictionSource, /^HealthSun 2027 formulary PDF \(updated 08\/21\/2026, ID 27026 v8\)$/);
});

// ─── the rules ───────────────────────────────────────────────────────────────

test('no row for that drug / strength → "PA/QL ?", never "no restrictions"', async () => {
  const z = await price('zetamol');
  assert.equal(z.byPlanId['H5431-006'].restrictionsKnown, false);
  assert.match(cell(z), /^T3 .* · PA\/QL \?$/);
  // A row exists for tadalafil, but not at 2.5 mg.
  assert.equal(H.healthsunRestrictions({ drugName: 'tadalafil 2.5 mg' }, 'H5431-006', 2027), null);
  // Rows that disagree (no strength, no product) are not a match either.
  assert.equal(H.healthsunRestrictions({ drugName: 'tadalafil' }, 'H5431-006', 2027), null);
});

test('a medicare.gov "not covered" is never overridden by the book', async () => {
  const r = await price('acyclovir ointment', ['H5431-012']);
  const row = r.byPlanId['H5431-012'];
  assert.equal(row.coverage, 'not_covered');
  assert.equal(row.restrictionSource, undefined);
  assert.equal(row.pa, null, 'the book\'s "PA" is not applied to a not-covered answer');
  // Every plan read not covered, so the existing "confirm the exact product" cell shows — no PDF flags.
  assert.equal(cell(r, 'H5431-012'), '⚠️ confirm');
});

test('MO / 90D / 100D only means no PA/QL (known); other plans keep "PA/QL ?"', async () => {
  const r = await price('trazodone', ['H5431-006', 'H1019-001']);
  assert.equal(r.byPlanId['H5431-006'].restrictionsKnown, true);
  assert.equal(r.byPlanId['H5431-006'].pa, false);
  // CarePlus is not in the HealthSun book: its row never gets the book's restrictions.
  assert.equal(r.byPlanId['H1019-001'].restrictionSource, undefined);
  const brand = H.healthsunRestrictions({ drugName: 'Eliquis', productName: 'apixaban 5 MG Oral Tablet [Eliquis]' }, 'H5431-006', 2027);
  assert.equal(brand.matchedName, 'ELIQUIS ORAL TABLET 5 MG', 'RxNorm branded product matches the book\'s brand row');
});
