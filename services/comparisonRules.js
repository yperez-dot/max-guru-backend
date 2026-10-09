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
const { requestedForm, expandDosageForms } = require('./drugNames');

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
6. COUNT FORMAT: Never show "X/7". Always show "X in · Y not in network · Z unchecked" per plan (add "· N not confirmed" when any). A doctor checked in the carrier's directory and not listed for that plan is "❌ Not in network (not listed)" — say "Not listed in [carrier]'s directory for this plan"; never suggest the doctor may still be in. The carrier's public directory is the same one members and brokers use.
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
17. THE GRID IS THE SOURCE OF TRUTH: plan names and plan IDs from the THEI 2027 grid are verified. Never retract them or call them "unverified".
18. AGENT-REQUESTED SNPs: when the agent asks to run / include C-SNPs (or D-SNPs) for a condition, treat the condition (or Medicaid) as agent-confirmed for that run — she confirms eligibility at enrollment. Never refuse; run her doctors and meds on those plans.
19. DIRECTORY SOURCES: never explain how a directory was searched (guest / member / login) in a reply. A doctor checked and not listed is "Not listed in [carrier]'s directory for this plan".
Never invent plan rankings or eligibility. When the server tool result already contains a DOCTOR × PLAN TABLE and a "Why these plans" line, copy them as-is.
`;

const UNCHECKED = '❔ unchecked';
// Checked in the carrier's official directory (the same directory members and brokers use) and not
// listed for this plan. Never shown for a failed or skipped check.
const NOT_LISTED_CELL = '❌ Not in network (not listed)';
const NOT_CONFIRMED_CELL = '❔ not confirmed';
// Same unknown wording in the doctor and drug legends (rule 9).
const UNKNOWN_LEGEND = '❔ unchecked = never checked · ❔ not confirmed = checked, no result';
const LEGEND = `✅ In · ${NOT_LISTED_CELL} = checked in the carrier's directory, not listed for this plan · ${UNKNOWN_LEGEND} (never assume not in network unless checked)`;
const IN_STAR_LEGEND = '✅ In* = in the carrier network; confirm this specific plan in the carrier directory';
const MEDS_LEGEND = `T = tier (covered) · PA = prior auth · ST = step therapy · QL = quantity limit · ❌ not covered · ⚠️ confirm = read not covered, check the exact product in Sunfire · ${UNKNOWN_LEGEND}`;
// Every drug lookup failed: nothing to price, so drug cost must not rank plans (2026-10-09).
const MEDS_FAILED_BANNER = '🛑 **Medication lookup failed — do not rank by drug cost**';
const MEDS_UNREADABLE = "⚠️ Couldn't read the medication list. Re-send as 'Meds: a, b, c'";
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
// "run her drs on the csnps with cardiovascular disorders" / "include the D-SNPs": the agent asks for
// those plans by name — she confirms the condition / Medicaid at enrollment, so for this run it counts
// as agent-confirmed (Maura Soley, 2026-10-07: Max refused with "no qualifying condition is confirmed").
const CSNP_RUN_RE = /^Run C-SNPs\b|\b(?:run|include|check|show|use|add|try|look\s*at|compare|price|pull)\b[^.\n]{0,40}\bc-?snps?\b|\bc-?snps?\b[^.\n?]{0,20}\b(?:with|for)\s+(?:her|his|the|a)?\s*[a-z][^?]*$/i;
const DSNP_RUN_RE = /\b(?:run|include|check|show|use|add|try|look\s*at|compare|price|pull)\b[^.\n]{0,40}\bd-?snps?\b/i;
const CONDITION_WORDS = [
  ['heart', /\b(cardio\w*|heart|chf|afib|a-?fib|atrial|arrhythm\w*|coronary|cad|vascular|hypertension|cardiac)\b/i, /heart|cardi|coronary|arrhythm|vascular|afib/i],
  ['diabetes', /\bdiabet\w*\b/i, /diabet/i],
  ['lung', /\b(copd|lung|asthma|pulmonary|respiratory)\b/i, /lung|copd|asthma|pulmon|respir/i],
  ['kidney', /\b(kidney|renal|esrd|ckd|dialysis)\b/i, /kidney|renal|esrd|dialysis/i],
  ['dementia', /\b(dementia|alzheimer\w*)\b/i, /dementia|alzheimer/i],
];
function csnpRunAsk(text) {
  const t = String(text || '');
  return CSNP_RUN_RE.test(t) && !/\b(no|not|without|exclude|skip)\s+(?:the\s+)?c-?snps?\b/i.test(t);
}
function dsnpRunAsk(text) {
  const t = String(text || '');
  return DSNP_RUN_RE.test(t) && !/\b(no|not|without|exclude|skip)\s+(?:the\s+)?d-?snps?\b/i.test(t);
}
function conditionsIn(text) {
  return CONDITION_WORDS.filter(([, re]) => re.test(String(text || ''))).map(([k]) => k);
}

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

  const out = { medicaid, levels, csnp };
  if (csnpRunAsk(askText) && csnp !== 'none') {
    out.csnp = 'confirmed';
    out.csnpAgentConfirmed = true;
    out.csnpOnly = true;
    out.conditions = conditionsIn(askText);
  }
  if (dsnpRunAsk(askText) && medicaid === 'unknown') {
    out.medicaid = 'full';
    out.levels = ['FBDE'];
    out.dsnpAgentConfirmed = true;
  }
  return out;
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
    if (elig.csnp === 'confirmed') {
      // Her condition decides which C-SNPs fit (grid "chronicConditions"); a plan with no list stays in.
      const conds = Array.isArray(elig.conditions) ? elig.conditions : [];
      const list = String(planLike.chronicConditions || '');
      if (conds.length && list) {
        const fits = CONDITION_WORDS.filter(([k]) => conds.includes(k)).some(([, , planRe]) => planRe.test(list));
        if (!fits) return { status: 'excluded', kind, reason: `C-SNPs — not for ${conds.join(' / ')}` };
      }
      return { status: 'eligible', kind };
    }
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

/** "atorvastatin" and "Atorvastatin Calcium 20 MG" are the same listed med; "acyclovir tablets" and "acyclovir ointment" are not. */
function sameDrug(a, b) {
  const x = String(a || '').toLowerCase().trim();
  const y = String(b || '').toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const fx = requestedForm(x);
  const fy = requestedForm(y);
  if (fx && fy && fx !== fy) return false;
  const head = (s) => s.split(/[\s/(-]+/)[0];
  return x.startsWith(y) || y.startsWith(x) || head(x) === head(y);
}

/** Meds the agent listed: "Meds: …" sections plus any known drug names in her words. */
// Reply words that are never a medication ("both", "yes", "same") — a numbered answer
// like "2. both" must not become a drug lookup / export row (Gail Carreno, 2026-10-07).
const NON_DRUG_WORDS = new Set(
  'both all none no nope yes yeah yep ok okay sure same correct right wrong those these them they it this that either neither each other others another any meds med medication medications drug drugs rx generic brand unknown na idk she he her his their unchanged covered'.split(' ')
);

function isNonDrugAnswer(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s/-]+/g, ' ').split(/[\s/]+/).filter(Boolean);
  return !words.length || words.every((w) => NON_DRUG_WORDS.has(w));
}

// Labels agents put before a med list, English and Spanish, with or without a colon.
const MED_LABEL = '(?:meds?|medications?|medicines?|rx|drugs?|takes?|taking|medicamentos?|medicinas?)';
// Labels that are a med list even with one drug and no colon ("Takes Eliquis"). "Rx" / "drugs"
// without a colon need two items ("Rx tiers", "drug cost" are not lists).
const STRONG_LABEL_RE = /^(?:meds?|medications?|medicines?|takes?|taking|medicamentos?|medicinas?)$/i;
// First words that start a sentence, never a drug ("Meds already on file", "Rx tiers are discarded").
const NOT_DRUG_START_RE = /^(?:no|none|not|already|on|off|file|list|lists|cost|costs|tier|tiers|the|a|an|for|are|is|was|were|of|to|in|with|at|from|covered|coverage|lookup|check|table|section|please|review|or|that|this|any|every|each|below|above|she|he|they|her|his|their|will|can|should|has|have|had|given|listed|named|priced|here|there|medicaid|plan|plans|compare|zip|doctor|doctors|dr|drs|current|currently|wondering|looking|want|wants|need|needs|msp|qmb|slmb|c-?snp|d-?snp|care|same|unchanged|rank|run|show|give|find|add|look|send|use|call|keep|swap|suggest|best|top|all|only|just|yes|ok|okay)$/i;
const DRUG_ITEM_RE = /^[A-Za-z][A-Za-z0-9'’-]*(?:\s+[A-Za-z0-9.%/'’-]+){0,4}$/;
// With no label at all, an item is a drug name plus at most a strength / form / release word
// ("metformin 500mg", "acyclovir ointment") — never a sentence ("Rank all eligible plans").
const UNLABELED_ITEM_RE = /^[A-Za-z][A-Za-z0-9-]*(?:\s+(?:\d+(?:\.\d+)?\s?(?:mg|mcg|ml|units?|iu)|er|xr|sr|hcl|[a-z]+))?(?:\s+\d+\s?(?:mg|mcg|ml))?$/;

/** "esomeprazole, rasuvostatin, acyclovir tablets & ointment" → one item per drug and per dosage form. */
function splitMedList(list) {
  const out = [];
  for (const seg of String(list || '').split(/[,;]/)) {
    const s = seg.replace(/\(.*?\)/g, '').replace(/[.\s]+$/, '').trim();
    if (!s) continue;
    const forms = expandDosageForms(s);
    const parts = forms.length > 1 ? forms : s.split(/\band\b|\s&\s|\s\+\s|\sy\s/i);
    for (const p of parts) {
      const item = p.replace(/[.\s]+$/, '').trim();
      if (item) out.push(item);
    }
  }
  return out;
}

const looksLikeDrugItem = (s) => DRUG_ITEM_RE.test(s) && !NOT_DRUG_START_RE.test(s.split(/\s+/)[0]) && !isNonDrugAnswer(s);

/**
 * Meds typed as a plain list with no label (ported from compareJobs, 2026-10-09):
 * "… 33076. Ashwin Mehta. Eliquis, metformin 500mg. No medicaid." The run of drug-like items at the
 * end of a sentence counts when everything before it in that sentence is a capitalized name
 * ("…, Dr. Zuhdiyah Darojat, esomeprazole, rasuvostatin").
 */
function unlabeledMeds(t, zip, doctors) {
  if (!zip) return [];
  const at = t.indexOf(zip);
  if (at < 0) return [];
  const rest = t.slice(at + zip.length).replace(/^[\s.,;:\-–—]+/, '').replace(/\b(?:Drs?|Dras?|Doc)\.\s*(?=[A-Za-z])/gi, '');
  const docNames = new Set((doctors || []).map((d) => String(d.name || d).toLowerCase()));
  const isName = (x) => /^[A-Z][a-z'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z'’-]+)+$/.test(x) || docNames.has(x.toLowerCase());
  for (const sentence of rest.split(/(?<!\b[A-Za-z])\.\s+(?=[A-Za-z])|\n/)) {
    const body = sentence.replace(/^\s*(?:takes?|taking|on|meds?|rx)\s*:?\s+/i, '').replace(/[\s.]+$/, '');
    // "…, Medications esomeprazole, …": the label glued to the first drug is not part of its name.
    const items = splitMedList(body).map((x) => x.replace(new RegExp(`^${MED_LABEL}\\s*:?\\s+`, 'i'), ''));
    if (!items.length || items.length > 20) continue;
    let k = items.length;
    while (k > 0 && UNLABELED_ITEM_RE.test(items[k - 1]) && looksLikeDrugItem(items[k - 1]) && !isName(items[k - 1]) && !NOT_MED_RE.test(items[k - 1])) k -= 1;
    const drugs = items.slice(k);
    if (!drugs.length) continue;
    // Everything before the run must be names (doctors); otherwise this sentence is not a med list.
    if (k > 0 && !items.slice(0, k).every(isName)) continue;
    if (k > 0 && drugs.length < 2) continue;
    return drugs;
  }
  return [];
}

const NOT_MED_RE = /^(?:no|none|not|medicaid|plan|plans|compare|they|their|for|add|has|have|she|he|c-?snp|d-?snp|zip|current|currently|wondering|looking|want|wants|need|needs|please|msp|qmb|slmb|diabetes|chf|copd)\b/i;

function medsFromAsk(askText) {
  const t = String(askText || '');
  const out = [];
  const add = (s) => { if (s && s.length > 2 && s.length < 40 && !isNonDrugAnswer(s) && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s); };
  // "Meds: a, b" / "Medications a, b" / "Medicamentos: a y b" / "Takes a, b" — colon optional
  // (Martin Wiesenthal, 2026-10-09: "…, Medications esomeprazole, rasuvostatin, …" read 0 meds).
  for (const m of t.matchAll(new RegExp(`(^|[^A-Za-z])(no\\s+)?\\b(${MED_LABEL})\\b(\\s*:\\s*|\\s+)([^\\n]+)`, 'gi'))) {
    if (m[2]) continue; // "no meds"
    const label = m[3];
    const colon = m[4].includes(':');
    // The list ends at the first sentence break ("… chlorthalidone. Suggest 2-3 plans").
    const list = m[5].split(/\.\s+(?=[A-Z])|\.\s*$|\b(?:compare|suggest|give me|show me|doctors?|drs?|plans?)\s*[:\b]/i)[0];
    const items = splitMedList(list);
    if (colon) {
      items.forEach(add);
      continue;
    }
    // No colon: only a real list of drug names counts ("Rx tiers are discarded" is not one).
    if (!items.length || !items.every(looksLikeDrugItem)) continue;
    if (items.length < 2 && !STRONG_LABEL_RE.test(label)) continue;
    items.forEach(add);
  }
  // A list under a header — the loaded workup writes "Medications (tiers shown …):" then one
  // "- Atorvastatin 20mg: H1036-054C Tier 1 …" bullet per med. The one-line pattern above saw
  // nothing after the colon, so a loaded client's meds were never priced (Victor, 2026-10-08).
  for (const m of t.matchAll(/^\s*(?:meds?|medications?|rx|drugs?|medicamentos?)\b[^\n:]*:\s*\n((?:[ \t]*[-•*][^\n]*(?:\n|$))+)/gim)) {
    for (const line of m[1].split('\n')) {
      const name = line.replace(/^\s*[-•*]\s*/, '').split(/:\s/)[0].replace(/\(.*?\)/g, '').replace(/[.\s]+$/, '').trim();
      if (name && name.length > 2 && name.length < 40 && !isNonDrugAnswer(name) && !out.some((o) => sameDrug(o, name))) out.push(name);
    }
  }
  // MedicarePro "Prescriptions (5)" paste: one "atorvastatin calcium TAB 10MG" line per drug (with
  // "30/Monthly", "Quotable", dates around it). Name + dosage form + strength → "Atorvastatin Calcium 10mg"
  // (Victor, 2026-10-08: none of his 5 meds were read).
  const FORM = '(?:TAB|TABS|TABLET|CAP|CAPS|CAPSULE|TBEC|TBDR|CPDR|CPEP|TB24|TB12|CP24|CP12|SOL|SOLN|SUSP|INJ|PEN|CREAM|OINT|GEL|PATCH|INH|AERO|SPR|SPRAY|DROPS?|LIQ|POWD|PACK)';
  const rxLine = new RegExp(`^\\s*([A-Za-z][A-Za-z\\- ]{2,40}?)\\s+${FORM}\\b[^\\d\\n]{0,20}(\\d+(?:\\.\\d+)?)\\s*(MG|MCG|G|ML|UNITS?|%)\\b`, 'gim');
  for (const m of t.matchAll(rxLine)) {
    const base = m[1].trim().toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
    const name = `${base.replace(/\bHcl\b/, 'HCl')} ${m[2]}${m[3].toLowerCase()}`;
    if (!isNonDrugAnswer(name) && !out.some((o) => sameDrug(o, name))) out.push(name);
  }
  // Nothing labeled: a plain list after the ZIP and the doctors.
  if (!out.length) {
    const zip = (t.match(/\b(\d{5})\b/) || [])[1] || '';
    unlabeledMeds(t, zip, []).forEach(add);
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
// "add doctors, devoted, and aetna to her plan comp" is a carrier ask too (Gail, 2026-10-08).
const REQUEST_VERBS = /\b(show|compare|instead|use|switch|swap|look at|what about|how about|wants?|prefers?|only|give me|pull|run|check|try|those|these|add|include|plus|also)\b/i;

// "HUMANA WONT WORK", "not Humana", "other than Humana", "instead of Humana" — a carrier
// she rules out. Words right after the carrier name, or right before it.
const REJECT_AFTER_RE = /^[^.!?\n]{0,25}?\b(?:won'?t|wont|will\s+not|doesn'?t|does\s+not|didn'?t|did\s+not|isn'?t|is\s+not|aren'?t|are\s+not|can'?t|cannot|not\s+going\s+to)\s+(?:\w+\s+)?(?:work|do|cut|be|cover|take|accept|help|fit|an?\s+option)\b|^\W*(?:is|are)?\s*(?:out|no\s+good|a\s+no|not\s+an?\s+option|off\s+the\s+table)\b/i;
const REJECT_BEFORE_RE = /\b(?:no|not|other\s+than|besides|except|excluding|exclude|leave\s+out|remove|instead\s+of|anything\s+but|skip|drop|forget|without|no\s+more|rather\s+than)\s+(?:the\s+|all\s+)?$/i;

/** Carriers she rules out in ONE message ("YIKES, HUMANA WONT WORK THEN") → ['Humana']. */
function carriersRejected(message) {
  const t = String(message || '').replace(/\b(?:doctors?|drs?|providers?)\s*:[^\n]*/gi, ' ');
  const out = [];
  for (const [name, re] of CARRIER_WORDS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of t.matchAll(g)) {
      const start = m.index;
      const end = start + m[0].length;
      // "Drop MedicareMax H5420-001" / "remove Humana Gold Plus" / "drop DrMax" names ONE plan, not the
      // carrier: a plan drop, never "another carrier" (Maura, 2026-10-07 5:20 PM: UHC was excluded and
      // her current UHC plan H1045-001 left the table).
      const clauseAfter = t.slice(end).split(/[.;!?\n]/)[0].slice(0, 60);
      if (/^(?:medicaremax|drmax|drselect)$/i.test(m[0].trim()) || /\b[HR]\d{4}-\d{3}/i.test(clauseAfter)
        || /^\s+(?:gold\s+plus|medicare\s+\w+|preferred|choice|select|complete|core|giveback|value|max|plus|care\s*\w*)\b/i.test(clauseAfter)) continue;
      if (REJECT_AFTER_RE.test(t.slice(end, end + 50)) || REJECT_BEFORE_RE.test(t.slice(Math.max(0, start - 25), start))) {
        if (!out.includes(name)) out.push(name);
        break;
      }
    }
  }
  return out;
}

/** "check on another plan", "a different carrier", "something else" — she wants other carriers' plans. */
const OTHER_CARRIER_RE = /\b(?:an)?other\s+(?:plans?|carriers?|compan(?:y|ies)|insurances?|insurers?|options?|networks?)\b|\bdifferent\s+(?:plans?|carriers?|compan(?:y|ies)|insurances?|insurers?|options?|networks?)\b|\bsomething\s+else\b|\bsomewhere\s+else\b/i;
function wantsOtherCarrier(message) {
  return OTHER_CARRIER_RE.test(String(message || '').replace(/\b(?:doctors?|drs?|providers?)\s*:[^\n]*/gi, ' '));
}

/**
 * Carriers the agent asked to see, from ONE message ("lets instead of these plans
 * show me doctors health, solis, devoted"). [] when the message is not a carrier ask.
 * Doctor lists ("Doctors: …") and pasted plan names with IDs are not carrier asks.
 */
function carriersRequested(message) {
  const t = String(message || '')
    .replace(/\b(?:doctors?|drs?|providers?)\s*:[^\n]*/gi, ' ')
    // "Current plan H1045-005 UHC Preferred MA FL-0002" names her client's plan, it is not a carrier ask.
    // No commas inside: "Current plan H1045-005 UHC Preferred" is her client's plan, but
    // "compare his current plan with Humana, HealthSun and Doctors" is a carrier ask (2026-10-07).
    .replace(/\b(?:current(?:ly)?|has|is on|on)\s+(?:plan\s*)?(?:is\s*)?:?\s*[^.;,\n]*\b[HR]\d{4}-\d{3}[A-Z]?\b[^.;,\n]*/gi, ' ')
    // A carrier word glued to a plan name ("Humana Gold Plus H1036-065C") is not an ask, but one
    // in a list ("Humana, HealthSun and Doctors (DrSelect H4140-023)") is — so stop at and/with/&.
    .replace(/(?:(?!\band\b|\bwith\b|&)[^,;.\n]){0,70}\b[HR]\d{4}-\d{3}[A-Z]?\b[^,;.\n]{0,60}/gi, ' ');
  if (!REQUEST_VERBS.test(t)) return [];
  // "HUMANA WONT WORK THEN. check on another plan" rules Humana out — it is not a Humana ask.
  const rejected = carriersRejected(message);
  return CARRIER_WORDS.filter(([name, re]) => re.test(t) && !rejected.includes(name)).map(([name]) => name);
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

/**
 * Meds already in the thread (loaded workup, pasted list, earlier answer) → a short system note so the model
 * never asks for them again or says the workup has none (Paula Harris, 2026-10-08: "i gave them to you already").
 */
function knownMedsNote(messages) {
  try {
    const { comparisonAskText } = require('./doctorPlanNarrow');
    const { conversationAskText } = require('./planYear');
    const msgs = Array.isArray(messages) ? messages : [];
    const meds = medsFromAsk(comparisonAskText(msgs, conversationAskText(msgs)));
    if (!meds.length) return '';
    return `\nMEDS ALREADY ON FILE FOR THIS CLIENT (from the loaded workup or her messages): ${meds.join('; ')}. Never ask her for medications and never say the workup has none — price these with lookup_formulary against the plans in the table.`;
  } catch (_) {
    return '';
  }
}

module.exports = {
  csnpRunAsk,
  dsnpRunAsk,
  conditionsIn,
  NOT_LISTED_CELL,
  COMPARISON_TABLE_RULES,
  UNCHECKED,
  NOT_CONFIRMED_CELL,
  UNKNOWN_LEGEND,
  LEGEND,
  MEDS_LEGEND,
  MEDS_FAILED_BANNER,
  MEDS_UNREADABLE,
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
  unlabeledMeds,
  splitMedList,
  knownMedsNote,
  isNonDrugAnswer,
  sameDrug,
  exactDollars,
  CARRIER_WORDS,
  carriersRequested,
  carriersRejected,
  wantsOtherCarrier,
  carrierOfPlan,
};
