const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { loadKnowledge } = require('../knowledge/loader');
const {
  parseCmsId,
  cmsIdsMatch,
  parseTierNumber,
  coverageFromObject,
  firstCoverageHit,
  sunfireIdForPlan,
  pickCatalogMatch,
  humanaPlanYearMatch,
  isHumanaCms,
  cmsContractParts,
  rankNdcs,
  extractMedicareGovCost,
  costShareFromKnowledge,
  costShareFromPlanObject,
  lookupFormulary,
  formatFormularyText,
  toExportDrug,
  medicareGovFetch,
} = require('./formularyLookup');

loadKnowledge({ force: true });

const MAP = {
  262355: { hRaw: 'H1036', planName: 'Humana Gold Plus H1036-054C (HMO)', carrier: 'Humana Inc.' },
  262403: { hRaw: 'H1036', planName: 'Humana Gold Plus Giveback H1036-305 (HMO)', carrier: 'Humana Inc.' },
};

describe('formulary id / tier helpers', () => {
  it('softens letter-PBP the same way the Humana grid does', () => {
    assert.equal(parseCmsId('H1036-054C').base, 'H1036-054');
    assert.equal(parseCmsId('H1036-054C').full, 'H1036-054C');
    assert.equal(cmsIdsMatch('H1036-054C', 'H1036-054'), true);
    assert.equal(cmsIdsMatch('H1036-054C', 'H1036-305'), false);
  });

  it('parses tier numbers and never invents one from junk', () => {
    assert.equal(parseTierNumber(4), 4);
    assert.equal(parseTierNumber('Tier 2'), 2);
    assert.equal(parseTierNumber('T4'), 4);
    assert.equal(parseTierNumber('preferred brand'), null);
  });

  it('reads Sunfire-style coverage objects', () => {
    assert.deepEqual(coverageFromObject({ tier: 3, priorAuth: true, stepTherapy: false }), {
      tier: 3,
      pa: true,
      st: false,
      ql: null,
      coverage: 'covered',
    });
    const nested = firstCoverageHit({ drugs: [{ name: 'Trintellix', formulary: { drugTier: 4, PA: 'yes' } }] });
    assert.equal(nested.tier, 4);
    assert.equal(nested.pa, true);
  });

  it('maps THEI CMS IDs to Sunfire plan ids from the catalog map', () => {
    assert.equal(sunfireIdForPlan('H1036-054C', MAP), '262355');
    assert.equal(sunfireIdForPlan('H1036-305', MAP), '262403');
  });

  it('prefers an exact catalog name match', () => {
    const hit = pickCatalogMatch(
      [
        { name: 'Atorvastatin Calcium 10 MG', ndc: '1' },
        { name: 'Atorvastatin', ndc: '2' },
      ],
      'atorvastatin'
    );
    assert.equal(hit.ndc, '2');
  });
});

describe('Humana FHIR plan-year matching', () => {
  it('requires contract-PBP and year on the PlanID extension', () => {
    assert.equal(isHumanaCms('H1036-054C'), true);
    assert.equal(isHumanaCms('H1045-012'), false);
    assert.equal(humanaPlanYearMatch('H1036-054-000-2027', 'H1036-054C', 2027), true);
    assert.equal(humanaPlanYearMatch('H10360540002027', 'H1036-054C', 2027), true);
    assert.equal(humanaPlanYearMatch('H1036-054-000-2026', 'H1036-054C', 2027), false);
    assert.equal(humanaPlanYearMatch('H1036-305-000-2027', 'H1036-054C', 2027), false);
  });
});

describe('2027 THEI grid cost-share after a verified tier', () => {
  it('reads Gold Plus H1036-054C and Giveback H1036-305 T1–T6 from the 2027 KB', () => {
    assert.equal(costShareFromKnowledge('H1036-054C', 2027, 4).value, '40%');
    assert.equal(costShareFromKnowledge('H1036-054C', 2027, 1).value, '$0');
    assert.equal(costShareFromKnowledge('H1036-305', 2027, 4).value, '50%');
    assert.equal(costShareFromKnowledge('H1036-305', 2027, 3).value, '9%');
    assert.equal(costShareFromKnowledge('H1036-054C', 2026, 4), null);
  });

  it('formats 2026 plan-data copays only when asked for 2026', () => {
    assert.equal(costShareFromPlanObject({ tier4: 0.4 }, 4).value, '40%');
    assert.equal(costShareFromPlanObject({ tier1: 0 }, 1).value, '$0');
  });
});

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

describe('lookupFormulary discards Daisy claimedTier completely', () => {
  it('never surfaces a pasted tier when every live source fails', async () => {
    const prev = process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_JWT;
    const fetchImpl = async () => jsonRes({ resourceType: 'Bundle', entry: [] }, 503);
    const result = await lookupFormulary(
      {
        drugName: 'Trintellix',
        planIds: ['H1036-054C', 'H1036-305'],
        year: 2027,
        claimedTier: 4,
      },
      fetchImpl
    );
    if (prev == null) delete process.env.SUNFIRE_JWT;
    else process.env.SUNFIRE_JWT = prev;

    assert.equal(result.claimedTier, null);
    assert.equal(result.claimedTierDiscarded, true);
    assert.equal(result.verifiedAny, false);
    assert.equal(result.byPlanId['H1036-054C'].verified, false);
    assert.equal(result.byPlanId['H1036-054C'].tier, null);
    const text = formatFormularyText(result);
    assert.match(text, /UNVERIFIED/);
    assert.doesNotMatch(text, /claim only/i);
    assert.doesNotMatch(text, /Client-stated/i);
    assert.doesNotMatch(text, /Daisy/i);
    assert.doesNotMatch(text, /Tier 4/);
    const exported = toExportDrug(result);
    assert.equal(exported.claimedTier, undefined);
    assert.equal(exported.byPlanId['H1036-054C'].verified, false);
  });

  it('uses a live Sunfire tier + 2027 grid cost-share; claimedTier is gone', async () => {
    process.env.SUNFIRE_JWT = 'test-jwt';
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/v2/drug/search/trintellix/-1')) {
        return jsonRes({ drugs: [{ id: 99, name: 'Trintellix', ndc: '64764072011' }] });
      }
      if (u.includes('/v2/drug/99/262355') || u.includes('/v2/drug/search/trintellix/262355')) {
        return jsonRes({ tier: 5, priorAuth: true, stepTherapy: false });
      }
      if (u.includes('/v2/drug/99/262403') || u.includes('/v2/drug/search/trintellix/262403')) {
        return jsonRes({ drugTier: 3, pa: false, st: true });
      }
      if (u.includes('fhir.humana.com')) return jsonRes({ resourceType: 'Bundle', entry: [] });
      return jsonRes({ message: 'nope' }, 404);
    };
    const result = await lookupFormulary(
      {
        drugName: 'Trintellix',
        planIds: ['H1036-054C', 'H1036-305'],
        year: 2027,
        claimedTier: 4,
      },
      fetchImpl
    );
    delete process.env.SUNFIRE_JWT;

    assert.equal(result.claimedTier, null);
    assert.equal(result.claimedTierDiscarded, true);
    assert.equal(result.byPlanId['H1036-054C'].verified, true);
    assert.equal(result.byPlanId['H1036-054C'].tier, 5);
    assert.equal(result.byPlanId['H1036-054C'].costShare, '33%');
    assert.equal(result.byPlanId['H1036-054C'].pa, true);
    assert.equal(result.byPlanId['H1036-305'].tier, 3);
    assert.equal(result.byPlanId['H1036-305'].costShare, '9%');
    const text = formatFormularyText(result);
    assert.match(text, /verified Tier 5/);
    assert.match(text, /FORMULARY_LOOKUP.*verified_tier=5/);
    assert.doesNotMatch(text, /claim only/i);
    assert.doesNotMatch(text, /Client-stated/i);
    assert.doesNotMatch(text, /Daisy/i);
  });

  it('accepts a Humana FHIR hit only when PlanID is this PBP + year', async () => {
    const prev = process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_JWT;
    const fetchImpl = async (url) => {
      if (!String(url).includes('fhir.humana.com')) return jsonRes({}, 401);
      return jsonRes({
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'MedicationKnowledge',
              extension: [
                {
                  url: 'http://hl7.org/fhir/us/davinci-drug-formulary/StructureDefinition/usdf-DrugTierID-extension',
                  valueCodeableConcept: { coding: [{ code: '2', display: 'Generic' }] },
                },
                {
                  url: 'http://hl7.org/fhir/us/davinci-drug-formulary/StructureDefinition/usdf-PriorAuthorization-extension',
                  valueBoolean: false,
                },
                {
                  url: 'http://hl7.org/fhir/us/davinci-drug-formulary/StructureDefinition/usdf-StepTherapyLimit-extension',
                  valueBoolean: false,
                },
                {
                  url: 'http://hl7.org/fhir/us/davinci-drug-formulary/StructureDefinition/usdf-PlanID-extension',
                  valueString: 'H1036-054-000-2027',
                },
              ],
              code: { text: 'atorvastatin 20 mg tablet' },
            },
          },
        ],
      });
    };
    const result = await lookupFormulary(
      { drugName: 'Atorvastatin', planIds: ['H1036-054C', 'H1036-305'], year: 2027, claimedTier: 1 },
      fetchImpl
    );
    if (prev == null) delete process.env.SUNFIRE_JWT;
    else process.env.SUNFIRE_JWT = prev;

    assert.equal(result.byPlanId['H1036-054C'].verified, true);
    assert.equal(result.byPlanId['H1036-054C'].tier, 2);
    assert.equal(result.byPlanId['H1036-054C'].costShare, '$0');
    assert.equal(result.byPlanId['H1036-305'].verified, false);
    assert.equal(result.byPlanId['H1036-305'].tier, null);
  });
});

describe('Medicare.gov Plan Compare source 3', () => {
  it('parses contract-PBP and ranks 30-count NDCs', () => {
    assert.deepEqual(cmsContractParts('H1036-054C'), {
      contractId: 'H1036',
      planId: '054',
      segmentId: '0',
    });
    assert.equal(rankNdcs(['64764073090', '64764073030', '64764073007'])[0], '64764073030');
  });

  it('reads a drugs/cost tier only for the matching contract-PBP + year', () => {
    const payload = {
      plans: [
        {
          plan: { contract_id: 'H1036', plan_id: '054', segment_id: '0', contract_year: '2027' },
          restrictions: [],
          costs: [{ drug_costs: [{ ndc: '64764073030', covered: true, coverage_reason: 'COVERED', tier: 4 }] }],
        },
      ],
    };
    const hit = extractMedicareGovCost(payload, 'H1036-054C', 2027);
    assert.equal(hit.tier, 4);
    assert.equal(extractMedicareGovCost(payload, 'H1036-305', 2027).miss, 'plan_mismatch');
    assert.equal(extractMedicareGovCost(payload, 'H1036-054C', 2026).miss, 'plan_mismatch');
  });

  it('verifies via medicare.gov when Sunfire and FHIR fail, and still discards claimedTier', async () => {
    const prev = process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_JWT;
    const fetchImpl = async (url, options = {}) => {
      const u = String(url);
      if (u.includes('fhir.humana.com')) return jsonRes({ resourceType: 'Bundle', entry: [] }, 403);
      if (u.includes('/drugs/autocomplete')) {
        return jsonRes({ drugs: [{ rxcui: '1790881', name: 'Trintellix' }] });
      }
      if (u.includes('/related.json')) {
        return jsonRes({
          relatedGroup: {
            conceptGroup: [
              {
                tty: 'SBD',
                conceptProperties: [{ rxcui: '1790886', name: 'vortioxetine 10 MG Oral Tablet [Trintellix]' }],
              },
            ],
          },
        });
      }
      if (u.includes('/ndcs.json')) {
        return jsonRes({ ndcGroup: { ndcList: { ndc: ['64764073030'] } } });
      }
      if (u.includes('/drugs/cost')) {
        const body = options.body ? JSON.parse(options.body) : {};
        const plan = (body.plans || [])[0] || {};
        return jsonRes({
          plans: [
            {
              plan: {
                contract_id: plan.contract_id || 'H1036',
                plan_id: plan.plan_id || '054',
                segment_id: '0',
                contract_year: '2027',
              },
              restrictions: [],
              costs: [
                {
                  drug_costs: [
                    { ndc: '64764073030', covered: true, coverage_reason: 'COVERED', tier: plan.plan_id === '305' ? 4 : 4 },
                  ],
                },
              ],
            },
          ],
        });
      }
      return jsonRes({ message: 'nope' }, 404);
    };
    const result = await lookupFormulary(
      { drugName: 'Trintellix', planIds: ['H1036-054C', 'H1036-305'], year: 2027, claimedTier: 4 },
      fetchImpl
    );
    if (prev == null) delete process.env.SUNFIRE_JWT;
    else process.env.SUNFIRE_JWT = prev;

    assert.equal(result.claimedTier, null);
    assert.equal(result.byPlanId['H1036-054C'].verified, true);
    assert.equal(result.byPlanId['H1036-054C'].tier, 4);
    assert.equal(result.byPlanId['H1036-054C'].source, 'medicare_gov');
    assert.equal(result.byPlanId['H1036-054C'].costShare, '40%');
    assert.equal(result.byPlanId['H1036-305'].tier, 4);
    assert.equal(result.byPlanId['H1036-305'].costShare, '50%');
    const text = formatFormularyText(result);
    assert.match(text, /source medicare_gov/);
    assert.doesNotMatch(text, /claim only/i);
    assert.doesNotMatch(text, /Daisy/i);
  });
});

function listenEchoServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/drugs/cost` });
    });
  });
}

describe('medicare.gov POST transport without a preinstalled curl', () => {
  it('POSTs via curl when the binary is present', async () => {
    const { server, url } = await listenEchoServer();
    try {
      const res = await medicareGovFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'atorvastatin' }),
      });
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      const payload = JSON.parse(await res.text());
      assert.match(payload.body, /atorvastatin/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('POSTs via python urllib when curl is missing', async () => {
    const { server, url } = await listenEchoServer();
    const prevCurl = process.env.MEDICARE_GOV_CURL;
    process.env.MEDICARE_GOV_CURL = '/definitely/missing/curl-binary';
    try {
      const res = await medicareGovFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'trintellix' }),
      });
      assert.equal(res.ok, true);
      assert.equal(res.status, 200);
      const payload = JSON.parse(await res.text());
      assert.equal(payload.method, 'POST');
      assert.match(payload.body, /trintellix/);
    } finally {
      if (prevCurl == null) delete process.env.MEDICARE_GOV_CURL;
      else process.env.MEDICARE_GOV_CURL = prevCurl;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('names a transport miss instead of silent http_0 when both binaries are gone', async () => {
    const prevCurl = process.env.MEDICARE_GOV_CURL;
    const prevPy = process.env.MEDICARE_GOV_PYTHON;
    process.env.MEDICARE_GOV_CURL = '/definitely/missing/curl-binary';
    process.env.MEDICARE_GOV_PYTHON = '/definitely/missing/python-binary';
    try {
      const res = await medicareGovFetch('http://127.0.0.1:9/drugs/cost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.equal(res.error, 'medicare_gov_transport_unavailable');
    } finally {
      if (prevCurl == null) delete process.env.MEDICARE_GOV_CURL;
      else process.env.MEDICARE_GOV_CURL = prevCurl;
      if (prevPy == null) delete process.env.MEDICARE_GOV_PYTHON;
      else process.env.MEDICARE_GOV_PYTHON = prevPy;
    }
  });
});
