// Martin Wiesenthal staging run, 2026-10-09: 59 s (English) / 34 s (Spanish) for one comparison.
//   A. medicare.gov NDC resolution (~20 RxNorm / medicare.gov requests) ran once per plan, not per drug.
//   B. Seven guessed Sunfire coverage endpoints 404 for every drug x plan, tried one after another.
//   C. strictName (name unverified) still priced the Sunfire catalog's hint NDC.
//   D. A strength whose RxNav NDC fetch failed vanished from the split instead of "❔ not found".
// RxNorm / medicare.gov / Sunfire are stubbed; nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.SUNFIRE_JWT;

const F = require('./formularyLookup');
const N = require('./doctorPlanNarrow');
const D = require('./drugNames');

const PLANS5 = ['H1019-001', 'H5431-006', 'H1019-002', 'H5431-007', 'H1019-003'];

const EXACT = { trazodone: '82112', esomeprazole: '283742', tadalafil: '358263' };
const CONCEPTS = {
  82112: [['856364', 'trazodone hydrochloride 50 MG Oral Tablet'], ['856369', 'trazodone hydrochloride 100 MG Oral Tablet']],
  283742: [
    ['433733', 'esomeprazole 20 MG Delayed Release Oral Tablet'],
    ['606726', 'esomeprazole 20 MG Delayed Release Oral Capsule'],
  ],
  358263: [
    ['757707', 'tadalafil 2.5 MG Oral Tablet'], ['403957', 'tadalafil 5 MG Oral Tablet'], ['484814', 'tadalafil 10 MG Oral Tablet'],
  ],
};
const NDCS = { 856364: ['00378347301', '00378347305'], 856369: ['00378347401'], 433733: ['00363036142'], 606726: ['00093645056'], 757707: ['00093301630'], 403957: ['00093301730'], 484814: ['13668056730'] };
const OTC = new Set(['00363036142']);
const COST = {
  '00378347301': { tier: 1, covered: true },
  '00378347401': { tier: 2, covered: true },
  '00093645056': { tier: 3, covered: true },
  '00093301630': { covered: false, reason: 'NOT_IN_FORMULARY' },
  '00093301730': { tier: 4, covered: true },
  '13668056730': { covered: false, reason: 'NOT_IN_FORMULARY' },
  '99999999999': { tier: 5, covered: true }, // the Sunfire catalog hint NDC
};

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

function stubFetch({ log = [], costLog = [], rxnormDown = false, ndcsDownFor = null } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    log.push(u);
    const q = (k) => decodeURIComponent((u.match(new RegExp(`[?&]${k}=([^&]+)`)) || [])[1] || '').replace(/\+/g, ' ');
    if (/\/drugs\/cost$/.test(u)) {
      const body = JSON.parse(opts.body);
      const ndcs = body.prescriptions.map((x) => x.ndc);
      costLog.push(...ndcs);
      const plans = body.plans.map((plan) => ({
        plan,
        costs: [{ drug_costs: ndcs.filter((n) => COST[n]).map((n) => ({ ndc: n, tier: COST[n].tier || null, covered: COST[n].covered, coverage_reason: COST[n].reason || 'COVERED' })) }],
        restrictions: [],
        excluded_drugs: [],
      }));
      return json({ plans });
    }
    if (u.includes('/drugs/autocomplete')) {
      const name = q('name');
      const id = EXACT[name.split(/\s+/)[0]];
      return json({ drugs: id ? [{ rxcui: id, name: name.split(/\s+/)[0] }] : [] });
    }
    if (rxnormDown && u.includes('rxnav.nlm.nih.gov')) return { ok: false, status: 0, text: async () => '' };
    if (u.includes('/rxcui.json?name=')) {
      const id = EXACT[q('name')];
      return json({ idGroup: id ? { rxnormId: [id] } : {} });
    }
    if (u.includes('/approximateTerm.json')) return json({ approximateGroup: {} });
    if (/\/related\.json\?tty=IN$/.test(u)) return json({ relatedGroup: { conceptGroup: [] } });
    const rel = u.match(/\/rxcui\/(\d+)\/related\.json\?tty=SCD/);
    if (rel) return json({ relatedGroup: { conceptGroup: [{ tty: 'SCD', conceptProperties: (CONCEPTS[rel[1]] || []).map(([rxcui, name]) => ({ rxcui, name, tty: 'SCD' })) }] } });
    const nd = u.match(/\/rxcui\/(\d+)\/ndcs\.json/);
    if (nd) {
      if (ndcsDownFor && ndcsDownFor.includes(nd[1])) return { ok: false, status: 0, text: async () => '' };
      return json({ ndcGroup: { ndcList: { ndc: NDCS[nd[1]] || [] } } });
    }
    if (u.includes('/ndcproperties.json')) {
      const id = q('id');
      return json({ ndcPropertyList: { ndcProperty: [{ propertyConceptList: { propertyConcept: [{ propName: 'LABEL_TYPE', propValue: OTC.has(id) ? 'HUMAN OTC DRUG' : 'HUMAN PRESCRIPTION DRUG' }] } }] } });
    }
    return json({}, 404);
  };
}

function freshCaches() {
  D._nameCache.clear();
  F._strengthVariantCache.clear();
}

// Plan rows the pre-memo code produced for these asks (captured from main before the change).
const EXPECTED_ROWS = {
  "trazodone 50 mg": [
    {
      "planId": "H1019-001",
      "year": 2027,
      "verified": true,
      "tier": 1,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "82112",
      "costShare": "$0",
      "costShareSource": "kb_2027",
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    },
    {
      "planId": "H5431-006",
      "year": 2027,
      "verified": true,
      "tier": 1,
      "coverage": "covered",
      "pa": false,
      "st": false,
      "ql": false,
      "rxcui": "82112",
      "costShare": "$0",
      "costShareSource": "kb_2027",
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": true,
      "qlText": null,
      "restrictionSource": "HealthSun 2027 formulary PDF (updated 08/21/2026, ID 27026 v8)",
      "restrictionRow": "trazodone hcl oral"
    },
    {
      "planId": "H1019-002",
      "year": 2027,
      "verified": true,
      "tier": 1,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "82112",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    },
    {
      "planId": "H5431-007",
      "year": 2027,
      "verified": true,
      "tier": 1,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "82112",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    },
    {
      "planId": "H1019-003",
      "year": 2027,
      "verified": true,
      "tier": 1,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "82112",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    }
  ],
  "esomeprazole": [
    {
      "planId": "H1019-001",
      "year": 2027,
      "verified": true,
      "tier": 3,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "283742",
      "costShare": "$0",
      "costShareSource": "kb_2027",
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    },
    {
      "planId": "H5431-006",
      "year": 2027,
      "verified": true,
      "tier": 3,
      "coverage": "covered",
      "pa": false,
      "st": false,
      "ql": true,
      "rxcui": "283742",
      "costShare": "25%",
      "costShareSource": "kb_2027",
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": true,
      "qlText": "QL 30/30",
      "restrictionSource": "HealthSun 2027 formulary PDF (updated 08/21/2026, ID 27026 v8)",
      "restrictionRow": "esomeprazole magnesium oral capsule delayed release (rx)"
    },
    {
      "planId": "H1019-002",
      "year": 2027,
      "verified": true,
      "tier": 3,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "283742",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    },
    {
      "planId": "H5431-007",
      "year": 2027,
      "verified": true,
      "tier": 3,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "283742",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    },
    {
      "planId": "H1019-003",
      "year": 2027,
      "verified": true,
      "tier": 3,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "283742",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false
    }
  ],
  "tadalafil": [
    {
      "planId": "H1019-001",
      "year": 2027,
      "verified": true,
      "tier": 4,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "358263",
      "costShare": "50%",
      "costShareSource": "kb_2027",
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false,
      "strengths": [
        {
          "strength": "2.5 mg",
          "productName": "tadalafil 2.5 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "5 mg",
          "productName": "tadalafil 5 MG Oral Tablet",
          "verified": true,
          "coverage": "covered",
          "tier": 4,
          "pa": null,
          "st": null,
          "ql": null,
          "source": "medicare_gov",
          "costShare": "50%",
          "restrictionsKnown": false
        },
        {
          "strength": "10 mg",
          "productName": "tadalafil 10 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        }
      ],
      "edLabel": "Covered — verify if supplemental benefit"
    },
    {
      "planId": "H5431-006",
      "year": 2027,
      "verified": true,
      "tier": 4,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "358263",
      "costShare": "25%",
      "costShareSource": "kb_2027",
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false,
      "strengths": [
        {
          "strength": "2.5 mg",
          "productName": "tadalafil 2.5 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "5 mg",
          "productName": "tadalafil 5 MG Oral Tablet",
          "verified": true,
          "coverage": "covered",
          "tier": 4,
          "pa": true,
          "st": false,
          "ql": true,
          "source": "medicare_gov",
          "costShare": "25%",
          "restrictionsKnown": true,
          "qlText": "QL 30/30",
          "restrictionSource": "HealthSun 2027 formulary PDF (updated 08/21/2026, ID 27026 v8)",
          "restrictionRow": "tadalafil oral tablet 5 mg"
        },
        {
          "strength": "10 mg",
          "productName": "tadalafil 10 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        }
      ],
      "edLabel": "Covered — verify if supplemental benefit"
    },
    {
      "planId": "H1019-002",
      "year": 2027,
      "verified": true,
      "tier": 4,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "358263",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false,
      "strengths": [
        {
          "strength": "2.5 mg",
          "productName": "tadalafil 2.5 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "5 mg",
          "productName": "tadalafil 5 MG Oral Tablet",
          "verified": true,
          "coverage": "covered",
          "tier": 4,
          "pa": null,
          "st": null,
          "ql": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "10 mg",
          "productName": "tadalafil 10 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        }
      ],
      "edLabel": "Covered — verify if supplemental benefit"
    },
    {
      "planId": "H5431-007",
      "year": 2027,
      "verified": true,
      "tier": 4,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "358263",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false,
      "strengths": [
        {
          "strength": "2.5 mg",
          "productName": "tadalafil 2.5 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "5 mg",
          "productName": "tadalafil 5 MG Oral Tablet",
          "verified": true,
          "coverage": "covered",
          "tier": 4,
          "pa": null,
          "st": null,
          "ql": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "10 mg",
          "productName": "tadalafil 10 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        }
      ],
      "edLabel": "Covered — verify if supplemental benefit"
    },
    {
      "planId": "H1019-003",
      "year": 2027,
      "verified": true,
      "tier": 4,
      "coverage": "covered",
      "pa": null,
      "st": null,
      "ql": null,
      "rxcui": "358263",
      "costShare": null,
      "costShareSource": null,
      "source": "medicare_gov",
      "reason": null,
      "formularyPlanId": null,
      "restrictionsKnown": false,
      "strengths": [
        {
          "strength": "2.5 mg",
          "productName": "tadalafil 2.5 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "5 mg",
          "productName": "tadalafil 5 MG Oral Tablet",
          "verified": true,
          "coverage": "covered",
          "tier": 4,
          "pa": null,
          "st": null,
          "ql": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        },
        {
          "strength": "10 mg",
          "productName": "tadalafil 10 MG Oral Tablet",
          "verified": true,
          "coverage": "not_covered",
          "tier": null,
          "source": "medicare_gov",
          "costShare": null,
          "restrictionsKnown": false
        }
      ],
      "edLabel": "Covered — verify if supplemental benefit"
    }
  ]
};

test('A: one drug x 5 plans resolves its NDCs once — autocomplete and related.json are asked once, rows unchanged', async () => {
  freshCaches();
  const log = [];
  const r = await F.lookupFormulary({ drugName: 'trazodone 50 mg', planIds: PLANS5, year: 2027 }, stubFetch({ log }));
  const auto = log.filter((u) => u.includes('/drugs/autocomplete'));
  const related = log.filter((u) => /\/related\.json\?tty=SCD\+SBD/.test(u));
  assert.equal(auto.length, 1, `autocomplete asked ${auto.length} times`);
  assert.equal(related.length, 1, `related.json asked ${related.length} times`);
  assert.deepEqual(r.lookups, EXPECTED_ROWS['trazodone 50 mg']);
  assert.equal(r.lookups.length, 5);
});

test('A: rows for a no-strength ask (split path) are unchanged across 5 plans', async () => {
  for (const drugName of ['esomeprazole', 'tadalafil']) {
    freshCaches();
    const r = await F.lookupFormulary({ drugName, planIds: PLANS5, year: 2027 }, stubFetch());
    assert.deepEqual(r.lookups, EXPECTED_ROWS[drugName], drugName);
  }
});

test('A: a shared resolution error reaches every plan the same way', async () => {
  freshCaches();
  // medicare.gov autocomplete knows nothing: every plan reads the same reason.
  const r = await F.lookupFormulary({ drugName: 'zzzdrug 10 mg', planIds: PLANS5, year: 2027, skipNameCheck: true }, stubFetch());
  const reasons = new Set(r.lookups.map((x) => x.reason));
  assert.equal(reasons.size, 1);
  assert.match([...reasons][0], /medicare_gov/);
  // A resolver that throws: the lookup rejects (as it did when each plan resolved on its own).
  await assert.rejects(
    F.lookupMedicareGov({ drugName: 'trazodone 50 mg', planId: 'H1019-001', year: 2027 }, stubFetch(), () => Promise.reject(new Error('boom'))),
    /boom/
  );
});

test('A: lookupMedicareGov uses an injected resolution and never re-resolves', async () => {
  freshCaches();
  const log = [];
  const f = stubFetch({ log });
  const resolved = F.resolveMedicareGovNdcs({ drugName: 'trazodone 50 mg' }, f);
  const before = log.length;
  const out = [];
  for (const planId of PLANS5) out.push(await F.lookupMedicareGov({ drugName: 'trazodone 50 mg', planId, year: 2027 }, f, () => resolved));
  assert.equal(log.slice(before).filter((u) => u.includes('/drugs/autocomplete')).length, 0);
  assert.ok(out.every((o) => o.verified && o.tier === 1));
});

// ─── B: Sunfire probe breaker ────────────────────────────────────────────────

function sunfireStub(statusFor, log) {
  return async (url) => {
    const u = String(url);
    log.push(u);
    const s = statusFor(u);
    if (s === 'html') return { ok: true, status: 200, text: async () => '<html>app shell</html>' };
    if (s === 200) return json({ drugs: [{ tier: 2, covered: true }] });
    return json({ message: 'nope' }, s);
  };
}

test('B: an endpoint answering 404 three times is skipped on the 4th call; cooldown expiry re-probes once', async () => {
  process.env.SUNFIRE_JWT = 'test';
  let now = 1_000_000;
  F._resetSunfireProbeBreaker(() => now);
  try {
    const log = [];
    const f = sunfireStub(() => 404, log);
    const args = { drug: { name: 'trazodone', id: 'D1' }, planId: 'H1019-001', year: 2027, sunfirePlanId: 'SF1' };
    for (let i = 0; i < 3; i += 1) {
      const r = await F.lookupSunfireCoverage(args, f);
      assert.equal(r.reason, 'sunfire_no_tier');
      assert.equal(r.attempted.length, 7);
    }
    assert.equal(log.length, 21);
    const r4 = await F.lookupSunfireCoverage(args, f);
    assert.equal(log.length, 21, 'all seven endpoints parked: no request on the 4th call');
    assert.equal(r4.reason, 'sunfire_no_tier');
    // Another drug / plan hits the same endpoint templates: also skipped.
    await F.lookupSunfireCoverage({ ...args, drug: { name: 'esomeprazole', id: 'D2' }, sunfirePlanId: 'SF2' }, f);
    assert.equal(log.length, 21);
    // Cooldown over: each endpoint is asked once more; still 404 → parked again right away.
    now += F.SUNFIRE_PROBE_COOLDOWN_MS + 1;
    await F.lookupSunfireCoverage(args, f);
    assert.equal(log.length, 28);
    await F.lookupSunfireCoverage(args, f);
    assert.equal(log.length, 28);
  } finally {
    F._resetSunfireProbeBreaker();
    delete process.env.SUNFIRE_JWT;
  }
});

test('B: non-JSON bodies count as dead; 405 / 410 too', async () => {
  process.env.SUNFIRE_JWT = 'test';
  F._resetSunfireProbeBreaker(() => 0);
  try {
    const log = [];
    const f = sunfireStub((u) => (u.includes('/v2/drug/search/') ? 'html' : u.includes('POST') ? 405 : 410), log);
    const args = { drug: { name: 'trazodone', id: 'D1' }, planId: 'H1019-001', year: 2027, sunfirePlanId: 'SF1' };
    for (let i = 0; i < 3; i += 1) await F.lookupSunfireCoverage(args, f);
    const n = log.length;
    await F.lookupSunfireCoverage(args, f);
    assert.equal(log.length, n);
  } finally {
    F._resetSunfireProbeBreaker();
    delete process.env.SUNFIRE_JWT;
  }
});

test('B: 401 / 403 are never parked and the lookup still says sunfire_session_expired; 5xx and timeouts are not dead', async () => {
  process.env.SUNFIRE_JWT = 'test';
  F._resetSunfireProbeBreaker(() => 0);
  try {
    for (const status of [401, 403]) {
      const log = [];
      const f = sunfireStub(() => status, log);
      const args = { drug: { name: 'trazodone', id: 'D1' }, planId: 'H1019-001', year: 2027, sunfirePlanId: 'SF1' };
      for (let i = 0; i < 5; i += 1) await F.lookupSunfireCoverage(args, f);
      assert.equal(log.length, 35, `${status}: every call still asks every endpoint`);
      // End to end: the expired session is what the lookup reports, never a silent skip.
      freshCaches();
      const sun = sunfireStub(() => status, []);
      const rest = stubFetch();
      const mixed = (u, o) => (String(u).startsWith(F.SUNFIRE_BASE) ? sun(u, o) : rest(u, o));
      for (let i = 0; i < 4; i += 1) {
        const r = await F.lookupFormulary({ drugName: 'trazodone 50 mg', planIds: ['H1019-001'], year: 2027 }, mixed);
        assert.equal(r.catalogError, 'sunfire_session_expired');
      }
    }
    for (const status of [500, 503, 0]) {
      const log = [];
      const f = status === 0 ? async (u) => { log.push(u); throw new Error('socket hang up'); } : sunfireStub(() => status, log);
      const args = { drug: { name: 'trazodone', id: 'D1' }, planId: 'H1019-001', year: 2027, sunfirePlanId: 'SF1' };
      for (let i = 0; i < 4; i += 1) await F.lookupSunfireCoverage(args, f);
      assert.equal(log.length, 28, `${status}: not parked`);
    }
  } finally {
    F._resetSunfireProbeBreaker();
    delete process.env.SUNFIRE_JWT;
  }
});

test('B: a success resets the count', async () => {
  process.env.SUNFIRE_JWT = 'test';
  F._resetSunfireProbeBreaker(() => 0);
  try {
    const log = [];
    let calls = 0;
    // First endpoint: 404, 404, 200, 404, 404 → never three in a row, never parked.
    const f = sunfireStub((u) => {
      if (!/\/v2\/drug\/search\/trazodone\/SF1$/.test(u)) return 404;
      calls += 1;
      return calls === 3 ? 200 : 404;
    }, log);
    const args = { drug: { name: 'trazodone', id: 'D1' }, planId: 'H1019-001', year: 2027, sunfirePlanId: 'SF1' };
    const out = [];
    for (let i = 0; i < 5; i += 1) out.push(await F.lookupSunfireCoverage(args, f));
    assert.equal(out[2].tier, 2);
    assert.equal(calls, 5, 'the first endpoint was asked every time');
  } finally {
    F._resetSunfireProbeBreaker();
    delete process.env.SUNFIRE_JWT;
  }
});

test('B: the catalog search is never parked', async () => {
  process.env.SUNFIRE_JWT = 'test';
  F._resetSunfireProbeBreaker(() => 0);
  try {
    const log = [];
    const f = sunfireStub(() => 404, log);
    for (let i = 0; i < 5; i += 1) await F.searchSunfireCatalog('trazodone', f);
    assert.equal(log.length, 5);
  } finally {
    F._resetSunfireProbeBreaker();
    delete process.env.SUNFIRE_JWT;
  }
});

// ─── C: strictName drops the Sunfire hint NDC ────────────────────────────────

test('C: strictName=true never prices the hint NDC', async () => {
  freshCaches();
  const costLog = [];
  const f = stubFetch({ costLog });
  // Autocomplete does not know the name: today the hint NDC was the only thing left to price.
  const strict = await F.resolveMedicareGovNdcs({ drugName: 'zzzdrug', hintNdc: '99999999999', strictName: true }, f);
  assert.ok(!strict.ndcs.includes('99999999999'));
  const mpf = await F.lookupMedicareGov({ drugName: 'zzzdrug', hintNdc: '99999999999', planId: 'H1019-001', year: 2027, strictName: true }, f);
  assert.equal(mpf.verified, false);
  assert.ok(!costLog.includes('99999999999'), 'hint NDC was priced');
  // Not strict: the hint is still a fallback, as before.
  const loose = await F.resolveMedicareGovNdcs({ drugName: 'zzzdrug', hintNdc: '99999999999' }, f);
  assert.ok(loose.ndcs.includes('99999999999'));
});

// ─── D: a strength whose NDC fetch failed stays as "❔ not found" ────────────

test('D: one strength group with a failed ndcs fetch shows as verified:false / "❔ not found", not cached', async () => {
  freshCaches();
  // 10 mg (484814) NDC fetch fails; 2.5 mg and 5 mg answer.
  const f = stubFetch({ ndcsDownFor: ['484814'] });
  const v = await F.medicareGovStrengthVariants({ drugName: 'tadalafil', planIds: ['H1019-001', 'H5431-006'], year: 2027 }, f);
  for (const planId of ['H1019-001', 'H5431-006']) {
    const ten = v[planId].find((x) => x.strength === '10 mg');
    assert.deepEqual(ten, { strength: '10 mg', productName: 'tadalafil 10 MG Oral Tablet', verified: false, coverage: null, tier: null, source: 'medicare_gov' });
    assert.equal(v[planId].length, 3);
  }
  const row = { planId: 'H1019-001', verified: true, coverage: 'covered', tier: 4, strengths: v['H1019-001'] };
  const cell = N.medsTable([{ drugName: 'tadalafil', byPlanId: { 'H1019-001': row }, lookups: [row] }], [{ planId: 'H1019-001', name: 'CarePlus' }]).split('\n')[2];
  assert.match(cell, /10 mg: ❔ not found/);
  // Not cached: the next call asks again.
  let calls = 0;
  const counting = (url, opts) => { calls += 1; return stubFetch()(url, opts); };
  const again = await F.medicareGovStrengthVariants({ drugName: 'tadalafil', planIds: ['H1019-001', 'H5431-006'], year: 2027 }, counting);
  assert.ok(calls > 0);
  assert.equal(again['H1019-001'].find((x) => x.strength === '10 mg').coverage, 'not_covered');
  F._strengthVariantCache.clear();
});

// ─── timing debug line ───────────────────────────────────────────────────────

test('FORMULARY_DEBUG=1 logs one timing line with the fetch count', async () => {
  freshCaches();
  const prev = process.env.FORMULARY_DEBUG;
  process.env.FORMULARY_DEBUG = '1';
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  let fetches = 0;
  const base = stubFetch();
  try {
    await F.lookupFormulary({ drugName: 'trazodone 50 mg', planIds: PLANS5, year: 2027 }, (u, o) => { fetches += 1; return base(u, o); });
  } finally {
    console.log = orig;
    if (prev === undefined) delete process.env.FORMULARY_DEBUG; else process.env.FORMULARY_DEBUG = prev;
  }
  const timing = lines.filter((l) => l.startsWith('[formulary-debug] timing'));
  assert.equal(timing.length, 1);
  assert.match(timing[0], new RegExp(`^\\[formulary-debug\\] timing drug="trazodone 50 mg" ms=\\d+ fetches=${fetches}$`));
});

