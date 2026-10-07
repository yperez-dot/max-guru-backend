// services/comparisonRules.js — Doctor/Drug Comparison Table Rules (HARD RULES).
//
// One source for the rule text (appended to every system prompt) and for the
// facts the selector needs: the client's county pool from the THEI 2027 grid,
// eligibility read from the agent's own words, and SNP flags from listed meds.
// Nothing here ranks plans for a client or decides eligibility on its own — an
// unknown stays unknown and the plan stays out of the top 3 until the agent
// confirms it.

const fs = require('fs');
const path = require('path');

const COMPARISON_TABLE_RULES = `
DOCTOR/DRUG COMPARISON TABLE RULES (HARD RULES — apply on every multi-doctor or multi-plan comparison; they replace any earlier, shorter version and override older table/format instructions where they conflict):

A. PLAN SELECTION (run before building any table)
1. ELIGIBILITY FILTER FIRST: Before selecting plans, determine eligibility:
   - Medicaid status: full Medicaid / MSP only (QMB, SLMB, QI) / none
   - C-SNP qualifying chronic condition: confirmed / none / unknown
   If either is unknown, ask the agent BEFORE selecting plans. Exclude any D-SNP, QMB-only, or C-SNP plan the client is not confirmed eligible for.
2. SELECTION POOL: Select from ALL eligible plans in the client's county in the plan grid, not only plans returned by a single provider lookup. Run the network check for every listed doctor against every eligible plan before ranking.
3. RANKING ORDER: 1st most doctors confirmed In; 2nd fewest doctors confirmed Out; 3rd lowest total estimated drug cost for the client's listed meds; 4th lowest premium. A plan with more than half its doctor cells unchecked cannot be placed in the top 3 — list it separately under "Could not verify."
4. NETWORK DIVERSITY: If two plans share the same carrier network and produce identical doctor results, prefer a plan on a different network for the top 3. Never print a "Same network as above" list. A comparison always shows at least 2 plans: if only one network is available, show the best two plans anyway.
5. "WHY THESE PLANS" LINE (required, above every table): "Why these plans: [N] eligible plans checked in [county]. Ranked by doctors in → fewest out → drug cost → premium. Excluded: [plan types excluded + reason, e.g., 'D-SNPs — Medicaid not confirmed']."

B. TABLE DISPLAY
6. COUNT FORMAT: Never show "X/7". Always show "X in · Y out · Z unchecked" per plan.
7. HEADER ACCURACY: Do not describe results as "most doctors in network" unless a plan has more than half confirmed In. Otherwise use: "Doctors × top plans (best confirmed match shown first — a count, not a recommendation)."
8. RUN ALL KNOWN DATA BEFORE ASKING: If meds or doctors were already provided, check them against EVERY plan in the table before displaying (one lookup_formulary call per drug with ALL table planIds). Never ask the agent for data already present in the conversation. Only ask for meds if none were given.
9. UNIFORM UNKNOWN MARKER: Every unknown cell displays "❔ unchecked" (never checked) or "❔ not confirmed" (checked, no result). Never a bare icon. Doctor and drug legends must use identical wording.
10. PROVIDER IDENTITY: Display each doctor as full name + specialty or NPI as matched. If only a last name was provided, confirm the match with the agent before running network checks.
11. SNP FLAGS: If meds suggest a possible C-SNP qualifying condition (e.g., an anticoagulant suggesting a cardiovascular condition), flag it as "Possible C-SNP eligibility — agent must confirm diagnosis." Never assume it.
12. CARRIERS ASKED BY NAME: When the agent asks for specific carriers ("show me Doctors, Solis, Devoted", "client wants Devoted"), the columns are those carriers' best eligible plans — never swap in other carriers or keep the old top 3. If a carrier has no eligible plan in the county, say so and why.
13. NUMBERED REPLIES ARE ANSWERS: "1. no, 2. cardiovascular disorder, 3. yes" answers Max's numbered questions in order — apply them; never re-ask what she answered.
14. NO EXACT DOCTOR MATCH: Never ask the agent to look up an NPI. Show the closest real providers the tool found (name, specialty, city) and let her pick ("Carlos Sosa = Glenda Sosa"), or ask for the spelling / specialty / office name.
15. SHORT FIRST REPLY (she skims long replies): the first reply to a comparison is ONLY the header, "Why these plans", the doctor table, the meds table, at most TWO notes (SNP eligibility first), and at most TWO questions (the one that blocks the work first). No benefits / grid snapshot, no "Sources:" line for grid or lookup data, and no note that repeats what a table already shows. Never mention a lookup failure for a carrier that is not a column in the table (e.g. Simply FindCare when Simply is not compared). Benefits go in a second reply only when she taps "Show benefits" or asks for them.
16. SHOW BENEFITS REQUEST: when she asks "Show benefits for these plans", answer with NO new lookups and NO repeat of the doctor or meds tables: one short block per plan already compared (marketing name + contract-PBP; premium, Part B giveback, MOOP, specialist, ER, dental, vision, OTC) from the THEI 2027 grid, non-yellow cells only. End with one line: full benefits are in the Excel / PDF export.
Never invent plan rankings or eligibility. When the server tool result already contains a DOCTOR × PLAN TABLE and a "Why these plans" line, copy them as-is.
`;

const UNCHECKED = '❔ unchecked';
const NOT_CONFIRMED_CELL = '❔ not confirmed';
// Same unknown wording in the doctor and drug legends (rule 9).
const UNKNOWN_LEGEND = '❔ unchecked = never checked · ❔ not confirmed = checked, no result';
const LEGEND = `✅ In · ❌ Out · ${UNKNOWN_LEGEND} (never assume Out)`;
const IN_STAR_LEGEND = '✅ In* = in the carrier network; confirm this specific plan in the carrier directory';
const MEDS_LEGEND = `T = tier · ⚠️ confirm = read not covered, check the exact product in Sunfire · ${UNKNOWN_LEGEND}`;
const RANK_ORDER = 'Ranked by doctors in → fewest out → drug cost → premium.';
const POSSIBLE_CSNP = 'Possible C-SNP eligibility — agent must confirm diagnosis.';

// ─── THEI 2027 grid (lives in the UI page; the backend already reads it for SOB links) ─

let gridOverride = null;
const gridCache = {};

function loadGrid(year = 2027) {
  if (gridOverride) return gridOverride;
  const y = Number(year) === 2026 ? 2026 : 2027;
  if (gridCache[y]) return gridCache[y];
  try {
    const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    const id = y === 2026 ? 'plan-data-2026' : 'plan-data';
    const m = html.match(new RegExp(`<script id="${id}" type="application/json">\\s*([\\s\\S]*?)\\s*</script>`));
    gridCache[y] = m ? JSON.parse(m[1]) : [];
  } catch (_) {
    gridCache[y] = [];
  }
  return gridCache[y];
}

/** Tests only: swap the grid for a fixture (null restores the real one). */
function setGridForTests(plans) {
  gridOverride = plans;
}

/** Same ZIP ranges as the UI (gridCountyForZip in max-demo-FINAL-v7.html). */
function countyForZip(zip) {
  const m = String(zip || '').match(/^(\d{5})/);
  if (!m) return '';
  const n = Number(m[1]);
  if (n === 33004 || n === 33009) return 'Broward';
  if (n >= 33019 && n <= 33029) return 'Broward';
  if (n >= 33060 && n <= 33077) return 'Broward';
  if (n >= 33301 && n <= 33394) return 'Broward';
  if (n >= 33441 && n <= 33443) return 'Broward';
  if (n >= 33010 && n <= 33018) return 'Miami-Dade';
  if (n >= 33030 && n <= 33039) return 'Miami-Dade';
  if (n >= 33054 && n <= 33056) return 'Miami-Dade';
  if (n >= 33090 && n <= 33092) return 'Miami-Dade';
  if (n >= 33101 && n <= 33299) return 'Miami-Dade';
  return '';
}

/** Client county from the agent's words: newest ZIP wins, then a county name. '' when unknown. */
function countyFromAsk(askText) {
  const lines = String(askText || '').split('\n').reverse();
  for (const line of lines) {
    const zips = [...line.matchAll(/\b(3\d{4})\b/g)].map((x) => x[1]);
    for (const z of zips.reverse()) {
      const c = countyForZip(z);
      if (c) return c;
    }
    if (/\bbroward\b/i.test(line) && !/miami|dade/i.test(line)) return 'Broward';
    if (/\bmiami[- ]?dade\b|\bdade\b/i.test(line) && !/broward/i.test(line)) return 'Miami-Dade';
  }
  return '';
}

/** Grid rows for the county (both counties when unknown), one row per contract-PBP. */
function gridPlansForCounty(county, year = 2027) {
  const grid = loadGrid(year) || [];
  const rows = county ? grid.filter((p) => p.county === county) : grid;
  const seen = new Map();
  for (const p of rows) {
    const id = String(p.planId || p.id || '').toUpperCase();
    if (id && !seen.has(id)) seen.set(id, p);
  }
  return [...seen.values()];
}

// ─── plan kinds + eligibility ───────────────────────────────────────────────

/** 'dsnp' | 'qmb' (QMB-only D-SNP) | 'csnp' | '' (open enrollment HMO/PPO). */
function snpKind(planLike) {
  const p = planLike || {};
  const type = String(p.type || '');
  const name = String(p.planName || p.name || p.label || '');
  const msp = String(p.mspLevels || '');
  if (/qmb\s*only/i.test(msp) || /\bqmb\s*only\b/i.test(name)) return 'qmb';
  if (/^d-?snp$/i.test(type) || /\bd-?snp\b|\bdual\b/i.test(name) || type === 'dsnp') return 'dsnp';
  if (/^c-?snp$/i.test(type) || /\bc-?snp\b|complete care|chronic/i.test(name) || type === 'csnp') return 'csnp';
  return '';
}

function networkType(planLike) {
  const p = planLike || {};
  return /\bppo\b/i.test(`${p.type || ''} ${p.planName || p.name || p.label || ''}`) ? 'ppo' : 'hmo';
}

const LEVEL_RE = [
  ['FBDE', /\bf[bd]{2}e\b|full[- ]?(benefit )?dual|full medicaid/i],
  ['QMB+', /\bqmb\s*(\+|plus)/i],
  ['SLMB+', /\bslmb\s*(\+|plus)/i],
  ['QMB', /\bqmb\b(?!\s*(\+|plus))/i],
  ['SLMB', /\bslmb\b(?!\s*(\+|plus))/i],
  ['QI', /\bqi\b/i],
  ['QDWI', /\bqdwi\b/i],
];

function levelsIn(text) {
  const t = String(text || '');
  return LEVEL_RE.filter(([, re]) => re.test(t)).map(([lvl]) => lvl);
}

/**
 * What the agent said about eligibility. Never inferred from meds or plan names.
 * medicaid: 'full' | 'msp' | 'none' | 'unknown'; levels: client's stated MSP/dual levels;
 * csnp: 'confirmed' | 'none' | 'unknown'.
 */
function eligibilityFromAsk(askText) {
  // Plan names carry these words too ("Aetna Medicare QMB Only Select H1609-043",
  // "Dual Complete") — strip plan references so a named plan never reads as the
  // client's own eligibility.
  const t = String(askText || '')
    .replace(/[^,;.\n]{0,70}\b[HR]\d{4}-\d{3}[A-Z]?\b/gi, ' ')
    .replace(/\b(qmb only select|dual complete|dual select|complete care)\b/gi, ' ');
  const none = /\b(no|not on|without|sin|doesn'?t have|don'?t have|no tiene)\s+(medicaid|msp|dual|qmb|slmb|medicare savings)\b|\bnot dual\b|\bmedicaid\s*[:=-]?\s*(no|none)\b|\bnon[- ]?dual\b/i.test(t);
  const levels = none ? [] : levelsIn(t);
  let medicaid = 'unknown';
  if (none) medicaid = 'none';
  else if (/\b(full medicaid|has medicaid|have medicaid|tiene medicaid|full dual|dual eligible|medicaid\s*[:=-]?\s*(yes|full))\b/i.test(t) || levels.some((l) => ['FBDE', 'QMB+', 'SLMB+'].includes(l))) {
    medicaid = 'full';
    if (!levels.length) levels.push('FBDE');
  } else if (levels.length || /\bmsp only\b|\bmedicare savings program\s*(only|yes)\b|\bpartial dual\b/i.test(t)) {
    medicaid = 'msp';
  }

  let csnp = 'unknown';
  if (/\b(no|not|without|none)\s+(c-?snp|chronic condition|qualifying (chronic )?condition)s?\b|\bc-?snp\s*[:=-]?\s*no\b|\bnot c-?snp eligible\b/i.test(t)) csnp = 'none';
  else if (/\bc-?snp\s*(eligible|qualif\w*|[:=-]\s*yes|ok)\b|\bqualifies for (a )?c-?snp\b|\b(chronic condition|qualifying condition|diagnos\w+)\s*[:=-]?\s*(confirmed|yes)\b|\b(has|diagnosed with|dx(?: of)?:?)\s+(diabetes|chf|heart failure|copd|esrd|afib|atrial fibrillation|cardiovascular|coronary artery disease|cad|chronic lung|dementia|ckd)\b/i.test(t)) csnp = 'confirmed';

  return { medicaid, levels, csnp };
}

/**
 * Is the client confirmed eligible for this plan?
 * { status: 'eligible' | 'excluded' | 'unknown', reason }
 * 'unknown' keeps the plan out of the top 3 (never assumed eligible).
 */
function planEligibility(planLike, elig) {
  const kind = snpKind(planLike);
  if (!kind) return { status: 'eligible', kind };
  if (kind === 'csnp') {
    if (elig.csnp === 'confirmed') return { status: 'eligible', kind };
    return { status: elig.csnp === 'none' ? 'excluded' : 'unknown', kind, reason: elig.csnp === 'none' ? 'C-SNPs — no qualifying condition' : 'C-SNPs — qualifying condition not confirmed' };
  }
  // D-SNP / QMB-only: need a stated dual level that this plan's MSP Levels accept.
  if (elig.medicaid === 'none') {
    return { status: 'excluded', kind, reason: kind === 'qmb' ? 'QMB-only plans — no Medicaid/MSP' : 'D-SNPs — no Medicaid/MSP' };
  }
  if (elig.medicaid === 'unknown') {
    return { status: 'unknown', kind, reason: kind === 'qmb' ? 'QMB-only plans — QMB not confirmed' : 'D-SNPs — Medicaid not confirmed' };
  }
  const planLevels = kind === 'qmb' ? ['QMB'] : levelsIn(planLike.mspLevels || '');
  if (!planLevels.length) {
    return { status: 'unknown', kind, reason: 'D-SNPs — plan MSP levels not on the grid' };
  }
  const ok = elig.levels.some((l) => planLevels.includes(l));
  if (ok) return { status: 'eligible', kind };
  return elig.levels.length > 0
    ? { status: 'excluded', kind, reason: kind === 'qmb' ? 'QMB-only plans — client is not QMB' : "D-SNPs — client's MSP level not accepted" }
    : { status: 'unknown', kind, reason: kind === 'qmb' ? 'QMB-only plans — QMB not confirmed' : 'D-SNPs — MSP level not confirmed' };
}

// ─── meds that suggest (never confirm) a C-SNP condition ────────────────────

const CSNP_HINTS = [
  { condition: 'cardiovascular condition', re: /\b(eliquis|apixaban|xarelto|rivaroxaban|warfarin|coumadin|jantoven|pradaxa|dabigatran|savaysa|edoxaban|clopidogrel|plavix|brilinta|ticagrelor)\b/i, why: 'an anticoagulant/antiplatelet' },
  { condition: 'heart failure', re: /\b(entresto|sacubitril|furosemide|lasix|spironolactone|carvedilol)\b/i, why: 'a heart-failure med' },
  { condition: 'diabetes', re: /\b(metformin|insulin|lantus|basaglar|tresiba|humalog|novolog|glipizide|glimepiride|glyburide|jardiance|empagliflozin|farxiga|dapagliflozin|januvia|sitagliptin|ozempic|semaglutide|trulicity|dulaglutide|mounjaro|tirzepatide|rybelsus)\b/i, why: 'a diabetes med' },
  { condition: 'chronic lung disease', re: /\b(spiriva|tiotropium|trelegy|breo|symbicort|advair|anoro|incruse|albuterol)\b/i, why: 'an inhaler' },
];

/** Possible C-SNP conditions suggested by listed meds — a flag only. */
function csnpHintsFromMeds(medNames) {
  const names = (medNames || []).map(String);
  const out = [];
  for (const h of CSNP_HINTS) {
    const drug = names.find((n) => h.re.test(n));
    if (drug) out.push({ condition: h.condition, drug, why: h.why });
  }
  return out;
}

/** "atorvastatin" and "Atorvastatin Calcium 20 MG" are the same listed med. */
function sameDrug(a, b) {
  const x = String(a || '').toLowerCase().trim();
  const y = String(b || '').toLowerCase().trim();
  if (!x || !y) return false;
  const head = (s) => s.split(/[\s/(-]+/)[0];
  return x === y || x.startsWith(y) || y.startsWith(x) || head(x) === head(y);
}

/** Meds the agent listed: "Meds: …" sections plus any known drug names in her words. */
function medsFromAsk(askText) {
  const t = String(askText || '');
  const out = [];
  for (const m of t.matchAll(/\b(?:meds?|medications?|rx|drugs?|medicamentos?)\s*:\s*([^\n]+)/gi)) {
    // The list ends at the first sentence break ("… chlorthalidone. Suggest 2-3 plans").
    const list = m[1].split(/\.\s+(?=[A-Z])|\.\s*$|\b(?:compare|suggest|give me|show me|doctors?|drs?|plans?)\s*[:\b]/i)[0];
    list.split(/[,;]|\band\b/).map((s) => s.replace(/\(.*?\)/g, '').replace(/[.\s]+$/, '').trim()).filter((s) => s && s.length > 2 && s.length < 40).forEach((s) => out.push(s));
  }
  for (const h of CSNP_HINTS) {
    const hit = t.match(h.re);
    if (hit && !out.some((o) => sameDrug(o, hit[0]))) out.push(hit[0]);
  }
  return out;
}

// ─── carriers the agent asks for by name ("show me Doctors, Solis, Devoted") ──

const CARRIER_WORDS = [
  ['Doctors HealthCare', /\bdoc?to?r?s?'?\s*(?:health\s*care|healthcare|health|hc|plans?)\b|\bdrmax\b|\bdrselect\b|(?:[,&]|\band\b|\bwith\b)\s*doctors\b(?!\s*:)(?!\s+(?:i|are|is|who|names?|lists?|here|below))|\bdoctors\s*,\s*(?:solis|care\s*plus|uhc|humana|devoted|aetna|simply|wellcare)/i],
  ['Solis', /\bsol[iy]s\b/i],
  ['Devoted', /\b[cd]evoted\b|\bdevote\b/i],
  ['Humana', /\bhumana\b/i],
  ['Aetna', /\baetna\b/i],
  ['UnitedHealthcare', /\buhc\b|\bunited\s*health|\baarp\b|\bmedicaremax\b/i],
  ['Simply', /\bsimply\b/i],
  ['Wellcare', /\bwell\s*care\b/i],
  ['CarePlus', /\bcare\s*plus\b/i],
  ['Florida Blue', /\bflorida blue\b|\bfl blue\b|\bbluemedicare\b/i],
  ['HealthSun', /\bhealth\s*sun\b/i],
];
const REQUEST_VERBS = /\b(show|compare|instead|use|switch|swap|look at|what about|how about|wants?|prefers?|only|give me|pull|run|check|try|those|these)\b/i;

/**
 * Carriers the agent asked to see, from ONE message ("lets instead of these plans
 * show me doctors health, solis, devoted"). [] when the message is not a carrier ask.
 * Doctor lists ("Doctors: …") and pasted plan names with IDs are not carrier asks.
 */
function carriersRequested(message) {
  const t = String(message || '')
    .replace(/\b(?:doctors?|drs?|providers?)\s*:[^\n]*/gi, ' ')
    // "Current plan H1045-005 UHC Preferred MA FL-0002" names her client's plan, it is not a carrier ask.
    .replace(/\b(?:current(?:ly)?|has|is on|on)\s+(?:plan\s*)?(?:is\s*)?:?\s*[^.;\n]*\b[HR]\d{4}-\d{3}[A-Z]?\b[^.;\n]*/gi, ' ')
    .replace(/[^,;.\n]{0,70}\b[HR]\d{4}-\d{3}[A-Z]?\b[^,;.\n]{0,60}/gi, ' ');
  if (!REQUEST_VERBS.test(t)) return [];
  return CARRIER_WORDS.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/** Same carrier names the plan code uses (carrierKey in doctorPlanNarrow). */
function carrierOfPlan(planLike) {
  const p = planLike || {};
  const t = `${p.carrier || ''} ${p.planName || p.name || ''}`;
  for (const [name, re] of CARRIER_WORDS) if (re.test(t)) return name;
  if (/\bdoctors\b/i.test(t)) return 'Doctors HealthCare';
  return '';
}

// ─── money helpers (only exact grid / lookup dollars; ranges and blanks stay unknown) ─

function exactDollars(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^\$\s*(\d+(?:\.\d+)?)(?:\s*\(.*\))?$/);
  return m ? Number(m[1]) : null;
}

module.exports = {
  COMPARISON_TABLE_RULES,
  UNCHECKED,
  NOT_CONFIRMED_CELL,
  UNKNOWN_LEGEND,
  LEGEND,
  MEDS_LEGEND,
  IN_STAR_LEGEND,
  RANK_ORDER,
  POSSIBLE_CSNP,
  loadGrid,
  setGridForTests,
  countyForZip,
  countyFromAsk,
  gridPlansForCounty,
  snpKind,
  networkType,
  levelsIn,
  eligibilityFromAsk,
  planEligibility,
  csnpHintsFromMeds,
  medsFromAsk,
  sameDrug,
  exactDollars,
  CARRIER_WORDS,
  carriersRequested,
  carrierOfPlan,
};
