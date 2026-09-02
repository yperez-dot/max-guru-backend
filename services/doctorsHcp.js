/**
 * Doctors HealthCare Plans (H4140) provider search.
 *
 * THEI's Sunfire book does not return Doctors networks. There is no public
 * Plan Net FHIR. The live directory is the Angular app at
 * https://providersearch.doctorshcp.com which POSTs JSON to /ProviderSearch.
 *
 * The API does not return CMS plan IDs — a hit means the NPI is in the
 * Doctors directory (shared across their MA products).
 *
 * Probed 2026-09-02. PCPSpecialtiesCode MUST be a string array (empty string → 400).
 */

const DOCTORS_SEARCH_URL = 'https://providersearch.doctorshcp.com/ProviderSearch';
const FETCH_TIMEOUT_MS = 12_000;
const PLAN_LABEL = 'Doctors HealthCare Plans';
const SEARCH_TYPES = ['pcp', 'spe'];

function buildSearchBody({ providerType, npi, zip = '', hospitalNpi = '' }) {
  return {
    ProviderType: providerType,
    PCPSpecialtiesCode: [],
    ProviderSpecialtyCode: '',
    AncillarySpecialtyCode: '',
    HospitalNPI: hospitalNpi || '',
    ProviderName: '',
    Language: '',
    ProviderNPI: providerType === 'hos' ? '' : String(npi || ''),
    City: '',
    County: '',
    ZipCode: zip ? String(zip) : '',
    LimitMilesTo: 250,
  };
}

function npiMatches(hit, npi) {
  if (!hit || npi == null || npi === '') return false;
  return String(hit.providerNpi ?? '') === String(npi);
}

function formatMatch(hit) {
  const parts = [
    hit.providerAddress1,
    hit.providerCityName,
    hit.providerState,
    hit.providerZipCode,
  ].filter(Boolean);
  return {
    npi: String(hit.providerNpi ?? ''),
    name: hit.providerName || '',
    specialty: hit.providerSpecialties || '',
    address: parts.join(', '),
    phone: hit.phone || '',
    acceptsNewPatients: hit.pcpAcceptsNewPatients || '',
  };
}

async function postSearch(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DOCTORS_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://providersearch.doctorshcp.com',
        Referer: 'https://providersearch.doctorshcp.com/',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[doctorsHcp] HTTP ${res.status} type=${body.ProviderType}`);
      return { ok: false, hits: [] };
    }
    const data = await res.json();
    return { ok: true, hits: Array.isArray(data) ? data : [] };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[doctorsHcp] ${label} type=${body.ProviderType}`);
    return { ok: false, hits: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search Doctors as PCP and specialist in parallel.
 * Zip is omitted on purpose: NPI identity must not be dropped by radius.
 */
async function queryDoctorsHcp(npi) {
  if (!npi) {
    return { inNetwork: false, matches: [], error: 'missing_npi', planLabel: PLAN_LABEL };
  }

  const results = await Promise.all(
    SEARCH_TYPES.map((providerType) =>
      postSearch(buildSearchBody({ providerType, npi, zip: '' }))
    )
  );

  const seen = new Set();
  const matches = [];
  for (const { hits } of results) {
    for (const hit of hits) {
      if (!npiMatches(hit, npi)) continue;
      const key = `${hit.providerNpi}|${hit.providerAddress1}|${hit.providerSpecialties}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push(formatMatch(hit));
    }
  }

  const anyOk = results.some((r) => r.ok);
  return {
    inNetwork: matches.length > 0,
    matches,
    error: anyOk ? null : 'request_failed',
    planLabel: PLAN_LABEL,
  };
}

module.exports = {
  PLAN_LABEL,
  DOCTORS_SEARCH_URL,
  SEARCH_TYPES,
  buildSearchBody,
  npiMatches,
  formatMatch,
  queryDoctorsHcp,
};
