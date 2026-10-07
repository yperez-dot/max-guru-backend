/**
 * UnitedHealthcare guest Find a Doctor (no member login, no Jarvis).
 *
 * Public SPA: https://findcare.guest.uhc.com/guest-plan-selection/browse
 * (WeRally county-plan-selection/uhc.mnr redirects here.)
 *
 * Flow, probed 2026-10-02:
 *   1. GET /api/create-guest-session → PSX_GUEST_SESSION + PSX_GUEST_ID cookies
 *   2. GET /api/authorize-guest-session → { authorized: true }
 *   3. GraphQL POST /api/graphql
 *        GetLocation / GetPostalPoint
 *        GetPlanDefinitions(lob=MR, coverageType=M, planYear)
 *        ProviderSearch(npiNumber, reciprocityId, rulesPackageKey=planIdentifier)
 *
 * A successful empty ProviderSearch is out-of-network for THAT plan.
 * Session / GraphQL failure is a failed check — never invent OON.
 *
 * THEI AEP 2027 Duals (Miami-Dade / Broward) live in this directory:
 *   H1045-012 FL-QV4, H1045-061 FL-QV5, H1045-063 FL-Y6.
 */

const GUEST_BASE = 'https://findcare.guest.uhc.com';
const GRAPHQL_URL = `${GUEST_BASE}/api/graphql`;
const CREATE_SESSION_URL = `${GUEST_BASE}/api/create-guest-session?useGuestPersistence=true`;
const AUTHORIZE_SESSION_URL = `${GUEST_BASE}/api/authorize-guest-session`;
const GUEST_SEARCH_URL = `${GUEST_BASE}/guest-plan-selection/browse`;
const PUBLIC_FIND_A_DOCTOR = 'https://www.uhc.com/find-a-doctor';
const PLAN_YEAR = '2027';
const CARRIER_LABEL = 'UnitedHealthcare';
const LOB = 'MR';
const LOB_SEARCH = 'M&R';
const COVERAGE_TYPE = 'M';
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_CONCURRENCY = 6;
const SEARCH_RADIUS = 50;

/** THEI South Florida UHC / AARP / MedicareMax contracts on the 2027 grid. */
const THEI_UHC_CONTRACTS = ['H1045', 'H5420', 'H1889', 'H2509', 'R0759'];

const GET_LOCATION = `query GetLocation($address: String) {
  location(address: $address) {
    features { center stateCode zipCode locationType }
  }
}`;

const GET_POSTAL_POINT = `query GetPostalPoint($postal: String) {
  getPostalPoint(postal: $postal) {
    county county_proper county_id state
  }
}`;

const GET_PLAN_DEFINITIONS = `query GetPlanDefinitions(
  $lob: String!
  $coverageType: String!
  $planYear: String!
  $stateCode: String
  $countyFipsCode: String
  $isDualYear: Boolean
  $isEI: Boolean!
  $portalSource: String
  $source: String
) {
  getPlanDefinitions(
    lob: $lob
    coverageType: $coverageType
    planYear: $planYear
    stateCode: $stateCode
    countyFipsCode: $countyFipsCode
    isDualYear: $isDualYear
    portalSource: $portalSource
    source: $source
  ) {
    planDetails {
      planName
      planIdentifier
      medicarePlanType
      searchDirectory
      guestPlanIdentifier @include(if: $isEI)
      years { planYear reciprocityId clusterKey }
    }
  }
}`;

const PROVIDER_SEARCH = `query ProviderSearch(
  $coverages: [String]!
  $coverageType: String!
  $reciprocityId: String!
  $providerType: String!
  $npiNumber: String
  $latitude: String
  $longitude: String
  $lob: String
  $population: String
  $planYear: String
  $rulesPackageKey: String
  $isGuestUser: Boolean
  $stateCode: String
  $locale: String
  $pageNumber: Int
  $pageSize: Int
  $searchRadius: Int
) {
  providerSearch(
    coverages: $coverages
    coverageType: $coverageType
    reciprocityId: $reciprocityId
    providerType: $providerType
    npiNumber: $npiNumber
    latitude: $latitude
    longitude: $longitude
    lob: $lob
    population: $population
    planYear: $planYear
    rulesPackageKey: $rulesPackageKey
    isGuestUser: $isGuestUser
    stateCode: $stateCode
    locale: $locale
    pageNumber: $pageNumber
    pageSize: $pageSize
    searchRadius: $searchRadius
  ) {
    providers {
      providerType
      providerId
      locationId
      firstName
      middleName
      lastName
      npi
      speciality
      primarySpecialities
      distance
      address { line city district state postalCode }
    }
  }
}`;

let sessionCache = null;
// Concurrent doctor lookups (8-doctor Padron asks) must share one session mint
// and one ZIP/plan-definition fetch instead of each NPI repeating them.
let sessionPromise = null;
const zipContextCache = new Map();
const ZIP_CONTEXT_TTL_MS = 20 * 60 * 1000;

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
    Accept: 'application/json',
    Origin: GUEST_BASE,
    Referer: GUEST_SEARCH_URL,
    'User-Agent': 'Mozilla/5.0',
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

async function mintSession(fetchImpl = fetch) {
  const jar = newCookieJar();
  const created = await fetchJar(jar, CREATE_SESSION_URL, {}, FETCH_TIMEOUT_MS, fetchImpl);
  const createdBody = await created.json().catch(() => null);
  if (!created.ok || !createdBody?.success) {
    throw new Error(`uhc guest session HTTP ${created.status}`);
  }
  const auth = await fetchJar(jar, AUTHORIZE_SESSION_URL, {}, FETCH_TIMEOUT_MS, fetchImpl);
  const authBody = await auth.json().catch(() => null);
  if (!auth.ok || !authBody?.authorized) {
    throw new Error(`uhc guest authorize HTTP ${auth.status}`);
  }
  return { jar, expiresAt: Date.now() + 25 * 60 * 1000 };
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

async function graphql(session, query, variables, operationName, fetchImpl = fetch) {
  const res = await fetchJar(session.jar, GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables, operationName }),
  }, FETCH_TIMEOUT_MS, fetchImpl);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.errors) {
    const msg = data?.errors?.[0]?.message || `uhc graphql HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data.data;
}

function cmsId(planIdentifier) {
  const m = String(planIdentifier || '').match(/^(H\d{4}|R\d{4})-(\d{3})/i);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

function normalizeCmsId(value) {
  return cmsId(value) || (String(value || '').trim().toUpperCase() || null);
}

function npiMatches(value, npi) {
  return String(value || '') === String(npi || '');
}

function formatPlanLabel(plan) {
  const name = plan?.planName || 'UHC plan';
  const id = cmsId(plan?.planIdentifier);
  return id ? `${name} (${id})` : name;
}

function isGroupPlan(plan) {
  return String(plan?.medicarePlanType || '').toUpperCase() === 'GROUP';
}

function isTheiUhcPlan(plan) {
  if (isGroupPlan(plan)) return false;
  const id = cmsId(plan?.planIdentifier);
  if (!id) return false;
  return THEI_UHC_CONTRACTS.includes(id.split('-')[0]);
}

function reciprocityId(plan) {
  const year = (plan?.years || [])[0] || {};
  return String(year.reciprocityId || plan?.reciprocityId || '').trim();
}

function populationFor(plan) {
  // Guest UI maps Medicare medical (MR + M) to COSMOS. Plan-specific
  // filter is reciprocityId + rulesPackageKey (CMS plan identifier).
  const dir = String(plan?.searchDirectory || '').toUpperCase();
  if (dir && dir !== 'COSMOS' && dir !== 'DSNP') return dir;
  return 'COSMOS';
}

function formatAddress(addr) {
  if (!addr) return '';
  const line = Array.isArray(addr.line) ? addr.line.filter(Boolean).join(', ') : (addr.line || '');
  return [line, addr.city, addr.state, String(addr.postalCode || '').slice(0, 5)].filter(Boolean).join(', ');
}

function formatMatch(provider) {
  return {
    npi: String(provider.npi || ''),
    name: [provider.firstName, provider.middleName, provider.lastName].filter(Boolean).join(' '),
    specialty: provider.speciality || (provider.primarySpecialities || [])[0] || '',
    address: formatAddress(provider.address),
    providerId: provider.providerId || '',
  };
}

function pickPlans(planDetails, planIds) {
  const thei = (planDetails || []).filter(isTheiUhcPlan);
  if (!planIds || !planIds.length) return thei;
  const wanted = new Set(planIds.map(normalizeCmsId).filter(Boolean));
  return thei.filter((plan) => wanted.has(cmsId(plan.planIdentifier)));
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
    sourceUrl: GUEST_SEARCH_URL,
    publicUrl: PUBLIC_FIND_A_DOCTOR,
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

async function searchPlan(session, { npi, lat, lng, state, year, plan }, fetchImpl) {
  const rec = reciprocityId(plan);
  const key = plan.planIdentifier;
  if (!rec || !key) {
    return {
      cmsId: cmsId(key),
      planName: plan.planName,
      planIdentifier: key,
      status: 'failed',
      error: 'missing_plan_keys',
      match: null,
    };
  }
  try {
    const data = await graphql(session, PROVIDER_SEARCH, {
      coverages: [COVERAGE_TYPE],
      coverageType: COVERAGE_TYPE,
      reciprocityId: rec,
      providerType: 'PRACTITIONER',
      npiNumber: String(npi),
      latitude: String(lat),
      longitude: String(lng),
      lob: LOB_SEARCH,
      population: populationFor(plan),
      planYear: String(year),
      rulesPackageKey: key,
      isGuestUser: true,
      stateCode: state,
      locale: 'en-US',
      pageNumber: 1,
      pageSize: 5,
      searchRadius: SEARCH_RADIUS,
    }, 'ProviderSearch', fetchImpl);
    const providers = data?.providerSearch?.providers || [];
    const hit = providers.find((p) => npiMatches(p.npi, npi));
    return {
      cmsId: cmsId(key),
      planName: plan.planName,
      planIdentifier: key,
      status: hit ? 'in_network' : (unreliableMiss(key) ? 'not_listed' : 'out_of_network'),
      error: null,
      match: hit ? formatMatch(hit) : null,
    };
  } catch (err) {
    return {
      cmsId: cmsId(key),
      planName: plan.planName,
      planIdentifier: key,
      status: 'failed',
      error: err.name === 'AbortError' ? 'Timeout' : err.message,
      match: null,
    };
  }
}

async function fetchZipContext(session, { zip, state, year }, fetchImpl) {
  const geo = await graphql(session, GET_LOCATION, { address: String(zip) }, 'GetLocation', fetchImpl);
  const feature = (geo?.location?.features || [])[0];
  const center = feature?.center || [];
  const lng = center[0];
  const lat = center[1];
  if (lat == null || lng == null) return null;

  const postal = await graphql(session, GET_POSTAL_POINT, { postal: String(zip) }, 'GetPostalPoint', fetchImpl);
  const point = postal?.getPostalPoint || {};
  const countyFips = point.county_id || null;
  const county = point.county_proper || point.county || null;
  const geoState = feature.stateCode || point.state || state;

  const defs = await graphql(session, GET_PLAN_DEFINITIONS, {
    lob: LOB,
    coverageType: COVERAGE_TYPE,
    planYear: String(year),
    stateCode: geoState,
    countyFipsCode: countyFips,
    isDualYear: false,
    isEI: false,
    portalSource: 'guest-plan-selection',
    source: 'guest',
  }, 'GetPlanDefinitions', fetchImpl);

  return {
    lat,
    lng,
    countyFips,
    county,
    geoState,
    planDetails: defs?.getPlanDefinitions?.planDetails || [],
  };
}

/** ZIP + year context is identical for every NPI in a multi-doctor ask — share it. */
function zipContext(session, { zip, state, year }, fetchImpl) {
  const key = `${zip}|${state}|${year}`;
  const hit = zipContextCache.get(key);
  if (hit && hit.session === session && hit.expiresAt > Date.now()) return hit.promise;
  const promise = fetchZipContext(session, { zip, state, year }, fetchImpl).then((ctx) => {
    if (!ctx) zipContextCache.delete(key);
    return ctx;
  }, (err) => {
    zipContextCache.delete(key);
    throw err;
  });
  zipContextCache.set(key, { session, promise, expiresAt: Date.now() + ZIP_CONTEXT_TTL_MS });
  return promise;
}

/**
 * Look up one NPI in UHC's public Medicare guest directory.
 * Default plan year is 2027 (AEP). Pass planIds like ['H1045-012'] to
 * restrict to specific CMS IDs; otherwise THEI FL UHC contracts are checked.
 */
async function queryUhcGuest(npi, {
  zip = '33176',
  state = 'FL',
  planIds = [],
  year = PLAN_YEAR,
} = {}, fetchImpl = fetch) {
  if (!npi) return emptyResult({ error: 'missing_npi', year });

  try {
    const session = await getSession(fetchImpl);
    const ctx = await zipContext(session, { zip, state, year }, fetchImpl);
    if (!ctx) {
      return emptyResult({ error: 'request_failed', year });
    }
    const { lat, lng, county, geoState, planDetails } = ctx;

    let plans = pickPlans(planDetails, planIds);
    // None of the asked IDs is a UHC plan (a Humana-only planId): check every THEI UHC plan
    // instead of none, so a UHC column in the same comparison gets a plan-level answer.
    if (!plans.length && planIds.length) plans = pickPlans(planDetails, []);
    if (!plans.length) {
      return {
        ...emptyResult({ error: null, year, county }),
        error: planIds.length ? null : 'request_failed',
        note: planIds.length
          ? 'No matching THEI UHC plans in the guest directory for that county/year.'
          : 'UHC guest plan list returned no THEI plans — failed check, not out of network.',
      };
    }

    const checks = await mapPool(plans, SEARCH_CONCURRENCY, (plan) => (
      searchPlan(session, {
        npi,
        lat,
        lng,
        state: geoState,
        year,
        plan,
      }, fetchImpl)
    ));

    const inChecks = checks.filter((c) => c.status === 'in_network');
    const outChecks = checks.filter((c) => c.status === 'out_of_network');
    const failed = checks.filter((c) => c.status === 'failed');
    const notListed = checks.filter((c) => c.status === 'not_listed');
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

    return {
      inNetwork: inChecks.length > 0,
      plans: inChecks.map((c) => formatPlanLabel(c)),
      outOfNetworkPlans: outChecks.map((c) => formatPlanLabel(c)),
      checks,
      matches,
      error: allFailed ? 'request_failed' : null,
      carrierLabel: CARRIER_LABEL,
      year: String(year),
      county,
      sourceUrl: GUEST_SEARCH_URL,
      publicUrl: PUBLIC_FIND_A_DOCTOR,
      failedPlans: failed.map((c) => formatPlanLabel(c)),
      notListedPlans: notListed.map((c) => formatPlanLabel(c)),
    };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[uhcGuestSearch] ${label}`);
    sessionCache = null;
    zipContextCache.clear();
    return emptyResult({ error: 'request_failed', year });
  }
}

function resetSessionCache() {
  sessionCache = null;
  sessionPromise = null;
  zipContextCache.clear();
}

/**
 * Contracts whose guest-directory miss is not a reliable Out. H1045 is Preferred Care Partners
 * (UHC-owned, Miami-Dade/Broward): the guest API maps it to COSMOS / reciprocity 115 for 2026 and
 * 2027, yet 4 of 5 doctors Maura Soley actively sees on H1045-001 come back unlisted (2026-10-07).
 * A miss there reads "not confirmed", never a hard Out.
 */
const UNRELIABLE_MISS_CONTRACTS = ['H1045'];
function unreliableMiss(planKey) {
  return UNRELIABLE_MISS_CONTRACTS.includes(String(planKey || '').slice(0, 5).toUpperCase());
}

/** Agent-facing lines. Failed check is never phrased as out of network. */
function formatUhcAgentNote(result) {
  if (!result) return '';
  const lines = [`UHC guest Find a Doctor (${result.year || PLAN_YEAR}, no member login):`];
  if (result.error && !result.checks?.length) {
    lines.push('Failed check — could not finish the public UHC directory. That is not out of network.');
    lines.push(`Next step: ${result.publicUrl || PUBLIC_FIND_A_DOCTOR} (Continue as guest → Medicare) or ${GUEST_SEARCH_URL}.`);
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
  if (result.notListedPlans?.length) {
    lines.push(`Not listed — NOT CONFIRMED, never Out (Preferred Care Partners plan; the guest directory misses doctors members see — verify on mypreferredcare.com or call the plan): ${result.notListedPlans.join('; ')}`);
  }
  if (!result.plans?.length && !result.outOfNetworkPlans?.length && !result.failedPlans?.length && !result.notListedPlans?.length) {
    lines.push('No THEI UHC plans were checked. Failed check — not out of network.');
  }
  lines.push(`Source: ${result.sourceUrl || GUEST_SEARCH_URL}`);
  return lines.join('\n');
}

module.exports = {
  CARRIER_LABEL,
  PLAN_YEAR,
  GUEST_BASE,
  GUEST_SEARCH_URL,
  PUBLIC_FIND_A_DOCTOR,
  THEI_UHC_CONTRACTS,
  cmsId,
  normalizeCmsId,
  npiMatches,
  formatPlanLabel,
  isTheiUhcPlan,
  reciprocityId,
  populationFor,
  pickPlans,
  formatMatch,
  formatAddress,
  queryUhcGuest,
  resetSessionCache,
  formatUhcAgentNote,
  unreliableMiss,
};
