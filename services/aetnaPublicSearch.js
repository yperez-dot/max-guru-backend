/**
 * Aetna Medicare guest provider search (no member login).
 *
 * Public SPA at health.aetna.com mints a cookie + Bearer via client_credentials
 * (client id/secret are in the page HTML). Then:
 *   1. Geocode ZIP → latlng + county FIPS
 *   2. POST /v1/ahpublic_taxonomy by NPI
 *   3. POST /v4/ahpublic_search with medicare_plans + last-name filter
 *   4. GET /v3/ahpublic_providers/{id}/locations/{loc}/lobs/medicare/healthplans
 *
 * Probed 2026-09-02. Taxonomy hit ≠ MA in-network (Garcia NPI 1497949424 is in
 * the directory, not in Miami-Dade MA search). Tharkur 1306409339 is directory
 * only. Ricardo Garcia Rivera 1366434334 is in-network for H1609 plans.
 */

const TOKEN_URL = 'https://api01.aetna.com/identitymanagement/prod/v3/auth/oauth2/spa/public/scookie/app/token';
const API03 = 'https://api03.aetna.com/healthcare/prod';
const GEOCODE_URL = 'https://api01.aetna.com/hcb/prod/v4/geocode';
const SPA_URL = 'https://health.aetna.com/ahpublic/medicare-direct';
const FETCH_TIMEOUT_MS = 12_000;
const PLAN_YEAR = '2026';
const PAGE_SIZE = 50;
const MAX_PAGES = 6;
const CARRIER_LABEL = 'Aetna Medicare';

/** Public SPA credentials baked into health.aetna.com (not a private secret). */
const FALLBACK_CLIENT_ID = '8b2a1b1b-6d83-4855-8e5f-10cb198e6769';
const FALLBACK_CLIENT_SECRET = 'yD3fE8gI0oC4gQ2eB1bM0sH2hO6vA3uP0aE2vE6gT6xY6mU2qG';

let sessionCache = null;

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

async function fetchJar(jar, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { ...(options.headers || {}) };
  const cookies = cookieHeader(jar);
  if (cookies) headers.Cookie = cookies;
  try {
    const res = await fetch(url, { ...options, headers, signal: ctrl.signal });
    storeCookies(jar, res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function parseSpaCredentials(html) {
  const id = html.match(/"publicTokenClientId"\s*:\s*"([0-9a-f-]{36})"/i);
  const secret = html.match(/"\/ahweb\/public_client_token\/prod"\s*:\s*"([^"]+)"/);
  return {
    clientId: id?.[1] || FALLBACK_CLIENT_ID,
    clientSecret: secret?.[1] || FALLBACK_CLIENT_SECRET,
  };
}

async function loadSpaCredentials(jar) {
  try {
    const res = await fetchJar(jar, SPA_URL, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!res.ok) return parseSpaCredentials('');
    return parseSpaCredentials(await res.text());
  } catch {
    return parseSpaCredentials('');
  }
}

async function mintSession() {
  const jar = newCookieJar();
  const { clientId, clientSecret } = await loadSpaCredentials(jar);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetchJar(jar, TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Origin: 'https://health.aetna.com',
      Referer: 'https://health.aetna.com/',
    },
    body: 'grant_type=client_credentials&scope=Public',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new Error(`aetna token HTTP ${res.status}`);
  }
  const ttlMs = Math.max(60, Number(data.expires_in) || 3600) * 1000;
  return {
    accessToken: data.access_token,
    jar,
    expiresAt: Date.now() + ttlMs - 60_000,
  };
}

async function getSession() {
  if (sessionCache && sessionCache.expiresAt > Date.now()) return sessionCache;
  sessionCache = await mintSession();
  return sessionCache;
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://health.aetna.com',
    Referer: 'https://health.aetna.com/ahpublic/medicare-direct',
  };
}

function formatLatLng(latitude, longitude) {
  if (latitude == null || longitude == null) return null;
  return `${latitude},${longitude}`;
}

function lastNameFromDisplay(name) {
  if (!name || typeof name !== 'string') return '';
  const cleaned = name.replace(/,?\s+(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|MA|MS|MSN|MED|PharmD|PhD)\.?$/i, '').trim();
  const noComma = cleaned.includes(',') ? cleaned.slice(0, cleaned.indexOf(',')).trim() : cleaned;
  const parts = noComma.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function npiMatches(value, npi) {
  return String(value || '') === String(npi || '');
}

function isInNetworkStatus(status) {
  const s = String(status || '').trim();
  return /in\s*network/i.test(s) || /^inn$/i.test(s);
}

function formatPlanLabel(plan) {
  const name = plan?.plan_name || plan?.planName || '';
  const id = String(plan?.plan_id || plan?.planId || '');
  const cms = id.match(/^(H\d{4}-\d{3})/i);
  if (name) return name;
  if (cms) return `Aetna ${cms[1]}`;
  return id ? `${CARRIER_LABEL} – ${id}` : CARRIER_LABEL;
}

function buildTaxonomyBody({ q, latlng, countyCode, state = 'FL' }) {
  return {
    q: String(q || ''),
    latlng,
    supported_types: ['practitioner'],
    county_code: countyCode || null,
    plan_type: 'IND',
    plan_year: PLAN_YEAR,
    use_template: true,
    public_site_id: 'medicare',
    lob: 'medicare',
    state,
  };
}

function buildMedicareSearchBody({ q, latlng, countyCode, lastName, offset = 0 }) {
  return {
    latlng,
    q: q || lastName,
    provider_filters: { name: lastName },
    medicare_plans: {
      public_site_id: 'medicare',
      county_code: String(countyCode),
      plan_type: 'IND',
      plan_year: PLAN_YEAR,
    },
    limit: PAGE_SIZE,
    offset,
  };
}

async function geocodeZip(session, zip) {
  const url = `${GEOCODE_URL}?address=${encodeURIComponent(zip)}`;
  const res = await fetchJar(session.jar, url, { headers: authHeaders(session) });
  if (!res.ok) return null;
  const data = await res.json();
  const addr = (data.postalAddresses || [])[0];
  if (!addr) return null;
  return {
    latlng: formatLatLng(addr.latitude, addr.longitude),
    countyCode: addr.countyCode || null,
    state: addr.state || 'FL',
    zip: addr.postalCode || zip,
  };
}

async function taxonomyByNpi(session, { npi, latlng, countyCode, state }) {
  const res = await fetchJar(session.jar, `${API03}/v1/ahpublic_taxonomy`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify(buildTaxonomyBody({ q: npi, latlng, countyCode, state })),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.find_care || []).filter((row) => npiMatches(row.npi, npi));
}

async function searchMedicarePages(session, { lastName, latlng, countyCode, npi }) {
  const matches = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const res = await fetchJar(session.jar, `${API03}/v4/ahpublic_search`, {
      method: 'POST',
      headers: authHeaders(session),
      body: JSON.stringify(buildMedicareSearchBody({
        q: lastName,
        latlng,
        countyCode,
        lastName,
        offset,
      })),
    });
    if (!res.ok) break;
    const data = await res.json();
    const sites = data.sites || [];
    for (const site of sites) {
      if (npiMatches(site.npi, npi)) matches.push(site);
    }
    const total = Number(data.metadata?.total_results || 0);
    if (!sites.length || offset + sites.length >= total) break;
    if (matches.length) break;
  }
  return matches;
}

async function fetchMedicarePlans(session, site, countyCode) {
  const id = site.id;
  const loc = site.service_location_number;
  if (!id || !loc) return [];
  const url = `${API03}/v3/ahpublic_providers/${encodeURIComponent(id)}/locations/${encodeURIComponent(loc)}/lobs/medicare/healthplans?plan_year=${PLAN_YEAR}&county_code=${encodeURIComponent(countyCode)}&plan_type=IND`;
  const res = await fetchJar(session.jar, url, { headers: authHeaders(session) });
  if (!res.ok) return [];
  const data = await res.json();
  const rows = data.inside_area_plans || [];
  const seen = new Set();
  const plans = [];
  for (const row of rows) {
    if (!isInNetworkStatus(row.network_status)) continue;
    const hp = row.health_plan || {};
    const key = hp.plan_id || hp.plan_name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    plans.push(formatPlanLabel(hp));
  }
  return plans;
}

function formatMatch(site) {
  const addr = site.address || {};
  const parts = [addr.street1, addr.city, addr.state, addr.zip_code].filter(Boolean);
  return {
    npi: String(site.npi || ''),
    name: site.formatted_name || [site.last_name, site.first_name].filter(Boolean).join(', '),
    specialty: (site.specialties || []).find((s) => s.primary)?.name || '',
    address: parts.join(', '),
    phone: site.formatted_primary_phone || '',
    networkStatus: (site.specialties || []).find((s) => s.primary)?.medical_network_status || '',
  };
}

/**
 * Look up one NPI in Aetna's public Medicare directory for a Florida ZIP.
 */
async function queryAetnaPublic(npi, { zip = '33176', state = 'FL', lastName = '' } = {}) {
  if (!npi) {
    return {
      inNetwork: false,
      plans: [],
      matches: [],
      directoryHit: false,
      error: 'missing_npi',
      carrierLabel: CARRIER_LABEL,
    };
  }

  try {
    const session = await getSession();
    const geo = await geocodeZip(session, zip);
    if (!geo?.latlng || !geo.countyCode) {
      return {
        inNetwork: false,
        plans: [],
        matches: [],
        directoryHit: false,
        error: 'request_failed',
        carrierLabel: CARRIER_LABEL,
      };
    }

    const taxHits = await taxonomyByNpi(session, {
      npi,
      latlng: geo.latlng,
      countyCode: geo.countyCode,
      state: geo.state || state,
    });
    const directoryHit = taxHits.length > 0;
    const searchLast = lastNameFromDisplay(taxHits[0]?.name) || lastName;
    if (!directoryHit || !searchLast) {
      return {
        inNetwork: false,
        plans: [],
        matches: [],
        directoryHit,
        error: null,
        carrierLabel: CARRIER_LABEL,
      };
    }

    let sites = await searchMedicarePages(session, {
      lastName: searchLast,
      latlng: geo.latlng,
      countyCode: geo.countyCode,
      npi,
    });

    const taxZip = String(taxHits[0]?.address?.zipCode || '').slice(0, 5);
    if (!sites.length && taxZip && taxZip !== String(zip).slice(0, 5)) {
      const geo2 = await geocodeZip(session, taxZip);
      if (geo2?.latlng && geo2.countyCode) {
        sites = await searchMedicarePages(session, {
          lastName: searchLast,
          latlng: geo2.latlng,
          countyCode: geo2.countyCode,
          npi,
        });
      }
    }

    if (!sites.length) {
      return {
        inNetwork: false,
        plans: [],
        matches: [],
        directoryHit: true,
        error: null,
        carrierLabel: CARRIER_LABEL,
      };
    }

    const planLists = await Promise.all(
      sites.slice(0, 3).map((site) => fetchMedicarePlans(session, site, geo.countyCode))
    );
    const plans = [];
    const seen = new Set();
    for (const list of planLists) {
      for (const label of list) {
        if (seen.has(label)) continue;
        seen.add(label);
        plans.push(label);
      }
    }

    return {
      inNetwork: plans.length > 0 || sites.some((s) => isInNetworkStatus(s.specialties?.[0]?.medical_network_status)),
      plans,
      matches: sites.slice(0, 3).map(formatMatch),
      directoryHit: true,
      error: null,
      carrierLabel: CARRIER_LABEL,
    };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[aetnaPublicSearch] ${label}`);
    sessionCache = null;
    return {
      inNetwork: false,
      plans: [],
      matches: [],
      directoryHit: false,
      error: 'request_failed',
      carrierLabel: CARRIER_LABEL,
    };
  }
}

module.exports = {
  CARRIER_LABEL,
  PLAN_YEAR,
  TOKEN_URL,
  API03,
  formatLatLng,
  lastNameFromDisplay,
  npiMatches,
  isInNetworkStatus,
  formatPlanLabel,
  buildTaxonomyBody,
  buildMedicareSearchBody,
  parseSpaCredentials,
  queryAetnaPublic,
};
