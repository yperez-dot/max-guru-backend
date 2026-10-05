// services/compareJobs.js — Client Comparison mode.
//
// Comparisons don't go through the chat model. The agent's ask is parsed into
// fields (client, ZIP, doctors, meds, plans), then one background job runs every
// doctor and drug lookup in parallel and reports progress. No chat wait, no
// model timeouts, no plan dumps. Chat stays for questions.

const crypto = require('crypto');
const { lookupDoctor, NOT_CONFIRMED } = require('./providerNetwork');
const { lookupFormulary, toExportDrug, toExportDrugs, formatFormularyText } = require('./formularyLookup');
const { askConstraints, coverageMatrix, gridTable, medsTable, namedPlanColumns } = require('./doctorPlanNarrow');

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
  for (const id of input.skip) parts.push(`Skip ${id}.`);
  if (input.plans.length) parts.push(`Compare ${input.plans.join(', ')}.`);
  return parts.join(' ');
}

async function runJob(job, { lookupOneDoctor = lookupDoctor, lookupRx = lookupFormularyCached } = {}) {
  const input = job.input;
  const askText = askTextFor(input);
  const constraints = askConstraints(askText);
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

    // 2) Plans — the agent's named plans, else the top 3 by doctors in network.
    let planIds = input.plans.slice();
    let planSource = 'named';
    if (!planIds.length) {
      planSource = 'top_doctor_coverage';
      const m = coverageMatrix(doctorStructs).filter((p) => (
        !constraints.skip.has(p.planId) && !(constraints.noMedicaid && p.type === 'dsnp')
      ));
      planIds = m.slice(0, 3).map((p) => p.planId);
    }
    job.result.planIds = planIds;
    job.result.planSource = planSource;

    // 3) Meds — every drug at once (bounded), against the final plans.
    job.status = 'meds';
    job.progress.meds.total = planIds.length ? input.meds.length : 0;
    const drugResults = new Array(input.meds.length);
    if (planIds.length && input.meds.length) {
      await mapPool(input.meds, DRUG_CONCURRENCY, async (drugName, i) => {
        try {
          drugResults[i] = await lookupRx({ drugName, planIds, year: input.year });
        } catch (e) {
          drugResults[i] = { drugName, error: e.message, lookups: [], byPlanId: {} };
        }
        job.progress.meds.done += 1;
      });
    }
    const drugs = drugResults.filter(Boolean);
    job.result.drugs = drugs.map((r) => ({
      drugName: r.drugName,
      byPlanId: r.byPlanId || {},
      notCoveredNote: r.notCoveredNote || null,
      retriedProduct: r.retriedProduct || null,
      export: toExportDrugs(r),
      text: r.lookups ? formatFormularyText(r).slice(0, 1500) : `${r.drugName}: lookup failed (${r.error || 'unknown'})`,
    }));

    // 4) Tables (same look as chat).
    const matrix = coverageMatrix(doctorStructs);
    // Same column logic as chat: plan-level In/Out where a directory gives it,
    // ✅ In* for carrier-level hits (Aetna fallback), Devoted = one network.
    const columns = namedPlanColumns(
      planIds.map((id) => ({ planId: id, name: (input.planNames && input.planNames[id]) || id })),
      matrix,
      doctorStructs,
    ).map((c) => ({ ...c, name: (input.planNames && input.planNames[c.planId]) || c.name }));
    job.result.doctorTable = gridTable(doctorStructs, columns);
    job.result.medsTable = medsTable(drugs, columns);
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
