/**
 * CarePlus public Find Care guest directory (same Humana APIM, CarePlus hostname).
 *
 * Public SPA: https://findcare.careplushealthplans.com
 * Guest search is by network. THEI 2027 CarePlus HMO / C-SNP / D-SNP plans in
 * Miami-Dade and Broward share CarePlus27 (networkId 4263).
 *
 * A successful empty providersearch is out-of-network for that network.
 * Config / token / search failure is a failed check — never invent OON.
 * When guest fails, the 2027 county PDF index may still mark a listed doctor In
 * (partial list — a PDF miss stays not confirmed, never Out).
 */

const {
  npiMatches,
  resultHasNpi,
  formatMatch,
  geoForZip,
  cmsIdsMatch,
  COUNTY_MIAMI_DADE,
  COUNTY_BROWARD,
} = require('./humanaFindcare');
const careplusDirectory = require('./careplusDirectory');

const FINDCARE_BASE = 'https://findcare.careplushealthplans.com';
const APIM_BASE = `${FINDCARE_BASE}/apim-gateway/api`;
const CONFIG_URL = `${FINDCARE_BASE}/session/v1/config`;
const GUEST_TOKEN_URL = `${APIM_BASE}/v1/token/validate/guest`;
const NETWORKS_URL = `${APIM_BASE}/v1/networks/medical`;
const SEARCH_NPI_URL = `${APIM_BASE}/v1/providersearch/npi/`;
const PUBLIC_FIND_CARE = 'https://findcare.careplushealthplans.com';
const PLAN_YEAR = '2027';
const CARRIER_LABEL = 'CarePlus';
const CUSTOMER_ID = 1;
const MEDICARE_COVERAGE_TYPE_ID = 3;
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_RADIUS = 50;
const SEARCH_LIMIT = 20;
const FALLBACK_APIM_SUBSCRIPTION = '7f74c6e49dac4c04a5cfd8d686124418';

const THEI_CAREPLUS_NETWORKS = [
  {
    networkId: 4263,
    networkName: 'CarePlus27',
    coverageTypeId: MEDICARE_COVERAGE_TYPE_ID,
    plans: [
      { cmsId: 'H1019-006', planName: 'CarePlus CareOne Plus', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1019-001', planName: 'CarePlus CareOne Plus', counties: [COUNTY_BROWARD] },
      { cmsId: 'H1019-148', planName: 'CarePlus CareAccess', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
      { cmsId: 'H1019-136', planName: 'CarePlus CareFree Platinum', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1019-135', planName: 'CarePlus CareFree Platinum', counties: [COUNTY_BROWARD] },
      { cmsId: 'H1019-065', planName: 'CarePlus CareFree Giveback', counties: [COUNTY_BROWARD] },
      { cmsId: 'H1019-154', planName: 'CarePlus CareBreeze', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1019-123', planName: 'CarePlus CareBreeze Platinum', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1019-124', planName: 'CarePlus CareBreeze Platinum POS', counties: [COUNTY_BROWARD] },
      { cmsId: 'H1019-150', planName: 'CarePlus CareComplete', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1019-121', planName: 'CarePlus CareComplete Platinum', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1019-130', planName: 'CarePlus CareComplete Platinum POS', counties: [COUNTY_BROWARD] },
      { cmsId: 'H1019-023', planName: 'CarePlus CareNeeds Platinum', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
    ],
  },
];

let sessionCache = null;
let sessionPromise = null;
const networksCache = new Map();

function newCookieJar() {
  return new Map();
}

function storeCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const nv = String(raw).split(';')[0];
    const eq = nv.indexOf('=');
    if (eq < 0) continue;
    jar.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

function guestHeaders(jar, extra = {}) {
  const headers = {
    Accept: '*/*',
    Origin: FINDCARE_BASE,
    Referer: `${FINDCARE_BASE}/`,
    'User-Agent': 'Mozilla/5.0',
    'X-Fc-Tab': '1',
    'X-Fc-Module': 'med',
    ...extra,
  };
  const cookies = cookieHeader(jar);
  if (cookies) headers.Cookie = cookies;
  return headers;
}

async function fetchJar(jar, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, headers: guestHeaders(jar, options.headers), signal: ctrl.signal });
    storeCookies(jar, res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function formatPlanLabel(plan) {
  const name = plan?.planName || 'CarePlus plan';
  const id = plan?.cmsId;
  return id ? `${name} (${id})` : name;
}

function plansForNetwork(network, { county, planIds } = {}) {
  let plans = (network.plans || []).filter((p) => !county || p.counties.includes(county));
  if (planIds && planIds.length) {
    const filtered = plans.filter((p) => planIds.some((id) => cmsIdsMatch(p.cmsId, id)));
    if (filtered.length) plans = filtered;
  }
  return plans;
}

function emptyResult({ error = null, year = PLAN_YEAR, county = null, source = 'findcare' } = {}) {
  return {
    inNetwork: false,
    plans: [],
    outOfNetworkPlans: [],
    checks: [],
    matches: [],
    error,
    carrierLabel: CARRIER_LABEL,
    year: String(year),
    county,
    sourceUrl: PUBLIC_FIND_CARE,
    publicUrl: PUBLIC_FIND_CARE,
    source,
    partialList: source !== 'findcare',
    status: error ? 'failed' : 'checked',
  };
}

async function mintSession(fetchImpl = fetch) {
  const jar = newCookieJar();
  const cfgRes = await fetchJar(jar, CONFIG_URL, {}, FETCH_TIMEOUT_MS, fetchImpl);
  const cfg = await cfgRes.json().catch(() => null);
  const apimKey = cfg?.APIM_SUBSCRIPTION || FALLBACK_APIM_SUBSCRIPTION;
  if (!cfgRes.ok && !apimKey) {
    throw new Error(`careplus findcare config HTTP ${cfgRes.status}`);
  }
  const tokenRes = await fetchJar(jar, GUEST_TOKEN_URL, {
    headers: { 'Ocp-Apim-Subscription-Key': apimKey },
  }, FETCH_TIMEOUT_MS, fetchImpl);
  if (!tokenRes.ok) {
    throw new Error(`careplus findcare guest token HTTP ${tokenRes.status}`);
  }
  return { jar, apimKey, expiresAt: Date.now() + 20 * 60 * 1000 };
}

async function getSession(fetchImpl = fetch) {
  if (sessionCache && sessionCache.expiresAt > Date.now()) return sessionCache;
  if (!sessionPromise) {
    sessionPromise = mintSession(fetchImpl)
      .then((session) => {
        sessionCache = session;
        return session;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

async function apimPost(session, url, body, fetchImpl = fetch) {
  const res = await fetchJar(session.jar, url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': session.apimKey,
    },
    body: JSON.stringify(body),
  }, FETCH_TIMEOUT_MS, fetchImpl);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.title || data?.message || `careplus findcare HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchFutureNetworks(session, zip, fetchImpl) {
  const data = await apimPost(session, NETWORKS_URL, {
    CustomerId: CUSTOMER_ID,
    ZipCode: String(zip),
    IsNoNetwork: false,
  }, fetchImpl);
  return data?.future || [];
}

function listFutureNetworks(session, zip, fetchImpl) {
  const key = String(zip);
  const hit = networksCache.get(key);
  if (hit && hit.session === session) return hit.promise;
  const promise = fetchFutureNetworks(session, zip, fetchImpl).catch((err) => {
    networksCache.delete(key);
    throw err;
  });
  networksCache.set(key, { session, promise });
  return promise;
}

async function searchNetwork(session, { npi, geo, network }, fetchImpl) {
  try {
    const data = await apimPost(session, SEARCH_NPI_URL, {
      customerId: CUSTOMER_ID,
      networkId: network.networkId,
      coverageTypeId: network.coverageTypeId || MEDICARE_COVERAGE_TYPE_ID,
      value: String(npi),
      distance: SEARCH_RADIUS,
      offset: 1,
      limit: SEARCH_LIMIT,
      sortBy: 5,
      location: {
        latitude: geo.lat,
        longitude: geo.lng,
        zipCode: geo.zip,
      },
      filters: [{ id: 0, values: [] }],
      centerwellConvivaFilter: 0,
      tealiumSessionId: '',
      ipaId: 0,
      coverageYear: 'Future',
    }, fetchImpl);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.results)) {
      throw new Error('careplus findcare: response is not a search result');
    }
    const hit = resultHasNpi(data, npi);
    return {
      networkId: network.networkId,
      networkName: network.networkName,
      plans: network.plans,
      status: hit ? 'in_network' : 'out_of_network',
      error: null,
      match: hit ? firstMatch(data, npi) : null,
      resultCount: Number(data?.resultCount || 0),
    };
  } catch (err) {
    return {
      networkId: network.networkId,
      networkName: network.networkName,
      plans: network.plans,
      status: 'failed',
      error: err.name === 'AbortError' ? 'Timeout' : err.message,
      match: null,
    };
  }
}

function firstMatch(data, npi) {
  const rows = data?.results || [];
  const hit = rows.find((row) => npiMatches(row.nationalProviderIdentifiers, npi));
  return hit ? formatMatch(hit) : null;
}

function pdfFallback({ firstName, middleName, lastName, zip, year, county, plans }) {
  const pdf = careplusDirectory.careplusCheck({ firstName, middleName, lastName, zip });
  if (pdf && pdf.inNetwork) {
    return {
      inNetwork: true,
      plans: (plans || []).map(formatPlanLabel),
      outOfNetworkPlans: [],
      checks: [],
      matches: pdf.matches || [],
      error: null,
      carrierLabel: CARRIER_LABEL,
      year: String(year),
      county,
      sourceUrl: PUBLIC_FIND_CARE,
      publicUrl: PUBLIC_FIND_CARE,
      source: 'pdf',
      partialList: true,
      status: 'checked',
    };
  }
  return {
    ...emptyResult({
      error: pdf && pdf.status === 'checked' ? null : 'request_failed',
      year,
      county,
      source: 'pdf',
    }),
    status: pdf && pdf.status === 'checked' ? 'checked' : 'failed',
    matches: (pdf && pdf.matches) || [],
    partialList: true,
  };
}

/**
 * Look up one NPI in CarePlus's public Medicare Find Care guest directory.
 * Successful empty → Out. Guest failure → PDF In if listed, else not confirmed (never guessed Out).
 */
async function queryCareplusFindcare(npi, {
  zip = '33176',
  planIds = [],
  year = PLAN_YEAR,
  firstName = '',
  middleName = '',
  lastName = '',
} = {}, fetchImpl = fetch) {
  const geo = geoForZip(zip);
  const network = {
    ...THEI_CAREPLUS_NETWORKS[0],
    plans: plansForNetwork(THEI_CAREPLUS_NETWORKS[0], { county: geo.county, planIds }),
  };
  const fallback = () => pdfFallback({
    firstName, middleName, lastName, zip, year, county: geo.county, plans: network.plans,
  });

  if (!npi) return fallback();

  try {
    const session = await getSession(fetchImpl);
    const future = await listFutureNetworks(session, geo.zip, fetchImpl);
    const liveIds = new Set((future || []).filter((n) => n && n.networkId).map((n) => Number(n.networkId)));
    if (!liveIds.has(Number(network.networkId))) {
      return fallback();
    }
    if (!network.plans.length) {
      network.plans = plansForNetwork(THEI_CAREPLUS_NETWORKS[0], { county: geo.county, planIds: [] });
    }

    const check = await searchNetwork(session, { npi, geo, network }, fetchImpl);
    if (check.status === 'failed') return fallback();

    const inNetwork = check.status === 'in_network';
    return {
      inNetwork,
      plans: inNetwork ? network.plans.map(formatPlanLabel) : [],
      outOfNetworkPlans: inNetwork ? [] : network.plans.map(formatPlanLabel),
      checks: [check],
      matches: check.match ? [check.match] : [],
      error: null,
      carrierLabel: CARRIER_LABEL,
      year: String(year),
      county: geo.county,
      sourceUrl: PUBLIC_FIND_CARE,
      publicUrl: PUBLIC_FIND_CARE,
      source: 'findcare',
      partialList: false,
      status: 'checked',
    };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[careplusFindcare] ${label}`);
    sessionCache = null;
    networksCache.clear();
    return fallback();
  }
}

function resetSessionCache() {
  sessionCache = null;
  sessionPromise = null;
  networksCache.clear();
}

module.exports = {
  CARRIER_LABEL,
  PLAN_YEAR,
  FINDCARE_BASE,
  PUBLIC_FIND_CARE,
  SEARCH_NPI_URL,
  THEI_CAREPLUS_NETWORKS,
  queryCareplusFindcare,
  resetSessionCache,
  formatPlanLabel,
  plansForNetwork,
};
