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

const fs = require('fs');
const path = require('path');

// 2027 county directory PDFs (exact NPIs), built by scripts/build_doctors_index.py.
// Checked first because Railway often cannot reach the live search site ("fetch failed").
const INDEX_PATH = path.join(__dirname, '..', 'data', 'doctors-directory-2027.json');
const COUNTY_LABEL = { miamiDade: 'Miami-Dade', broward: 'Broward', tampa: 'Hillsborough/Pasco', orlando: 'Orange/Osceola/Seminole', polk: 'Polk' };
let pdfIndex;
function loadIndex() {
  if (pdfIndex === undefined) {
    try { pdfIndex = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { pdfIndex = null; }
  }
  return pdfIndex;
}

// Which county PDF covers which counties (COUNTY_LABEL). Polk has no PDF index yet.
const INDEX_COUNTIES = {
  miamiDade: ['Miami-Dade'],
  broward: ['Broward'],
  tampa: ['Hillsborough', 'Pasco'],
  orlando: ['Orange', 'Osceola', 'Seminole'],
  polk: ['Polk'],
};

const SOUTH_FLORIDA_POOL = ['miamiDade', 'broward'];

/** Index keys for HER county (from the ZIP); [] when the county is unknown or has no Doctors PDF. */
function doctorsIndexKeysForZip(zip) {
  const idx = loadIndex();
  const counties = require('./flZipCounty').countiesForZip(zip);
  const keys = [];
  for (const c of counties) {
    for (const [k, list] of Object.entries(INDEX_COUNTIES)) {
      if (list.includes(c) && idx && idx.counties && idx.counties[k] && !keys.includes(k)) keys.push(k);
    }
  }
  // Miami-Dade and Broward are ONE pool: DrSelect-SFL / DrMax are South Florida plans, and each
  // county PDF lists only doctors whose offices are in that county. A Miami-Dade client seeing a
  // Plantation doctor is In — searching only her county's PDF read him ❌ Out (Yahoska, 2026-10-07).
  if (keys.some((k) => SOUTH_FLORIDA_POOL.includes(k))) {
    for (const k of SOUTH_FLORIDA_POOL) if (idx && idx.counties && idx.counties[k] && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/**
 * County-scoped PDF check: a listing in another county's directory is never In for her.
 * → { searched, hits (her county), otherCounty (listed elsewhere only) }.
 */
function doctorsPdfScoped(npi, zip) {
  const all = doctorsPdfCheck(npi);
  const keys = doctorsIndexKeysForZip(zip);
  if (!keys.length) return { searched: false, hits: [], otherCounty: all };
  return { searched: true, hits: all.filter((h) => keys.includes(h.county)), otherCounty: all.filter((h) => !keys.includes(h.county)), keys };
}

/** NPI listed in any 2027 Doctors county PDF? Returns [{county, label, page, asOf}] (empty = not listed). */
function doctorsPdfCheck(npi) {
  const idx = loadIndex();
  if (!idx || !npi) return [];
  const hits = [];
  for (const [county, c] of Object.entries(idx.counties || {})) {
    const page = c.npis && c.npis[String(npi)];
    if (page) hits.push({ county, label: COUNTY_LABEL[county] || county, page, asOf: c.asOf || null });
  }
  return hits;
}

const DOCTORS_SEARCH_URL = 'https://providersearch.doctorshcp.com/ProviderSearch';
const FETCH_TIMEOUT_MS = 12_000;
const PLAN_LABEL = 'Doctors HealthCare Plans';
const SEARCH_TYPES = ['pcp', 'spe'];
const DIRECTORY_DEBUG = /^(1|true|yes)$/i.test(String(process.env.MAX_DIRECTORY_DEBUG || ''));

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

const RETRY_STATUS = new Set([404, 408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = Number(process.env.MAX_DOCTORS_HCP_RETRY_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The Doctors API answers bursts with HTTP 404 (probed 2026-10-06: back-to-back
 * calls 404, the same call 2.5s apart returns 200). One retry after a pause.
 */
async function postSearch(body) {
  const first = await postSearchOnce(body);
  if (first.ok || !RETRY_STATUS.has(first.status || 0)) return first;
  await sleep(RETRY_DELAY_MS);
  return postSearchOnce(body);
}

async function postSearchOnce(body) {
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
      return { ok: false, status: res.status, hits: [] };
    }
    const data = await res.json();
    // Anything but a JSON list (HTML block page, error object) is a failed check, not a miss.
    if (!Array.isArray(data)) {
      console.warn(`[doctorsHcp] 200 non-list reply type=${body.ProviderType} npi=${body.ProviderNPI}`);
      return { ok: false, status: 200, hits: [] };
    }
    if (DIRECTORY_DEBUG) {
      const match = data.filter((h) => String(h.providerNpi ?? '') === String(body.ProviderNPI)).length;
      console.log(`[doctorsHcp] 200 type=${body.ProviderType} npi=${body.ProviderNPI} rows=${data.length} match=${match}`);
    }
    return { ok: true, hits: data };
  } catch (err) {
    const cause = err.cause ? ` (${err.cause.code || err.cause.name || ''} ${err.cause.message || ''})`.replace(/\s+\)/, ')') : '';
    const label = err.name === 'AbortError' ? 'Timeout' : `${err.message}${cause}`;
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
async function queryDoctorsHcp(npi, { zip } = {}) {
  if (!npi) {
    return { inNetwork: false, matches: [], error: 'missing_npi', planLabel: PLAN_LABEL };
  }

  // With her ZIP, only her county's PDF counts (a Tampa listing is not In for a Miami-Dade client).
  // Without a ZIP (admin probes, old callers) any county PDF answers, as before.
  const scoped = zip ? doctorsPdfScoped(npi, zip) : null;
  const pdfHits = scoped ? scoped.hits : doctorsPdfCheck(npi);
  if (scoped && scoped.searched && !pdfHits.length && scoped.otherCounty.length) {
    // Listed only in a county outside her pool (e.g. Tampa for a Miami-Dade client). That is not
    // an In for her — but it is not proof of Out either, so it is a failed check: ❔ unchecked,
    // never ❌ Out. The live site cannot tell counties apart, so it is not asked.
    return {
      inNetwork: false,
      matches: [],
      error: 'other_county_only',
      source: 'pdf',
      otherCountyOnly: scoped.otherCounty.map((h) => `${h.label} p. ${h.page}`),
      planLabel: PLAN_LABEL,
    };
  }
  if (pdfHits.length) {
    return {
      inNetwork: true,
      matches: pdfHits.map((h) => ({
        npi: String(npi), name: '', specialty: '', phone: '', acceptsNewPatients: '',
        address: `Doctors 2027 directory PDF, ${h.label} p. ${h.page}${h.asOf ? ` (current as of ${h.asOf})` : ''}`,
      })),
      error: null,
      source: 'pdf',
      planLabel: PLAN_LABEL,
    };
  }

  // One after the other (PCP, then specialist) — parallel bursts get 404s.
  const results = [];
  for (const providerType of SEARCH_TYPES) {
    const r = await postSearch(buildSearchBody({ providerType, npi, zip: '' }));
    results.push(r);
    if (r.hits.some((hit) => npiMatches(hit, npi))) break; // found — no need for the other list
  }

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

  // A miss only counts as "checked" when every list answered; a failed list is not a miss.
  const allOk = results.every((r) => r.ok);
  return {
    inNetwork: matches.length > 0,
    matches,
    error: matches.length || allOk ? null : 'request_failed',
    planLabel: PLAN_LABEL,
  };
}

/** Raw answer per list for one NPI — for /admin/directory-check (what Railway actually gets). */
async function probeDoctors(npi) {
  const out = [];
  for (const providerType of SEARCH_TYPES) {
    const r = await postSearchOnce(buildSearchBody({ providerType, npi, zip: '' }));
    out.push({ list: providerType, ok: r.ok, status: r.status || (r.ok ? 200 : null), rows: r.hits.length, match: r.hits.filter((h) => npiMatches(h, npi)).length });
  }
  return out;
}

module.exports = {
  doctorsPdfCheck,
  doctorsPdfScoped,
  doctorsIndexKeysForZip,
  probeDoctors,
  PLAN_LABEL,
  DOCTORS_SEARCH_URL,
  SEARCH_TYPES,
  buildSearchBody,
  npiMatches,
  formatMatch,
  queryDoctorsHcp,
};
