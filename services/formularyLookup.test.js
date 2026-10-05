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
  toExportDrugs,
  knownGenericFor,
  medicareGovFetch,
} = require('./formularyLookup');
const { resetDoctorsFormularyCache, DOCTORS_2027_FORMULARY_PDF } = require('./doctorsFormularyPdf');

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

  it('reads Doctors T1–T6 from the 2027 KB for both old and remapped PBPs', () => {
    assert.equal(costShareFromKnowledge('H4140-001', 2027, 4).value, '$55');
    assert.equal(costShareFromKnowledge('H4140-022', 2027, 4).value, '$55');
    assert.equal(costShareFromKnowledge('H4140-012', 2027, 4).value, '$55');
    assert.equal(costShareFromKnowledge('H4140-023', 2027, 4).value, '$55');
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

const DOCTORS_LAYOUT = `
Drug Name/Nombre del Medicamento                  Tier/Nivel de
                                                     Medicamento
TRINTELLIX ORAL TABLET 10 MG, 20 MG,                         4        ST; QL (30 per 30 days)
5 MG
ELIQUIS ORAL TABLET 5 MG                                     3        QL (74 per 30 days)
`;

function doctorsFetch(url, options = {}) {
  const u = String(url);
  if (u.includes('2027_FORMULARY.pdf') || u === DOCTORS_2027_FORMULARY_PDF) {
    return {
      ok: true,
      status: 200,
      text: async () => DOCTORS_LAYOUT,
    };
  }
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
    return jsonRes({ plans: [], message: 'Plan not found' }, 200);
  }
  return jsonRes({ message: 'nope' }, 404);
}

describe('Doctors consumer formulary after medicare.gov misses 2027 H4140', () => {
  it('verifies Trintellix from the PDF for H4140-001/022 and H4140-012/023', async () => {
    resetDoctorsFormularyCache();
    const prev = process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_JWT;
    const result = await lookupFormulary(
      {
        drugName: 'Trintellix',
        planIds: ['H4140-001', 'H4140-022', 'H4140-012', 'H4140-023'],
        year: 2027,
        claimedTier: 4,
      },
      doctorsFetch
    );
    if (prev == null) delete process.env.SUNFIRE_JWT;
    else process.env.SUNFIRE_JWT = prev;

    assert.equal(result.claimedTier, null);
    assert.equal(result.verifiedAny, true);
    for (const id of ['H4140-001', 'H4140-022', 'H4140-012', 'H4140-023']) {
      const row = result.byPlanId[id];
      assert.equal(row.verified, true, id);
      assert.equal(row.tier, 4, id);
      assert.equal(row.st, true, id);
      assert.equal(row.source, 'doctors_formulary_pdf', id);
      assert.equal(row.costShare, '$55', id);
    }
    assert.equal(result.byPlanId['H4140-001'].formularyPlanId, 'H4140-022');
    assert.equal(result.byPlanId['H4140-012'].formularyPlanId, 'H4140-023');
    const text = formatFormularyText(result);
    assert.match(text, /source doctors_formulary_pdf/);
    assert.doesNotMatch(text, /Daisy/i);
    assert.doesNotMatch(text, /claim only/i);
  });

  it('does not run the Doctors module for a non-Doctors plan', async () => {
    resetDoctorsFormularyCache();
    const prev = process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_JWT;
    const urls = [];
    const fetchImpl = async (url, options) => {
      urls.push(String(url));
      return doctorsFetch(url, options);
    };
    const result = await lookupFormulary(
      { drugName: 'Trintellix', planIds: ['H1036-054C'], year: 2027, claimedTier: 4 },
      fetchImpl
    );
    if (prev == null) delete process.env.SUNFIRE_JWT;
    else process.env.SUNFIRE_JWT = prev;

    assert.equal(result.byPlanId['H1036-054C'].verified, false);
    assert.equal(result.byPlanId['H1036-054C'].tier, null);
    assert.equal(
      urls.some((u) => /doctorshcp\.com|2027_FORMULARY/i.test(u)),
      false
    );
  });
});

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

describe('known brand → generic name map (no tiers)', () => {
  it('maps Lipitor and Benicar and does not invent a tier', () => {
    assert.equal(knownGenericFor('Lipitor'), 'Atorvastatin');
    assert.equal(knownGenericFor('Lipitor*'), 'Atorvastatin');
    assert.equal(knownGenericFor('Benicar'), 'Olmesartan');
    assert.equal(knownGenericFor('Trintellix'), null);
    assert.equal(knownGenericFor('Benicar HCT'), null);
  });
});

function brandNotCoveredFetch(url) {
  const u = String(url);
  if (u.includes('/v2/drug/search/lipitor/-1')) {
    return jsonRes({ drugs: [{ id: 11, name: 'Lipitor', ndc: '00710155' }] });
  }
  if (u.includes('/v2/drug/search/atorvastatin/-1')) {
    return jsonRes({ drugs: [{ id: 22, name: 'Atorvastatin', ndc: '00030001' }] });
  }
  if (u.includes('/v2/drug/search/benicar/-1')) {
    return jsonRes({ drugs: [{ id: 33, name: 'Benicar', ndc: '655970101' }] });
  }
  if (u.includes('/v2/drug/search/olmesartan/-1')) {
    return jsonRes({ drugs: [{ id: 44, name: 'Olmesartan', ndc: '00040001' }] });
  }
  if (
    /\/v2\/drug\/(11|33)(\/|$)/.test(u) ||
    u.includes('/v2/drug/search/lipitor/') ||
    u.includes('/v2/drug/search/benicar/')
  ) {
    return jsonRes({ covered: false, coverage: 'not_covered' });
  }
  if (
    /\/v2\/drug\/(22|44)(\/|$)/.test(u) ||
    u.includes('/v2/drug/search/atorvastatin/') ||
    u.includes('/v2/drug/search/olmesartan/')
  ) {
    return jsonRes({ tier: 1, priorAuth: false, stepTherapy: false });
  }
  if (u.includes('fhir.humana.com')) return jsonRes({ resourceType: 'Bundle', entry: [] });
  return jsonRes({ message: 'nope' }, 404);
}

describe('lookupFormulary auto-follows generic when brand is not covered', () => {
  it('looks up Atorvastatin after Lipitor is verified not covered and uses the live generic tier', async () => {
    process.env.SUNFIRE_JWT = 'test-jwt';
    const result = await lookupFormulary(
      { drugName: 'Lipitor', planIds: ['H1036-054C', 'H1036-305'], year: 2027, claimedTier: 4 },
      brandNotCoveredFetch
    );
    delete process.env.SUNFIRE_JWT;

    assert.equal(result.suggestedGeneric, 'Atorvastatin');
    assert.equal(result.byPlanId['H1036-054C'].coverage, 'not_covered');
    assert.equal(result.byPlanId['H1036-054C'].tier, null);
    assert.equal(result.genericFollowup.drugName, 'Atorvastatin');
    assert.equal(result.genericFollowup.byPlanId['H1036-054C'].verified, true);
    assert.equal(result.genericFollowup.byPlanId['H1036-054C'].tier, 1);
    assert.equal(result.genericFollowup.byPlanId['H1036-054C'].costShare, '$0');
    assert.equal(result.genericFollowup.suggestedGeneric, null);

    const text = formatFormularyText(result);
    assert.match(text, /not covered/i);
    assert.match(text, /Suggested generic for Lipitor\*: Atorvastatin/);
    assert.match(text, /do not wait for the agent to type the generic/i);
    assert.match(text, /never invent a tier/i);
    assert.match(text, /verified Tier 1/);
    assert.doesNotMatch(text, /claim only/i);
    assert.doesNotMatch(text, /Daisy/i);

    const exported = toExportDrugs(result);
    assert.equal(exported[0].name, 'Lipitor*');
    assert.equal(exported[0].brandNotCovered, true);
    assert.equal(exported[1].name, 'Atorvastatin (generic)');
    assert.equal(exported[1].genericOf, 'Lipitor');
    assert.equal(exported[1].byPlanId['H1036-054C'].tier, 1);
    assert.equal(toExportDrug(result).claimedTier, undefined);
  });

  it('suggests Olmesartan after Benicar is not covered and leaves Unverified if the generic lookup fails', async () => {
    process.env.SUNFIRE_JWT = 'test-jwt';
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/v2/drug/search/olmesartan')) return jsonRes({ drugs: [] }, 503);
      if (u.includes('/v2/drug/44/') || u.includes('/v2/drug/search/olmesartan/')) {
        return jsonRes({ message: 'nope' }, 404);
      }
      return brandNotCoveredFetch(url);
    };
    const result = await lookupFormulary(
      { drugName: 'Benicar', planIds: ['H1036-054C'], year: 2027, claimedTier: 3 },
      fetchImpl
    );
    delete process.env.SUNFIRE_JWT;

    assert.equal(result.suggestedGeneric, 'Olmesartan');
    assert.equal(result.byPlanId['H1036-054C'].coverage, 'not_covered');
    assert.equal(result.genericFollowup.verifiedAny, false);
    assert.equal(result.genericFollowup.byPlanId['H1036-054C'].tier, null);
    const drugs = toExportDrugs(result);
    assert.equal(drugs[0].name, 'Benicar*');
    assert.equal(drugs[1].name, 'Olmesartan (generic)');
    assert.equal(drugs[1].byPlanId['H1036-054C'].verified, false);
    assert.equal(drugs[1].byPlanId['H1036-054C'].tier, null);
    const text = formatFormularyText(result);
    assert.match(text, /UNVERIFIED/);
    assert.doesNotMatch(text, /verified Tier [1-6].*Olmesartan|Olmesartan.*verified Tier [1-6]/);
  });

  it('does not recurse when skipGenericFollowup is set', async () => {
    process.env.SUNFIRE_JWT = 'test-jwt';
    const result = await lookupFormulary(
      {
        drugName: 'Lipitor',
        planIds: ['H1036-054C'],
        year: 2027,
        skipGenericFollowup: true,
      },
      brandNotCoveredFetch
    );
    delete process.env.SUNFIRE_JWT;
    assert.equal(result.suggestedGeneric, null);
    assert.equal(result.genericFollowup, null);
    assert.equal(result.byPlanId['H1036-054C'].coverage, 'not_covered');
  });

  it('does not invent a generic for a brand that is not in the name map', async () => {
    process.env.SUNFIRE_JWT = 'test-jwt';
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('/v2/drug/search/trintellix/-1')) {
        return jsonRes({ drugs: [{ id: 99, name: 'Trintellix', ndc: '64764072011' }] });
      }
      if (u.includes('/v2/drug/99/') || u.includes('/v2/drug/search/trintellix/')) {
        return jsonRes({ covered: false, coverage: 'not_covered' });
      }
      if (u.includes('fhir.humana.com')) return jsonRes({ resourceType: 'Bundle', entry: [] });
      return jsonRes({ message: 'nope' }, 404);
    };
    const result = await lookupFormulary(
      { drugName: 'Trintellix', planIds: ['H1036-054C'], year: 2027 },
      fetchImpl
    );
    delete process.env.SUNFIRE_JWT;
    assert.equal(result.suggestedGeneric, null);
    assert.equal(result.genericFollowup, null);
    assert.equal(toExportDrugs(result).length, 1);
  });
});

describe('levothyroxine: odd catalog product must not read "not covered"', () => {
  const fl = require('./formularyLookup');
  it('ranks the oral tablet with the asked strength ahead of injection / capsule', () => {
    const drugs = [
      { name: 'Levothyroxine Sodium Intravenous Solution Reconstituted', ndc: '1' },
      { name: 'Levothyroxine Sodium Oral Capsule', ndc: '2' },
      { name: 'Levothyroxine Sodium Oral Tablet 50 MCG', ndc: '3' },
    ];
    assert.equal(fl.pickCatalogMatch(drugs, 'levothyroxine 50').ndc, '3');
    assert.equal(fl.pickCatalogMatch(drugs, 'levothyroxine').ndc, '3');
    assert.equal(fl.pickCatalogMatch([{ name: 'Hydrochlorothiazide Oral Tablet 25 MG', ndc: 'a' }, { name: 'Hydrochlorothiazide Oral Capsule 12.5 MG', ndc: 'b' }], 'hydrochlorothiazide 25').ndc, 'a');
  });
  it('says confirm, not "not covered", in the agent text', () => {
    const text = fl.formatFormularyText({
      drugName: 'Levothyroxine Sodium Oral Capsule', ndc: null, year: 2027, lookups: [{ planId: 'H1045-005', year: 2027, verified: true, coverage: 'not_covered', source: 'sunfire' }], byPlanId: {},
      notCoveredNote: 'read not covered on every plan', catalog: [],
    });
    assert.match(text, /UNVERIFIED NOT-COVERED/);
    assert.match(text, /do NOT state "not covered" as fact/);
  });
});
