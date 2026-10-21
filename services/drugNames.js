// services/drugNames.js — which drug (and which dosage form) the agent typed, before any
// formulary is asked.
//
// Martin Wiesenthal, 2026-10-09: "rasuvostatin" went straight to medicare.gov autocomplete,
// whose first hit was "Rasuvo" (methotrexate) — a different drug in a different class — and
// "acyclovir tablets & ointment" was priced as one oral tablet. Names now resolve against
// RxNorm generic / ingredient names first:
//   exact RxNorm name          → use it
//   one close RxNorm match     → use it, flagged "rasuvostatin → rosuvastatin (auto-corrected, verify)"
//   competing ingredients / low confidence / no match → do not price; ask "did you mean …?"
// Every correction is shown, so a name can never silently land on another drug or class.

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const FETCH_TIMEOUT_MS = 8_000;

// Dosage-form words an agent types → the form asked for. Non-oral forms must resolve to a
// product of that form (topical / ophthalmic / otic), never the oral one.
const FORM_WORDS = [
  ['tablet', /^(?:tabs?|tablets?|tbs?)$/i],
  ['capsule', /^(?:caps?|capsules?)$/i],
  ['ointment', /^(?:oint|ointments?)$/i],
  ['cream', /^(?:creams?|crema)$/i],
  ['gel', /^gels?$/i],
  ['lotion', /^lotions?$/i],
  ['drops', /^(?:drops?|gotas)$/i],
  ['patch', /^(?:patch|patches|parches?)$/i],
];
const NON_ORAL_FORMS = new Set(['ointment', 'cream', 'gel', 'lotion', 'drops', 'patch']);
// What an RxNorm product name says for each form.
const CONCEPT_FORM_RE = {
  tablet: /\btablet\b/i,
  capsule: /\bcapsule\b/i,
  ointment: /\bointment\b/i,
  cream: /\bcream\b/i,
  gel: /\b(?:topical|ophthalmic|vaginal|rectal)? ?gel\b/i,
  lotion: /\blotion\b/i,
  drops: /\b(?:ophthalmic|otic)\b.*\b(?:solution|suspension|drops?)\b|\bdrops?\b/i,
  patch: /\btransdermal\b|\bpatch\b/i,
};

function formOfWord(word) {
  const w = String(word || '').replace(/[.,;]+$/, '');
  for (const [form, re] of FORM_WORDS) if (re.test(w)) return form;
  return null;
}

/** The dosage form named in a med string ("acyclovir ointment" → "ointment"), or null. */
function requestedForm(name) {
  for (const w of String(name || '').split(/\s+/)) {
    const f = formOfWord(w);
    if (f) return f;
  }
  return null;
}

const isNonOralForm = (form) => NON_ORAL_FORMS.has(form);

/** How a form reads in the meds table: "acyclovir oral tablet", "acyclovir topical ointment". */
function formLabel(form, asked = '') {
  const eye = /\b(?:eye|ophthalmic|ophth)\b/i.test(asked);
  const ear = /\b(?:ear|otic)\b/i.test(asked);
  switch (form) {
    case 'tablet': return 'oral tablet';
    case 'capsule': return 'oral capsule';
    case 'ointment': return eye ? 'ophthalmic ointment' : 'topical ointment';
    case 'cream': return 'topical cream';
    case 'gel': return eye ? 'ophthalmic gel' : 'topical gel';
    case 'lotion': return 'topical lotion';
    case 'drops': return ear ? 'otic drops' : 'ophthalmic drops';
    case 'patch': return 'transdermal patch';
    default: return '';
  }
}

/** True when an RxNorm product name is the asked form ("acyclovir 0.05 MG/MG Topical Ointment" is an ointment). */
function conceptHasForm(conceptName, form) {
  const re = CONCEPT_FORM_RE[form];
  return re ? re.test(String(conceptName || '')) : true;
}

const FORM_SEP_RE = /^(?:&|and|y|\+|\/|or)$/i;

/**
 * "acyclovir tablets & ointment" → ["acyclovir tablets", "acyclovir ointment"]
 * "acyclovir tabs and cream"     → ["acyclovir tabs", "acyclovir cream"]
 * Anything else comes back as the one item it was.
 */
function expandDosageForms(item) {
  const s = String(item || '').trim();
  const words = s.split(/\s+/);
  const first = words.findIndex((w) => formOfWord(w));
  if (first < 1) return s ? [s] : [];
  const tail = words.slice(first);
  const forms = [];
  for (let i = 0; i < tail.length; i += 1) {
    if (i % 2 === 0) {
      if (!formOfWord(tail[i])) return [s];
      forms.push(tail[i].replace(/[.,;]+$/, ''));
    } else if (!FORM_SEP_RE.test(tail[i])) {
      return [s];
    }
  }
  if (forms.length < 2 || tail.length % 2 === 0) return [s];
  const base = words.slice(0, first).join(' ');
  return forms.map((f) => `${base} ${f}`);
}

/** Expand every item of a med list. */
function expandMedList(list) {
  const out = [];
  for (const m of list || []) for (const x of expandDosageForms(m)) if (!out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x);
  return out;
}

// Strength, form and release words carry the product, not the drug name RxNorm should match.
// "Clobetasol 0.05% cream" / "… 0.05% solution": the strength ("0.05%" — '%' has no word boundary after it) and the
// form word are stripped for the RxNorm check; the med keeps them as its label (Live bug, 2026-10-21: cream and
// solution read "not a drug name RxNorm knows" while shampoo resolved).
const STRIP_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units?|iu|meq|%)(?![A-Za-z0-9])|\b(?:shampoo|foam|scalp|external|wash|lotion|liquid|er|xr|xl|sr|cr|dr|ec|odt|la|hcl|pah|bph|oral|topical|ophthalmic|eye|ear|otic|solution|soln|suspension|susp|pen|injection|inhaler|vial|ellipta|diskus|respimat|flexpen|kwikpen|flextouch|hfa|turbuhaler|handihaler|breezhaler|autoinjector|sureclick|daily|bid|tid|qd|prn)\b/gi;

/** "rasuvostatin 10mg tablets" → "rasuvostatin" (the part RxNorm should match). */
function drugNameBase(raw) {
  return String(raw || '')
    .split(/\s+/).filter((w) => !formOfWord(w)).join(' ')
    .replace(STRIP_RE, ' ')
    .replace(/[^A-Za-z0-9\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 1 = same spelling, 0 = nothing alike. */
function similarity(a, b) {
  const x = String(a || '').toLowerCase().trim();
  const y = String(b || '').toLowerCase().trim();
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// A fuzzy match below this is a guess, not a correction: ask instead of pricing.
const MIN_SIMILARITY = 0.75;
// Two different ingredients this close in RxNorm's score are a real tie: ask.
const TIE_RATIO = 0.9;

async function getJson(url, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res || !res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The ingredient(s) behind an RxNorm concept (a brand or product resolves to its generic). */
async function ingredientsOf(rxcui, fetchImpl) {
  const j = await getJson(`${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=IN`, fetchImpl);
  const groups = (j && j.relatedGroup && j.relatedGroup.conceptGroup) || [];
  const names = [];
  for (const g of groups) for (const c of g.conceptProperties || []) if (c.name) names.push(String(c.name).toLowerCase());
  return names;
}

const nameCache = new Map();

/**
 * Resolve what the agent typed to an RxNorm drug name.
 * status: 'exact' | 'corrected' | 'ambiguous' | 'not_found' | 'unavailable' (RxNorm unreachable —
 * the caller keeps the old behavior rather than blocking the lookup).
 * `query` is the string to price with: the agent's words, with the drug name swapped when corrected.
 */
async function resolveDrugName(raw, fetchImpl = fetch) {
  const input = String(raw || '').trim();
  const base = drugNameBase(input);
  if (!base || /^\d[\d-]*$/.test(base) || base.length < 3) return { status: 'exact', input, query: input, name: base || input };
  if (nameCache.has(base)) return { ...nameCache.get(base), input, query: swapName(input, base, nameCache.get(base)) };

  const exact = await getJson(`${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(base)}&search=1`, fetchImpl);
  if (!exact) return { status: 'unavailable', input, query: input, name: base };
  const exactIds = (exact.idGroup && exact.idGroup.rxnormId) || [];
  if (exactIds.length) return remember(base, input, { status: 'exact', name: base, rxcui: String(exactIds[0]) });

  const approx = await getJson(`${RXNORM_BASE}/approximateTerm.json?term=${encodeURIComponent(base)}&maxEntries=12&option=1`, fetchImpl);
  if (!approx) return { status: 'unavailable', input, query: input, name: base };
  // Best-scoring RxNorm name per concept, in RxNorm's own order.
  const byRxcui = new Map();
  for (const c of (approx.approximateGroup && approx.approximateGroup.candidate) || []) {
    if (c.source !== 'RXNORM' || !c.name || !c.rxcui) continue;
    const score = Number(c.score) || 0;
    const prev = byRxcui.get(c.rxcui);
    if (!prev || score > prev.score) byRxcui.set(c.rxcui, { rxcui: String(c.rxcui), name: String(c.name), score });
  }
  const cands = [...byRxcui.values()].sort((a, b) => b.score - a.score);
  if (!cands.length) {
    // RxNorm's own spelling suggestion ("farxica" → "farxiga") is a "did you mean", never a silent correction.
    const sp = await getJson(`${RXNORM_BASE}/spellingsuggestions.json?name=${encodeURIComponent(base)}`, fetchImpl);
    const sugg = ((sp && sp.suggestionGroup && sp.suggestionGroup.suggestionList && sp.suggestionGroup.suggestionList.suggestion) || [])[0];
    return remember(base, input, sugg ? { status: 'ambiguous', name: base, suggestion: String(sugg).toLowerCase(), alternatives: [], reason: 'spelling' } : { status: 'not_found', name: base });
  }

  const top = cands[0];
  // Competitors: concepts scored close to the top one. Different ingredients among them = ambiguous.
  const close = cands.filter((c) => c.score >= top.score * TIE_RATIO).slice(0, 4);
  const ingredientSets = await Promise.all(close.map(async (c) => {
    const ing = await ingredientsOf(c.rxcui, fetchImpl);
    return ing.length ? ing : [c.name.toLowerCase()];
  }));
  const key = (ing) => [...new Set(ing)].sort().join('+');
  const distinct = [...new Set(ingredientSets.map(key))];
  // RxNorm's own name for the top concept when it is the generic ("rosuvastatin"), else its ingredient.
  const topIngredient = ingredientSets[0].length === 1 ? ingredientSets[0][0] : top.name.toLowerCase();
  // A misspelled brand corrects to that brand ("Eliquiss" → "eliquis"), a generic to the generic.
  const topName = similarity(base, top.name) >= similarity(base, topIngredient) ? top.name.toLowerCase() : topIngredient;
  const sim = similarity(base, topName);
  if (distinct.length > 1) {
    const others = [...new Set(ingredientSets.slice(1).map((s) => s[0]))].filter((n) => n !== topName);
    return remember(base, input, { status: 'ambiguous', name: base, suggestion: topName, alternatives: others, reason: 'different_ingredients' });
  }
  // A pharmacy-label spelling of the same drug ("BRIMONIDINE TARTRATE/TIMOLOL MALEATE SOLUTION 0.2/0.5%" vs
  // RxNorm's "brimonidine tartrate 0.2 % / timolol maleate 0.5 % ophthalmic solution") is a correction, not a
  // "check name" row on every re-run (Nancy Blanco De Pajaro, 2026-10-17).
  // Same letters, only spacing / slashes differ ("brimonidine timolol" vs RxNorm "brimonidine / timolol"): that is the
  // name she typed, not a correction to flag.
  if (distinct.length === 1 && base.replace(/[^a-z]/g, '') === topName.replace(/[^a-z]/g, '')) {
    return remember(base, input, { status: 'exact', name: topName, rxcui: top.rxcui });
  }
  if (sim < MIN_SIMILARITY && sameCoreDrug(base, topName)) {
    return remember(base, input, { status: 'corrected', name: topName, rxcui: top.rxcui, from: base, similarity: Number(sim.toFixed(2)) });
  }
  if (sim < MIN_SIMILARITY) {
    return remember(base, input, { status: 'ambiguous', name: base, suggestion: topName, alternatives: [], reason: 'low_confidence' });
  }
  return remember(base, input, { status: 'corrected', name: topName, rxcui: top.rxcui, from: base, similarity: Number(sim.toFixed(2)) });
}

const CORE_SKIP_WORDS = new Set(('maleate tartrate hydrochloride hcl sodium potassium calcium magnesium besylate mesylate succinate citrate sulfate acetate phosphate fumarate bromide chloride propionate furoate monohydrate dihydrate ' +
  'solution soln sol suspension susp drops drop tablet tablets tab tabs capsule capsules cap caps ophthalmic oral topical extended release er xr sr dr cream ointment gel injection pen mg mcg ml').split(/\s+/));
/** Same ingredient words, salts / forms / strengths aside. */
function sameCoreDrug(a, b) {
  const core = (x) => [...new Set(String(x || '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !CORE_SKIP_WORDS.has(w)))].sort().join('+');
  const ca = core(a);
  return !!ca && ca === core(b);
}

function swapName(input, base, res) {
  if (res.status !== 'corrected') return input;
  // Keep the strength / form words the agent typed; swap only the misspelled name.
  const re = new RegExp(base.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  return re.test(input) ? input.replace(re, res.name) : res.name;
}

function remember(base, input, res) {
  nameCache.set(base, res);
  return { ...res, input, query: swapName(input, base, res) };
}

// Words in an ask that are never the drug she means, even when RxNorm has a concept for them.
const COMMON_WORDS = new Set(('zip code plans plan compare doctor doctors client clients please check medicaid network networks which would could should about there their other others better current currently terminating terminate wants needs looking these those where county broward miami dade palm beach florida humana aetna devoted careplus simply wellcare cigna healthspring solis united health healthcare medicare advantage hello thanks thank today tomorrow years month months premium copay copays benefits dental vision hearing water oxygen sugar insulin-free alternatives options something anything everything also still since after before again with without from into under over between because while mother father husband wife daughter sister brother').split(/\s+/));

/**
 * Drug names RxNorm knows in free text ("… Medications esomeprazole, rasuvostatin …") — used only to
 * notice that a med list was typed but could not be read, never to price anything.
 */
async function drugTokensInText(text, { exclude = [], fetchImpl = fetch, max = 10, timeoutMs = 4_000 } = {}) {
  const excl = new Set(exclude.flatMap((n) => String(n || '').toLowerCase().split(/[^a-z]+/)).filter(Boolean));
  const words = [...new Set(String(text || '').toLowerCase().match(/[a-z][a-z-]{4,}/g) || [])]
    .filter((w) => !excl.has(w) && !COMMON_WORDS.has(w))
    .slice(0, max);
  if (!words.length) return [];
  const check = Promise.all(words.map(async (w) => {
    const j = await getJson(`${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(w)}&search=1`, fetchImpl);
    return j && j.idGroup && (j.idGroup.rxnormId || []).length ? w : null;
  })).then((hits) => hits.filter(Boolean));
  return Promise.race([check, new Promise((r) => setTimeout(() => r([]), timeoutMs))]);
}

/**
 * Did the answering source report restrictions at all? medicare.gov never does (its restrictions
 * list comes back empty even for Ozempic), and a Sunfire / Humana FHIR answer that omits the PA /
 * ST / QL fields says nothing either — a missing field is never "none". Solis, HealthSun and the
 * Doctors PDF print every row's requirements, so their false is a real "none".
 * Any other source is known only when it reported all three: a Humana FHIR answer with a PA
 * extension and no QL one used to read as "no QL" (audit, 2026-10-09).
 */
const PDF_READER_SOURCE_RE = /solis .*formulary pdf|healthsun .*formulary pdf|doctors_formulary_pdf/i;

function restrictionsKnownFor(hit) {
  if (!hit) return false;
  const source = String(hit.source || '');
  if (/medicare_gov/i.test(source)) return false;
  if (PDF_READER_SOURCE_RE.test(source)) return true;
  return [hit.pa, hit.st, hit.ql].every((v) => typeof v === 'boolean');
}

/** True when a row's PA/ST/QL were not reported by its source ("PA/QL ?"). */
function restrictionsUnknown(row) {
  if (!row || !row.verified || row.coverage === 'not_covered') return false;
  if (typeof row.restrictionsKnown === 'boolean') return !row.restrictionsKnown;
  return !restrictionsKnownFor(row);
}

// ─── Part D excluded drug classes ─────────────────────────────────────────────

// Sexual / erectile dysfunction PDE5 inhibitors: excluded from Part D for ED use. A plan can still
// cover them as a supplemental benefit, or under Part D for BPH (tadalafil) / PAH.
const ED_DRUG_RE = /\b(?:tadalafil|sildenafil|vardenafil|avanafil|cialis|viagra|levitra|staxyn|stendra|revatio|adcirca|alyq|tadliq)\b/i;

const isEdDrug = (name) => ED_DRUG_RE.test(String(name || ''));

const ED_LABELS = {
  supplemental: 'Covered — supplemental benefit (excluded drug; not counted toward Part D OOP max)',
  bphPah: 'Covered — Part D for BPH/PAH only (PA required, verify diagnosis)',
  paOnly: 'Covered · PA required (verify indication)',
  notCovered: 'Not covered by this plan',
  notConfirmed: 'Not confirmed',
  verify: 'Covered — verify if supplemental benefit',
};

/**
 * The label for an ED drug on one plan. Coverage is looked up like any other drug; this only
 * names what the answer means. When the source cannot tell supplemental from Part D coverage,
 * it says so instead of guessing. BPH/PAH is said only when the source names that indication on
 * the row — a PA flag alone never implies it (Solis lists tadalafil 2.5 mg as "PA, QL" under
 * Genitourinary Agents, with no indication; 2026-10-09).
 */
function edLabel(row) {
  if (!row || !row.verified) return ED_LABELS.notConfirmed;
  if (row.coverage === 'not_covered') return ED_LABELS.notCovered;
  if (row.excludedDrug === true) return ED_LABELS.supplemental;
  if (row.indication && /^(?:BPH|PAH)$/i.test(row.indication)) return ED_LABELS.bphPah;
  if (row.pa === true) return ED_LABELS.paOnly;
  return ED_LABELS.verify;
}

// ─── one med-name normalizer (overhaul, 2026-10-17) ───────────────────────────────────────────────────────────
// A pharmacy-label / ALL-CAPS / salt-named med reads the way medicare.gov and Sunfire list it before any formulary
// is asked: "BRIMONIDINE TARTRATE/TIMOLOL MALEATE SOLUTION 0.2/0.5%" → "brimonidine / timolol 0.2%/0.5% ophthalmic
// solution" (Nancy Blanco De Pajaro). Plain names ("Farxiga", "gabapentin 300 mg") are left exactly as typed.
const MED_SALT_WORDS = new Set(['maleate', 'tartrate', 'hydrochloride', 'hcl', 'sodium', 'potassium', 'calcium', 'magnesium', 'besylate', 'mesylate', 'succinate', 'citrate', 'sulfate', 'acetate', 'phosphate', 'fumarate', 'bromide', 'chloride', 'propionate', 'furoate', 'monohydrate', 'dihydrate', 'trihydrate']);
const MED_FORM_WORDS = new Set(['solution', 'soln', 'sol', 'suspension', 'susp', 'drops', 'drop', 'tablet', 'tablets', 'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps', 'ophthalmic', 'opth', 'oph', 'cream', 'ointment', 'gel', 'inhaler', 'injection', 'pen', 'oral', 'topical']);
const EYE_DRUG_RE = /\b(?:brimonidine|timolol|latanoprost|dorzolamide|travoprost|bimatoprost|brinzolamide|netarsudil|tafluprost)\b/i;
const FORM_DISPLAY = { tab: 'tablet', tabs: 'tablet', tablets: 'tablet', tablet: 'tablet', cap: 'capsule', caps: 'capsule', capsules: 'capsule', capsule: 'capsule', cream: 'cream', ointment: 'ointment', gel: 'gel', inhaler: 'inhaler', injection: 'injection', pen: 'pen' };

/** Does a typed med need normalizing? ALL CAPS, a combo slash, a salt word, or a pharmacy-label length. */
function medNameIsMessy(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  const letters = s.replace(/[^A-Za-z]/g, '');
  const allCaps = letters.length >= 4 && letters === letters.toUpperCase();
  const combo = /[A-Za-z]\s*\/\s*[A-Za-z]/.test(s);
  const words = s.toLowerCase().split(/[^a-z]+/);
  const salt = words.length > 1 && words.some((w) => MED_SALT_WORDS.has(w)) && combo;
  return allCaps || combo || salt || s.length >= 40;
}

/** Ingredients (salts kept + stripped), strength and form of a typed med. */
function medNameParts(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  const low = s.toLowerCase();
  // "0.2/0.5%" → "0.2%/0.5%"; "20 mg" stays.
  const strengths = [];
  const noStrength = low.replace(/\b(\d+(?:\.\d+)?(?:\s*[\/-]\s*\d+(?:\.\d+)?)*)\s*(%|mg|mcg|ml|g|units?|iu|meq)?(?=[\s,/]|$)/g, (m, nums, unit) => {
    const sep = /-/.test(nums) ? '-' : '/';
    const parts = nums.split(/\s*[\/-]\s*/);
    strengths.push(unit === '%' ? parts.map((n) => `${n}%`).join('/') : `${parts.join(sep)}${unit ? ` ${unit}` : ''}`);
    return ' ';
  });
  const forms = [];
  const comps = noStrength.split(/\s*\/\s*/).map((c) => c.split(/\s+/).filter((w) => {
    if (!w) return false;
    if (MED_FORM_WORDS.has(w)) { forms.push(w); return false; }
    return true;
  })).filter((ws) => ws.length);
  const salted = comps.map((ws) => ws.join(' '));
  const ingredients = comps.map((ws) => ws.filter((w) => !MED_SALT_WORDS.has(w)).join(' ') || ws.join(' '));
  let form = '';
  if (forms.some((f) => /^(?:solution|soln|sol|drops?|ophthalmic|opth|oph)$/.test(f))) form = EYE_DRUG_RE.test(low) ? 'ophthalmic solution' : (forms.includes('suspension') || forms.includes('susp') ? 'suspension' : 'solution');
  else if (forms.length) form = FORM_DISPLAY[forms.find((f) => FORM_DISPLAY[f])] || '';
  return { ingredients, salted, strength: strengths.join(' '), form };
}

/** Sync display form (no network): what the meds list and the formulary search use. */
function localMedDisplay(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!medNameIsMessy(s)) return s;
  const p = medNameParts(s);
  if (!p.ingredients.length) return s;
  let names;
  if (p.ingredients.length >= 2) names = p.ingredients.join(' / ');
  else {
    // A single ingredient keeps its salt (medicare.gov lists "atorvastatin calcium"); an ALL-CAPS brand reads "Farxiga".
    names = p.salted[0];
    if (names.split(/\s+/).length === 1 && s === s.toUpperCase()) names = names.charAt(0).toUpperCase() + names.slice(1);
  }
  return [names, p.strength, p.form].filter(Boolean).join(' ');
}

const medNameCache = new Map();
/**
 * The one med-name normalizer: { display, query, fallbacks, rxcui, source }.
 * display/query: medicare.gov naming ("brimonidine / timolol 0.2%/0.5% ophthalmic solution"); fallbacks: the combo
 * without strength, the salt-kept combo, then exactly what she typed. RxNorm confirms a combo's ingredient set
 * (rxcui); when RxNorm is slow or down the local form is used — never a block.
 */
async function normalizeMedName(raw, fetchImpl = fetch) {
  const input = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!input) return { display: '', query: '', fallbacks: [], rxcui: null, source: 'typed' };
  const key = input.toLowerCase();
  if (medNameCache.has(key)) return medNameCache.get(key);
  const display = localMedDisplay(input);
  if (display === input) {
    const res = { display, query: input, fallbacks: [], rxcui: null, source: 'typed' };
    medNameCache.set(key, res);
    return res;
  }
  const p = medNameParts(input);
  const fallbacks = [];
  const add = (x) => { const v = String(x || '').trim(); if (v && v !== display && !fallbacks.includes(v)) fallbacks.push(v); };
  if (p.ingredients.length >= 2) { add(p.ingredients.join(' / ')); add(p.salted.join(' / ')); }
  else add(p.salted[0]);
  add(input);
  let rxcui = null;
  let source = 'local';
  if (p.ingredients.length >= 2) {
    const j = await getJson(`${RXNORM_BASE}/rxcui.json?name=${encodeURIComponent(p.ingredients.join(' / '))}&search=1`, fetchImpl);
    const ids = (j && j.idGroup && j.idGroup.rxnormId) || [];
    if (ids.length) { rxcui = String(ids[0]); source = 'rxnorm'; }
  }
  const res = { display, query: display, fallbacks, rxcui, source };
  // Only a definite answer is cached; an RxNorm outage is retried on the next lookup.
  if (source === 'rxnorm' || p.ingredients.length < 2) medNameCache.set(key, res);
  return res;
}

module.exports = {
  medNameIsMessy,
  medNameParts,
  localMedDisplay,
  normalizeMedName,
  _medNameCache: medNameCache,
  requestedForm,
  isNonOralForm,
  conceptHasForm,
  formLabel,
  expandDosageForms,
  expandMedList,
  drugNameBase,
  similarity,
  resolveDrugName,
  sameCoreDrug,
  drugTokensInText,
  restrictionsKnownFor,
  restrictionsUnknown,
  isEdDrug,
  edLabel,
  ED_LABELS,
  RXNORM_BASE,
  _nameCache: nameCache,
};
