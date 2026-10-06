// services/compareJobs.js — Client Comparison mode.
//
// Comparisons don't go through the chat model. The agent's ask is parsed into
// fields (client, ZIP, doctors, meds, plans), then one background job runs every
// doctor and drug lookup in parallel and reports progress. No chat wait, no
// model timeouts, no plan dumps. Chat stays for questions.

const crypto = require('crypto');
const { lookupDoctor, NOT_CONFIRMED } = require('./providerNetwork');
const { lookupFormulary, toExportDrug, toExportDrugs, formatFormularyText } = require('./formularyLookup');
const { askConstraints, gridTable, medsTable, selectComparison } = require('./doctorPlanNarrow');
const { eligibilityFromAsk, LEGEND, MEDS_LEGEND, IN_STAR_LEGEND } = require('./comparisonRules');

// Candidates priced before the final top 3, so drug cost can break ties (rule 3).
const RX_SHORTLIST = Number(process.env.MAX_COMPARE_RX_SHORTLIST || 6);

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const RX_CACHE_MS = Number(process.env.MAX_RX_CACHE_MS || 24 * 60 * 60 * 1000);
const DOCTOR_BUDGET_MS = Number(process.env.MAX_COMPARE_DOCTOR_BUDGET_MS || 90_000);
const DRUG_CONCURRENCY = Number(process.env.MAX_COMPARE_DRUG_CONCURRENCY || 4);
const MAX_DOCTORS = 15;
const MAX_MEDS = 20;
const MAX_PLANS = 4;

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

/** "Maria & Gaspar Padron, ZIP 33332 … Doctors: … Meds: … Compare H… " → fields. */
function parseCompareAsk(text) {
  const t = String(text || '').replace(/\r/g, '');
  const stops = ['doctors?', 'drs?', 'providers?', 'meds?', 'medications?', 'rx', 'drugs?', 'plans?', 'compare'];
  const constraints = askConstraints(t);

  const zip = (t.match(/\b(?:zip\s*(?:code)?\s*:?\s*)?(\d{5})\b/i) || [])[1] || '';
  const clientMatch = t.match(/^\s*([A-Z][a-z]+(?:\s*(?:&|and|y)\s*[A-Z][a-z]+)?\s+[A-Z][A-Za-z'-]+)/);
  const clientName = clientMatch ? clientMatch[1].replace(/\s+/g, ' ').trim() : '';
  const terminatingPlan = ((t.match(/\b([HR]\d{4}-\d{3}[A-Z]?)\b[^.\n]{0,25}?\b(?:terminat|ending)/i) || [])[1] || '').toUpperCase();

  let doctorsText = section(t, '(?:doctors?|drs?|providers?)', stops.filter((s) => !/doctor|dr|provider/.test(s)));
  let medsText = section(t, '(?:meds?|medications?|rx|drugs?)', stops.filter((s) => !/med|rx|drug/.test(s)));
  // Trim trailing sentences ("… Compare Humana …", "Give me 2-3 plans")
  const cut = (s) => s.split(/\.\s+(?=[A-Z])|\bcompare\b|\bgive me\b|\bsuggest\b|\bshow me\b/i)[0];
  doctorsText = cut(doctorsText);
  medsText = cut(medsText);

  const doctors = splitList(doctorsText).map((name) => {
    const mustKeep = /must[- ]?keep/i.test(name);
    return { name: name.replace(/\(?\s*must[- ]?keep\s*\)?/i, '').replace(/[\s.]+$/, '').trim(), mustKeep };
  }).filter((d) => d.name).slice(0, MAX_DOCTORS);
  const meds = splitList(medsText).map((m) => m.replace(/\.$/, '')).slice(0, MAX_MEDS);

  const skip = constraints.skip;
  const plans = [];
  for (const m of t.matchAll(PLAN_ID_RE)) {
    const id = m[1].toUpperCase();
    if (id === terminatingPlan || skip.has(id) || [...skip].some((x) => x.slice(0, 9) === id.slice(0, 9))) continue;
    if (!plans.includes(id)) plans.push(id);
  }

  return {
    clientName,
    zip,
    doctors,
    meds,
    plans: plans.slice(0, MAX_PLANS),
    terminatingPlan,
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
  const meds = list(src.meds).map((m) => String(m || '').trim()).filter(Boolean).slice(0, MAX_MEDS);
  const plans = list(src.plans).map((p) => String(p || '').trim().toUpperCase()).filter((p) => /^[HR]\d{4}-\d{3}[A-Z]?$/.test(p)).slice(0, MAX_PLANS);
  return {
    clientName: String(src.clientName || '').trim().slice(0, 80),
    zip: String(src.zip || '').trim().slice(0, 5),
    doctors,
    meds,
    plans,
    terminatingPlan: String(src.terminatingPlan || '').trim().toUpperCase(),
    noMedicaid: Boolean(src.noMedicaid),
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
    const planSource = named.length ? 'named' : 'top_doctor_coverage';
    let rxPlanIds = named.map((p) => p.planId);
    if (!named.length) {
      const first = selectComparison(doctorStructs, askText, { named: [], meds: input.meds });
      rxPlanIds = first.ranked.slice(0, RX_SHORTLIST).map((c) => c.planId);
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

    const sel = selectComparison(doctorStructs, askText, {
      named, meds: input.meds, drugs, onlyPlanIds: named.length ? undefined : rxPlanIds,
    });
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
    job.result.doctorTable = gridTable(sel.doctors, columns);
    job.result.medsTable = medsTable(drugs, columns, input.meds);
    job.result.legend = LEGEND + (columns.some((p) => (p.inCarrier || []).length) ? ` · ${IN_STAR_LEGEND}` : '');
    job.result.medsLegend = MEDS_LEGEND;
    job.result.couldNotVerify = {
      count: sel.couldNotVerifyCount,
      plans: sel.couldNotVerify.slice(0, 3).map((c) => ({ planId: c.planId, name: c.name })),
    };
    job.result.sameNetwork = sel.sameNetwork.map((x) => ({ planId: x.plan.planId, name: x.plan.name, sameAs: x.twin.planId, diff: x.diff }));
    job.result.flags = sel.flags;
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
  setImmediate(() => { void runJob(job, deps); });
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
  lookupFormularyCached,
  NOT_CONFIRMED,
};
