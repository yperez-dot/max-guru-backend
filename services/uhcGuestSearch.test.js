const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  CARRIER_LABEL,
  PLAN_YEAR,
  THEI_UHC_CONTRACTS,
  cmsId,
  normalizeCmsId,
  npiMatches,
  formatPlanLabel,
  isTheiUhcPlan,
  reciprocityId,
  populationFor,
  pickPlans,
  formatAddress,
  queryUhcGuest,
  resetSessionCache,
  formatUhcAgentNote,
} = require('./uhcGuestSearch');

describe('uhcGuestSearch helpers', () => {
  it('defaults to AEP 2027', () => {
    assert.equal(PLAN_YEAR, '2027');
    assert.equal(CARRIER_LABEL, 'UnitedHealthcare');
    assert.ok(THEI_UHC_CONTRACTS.includes('H1045'));
  });

  it('normalizes CMS IDs from UHC plan identifiers', () => {
    assert.equal(cmsId('H1045-012-000'), 'H1045-012');
    assert.equal(cmsId('H1045-061'), 'H1045-061');
    assert.equal(normalizeCmsId('h1045-012-000'), 'H1045-012');
    assert.equal(cmsId('not-a-plan'), null);
  });

  it('matches NPI as string or number', () => {
    assert.equal(npiMatches('1598792707', 1598792707), true);
    assert.equal(npiMatches('1306409339', '1598792707'), false);
  });

  it('labels plans with CMS id', () => {
    assert.equal(
      formatPlanLabel({
        planName: 'UHC Preferred Dual Complete FL-QV4 (HMO D-SNP)',
        planIdentifier: 'H1045-012-000',
      }),
      'UHC Preferred Dual Complete FL-QV4 (HMO D-SNP) (H1045-012)'
    );
  });

  it('keeps THEI individual UHC plans and drops group / other carriers', () => {
    const dual = {
      planName: 'UHC Preferred Dual Complete FL-QV4 (HMO D-SNP)',
      planIdentifier: 'H1045-012-000',
      medicarePlanType: 'INDIVIDUAL',
    };
    const group = { ...dual, planIdentifier: 'H1045-801-000', medicarePlanType: 'GROUP' };
    const humana = { planName: 'Humana', planIdentifier: 'H1036-054-000', medicarePlanType: 'INDIVIDUAL' };
    assert.equal(isTheiUhcPlan(dual), true);
    assert.equal(isTheiUhcPlan(group), false);
    assert.equal(isTheiUhcPlan(humana), false);
    assert.deepEqual(pickPlans([dual, group, humana], ['H1045-012']).map((p) => p.planIdentifier), ['H1045-012-000']);
  });

  it('uses COSMOS population and plan-year reciprocity', () => {
    const plan = {
      searchDirectory: 'DSNP',
      years: [{ planYear: '2027', reciprocityId: '115' }],
    };
    assert.equal(populationFor(plan), 'COSMOS');
    assert.equal(reciprocityId(plan), '115');
  });

  it('never phrases a failed check as out of network', () => {
    const note = formatUhcAgentNote({
      year: '2027',
      error: 'request_failed',
      checks: [],
      publicUrl: 'https://www.uhc.com/find-a-doctor',
    });
    assert.match(note, /Failed check/);
    assert.doesNotMatch(note, /^Out of network/m);
  });

  it('formats guest address lines', () => {
    assert.equal(
      formatAddress({ line: ['3626 NW 7th St'], city: 'Miami', state: 'FL', postalCode: '33125-4069' }),
      '3626 NW 7th St, Miami, FL, 33125'
    );
  });
});

function jsonRes(body, cookies = []) {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => cookies },
    json: async () => body,
  };
}

function mockFetch(routes) {
  return async (url, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
    const op = body.operationName || '';
    if (String(url).includes('/api/create-guest-session')) {
      return jsonRes({ success: true }, ['PSX_GUEST_SESSION=abc; Path=/']);
    }
    if (String(url).includes('/api/authorize-guest-session')) {
      return jsonRes({ authorized: true });
    }
    if (String(url).includes('/api/graphql')) {
      if (typeof routes[op] === 'function') return jsonRes({ data: routes[op](body.variables || {}) });
      if (routes[op]) return jsonRes({ data: routes[op] });
      throw new Error(`unexpected graphql ${op}`);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

const DUAL_012 = {
  planName: 'UHC Preferred Dual Complete FL-QV4 (HMO D-SNP)',
  planIdentifier: 'H1045-012-000',
  medicarePlanType: 'INDIVIDUAL',
  searchDirectory: 'COSMOS',
  years: [{ planYear: '2027', reciprocityId: '115' }],
};
const DUAL_061 = {
  planName: 'UHC Preferred Dual Complete FL-QV5 (HMO D-SNP)',
  planIdentifier: 'H1045-061-000',
  medicarePlanType: 'INDIVIDUAL',
  searchDirectory: 'COSMOS',
  years: [{ planYear: '2027', reciprocityId: '115' }],
};

describe('queryUhcGuest mocked path', () => {
  beforeEach(() => resetSessionCache());

  it('returns in-network for a matching 2027 Dual NPI', async () => {
    const fetchImpl = mockFetch({
      GetLocation: { location: { features: [{ center: ['-80.36', '25.68'], stateCode: 'FL' }] } },
      GetPostalPoint: { getPostalPoint: { county_proper: 'Miami-Dade', county_id: '12086', state: 'FL' } },
      GetPlanDefinitions: { getPlanDefinitions: { planDetails: [DUAL_012, DUAL_061] } },
      ProviderSearch: {
        providerSearch: {
          providers: [{
            npi: '1598792707',
            firstName: 'Lazaro',
            middleName: 'Miguel',
            lastName: 'Garcia',
            speciality: 'Family Practice',
            address: { line: ['3626 NW 7th St'], city: 'Miami', state: 'FL', postalCode: '33125' },
          }],
        },
      },
    });
    const result = await queryUhcGuest('1598792707', { zip: '33176', planIds: ['H1045-012', 'H1045-061'] }, fetchImpl);
    assert.equal(result.error, null);
    assert.equal(result.inNetwork, true);
    assert.equal(result.year, '2027');
    assert.ok(result.plans.some((p) => /H1045-012/.test(p)));
    assert.equal(result.checks.every((c) => c.status === 'in_network'), true);
    assert.equal(result.matches[0].name, 'Lazaro Miguel Garcia');
  });

  it('treats a successful empty search as out of network for that plan', async () => {
    const fetchImpl = mockFetch({
      GetLocation: { location: { features: [{ center: ['-80.36', '25.68'], stateCode: 'FL' }] } },
      GetPostalPoint: { getPostalPoint: { county_proper: 'Miami-Dade', county_id: '12086', state: 'FL' } },
      GetPlanDefinitions: { getPlanDefinitions: { planDetails: [DUAL_012] } },
      ProviderSearch: { providerSearch: { providers: [] } },
    });
    const result = await queryUhcGuest('1306409339', { zip: '33176', planIds: ['H1045-012'] }, fetchImpl);
    assert.equal(result.error, null);
    assert.equal(result.inNetwork, false);
    assert.deepEqual(result.plans, []);
    assert.equal(result.checks[0].status, 'out_of_network');
    assert.ok(result.outOfNetworkPlans[0].includes('H1045-012'));
  });

  it('does not treat a GraphQL failure as out of network', async () => {
    const fetchImpl = mockFetch({
      GetLocation: { location: { features: [{ center: ['-80.36', '25.68'], stateCode: 'FL' }] } },
      GetPostalPoint: { getPostalPoint: { county_proper: 'Miami-Dade', county_id: '12086', state: 'FL' } },
      GetPlanDefinitions: { getPlanDefinitions: { planDetails: [DUAL_012] } },
      ProviderSearch: () => { throw new Error('should use HTTP error'); },
    });
    // Override graphql search to return an error payload
    const failing = async (url, options = {}) => {
      if (String(url).includes('/api/graphql')) {
        const body = JSON.parse(options.body || '{}');
        if (body.operationName === 'ProviderSearch') {
          return {
            ok: true,
            status: 200,
            headers: { getSetCookie: () => [] },
            json: async () => ({ errors: [{ message: 'upstream timeout' }] }),
          };
        }
      }
      return fetchImpl(url, options);
    };
    const result = await queryUhcGuest('1598792707', { zip: '33176', planIds: ['H1045-012'] }, failing);
    assert.equal(result.inNetwork, false);
    assert.deepEqual(result.outOfNetworkPlans, []);
    assert.equal(result.checks[0].status, 'failed');
    assert.equal(result.error, 'request_failed');
  });

  it('ignores a search hit whose NPI does not match', async () => {
    const fetchImpl = mockFetch({
      GetLocation: { location: { features: [{ center: ['-80.36', '25.68'], stateCode: 'FL' }] } },
      GetPostalPoint: { getPostalPoint: { county_proper: 'Miami-Dade', county_id: '12086', state: 'FL' } },
      GetPlanDefinitions: { getPlanDefinitions: { planDetails: [DUAL_012] } },
      ProviderSearch: {
        providerSearch: { providers: [{ npi: '1497949424', firstName: 'Mireya', lastName: 'Garcia' }] },
      },
    });
    const result = await queryUhcGuest('1598792707', { zip: '33176', planIds: ['H1045-012'] }, fetchImpl);
    assert.equal(result.inNetwork, false);
    assert.equal(result.checks[0].status, 'out_of_network');
  });
});
