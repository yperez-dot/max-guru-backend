const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  CARRIER_LABEL,
  PLAN_YEAR,
  THEI_HUMANA_NETWORKS,
  SEARCH_NPI_URL,
  parseCmsId,
  cmsIdsMatch,
  npiMatches,
  formatPlanLabel,
  countyForZip,
  geoForZip,
  plansForNetwork,
  pickTheiNetworks,
  isHumanaLabel,
  resultHasNpi,
  queryHumanaFindcare,
  resetSessionCache,
  formatHumanaAgentNote,
} = require('./humanaFindcare');

describe('humanaFindcare helpers', () => {
  it('defaults to AEP 2027', () => {
    assert.equal(PLAN_YEAR, '2027');
    assert.equal(CARRIER_LABEL, 'Humana');
    assert.ok(THEI_HUMANA_NETWORKS.some((n) => n.networkId === 4250));
    assert.match(SEARCH_NPI_URL, /providersearch\/npi\/$/);
  });

  it('matches letter-PBP CMS IDs used on the THEI Humana grid', () => {
    assert.equal(parseCmsId('H1036-054C').base, 'H1036-054');
    assert.equal(parseCmsId('H1036-054').full, 'H1036-054');
    assert.equal(cmsIdsMatch('H1036-054C', 'H1036-054'), true);
    assert.equal(cmsIdsMatch('H1036-054C', 'H1036-065'), false);
  });

  it('matches NPI in a string or identifier array', () => {
    assert.equal(npiMatches('1497949424', 1497949424), true);
    assert.equal(npiMatches(['1497949424'], '1497949424'), true);
    assert.equal(npiMatches(['1598792707'], '1497949424'), false);
  });

  it('labels plans with CMS id', () => {
    assert.equal(
      formatPlanLabel({ planName: 'Humana Gold Plus', cmsId: 'H1036-054C' }),
      'Humana Gold Plus (H1036-054C)'
    );
  });

  it('maps Miami-Dade vs Broward ZIPs', () => {
    assert.equal(countyForZip('33176'), 'miami-dade');
    assert.equal(countyForZip('33312'), 'broward');
    assert.equal(geoForZip('33125').lat, 25.779);
  });

  it('keeps Dual Integrated only in Miami-Dade and drops other carriers', () => {
    const fide = THEI_HUMANA_NETWORKS.find((n) => n.networkId === 4372);
    assert.deepEqual(plansForNetwork(fide, { county: 'miami-dade' }).map((p) => p.cmsId), ['H1036-339']);
    assert.deepEqual(plansForNetwork(fide, { county: 'broward' }), []);
    const live = [
      { networkId: 4250, networkName: 'FL Medicare HMO27' },
      { networkId: 4263, networkName: 'CarePlus27' },
    ];
    const picked = pickTheiNetworks(live, { county: 'miami-dade', planIds: ['H1036-054'] });
    assert.deepEqual(picked.map((n) => n.networkId), [4250]);
    assert.ok(picked[0].plans.some((p) => p.cmsId === 'H1036-054C'));
  });

  it('does not treat a CarePlus Sunfire label as Humana', () => {
    assert.equal(isHumanaLabel('Humana Gold Plus — Humana Inc.'), true);
    assert.equal(isHumanaLabel('CarePlus CareComplete (Humana)'), false);
  });

  it('never phrases a failed check as out of network', () => {
    const note = formatHumanaAgentNote({
      year: '2027',
      error: 'request_failed',
      checks: [],
      publicUrl: 'https://findcare.humana.com',
    });
    assert.match(note, /Failed check/);
    assert.doesNotMatch(note, /^Out of network/m);
  });

  it('requires a matching NPI on the search hit', () => {
    assert.equal(
      resultHasNpi({ results: [{ nationalProviderIdentifiers: ['1497949424'] }] }, '1497949424'),
      true
    );
    assert.equal(
      resultHasNpi({ results: [{ nationalProviderIdentifiers: ['1497949424'] }] }, '1598792707'),
      false
    );
  });
});

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => [] },
    json: async () => body,
  };
}

function mockFetch(routes) {
  return async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/session/v1/config')) return jsonRes({ APIM_SUBSCRIPTION: 'test-key' });
    if (u.includes('/token/validate/guest')) return jsonRes(200);
    if (u.includes('/networks/medical')) {
      const impl = routes.networks;
      return jsonRes(typeof impl === 'function' ? impl(JSON.parse(options.body || '{}')) : impl);
    }
    if (u.includes('/providersearch/npi')) {
      assert.match(u, /npi\/$/);
      const impl = routes.search;
      if (typeof impl === 'function') return impl(JSON.parse(options.body || '{}'), u);
      return jsonRes(impl);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

const HMO27 = { networkId: 4250, networkName: 'FL Medicare HMO27', coverageTypeId: 3 };
const PPO27 = { networkId: 4225, networkName: 'Medicare PPO27', coverageTypeId: 3 };
const MIREYA = {
  resultCount: 1,
  results: [{
    providerId: 'p1',
    officeId: 'o1',
    providerName: 'Garcia, Mireya MD',
    primarySpecialty: 'Internal Medicine',
    nationalProviderIdentifiers: ['1497949424'],
    address: { line1: '123 Main', city: 'Miami', state: 'FL', zipCode: '33125' },
  }],
};

describe('queryHumanaFindcare mocked path', () => {
  beforeEach(() => resetSessionCache());

  it('returns in-network for a matching 2027 HMO NPI', async () => {
    const fetchImpl = mockFetch({
      networks: { current: [], future: [HMO27, PPO27] },
      search: (body) => {
        if (body.networkId === 4250 && body.coverageYear === 'Future') return jsonRes(MIREYA);
        return jsonRes({ resultCount: 0, results: [] });
      },
    });
    const result = await queryHumanaFindcare('1497949424', { zip: '33125', planIds: ['H1036-054'] }, fetchImpl);
    assert.equal(result.error, null);
    assert.equal(result.inNetwork, true);
    assert.equal(result.year, '2027');
    assert.ok(result.plans.some((p) => /H1036-054C/.test(p)));
    assert.equal(result.checks[0].status, 'in_network');
    assert.equal(result.matches[0].name, 'Garcia, Mireya MD');
  });

  it('treats a successful empty search as out of network for that network', async () => {
    const fetchImpl = mockFetch({
      networks: { current: [], future: [HMO27] },
      search: { resultCount: 0, results: [] },
    });
    const result = await queryHumanaFindcare('1306409339', { zip: '33176', planIds: ['H1036-054'] }, fetchImpl);
    assert.equal(result.error, null);
    assert.equal(result.inNetwork, false);
    assert.deepEqual(result.plans, []);
    assert.equal(result.checks[0].status, 'out_of_network');
    assert.ok(result.outOfNetworkPlans[0].includes('H1036-054C'));
  });

  it('does not treat an HTTP failure as out of network', async () => {
    const fetchImpl = mockFetch({
      networks: { current: [], future: [HMO27] },
      search: () => jsonRes({ message: 'upstream timeout' }, 502),
    });
    const result = await queryHumanaFindcare('1497949424', { zip: '33176', planIds: ['H1036-054'] }, fetchImpl);
    assert.equal(result.inNetwork, false);
    assert.deepEqual(result.outOfNetworkPlans, []);
    assert.equal(result.checks[0].status, 'failed');
    assert.equal(result.error, 'request_failed');
  });

  it('ignores a search hit whose NPI does not match', async () => {
    const fetchImpl = mockFetch({
      networks: { current: [], future: [HMO27] },
      search: MIREYA,
    });
    const result = await queryHumanaFindcare('1598792707', { zip: '33125', planIds: ['H1036-054'] }, fetchImpl);
    assert.equal(result.inNetwork, false);
    assert.equal(result.checks[0].status, 'out_of_network');
  });

  it('reports PPO27 OON while HMO27 is in-network for the same NPI', async () => {
    const fetchImpl = mockFetch({
      networks: { current: [], future: [HMO27, PPO27] },
      search: (body) => jsonRes(body.networkId === 4250 ? MIREYA : { resultCount: 0, results: [] }),
    });
    const result = await queryHumanaFindcare('1497949424', {
      zip: '33125',
      planIds: ['H1036-054', 'H7617-145'],
    }, fetchImpl);
    assert.equal(result.inNetwork, true);
    assert.ok(result.plans.some((p) => /H1036-054C/.test(p)));
    assert.ok(result.outOfNetworkPlans.some((p) => /H7617-145/.test(p)));
  });
});
