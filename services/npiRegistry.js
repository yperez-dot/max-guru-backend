/**
 * CMS NPI Registry helpers for provider lookup.
 *
 * Traps (2026-09-02, Lazaro Miguel Garcia NPI 1598792707):
 *   - A 10-digit NPI in the agent message must be looked up by number. Name
 *     search is how Max used to miss this PCP and only return other Garcias.
 *   - ZIP on the CMS query is a hard filter. 33166 hits the Miami Springs NP
 *     and never the Family Medicine MD 4.6 miles away in 33125. Search
 *     statewide, then rank by ZIP / middle name / MD|DO credential.
 *   - Trailing "MD" and "Dr. … at Salus Health" must not become the last name.
 */

const NPI_REGISTRY_BASE = 'https://npiregistry.cms.hhs.gov/api/';
const FETCH_TIMEOUT_MS = 12_000;
const CMS_PAGE_LIMIT = 20;
const DEFAULT_RETURN_LIMIT = 5;

const CREDENTIAL_RE = /^(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD|ARNP|FNP|DNP)$/i;

async function fetchJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractNpi(text) {
  const m = String(text || '').match(/\b(\d{10})\b/);
  return m ? m[1] : null;
}

function parseName(fullName) {
  if (!fullName || typeof fullName !== 'string') return {};
  let cleaned = fullName.trim();
  cleaned = cleaned.replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '');
  cleaned = cleaned.replace(/\s+at\s+.+$/i, '');
  cleaned = cleaned.replace(/,?\s+(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD|ARNP)\.?$/i, '').trim();

  if (cleaned.includes(',')) {
    const commaIdx = cleaned.indexOf(',');
    const last = cleaned.slice(0, commaIdx).trim();
    const rest = cleaned.slice(commaIdx + 1).trim().split(/\s+/).filter(Boolean);
    return {
      firstName: rest[0] || '',
      middleName: rest.slice(1).join(' '),
      lastName: last,
    };
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);
  while (parts.length && CREDENTIAL_RE.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return {};
  if (parts.length === 1) return { lastName: parts[0] };
  return {
    firstName: parts[0],
    middleName: parts.slice(1, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

function locationZip(result) {
  const addrs = result?.addresses || [];
  const loc = addrs.find((a) => a.address_purpose === 'LOCATION') || addrs[0] || {};
  return String(loc.postal_code || '').slice(0, 5);
}

function rankScore(result, { zip, firstName, middleName } = {}) {
  let s = 0;
  const z = locationZip(result);
  const qz = String(zip || '').slice(0, 5);
  if (qz && z === qz) s += 100;
  else if (qz && z.slice(0, 3) === qz.slice(0, 3)) s += 25;
  const b = result?.basic || {};
  if (firstName && String(b.first_name || '').toUpperCase() === String(firstName).toUpperCase()) s += 20;
  const mid = String(middleName || '').replace(/\./g, '').trim();
  if (mid && String(b.middle_name || '').toUpperCase().startsWith(mid.toUpperCase())) s += 40;
  if (/\b(MD|DO)\b/i.test(b.credential || '')) s += 15;
  return s;
}

function rankResults(results, query) {
  return [...results].sort((a, b) => rankScore(b, query) - rankScore(a, query));
}

async function lookupByNumber(npi) {
  if (!npi) return [];
  const url = `${NPI_REGISTRY_BASE}?version=2.1&number=${encodeURIComponent(npi)}`;
  const data = await fetchJSON(url);
  return data?.results || [];
}

async function lookupByName({ firstName, lastName, middleName, state = 'FL', zip, limit = DEFAULT_RETURN_LIMIT } = {}) {
  if (!lastName) return [];
  const p = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    state,
    last_name: lastName,
    limit: String(CMS_PAGE_LIMIT),
  });
  if (firstName) p.set('first_name', firstName);
  const data = await fetchJSON(`${NPI_REGISTRY_BASE}?${p}`);
  let results = data?.results || [];
  if (!results.length && firstName) {
    const p2 = new URLSearchParams({
      version: '2.1',
      enumeration_type: 'NPI-1',
      state,
      last_name: lastName,
      limit: String(CMS_PAGE_LIMIT),
    });
    const data2 = await fetchJSON(`${NPI_REGISTRY_BASE}?${p2}`);
    results = data2?.results || [];
  }
  return rankResults(results, { zip, firstName, middleName }).slice(0, limit);
}

/**
 * Resolve CMS NPI-1 records from a pasted NPI and/or a doctor name.
 * ZIP ranks matches; it does not filter them out.
 */
async function resolveNpiRecords({ doctorName = '', zip, state = 'FL', npi, limit = DEFAULT_RETURN_LIMIT } = {}) {
  const number = extractNpi(npi) || extractNpi(doctorName);
  if (number) {
    const byNumber = await lookupByNumber(number);
    if (byNumber.length) return byNumber;
  }
  const parsed = parseName(doctorName);
  let results = await lookupByName({ ...parsed, zip, state, limit });
  if (results.length) return results;

  const tokens = [parsed.firstName, parsed.middleName, parsed.lastName].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    const attempts = [
      { firstName: tokens[0], lastName: tokens.slice(1).join(' ') },
      { firstName: tokens[0], lastName: tokens.slice(-2).join(' ') },
    ];
    for (const attempt of attempts) {
      results = await lookupByName({ ...attempt, zip, state, limit });
      if (results.length) return results;
    }
  }
  if (parsed.lastName && parsed.firstName) {
    results = await lookupByName({ lastName: parsed.lastName, zip, state, limit });
  }
  return results;
}

module.exports = {
  NPI_REGISTRY_BASE,
  extractNpi,
  parseName,
  locationZip,
  rankScore,
  rankResults,
  lookupByNumber,
  lookupByName,
  resolveNpiRecords,
};
