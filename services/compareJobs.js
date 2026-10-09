// services/compareJobs.js — Client Comparison mode.
//
// Comparisons don't go through the chat model. The agent's ask is parsed into
// fields (client, ZIP, doctors, meds, plans), then one background job runs every
// doctor and drug lookup in parallel and reports progress. No chat wait, no
// model timeouts, no plan dumps. Chat stays for questions.

const crypto = require('crypto');
const { lookupDoctor, NOT_CONFIRMED } = require('./providerNetwork');
const { lookupFormulary, toExportDrug, toExportDrugs, formatFormularyText } = require('./formularyLookup');
const { askConstraints, gridTable, medsTable, selectComparison, strengthNotes } = require('./doctorPlanNarrow');
const { eligibilityFromAsk, carriersRequested, LEGEND, MEDS_LEGEND, MEDS_FAILED_BANNER, IN_STAR_LEGEND, unlabeledMeds: unlabeledMedsList } = require('./comparisonRules');
const { expandMedList } = require('./drugNames');

// Candidates priced before the final top 3, so drug cost can break ties (rule 3).
const RX_SHORTLIST = Number(process.env.MAX_COMPARE_RX_SHORTLIST || 6);

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const RX_CACHE_MS = Number(process.env.MAX_RX_CACHE_MS || 24 * 60 * 60 * 1000);
const DOCTOR_BUDGET_MS = Number(process.env.MAX_COMPARE_DOCTOR_BUDGET_MS || 90_000);
const DRUG_CONCURRENCY = Number(process.env.MAX_COMPARE_DRUG_CONCURRENCY || 4);
const MAX_DOCTORS = 15;
const MAX_MEDS = 20;
const MAX_PLANS = 6; // same cap as the UI (max-demo MAX_PLANS) — a 5th named plan was silently dropped

// "wondering if there's something better", "other options", "alternatives" → keep her plan as a column AND shop the county.
const ALTERNATIVES_RE = /\b(?:something|anything|options?|plans?)\s+(?:that(?:'s| is)\s+)?better\b|\bbetter\s+(?:options?|plans?|fit|deal)\b|\bother\s+(?:options?|plans?)\b|\balternatives?\b|\bsee\s+what\s+else\b|\bwhat\s+else\b|\bshop(?:ping)?\s+around\b|\bcompare\s+(?:it\s+)?(?:to|against|with)\s+others?\b|\bsomething\s+else\b/i;

const PLAN_ID_RE = /\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi;

// ─── parse ──────────────────────────────────────────────────────────────────

function splitList(text) {
  return String(text || '')
    .split(/\n|,|;|\band\b(?=\s+[A-Z])/)
    .map((s) => s.replace(/^[\s\-•*\d.)]+/, '').trim())
    .filter((s) => s && s.length > 1);
}

function section(text, label, stops) {
  const re = new RegExp(`\\b${label}\\s*:\\s*([\\s\\S]*?)(?=(?:\\b(?:${stops.join('|')})\\s*:)|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

// Plan ids as agents paste them: "H1045-5-0", "H1045-005-0", "H1045-5" → "H1045-005".
function normalizePlanIds(text) {
  return String(text || '').replace(/\b([HR]\d{4})-(\d{1,3})(?:-\d)?(?=[^\dA-Za-z-]|$)/gi, (m, a, b) => `${a.toUpperCase()}-${b.padStart(3, '0')}`);
}

const TITLE_SKIP = new Set(['and', 'y', '&']);

/** Free-form paste with no strict capitalization: "Marilyn and Angus butler. 33076. …" → "Marilyn and Angus Butler". */
function looseClientName(t) {
  // "Mr. and Mrs. Mazzeo" / "The Mazzeos" / "Mazzeo family" → keep the titles, drop the filler; the dots in Mr./Mrs. are not sentence ends.
  // "New client: Victor Rocha, ZIP …" — the label (with its colon) is not the name (Victor, 2026-10-08).
  const src = String(t || '').replace(/^\s+/, '').replace(/^(?:new\s+)?(?:client|patient|cliente)\s*[:\-–—]\s*/i, '').replace(/\b(Mr|Mrs|Ms|Miss)\.(?=\s)/gi, '$1');
  const head = src.split(/[\d\n,;:]|\.(?=\s|$)/)[0].replace(/\bzip(?:\s*code)?\s*$/i, '').replace(/^\s*(?:the|new client|client)\s+/i, '').replace(/\s+family\s*$/i, '').trim();
  if (!head || head.length > 70) return '';
  const words = head.split(/\s+/);
  if (words.length > 6) return '';
  if (!words.every((w) => /^[A-Za-z][A-Za-z'’-]*$|^&$/.test(w))) return '';
  if (/^(?:doctors?|drs?|meds?|medications?|compare|please|can|could|hi|hello|new|client|zip|plan|plans|current|show|add|check|look|find|help|she|he|they|his|her|their|no|none)$/i.test(words[0])) return '';
  // One word is a family name ("Mazzeos", "Mazzeo") — only when it clearly opens the paste, i.e. a delimiter followed it.
  if (words.length === 1 && (words[0].length < 3 || !/^[A-Za-z][A-Za-z'’-]+$/.test(words[0]))) return '';
  return words.map((w) => (TITLE_SKIP.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ').replace(/\b(Mr|Mrs|Ms)\b(?!\.)/g, '$1.');
}

/** Doctors typed as a plain list right after the ZIP: "33076. Ashwin Mehta, Jorge G. Ruiz, … no meds." */
function unlabeledDoctors(t, zip) {
  if (!zip) return '';
  const at = t.indexOf(zip);
  if (at < 0) return '';
  let rest = t.slice(at + zip.length).replace(/^[\s.,;:\-–—]+/, '').replace(/\b(?:Drs?|Dras?|Doc)\.\s*(?=[A-Za-z])/gi, '');
  rest = rest.split(/(?<!\b[A-Za-z])\.\s+(?=[A-Za-z])|\n\s*\n/)[0];
  const items = rest.split(/\n|,|;|\band\b(?=\s+[A-Z])/).map((x) => x.replace(/^[\s\-•*\d.)]+/, '').replace(/[\s.]+$/, '').trim()).filter(Boolean);
  const looksLikeName = (x) => {
    const w = x.replace(/\b(?:Drs?|Dras?|Doc)(?:\.\s*|\s+)/i, '').split(/\s+/);
    return w.length >= 2 && w.length <= 5 && /^[A-Z]/.test(w[0]) && /^[A-Z]/.test(w[w.length - 1]) && w.every((y) => /^[A-Za-z][A-Za-z.'’-]*$/.test(y)) &&
      !/^(?:no|none|meds?|medicaid|they|for|has|have|she|he|compare|add)\b/i.test(x);
  };
  const good = items.filter(looksLikeName);
  if (!good.length || good.length * 2 < items.length) return '';
  return good.join('\n');
}

const MED_WORD_RE = /^(?:meds?|medications?|medicines?|rx|drugs?|takes?|taking|medicamentos?|medicinas?|zip|plans?|compare|no|and|y)$/i;

/**
 * Doctors named with a title anywhere in the ask, no "Doctors:" label needed:
 * "Dr.Steven Barilla, Dr. Matthew Soff, Dra. Ana Ruiz, Doctora María López" (Martin Wiesenthal,
 * 2026-10-09: three doctors shared a sentence with six meds, so the plain-list reader saw too few names).
 */
function titledDoctors(t) {
  const out = [];
  const re = /\b(?:Dr|Dra|Drs|Dras|Doc|Doctor|Doctora)\b\.?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÿ'’-]+(?:\s+[A-Z]\.)?(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÀ-ÿ'’-]+){0,3})/g;
  for (const m of String(t || '').matchAll(re)) {
    const words = m[1].split(/\s+/);
    while (words.length && MED_WORD_RE.test(words[words.length - 1])) words.pop();
    const name = words.join(' ').trim();
    if (words.length >= 2 && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.join('\n');
}

/** Meds typed as a plain list after the ZIP/doctors — one reader shared with the chat path (comparisonRules). */
function unlabeledMeds(t, zip, doctors) {
  return unlabeledMedsList(t, zip, doctors).join('\n');
}

/** "Maria & Gaspar Padron, ZIP 33332 … Doctors: … Meds: … Compare H… " → fields. */
function parseCompareAsk(text) {
  const t = normalizePlanIds(String(text || '').replace(/\r/g, ''));
  const stops = ['doctors?', 'drs?', 'providers?', 'meds?', 'medications?', 'rx', 'drugs?', 'plans?', 'compare'];
  const constraints = askConstraints(t);

  const zip = (t.match(/\b(?:zip\s*(?:code)?\s*:?\s*)?(\d{5})\b/i) || [])[1] || '';
  const clientMatch = t.replace(/^\s*(?:new\s+)?(?:client|patient|cliente)\s*[:\-–—]\s*/i, '').match(/^\s*([A-Z][a-z]+(?:\s*(?:&|and|y)\s*[A-Z][a-z]+)?\s+[A-Z][A-Za-z'-]+)/);
  const strictName = clientMatch ? clientMatch[1].replace(/\s+/g, ' ').trim() : '';
  const looseName = looseClientName(t);
  const clientName = (looseName && looseName.toLowerCase().startsWith(strictName.toLowerCase()) ? looseName : (strictName || looseName)).replace(/^the\s+/i, '');
  const terminatingPlan = ((t.match(/\b([HR]\d{4}-\d{3}[A-Z]?)\b[^.\n]{0,25}?\b(?:terminat|ending)/i) || [])[1] || '').toUpperCase();

  let doctorsText = section(t, '(?:doctors?|drs?|providers?)', stops.filter((s) => !/doctor|dr|provider/.test(s)));
  let medsText = section(t, '(?:meds?|medications?|rx|drugs?)', stops.filter((s) => !/med|rx|drug/.test(s)));
  // Trim trailing sentences ("… Compare Humana …", "Give me 2-3 plans")
  const cut = (s) => s.split(/(?<!\b[A-Za-z])\.\s+(?=[A-Z])|\bcompare\b|\bgive me\b|\bsuggest\b|\bshow me\b/i)[0];
  // "Dr. Jorge Perez" must not be cut at the period after "Dr" (it left the doctor named just "Dr").
  if (!doctorsText) {
    // Plain list after the ZIP, plus every titled name ("Dr.Steven Barilla", "Dra. María López").
    const names = [];
    for (const n of [...unlabeledDoctors(t, zip).split('\n'), ...titledDoctors(t).split('\n')]) {
      const k = n.trim().toLowerCase();
      if (k && !names.some((x) => x.toLowerCase() === k)) names.push(n.trim());
    }
    doctorsText = names.join('\n');
  }
  doctorsText = doctorsText.replace(/\b(?:Drs?|Dras?|Doc)(?:\.\s*|\s+)(?=[A-Za-z])/gi, '');
  doctorsText = cut(doctorsText);
  medsText = cut(medsText);
  if (!medsText) {
    // "Medications esomeprazole, …" (label, no colon) before the unlabeled-list fallback.
    const labeled = require('./comparisonRules').medsFromAsk(t);
    medsText = labeled.length ? labeled.join('\n') : unlabeledMeds(t, zip, splitList(doctorsText).map((name) => ({ name })));
  }

  // "Carlos Santa-Cruz, MD (Urology, Coral Gables)": the commas inside the parentheses and the
  // credential after the name are not doctors of their own (Victor, 2026-10-08: 3 doctors read as 5).
  const CRED_ONLY_RE = /^(?:md|m\.d\.?|do|d\.o\.?|dpm|dds|dmd|od|np|pa|pa-c|aprn|arnp|phd|facc|facp|facs)\.?$/i;
  const doctors = splitList(doctorsText.replace(/\([^)]*,[^)]*\)/g, ' ')).filter((x) => !CRED_ONLY_RE.test(x.trim())).map((raw) => {
    const mustKeep = /must[- ]?keep/i.test(raw);
    let name = raw.replace(/\(?\s*must[- ]?keep\s*\)?/i, '');
    // "Rundeep Singh Gadh NPI 1407095615 (PCP)" — pull the NPI out so the lookup uses it
    // instead of searching for a name with ten digits glued on (Yahoska, 2026-10-07).
    let npi;
    const m = name.match(/\b(?:npi\s*#?\s*:?\s*)?(\d{10})\b/i);
    if (m) {
      npi = m[1];
      name = name.replace(m[0], ' ').replace(/\bnpi\b\s*#?\s*:?/i, ' ');
    }
    name = name.replace(/\s{2,}/g, ' ').replace(/[\s.,-]+$/, '').trim();
    return npi ? { name, npi, mustKeep } : { name, mustKeep };
  }).filter((d) => d.name || d.npi).slice(0, MAX_DOCTORS);
  // "acyclovir tablets & ointment" is two products, two rows.
  let meds = expandMedList(splitList(medsText).map((m) => m.replace(/\.$/, ''))).slice(0, MAX_MEDS);
  // A pasted MedicarePro "Prescriptions (5)" block ("atorvastatin calcium TAB 10MG" lines) — the
  // section parser above caught only the first line (Victor, 2026-10-08). Use the full Rx-line read.
  const rxMeds = require('./comparisonRules').medsFromAsk(t);
  if (/^\s*[A-Za-z][A-Za-z\- ]{2,40}?\s+(?:TAB|CAP|TBEC|CPDR|TB24|CP24|SOL|SOLN|INJ|PATCH|INH)\b/im.test(t) && rxMeds.length > meds.length) meds = rxMeds.slice(0, MAX_MEDS);
  // "Medications esomeprazole, …" with no colon — the shared reader catches what the section parser missed.
  if (!meds.length && rxMeds.length) meds = rxMeds.slice(0, MAX_MEDS);

  const skip = constraints.skip;
  const plans = [];
  for (const m of t.matchAll(PLAN_ID_RE)) {
    const id = m[1].toUpperCase();
    if (id === terminatingPlan || skip.has(id) || [...skip].some((x) => x.slice(0, 9) === id.slice(0, 9))) continue;
    // H1036-065C and H1036-065 are the same contract-PBP: keep one column.
    if (!plans.some((x) => x.slice(0, 9) === id.slice(0, 9))) plans.push(id);
  }

  return {
    clientName,
    zip,
    doctors,
    meds,
    plans: plans.slice(0, MAX_PLANS),
    terminatingPlan,
    wantsAlternatives: ALTERNATIVES_RE.test(t),
    carriers: carriersRequested(t),
    noMedicaid: constraints.noMedicaid,
    // Medicaid / MSP level / C-SNP condition exactly as the agent stated them (never inferred).
    eligibility: eligibilityFromAsk(t),
    skip: [...skip].filter((id) => id !== terminatingPlan),
    year: /\b2026\b/.test(t) && !/\b2027\b/.test(t) ? 2026 : 2027,
  };
}

// ─── Rx cache (tiers don't change mid-season) ───────────────────────────────

const rxCache = new Map();

async function lookupFormularyCached({ drugName, planIds, year }) {
  const key = `${String(drugName).toLowerCase().trim()}|${year}|${[...planIds].sort().join(',')}`;
  const hit = rxCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await lookupFormulary({ drugName, planIds, year });
  if (value && value.lookups && value.lookups.some((l) => l.verified)) {
    rxCache.set(key, { value, expiresAt: Date.now() + RX_CACHE_MS });
  }
  return value;
}

// ─── jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();

// At most MAX_CONCURRENT comparisons run at once, across everyone. Carrier sites
// (Doctors, Devoted, UHC) are slow and throttle bursts, so extra clients wait their turn
// as status 'queued' with a position, and start automatically as a slot frees up.
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_COMPARE_CONCURRENCY || 2));
let activeRuns = 0;
const waiting = [];

function pumpQueue() {
  while (activeRuns < MAX_CONCURRENT && waiting.length) {
    const { job, deps } = waiting.shift();
    if (job.status !== 'queued') continue;
    activeRuns += 1;
    runJob(job, deps)
      .catch((e) => { job.status = 'error'; job.error = e.message; job.finishedAt = Date.now(); })
      .finally(() => { activeRuns -= 1; pumpQueue(); });
  }
}

function enqueueJob(job, deps) {
  waiting.push({ job, deps });
  pumpQueue();
}

function queuePosition(job) {
  if (job.status !== 'queued') return 0;
  const i = waiting.findIndex((w) => w.job === job);
  return i < 0 ? 0 : i + 1;
}

function queueState() {
  return { active: activeRuns, waiting: waiting.length, limit: MAX_CONCURRENT };
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
}

async function mapPool(items, limit, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    queuePosition: queuePosition(job),
    error: job.error || null,
    input: job.input,
    progress: job.progress,
    result: job.result,
    startedAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
}

const LEVELS = ['FBDE', 'QMB+', 'SLMB+', 'QMB', 'SLMB', 'QI', 'QDWI'];

function normalizeEligibility(e, noMedicaid) {
  const src = e && typeof e === 'object' ? e : {};
  const medicaid = noMedicaid ? 'none' : (['full', 'msp', 'none'].includes(src.medicaid) ? src.medicaid : 'unknown');
  const levels = medicaid === 'none' ? [] : (Array.isArray(src.levels) ? src.levels : []).map((l) => String(l).toUpperCase()).filter((l) => LEVELS.includes(l));
  const csnp = ['confirmed', 'none'].includes(src.csnp) ? src.csnp : 'unknown';
  return { medicaid, levels, csnp };
}

/** Agent-stated eligibility as plain words the selector reads back. */
function eligibilityText(e) {
  const parts = [];
  if (e.medicaid === 'none') parts.push('No Medicaid.');
  if (e.medicaid === 'full') parts.push(`Full Medicaid${e.levels.length ? ` (${e.levels.join(', ')})` : ''}.`);
  if (e.medicaid === 'msp') parts.push(e.levels.length ? `MSP only: ${e.levels.join(', ')}.` : 'MSP only.');
  if (e.csnp === 'confirmed') parts.push('C-SNP eligible.');
  if (e.csnp === 'none') parts.push('No C-SNP qualifying condition.');
  return parts.join(' ');
}

function normalizeInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => (Array.isArray(v) ? v : splitList(v));
  const doctors = list(src.doctors).map((d) => (typeof d === 'string' ? { name: d } : d))
    .filter((d) => d && String(d.name || d.npi || '').trim())
    .map((d) => ({ name: String(d.name || d.npi).trim(), npi: d.npi ? String(d.npi) : undefined, mustKeep: Boolean(d.mustKeep) }))
    .slice(0, MAX_DOCTORS);
  const meds = expandMedList(list(src.meds).map((m) => String(m || '').trim()).filter(Boolean)).slice(0, MAX_MEDS);
  const plans = list(src.plans).map((p) => String(p || '').trim().toUpperCase()).filter((p) => /^[HR]\d{4}-\d{3}[A-Z]?$/.test(p)).slice(0, MAX_PLANS);
  return {
    clientName: String(src.clientName || '').trim().slice(0, 80),
    zip: String(src.zip || '').trim().slice(0, 5),
    doctors,
    meds,
    plans,
    terminatingPlan: String(src.terminatingPlan || '').trim().toUpperCase(),
    noMedicaid: Boolean(src.noMedicaid),
    wantsAlternatives: Boolean(src.wantsAlternatives),
    carriers: list(src.carriers).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 8),
    eligibility: normalizeEligibility(src.eligibility, Boolean(src.noMedicaid)),
    skip: list(src.skip).map((s) => String(s).toUpperCase()),
    year: Number(src.year) === 2026 ? 2026 : 2027,
    planNames: src.planNames && typeof src.planNames === 'object'
      ? Object.fromEntries(Object.entries(src.planNames).slice(0, 10).map(([k, v]) => [String(k).toUpperCase(), String(v || '').slice(0, 80)]))
      : {},
  };
}

/** Plain text of the job inputs, for the doctor/plan helpers that read the ask. */
function askTextFor(input) {
  const parts = [];
  if (input.clientName) parts.push(input.clientName);
  if (input.zip) parts.push(`ZIP ${input.zip}`);
  if (input.terminatingPlan) parts.push(`Current plan ${input.terminatingPlan} terminating ${input.year}.`);
  if (input.noMedicaid) parts.push('No Medicaid.');
  else if (input.eligibility) parts.push(eligibilityText(input.eligibility));
  for (const id of input.skip) parts.push(`Skip ${id}.`);
  if (input.plans.length) parts.push(`Compare ${input.plans.join(', ')}.`);
  if ((input.carriers || []).length) parts.push(`Carriers requested: ${input.carriers.join(', ')}.`);
  return parts.join(' ');
}

async function runJob(job, { lookupOneDoctor = lookupDoctor, lookupRx = lookupFormularyCached } = {}) {
  const input = job.input;
  const askText = askTextFor(input);
  try {
    // 1) Doctors — all at once; progress ticks as each one finishes.
    job.status = 'doctors';
    const deadlineAt = Date.now() + DOCTOR_BUDGET_MS;
    const doctorStructs = await Promise.all(input.doctors.map(async (d) => {
      let r;
      try {
        r = await lookupOneDoctor({ doctorName: d.name, npi: d.npi, zip: input.zip, year: input.year }, { deadlineAt, npiCap: 2 });
      } catch (e) {
        r = { status: 'error', doctorName: d.name, structured: { doctorName: d.name, networks: [] } };
      }
      job.progress.doctors.done += 1;
      return { ...(r.structured || {}), requestedName: d.name, status: r.status, mustKeep: Boolean(d.mustKeep) };
    }));
    job.result.doctors = doctorStructs;

    // 2) + 3) Plans and meds — Doctor/Drug Comparison Table Rules (doctorPlanNarrow.selectComparison).
    // Named plans stay the columns. Otherwise: eligible county pool → rank → top 3, with
    // every listed med priced on the shortlist first so drug cost can break ties and every
    // table plan already has its meds checked (rules 3 + 8).
    const named = input.plans.map((id) => ({ planId: id, name: (input.planNames && input.planNames[id]) || id }));
    // Her plan(s) + "is there something better?": keep them as the first column and shop the county for the rest.
    const pinned = named.length && (input.wantsAlternatives || (input.carriers || []).length) ? named.map((p) => p.planId) : [];
    const planSource = pinned.length ? 'current_plus_alternatives' : named.length ? 'named' : 'top_doctor_coverage';
    let rxPlanIds = named.map((p) => p.planId);
    if (!named.length || pinned.length) {
      const first = selectComparison(doctorStructs, askText, { named: [], meds: input.meds });
      rxPlanIds = [...new Set([...pinned, ...first.ranked.slice(0, RX_SHORTLIST).map((c) => c.planId)])];
    }

    job.status = 'meds';
    job.progress.meds.total = rxPlanIds.length ? input.meds.length : 0;
    const drugResults = new Array(input.meds.length);
    if (rxPlanIds.length && input.meds.length) {
      await mapPool(input.meds, DRUG_CONCURRENCY, async (drugName, i) => {
        try {
          drugResults[i] = await lookupRx({ drugName, planIds: rxPlanIds, year: input.year });
        } catch (e) {
          drugResults[i] = { drugName, error: e.message, lookups: [], byPlanId: {} };
        }
        job.progress.meds.done += 1;
      });
    }
    const drugs = drugResults.filter(Boolean);

    const sel = selectComparison(doctorStructs, askText, pinned.length
      ? { named: [], meds: input.meds, drugs, onlyPlanIds: rxPlanIds, pinPlanIds: pinned }
      : { named, meds: input.meds, drugs, onlyPlanIds: named.length ? undefined : rxPlanIds });
    // Compare-mode headers use the grid marketing names the UI sent.
    const columns = sel.columns.map((c) => ({ ...c, name: (input.planNames && input.planNames[c.planId]) || c.name }));
    const planIds = columns.map((c) => c.planId);
    job.result.planIds = planIds;
    job.result.planSource = planSource;
    job.result.drugs = drugs.map((r) => ({
      drugName: r.drugName,
      byPlanId: r.byPlanId || {},
      notCoveredNote: r.notCoveredNote || null,
      retriedProduct: r.retriedProduct || null,
      export: toExportDrugs(r),
      text: r.lookups ? formatFormularyText(r).slice(0, 1500) : `${r.drugName}: lookup failed (${r.error || 'unknown'})`,
    }));

    // 4) Tables (same look as chat) + the rule lines the UI shows above / below them.
    job.result.header = sel.header;
    job.result.whyLine = sel.whyLine;
    job.result.doctorCount = input.doctors.length;
    job.result.doctorTable = gridTable(sel.doctors, columns);
    job.result.medsTable = medsTable(drugs, columns, input.meds);
    job.result.legend = LEGEND + (columns.some((p) => (p.inCarrier || []).length) ? ` · ${IN_STAR_LEGEND}` : '');
    job.result.medsLegend = MEDS_LEGEND;
    // Every lookup failed: the table carries the banner, and the UI shows it in red.
    job.result.medsLookupFailed = drugs.length > 0 && !drugs.some((r) => (r.lookups || []).some((l) => l && l.verified));
    job.result.medsBanner = job.result.medsLookupFailed ? MEDS_FAILED_BANNER.replace(/\*\*/g, '') : null;
    job.result.couldNotVerify = {
      count: sel.couldNotVerifyCount,
      plans: sel.couldNotVerify.slice(0, 3).map((c) => ({ planId: c.planId, name: c.name })),
    };
    job.result.sameNetwork = sel.sameNetwork.map((x) => ({ planId: x.plan.planId, name: x.plan.name, sameAs: x.twin.planId, diff: x.diff }));
    job.result.flags = [...sel.flags, ...strengthNotes(drugs, planIds)];
    job.result.questions = sel.questions;
    job.result.notConfirmed = doctorStructs.filter((d) => !['done', 'partial'].includes(d.status)).map((d) => d.requestedName);
    // toolResults in the shape the Excel/PDF export already reads.
    job.result.toolResults = [
      ...doctorStructs.map((d) => ({ tool: 'lookup_provider_network', output: d })),
      ...drugs.map((r) => ({ tool: 'lookup_formulary', output: { ...r, drug: toExportDrug(r), drugs: toExportDrugs(r) } })),
    ];
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  } finally {
    job.finishedAt = Date.now();
  }
}

function createJob(rawInput, owner, deps) {
  sweep();
  const input = normalizeInput(rawInput);
  if (!input.doctors.length && !input.meds.length) {
    const err = new Error('Add at least one doctor or medication.');
    err.status = 400;
    throw err;
  }
  if (!input.zip) {
    const err = new Error('ZIP is required for doctor network checks.');
    err.status = 400;
    throw err;
  }
  const job = {
    id: crypto.randomBytes(9).toString('hex'),
    owner: String(owner || ''),
    createdAt: Date.now(),
    finishedAt: null,
    status: 'queued',
    input,
    progress: { doctors: { done: 0, total: input.doctors.length }, meds: { done: 0, total: input.meds.length } },
    result: {},
  };
  jobs.set(job.id, job);
  enqueueJob(job, deps);
  return job;
}

function getJob(id, owner) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.owner && owner && job.owner !== String(owner)) return null;
  return job;
}

module.exports = {
  parseCompareAsk,
  normalizeInput,
  createJob,
  getJob,
  publicJob,
  runJob,
  queueState,
  lookupFormularyCached,
  NOT_CONFIRMED,
};
