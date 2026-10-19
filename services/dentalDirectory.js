/**
 * services/dentalDirectory.js — dentists are checked in each plan's DENTAL network, never the medical directory.
 *
 * Gerry Cabrera, 2026-10-19: Salome Fraga, DMD (NPI 1205322856) read ❌ on UHC, Humana and DrMax because
 * Max searched the Medicare medical directories, which do not list dentists. Humana's own dental directory
 * lists her in Florida Gold Plus Dental.
 *
 * Which network each carrier uses lives in data/dental-networks-2027.json (THEI 2027 grid, Plan Info,
 * Dental column). Live sources, all public guest endpoints (no login):
 *   humana:3171   Humana Find Care, dental (customerId 1004), POST providersearch/npi/ on network 3171
 *   uhc:national  UHC guest Find a Doctor, coverage type D → "*National Medicare Advantage Network"
 *   fdb:41 / :45  Florida Dental Benefits GeoDirectory REST (gd_placecategory 41 Doctors HCP, 45 HealthSun),
 *                 whole list cached for a day, matched by NPI (in the slug), then by name + distance
 * Everything else is "❔ check dental directory (<vendor>)" — never ❌ — and Devoted / HealthSpring
 * (no set dental network, reimbursed) read "ℹ️ no dental network (reimbursed)".
 * A source that errors or times out is "❔ not confirmed", never Out.
 */

const CONFIG = require('../data/dental-networks-2027.json');

const FETCH_TIMEOUT_MS = Number(process.env.MAX_DENTAL_TIMEOUT_MS || 12_000);
const FDB_TTL_MS = 24 * 60 * 60 * 1000;
const FDB_NAME_MILES = 30;

// ─── who is a dentist ────────────────────────────────────────────────────────────────────────

const DENTAL_TAXONOMY_RE = /^1223/; // NUCC 1223* = Dentist (general, endodontics, orthodontics, …)
const DENTAL_CRED_RE = /^\s*(?:D\.?\s*D\.?\s*S|D\.?\s*M\.?\s*D)\.?\s*$/i;

/** An NPPES record (or npiRecordInfo) for a dentist: primary taxonomy 1223*, or a DDS / DMD credential. */
function isDentistRecord(r) {
  if (!r) return false;
  const tax = r.taxonomies || [];
  const primary = tax.find((t) => t && t.primary) || tax[0];
  if (primary && DENTAL_TAXONOMY_RE.test(String(primary.code || ''))) return true;
  if (primary && /\bdentist/i.test(String(primary.desc || ''))) return true;
  const cred = String((r.basic && r.basic.credential) || r.credential || '');
  return cred.split(/[,;/]/).some((c) => DENTAL_CRED_RE.test(c));
}

/** She named a dentist or a dental practice ("Pinecrest Modern Dentistry", "Elvin Silvestry DDS"). */
function asksForDentist(name) {
  return /\b(?:dds|d\.d\.s|dmd|d\.m\.d|dentist\w*|dentisry|dental|orthodont\w*|endodont\w*|periodont\w*|prosthodont\w*)\b/i.test(String(name || ''));
}

// ─── plan → dental network (config) ─────────────────────────────────────────────────────────

function contractOf(planId) {
  return (String(planId || '').toUpperCase().match(/^([HR]\d{4})/) || [])[1] || '';
}

/** The config row for a plan: by contract first, then by carrier name. Null when neither knows it. */
function dentalNetworkFor(planId, carrier = '') {
  const c = contractOf(planId);
  const byContract = c && CONFIG.carriers.find((x) => (x.contracts || []).includes(c));
  if (byContract) return byContract;
  const name = String(carrier || '');
  if (!name) return null;
  return CONFIG.carriers.find((x) => x.carrierMatch && new RegExp(x.carrierMatch, 'i').test(name)) || null;
}

const CELLS = {
  in: '✅ In',
  out: '❌ Not in network (not listed)',
  notConfirmed: '❔ not confirmed',
  none: 'ℹ️ no dental network (reimbursed)',
  check: (vendor) => `❔ check dental directory${vendor ? ` (${vendor})` : ''}`,
};

/**
 * One plan's dental verdict for a dentist: { status: in|out|not_confirmed|check|none, vendor, source }.
 * `dental` is the structured lookup (dental.sources: { 'humana:3171': { status } … }); without one
 * (no lookup ran) a live-source plan reads "check dental directory".
 */
function dentalVerdict(dental, planId, carrier = '') {
  const row = dentalNetworkFor(planId, carrier);
  if (!row) return { status: 'check', vendor: '' };
  if (row.source === 'none') return { status: 'none', vendor: row.vendor };
  if (row.source === 'manual' || !CONFIG.sources[row.source]) return { status: 'check', vendor: row.vendor };
  const res = dental && dental.sources && dental.sources[row.source];
  if (!res) return { status: dental && dental.sources ? 'not_confirmed' : 'check', vendor: row.vendor, source: row.source };
  if (res.status === 'in') return { status: 'in', vendor: row.vendor, source: row.source, match: res.match || null };
  if (res.status === 'out') return { status: 'out', vendor: row.vendor, source: row.source };
  return { status: 'not_confirmed', vendor: row.vendor, source: row.source };
}

function dentalCell(dental, planId, carrier = '') {
  const v = dentalVerdict(dental, planId, carrier);
  if (v.status === 'in') return CELLS.in;
  if (v.status === 'out') return CELLS.out;
  if (v.status === 'none') return CELLS.none;
  if (v.status === 'check') return CELLS.check(v.vendor);
  return CELLS.notConfirmed;
}

/** Per-contract cells for every configured carrier — the export reads these (it has no config). */
function dentalCellsByContract(dental) {
  const out = {};
  for (const row of CONFIG.carriers) {
    for (const c of row.contracts || []) out[c] = dentalCell(dental, `${c}-000`);
  }
  return out;
}

// ─── fetch helpers ──────────────────────────────────────────────────────────────────────────

function newJar() { return new Map(); }
function storeCookies(jar, res) {
  const list = res && res.headers && typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const nv = String(raw).split(';')[0];
    const eq = nv.indexOf('=');
    if (eq > 0) jar.set(nv.slice(0, eq).trim(), nv.slice(eq + 1).trim());
  }
}
function cookieHeader(jar) { return [...jar.entries()].map(([n, v]) => `${n}=${v}`).join('; '); }

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    return await fetchImpl(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function geoForZip(zip) {
  try {
    return require('./humanaFindcare').geoForZip(zip);
  } catch (_) {
    return { lat: 25.654, lng: -80.361, zip: String(zip || '33176') };
  }
}

function milesBetween(a, b) {
  const R = 3958.8;
  const rad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function plainWords(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(?:dr|dds|dmd|pa|llc|inc|md)\b\.?/g, ' ').split(/[^a-z]+/).filter((w) => w.length > 1);
}

// ─── Humana dental (Find Care, customerId 1004) ────────────────────────────────────────────

const HUMANA_BASE = 'https://findcare.humana.com';
const HUMANA_DENTAL_CUSTOMER = 1004;
const HUMANA_DENTAL_COVERAGE = 7;
let humanaSession = null;

function humanaHeaders(jar, extra = {}) {
  const h = { Accept: '*/*', Origin: HUMANA_BASE, Referer: `${HUMANA_BASE}/dental`, 'User-Agent': 'Mozilla/5.0', 'X-Fc-Tab': '1', 'X-Fc-Module': 'dental', ...extra };
  const c = cookieHeader(jar);
  if (c) h.Cookie = c;
  return h;
}

async function humanaDentalSession(fetchImpl) {
  if (humanaSession && humanaSession.expiresAt > Date.now()) return humanaSession;
  const jar = newJar();
  const cfgRes = await fetchWithTimeout(fetchImpl, `${HUMANA_BASE}/session/v1/config`, { headers: humanaHeaders(jar) });
  storeCookies(jar, cfgRes);
  const cfg = await cfgRes.json().catch(() => null);
  // Public SPA key from /session/v1/config (same one humanaFindcare.js falls back to).
  const key = (cfg && cfg.APIM_SUBSCRIPTION) || '7f74c6e49dac4c04a5cfd8d686124418';
  const tok = await fetchWithTimeout(fetchImpl, `${HUMANA_BASE}/apim-gateway/api/v1/token/validate/guest`, { headers: humanaHeaders(jar, { 'Ocp-Apim-Subscription-Key': key }) });
  storeCookies(jar, tok);
  if (!tok.ok) throw new Error(`humana dental guest token HTTP ${tok.status}`);
  humanaSession = { jar, key, expiresAt: Date.now() + 20 * 60 * 1000 };
  return humanaSession;
}

async function searchHumanaDental({ npi, zip, networkId }, fetchImpl = fetch) {
  const s = await humanaDentalSession(fetchImpl);
  const geo = geoForZip(zip);
  const res = await fetchWithTimeout(fetchImpl, `${HUMANA_BASE}/apim-gateway/api/v1/providersearch/npi/`, {
    method: 'POST',
    headers: humanaHeaders(s.jar, { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': s.key }),
    body: JSON.stringify({
      customerId: HUMANA_DENTAL_CUSTOMER,
      networkId,
      coverageTypeId: HUMANA_DENTAL_COVERAGE,
      value: String(npi),
      distance: 50,
      offset: 1,
      limit: 20,
      sortBy: 5,
      location: { latitude: geo.lat, longitude: geo.lng, zipCode: geo.zip },
      filters: [{ id: 0, values: [] }],
      centerwellConvivaFilter: 0,
      tealiumSessionId: '',
      ipaId: 0,
      coverageYear: 'Future',
    }),
  });
  storeCookies(s.jar, res);
  const data = await res.json().catch(() => null);
  if (!res.ok) { humanaSession = null; throw new Error(`humana dental HTTP ${res.status}`); }
  // A 200 that is not a search answer is a failed check, never a miss.
  if (!data || !Array.isArray(data.results)) throw new Error('humana dental: response is not a search result');
  const hit = data.results.find((r) => (r.nationalProviderIdentifiers || []).map(String).includes(String(npi)));
  if (!hit) return { status: 'out' };
  const a = hit.address || {};
  return {
    status: 'in',
    match: {
      name: hit.providerName || '',
      office: hit.affiliationNames || '',
      address: [a.addressLine1, a.addressLine2, a.city, a.stateCode, String(a.zipCode || '').slice(0, 5)].filter(Boolean).join(', '),
      phone: hit.phone || '',
      miles: hit.officeDistance != null ? Number(hit.officeDistance) : null,
    },
  };
}

// ─── UHC dental (guest Find a Doctor, coverage type D) ─────────────────────────────────────

const UHC_BASE = 'https://findcare.guest.uhc.com';
const UHC_DENTAL_PLAN = 'FFS000000028'; // "*National Medicare Advantage Network" (the only MR dental plan, 2026-10-19)
const UHC_PROVIDER_SEARCH = `query ProviderSearch($coverages: [String]!, $coverageType: String!, $reciprocityId: String!, $providerType: String!, $npiNumber: String, $latitude: String, $longitude: String, $lob: String, $population: String, $planYear: String, $rulesPackageKey: String, $isGuestUser: Boolean, $stateCode: String, $locale: String, $pageNumber: Int, $pageSize: Int, $searchRadius: Int) {
  providerSearch(coverages: $coverages, coverageType: $coverageType, reciprocityId: $reciprocityId, providerType: $providerType, npiNumber: $npiNumber, latitude: $latitude, longitude: $longitude, lob: $lob, population: $population, planYear: $planYear, rulesPackageKey: $rulesPackageKey, isGuestUser: $isGuestUser, stateCode: $stateCode, locale: $locale, pageNumber: $pageNumber, pageSize: $pageSize, searchRadius: $searchRadius) {
    providers { providerId firstName middleName lastName npi speciality }
  }
}`;
let uhcSession = null;

function uhcHeaders(jar, extra = {}) {
  const h = { Accept: 'application/json', Origin: UHC_BASE, Referer: `${UHC_BASE}/guest-plan-selection/browse`, 'User-Agent': 'Mozilla/5.0', ...extra };
  const c = cookieHeader(jar);
  if (c) h.Cookie = c;
  return h;
}

async function uhcDentalSession(fetchImpl) {
  if (uhcSession && uhcSession.expiresAt > Date.now()) return uhcSession;
  const jar = newJar();
  const a = await fetchWithTimeout(fetchImpl, `${UHC_BASE}/api/create-guest-session?useGuestPersistence=true`, { headers: uhcHeaders(jar) });
  storeCookies(jar, a);
  const b = await fetchWithTimeout(fetchImpl, `${UHC_BASE}/api/authorize-guest-session`, { headers: uhcHeaders(jar) });
  storeCookies(jar, b);
  if (!a.ok || !b.ok) throw new Error(`uhc dental guest session HTTP ${a.status}/${b.status}`);
  uhcSession = { jar, expiresAt: Date.now() + 20 * 60 * 1000 };
  return uhcSession;
}

async function searchUhcDental({ npi, zip, year = 2027 }, fetchImpl = fetch) {
  const s = await uhcDentalSession(fetchImpl);
  const geo = geoForZip(zip);
  const res = await fetchWithTimeout(fetchImpl, `${UHC_BASE}/api/graphql`, {
    method: 'POST',
    headers: uhcHeaders(s.jar, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      operationName: 'ProviderSearch',
      query: UHC_PROVIDER_SEARCH,
      variables: {
        coverages: ['D'], coverageType: 'D', reciprocityId: UHC_DENTAL_PLAN, providerType: 'PRACTITIONER', npiNumber: String(npi),
        latitude: String(geo.lat), longitude: String(geo.lng), lob: 'M&R', population: 'DENTAL', planYear: String(year),
        rulesPackageKey: UHC_DENTAL_PLAN, isGuestUser: true, stateCode: 'FL', locale: 'en-US', pageNumber: 1, pageSize: 5, searchRadius: 50,
      },
    }),
  });
  storeCookies(s.jar, res);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.errors) { uhcSession = null; throw new Error((data && data.errors && data.errors[0] && data.errors[0].message) || `uhc dental HTTP ${res.status}`); }
  const list = data.data && data.data.providerSearch && data.data.providerSearch.providers;
  if (!Array.isArray(list)) throw new Error('uhc dental: response is not a provider list');
  const hit = list.find((p) => String(p.npi || '') === String(npi));
  if (!hit) return { status: 'out' };
  return { status: 'in', match: { name: [hit.firstName, hit.middleName, hit.lastName].filter(Boolean).join(' '), specialty: hit.speciality || '' } };
}

// ─── Florida Dental Benefits (GeoDirectory REST, cached daily) ─────────────────────────────

const FDB_BASE = 'https://fdbenefits.com/wp-json/geodir/v2/places';
const FDB_FIELDS = 'slug,provider_full_name,office_name,street,city,zip,latitude,longitude,phone';
const fdbCache = new Map(); // category → { at, rows } | { promise }

function fdbNpi(slug) {
  return (String(slug || '').match(/-(\d{10})-/) || [])[1] || '';
}

async function fdbPage(category, page, fetchImpl) {
  const url = `${FDB_BASE}?gd_placecategory=${category}&per_page=100&page=${page}&_fields=${FDB_FIELDS}`;
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) throw new Error(`fdb page ${page} HTTP ${res.status}`);
  const pages = Number(res.headers && res.headers.get && res.headers.get('x-wp-totalpages')) || 1;
  return { rows: data, pages };
}

/** Every provider FDB lists for one plan (category), refreshed once a day. */
async function fdbList(category, fetchImpl = fetch) {
  const hit = fdbCache.get(category);
  if (hit && hit.rows && Date.now() - hit.at < FDB_TTL_MS) return hit.rows;
  if (hit && hit.promise) return hit.promise;
  const promise = (async () => {
    const first = await fdbPage(category, 1, fetchImpl);
    const rest = await Promise.all(Array.from({ length: Math.max(0, Math.min(first.pages, 60) - 1) }, (_, i) => fdbPage(category, i + 2, fetchImpl)));
    const rows = [first, ...rest].flatMap((p) => p.rows).map((r) => ({
      npi: fdbNpi(r.slug),
      name: String(r.provider_full_name || ''),
      office: String(r.office_name || ''),
      address: [r.street, r.city, 'FL', String(r.zip || '').slice(0, 5)].filter(Boolean).join(', '),
      lat: Number(r.latitude),
      lng: Number(r.longitude),
      phone: String(r.phone || ''),
    }));
    if (!rows.length) throw new Error('fdb: empty provider list');
    fdbCache.set(category, { at: Date.now(), rows });
    return rows;
  })();
  fdbCache.set(category, { promise, ...(hit && hit.rows ? { rows: hit.rows, at: hit.at } : {}) });
  try {
    return await promise;
  } catch (err) {
    // Keep yesterday's list if the refresh failed; otherwise the check fails (not confirmed).
    if (hit && hit.rows) { fdbCache.set(category, { at: hit.at, rows: hit.rows }); return hit.rows; }
    fdbCache.delete(category);
    throw err;
  }
}

/** Listed by NPI → In; else same first + last name within FDB_NAME_MILES of her ZIP → In; else Out. */
async function searchFdb({ npi, firstName, lastName, zip, category }, fetchImpl = fetch) {
  const rows = await fdbList(category, fetchImpl);
  const fmt = (r) => ({ name: r.name, office: r.office, address: r.address, phone: r.phone, npi: r.npi });
  const byNpi = npi ? rows.find((r) => r.npi === String(npi)) : null;
  if (byNpi) return { status: 'in', match: fmt(byNpi), matchedBy: 'npi' };
  const first = plainWords(firstName)[0];
  const last = plainWords(lastName);
  if (first && last.length) {
    const geo = geoForZip(zip);
    const near = rows.filter((r) => {
      const w = plainWords(r.name);
      return w[0] === first && last.every((x) => w.includes(x))
        && (!Number.isFinite(r.lat) || milesBetween(geo, r) <= FDB_NAME_MILES);
    });
    if (near.length) return { status: 'in', match: fmt(near[0]), matchedBy: 'name' };
  }
  return { status: 'out' };
}

// ─── one dentist, every live source ────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

/**
 * Check one dentist (npiRecordInfo shape: npi, firstName, lastName) against every live dental source.
 * Returns { isDentist: true, sources: { key: { status: in|out|failed, match?, error? } }, cellsByContract }.
 */
async function checkDentist(rec, { zip, year = 2027, deadlineAt, fetchImpl = fetch, only } = {}) {
  const budget = Math.max(1000, Math.min(FETCH_TIMEOUT_MS + 3000, (Number(deadlineAt) || Date.now() + 20_000) - Date.now()));
  const keys = Object.keys(CONFIG.sources).filter((k) => !only || only.includes(k));
  const run = (key) => {
    const src = CONFIG.sources[key];
    if (src.kind === 'humana') return searchHumanaDental({ npi: rec.npi, zip, networkId: src.humanaNetworkId }, fetchImpl);
    if (src.kind === 'uhc') return searchUhcDental({ npi: rec.npi, zip, year }, fetchImpl);
    if (src.kind === 'fdb') return searchFdb({ npi: rec.npi, firstName: rec.firstName, lastName: rec.lastName, zip, category: src.fdbCategory }, fetchImpl);
    return Promise.reject(new Error(`unknown dental source ${key}`));
  };
  const settled = await Promise.all(keys.map((key) => withTimeout(run(key), budget).then(
    (v) => [key, v],
    (err) => [key, { status: 'failed', error: err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err) }],
  )));
  const dental = { isDentist: true, sources: Object.fromEntries(settled) };
  dental.cellsByContract = dentalCellsByContract(dental);
  return dental;
}

/** Text for the model / agent: what each dental directory said. */
function formatDentalText(doctorName, rec, dental) {
  const lines = [`Dental directory results for "${doctorName}" (dentist — checked in each plan's DENTAL network, not the Medicare medical directories):`];
  lines.push(`**${rec.name}** (NPI: ${rec.npi})${rec.specialty ? ` · ${rec.specialty}` : ''}`);
  for (const [key, r] of Object.entries(dental.sources || {})) {
    const label = CONFIG.sources[key] ? CONFIG.sources[key].label : key;
    if (r.status === 'in') lines.push(`- ${label}: LISTED${r.match ? ` — ${[r.match.name, r.match.office, r.match.address].filter(Boolean).join(', ')}` : ''}`);
    else if (r.status === 'out') lines.push(`- ${label}: not listed → Not in network (not listed)`);
    else lines.push(`- ${label}: could not complete (${r.error || 'error'}) → not confirmed, never Out`);
  }
  const manual = CONFIG.carriers.filter((c) => c.source === 'manual').map((c) => `${c.carrier}: ${c.vendor}`);
  const none = CONFIG.carriers.filter((c) => c.source === 'none').map((c) => c.carrier);
  lines.push(`Other carriers have no dental directory Max can search — cells read "❔ check dental directory (vendor)": ${manual.join('; ')}.`);
  if (none.length) lines.push(`${none.join(' and ')}: no set dental network (reimbursed) — not In/Out.`);
  lines.push('Dentists are left out of the doctor counts and the plan ranking.');
  return lines.join('\n');
}

function resetDentalCaches() {
  humanaSession = null;
  uhcSession = null;
  fdbCache.clear();
}

module.exports = {
  CONFIG,
  CELLS,
  isDentistRecord,
  asksForDentist,
  dentalNetworkFor,
  dentalVerdict,
  dentalCell,
  dentalCellsByContract,
  searchHumanaDental,
  searchUhcDental,
  searchFdb,
  fdbList,
  fdbNpi,
  checkDentist,
  formatDentalText,
  resetDentalCaches,
};
