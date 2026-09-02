/**
 * Simply Healthcare (H5471) guest Find Care search.
 *
 * No member login. Guest JWT from GET /precare/api/utility/data-modifiedon
 * (needs meta-brandcd / meta-consumerapp / meta-locale). Medicare Individual
 * plans from public-plan. Provider hits from POST search-box (npiIds on the
 * suggestion). Shop GraphQL getProviders is UNKNOWN_ERROR from this host;
 * search-box can hang behind Akamai — keep a short timeout and fail honest.
 *
 * Probed 2026-09-02. NPI as queryText does not match; search by last name
 * then filter npiIds.
 */

const FINDCARE_BASE = 'https://findcare.simplyhealthcareplans.com';
const SHOP_COVERAGE_URL = 'https://shop.simplyhealthcareplans.com/medicare/apprat/quote/coverage/api/v1/plancoverage';
const GUEST_URL = 'https://findcare.simplyhealthcareplans.com/?brand=SHC';
const SHOP_URL = 'https://shop.simplyhealthcareplans.com/medicare/standalonetools/find-doctor?brand=SIMPLY';
const FETCH_TIMEOUT_MS = 8_000;
const CARRIER_LABEL = 'Simply Healthcare';
const BRAND = 'SHC';
const PLAN_CATEGORY = 'MCRIN';
const TYPE_CODES = ['P'];
const SEARCH_TYPES = ['NM'];

const GUEST_HEADERS = {
  Accept: 'application/json',
  Origin: FINDCARE_BASE,
  Referer: `${FINDCARE_BASE}/?brand=${BRAND}`,
  'User-Agent': 'Mozilla/5.0',
  'meta-brandcd': BRAND,
  'meta-consumerapp': 'FINDCARE',
  'meta-locale': 'en_US',
};

const COVERAGE_QUERY = `query planCoverage($request: RequestInput!, $context: ContextInput!) {
  planCoverage(request: $request, context: $context) {
    response {
      zipCode
      location { longitudeLong latitudeLong }
      counties { countyName fipsCountyCode state { stateCode } }
    }
  }
}`;

let tokenCache = null;
let planCache = { expiresAt: 0, plans: [] };

async function fetchTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function npiList(row) {
  const raw = row?.npiIds ?? row?.npiId ?? row?.npi ?? [];
  const values = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
  return values.map((v) => String(v || '').trim()).filter(Boolean);
}

/** Search-box is last-name only. "GARCIA RIVERA" → "RIVERA". */
function searchLastName(name) {
  const creds = /^(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|MA|MS|MSN|MED|PharmD|PhD)$/i;
  const parts = String(name || '').trim().split(/[\s,]+/).filter(Boolean);
  while (parts.length && creds.test(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] || '';
}

function npiMatches(row, npi) {
  return npiList(row).includes(String(npi));
}

function authHeaders(token) {
  return {
    ...GUEST_HEADERS,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function guestToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  const res = await fetchTimeout(`${FINDCARE_BASE}/precare/api/utility/data-modifiedon`, {
    headers: GUEST_HEADERS,
  });
  if (!res.ok) throw new Error(`simply token HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token) throw new Error('simply token missing');
  tokenCache = { token: data.token, expiresAt: Date.now() + 20 * 60 * 1000 };
  return tokenCache.token;
}

function formatPlanLabel(plan) {
  return plan?.name || plan?.planName || CARRIER_LABEL;
}

async function listMedicarePlans(token) {
  if (planCache.expiresAt > Date.now() && planCache.plans.length) return planCache.plans;
  const res = await fetchTimeout(
    `${FINDCARE_BASE}/precare/api/utility/v1/public-plan/${BRAND}/states/FL/categories/${PLAN_CATEGORY}/plans?care=medical`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) throw new Error(`simply plans HTTP ${res.status}`);
  const data = await res.json();
  const plans = data.data || data.plans || [];
  planCache = { plans, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return plans;
}

async function geocodeZip(zip) {
  const res = await fetchTimeout(SHOP_COVERAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://shop.simplyhealthcareplans.com',
      Referer: SHOP_URL,
    },
    body: JSON.stringify({
      query: COVERAGE_QUERY,
      variables: {
        request: { zipCode: String(zip) },
        context: { marketSegment: ['MEDICARE'] },
      },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const loc = data?.data?.planCoverage?.response?.location;
  if (!loc) return null;
  return {
    latitude: String(loc.latitudeLong),
    longitude: String(loc.longitudeLong),
  };
}

function buildSearchBoxBody({ queryText, plan, latitude, longitude, zip }) {
  return {
    queryText: String(queryText || ''),
    locale: 'en_US',
    typeCodes: TYPE_CODES,
    searchTypes: SEARCH_TYPES,
    planstateCode: 'FL',
    alphaPrefix: plan.prefix || plan.alphaPrefix || '',
    plans: [{ identifier: plan.id || plan.identifier }],
    networks: plan.networkList || plan.networks || [],
    planCategory: PLAN_CATEGORY,
    brandCode: BRAND,
    includeVirtualProviders: false,
    memberCriteria: {},
    latitude: String(latitude),
    longitude: String(longitude),
    distance: 20,
    state: 'FL',
    postalCode: String(zip),
    isPrefixProcSearchEnabled: false,
  };
}

function collectProviders(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const seen = new Set();
  for (const value of Object.values(data)) {
    if (!Array.isArray(value) || !value.length) continue;
    if (!value[0] || typeof value[0] !== 'object') continue;
    if (!(value[0].providerName || value[0].npiIds || value[0].npiId)) continue;
    for (const row of value) {
      const key = `${row.providerName}|${npiList(row).join(',')}|${row.addressId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

function formatMatch(row) {
  const addr = row.address || {};
  const parts = [
    row.addressLine1 || addr.addressLine1 || addr.street1,
    row.city || addr.city,
    row.state || addr.state,
    row.postalCode || addr.postalCode,
  ].filter(Boolean);
  return {
    npi: npiList(row)[0] || '',
    name: row.providerName || '',
    address: parts.join(', '),
    phone: row.phone || addr.phone || '',
  };
}

async function searchPlan(token, { plan, lastName, latitude, longitude, zip, npi }) {
  try {
    const res = await fetchTimeout(`${FINDCARE_BASE}/precare/api/lookup/public/v1/search-box`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(buildSearchBoxBody({
        queryText: lastName,
        plan,
        latitude,
        longitude,
        zip,
      })),
    });
    if (!res.ok) return { ok: false, hits: [] };
    const data = await res.json();
    const hits = collectProviders(data).filter((row) => npiMatches(row, npi));
    return { ok: true, hits, plan };
  } catch {
    return { ok: false, hits: [] };
  }
}

function pickPlansToSearch(plans) {
  const preferred = [];
  const rest = [];
  for (const plan of plans) {
    if (/Complete(?! Platinum)|Extra(?! Platinum)|Select(?! Platinum)/i.test(plan.name || '')) {
      preferred.push(plan);
    } else {
      rest.push(plan);
    }
  }
  return [...preferred, ...rest].slice(0, 4);
}

/**
 * Look up one NPI in Simply's public Find Care (Medicare Individual).
 */
async function querySimplyFindcare(npi, { zip = '33126', lastName = '' } = {}) {
  if (!npi) {
    return {
      inNetwork: false,
      plans: [],
      matches: [],
      error: 'missing_npi',
      carrierLabel: CARRIER_LABEL,
    };
  }
  const queryLast = searchLastName(lastName);
  if (!queryLast) {
    return {
      inNetwork: false,
      plans: [],
      matches: [],
      error: null,
      carrierLabel: CARRIER_LABEL,
      note: 'Simply Find Care matches by name, not NPI. Last name required.',
    };
  }

  try {
    const token = await guestToken();
    const [plans, geo] = await Promise.all([
      listMedicarePlans(token),
      geocodeZip(zip),
    ]);
    if (!geo?.latitude || !plans.length) {
      return {
        inNetwork: false,
        plans: [],
        matches: [],
        error: 'request_failed',
        carrierLabel: CARRIER_LABEL,
      };
    }

    const toSearch = pickPlansToSearch(plans);
    const results = await Promise.all(
      toSearch.map((plan) => searchPlan(token, {
        plan,
        lastName: queryLast,
        latitude: geo.latitude,
        longitude: geo.longitude,
        zip,
        npi,
      }))
    );

    const anyOk = results.some((r) => r.ok);
    const planLabels = [];
    const matches = [];
    const seenMatch = new Set();
    for (const result of results) {
      if (!result.hits?.length) continue;
      const label = formatPlanLabel(result.plan);
      if (!planLabels.includes(label)) planLabels.push(label);
      for (const hit of result.hits) {
        const formatted = formatMatch(hit);
        const key = `${formatted.npi}|${formatted.address}`;
        if (seenMatch.has(key)) continue;
        seenMatch.add(key);
        matches.push(formatted);
      }
    }

    return {
      inNetwork: planLabels.length > 0,
      plans: planLabels,
      matches,
      error: anyOk ? null : 'request_failed',
      carrierLabel: CARRIER_LABEL,
      guestUrl: GUEST_URL,
    };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[simplyFindcare] ${label}`);
    tokenCache = null;
    return {
      inNetwork: false,
      plans: [],
      matches: [],
      error: 'request_failed',
      carrierLabel: CARRIER_LABEL,
      guestUrl: GUEST_URL,
    };
  }
}

module.exports = {
  CARRIER_LABEL,
  FINDCARE_BASE,
  GUEST_URL,
  SHOP_URL,
  GUEST_HEADERS,
  npiList,
  npiMatches,
  searchLastName,
  formatPlanLabel,
  buildSearchBoxBody,
  collectProviders,
  pickPlansToSearch,
  querySimplyFindcare,
};
