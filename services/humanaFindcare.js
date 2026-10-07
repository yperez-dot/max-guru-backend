/**
 * Humana public Find Care guest directory (no member login, no Jarvis).
 *
 * Public SPA: https://findcare.humana.com
 * (humana.com/finder redirects here. “Search as a guest.”)
 *
 * Flow, probed 2026-10-02:
 *   1. GET /session/v1/config → APIM_SUBSCRIPTION (public SPA key)
 *   2. GET /apim-gateway/api/v1/token/validate/guest
 *   3. POST /apim-gateway/api/v1/networks/medical  {CustomerId, ZipCode, IsNoNetwork}
 *        future[] = 2027 AEP networks (names end in 27)
 *   4. POST /apim-gateway/api/v1/providersearch/npi/  by NPI against a network
 *        Trailing slash is required — without it nginx 502s.
 *
 * Guest search is by **network**, not PBP. THEI 2027 Gold Plus HMO/C-SNP/Giveback
 * share FL Medicare HMO27; Dual Select share HIDE HMO27; Dual Integrated is
 * FIDE HMO27; Choice PPO is Medicare PPO27.
 *
 * A successful empty providersearch is out-of-network for THAT network.
 * Config / token / search failure is a failed check — never invent OON.
 *
 * Live smoke 2026-10-02 (Miami-Dade 33125):
 *   Mireya Garcia 1497949424 → IN HMO27 / HIDE / FIDE; OON Medicare PPO27
 *   Tharkur 1306409339 → successful empty on those 2027 Medicare networks
 */

const FINDCARE_BASE = 'https://findcare.humana.com';
const APIM_BASE = `${FINDCARE_BASE}/apim-gateway/api`;
const CONFIG_URL = `${FINDCARE_BASE}/session/v1/config`;
const GUEST_TOKEN_URL = `${APIM_BASE}/v1/token/validate/guest`;
const NETWORKS_URL = `${APIM_BASE}/v1/networks/medical`;
const SEARCH_NPI_URL = `${APIM_BASE}/v1/providersearch/npi/`;
const PUBLIC_FIND_CARE = 'https://findcare.humana.com';
const PLAN_YEAR = '2027';
const CARRIER_LABEL = 'Humana';
const CUSTOMER_ID = 1;
const MEDICARE_COVERAGE_TYPE_ID = 3;
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_CONCURRENCY = 4;
const SEARCH_RADIUS = 50;
const SEARCH_LIMIT = 20;

/** Public SPA subscription key baked into /session/v1/config (not a private secret). */
const FALLBACK_APIM_SUBSCRIPTION = '7f74c6e49dac4c04a5cfd8d686124418';

const COUNTY_MIAMI_DADE = 'miami-dade';
const COUNTY_BROWARD = 'broward';

/** THEI 2027 South Florida Humana contracts on the working grid (green cells). */
const THEI_HUMANA_NETWORKS = [
  {
    networkId: 4250,
    networkName: 'FL Medicare HMO27',
    coverageTypeId: MEDICARE_COVERAGE_TYPE_ID,
    plans: [
      { cmsId: 'H1036-054C', planName: 'Humana Gold Plus', counties: [COUNTY_MIAMI_DADE] },
      { cmsId: 'H1036-065C', planName: 'Humana Gold Plus', counties: [COUNTY_BROWARD] },
      { cmsId: 'H1036-305', planName: 'Humana Gold Plus Giveback', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
      { cmsId: 'H1036-121', planName: 'Humana Gold Plus Diabetes & Heart', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
      { cmsId: 'H1036-297', planName: 'Humana Gold Plus Lung', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
    ],
  },
  {
    networkId: 4356,
    networkName: 'FL Medicare HIDE HMO27',
    coverageTypeId: MEDICARE_COVERAGE_TYPE_ID,
    plans: [
      { cmsId: 'H1036-077', planName: 'Humana Dual Select', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
      { cmsId: 'H1036-304', planName: 'Humana Dual Select', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
    ],
  },
  {
    networkId: 4372,
    networkName: 'FL Medicare FIDE HMO27',
    coverageTypeId: MEDICARE_COVERAGE_TYPE_ID,
    plans: [
      { cmsId: 'H1036-339', planName: 'Humana Dual Integrated', counties: [COUNTY_MIAMI_DADE] },
    ],
  },
  {
    networkId: 4225,
    networkName: 'Medicare PPO27',
    coverageTypeId: MEDICARE_COVERAGE_TYPE_ID,
    plans: [
      { cmsId: 'H7617-107', planName: 'HumanaChoice', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
      { cmsId: 'H7617-110', planName: 'HumanaChoice Giveback', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
      { cmsId: 'H7617-145', planName: 'HumanaChoice Giveback', counties: [COUNTY_MIAMI_DADE, COUNTY_BROWARD] },
    ],
  },
];

const ZIP_GEO = {
  '33125': { lat: 25.779, lng: -80.237, county: COUNTY_MIAMI_DADE },
  '33136': { lat: 25.788, lng: -80.211, county: COUNTY_MIAMI_DADE },
  '33145': { lat: 25.753, lng: -80.233, county: COUNTY_MIAMI_DADE },
  '33126': { lat: 25.778, lng: -80.297, county: COUNTY_MIAMI_DADE },
  '33166': { lat: 25.827, lng: -80.317, county: COUNTY_MIAMI_DADE },
  '33174': { lat: 25.759, lng: -80.357, county: COUNTY_MIAMI_DADE },
  '33176': { lat: 25.654, lng: -80.361, county: COUNTY_MIAMI_DADE },
  '33183': { lat: 25.694, lng: -80.404, county: COUNTY_MIAMI_DADE },
  '33186': { lat: 25.658, lng: -80.398, county: COUNTY_MIAMI_DADE },
  '33196': { lat: 25.651, lng: -80.451, county: COUNTY_MIAMI_DADE },
  '33010': { lat: 25.839, lng: -80.283, county: COUNTY_MIAMI_DADE },
  '33012': { lat: 25.864, lng: -80.304, county: COUNTY_MIAMI_DADE },
  '33015': { lat: 25.937, lng: -80.326, county: COUNTY_MIAMI_DADE },
  '33054': { lat: 25.862, lng: -80.250, county: COUNTY_MIAMI_DADE },
  '33004': { lat: 26.052, lng: -80.143, county: COUNTY_BROWARD },
  '33009': { lat: 25.985, lng: -80.148, county: COUNTY_BROWARD },
  '33019': { lat: 26.021, lng: -80.116, county: COUNTY_BROWARD },
  '33021': { lat: 26.021, lng: -80.187, county: COUNTY_BROWARD },
  '33060': { lat: 26.230, lng: -80.125, county: COUNTY_BROWARD },
  '33064': { lat: 26.248, lng: -80.125, county: COUNTY_BROWARD },
  '33312': { lat: 26.118, lng: -80.171, county: COUNTY_BROWARD },
  '33317': { lat: 26.124, lng: -80.226, county: COUNTY_BROWARD },
  '33328': { lat: 26.066, lng: -80.271, county: COUNTY_BROWARD },
  '33334': { lat: 26.185, lng: -80.133, county: COUNTY_BROWARD },
};

const DEFAULT_GEO = ZIP_GEO['33176'];

let sessionCache = null;
// Concurrent doctor lookups share one guest-token mint and one networks list per ZIP.
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

function parseCmsId(value) {
  const m = String(value || '').toUpperCase().match(/^(H\d{4}|R\d{4})-(\d{3})([A-Z])?/);
  if (!m) return null;
  const base = `${m[1]}-${m[2]}`;
  return { base, letter: m[3] || '', full: m[3] ? `${base}${m[3]}` : base };
}

function cmsIdKey(value) {
  const parsed = parseCmsId(value);
  return parsed ? parsed.base : null;
}

function cmsIdsMatch(a, b) {
  const pa = parseCmsId(a);
  const pb = parseCmsId(b);
  return Boolean(pa && pb && pa.base === pb.base);
}

function npiMatches(value, npi) {
  const wanted = String(npi || '');
  if (!wanted) return false;
  if (Array.isArray(value)) return value.some((v) => String(v) === wanted);
  return String(value || '') === wanted;
}

function formatPlanLabel(plan) {
  const name = plan?.planName || 'Humana plan';
  const id = plan?.cmsId;
  return id ? `${name} (${id})` : name;
}

function countyForZip(zip) {
  const geo = ZIP_GEO[String(zip || '').slice(0, 5)];
  if (geo) return geo.county;
  // THEI's county-by-ZIP table first: 330xx is Broward for Coral Springs (33065-33077), Tamarac, Margate…
  // — the old "333/334 prefix" guess called 33076 Miami-Dade, which hid Broward-only plans like H1036-065C.
  try {
    const c = require('./comparisonRules').countyForZip(zip);
    if (c === 'Broward') return COUNTY_BROWARD;
    if (c === 'Miami-Dade') return COUNTY_MIAMI_DADE;
  } catch (_) { /* fall through */ }
  const prefix = String(zip || '').slice(0, 3);
  if (prefix === '333' || prefix === '334') return COUNTY_BROWARD;
  return COUNTY_MIAMI_DADE;
}

function geoForZip(zip) {
  const key = String(zip || '').slice(0, 5);
  if (ZIP_GEO[key]) return { ...ZIP_GEO[key], zip: key };
  const county = countyForZip(key);
  const fallback = county === COUNTY_BROWARD ? ZIP_GEO['33312'] : DEFAULT_GEO;
  return { ...fallback, zip: key || fallback.zip || '33176', county };
}

function plansForNetwork(network, { county, planIds } = {}) {
  let plans = (network.plans || []).filter((p) => !county || p.counties.includes(county));
  if (planIds && planIds.length) {
    plans = plans.filter((p) => planIds.some((id) => cmsIdsMatch(p.cmsId, id)));
  }
  return plans;
}

function pickTheiNetworks(directoryNetworks, { county, planIds } = {}) {
  const liveIds = new Set(
    (directoryNetworks || [])
      .filter((n) => n && n.networkId)
      .map((n) => Number(n.networkId))
  );
  return THEI_HUMANA_NETWORKS
    .filter((net) => liveIds.has(Number(net.networkId)))
    .map((net) => ({ ...net, plans: plansForNetwork(net, { county, planIds }) }))
    .filter((net) => net.plans.length > 0);
}

function emptyResult({ error = null, year = PLAN_YEAR, county = null } = {}) {
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
  };
}

async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function formatMatch(row) {
  const addr = row.address || {};
  const line = [addr.line1 || addr.address1, addr.city, addr.state, String(addr.zipCode || addr.postalCode || '').slice(0, 5)]
    .filter(Boolean)
    .join(', ');
  const npis = row.nationalProviderIdentifiers || [];
  return {
    npi: String(npis[0] || ''),
    name: row.providerName || '',
    specialty: row.primarySpecialty || '',
    address: line,
    providerId: row.providerId || '',
    officeId: row.officeId || '',
  };
}

function resultHasNpi(data, npi) {
  const rows = data?.results || [];
  return rows.some((row) => npiMatches(row.nationalProviderIdentifiers, npi));
}

function firstMatch(data, npi) {
  const rows = data?.results || [];
  const hit = rows.find((row) => npiMatches(row.nationalProviderIdentifiers, npi));
  return hit ? formatMatch(hit) : null;
}

async function mintSession(fetchImpl = fetch) {
  const jar = newCookieJar();
  const cfgRes = await fetchJar(jar, CONFIG_URL, {}, FETCH_TIMEOUT_MS, fetchImpl);
  const cfg = await cfgRes.json().catch(() => null);
  const apimKey = cfg?.APIM_SUBSCRIPTION || FALLBACK_APIM_SUBSCRIPTION;
  if (!cfgRes.ok && !apimKey) {
    throw new Error(`humana findcare config HTTP ${cfgRes.status}`);
  }
  const tokenRes = await fetchJar(jar, GUEST_TOKEN_URL, {
    headers: { 'Ocp-Apim-Subscription-Key': apimKey },
  }, FETCH_TIMEOUT_MS, fetchImpl);
  if (!tokenRes.ok) {
    throw new Error(`humana findcare guest token HTTP ${tokenRes.status}`);
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
    const msg = data?.title || data?.message || `humana findcare HTTP ${res.status}`;
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

/**
 * Look up one NPI in Humana's public Medicare Find Care guest directory.
 * Default plan year is 2027 (AEP future networks). Pass planIds like
 * ['H1036-054'] to restrict to the THEI CMS IDs that share that network.
 */
async function queryHumanaFindcare(npi, {
  zip = '33176',
  planIds = [],
  year = PLAN_YEAR,
} = {}, fetchImpl = fetch) {
  if (!npi) return emptyResult({ error: 'missing_npi', year });
  const geo = geoForZip(zip);

  try {
    const session = await getSession(fetchImpl);
    const future = await listFutureNetworks(session, geo.zip, fetchImpl);
    const networks = pickTheiNetworks(future, { county: geo.county, planIds });
    if (!networks.length) {
      return {
        ...emptyResult({ error: null, year, county: geo.county }),
        error: planIds.length ? null : 'request_failed',
        note: planIds.length
          ? 'No matching THEI Humana plans in the guest directory for that county/year.'
          : 'Humana Find Care returned no THEI 2027 Medicare networks — failed check, not out of network.',
      };
    }

    const checks = await mapPool(networks, SEARCH_CONCURRENCY, (network) => (
      searchNetwork(session, { npi, geo, network }, fetchImpl)
    ));

    const inChecks = checks.filter((c) => c.status === 'in_network');
    const outChecks = checks.filter((c) => c.status === 'out_of_network');
    const failed = checks.filter((c) => c.status === 'failed');
    const allFailed = failed.length === checks.length;

    const matches = [];
    const seen = new Set();
    for (const check of inChecks) {
      if (!check.match) continue;
      const key = check.match.npi || check.match.providerId;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(check.match);
    }

    const inPlans = inChecks.flatMap((c) => c.plans.map(formatPlanLabel));
    const outPlans = outChecks.flatMap((c) => c.plans.map(formatPlanLabel));

    return {
      inNetwork: inChecks.length > 0,
      plans: inPlans,
      outOfNetworkPlans: outPlans,
      checks,
      matches,
      error: allFailed ? 'request_failed' : null,
      carrierLabel: CARRIER_LABEL,
      year: String(year),
      county: geo.county,
      sourceUrl: PUBLIC_FIND_CARE,
      publicUrl: PUBLIC_FIND_CARE,
      failedPlans: failed.flatMap((c) => c.plans.map(formatPlanLabel)),
    };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[humanaFindcare] ${label}`);
    sessionCache = null;
    networksCache.clear();
    return emptyResult({ error: 'request_failed', year, county: geo.county });
  }
}

function resetSessionCache() {
  sessionCache = null;
  sessionPromise = null;
  networksCache.clear();
}

function isHumanaLabel(label) {
  return /humana/i.test(String(label || '')) && !/careplus/i.test(String(label || ''));
}

/** Agent-facing lines. Failed check is never phrased as out of network. */
function formatHumanaAgentNote(result) {
  if (!result) return '';
  const lines = [`Humana Find Care guest (${result.year || PLAN_YEAR}, no member login):`];
  if (result.error && !result.checks?.length) {
    lines.push('Failed check — could not finish the public Humana directory. That is not out of network.');
    lines.push(`Next step: ${result.publicUrl || PUBLIC_FIND_CARE} (Search as a guest → Medicare → 2027 network).`);
    return lines.join('\n');
  }
  if (result.plans?.length) {
    lines.push(`In network: ${result.plans.join('; ')}`);
  }
  if (result.outOfNetworkPlans?.length) {
    lines.push(`Out of network: ${result.outOfNetworkPlans.join('; ')}`);
  }
  if (result.failedPlans?.length) {
    lines.push(`Failed check (not OON): ${result.failedPlans.join('; ')}`);
  }
  if (!result.plans?.length && !result.outOfNetworkPlans?.length && !result.failedPlans?.length) {
    lines.push('No THEI Humana plans were checked. Failed check — not out of network.');
  }
  lines.push('Guest Find Care is by network (not PBP): Gold Plus HMO/C-SNP/Giveback share HMO27; Dual Select share HIDE HMO27.');
  lines.push(`Source: ${result.sourceUrl || PUBLIC_FIND_CARE}`);
  return lines.join('\n');
}

module.exports = {
  CARRIER_LABEL,
  PLAN_YEAR,
  FINDCARE_BASE,
  PUBLIC_FIND_CARE,
  SEARCH_NPI_URL,
  THEI_HUMANA_NETWORKS,
  COUNTY_MIAMI_DADE,
  COUNTY_BROWARD,
  parseCmsId,
  cmsIdKey,
  cmsIdsMatch,
  npiMatches,
  formatPlanLabel,
  countyForZip,
  geoForZip,
  plansForNetwork,
  pickTheiNetworks,
  isHumanaLabel,
  resultHasNpi,
  formatMatch,
  queryHumanaFindcare,
  resetSessionCache,
  formatHumanaAgentNote,
};
