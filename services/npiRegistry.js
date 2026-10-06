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
 *
 * Clinic / group names (2026-10-02, Miami Neurology & Rehab Specialists):
 *   - NPI-1 last-name search treats "Specialists" as a person and misses the
 *     org. Use NPI-2 organization_name with a trailing wildcard
 *     (`MIAMI NEUROLOGY*`) — CMS does not substring-match without `*`.
 *   - DBA MNRS is not in NPPES other_names. Aliases come from the clinic site
 *     or the agent, not from inventing a marketing name.
 */

const NPI_REGISTRY_BASE = 'https://npiregistry.cms.hhs.gov/api/';
const FETCH_TIMEOUT_MS = 12_000;
const CMS_PAGE_LIMIT = 20;
const DEFAULT_RETURN_LIMIT = 5;

const CREDENTIAL_RE = /^(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD|ARNP|FNP|DNP)$/i;

const ORG_HINT_RE = /\b(clinic|clinics|group|groups|specialists?|rehab|rehabilitation|therap(?:y|ies)|physical|neurology|neuro|associates?|centers?|centres?|institute|hospital|hospitals|medical|health|physicians?|practice|practices|llc|inc|pllc|dba|corp|corporation|services)\b|&/i;

const ORG_STOP = new Set(['and', 'of', 'the', 'at', 'for', 'a', 'an', 'llc', 'inc', 'pllc', 'dba', 'pa', '&']);

const ORG_ABBREV = {
  rehab: 'rehabilitation',
  spec: 'specialists',
  specialist: 'specialists',
  specialists: 'specialists',
  assoc: 'associates',
  associates: 'associates',
  ctr: 'center',
  neuro: 'neurology',
};

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

const CRED_TOKEN_RE = /^(MD|DO|NP|PA|PAC|RN|APRN|DDS|DMD|DPM|OD|DC|PHARMD|PHD|ARNP|FNP|DNP|FACC|FACP|FACS|FAAFP|MPH|MBA|MS|JR|SR|II|III)$/i;
const SPECIALTY_HINT_RE = /^(pcp|primary|care|cardio|cardiology|cardiologist|ortho|orthopedic|orthopedics|orthopedist|gyn|obgyn|ob|derm|dermatology|dermatologist|eye|ophthalmologist|ophthalmology|optometrist|neuro|neurologist|gi|gastro|gastroenterologist|uro|urologist|endo|endocrinologist|onc|oncologist|pulm|pulmonologist|nephro|nephrologist|podiatrist|rheum|rheumatologist|ent|psych|psychiatrist|specialist|doctor|dr)$/i;

/**
 * "HOWARD BUSH M.D.", "Dr. Howard Bush, MD, FACC", "Howard Bush Cardio" → "Howard Bush".
 * Saved workups store NPPES display names with dotted credentials; NPPES search
 * misses them unless the credential and specialty hints are stripped.
 */
function cleanDoctorQuery(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s || /^\d{10}$/.test(s)) return s;
  s = s.replace(/^(dr\.?|doctor|mr\.?|mrs\.?|ms\.?)\s+/i, '');
  s = s.replace(/\(([^)]*)\)/g, ' ').replace(/\s+/g, ' ').trim();
  const isOrg = ORG_HINT_RE.test(s);
  const parts = s.split(/[\s,]+/).filter(Boolean);
  while (parts.length > 1) {
    const raw = parts[parts.length - 1];
    const bare = raw.replace(/[.\-/]/g, '');
    if (CRED_TOKEN_RE.test(bare) || (!isOrg && SPECIALTY_HINT_RE.test(bare))) parts.pop();
    else break;
  }
  if (isOrg) {
    while (parts.length > 1 && /^(llc|inc|pllc|pa|corp|co)\.?$/i.test(parts[parts.length - 1])) parts.pop();
  }
  let out = parts.join(' ');
  if (out === out.toUpperCase() && /[A-Z]/.test(out)) {
    out = out.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }
  return out;
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

function allLocationAddresses(result) {
  const addrs = [...(result?.addresses || []), ...(result?.practiceLocations || [])];
  const locs = addrs.filter((a) => a.address_purpose === 'LOCATION' || (!a.address_purpose && a.address_1));
  return locs.length ? locs : addrs;
}

function locationZip(result) {
  const loc = allLocationAddresses(result)[0] || {};
  return String(loc.postal_code || '').slice(0, 5);
}

function looksLikeOrganization(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  if (/^\d{10}$/.test(s)) return false;
  if (/\b(MD|DO|NP|ARNP|APRN)\b/i.test(s) && !ORG_HINT_RE.test(s)) return false;
  if (/^[A-Za-z][A-Za-z'.-]+,\s+[A-Za-z]/.test(s) && !ORG_HINT_RE.test(s)) return false;
  // Only a clinic word (or &) makes it a clinic. Four plain words is a person with two
  // surnames ("Carlos Alberto Sosa Rosales"), not a company — live bug 2026-10-06.
  return ORG_HINT_RE.test(s);
}

function orgQueryVariants(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  const cleaned = raw.replace(/[.,/]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter((t) => t && !ORG_STOP.has(t.toLowerCase()));
  const expanded = tokens.map((t) => ORG_ABBREV[t.toLowerCase()] || t);
  const variants = new Set();
  const add = (s) => {
    const v = String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (v.length < 3) return;
    variants.add(v.endsWith('*') ? v : `${v}*`);
  };
  add(cleaned);
  add(expanded.join(' '));
  if (expanded.length >= 2) add(expanded.slice(0, 2).join(' '));
  if (expanded.length >= 3) add(expanded.slice(0, 3).join(' '));
  if (tokens.length >= 2) add(tokens.slice(0, 2).join(' '));
  return [...variants];
}

function displayName(result) {
  const b = result?.basic || {};
  if (b.organization_name) {
    const dba = (result.other_names || [])
      .map((o) => o.organization_name || o.code)
      .filter(Boolean);
    return dba.length ? `${b.organization_name} (DBA ${dba.join(', ')})` : b.organization_name;
  }
  return [b.first_name, b.middle_name, b.last_name, b.credential].filter(Boolean).join(' ');
}

function formatAddressLine(addr) {
  if (!addr) return '';
  return [
    addr.address_1,
    addr.address_2,
    addr.city,
    addr.state,
    String(addr.postal_code || '').slice(0, 5),
  ].filter(Boolean).join(', ');
}

function formatClinicRecord(result) {
  const locations = allLocationAddresses(result);
  const phones = [...new Set(locations.map((a) => a.telephone_number).filter(Boolean))];
  const aliases = (result.other_names || [])
    .map((o) => o.organization_name || o.code)
    .filter(Boolean);
  const spec = (result.taxonomies || []).find((t) => t.primary)?.desc
    || (result.taxonomies || [])[0]?.desc
    || null;
  return {
    npi: result.number,
    enumerationType: result.enumeration_type || (result.basic?.organization_name ? 'NPI-2' : 'NPI-1'),
    officialName: displayName(result),
    organizationName: result.basic?.organization_name || null,
    aliases,
    specialty: spec,
    addresses: locations.map((a) => ({
      line: formatAddressLine(a),
      city: a.city || null,
      state: a.state || null,
      zip: String(a.postal_code || '').slice(0, 5) || null,
      phone: a.telephone_number || null,
    })),
    phones,
    status: result.basic?.status || null,
  };
}

function orgTokenSet(name) {
  return new Set(
    String(name || '')
      .toUpperCase()
      .replace(/[.,/&]/g, ' ')
      .split(/\s+/)
      .map((t) => ORG_ABBREV[t.toLowerCase()] ? ORG_ABBREV[t.toLowerCase()].toUpperCase() : t)
      .filter((t) => t && !ORG_STOP.has(t.toLowerCase()))
  );
}

function rankOrgScore(result, { zip, city, organizationName } = {}) {
  let s = rankScore(result, { zip });
  const qz = String(zip || '').slice(0, 5);
  if (qz) {
    for (const addr of allLocationAddresses(result)) {
      const z = String(addr.postal_code || '').slice(0, 5);
      if (z === qz) s += 100;
      else if (z.slice(0, 3) === qz.slice(0, 3)) s += 20;
    }
  }
  const qc = String(city || '').trim().toUpperCase();
  if (qc) {
    for (const addr of allLocationAddresses(result)) {
      if (String(addr.city || '').toUpperCase() === qc) s += 40;
    }
  }
  const qTokens = orgTokenSet(organizationName);
  const nameTokens = orgTokenSet(result?.basic?.organization_name);
  if (qTokens.size && nameTokens.size) {
    let overlap = 0;
    for (const t of qTokens) {
      if (nameTokens.has(t)) overlap += 1;
    }
    s += overlap * 25;
  }
  return s;
}

function rankOrgResults(results, query) {
  return [...results].sort((a, b) => rankOrgScore(b, query) - rankOrgScore(a, query));
}

async function lookupByOrganizationName({
  organizationName,
  state = 'FL',
  zip,
  city,
  limit = DEFAULT_RETURN_LIMIT,
} = {}) {
  const variants = orgQueryVariants(organizationName);
  if (!variants.length) return [];
  const byNumber = new Map();
  for (const q of variants.slice(0, 4)) {
    const p = new URLSearchParams({
      version: '2.1',
      enumeration_type: 'NPI-2',
      organization_name: q,
      limit: String(CMS_PAGE_LIMIT),
    });
    if (state) p.set('state', state);
    const data = await fetchJSON(`${NPI_REGISTRY_BASE}?${p}`);
    for (const rec of data?.results || []) {
      if (rec?.number && !byNumber.has(rec.number)) byNumber.set(rec.number, rec);
    }
  }
  return rankOrgResults([...byNumber.values()], { zip, city, organizationName }).slice(0, limit);
}

// Not a treating doctor: behavior techs, counselors, aides. Never the doctor an agent named.
const NON_PROVIDER_CRED_RE = /\b(RBT|BCBA|BCABA|LMHC|LCSW|LMFT|CNA|HHA|CMA|EMT|RT|CPHT|PHARM\s*TECH)\b/i;
const NON_PROVIDER_TAXONOMY_RE = /behavior technician|behavior analyst|counselor|social worker|technician|aide|assistant, home health|marriage|doula|massage/i;

function isNonProvider(result) {
  const b = result?.basic || {};
  const tax = (result?.taxonomies || []).map((t) => t.desc || '').join(' ');
  return NON_PROVIDER_CRED_RE.test(String(b.credential || '')) || NON_PROVIDER_TAXONOMY_RE.test(tax);
}

/**
 * Name first, place second: the doctor she named beats a different person who
 * happens to practice in the client's ZIP ("Carlos Sosa" must never resolve to
 * Amanda C Sosa, RBT, because Amanda's office is closer).
 */
function rankScore(result, { zip, firstName, middleName } = {}) {
  let s = 0;
  const z = locationZip(result);
  const qz = String(zip || '').slice(0, 5);
  if (qz && z === qz) s += 100;
  else if (qz && z.slice(0, 3) === qz.slice(0, 3)) s += 25;
  const b = result?.basic || {};
  const fn = String(b.first_name || '').toUpperCase();
  const qf = String(firstName || '').toUpperCase();
  if (qf && fn === qf) s += 150;
  else if (qf && fn && fn[0] === qf[0]) s += 30;
  const mid = String(middleName || '').replace(/\./g, '').trim();
  if (mid && String(b.middle_name || '').toUpperCase().startsWith(mid.toUpperCase())) s += 40;
  if (/\b(MD|DO)\b/i.test(b.credential || '')) s += 15;
  if (isNonProvider(result)) s -= 200;
  return s;
}

function rankResults(results, query) {
  return [...results].sort((a, b) => rankScore(b, query) - rankScore(a, query));
}

/** Same person she named? First name (or its initial / a middle name) must agree. */
function firstNameAgrees(result, firstName) {
  const qf = String(firstName || '').toUpperCase().replace(/\./g, '');
  if (!qf) return true;
  const b = result?.basic || {};
  const fn = String(b.first_name || '').toUpperCase();
  const mn = String(b.middle_name || '').toUpperCase();
  if (qf.length === 1) return fn.startsWith(qf) || mn.startsWith(qf);
  return fn === qf || mn === qf || fn.startsWith(qf) || qf.startsWith(fn) && fn.length >= 3;
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
  const results = (data?.results || []).filter((r) => !isNonProvider(r));
  return rankResults(results, { zip, firstName, middleName }).slice(0, limit);
}

// "Ian Del Conde", "Maria De La Cruz", "Juan Dos Santos" — the particle belongs to the last name.
const SURNAME_PARTICLES = new Set(['de', 'del', 'della', 'dela', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'van', 'von', 'der', 'den', 'le', 'st', 'san', 'santa', 'mac', 'y']);

/**
 * Resolve CMS NPI-1 and NPI-2 records from a pasted NPI and/or a name.
 * ZIP ranks matches; it does not filter them out. Clinic/group names try
 * organization search first (or as a fallback when the individual search misses).
 */
async function resolveNpiRecords({ doctorName = '', zip, state = 'FL', npi, limit = DEFAULT_RETURN_LIMIT } = {}) {
  const number = extractNpi(npi) || extractNpi(doctorName);
  doctorName = cleanDoctorQuery(doctorName);
  if (number) {
    const byNumber = await lookupByNumber(number);
    if (byNumber.length) return byNumber;
  }

  const orgFirst = looksLikeOrganization(doctorName);
  if (orgFirst) {
    const org = await lookupByOrganizationName({ organizationName: doctorName, zip, state, limit });
    if (org.length) return org;
  }

  const parsed = parseName(doctorName);
  const tokens = [parsed.firstName, parsed.middleName, parsed.lastName].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
  const attempts = [];
  if (tokens.length >= 3) {
    // Particle in the middle ("Ian Del Conde") → compound last name first.
    const particleAt = tokens.findIndex((t, i) => i > 0 && i < tokens.length - 1 && SURNAME_PARTICLES.has(t.toLowerCase()));
    if (particleAt > 0) attempts.push({ firstName: tokens[0], middleName: tokens.slice(1, particleAt).join(' '), lastName: tokens.slice(particleAt).join(' ') });
  }
  attempts.push(parsed);
  if (tokens.length >= 3) {
    attempts.push({ firstName: tokens[0], lastName: tokens.slice(1).join(' ') });
    attempts.push({ firstName: tokens[0], lastName: tokens.slice(-2).join(' ') });
    attempts.push({ firstName: tokens[0], lastName: tokens.slice(-2).join('-') });
  }
  const seen = new Set();
  let results = [];
  for (const attempt of attempts) {
    const key = `${attempt.firstName || ''}|${attempt.lastName || ''}`.toLowerCase();
    if (!attempt.lastName || seen.has(key)) continue;
    seen.add(key);
    results = await lookupByName({ ...attempt, zip, state, limit });
    if (results.length) return results;
  }
  // Longer registered last names: "Ian Del Conde" is NPPES "DEL CONDE POZZI". NPPES takes a
  // trailing * after 2+ letters; the first name still has to agree.
  if (parsed.firstName) {
    const stems = [];
    if (tokens.length >= 3) stems.push(tokens.slice(1).join(' '));
    if (parsed.lastName) stems.push(parsed.lastName);
    for (const stem of [...new Set(stems)]) {
      if (stem.replace(/[^A-Za-z]/g, '').length < 2) continue;
      const wild = await lookupByName({ firstName: tokens[0], lastName: `${stem}*`, zip, state, limit: CMS_PAGE_LIMIT });
      const keep = wild.filter((r) => firstNameAgrees(r, tokens[0])).slice(0, limit);
      if (keep.length) return keep;
    }
  }
  // Last name only — but only people whose first name agrees with hers. A different
  // first name is a different person: better "no NPI match, send the NPI" than a wrong doctor.
  if (parsed.lastName && parsed.firstName) {
    const lastOnly = await lookupByName({ lastName: parsed.lastName, zip, state, limit: CMS_PAGE_LIMIT });
    results = lastOnly.filter((r) => firstNameAgrees(r, parsed.firstName)).slice(0, limit);
    if (results.length) return results;
  }

  if (!orgFirst && doctorName) {
    const orgs = await lookupByOrganizationName({ organizationName: doctorName, zip, state, limit });
    // A person's name only matches a clinic that carries their surname ("Sosa"), never one
    // that shares first names ("CARLOS ALBERTO ALSINA MORFA APRN CORP" ≠ Carlos Alberto Sosa Rosales).
    const surnames = tokens.slice(tokens.length >= 4 ? 2 : 1)
      .map((t) => t.toUpperCase().replace(/[^A-Z]/g, ''))
      .filter((t) => t.length >= 3 && !SURNAME_PARTICLES.has(t.toLowerCase()));
    if (!surnames.length) return orgs;
    return orgs.filter((r) => {
      const words = orgTokenSet(r?.basic?.organization_name);
      return surnames.some((t) => words.has(t));
    });
  }
  return results;
}

// People who treat patients (not pharmacists, dentists, techs, nurses' aides…).
const TREATING_CRED_RE = /\b(M\.?D|D\.?O|N\.?P|APRN|ARNP|FNP|DNP|PA-?C|PA|AGACNP|ACNP|DPM|OD)\b/i;
const NOT_TREATING_TAX_RE = /pharmac|dentist|registered nurse|massage|mechanotherap|counselor|social worker|technician|behavior|case manag|dietitian|optician/i;

/** Edit distance with adjacent swaps counting as one typo ("Mortyko" ↔ "Morytko" = 1). */
function spellingDistance(a, b) {
  const x = String(a || '').toLowerCase().replace(/[^a-z]/g, '');
  const y = String(b || '').toLowerCase().replace(/[^a-z]/g, '');
  const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 1; j <= y.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[x.length][y.length];
}

function isTreating(r) {
  const tax = (r.taxonomies || []).map((t) => t.desc || '').join(' ');
  if (isNonProvider(r) || NOT_TREATING_TAX_RE.test(tax)) return false;
  return TREATING_CRED_RE.test(String(r.basic?.credential || ''))
    || /medicine|surgery|cardio|neuro|pediatr|psychiatr|oncolog|urolog|nephrolog|pulmonar|gastro|endocrin|rheumat|dermat|ophthal|orthop|family|internal|nurse practitioner|physician assistant/i.test(tax);
}

/**
 * No exact match for the name she gave? Find the closest real treating providers
 * instead of asking her for an NPI — including likely misspellings:
 * "John Mortyko" → John A Morytko, MD (one swapped letter). Candidates come from
 * the same last name, the same first name + first 3 letters, and the first 4
 * letters; they rank by spelling distance, same first name, nearest ZIP.
 * `spelling: true` marks a different spelling of the last name. A suggestion is
 * never used until she picks it.
 */
async function suggestSimilarProviders({ doctorName = '', zip, state = 'FL', limit = 3 } = {}) {
  const parsed = parseName(cleanDoctorQuery(doctorName));
  const last = String(parsed.lastName || '');
  if (last.replace(/[^A-Za-z]/g, '').length < 3) return [];
  const first = String(parsed.firstName || '');
  const queries = [{ last_name: last }];
  if (first) queries.push({ first_name: first, last_name: `${last.slice(0, 3)}*` });
  if (last.length >= 5) queries.push({ last_name: `${last.slice(0, 4)}*` });
  if (first && last.length >= 4) queries.push({ first_name: first, last_name: `${last.slice(0, 2)}*` });
  const seen = new Set();
  const found = [];
  for (const q of queries) {
    const p = new URLSearchParams({ version: '2.1', enumeration_type: 'NPI-1', state, limit: '200', ...q });
    const data = await fetchJSON(`${NPI_REGISTRY_BASE}?${p}`);
    for (const r of data?.results || []) {
      if (seen.has(r.number) || !isTreating(r)) continue;
      seen.add(r.number);
      found.push(r);
    }
  }
  const maxTypos = Math.max(2, Math.floor(last.replace(/[^A-Za-z]/g, '').length / 3));
  const qz = String(zip || '').slice(0, 3);
  const qf = first.toUpperCase();
  const scored = found.map((r) => {
    const candLast = String(r.basic?.last_name || '');
    const dist = Math.min(spellingDistance(last, candLast), spellingDistance(last, candLast.split(/[\s-]+/)[0]));
    const fn = String(r.basic?.first_name || '').toUpperCase();
    let s = 100 - dist * 30;
    if (qf && fn === qf) s += 60;
    else if (qf && fn[0] === qf[0]) s += 20;
    if (qz && locationZip(r).slice(0, 3) === qz) s += 25;
    if (/\b(MD|DO)\b/i.test(String(r.basic?.credential || '').replace(/\./g, ''))) s += 5;
    return { r, dist, s };
  }).filter((x) => x.dist <= maxTypos)
    // A different spelling only counts when the first name also agrees (or there is none).
    .filter((x) => x.dist === 0 || !qf || String(x.r.basic?.first_name || '').toUpperCase()[0] === qf[0]);
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map(({ r, dist }) => {
    const loc = (r.addresses || []).find((a) => a.address_purpose === 'LOCATION') || {};
    const b = r.basic || {};
    const name = [b.first_name, b.middle_name, b.last_name].filter(Boolean).join(' ').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
    return {
      name: `${name}${b.credential ? `, ${String(b.credential).replace(/\./g, '')}` : ''}`,
      npi: r.number,
      specialty: ((r.taxonomies || []).find((t) => t.primary) || (r.taxonomies || [])[0] || {}).desc || '',
      city: String(loc.city || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()),
      spelling: dist > 0,
    };
  });
}

module.exports = {
  suggestSimilarProviders,
  spellingDistance,
  cleanDoctorQuery,
  NPI_REGISTRY_BASE,
  extractNpi,
  parseName,
  locationZip,
  allLocationAddresses,
  rankScore,
  rankResults,
  isNonProvider,
  firstNameAgrees,
  lookupByNumber,
  lookupByName,
  lookupByOrganizationName,
  looksLikeOrganization,
  orgQueryVariants,
  displayName,
  formatClinicRecord,
  rankOrgScore,
  rankOrgResults,
  resolveNpiRecords,
};
