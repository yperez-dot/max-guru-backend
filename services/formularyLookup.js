/**
 * Plan-year formulary lookup (drug × contract-PBP).
 *
 * Daisy / paste / archive "Tier X" labels are discarded on entry. This module
 * never copies, quotes, or returns claimedTier. Lookup is the only source.
 *
 * Sources, in order:
 *   1. Sunfire /v2/drug/* when SUNFIRE_JWT is set (catalog + plan-scoped probes)
 *   2. Humana public FHIR MedicationKnowledge for Humana CMS IDs (H1036 / H7617)
 *      only when the PlanID extension matches this contract-PBP AND year
 *   3. Medicare.gov Plan Compare (autocomplete → RxNorm NDC → drugs/cost)
 *   4. Carrier consumer documents when the plan is not on Sunfire / missing
 *      on medicare.gov — Doctors 2027 formulary PDF first (H4140). See
 *      services/consumerFormulary.js. Never invent a tier.
 *
 * Cost-share after a verified tier comes from THEI Hub/grid knowledge
 * (2027 green cells in max-knowledge/carriers/*-plans-florida-2027.md),
 * not from the client's paste and not from Yahoska's finished-comp archive.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getKnowledgeByKey } = require('../knowledge/loader');
const { solisFormularyLookup, solisStrengthVariants, isSolisPlan } = require('./solisFormulary');
const { lookupConsumerFormulary } = require('./consumerFormulary');
const { doctorsPbpAliases, isDoctorsCms } = require('./doctorsFormularyPdf');
const { resolveDrugName, requestedForm, isNonOralForm, conceptHasForm, formLabel, drugNameBase, isEdDrug, edLabel, restrictionsKnownFor, restrictionsUnknown } = require('./drugNames');

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const HUMANA_FHIR = 'https://fhir.humana.com/api/MedicationKnowledge';
const MEDICARE_GOV_BASE = 'https://www.medicare.gov/api/v1/data/plan-compare';
const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const MPF_FE_VER = '2.69.0';
const PLAN_YEAR = 2027;
const MEDICARE_GOV_RETRY_DELAY_MS = Number(process.env.MEDICARE_GOV_RETRY_DELAY_MS || 700);
const FETCH_TIMEOUT_MS = 12_000;
const PUBLIC_HUMANA_DRUG_LIST = 'https://www.humana.com/pharmacy/medicare-drug-list';

const KB_2027_KEYS = [
  'carriers/humana-plans-florida-2027',
  'carriers/devoted-plans-florida-2027',
  'carriers/uhc-plans-florida-2027',
  'carriers/careplus-plans-florida-2027',
  'carriers/aetna-plans-florida-2027',
  'carriers/doctors-plans-florida-2027',
  'carriers/healthsun-plans-florida-2027',
  // These five carry the same "| Tier N | $X |" rows but were never read, so every Solis cell
  // showed a tier with no cost (Martin Wiesenthal, H0982-007, 2026-10-09).
  'carriers/solis-plans-florida-2027',
  'carriers/florida-blue-plans-florida-2027',
  'carriers/gold-kidney-plans-florida-2027',
  'carriers/simply-plans-florida-2027',
  'carriers/wellcare-plans-florida-2027',
];

let SUNFIRE_PLAN_MAP = {};
try {
  SUNFIRE_PLAN_MAP = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'sunfire-id-map.json'), 'utf8')
  );
} catch (_) {
  SUNFIRE_PLAN_MAP = {};
}

function sunfireHeaders() {
  const jwt = process.env.SUNFIRE_JWT || '';
  const sfp = process.env.SUNFIRE_SFP || '';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: SUNFIRE_BASE,
    Referer: `${SUNFIRE_BASE}/app/agent/yourmedicare/`,
    'User-Agent': 'Max-Medicare-Guru/1.0',
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (sfp) headers.Cookie = `sfp-cookie=${sfp}`;
  return headers;
}

function hasSunfireCreds() {
  return Boolean(process.env.SUNFIRE_JWT);
}

async function fetchJson(url, options = {}, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text, error: res.error };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    return { ok: false, status: 0, json: null, text: '', error: label };
  } finally {
    clearTimeout(timer);
  }
}

function parseCmsId(value) {
  const m = String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .match(/^(H\d{4}|R\d{4})-(\d{3})([A-Z])?/);
  if (!m) return null;
  const base = `${m[1]}-${m[2]}`;
  return { base, letter: m[3] || '', full: m[3] ? `${base}${m[3]}` : base };
}

function cmsIdsMatch(a, b) {
  const pa = parseCmsId(a);
  const pb = parseCmsId(b);
  return Boolean(pa && pb && pa.base === pb.base);
}

function displayPlanId(value) {
  return parseCmsId(value)?.full || String(value || '').replace(/\s+/g, '').toUpperCase();
}

function parseTierNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && raw >= 1 && raw <= 6) return raw;
  const m = String(raw).match(/(?:tier\s*)?([1-6])\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 6 ? n : null;
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function pickBool(obj, keys) {
  const v = pickFirst(obj, keys);
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

function walkObjects(node, acc = [], depth = 0) {
  if (!node || depth > 6) return acc;
  if (Array.isArray(node)) {
    node.slice(0, 40).forEach((item) => walkObjects(item, acc, depth + 1));
    return acc;
  }
  if (typeof node === 'object') {
    acc.push(node);
    Object.values(node).forEach((v) => {
      if (v && typeof v === 'object') walkObjects(v, acc, depth + 1);
    });
  }
  return acc;
}

function coverageFromObject(obj) {
  const tier = parseTierNumber(
    pickFirst(obj, [
      'tier',
      'drugTier',
      'formularyTier',
      'tierLevel',
      'tier_level',
      'Tier',
      'tierId',
      'drug_tier',
      'tierLevelValue',
      'formulary_tier',
    ])
  );
  const pa = pickBool(obj, [
    'priorAuth',
    'priorAuthorization',
    'pa',
    'PA',
    'prior_auth',
    'priorAuthorizationRequired',
    'prior_authorization',
  ]);
  const st = pickBool(obj, [
    'stepTherapy',
    'step_therapy',
    'st',
    'ST',
    'stepTherapyRequired',
    'step_therapy_required',
  ]);
  const ql = pickBool(obj, ['quantityLimit', 'quantity_limit', 'ql', 'QL', 'quantityLimitYn']);
  const coveredRaw = pickFirst(obj, ['covered', 'coverage', 'status', 'onFormulary', 'formularyStatus']);
  let coverage = null;
  if (coveredRaw !== undefined) {
    const s = String(coveredRaw).toLowerCase();
    if (s === 'true' || s === 'covered' || s === 'on-formulary' || s === 'onformulary') coverage = 'covered';
    else if (s === 'false' || s === 'not covered' || s === 'non-formulary' || s === 'notcovered') {
      coverage = 'not_covered';
    }
  }
  if (tier && !coverage) coverage = 'covered';
  return { tier, pa, st, ql, coverage };
}

function firstCoverageHit(payload) {
  for (const obj of walkObjects(payload)) {
    const hit = coverageFromObject(obj);
    if (hit.tier || hit.coverage === 'not_covered') return { ...hit, raw: obj };
  }
  return null;
}

/**
 * Plan year of a map entry, or null when it is not recorded.
 *
 * Do NOT infer the year from the id prefix. Sunfire ids are opaque sequence numbers: captures
 * from different plan years both contain ids beginning "26", and two captures that share 250
 * ids disagree on none of them. The year is a property of the endpoint the list came from
 * (`.../2026?…` vs `.../2027?…`), which only the builder knows (Yahoska, 2026-10-07).
 */
function sunfireEntryYear(sunfireId, entry) {
  const explicit = Number((entry && entry.year) || 0);
  return explicit > 2000 ? explicit : null;
}

/**
 * Map a CMS contract-PBP to its Sunfire plan id for that plan year.
 *
 * Matching used to search for the CMS id inside the marketing name, which only works for
 * carriers that print it (Humana). UHC, Aetna, Solis and Doctors never resolved, so Sunfire
 * was skipped for them entirely. Every entry carries `hRaw` (the contract) — match on that
 * plus the PBP instead, and fall back to the name only when the entry has no pbp recorded
 * (Yahoska, 2026-10-07).
 *
 * Returns null when the map holds no entry for that plan IN THAT YEAR — the caller must not
 * fall back to another year's id, or a 2027 comparison quotes 2026 tiers.
 */
function sunfireIdForPlan(planId, map = SUNFIRE_PLAN_MAP, year = null) {
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  const wantYear = Number(year) || null;
  const pbp = parsed.base.split('-')[1];
  // Entries recorded for the asked year are used first. Legacy entries carry no year at all,
  // so they are a last resort rather than a silent match for whatever year was asked.
  const all = Object.entries(map || {});
  const dated = all.filter(([id, e]) => sunfireEntryYear(id, e) === wantYear);
  const undated = all.filter(([id, e]) => sunfireEntryYear(id, e) === null);
  const entries = !wantYear ? all : dated.length ? dated : undated;

  const contractHits = entries.filter(
    ([, e]) => String(e.hRaw || '').toUpperCase() === parsed.base.split('-')[0]
  );
  // Contract + PBP is the real key. `pbp` is what the builder records; older hand-made
  // entries have none, so the marketing name is still read as a fallback.
  const byPbp = contractHits.filter(([, e]) => {
    const entryPbp = String(e.pbp || '').padStart(3, '0');
    if (entryPbp && entryPbp !== '000') return entryPbp === pbp;
    const name = String(e.planName || '').toUpperCase();
    return name.includes(parsed.full) || name.includes(parsed.base);
  });
  const exact = byPbp.find(([, e]) => {
    const name = String(e.planName || '').toUpperCase();
    return !parsed.letter || !name || name.includes(parsed.full);
  });
  if (exact) return exact[0];
  if (byPbp.length) return byPbp[0][0];

  // Last resort: the old name search, still scoped to the asked year.
  const fullHit = entries.find(([, e]) => String(e.planName || '').toUpperCase().includes(parsed.full));
  if (fullHit) return fullHit[0];
  const baseHits = entries.filter(([, e]) => String(e.planName || '').toUpperCase().includes(parsed.base));
  return baseHits[0] ? baseHits[0][0] : null;
}

/** Does the map hold any entry for this plan year at all? */
function sunfireMapHasYear(year, map = SUNFIRE_PLAN_MAP) {
  const y = Number(year) || 0;
  return Object.entries(map || {}).some(([id, e]) => sunfireEntryYear(id, e) === y);
}

/** True when the map records no plan year at all (the legacy hand-made file). */
function sunfireMapIsUndated(map = SUNFIRE_PLAN_MAP) {
  const v = Object.values(map || {});
  return v.length > 0 && v.every((e) => !(Number(e && e.year) > 2000));
}

function catalogDrugs(payload) {
  const data = payload || {};
  const list = data.drugs || data.results || data.data || (Array.isArray(data) ? data : []);
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => ({
      id: d.id || d.drugId || d.sunfireId || null,
      name: d.name || d.drugName || d.label || '',
      ndc: d.ndc || d.NDC || d.ndc11 || null,
      genericId: d.genericId || d.generic_id || null,
    }))
    .filter((d) => d.name || d.ndc);
}

const BAD_FORM_RE = /\b(inject(?:ion|able)?|intravenous|\biv\b|vial|kit|powder for|for solution|irrigation|topical|ophthalmic|otic|nasal|patch|suppositor)/i;

// Catalog-name abbreviations agents (and Max's own catalog hits) paste back:
// "Amlodipine Besy-Benazepril HCL" → "Amlodipine Besylate-Benazepril HCL".
const SALT_ABBREVIATIONS = [
  [/\bbesy\b\.?/gi, 'Besylate'],
  [/\bmal\b\.?/gi, 'Maleate'],
  [/\bsuccin\b\.?/gi, 'Succinate'],
  [/\btart\b\.?/gi, 'Tartrate'],
];

// Salt / form words that are not an active ingredient.
const NON_INGREDIENT_WORDS = new Set(
  'besy besylate hcl hydrochloride hbr hydrobromide sodium potassium calcium magnesium maleate mesylate succinate tartrate fumarate citrate sulfate acetate bromide phosphate hyclate monohydrate dihydrate trihydrate anhydrous oral tablet tablets tab tabs capsule capsules cap caps caplet caplets chewable solution suspension er xr xl sr dr cr la odt ec extended delayed immediate release hr mg mcg ml g unit units iu generic brand pen injector injection prefilled syringe kit'.split(' ')
);

/**
 * Active ingredients named in a drug string, in order:
 * "Amlodipine Besylate-Benazepril HCl 10-20 mg" → ["amlodipine", "benazepril"].
 */
function drugIngredients(raw) {
  const s = String(raw || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b\d+(?:\.\d+)?(?:\s*[-/]\s*\d+(?:\.\d+)?)*\s*(?:mg|mcg|µg|ug|g|ml|iu|units?|%)?(?:\s*\/\s*(?:ml|act|hr|h))?\b/g, ' ');
  const out = [];
  for (const part of s.split(/\s*(?:\/|\+|-|&|,|\band\b|\bwith\b)\s*/)) {
    const words = part.replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !NON_INGREDIENT_WORDS.has(w));
    if (!words.length) continue;
    const ing = words.join(' ');
    if (!out.includes(ing)) out.push(ing);
  }
  return out;
}

function ingredientWordMatch(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short);
}

/** Does catalog product `name` contain every ingredient of the query? */
function hasAllIngredients(name, queryIngredients) {
  const candWords = drugIngredients(name).join(' ').split(/\s+/).filter(Boolean);
  return queryIngredients.every((ing) => ing.split(/\s+/).every((w) => candWords.some((c) => ingredientWordMatch(w, c))));
}

/** Strip strength/dose/form so catalog search finds the molecule (e.g. "pregabalin 200 mg" → "pregabalin"). */
function drugCatalogQuery(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  for (const [re, full] of SALT_ABBREVIATIONS) s = s.replace(re, full);
  const stripped = s
    .replace(/\b\d+(?:\.\d+)?\s*(mg|mcg|µg|ug|g|ml|iu|units?)\b/gi, ' ')
    .replace(/\b(oral|tablet|tablets|capsule|capsules|caplets?|tabs?|caps?|er|xr|cr|dr|odt|solution|suspension|cream|gel|ointment|extended[- ]release|immediate[- ]release)\b/gi, ' ')
    .replace(/[(),/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || s.split(/\s+/)[0] || s;
}


function catalogScore(drug, query) {
  const name = String(drug.name || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();
  if (!name) return -100;
  let score = 0;
  // Combination products: every ingredient asked must be in the product
  // (amlodipine/benazepril must never resolve to amlodipine/valsartan), and a
  // single-ingredient ask prefers the plain product over combos.
  const qIngs = drugIngredients(q);
  const nIngs = drugIngredients(name);
  if (qIngs.length >= 2 && !hasAllIngredients(name, qIngs)) return -1000;
  if (qIngs.length && nIngs.length > qIngs.length) score -= 15;
  if (name === q) score += 100;
  const base = q.split(/\s+/)[0];
  if (base && name.startsWith(base)) score += 10;
  if (/\btab(let)?s?\b|oral tablet/.test(name)) score += 4;
  if (/\bcap(sule)?s?\b/.test(name)) score += 1;
  if (BAD_FORM_RE.test(name) && !BAD_FORM_RE.test(q)) score -= 20;
  for (const n of q.match(/\d+(?:\.\d+)?/g) || []) if (name.includes(n)) score += 3;
  return score;
}

/**
 * Catalog products for a query, best match first (oral tablet over injection, matching strength).
 * A combination ask drops products missing one of its ingredients — a wrong drug is worse than none.
 */
function rankCatalogMatches(drugs, query) {
  return (drugs || [])
    .map((d, i) => ({ d, i, s: catalogScore(d, query) }))
    .filter((x) => x.s > -1000)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.d);
}

function pickCatalogMatch(drugs, query) {
  if (!drugs || !drugs.length) return null;
  return rankCatalogMatches(drugs, query)[0] || null;
}

async function searchSunfireCatalog(name, fetchImpl = fetch) {
  if (!hasSunfireCreds() || !name) {
    return { drugs: [], error: hasSunfireCreds() ? null : 'sunfire_creds_missing', status: 0 };
  }
  const prefix = encodeURIComponent(String(name).toLowerCase().slice(0, 20));
  const res = await fetchJson(
    `${SUNFIRE_BASE}/v2/drug/search/${prefix}/-1`,
    { headers: sunfireHeaders() },
    fetchImpl
  );
  if (!res.ok) {
    // 401/403 means the Railway SUNFIRE_JWT expired — say so, do not let it look like
    // "drug not found" and silently fall back for the rest of AEP (Yahoska, 2026-10-07).
    const authFail = res.status === 401 || res.status === 403;
    return { drugs: [], error: authFail ? 'sunfire_session_expired' : (res.error || `sunfire_search_http_${res.status}`), status: res.status };
  }
  return { drugs: catalogDrugs(res.json), error: null, status: res.status };
}

async function lookupSunfireCoverage({ drug, planId, year, sunfirePlanId }, fetchImpl = fetch) {
  if (!hasSunfireCreds()) {
    return { verified: false, reason: 'sunfire_creds_missing', attempted: [] };
  }
  const y = Number(year) || PLAN_YEAR;
  // A Sunfire id from another plan year would answer with that year's tiers. Refuse it and
  // say why, instead of silently quoting 2026 numbers on a 2027 comparison.
  // Scoped to the asked year: an id from another plan year would answer with that year's
  // tiers. When the plan is unmapped the plan-scoped probes are simply skipped — the
  // drug-level ones still run — and the reason says which, instead of a bare "no tier".
  const sfId = sunfirePlanId || sunfireIdForPlan(planId, SUNFIRE_PLAN_MAP, y);
  const unmappedReason = sfId
    ? null
    : sunfireMapHasYear(y)
      ? 'sunfire_plan_not_mapped'
      : `sunfire_no_${y}_plan_ids`;
  const prefix = encodeURIComponent(String(drug?.name || '').toLowerCase().slice(0, 20));
  const drugId = drug?.id;
  const attempted = [];

  const attempts = [
    sfId && prefix
      ? { label: `GET /v2/drug/search/${prefix}/${sfId}`, method: 'GET', url: `${SUNFIRE_BASE}/v2/drug/search/${prefix}/${sfId}` }
      : null,
    sfId && prefix
      ? {
          label: `GET /v2/drug/search/${prefix}/${sfId}/${y}`,
          method: 'GET',
          url: `${SUNFIRE_BASE}/v2/drug/search/${prefix}/${sfId}/${y}`,
        }
      : null,
    drugId ? { label: `GET /v2/drug/${drugId}`, method: 'GET', url: `${SUNFIRE_BASE}/v2/drug/${drugId}` } : null,
    drugId && sfId
      ? { label: `GET /v2/drug/${drugId}/${sfId}`, method: 'GET', url: `${SUNFIRE_BASE}/v2/drug/${drugId}/${sfId}` }
      : null,
    drugId && sfId
      ? {
          label: 'POST /v2/drug/coverage',
          method: 'POST',
          url: `${SUNFIRE_BASE}/v2/drug/coverage`,
          body: { drugId, planId: sfId, year: y },
        }
      : null,
    drugId && sfId
      ? {
          label: 'POST /v2/drug/list',
          method: 'POST',
          url: `${SUNFIRE_BASE}/v2/drug/list`,
          body: { planId: sfId, year: y, drugId, drugs: [drugId] },
        }
      : null,
    drugId && sfId
      ? {
          label: `GET /v2/plan/${sfId}/drug/${drugId}`,
          method: 'GET',
          url: `${SUNFIRE_BASE}/v2/plan/${sfId}/drug/${drugId}?year=${y}`,
        }
      : null,
  ].filter(Boolean);

  const debug = process.env.FORMULARY_DEBUG === '1';
  for (const attempt of attempts) {
    attempted.push(attempt.label);
    const opts = { method: attempt.method, headers: sunfireHeaders() };
    if (attempt.body) opts.body = JSON.stringify(attempt.body);
    const res = await fetchJson(attempt.url, opts, fetchImpl);
    const hit = res.ok && res.json ? firstCoverageHit(res.json) : null;
    if (debug) {
      // Response body only (never our headers); long token-like strings are cut out.
      const snippet = String(res.text || res.error || '').replace(/\s+/g, ' ').replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]').slice(0, 160);
      const outcome = hit ? (hit.tier ? `tier ${hit.tier}` : hit.coverage || 'hit') : 'no tier';
      console.log(`[formulary-debug] sunfire ${displayPlanId(planId)} (${sfId || 'unmapped'}) ${attempt.label} → HTTP ${res.status || 0} ${outcome} | ${snippet || '(empty body)'}`);
    }
    if (!res.ok || !res.json) continue;
    if (!hit) continue;
    if (hit.coverage === 'not_covered') {
      return {
        verified: true,
        coverage: 'not_covered',
        tier: null,
        pa: hit.pa,
        st: hit.st,
        ql: hit.ql,
        source: `sunfire:${attempt.label}`,
        sunfirePlanId: sfId || null,
        attempted,
      };
    }
    if (hit.tier) {
      return {
        verified: true,
        coverage: 'covered',
        tier: hit.tier,
        pa: hit.pa,
        st: hit.st,
        ql: hit.ql,
        source: `sunfire:${attempt.label}`,
        sunfirePlanId: sfId || null,
        attempted,
      };
    }
  }

  return { verified: false, reason: unmappedReason || 'sunfire_no_tier', sunfirePlanId: sfId || null, attempted };
}

function fhirExtension(resource, fragment) {
  const list = resource?.extension || [];
  return list.find((ex) => String(ex.url || '').toLowerCase().includes(String(fragment).toLowerCase()));
}

function fhirTier(resource) {
  const ext = fhirExtension(resource, 'drugtierid');
  const coding = ext?.valueCodeableConcept?.coding?.[0];
  return parseTierNumber(coding?.code || coding?.display || ext?.valueString);
}

function fhirPlanId(resource) {
  const ext = fhirExtension(resource, 'planid');
  return ext?.valueString || ext?.valueCode || null;
}

function fhirBool(resource, fragment) {
  const ext = fhirExtension(resource, fragment);
  if (!ext) return null;
  if (typeof ext.valueBoolean === 'boolean') return ext.valueBoolean;
  return pickBool(ext, ['valueBoolean', 'valueString']);
}

function fhirName(resource) {
  return (
    resource?.code?.text ||
    resource?.code?.coding?.find((c) => c.display)?.display ||
    resource?.synonym?.[0] ||
    ''
  );
}

function fhirNdc(resource) {
  const coding = resource?.code?.coding || [];
  const ndc = coding.find((c) => /ndc/i.test(c.system || '') || /^\d{10,11}$/.test(c.code || ''));
  return ndc?.code || null;
}

function humanaPlanYearMatch(planExt, planId, year) {
  if (!planExt) return false;
  const parsed = parseCmsId(planId);
  if (!parsed) return false;
  const token = String(planExt).toUpperCase().replace(/\s+/g, '');
  const y = String(year || PLAN_YEAR);
  const hasPlan = token.includes(parsed.base.replace('-', '')) || token.includes(parsed.base);
  const hasYear = token.includes(y);
  return hasPlan && hasYear;
}

function isHumanaCms(planId) {
  const parsed = parseCmsId(planId);
  return Boolean(parsed && /^(H1036|H7617|H7284)$/.test(parsed.base.slice(0, 5)));
}

async function lookupHumanaFhir({ drugName, ndc, planId, year, strengthFrom = '' }, fetchImpl = fetch) {
  if (!isHumanaCms(planId)) {
    return { verified: false, reason: 'not_humana' };
  }
  const y = Number(year) || PLAN_YEAR;
  const headers = {
    Accept: 'application/fhir+json, application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; Max-Medicare-Guru/1.0)',
  };
  const queries = [];
  if (ndc) queries.push(`${HUMANA_FHIR}?code=${encodeURIComponent(String(ndc).replace(/-/g, ''))}`);
  if (ndc && String(ndc).includes('-')) queries.push(`${HUMANA_FHIR}?code=${encodeURIComponent(ndc)}`);
  if (drugName) queries.push(`${HUMANA_FHIR}?name=${encodeURIComponent(drugName)}`);

  let lastError = null;
  for (const url of queries) {
    const res = await fetchJson(url, { headers }, fetchImpl, 8_000);
    if (!res.ok) {
      lastError = res.error || `humana_fhir_http_${res.status}`;
      continue;
    }
    const entries = res.json?.entry || [];
    const matched = [];
    for (const entry of entries) {
      const resource = entry.resource;
      if (!resource || resource.resourceType !== 'MedicationKnowledge') continue;
      const planExt = fhirPlanId(resource);
      if (!humanaPlanYearMatch(planExt, planId, y)) continue;
      const tier = fhirTier(resource);
      const pa = fhirBool(resource, 'priorauthorization');
      const st = fhirBool(resource, 'steptherapy');
      const ql = fhirBool(resource, 'quantitylimit');
      matched.push({
        tier,
        pa,
        st,
        ql,
        planExt,
        name: fhirName(resource),
        ndc: fhirNdc(resource),
      });
    }
    // A name search returns one MedicationKnowledge per product: keep each strength's answer
    // instead of only the first one that had a tier.
    const byStrength = new Map();
    for (const m of matched.filter((x) => x.tier)) {
      const st = conceptProductTraits(m.name).strengths[0];
      const s = st ? `${Number(st.value)} ${st.unit}` : null;
      if (s && !byStrength.has(s)) byStrength.set(s, { strength: s, verified: true, coverage: 'covered', tier: m.tier, pa: m.pa, st: m.st, ql: m.ql, source: 'humana_fhir' });
    }
    const strengthVariants = byStrength.size > 1 ? [...byStrength.values()] : null;
    // A strength she typed picks that product, not the first one returned.
    const askedStrength = queryProductHints(strengthFrom || drugName).strengths[0];
    const forAsked = askedStrength && matched.find((m) => m.tier && conceptProductTraits(m.name).strengths.some((s) => sameStrength(s, askedStrength)));
    const withTier = forAsked || matched.find((m) => m.tier);
    if (withTier) {
      return {
        ...(strengthVariants && !askedStrength ? { strengthVariants } : {}),
        verified: true,
        coverage: 'covered',
        tier: withTier.tier,
        pa: withTier.pa,
        st: withTier.st,
        ql: withTier.ql,
        source: 'humana_fhir',
        fhirPlanId: withTier.planExt,
        drugName: withTier.name || drugName,
        ndc: withTier.ndc || ndc || null,
      };
    }
    if (matched.length) {
      return {
        verified: false,
        reason: 'humana_fhir_no_tier',
        source: 'humana_fhir',
      };
    }
    if (entries.length) {
      return {
        verified: false,
        reason: 'humana_fhir_no_pbp_year_match',
        source: 'humana_fhir',
        note: 'Humana FHIR returned formulary rows but none matched this contract-PBP + year. Not verified for this plan.',
      };
    }
  }

  return { verified: false, reason: lastError || 'humana_fhir_empty' };
}

function medicareGovHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': MPF_FE_VER,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

/**
 * Akamai 403s Node/undici and Node https POSTs to drugs/cost.
 * curl and Python urllib (stdlib) succeed. Railway Node images often lack
 * curl, and a missing binary used to resolve as status 0 → medicare_gov_http_0.
 * Try curl, then python3 urllib. Do not fall back to Node TLS.
 * Tests inject fetchImpl and never hit this path unless they call it directly.
 */
const PYTHON_URLLIB = `
import json, sys, urllib.error, urllib.request
req = json.load(sys.stdin)
headers = {str(k): str(v) for k, v in (req.get("headers") or {}).items() if v is not None}
data = req.get("body")
body = data.encode("utf-8") if data else None
r = urllib.request.Request(req["url"], data=body, headers=headers, method=req.get("method") or "GET")
try:
    with urllib.request.urlopen(r, timeout=float(req.get("timeout") or 20)) as resp:
        print(json.dumps({"status": int(resp.status), "text": resp.read().decode("utf-8", "replace")}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": int(e.code), "text": e.read().decode("utf-8", "replace")}))
except Exception as e:
    print(json.dumps({"status": 0, "text": "", "error": str(e)}))
`;

function fetchLike(status, text, error) {
  return {
    ok: status >= 200 && status < 300,
    status,
    error: error || undefined,
    text: async () => text,
  };
}

function spawnOnce(bin, args, { stdin = null, timeoutMs = 22_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      const missing = err && (err.code === 'ENOENT' || /ENOENT/.test(err.message || ''));
      done({ ok: false, status: 0, text: '', error: missing ? `${bin}_missing` : err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      done({ ok: true, status: 0, text: out, error: null });
    });
    try {
      if (stdin != null) child.stdin.write(stdin);
      child.stdin.end();
    } catch (_) {
      /* ignore — ENOENT already handled on error */
    }
  });
}

function curlBin() {
  return process.env.MEDICARE_GOV_CURL || 'curl';
}

function pythonBins() {
  if (process.env.MEDICARE_GOV_PYTHON) return [process.env.MEDICARE_GOV_PYTHON];
  return ['python3', 'python'];
}

async function curlFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const args = ['-sS', '-X', method, '--max-time', '20', '-w', '\n__HTTPSTATUS__:%{http_code}'];
  Object.entries(headers).forEach(([key, value]) => {
    if (value != null) args.push('-H', `${key}: ${value}`);
  });
  if (options.body) args.push('--data-binary', String(options.body));
  args.push(String(url));
  const spawned = await spawnOnce(curlBin(), args);
  if (spawned.error) return fetchLike(0, '', spawned.error);
  const match = spawned.text.match(/\n__HTTPSTATUS__:(\d+)\s*$/);
  const status = match ? Number(match[1]) : 0;
  const text = match ? spawned.text.slice(0, match.index) : spawned.text;
  return fetchLike(status, text, status ? undefined : 'curl_no_status');
}

async function pythonUrllibFetch(url, options = {}) {
  const payload = JSON.stringify({
    url: String(url),
    method: String(options.method || 'GET').toUpperCase(),
    headers: options.headers || {},
    body: options.body != null ? String(options.body) : '',
    timeout: 20,
  });
  let last = fetchLike(0, '', 'python_missing');
  for (const bin of pythonBins()) {
    const spawned = await spawnOnce(bin, ['-c', PYTHON_URLLIB], { stdin: payload });
    if (spawned.error) {
      last = fetchLike(0, '', spawned.error);
      continue;
    }
    try {
      const parsed = JSON.parse(String(spawned.text || '').trim() || '{}');
      const status = Number(parsed.status) || 0;
      last = fetchLike(status, parsed.text || '', parsed.error);
      if (status > 0 || last.ok) return last;
      if (parsed.error && !/_missing$/.test(String(parsed.error))) return last;
    } catch (err) {
      last = fetchLike(0, '', err.message || 'python_bad_output');
    }
  }
  return last;
}

async function medicareGovFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'POST') return fetch(url, options);
  const curl = await curlFetch(url, options);
  if (curl.ok) return curl;
  const py = await pythonUrllibFetch(url, options);
  if (py.ok || py.status > 0) return py;
  if (curl.status > 0) return curl;
  return fetchLike(0, '', 'medicare_gov_transport_unavailable');
}

function cmsContractParts(planId) {
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  const [contractId, pbp] = parsed.base.split('-');
  return { contractId, planId: pbp, segmentId: '0' };
}

function relatedRxnormConcepts(payload) {
  const groups = payload?.relatedGroup?.conceptGroup || [];
  const out = [];
  for (const group of groups) {
    for (const c of group.conceptProperties || []) {
      out.push({
        rxcui: String(c.rxcui || ''),
        name: c.name || '',
        tty: group.tty || c.tty || '',
      });
    }
  }
  return out.filter((c) => c.rxcui);
}

/**
 * What product the agent asked for: strength(s), tablet vs capsule, and
 * release type. RxNorm's related.json returns EVERY strength, form, and brand
 * for an ingredient, and brand / ER / ODT products are often non-formulary
 * while the plain generic is covered (Klonopin vs clonazepam, Lyrica CR vs
 * pregabalin capsule). Those must never decide coverage for a generic ask.
 */
function queryProductHints(query) {
  const q = String(query || '').toLowerCase();
  const strengths = [];
  const re = /(\d+(?:\.\d+)?)\s*(mg|mcg|g|unit|units|meq|%)\b/g;
  let m;
  while ((m = re.exec(q))) strengths.push({ value: m[1], unit: m[2] });
  let form = null;
  if (/\b(tab|tabs|tablet|tablets)\b/.test(q)) form = 'tablet';
  else if (/\b(cap|caps|capsule|capsules)\b/.test(q)) form = 'capsule';
  else form = requestedForm(q);
  return {
    strengths,
    form,
    er: /\b(er|xr|xl|cr|sr|la|extended|24\s*h(?:r|our)?|12\s*h(?:r|our)?)\b/.test(q),
    dr: /\b(dr|delayed|ec|enteric)\b/.test(q),
    odt: /\b(odt|disintegrat\w*)\b/.test(q),
    words: q.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean),
  };
}

function conceptProductTraits(name) {
  const n = String(name || '').toLowerCase();
  const strengths = [];
  // "20 MG/ML" is a concentration (oral solution), not a 20 mg dose: "pregabalin 20 mg" must not
  // match pregabalin 20 MG/ML Oral Solution (Katy, 2026-10-07).
  const re = /(\d+(?:\.\d+)?)\s*(mg|mcg|g|unit|units|meq|%)\b(?!\s*\/\s*(?:ml|actuat))/g;
  let m;
  while ((m = re.exec(n))) strengths.push({ value: m[1], unit: m[2] });
  const brand = (n.match(/\[([^\]]+)\]\s*$/) || [])[1] || null;
  let form = null;
  if (/\btablet\b/.test(n)) form = 'tablet';
  else if (/\bcapsule\b/.test(n)) form = 'capsule';
  else form = ['ointment', 'cream', 'gel', 'lotion', 'drops', 'patch'].find((f) => conceptHasForm(n, f)) || null;
  return {
    strengths,
    form,
    er: /extended release|\b24 hr\b|\b12 hr\b/.test(n),
    dr: /delayed release/.test(n),
    odt: /disintegrating/.test(n),
    brand,
  };
}

/**
 * The asked strength matches none of the products this lookup returned (pregabalin "20 mg" — likely
 * 200 mg). Only those products were checked, so this is "couldn't match", never "does not exist".
 * Returns the closest strengths found (×10 / ÷10 typos first), or null when it matches.
 */
function missingStrengthCheck(query, concepts) {
  const hints = queryProductHints(query);
  if (!hints.strengths.length) return null;
  const real = [];
  for (const c of concepts || []) {
    for (const t of conceptProductTraits(c && c.name).strengths) {
      if (!real.some((r) => sameStrength(r, t))) real.push(t);
    }
  }
  if (!real.length) return null;
  const missing = hints.strengths.filter((h) => !real.some((t) => sameStrength(h, t)));
  if (!missing.length) return null;
  const asked = missing[0];
  const v = Number(asked.value);
  const same = real.filter((t) => t.unit === asked.unit).sort((a, b) => Number(a.value) - Number(b.value));
  const typo = same.filter((t) => [v * 10, v / 10, v * 100].includes(Number(t.value)));
  const near = [...same].sort((a, b) => Math.abs(Number(a.value) - v) - Math.abs(Number(b.value) - v));
  const nearest = [];
  for (const t of [...typo, ...near]) if (!nearest.some((n) => sameStrength(n, t)) && nearest.length < 3) nearest.push(t);
  const fmt = (t) => `${t.value} ${t.unit}`;
  return { asked: fmt(asked), nearest: nearest.map(fmt), available: same.map(fmt) };
}

/** Query with the strength removed — the drug-level fallback for a strength that could not be matched. */
function withoutStrength(query) {
  return String(query || '').replace(/(\d+(?:\.\d+)?)\s*(mg|mcg|g|unit|units|meq|%)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

function sameStrength(a, b) {
  return Number(a.value) === Number(b.value) && a.unit === b.unit;
}

/**
 * True when an RxNorm concept is the product the agent asked for. Anything
 * not stated in the query (no strength, no form) does not disqualify.
 */
function conceptMatchesQuery(concept, query) {
  const hints = queryProductHints(query);
  const traits = conceptProductTraits(concept && concept.name);
  if (hints.strengths.length) {
    if (!traits.strengths.length) return false;
    if (!hints.strengths.every((h) => traits.strengths.some((t) => sameStrength(h, t)))) return false;
  }
  if (hints.form && traits.form && hints.form !== traits.form) return false;
  // An ointment / cream / drops ask is only ever that form — never the oral product.
  if (isNonOralForm(hints.form) && traits.form !== hints.form) return false;
  if (hints.er !== traits.er) return false;
  if (hints.odt !== traits.odt) return false;
  if (hints.dr && !traits.dr) return false;
  if (traits.brand) {
    const brandWords = traits.brand.toLowerCase().split(/\s+/);
    if (!brandWords.every((w) => hints.words.includes(w))) return false;
  }
  return true;
}

function scoreRelatedConcept(concept, query) {
  const name = String(concept.name || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();
  const hints = queryProductHints(q);
  const traits = conceptProductTraits(name);
  let score = 0;
  if (!hints.form && /oral tablet/.test(name)) score += 20;
  // No form asked: the adult oral capsule is as likely as the tablet (esomeprazole Rx is the DR
  // capsule), and pediatric granules / suspensions / injections are the least likely product.
  if (!hints.form && /oral capsule/.test(name)) score += 15;
  if (!/granule|suspension|solution|inject/.test(q) && /granules|for oral suspension|\binjection\b|oral solution/.test(name)) score -= 15;
  // An unrequested salt variant ("esomeprazole strontium") is a different product.
  const prefix = name.split(/\s\d/)[0].split(/\s+/);
  if (q && prefix.length > 1 && prefix.slice(1).some((w) => w.length > 3 && !q.includes(w))) score -= 10;
  if (/oral/.test(name)) score += 5;
  if (/(amlodipine|ezetimibe|caduet|vytorin)/.test(name) && !/(amlodipine|ezetimibe)/.test(q)) {
    score -= 40;
  }
  if (q && name.includes(q)) score += 10;
  if (q && new RegExp(`${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+ mg oral tablet`).test(name)) {
    score += 25;
  }
  if (concept.tty === 'SCD' && /generic|statin|pril|sartan|olol/.test(q)) score += 5;
  if (concept.tty === 'SBD' && /trintellix|lipitor|eliquis|jardiance|ozempic/.test(q)) score += 8;

  // Product fit: strength, tablet vs capsule, ER / DR / ODT, brand vs generic.
  if (hints.strengths.length && traits.strengths.length) {
    const hit = hints.strengths.every((h) => traits.strengths.some((t) => sameStrength(h, t)));
    score += hit ? 30 : -30;
  }
  if (hints.form && traits.form) score += hints.form === traits.form ? 15 : -20;
  if (hints.er !== traits.er) score -= 35;
  else if (hints.er) score += 10;
  if (hints.odt !== traits.odt) score -= 35;
  if (hints.dr && !traits.dr) score -= 15;
  if (traits.brand) {
    const brandWords = traits.brand.toLowerCase().split(/\s+/);
    if (!brandWords.every((w) => hints.words.includes(w))) score -= 25;
  }
  if (conceptMatchesQuery(concept, q)) score += 20;
  return score;
}

function rankNdcs(ndcs) {
  return [...ndcs].sort((a, b) => {
    const score = (n) => {
      const s = String(n);
      if (/30$/.test(s)) return 3;
      if (/90$/.test(s)) return 2;
      if (/07$/.test(s)) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
}

function normalizeNdc(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `0${digits}`;
  if (digits.length === 11) return digits;
  return digits || null;
}

async function autocompleteMedicareGov(name, fetchImpl = fetch) {
  if (!name) return { drugs: [], error: 'medicare_gov_no_name', status: 0 };
  const res = await fetchJson(
    `${MEDICARE_GOV_BASE}/drugs/autocomplete?name=${encodeURIComponent(String(name).trim())}`,
    { headers: medicareGovHeaders() },
    fetchImpl
  );
  if (!res.ok) {
    return { drugs: [], error: res.error || `medicare_gov_autocomplete_http_${res.status}`, status: res.status };
  }
  const list = res.json?.drugs || [];
  return { drugs: Array.isArray(list) ? list : [], error: null, status: res.status };
}

const ndcLabelCache = new Map();

/** "HUMAN OTC DRUG" / "HUMAN PRESCRIPTION DRUG" for an NDC (RxNav), or null when unknown. */
async function ndcLabelType(ndc, fetchImpl = fetch) {
  if (ndcLabelCache.has(ndc)) return ndcLabelCache.get(ndc);
  const res = await fetchJson(`${RXNORM_BASE}/ndcproperties.json?id=${encodeURIComponent(ndc)}`, { headers: { Accept: 'application/json' } }, fetchImpl, 6_000);
  const props = res.json?.ndcPropertyList?.ndcProperty?.[0]?.propertyConceptList?.propertyConcept || [];
  const label = (Array.isArray(props) ? props : []).find((p) => p && p.propName === 'LABEL_TYPE');
  const value = label ? String(label.propValue || '').toUpperCase() : null;
  if (res.ok) ndcLabelCache.set(ndc, value);
  return value;
}

/**
 * Drop OTC NDCs: Part D does not cover OTC products, and medicare.gov answers them with empty
 * costs. Esomeprazole 20 mg DR tablets are all store-brand OTC (Nexium 24HR); the Rx product is the
 * DR capsule (Martin Wiesenthal, 2026-10-09). Unknown label types are kept.
 */
async function rxNdcsOnly(ndcs, fetchImpl = fetch) {
  const labels = await Promise.all(ndcs.map((n) => ndcLabelType(n, fetchImpl).catch(() => null)));
  return { rx: ndcs.filter((n, i) => labels[i] !== 'HUMAN OTC DRUG'), otc: ndcs.filter((n, i) => labels[i] === 'HUMAN OTC DRUG') };
}

async function ndcsForRxcui(rxcui, fetchImpl = fetch) {
  if (!rxcui) return [];
  const res = await fetchJson(
    `${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`,
    { headers: { Accept: 'application/json' } },
    fetchImpl
  );
  const list = res.json?.ndcGroup?.ndcList?.ndc || [];
  return Array.isArray(list) ? list.map((n) => normalizeNdc(n)).filter(Boolean) : [];
}

// Extra exact-product NDCs asked when the first ones come back empty (not in medicare.gov's drug file).
const MEDICARE_GOV_EXTRA_NDC_PROBES = 24;
const MEDICARE_GOV_PROBE_BATCH = 4;

async function resolveMedicareGovNdcs({ drugName, ndc, hintNdc }, fetchImpl = fetch) {
  const out = [];
  const exact = new Set();
  const seen = new Set();
  const moreExact = [];
  // NDC → the RxNorm product it belongs to, so products that disagree at one strength are seen.
  const ndcConcept = {};
  const push = (value, isExact, concept = null) => {
    const n = normalizeNdc(value);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
    if (isExact) exact.add(n);
    if (concept) ndcConcept[n] = concept;
  };
  // An NDC the agent typed is the product by definition.
  if (ndc) push(ndc, true);
  const askedForm = requestedForm(drugName);

  const medicareQuery = drugCatalogQuery(drugName) || drugName || '';
  let auto = await autocompleteMedicareGov(medicareQuery, fetchImpl);
  if (!(auto.drugs || []).length && drugName && medicareQuery && medicareQuery !== drugName) {
    auto = await autocompleteMedicareGov(String(drugName).split(/\s+/)[0] || medicareQuery, fetchImpl);
  }
  const match = pickCatalogMatch(
    (auto.drugs || []).map((d) => ({ name: d.name, rxcui: d.rxcui, id: d.rxcui })),
    drugName || medicareQuery
  );
  // No fallback to the first autocomplete hit when it is a different combination
  // (asked amlodipine/benazepril, first hit amlodipine/valsartan).
  const comboAsk = drugIngredients(drugName || medicareQuery).length >= 2;
  const fallback = comboAsk ? null : auto.drugs?.[0] || null;
  const rxcui = match?.rxcui || fallback?.rxcui || null;
  const resolvedName = match?.name || fallback?.name || medicareQuery || drugName;
  let query = drugName || resolvedName;
  let strengthNote = null;

  if (rxcui) {
    const rel = await fetchJson(
      `${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=SCD+SBD`,
      { headers: { Accept: 'application/json' } },
      fetchImpl
    );
    // Every candidate — including the autocomplete concept — is ranked by how
    // well it fits the asked product. Brand / ER / ODT / wrong strength sink.
    const candidates = [{ rxcui: String(rxcui), name: resolvedName, tty: '' }, ...relatedRxnormConcepts(rel.json)];
    let dedup = [];
    for (const c of candidates) if (!dedup.some((d) => d.rxcui === c.rxcui)) dedup.push(c);
    // A single-ingredient ask is never a combination product: "esomeprazole" read not covered from
    // esomeprazole/naproxen (Vimovo) NDCs that counted as the asked product (Martin, 2026-10-09).
    const askIngredients = Math.max(1, drugIngredients(drugCatalogQuery(query) || query).length);
    // RxNorm writes combinations as "A 20 MG / B 375 MG …"; "0.05 MG/MG" (no spaces) is one strength.
    const conceptIngredients = (name) => (String(name || '').match(/\s\/\s(?=[a-z])/gi) || []).length + 1;
    dedup = dedup.filter((c) => conceptIngredients(c.name) <= askIngredients);
    // A typed strength is the ordinary product unless she asked for PAH: "tadalafil 20 mg" priced
    // on "Pulmonary Hypertension tadalafil 20 MG" (NDC 13668-0581-30) read T4 on H1019-001, where
    // plain tadalafil 20 mg is not covered (Martin Wiesenthal staging run, 2026-10-09).
    const pahProduct = (c) => /pulmonary hypertension|\(pah\)/i.test(c.name);
    if (/\b(?:pah|pulmonary)\b/i.test(query)) {
      // She asked for the PAH product: only that one, when RxNorm has it.
      if (dedup.some(pahProduct)) dedup = dedup.filter(pahProduct);
    } else if (queryProductHints(query).strengths.length) {
      dedup = dedup.filter((c) => !pahProduct(c));
    }
    // Ointment / cream / gel / drops / patch: only products of that form. No oral fallback.
    if (isNonOralForm(askedForm)) {
      const eye = /\b(?:eye|ophthalmic|ophth)\b/i.test(query);
      let ofForm = dedup.filter((c) => conceptHasForm(c.name, askedForm));
      const sameRoute = ofForm.filter((c) => /\bophthalmic\b/i.test(c.name) === eye);
      if (sameRoute.length) ofForm = sameRoute;
      if (!ofForm.length) {
        return { strengthNote: null, ndcs: [], moreExactNdcs: [], exactNdcs: [], rxcui: String(rxcui), name: resolvedName, error: 'form_not_found' };
      }
      dedup = ofForm;
    }
    // A strength no product has (typo): confirm at drug level and say so, never "unverified".
    strengthNote = missingStrengthCheck(query, dedup);
    if (strengthNote) query = withoutStrength(query);
    let sorted = dedup
      .map((c, i) => ({ ...c, i, score: scoreRelatedConcept(c, query), exact: conceptMatchesQuery(c, query) }))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.i - b.i);
    // No form asked: the best product of each form first (tablet, capsule, …), so one form's
    // "not covered" never decides a drug the plan covers in another form.
    if (!queryProductHints(query).form) {
      const firstOfForm = [];
      const seenForms = new Set();
      for (const c of sorted) {
        const f = conceptProductTraits(c.name).form || 'other';
        if (c.score > 0 && !seenForms.has(f)) { seenForms.add(f); firstOfForm.push(c); }
      }
      sorted = [...firstOfForm, ...sorted.filter((c) => !firstOfForm.includes(c))];
    }
    const toTry = sorted.slice(0, 8);
    const otcOnly = [];
    for (const concept of toTry) {
      const ranked = rankNdcs(await ndcsForRxcui(concept.rxcui, fetchImpl));
      // A product whose first NDCs are all OTC is the OTC product (esomeprazole 20 mg DR tablet).
      const head = ranked.slice(0, 6);
      const { rx, otc } = head.length ? await rxNdcsOnly(head, fetchImpl) : { rx: [], otc: [] };
      if (head.length && !rx.length) {
        otcOnly.push(...otc.slice(0, 2).map((n) => ({ n, exact: concept.exact })));
        continue;
      }
      const all = [...rx, ...ranked.slice(6)];
      all.slice(0, 3).forEach((n) => push(n, concept.exact, concept));
      // medicare.gov only prices the NDCs in its own drug file: most RxNorm NDCs for a generic
      // answer with empty drug_costs (pregabalin 200 mg on H1036-065C: 13668-0363-30, 46708-0124-30
      // and 50228-0355-30 are all empty, while 00904-7003-04 reads Tier 3). Keep the rest of the
      // exact product's NDCs so the lookup can keep asking (Katy, 2026-10-07).
      if (concept.exact) all.slice(3).forEach((n) => { const k = normalizeNdc(n); if (k && !seen.has(k) && !moreExact.includes(k)) moreExact.push(k); });
      if (out.length >= 8) break;
    }
    // Only OTC products exist for this ask: price them (they will read not covered / empty) rather than nothing.
    if (!out.length) otcOnly.forEach(({ n, exact: e }) => push(n, e));
  }

  // A catalog NDC (Sunfire's first hit) is a hint, never the asked product: duloxetine 30 mg
  // resolved to a 40 mg NDC and read "not covered" (2026-10-07). Never for a non-oral form ask —
  // the catalog hit is usually the oral product.
  if (hintNdc && out.length < 8 && !isNonOralForm(askedForm)) push(hintNdc, false);
  const ndcs = out.slice(0, 8);
  return {
    strengthNote,
    ndcs,
    moreExactNdcs: moreExact.filter((n) => !ndcs.includes(n)).slice(0, MEDICARE_GOV_EXTRA_NDC_PROBES),
    exactNdcs: ndcs.filter((n) => exact.has(n)),
    ndcConcepts: Object.fromEntries(ndcs.filter((n) => ndcConcept[n]).map((n) => [n, { rxcui: ndcConcept[n].rxcui, name: ndcConcept[n].name }])),
    rxcui: rxcui ? String(rxcui) : null,
    name: resolvedName || drugName,
    error: out.length ? null : auto.error || 'medicare_gov_no_ndc',
  };
}

const strengthVariantCache = new Map();

/**
 * Every oral strength of a drug priced on every plan in ONE medicare.gov request (it takes many
 * NDCs × many plans). No strength asked + tiers that differ by strength must not collapse to one
 * cell: tadalafil on H1019-001 is T4 at 5 mg and not covered at 2.5/10/20 mg; on H5431-006 10/20 mg
 * are T6 and listed in excluded_drugs (supplemental) (2026-10-09).
 * medicare.gov returns no per-NDC PA/ST/QL (restrictions comes back empty), so variants carry tier,
 * coverage and supplemental status only. Returns { [planId]: variants[] } or null.
 */
async function medicareGovStrengthVariants({ drugName, planIds, year }, fetchImpl = medicareGovFetch) {
  const y = Number(year) || PLAN_YEAR;
  const plans = (planIds || []).map((id) => ({ id, parts: cmsContractParts(id) })).filter((p) => p.parts);
  if (!plans.length || !drugName) return null;
  const key = `${String(drugName).toLowerCase()}|${y}|${plans.map((p) => p.id).sort().join(',')}`;
  if (strengthVariantCache.has(key)) return strengthVariantCache.get(key);
  const hints = queryProductHints(drugName);
  const query = drugCatalogQuery(drugName) || drugName;
  const auto = await autocompleteMedicareGov(query, fetchImpl);
  const match = pickCatalogMatch((auto.drugs || []).map((d) => ({ name: d.name, rxcui: d.rxcui, id: d.rxcui })), query);
  if (!match || !match.rxcui) return null;
  const rel = await fetchJson(`${RXNORM_BASE}/rxcui/${encodeURIComponent(match.rxcui)}/related.json?tty=SCD`, { headers: { Accept: 'application/json' } }, fetchImpl);
  // Same product family the agent means: single ingredient, oral tablet / capsule, release type as asked.
  const groups = new Map();
  for (const c of relatedRxnormConcepts(rel.json)) {
    if ((String(c.name).match(/\s\/\s(?=[a-z])/gi) || []).length) continue;
    const t = conceptProductTraits(c.name);
    if (!['tablet', 'capsule'].includes(t.form) || t.er !== hints.er || t.odt !== hints.odt || t.brand) continue;
    if (hints.form && t.form !== hints.form) continue;
    if (t.strengths.length !== 1) continue;
    const s = `${Number(t.strengths[0].value)} ${t.strengths[0].unit}`;
    // RxNorm names some products by indication ("Pulmonary Hypertension tadalafil 20 MG Oral
    // Tablet", the Adcirca/Alyq generic): its own variant, never folded into the plain 20 mg.
    const indication = /^pulmonary hypertension\b/i.test(c.name) ? 'PAH' : null;
    const gk = `${s}|${indication || ''}`;
    if (!groups.has(gk)) groups.set(gk, { strength: s, indication, concepts: [] });
    groups.get(gk).concepts.push(c);
  }
  if (groups.size < 2) { strengthVariantCache.set(key, null); return null; }
  const byStrength = [];
  for (const g of [...groups.values()].slice(0, 7)) {
    // NDCs from each product at this strength (2 apiece), so products that disagree are seen.
    const picked = [];
    for (const c of g.concepts.slice(0, 2)) {
      const { rx } = await rxNdcsOnly(rankNdcs(await ndcsForRxcui(c.rxcui, fetchImpl)).slice(0, 4), fetchImpl);
      picked.push(...rx.slice(0, g.concepts.length > 1 ? 2 : 3));
    }
    if (picked.length) byStrength.push({ strength: g.strength, indication: g.indication, ndcs: picked });
  }
  if (byStrength.length < 2) { strengthVariantCache.set(key, null); return null; }
  const res = await fetchJson(`${MEDICARE_GOV_BASE}/drugs/cost`, {
    method: 'POST',
    headers: medicareGovHeaders(),
    body: JSON.stringify({
      npis: [],
      prescriptions: byStrength.flatMap((b) => b.ndcs).map((ndc) => ({ ndc, quantity: '30', frequency: 'FREQUENCY_30_DAYS' })),
      lis: 'LIS_NO_HELP',
      full_year: false,
      retailOnly: false,
      plans: plans.map((p) => ({ contract_id: p.parts.contractId, plan_id: p.parts.planId, segment_id: p.parts.segmentId, contract_year: String(y) })),
    }),
  }, fetchImpl, 20_000);
  if (!res.ok || !res.json) return null;
  const out = {};
  for (const p of plans) {
    const row = (res.json.plans || []).find((x) => {
      const pl = x.plan || x;
      return String(pl.contract_id || '').toUpperCase() === p.parts.contractId && String(pl.plan_id || '') === p.parts.planId;
    });
    if (!row) continue;
    const excluded = JSON.stringify(row.excluded_drugs || []);
    const answers = new Map();
    for (const cost of row.costs || []) for (const dc of cost.drug_costs || []) answers.set(normalizeNdc(dc.ndc), dc);
    const variants = [];
    for (const b of byStrength) {
      const dcs = b.ndcs.map((n) => answers.get(n)).filter(Boolean);
      const covered = dcs.find((d) => d.covered !== false && parseTierNumber(d.tier));
      const notCovered = dcs.find((d) => d.covered === false || /NOT_COVERED|NON_FORMULARY|NOT_IN_FORMULARY/i.test(String(d.coverage_reason || '')));
      // Same strength, different products disagree (tadalafil 20 mg: PAH generics covered, ED generics
      // not; or one tier vs another): say "varies by product", never pick one.
      const tiers = new Set(dcs.filter((d) => d.covered !== false && parseTierNumber(d.tier)).map((d) => parseTierNumber(d.tier)));
      const mixed = (covered && notCovered) || tiers.size > 1;
      if (covered) {
        variants.push({ strength: b.strength, ...(b.indication ? { indication: b.indication } : {}), verified: true, coverage: 'covered', tier: parseTierNumber(covered.tier), pa: null, st: null, ql: null,
          ...(excluded.includes(String(covered.ndc)) ? { excludedDrug: true } : {}), ...(mixed ? { mixedProducts: true } : {}), source: 'medicare_gov' });
      } else if (notCovered) {
        variants.push({ strength: b.strength, ...(b.indication ? { indication: b.indication } : {}), verified: true, coverage: 'not_covered', tier: null, source: 'medicare_gov' });
      }
    }
    out[displayPlanId(p.id)] = variants;
  }
  strengthVariantCache.set(key, out);
  return out;
}

/** True when a drug's strengths differ in coverage, tier, PA, supplemental status or indication. */
function strengthsDiffer(variants) {
  const keys = new Set((variants || []).map((v) => `${v.coverage}|${v.tier}|${v.pa === true}|${v.excludedDrug === true}|${v.indication || ''}|${v.mixedProducts === true}`));
  return keys.size > 1;
}

function extractMedicareGovCost(payload, planId, year) {
  const parts = cmsContractParts(planId);
  if (!parts) return { miss: 'bad_plan_id' };
  const y = String(year);
  const plans = payload?.plans || [];
  const row = plans.find((p) => {
    const pl = p.plan || p;
    return (
      String(pl.contract_id || '').toUpperCase() === parts.contractId &&
      String(pl.plan_id || '') === parts.planId &&
      String(pl.contract_year || '') === y
    );
  });
  if (!row) return { miss: 'plan_mismatch' };
  const blob = JSON.stringify(row.restrictions || []);
  const pa = /prior\s*auth/i.test(blob) ? true : null;
  const st = /step\s*ther/i.test(blob) ? true : null;
  const ql = /quantity/i.test(blob) ? true : null;
  // A Part D-excluded drug the plan pays for as a supplemental benefit is listed in
  // excluded_drugs. An empty list does not prove Part D coverage, so only `true` is ever said.
  const excluded = Array.isArray(row.excluded_drugs) ? row.excluded_drugs : [];
  const excludedFor = (ndc) => (excluded.length && ndc && JSON.stringify(excluded).includes(String(ndc)) ? true : null);
  for (const cost of row.costs || []) {
    for (const dc of cost.drug_costs || []) {
      const reason = String(dc.coverage_reason || '').toUpperCase();
      const tier = parseTierNumber(dc.tier);
      if (dc.covered === false || reason === 'NOT_COVERED' || reason === 'NON_FORMULARY') {
        return { coverage: 'not_covered', tier: null, pa, st, ql, ndc: dc.ndc || null };
      }
      if (tier) {
        return { coverage: 'covered', tier, pa, st, ql, ndc: dc.ndc || null, excludedDrug: excludedFor(dc.ndc) };
      }
    }
  }
  return { miss: 'empty_costs' };
}

async function lookupMedicareGov({ drugName, ndc, hintNdc, planId, year }, fetchImpl = medicareGovFetch) {
  const y = Number(year) || PLAN_YEAR;
  const parts = cmsContractParts(planId);
  if (!parts) return { verified: false, reason: 'medicare_gov_bad_plan_id', source: 'medicare_gov' };

  const resolved = await resolveMedicareGovNdcs({ drugName, ndc, hintNdc }, fetchImpl);
  if (!resolved.ndcs.length) {
    return {
      verified: false,
      reason: resolved.error || 'medicare_gov_no_ndc',
      source: 'medicare_gov',
    };
  }

  // One NDC reading "not covered" does not decide coverage: RxNorm hands back
  // brand, ER, ODT and other-strength products too. Try every candidate; the
  // asked-for product (exact) wins, covered beats not covered.
  const exactSet = new Set(resolved.exactNdcs || []);
  const build = (hit, useNdc, extra = {}) => ({
    verified: true,
    coverage: hit.coverage,
    tier: hit.coverage === 'covered' ? hit.tier : null,
    pa: hit.pa,
    st: hit.st,
    ql: hit.ql,
    excludedDrug: hit.excludedDrug || null,
    source: 'medicare_gov',
    ndc: hit.ndc || useNdc,
    rxcui: resolved.rxcui,
    drugName: resolved.name || drugName,
    ...(resolved.strengthNote ? { strengthNote: resolved.strengthNote } : {}),
    ...extra,
  });
  let lastError = null;
  let exactNotCovered = null;
  let otherCovered = null;
  let otherNotCovered = null;
  const askCostOnce = (useNdc) => fetchJson(
      `${MEDICARE_GOV_BASE}/drugs/cost`,
      {
        method: 'POST',
        headers: medicareGovHeaders(),
        body: JSON.stringify({
          npis: [],
          prescriptions: [{ ndc: useNdc, quantity: '30', frequency: 'FREQUENCY_30_DAYS' }],
          lis: 'LIS_NO_HELP',
          full_year: false,
          retailOnly: false,
          plans: [
            {
              contract_id: parts.contractId,
              plan_id: parts.planId,
              segment_id: parts.segmentId,
              contract_year: String(y),
            },
          ],
        }),
      },
      fetchImpl,
      15_000
    );
  // medicare.gov drops or throttles some answers when a whole client's meds are priced at once
  // (Gail's Devoted and Aetna columns, all 7 meds, 2026-10-08). One retry before giving up on an NDC.
  const askCost = async (useNdc) => {
    let res = await askCostOnce(useNdc);
    if (!res.ok || !res.json) {
      await new Promise((r) => setTimeout(r, MEDICARE_GOV_RETRY_DELAY_MS));
      res = await askCostOnce(useNdc);
    }
    return res;
  };
  // Products that match the ask at the same strength (different RxNorm products) must agree:
  // "covered beats not covered" would hide that one of them is not covered.
  const concepts = resolved.ndcConcepts || {};
  const strengthKey = (n) => {
    const c = concepts[n];
    return c ? conceptProductTraits(c.name).strengths.map((s) => `${Number(s.value)}${s.unit}`).sort().join('+') : null;
  };
  const answeredByConcept = new Map();
  const mixedWith = async (useNdc) => {
    const c = concepts[useNdc];
    if (!c) return false;
    const key = strengthKey(useNdc);
    const others = new Map();
    for (const n of resolved.exactNdcs || []) {
      const oc = concepts[n];
      if (oc && oc.rxcui !== c.rxcui && strengthKey(n) === key && !others.has(oc.rxcui)) others.set(oc.rxcui, n);
    }
    for (const [rxcui, n] of others) {
      let cov = answeredByConcept.get(rxcui);
      if (cov === undefined) {
        const r = await askCost(n);
        const h = r.ok && r.json ? extractMedicareGovCost(r.json, planId, y) : {};
        cov = h.coverage || null;
      }
      if (cov === 'not_covered') return true;
    }
    return false;
  };
  let emptyExact = 0;
  for (const useNdc of resolved.ndcs.slice(0, 8)) {
    const isExact = exactSet.has(useNdc);
    // Once the exact product read not covered, only another exact NDC can change that.
    if (exactNotCovered && !isExact) continue;
    const res = await askCost(useNdc);
    if (!res.ok || !res.json) {
      lastError = res.error || `medicare_gov_http_${res.status}`;
      continue;
    }
    const hit = extractMedicareGovCost(res.json, planId, y);
    if (concepts[useNdc] && hit.coverage) answeredByConcept.set(concepts[useNdc].rxcui, hit.coverage);
    if (hit.coverage === 'covered' && hit.tier) {
      if (isExact) return build(hit, useNdc, (await mixedWith(useNdc)) ? { mixedProducts: true } : {});
      if (!otherCovered) otherCovered = { hit, useNdc };
      continue;
    }
    if (hit.coverage === 'not_covered') {
      if (isExact) exactNotCovered = exactNotCovered || { hit, useNdc };
      else otherNotCovered = otherNotCovered || { hit, useNdc };
      continue;
    }
    lastError = hit.miss ? `medicare_gov_${hit.miss}` : 'medicare_gov_no_tier';
    if (isExact && hit.miss === 'empty_costs') emptyExact += 1;
  }

  // The asked product's first NDCs were not in medicare.gov's drug file (empty drug_costs):
  // keep asking its other NDCs, a few at a time, until one answers. A sibling product never
  // answers for it (Katy, pregabalin on H1036-065C 2027, 2026-10-07).
  const more = resolved.moreExactNdcs || [];
  if (more.length && (emptyExact || exactNotCovered || !exactSet.size)) {
    for (let i = 0; i < more.length; i += MEDICARE_GOV_PROBE_BATCH) {
      const batch = more.slice(i, i + MEDICARE_GOV_PROBE_BATCH);
      const answers = await Promise.all(batch.map(async (useNdc) => {
        const res = await askCost(useNdc);
        return { useNdc, hit: res.ok && res.json ? extractMedicareGovCost(res.json, planId, y) : { miss: 'http' } };
      }));
      const covered = answers.find((a) => a.hit.coverage === 'covered' && a.hit.tier);
      if (covered) return build(covered.hit, covered.useNdc);
      // One repackager NDC reading not covered does not decide it while others may still answer.
      const notCovered = answers.find((a) => a.hit.coverage === 'not_covered');
      if (notCovered && !exactNotCovered) exactNotCovered = notCovered;
      if (exactNotCovered && i + MEDICARE_GOV_PROBE_BATCH >= 12) break;
    }
  }

  if (exactNotCovered) return build(exactNotCovered.hit, exactNotCovered.useNdc);
  if (otherCovered) {
    // No exact NDC answered; a sibling product (same ingredient) is covered.
    return build(otherCovered.hit, otherCovered.useNdc, { productNote: 'closest_product' });
  }
  if (otherNotCovered) {
    // Only brand / other-strength / other-release NDCs read not covered —
    // that says nothing about the generic the agent asked for.
    return { verified: false, reason: 'medicare_gov_only_other_products_not_covered', source: 'medicare_gov' };
  }
  return { verified: false, reason: lastError || 'medicare_gov_no_tier', source: 'medicare_gov' };
}

function costSharePlanCandidates(planId, year) {
  const parsed = parseCmsId(planId);
  if (!parsed) return [];
  const out = [parsed.full, parsed.base];
  if (Number(year) === 2027 && isDoctorsCms(planId)) {
    for (const alias of doctorsPbpAliases(parsed.base, year)) out.push(alias);
  }
  return [...new Set(out.map((id) => String(id).toUpperCase()))];
}

/**
 * Grid / KB tier cost-shares arrive in mixed shapes: "$0", "33%", but also bare "0", "5",
 * "0.33" (HealthSun's rows), which rendered as "T1 0" and "T5 0.33" (Yahoska, 2026-10-07).
 * A bare decimal under 1 is a coinsurance rate; any other bare number is dollars.
 */
function formatCostShare(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/[$%]/.test(s)) return s;
  if (!/^\d*\.?\d+$/.test(s)) return s;
  const num = Number(s);
  if (!Number.isFinite(num)) return s;
  if (num > 0 && num < 1) return `${Math.round(num * 1000) / 10}%`;
  return `$${s.replace(/^\./, '0.')}`;
}

function costShareFromKnowledge(planId, year, tier) {
  if (!tier || Number(year) !== 2027) return null;
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  const candidates = costSharePlanCandidates(planId, year);
  for (const key of KB_2027_KEYS) {
    const doc = getKnowledgeByKey(key);
    if (!doc) continue;
    const sections = doc.split(/^## /m);
    const hits = sections.filter((s) => {
      const upper = s.toUpperCase();
      return candidates.some((id) => upper.includes(id)) && /\|\s*Tier\s*1\s*\|/i.test(s);
    });
    const re = new RegExp(`\\|\\s*Tier\\s*${tier}\\s*\\|\\s*([^|]+)\\|`, 'i');
    for (const hit of hits) {
      const m = hit.match(re);
      if (!m) continue;
      const value = m[1].trim();
      if (!value) continue;
      return { value: formatCostShare(value), source: 'kb_2027', knowledgeKey: key };
    }
  }
  return null;
}

function costShareFromPlanObject(plan, tier) {
  if (!plan || !tier) return null;
  const key = `tier${tier}`;
  const raw = plan[key];
  if (raw === undefined || raw === null || raw === '') return null;
  return { value: formatCostShare(raw), source: 'plan_data' };
}

/** sunfire | humana_fhir | medicare_gov | solis_pdf | consumer_pdf | none — the debug line's source names. */
function debugSourceName(source) {
  const s = String(source || '');
  if (!s) return 'none';
  if (/^sunfire/i.test(s)) return 'sunfire';
  if (/humana_fhir/i.test(s)) return 'humana_fhir';
  if (/medicare_gov/i.test(s)) return 'medicare_gov';
  if (/solis/i.test(s)) return 'solis_pdf';
  return 'consumer_pdf';
}

/**
 * FORMULARY_DEBUG=1: one line per drug per plan — what she typed, what it resolved to, which
 * source answered, and the cell it produced. Off by default.
 */
function logFormularyDebug(result, inputName, nameRxcui) {
  if (process.env.FORMULARY_DEBUG !== '1' || !result) return;
  for (const row of result.lookups || []) {
    const rxcui = row.rxcui || nameRxcui || '?';
    const status = (row.verified ? `verified_${row.coverage || 'covered'}` : `unverified:${row.reason || 'unverified'}`)
      + (row.sunfireReason ? ` (sunfire: ${row.sunfireReason})` : '');
    const parts = [];
    if (row.verified && row.tier) parts.push(`T${row.tier}`);
    if (row.verified && row.coverage === 'not_covered') parts.push('not covered');
    if (row.verified && row.tier) parts.push(row.costShare ? `cost ${row.costShare}` : 'cost n/a');
    if (restrictionsUnknown(row)) parts.push('PA/QL ?');
    if (row.edLabel) parts.push(row.edLabel);
    if (Array.isArray(row.strengths) && row.strengths.length > 1) parts.push(`by strength: ${row.strengths.map((v) => `${v.strength}${v.indication ? ` (${v.indication})` : ''}=${v.coverage === 'not_covered' ? 'not covered' : `T${v.tier}${v.costShare ? ` ${v.costShare}` : ''}${v.pa ? ' PA' : ''}${v.excludedDrug ? ' supplemental' : ''}${v.mixedProducts ? ' varies-by-product' : ''}`}`).join(', ')}`);
    if (result.nameCheck) parts.push(result.nameCheck.suggestion ? `did you mean ${result.nameCheck.suggestion}?` : 'name not found');
    console.log(`[formulary-debug] ${row.planId} | ${inputName || result.drugName} → ${result.drugName} (${rxcui}) | source=${debugSourceName(row.source)} | status=${status} | result=${parts.join(' · ') || '—'}`);
  }
}

function emptyPlanResult(planId, year, reason) {
  return {
    planId: displayPlanId(planId),
    year: Number(year) || PLAN_YEAR,
    verified: false,
    tier: null,
    coverage: null,
    pa: null,
    st: null,
    ql: null,
    costShare: null,
    costShareSource: null,
    source: null,
    reason: reason || 'unverified',
  };
}

/** Known brand → generic names only. Never attach a tier here. */
const BRAND_TO_GENERIC = {
  lipitor: 'Atorvastatin',
  benicar: 'Olmesartan',
  crestor: 'Rosuvastatin',
  zocor: 'Simvastatin',
  pravachol: 'Pravastatin',
  nexium: 'Esomeprazole',
  prilosec: 'Omeprazole',
  protonix: 'Pantoprazole',
  plavix: 'Clopidogrel',
  norvasc: 'Amlodipine',
  cozaar: 'Losartan',
  diovan: 'Valsartan',
  lyrica: 'Pregabalin',
  xanax: 'Alprazolam',
  klonopin: 'Clonazepam',
  ativan: 'Lorazepam',
  valium: 'Diazepam',
  synthroid: 'Levothyroxine',
  wellbutrin: 'Bupropion',
  elavil: 'Amitriptyline',
  zoloft: 'Sertraline',
  lexapro: 'Escitalopram',
  neurontin: 'Gabapentin',
};

function brandKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function knownGenericFor(drugName) {
  const key = brandKey(drugName);
  if (!key) return null;
  if (BRAND_TO_GENERIC[key]) return BRAND_TO_GENERIC[key];
  const stripped = key.replace(/generic$/, '');
  return BRAND_TO_GENERIC[stripped] || null;
}

function brandVerifiedNotCovered(lookups) {
  return (lookups || []).some((row) => row && row.verified && row.coverage === 'not_covered');
}

function starBrandName(name) {
  const s = String(name || '').replace(/\*+$/, '').trim();
  return s ? `${s}*` : name;
}

/**
 * Look up one drug against one or more plans.
 * claimedTier is accepted for API compatibility and discarded immediately.
 */
async function lookupFormulary(
  {
    drugName = '',
    ndc = '',
    planId = '',
    planIds = [],
    year = PLAN_YEAR,
    claimedTier = null,
    plans = [],
    skipGenericFollowup = false,
    skipNameCheck = false,
  } = {},
  fetchImpl = fetch
) {
  const y = Number(year) || PLAN_YEAR;
  void claimedTier;
  const ids = [...(planId ? [planId] : []), ...(Array.isArray(planIds) ? planIds : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const uniqueIds = [];
  for (const id of ids) {
    if (!uniqueIds.some((u) => cmsIdsMatch(u, id))) uniqueIds.push(id);
  }

  // Which drug did she type? RxNorm generic / ingredient names first — never a medicare.gov
  // autocomplete prefix hit ("rasuvostatin" → "Rasuvo", methotrexate). An unclear name is
  // asked about, not priced.
  const inputName = String(drugName || '').trim();
  let nameCorrection = null;
  let nameRxcui = null;
  if (inputName && !ndc && !skipNameCheck) {
    const nameCheck = await resolveDrugName(inputName, fetchImpl);
    nameRxcui = nameCheck.rxcui || null;
    if (nameCheck.status === 'ambiguous' || nameCheck.status === 'not_found') {
      console.log(`[formulary] name not priced: "${inputName}" ${nameCheck.status}${nameCheck.suggestion ? ` (did you mean ${nameCheck.suggestion}?)` : ''}`);
      const rows = uniqueIds.map((id) => emptyPlanResult(id, y, 'name_unconfirmed'));
      const unresolved = {
        drugName: inputName,
        inputName,
        ndc: null,
        year: y,
        claimedTier: null,
        claimedTierDiscarded: true,
        catalog: [],
        catalogError: null,
        lookups: rows,
        byPlanId: Object.fromEntries(rows.map((r) => [r.planId, r])),
        verifiedAny: false,
        nameCheck: { status: nameCheck.status, input: inputName, suggestion: nameCheck.suggestion || null, alternatives: nameCheck.alternatives || [] },
      };
      logFormularyDebug(unresolved, inputName, null);
      return unresolved;
    }
    if (nameCheck.status === 'corrected') {
      nameCorrection = { from: drugNameBase(inputName), to: nameCheck.name };
      drugName = nameCheck.query;
    }
  }

  const rawQuery = drugName || ndc;
  // Ointment / cream / gel / drops / patch asks are priced only on a product of that form.
  const askedForm = requestedForm(rawQuery);
  const nonOral = isNonOralForm(askedForm);
  const catalogQuery = drugCatalogQuery(rawQuery) || rawQuery;
  let catalog = await searchSunfireCatalog(catalogQuery, fetchImpl);
  // If the agent pasted strength/form and the stripped query still missed, try the first token.
  if (!catalog.drugs.length && catalogQuery && catalogQuery.includes(' ')) {
    const token = catalogQuery.split(/\s+/)[0];
    if (token && token !== catalogQuery) {
      const retry = await searchSunfireCatalog(token, fetchImpl);
      if (retry.drugs.length) catalog = retry;
    }
  }
  if (!catalog.drugs.length && rawQuery && catalogQuery && catalogQuery !== rawQuery) {
    // last resort: original string (keeps prior behavior for odd names)
    const retryRaw = await searchSunfireCatalog(rawQuery, fetchImpl);
    if (retryRaw.drugs.length) catalog = retryRaw;
  }
  let ranked = rankCatalogMatches(catalog.drugs, rawQuery);
  if (nonOral) ranked = ranked.filter((d) => conceptHasForm(d.name, askedForm));
  let match = ranked[0] || null;
  let resolvedName = match?.name || drugCatalogQuery(rawQuery) || rawQuery || 'Unknown drug';
  let resolvedNdc = ndc || match?.ndc || null;

  let byPlanId = {};
  let lookups = [];

  if (!uniqueIds.length) {
    return {
      drugName: resolvedName,
      ndc: resolvedNdc,
      year: y,
      claimedTier: null,
      claimedTierDiscarded: true,
      catalog: catalog.drugs.slice(0, 10),
      catalogError: catalog.error,
      lookups: [],
      byPlanId,
      verifiedAny: false,
    };
  }

  // No strength asked: every strength's answer, so tiers that differ by strength are shown, not one picked.
  const askedStrengths = queryProductHints(rawQuery).strengths;
  const splitWanted = !ndc && !nonOral && !askedStrengths.length;
  const mgovVariants = splitWanted
    ? medicareGovStrengthVariants(
      { drugName: rawQuery, planIds: uniqueIds.filter((id) => !isSolisPlan(id)), year: y },
      fetchImpl === fetch ? medicareGovFetch : fetchImpl
    ).catch(() => null)
    : Promise.resolve(null);

  async function lookupPlans(match, resolvedName, resolvedNdc) {
    const byPlanId = {};
    const lookups = [];
    for (const id of uniqueIds) {
      const planObj = (plans || []).find((p) => cmsIdsMatch(p.planId || p.id, id));
      let hit = null;
      const reasons = [];

      // Non-oral form with no catalog product of that form: Sunfire would price the oral one.
      // Why Sunfire did not answer is kept even when a later source does (it was lost before).
      let sunfireReason = null;
      if (!nonOral || match) {
        const sunfire = await lookupSunfireCoverage(
          { drug: match || { name: resolvedName, ndc: resolvedNdc }, planId: id, year: y },
          fetchImpl
        );
        if (sunfire.verified) hit = sunfire;
        else if (sunfire.reason && sunfire.reason !== 'sunfire_creds_missing') {
          reasons.push(sunfire.reason);
          sunfireReason = sunfire.reason;
        }
      }

      // Humana FHIR, Solis and the consumer PDFs answer by drug name only — they cannot tell an
      // ointment from a tablet, so a non-oral form never takes their answer.
      if (!nonOral && (!hit || !hit.verified)) {
        const fhir = await lookupHumanaFhir(
          { drugName: resolvedName, ndc: resolvedNdc, planId: id, year: y, strengthFrom: rawQuery },
          fetchImpl
        );
        if (fhir.verified) hit = fhir;
        else if (fhir.reason && fhir.reason !== 'not_humana') reasons.push(fhir.reason);
      }

      if (!hit || !hit.verified) {
        const medicareFetch = fetchImpl === fetch ? medicareGovFetch : fetchImpl;
        // medicare.gov gets the product the agent asked for (strength / form / ER), not the Sunfire
        // catalog's bare name, and only an NDC the agent typed counts as that exact product.
        const mpf = await lookupMedicareGov(
          { drugName: medicareGovQueryName(rawQuery, resolvedName), ndc: ndc || null, hintNdc: ndc ? null : resolvedNdc, planId: id, year: y },
          medicareFetch
        );
        if (mpf.verified) hit = mpf;
        else if (mpf.reason) reasons.push(mpf.reason);
      }

      // Solis has no API Max can call — its published 2027 formulary PDF index answers instead.
      if (!nonOral && (!hit || !hit.verified)) {
        // A typed strength must reach the book ("tadalafil 10 mg" is its own row).
        const solis = solisFormularyLookup(askedStrengths.length ? rawQuery : resolvedName, id, y);
        if (solis) hit = solis;
      }

      if (!nonOral && (!hit || !hit.verified)) {
        const consumer = await lookupConsumerFormulary(
          { drugName: resolvedName, ndc: resolvedNdc, planId: id, year: y },
          fetchImpl
        );
        if (consumer.verified) hit = consumer;
        else if (consumer.reason && consumer.reason !== 'not_doctors' && consumer.reason !== 'no_consumer_source') {
          reasons.push(consumer.reason);
        }
      }

      const displayId = displayPlanId(id);
      if (hit && hit.verified) {
        const share =
          costShareFromKnowledge(id, y, hit.tier) ||
          (y === 2026 ? costShareFromPlanObject(planObj, hit.tier) : null);
        const row = {
          planId: displayId,
          year: y,
          verified: true,
          tier: hit.tier || null,
          coverage: hit.coverage || (hit.tier ? 'covered' : null),
          pa: hit.pa,
          st: hit.st,
          ql: hit.ql,
          ...(hit.excludedDrug ? { excludedDrug: true } : {}),
          ...(hit.indication ? { indication: hit.indication } : {}),
          ...(hit.mixedProducts ? { mixedProducts: true } : {}),
          ...(hit.rxcui ? { rxcui: String(hit.rxcui) } : {}),
          costShare: share ? share.value : null,
          costShareSource: share ? share.source : null,
          source: hit.source,
          reason: null,
          formularyPlanId: hit.formularyPlanId || null,
          ...(hit.strengthNote ? { strengthNote: hit.strengthNote } : {}),
          ...(hit.qlText ? { qlText: hit.qlText } : {}),
          restrictionsKnown: restrictionsKnownFor(hit),
          ...(sunfireReason && !/^sunfire/.test(String(hit.source || '')) ? { sunfireReason } : {}),
        };
        // Strengths that differ (tier / coverage / PA / supplemental): keep every one for the cell.
        if (splitWanted) {
          let variants = null;
          if (isSolisPlan(id)) variants = solisStrengthVariants(drugCatalogQuery(rawQuery) || rawQuery, id, y, askedForm);
          else if (hit.strengthVariants) variants = hit.strengthVariants;
          else variants = ((await mgovVariants) || {})[displayId] || null;
          if (variants && variants.length > 1 && strengthsDiffer(variants)) {
            row.strengths = variants.map((v) => {
              const vs = v.coverage === 'covered' ? costShareFromKnowledge(id, y, v.tier) : null;
              return { ...v, costShare: vs ? vs.value : null, restrictionsKnown: restrictionsKnownFor(v) };
            });
          }
        }
        byPlanId[displayId] = row;
        lookups.push(row);
      } else {
        // Railway logs: why a med could not be priced on a plan (nothing else shows it).
        console.log(`[formulary] ${displayId} ${resolvedName} ${y} unverified: ${reasons.join('|') || (hit && hit.reason) || catalog.error || 'unverified'}`);
        const row = {
          ...emptyPlanResult(id, y, reasons.join('|') || (hit && hit.reason) || catalog.error || 'unverified'),
          note: hit && hit.note ? hit.note : undefined,
        };
        byPlanId[displayId] = row;
        lookups.push(row);
      }
    }
    return { byPlanId, lookups };
  }

  ({ byPlanId, lookups } = await lookupPlans(match, resolvedName, resolvedNdc));

  // One odd catalog product (injection, capsule, different strength) can read
  // "not covered" everywhere for a drug every formulary carries (levothyroxine,
  // HCTZ). Before saying not covered, retry the next best products.
  let retriedProduct = null;
  let notCoveredNote = null;
  const allNotCovered = (rows) => rows.length > 0 && rows.every((r) => r.verified && r.coverage === 'not_covered');
  if (!ndc && allNotCovered(lookups) && !knownGenericFor(drugName)) {
    const base = String(drugName || '').toLowerCase().split(/\s+/)[0];
    const alternates = ranked
      .slice(1)
      .filter((d) => String(d.name || '').toLowerCase().startsWith(base) && d.name !== match?.name)
      .slice(0, 2);
    for (const alt of alternates) {
      const tryRun = await lookupPlans(alt, alt.name, alt.ndc || null);
      if (tryRun.lookups.some((r) => r.verified && r.coverage !== 'not_covered')) {
        retriedProduct = { from: resolvedName, to: alt.name };
        match = alt;
        resolvedName = alt.name;
        resolvedNdc = alt.ndc || null;
        ({ byPlanId, lookups } = tryRun);
        break;
      }
    }
    if (!retriedProduct) {
      notCoveredNote = `"${resolvedName}" read not covered on every plan, including ${alternates.length} other catalog product(s). Confirm the exact product/strength in Sunfire before telling the client — most formularies cover the common generic.`;
    }
  }

  // Part D excludes ED drugs, but a plan can still cover them: look them up like any other drug,
  // then say what the answer means (supplemental / BPH-PAH only / not covered / not confirmed).
  const edDrug = isEdDrug(rawQuery) || isEdDrug(resolvedName);
  if (edDrug) {
    for (const row of lookups) row.edLabel = edLabel(row);
  }

  // One row per asked form: "acyclovir tablets" and "acyclovir ointment" are two products, and
  // the meds table must not fold them into one "acyclovir" row.
  const label = askedForm ? formLabel(askedForm, rawQuery) : '';
  const namesForm = /\b(?:tabs?|tablets?|caps?|capsules?|ointment|cream|gel|lotion|drops?|patch|solution|suspension)\b/i.test(String(resolvedName));
  const withForm = label && !namesForm ? `${resolvedName} ${label}` : resolvedName;
  // A typed strength stays in the row name: the catalog says "Rosuvastatin Calcium", she typed
  // 10 mg — the agent must see that the 10 mg product was priced (staging, 2026-10-09).
  const typedStrengths = queryProductHints(rawQuery).strengths.map((s) => `${Number(s.value)} ${s.unit}`);
  const nameHasStrength = (s) => new RegExp(`\\b${s.split(' ')[0].replace('.', '\\.')}\\s*${s.split(' ')[1]}\\b`, 'i').test(String(withForm));
  const missing = typedStrengths.filter((s) => !nameHasStrength(s));
  const displayName = missing.length ? `${withForm} ${missing.join('/')}` : withForm;

  const result = {
    drugName: displayName,
    inputName: inputName || null,
    ndc: resolvedNdc,
    year: y,
    claimedTier: null,
    claimedTierDiscarded: true,
    catalog: catalog.drugs.slice(0, 10),
    catalogError: catalog.error,
    lookups,
    byPlanId,
    verifiedAny: lookups.some((l) => l.verified),
    suggestedGeneric: null,
    genericFollowup: null,
    retriedProduct,
    notCoveredNote,
    ...(nameCorrection ? { nameCorrection } : {}),
    ...(edDrug ? { edDrug: true } : {}),
    ...(askedForm ? { form: askedForm } : {}),
  };

  logFormularyDebug(result, inputName, nameRxcui);

  const genericName = knownGenericFor(drugName) || knownGenericFor(resolvedName);
  if (!skipGenericFollowup && genericName && brandVerifiedNotCovered(lookups)) {
    const generic = await lookupFormulary(
      {
        drugName: genericName,
        planIds: uniqueIds,
        year: y,
        plans,
        skipGenericFollowup: true,
        skipNameCheck: true,
      },
      fetchImpl
    );
    result.suggestedGeneric = genericName;
    result.genericFollowup = generic;
  }

  return result;
}

/** The agent's own words when they carry the product (strength / form / release) the catalog name dropped. */
function medicareGovQueryName(rawQuery, resolvedName) {
  const raw = String(rawQuery || '').trim();
  if (!raw || /^\d[\d-]*$/.test(raw)) return resolvedName;
  const a = queryProductHints(raw);
  const b = queryProductHints(resolvedName);
  const rawCarries = a.strengths.length > b.strengths.length || (a.form && !b.form) || (a.er && !b.er) || (a.dr && !b.dr) || (a.odt && !b.odt);
  return rawCarries ? raw : resolvedName;
}

function strengthNoteText(drugName, note) {
  if (!note) return '';
  // Only the products this lookup returned were checked, so never say a strength "does not exist".
  const name = String(drugName || 'this drug').replace(/\s*\d.*$/, '').toLowerCase();
  const near = note.nearest.length ? ` Closest strengths found: ${note.nearest.join(', ')}.` : '';
  return `STRENGTH NOT MATCHED: Couldn't match ${name} ${note.asked} on medicare.gov — confirm it.${near} The tier below is drug-level only, not confirmed for ${note.asked}.`;
}

function flagLine(label, value) {
  if (value === true) return label;
  if (value === false) return `no ${label}`;
  return null;
}

function formatPlanLookupLine(drugName, row) {
  if (row.verified && row.coverage === 'not_covered') {
    return `FORMULARY_LOOKUP year=${row.year} drug=${drugName.replace(/\s+/g, '_')} plan=${row.planId} verified_tier=none coverage=not_covered source=${row.source || 'unknown'}`;
  }
  if (row.verified && row.tier) {
    const extra = [
      row.costShare ? `cost_share=${String(row.costShare).replace(/\s+/g, '')}` : null,
      row.pa === true ? 'pa=yes' : row.pa === false ? 'pa=no' : null,
      row.st === true ? 'st=yes' : row.st === false ? 'st=no' : null,
      row.source ? `source=${row.source}` : null,
      row.strengthNote ? `tier_scope=drug_level strength=${row.strengthNote.asked.replace(/\s+/g, '')}_unmatched_confirm${row.strengthNote.nearest[0] ? ` closest=${row.strengthNote.nearest[0].replace(/\s+/g, '')}` : ''}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return `FORMULARY_LOOKUP year=${row.year} drug=${drugName.replace(/\s+/g, '_')} plan=${row.planId} verified_tier=${row.tier} ${extra}`.trim();
  }
  return `FORMULARY_LOOKUP year=${row.year} drug=${drugName.replace(/\s+/g, '_')} plan=${row.planId} verified=no reason=${row.reason || 'unverified'}`;
}

function formatFormularyText(result) {
  if (!result) return 'Formulary lookup failed.';
  const lines = [];
  lines.push(`${result.drugName}${result.ndc ? ` (NDC ${result.ndc})` : ''} — plan year ${result.year}`);
  if (result.nameCheck) {
    const nc = result.nameCheck;
    lines.push(nc.suggestion
      ? `NAME NOT CONFIRMED — NOT PRICED: ❓ '${nc.input}' — did you mean ${nc.suggestion}? Ask the agent; do not quote a tier for any guess.`
      : `NAME NOT CONFIRMED — NOT PRICED: ❓ '${nc.input}' is not a drug name RxNorm knows. Ask the agent to check the spelling.`);
  }
  if (result.nameCorrection) {
    lines.push(`NAME AUTO-CORRECTED: ${result.nameCorrection.from} → ${result.nameCorrection.to} (auto-corrected, verify). Show this correction to the agent.`);
  }
  if (result.edDrug) {
    lines.push('ED DRUG: Part D excludes ED use. Quote each plan with its label below exactly; never call it "not confirmed" when a plan answered.');
  }
  if (result.retriedProduct) {
    lines.push(`Note: the first catalog product (${result.retriedProduct.from}) read not covered; re-checked as ${result.retriedProduct.to}. Quote this result.`);
  }
  if (result.notCoveredNote) {
    lines.push(`UNVERIFIED NOT-COVERED: ${result.notCoveredNote} Tell the agent to confirm — do NOT state "not covered" as fact.`);
  }
  const sNote = (result.lookups || []).map((l) => l.strengthNote).find(Boolean);
  if (sNote) lines.push(strengthNoteText(result.drugName, sNote));
  if (!result.lookups.length) {
    lines.push('No plan IDs were passed. Catalog only — tiers are unverified until lookup_formulary is called with a contract-PBP.');
    if (result.catalog && result.catalog.length) {
      lines.push(
        `Catalog matches: ${result.catalog
          .slice(0, 5)
          .map((d) => `${d.name}${d.ndc ? ` NDC ${d.ndc}` : ''}`)
          .join('; ')}`
      );
    }
    if (result.catalogError) lines.push(`Catalog: ${result.catalogError}`);
    return lines.join('\n');
  }

  for (const row of result.lookups) {
    if (row.edLabel) lines.push(`${row.planId}: ${row.edLabel}`);
    if (!row.verified && /form_not_found/.test(String(row.reason || ''))) {
      lines.push(`${row.planId}: Not confirmed (form not found) — no ${result.form || 'requested-form'} product found; the oral form was NOT used.`);
      lines.push(formatPlanLookupLine(result.drugName, row));
      continue;
    }
    if (row.verified && row.tier) {
      const flags = [
        flagLine('PA', row.pa), flagLine('ST', row.st), flagLine('QL', row.ql),
        // Never let a silent source read as "no PA".
        restrictionsUnknown(row) ? 'PA/QL UNKNOWN (this source does not report restrictions; never say "no PA")' : null,
      ]
        .filter(Boolean)
        .join(', ');
      const cost =
        row.costShare && row.costShareSource === 'kb_2027'
          ? `${row.costShare} (2027 THEI grid T${row.tier})`
          : row.costShare
            ? `${row.costShare} (${row.costShareSource})`
            : 'cost-share not on file in THEI 2027 grid/KB';
      lines.push(
        row.strengthNote
          ? `${row.planId}: Tier ${row.tier} at drug level (not confirmed for ${row.strengthNote.asked}) · ${cost}${flags ? ` · ${flags}` : ''} · source ${row.source}`
          : `${row.planId}: verified Tier ${row.tier} · ${cost}${flags ? ` · ${flags}` : ''} · source ${row.source}`
      );
    } else if (row.verified && row.coverage === 'not_covered') {
      lines.push(`${row.planId}: verified not covered (${row.source}).`);
    } else {
      lines.push(`${row.planId}: UNVERIFIED${row.reason ? ` (${row.reason})` : ''}.`);
      if (row.note) lines.push(`  ${row.note}`);
    }
    lines.push(formatPlanLookupLine(result.drugName, row));
  }

  if (result.suggestedGeneric) {
    lines.push('');
    lines.push(
      `Suggested generic for ${starBrandName(result.drugName)}: ${result.suggestedGeneric}. Do not wait for the agent to type the generic. Show the brand as not covered with the asterisk note. Quote a generic tier only from the live follow-up — never invent a tier.`
    );
    if (result.genericFollowup) {
      lines.push(formatFormularyText(result.genericFollowup));
    } else {
      lines.push(
        `${result.suggestedGeneric}: UNVERIFIED (no live generic follow-up). Do not invent a tier.`
      );
    }
  }
  return lines.join('\n');
}

function toExportDrug(result) {
  if (!result) return null;
  const generic = knownGenericFor(result.drugName);
  const notCovered = brandVerifiedNotCovered(result.lookups);
  // "Not covered" on every plan after retrying other products is unverified —
  // the export must say confirm, never a flat "Not covered".
  let byPlanId = result.byPlanId;
  if (result.notCoveredNote && byPlanId) {
    byPlanId = Object.fromEntries(Object.entries(byPlanId).map(([id, row]) => (
      [id, row && row.coverage === 'not_covered' ? { ...row, unsure: true } : row]
    )));
  }
  return {
    name: generic && notCovered ? starBrandName(result.drugName) : result.drugName,
    ndc: result.ndc || '',
    byPlanId,
    brandNotCovered: Boolean(generic && notCovered),
    suggestedGeneric: result.suggestedGeneric || null,
  };
}

function toExportDrugs(result) {
  if (!result) return [];
  const brand = toExportDrug(result);
  const out = brand ? [brand] : [];
  if (result.suggestedGeneric) {
    const g = result.genericFollowup;
    out.push({
      name: `${result.suggestedGeneric} (generic)`,
      ndc: (g && g.ndc) || '',
      genericOf: String(result.drugName || '').replace(/\*+$/, ''),
      byPlanId: (g && g.byPlanId) || {},
    });
  }
  return out;
}

module.exports = {
  restrictionsKnownFor,
  restrictionsUnknown,
  medicareGovStrengthVariants,
  strengthsDiffer,
  missingStrengthCheck,
  medicareGovQueryName,
  strengthNoteText,
  sunfireMapIsUndated,
  sunfireEntryYear,
  sunfireMapHasYear,
  formatCostShare,
  PLAN_YEAR,
  SUNFIRE_BASE,
  HUMANA_FHIR,
  MEDICARE_GOV_BASE,
  RXNORM_BASE,
  PUBLIC_HUMANA_DRUG_LIST,
  KB_2027_KEYS,
  parseCmsId,
  cmsIdsMatch,
  displayPlanId,
  parseTierNumber,
  coverageFromObject,
  firstCoverageHit,
  sunfireIdForPlan,
  catalogDrugs,
  pickCatalogMatch,
  drugCatalogQuery,
  drugIngredients,
  rankCatalogMatches,
  humanaPlanYearMatch,
  isHumanaCms,
  cmsContractParts,
  scoreRelatedConcept,
  queryProductHints,
  conceptMatchesQuery,
  resolveMedicareGovNdcs,
  rankNdcs,
  extractMedicareGovCost,
  costShareFromKnowledge,
  costShareFromPlanObject,
  lookupFormulary,
  lookupSunfireCoverage,
  lookupHumanaFhir,
  lookupMedicareGov,
  lookupConsumerFormulary,
  costSharePlanCandidates,
  medicareGovFetch,
  curlFetch,
  pythonUrllibFetch,
  searchSunfireCatalog,
  formatFormularyText,
  formatPlanLookupLine,
  toExportDrug,
  toExportDrugs,
  knownGenericFor,
  BRAND_TO_GENERIC,
  hasSunfireCreds,
};
