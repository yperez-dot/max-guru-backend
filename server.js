require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { passThroughChat, DEFAULT_MODEL, providerConfig } = require('./services/grok');
const { BudgetGuard } = require('./services/budgetGuard');
const { ImageValidationError, normalizeMessages } = require('./services/chatImages');
const { requireApiKey } = require('./middleware/auth');
const { accessEnabled, requireAccessToken, unlockHandler } = require('./middleware/access');
const { createRateLimiter } = require('./middleware/rateLimit');
const { loadKnowledge, getKnowledgeSummary } = require('./knowledge/loader');
const { COMPARISON_TABLE_RULES } = require('./services/comparisonRules');
const { startSepRefreshScheduler, refreshSepTracker, getStatus: getSepRefreshStatus } = require('./services/sepRefresh');
const drugLookupRouter = require('./routes/drugLookup');
const formularyLookupRouter = require('./routes/formularyLookup');
const providerLookupRouter = require('./routes/providerLookup');
const workupsRouter = require('./routes/workups');
const compareRouter = require('./routes/compare');

const app = express();
const PORT = process.env.PORT || 3002;
const budgetGuard = new BudgetGuard();

const allowedOrigins = [
  'https://thei-max-guru.netlify.app',
  'https://max.healthexps.com',
  'http://localhost:3000',
  'http://localhost:5500',
];

const chatRateLimit = createRateLimiter({
  windowMs: Number(process.env.MAX_CHAT_RATE_WINDOW_MS || 60 * 60 * 1000),
  max: Number(process.env.MAX_CHAT_RATE_MAX || 40),
  name: 'chat',
});
const unlockRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.MAX_UNLOCK_RATE_MAX || 20),
  name: 'unlock',
});

app.use(cors({
  origin: (origin, cb) => {
    // Allow non-browser clients (no Origin) and allowlisted browser origins.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: process.env.MAX_JSON_BODY_LIMIT || '30mb' }));

app.get('/health', (req, res) => {
  const cfg = providerConfig();
  res.json({
    ok: true,
    service: 'max-guru',
    provider: cfg.provider,
    model: cfg.model,
    authRequired: true,
    accessGate: accessEnabled(),
    llmConfigured: Boolean(cfg.key),
    xaiConfigured: Boolean(process.env.XAI_API_KEY),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    sepRefresh: getSepRefreshStatus(),
    ts: new Date().toISOString(),
  });
});

// Authenticated daily cost status for admin/UI diagnostics.
app.get('/usage', requireApiKey, requireAccessToken, (req, res) => {
  res.json({ ok: true, ...budgetGuard.summary() });
});

// Shared password unlock → short-lived access token (required when MAX_ACCESS_PASSWORD is set)
app.post('/auth/unlock', requireApiKey, unlockRateLimit, unlockHandler);

// Knowledge index (admin/debug only)
app.get('/knowledge', requireApiKey, requireAccessToken, (req, res) => {
  res.json({ ok: true, summary: getKnowledgeSummary() });
});

// Force SEP tracker pull from live Hub (admin)
app.post('/admin/refresh-seps', requireApiKey, requireAccessToken, async (req, res) => {
  const result = await refreshSepTracker({ reason: 'admin' });
  const status = result.ok ? 200 : 502;
  res.status(status).json(result);
});

// GET /admin/directory-check?npi=1043665177 — what Railway itself gets back from the
// Doctors HealthCare and FHIR (Devoted, FL Blue, HealthSun) directories for one NPI.
app.get('/admin/directory-check', requireApiKey, requireAccessToken, async (req, res) => {
  const npi = String(req.query.npi || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(npi)) return res.status(400).json({ error: 'npi must be 10 digits' });
  const { probeDoctors } = require('./services/doctorsHcp');
  const { fhirCheck } = require('./services/providerNetwork');
  const started = Date.now();
  const [doctors, fhir] = await Promise.all([
    probeDoctors(npi).catch((e) => ({ error: e.message })),
    fhirCheck(npi).catch((e) => ({ error: e.message })),
  ]);
  res.json({ npi, ms: Date.now() - started, doctors, fhir });
});

// POST /provider-lookup { doctorName, zip, state? }
app.use('/drug-search', requireApiKey, requireAccessToken, drugLookupRouter);
app.use('/formulary-lookup', requireApiKey, requireAccessToken, formularyLookupRouter);
app.use('/sob-lookup', requireApiKey, requireAccessToken, require('./routes/sobLookup'));
app.use('/provider-lookup', requireApiKey, requireAccessToken, providerLookupRouter);
app.use('/workups', requireApiKey, requireAccessToken, workupsRouter);
// Client Comparison mode — background doctor + Rx job, no chat wait
app.use('/compare', requireApiKey, requireAccessToken, compareRouter);

const MAX_CLIENT_SYSTEM_CHARS = Number(process.env.MAX_CLIENT_SYSTEM_CHARS || 400000);
// passThroughChat hard-caps this at MAX_CHAT_DEADLINE_CAP_MS (110s) so the 120s browser wait never fires first.
const CHAT_DEADLINE_MS = Number(process.env.MAX_CHAT_DEADLINE_MS || 105_000);
const MAX_PRIOR_TOOL_RESULTS = 40;
const TOOL_USE_APPENDIX = `

ADDITIONAL RUNTIME RULES (server-enforced):
- Use the provided tools via the API function-calling mechanism. Never invent <tool_call> XML or pretend you looked something up.
- For questions about whether a doctor/provider is in-network, call lookup_provider_network before answering. When the agent lists 2 or more doctors, make ONE lookup_provider_network call with every doctor in doctors[] plus the shared zip (e.g. Padron: 8 doctors, ZIP 33332) — never one call per doctor and never split them across turns. MULTI-DOCTOR ANSWER FORMAT (keep it short — agents read this on a call): (a) the header, the "Why these plans" line and the DOCTOR × PLAN TABLE from the tool result, copied as-is (Doctor/Drug Comparison Table Rules below). NEVER list every plan ID per doctor. (b) If eligibility (Medicaid/MSP, C-SNP condition), a last-name-only doctor match, HMO vs PPO, or must-keep doctors are not known yet, ask the tool result's questions (max 3, numbered, short) — then stop and wait. Never "N/total doctors in"; counts are "X in · Y out · Z unchecked". (c) Once she answers, give exactly 2–3 plans that fit, each with every doctor In / Out / ❔ unchecked / ❔ not confirmed. Never a long plan dump. If a clinic/group/DBA name misses, call search_clinic_or_provider (CMS NPPES org search + optional known clinic page — never Google SERPs), propose the NPI(s), then re-run lookup_provider_network with npi=.
- Clinic "insurances accepted" pages are marketing, not verified In/Out. If a Humana (or other carrier) logo IS on the page: "Found a Humana logo on their site — here's the link. I recommend you call and confirm." If it is NOT (MNRS Physical Therapy / https://miamiphysicaltherapy.com/insurances/ lists Aetna, ASHP, AvMed, Cigna, Doctors Healthcare, GEHA, Golden Rule, Hartford, Harvard Pilgrim, Medicare, NALC, PHCS, TRICARE, UnitedHealthcare, UAIC, UMR, VA, Gallagher Bassett — NO Humana): "{carrier} is not listed on their accepted-insurances page" + link + recommend calling the office. Absence on the clinic site is not definitive OON if Find Care later returns IN — report both: not listed on clinic site + the NPI Find Care result. True In/Out is NPI + carrier Find Care / FHIR / guest directory only.
- CIGNA / HEALTHSPRING 2027: Cigna (HealthSpring) has NO 2027 Medicare Advantage plans — they pulled out. A Cigna directory hit for a doctor is not a 2027 option: never list Cigna as a carrier the doctor is \"in network\" with for 2027, never suggest a Cigna/HealthSpring 2027 plan. If the agent asks, say Cigna/HealthSpring has no 2027 MA plans.
- Provider results are facts, never a ranking signal. UHC uses the public guest Find a Doctor (2027) — no Jarvis/member login. Humana uses public Find Care guest (2027) — no member login. A failed check or empty Sunfire is not out-of-network. Only report UHC/Humana OON when that guest directory returned a successful empty result for that plan/network.
- For medication name / NDC lookups, call search_drug (catalog only). search_drug does NOT verify a plan tier.
- CLIENT-STATED RX TIERS: Daisy / paste / archive "Tier X" labels are discarded. Never surface, quote, or imply them — not even as a soft claim. Paste is drug names only. Call lookup_formulary for each drug × each named plan (year 2027 unless asked otherwise). Lookup order: Sunfire, Humana FHIR (PBP+year match only), medicare.gov Plan Compare, then carrier consumer (Doctors 2027 formulary PDF for H4140; 001→022, 012→023). If lookup fails, say unverified. After a verified tier, quote T1–T6 cost-share from THEI Hub/grid 2027 knowledge. Sheet 1zer8DxamS9GFdp9tHqWSB4S0bPjHbyU2Jyi6exBn31A is Yahoska's finished-comp archive — not the 2027 benefit grid and not a formulary source.
- For SEP / disaster SEP, compliance, SOA, certs, contracting, Medicaid/LIS, Hub ops topics: call search_knowledge (or get_knowledge_doc) before answering. Prefer hub/seps-by-state/FL for Florida SEP questions.
- Excel/PDF export: this UI can export a side-by-side .xlsx or PDF when you cite two or more plan IDs. NEVER say you cannot generate or export Excel/PDF/spreadsheets. When asked for Excel or PDF, restate the plan names with exact plan IDs and tell the agent to click Export Excel or Export PDF under your message. If the thread has a client name, terminating plan, or doctor in/out results, mention those facts (never invent them). Export layout is the Yahoska sheet: client name title, optional Plan Terminating only when the agent says a current plan is ending, marketing name + contract-PBP columns, Doctors In network/Out of network, Medications, then the fixed grid benefit rows plus an extra row ONLY for an off-grid benefit she asked for (Unverified if she asked and neither the SOB nor the EOC has a number), SOB/EOC links or pending. Do not cap plans at 3.
- GRID-MISSING BENEFITS: The THEI grid only has the most-requested benefits. Call lookup_sob_benefit only when the agent asks for a need that is not on the Plan Comparison Grid (SNF, hospital-grade bed / DME, hearing aids, chemotherapy, or any other asked off-grid benefit). Use that year's files: 2026-only ask → 2026 #plan-data-2026 SOB/EOC; unspecified year, 2027, or both years → 2027 #plan-data. Read the SOB first, then the Evidence of Coverage if the SOB does not have it. A 2026-only ask must not fetch a 2027 EOC. Do NOT look those up on every comparison. Do not auto-lookup benefits she did not ask for. Quote only what the document says. If it is not in either, say unverified. Never invent dollars. Never quote the other year's SOB. Never print chopped PDF fragments.
- For plan availability / similar plans outside Miami-Dade or Broward (or when the agent names another Florida county or ZIP such as Alachua, Orange, Hillsborough, Palm Beach): call discover_similar_plans BEFORE answering. List carrier + plan name + plan ID candidates and the medicare.gov Plan Compare link. Say the THEI benefit grid does not cover that county. Do NOT invent premiums, MOOP, or dental from memory. Do NOT rank or recommend a "best" plan (TPMO). Agent verifies in Sunfire / SOB / Plan Compare.
- CLIENT-FACING COMPARISON (preferred LOOK = Yahoska Arias Lazo Excel/PDF; DATA workflow = THEI client Google Sheet — one tab/client; sheet id 17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc; URL https://docs.google.com/spreadsheets/d/17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc/edit):
  1) NAME FIRST: Ask for the client's full name if not already in the conversation (tab/header name). Never invent a name. Never use the placeholder "Client".
  2) THEI SHEET Drs/Rx: After the name is known, use that client's sheet tab for doctors and medications when possible. Max may not have live Google access — if Drs/Rx are not pasted, ask the agent to pull Drs/Rx from that sheet for the named client (examples: Sr. Perez ZIP+meds; Carol.Wong doctors True/False then benefits; Bonnie.Lane many specialists True/False). Do not invent Drs/Rx.
  3) PRESENTATION (Yahoska sheet / Arias Lazo): Title = client full name; optional Plan Terminating row; plan columns = marketing name + contract-PBP on its own line; Doctors section first (In network / Out of network); then the fixed benefit row order; SOB/EOC as links or pending. Chat stays short bullets — the Export Excel / Export PDF buttons build the file. No ranking blurbs.
  4) LAYOUT — Plan columns: full marketing name + contract-PBP (2–4 plans). Out-of-area: discover_similar_plans + Plan Compare; Dade/Broward use THEI PLAN DATA (2027 AEP default; 2026 only if asked). Do NOT invent benefit dollars. Do NOT copy 2026 dollars into a 2027 column.
  5) LAYOUT — Benefit rows in this order when sourced: Premium; Part B Rebate; Referrals Needed?; MSP Levels; Max Out of Pocket; Inpatient Hospital; Outpatient Hospital; PCP; Specialist; ER; Urgent Care; Advanced Imaging (MRI, CT, PET); Hearing; Dental + procedure rows; Vision; Ambulance; Transportation; Companionship; Custodial Care; RX Deductible; Tiers 1–6; OTC; Grocery Card; Acupuncture; Fitness; Summary of Benefits; Evidence of Coverage.
  6) LAYOUT — Doctor rows: doctor name with In network / Out of network under each plan column. Call lookup_provider_network for each known doctor with client ZIP. If doctors unknown, omit the Doctors block.
  7) LAYOUT — Rx / Medications rows: drug name with verified lookup tier + T1–T6 cost-share under each plan. Call lookup_formulary for each drug × plan. Discard Daisy / paste tier labels. Export shows Unverified unless lookup_formulary verified a tier.
  8) If doctors/Rx unknown after name: ask "Do they have doctors or meds on our sheet / that we should check?"
  9) TPMO: No ranking ("best" / "closest" / "highest"). Objective tables only. Prefer search_knowledge for client-plan-comparison.
${COMPARISON_TABLE_RULES}`;

function deadlineBanner(resume) {
  const resumable = Boolean(resume && resume.resumable);
  return {
    id: 'chat-deadline',
    type: 'warning',
    message: resumable
      ? `Max hit the chat wait with ${resume.finished} lookup result(s) finished. They are saved — send the same ask again and Max continues from them (doctor lookups come back from cache). Dollars stay unverified unless a SOB lookup finished.`
      : 'Max hit the chat wait before any lookup finished — nothing was saved. Sending again starts fresh.',
  };
}

function compactToolOutput(output) {
  if (!output || typeof output !== 'object') return String(output || '').slice(0, 400);
  if (output.doctorName || output.requestedName) {
    const inNets = (output.networks || []).filter((n) => n.inNetwork).map((n) => (
      n.plans && n.plans.length ? `${n.carrier} (${n.plans.join('; ')})` : n.carrier
    ));
    const who = [output.requestedName, output.doctorName].filter(Boolean).join(' → ');
    if (output.status === 'timeout' || output.status === 'not_found' || output.status === 'error') {
      return `${who}: NOT CONFIRMED (${output.status})`;
    }
    return `${who}${output.npi ? ` NPI ${output.npi}` : ''}: ${inNets.length ? `in-network ${inNets.join(', ')}` : 'no in-network hit in finished checks'}${(output.pending || []).length ? `; pending ${output.pending.join(', ')}` : ''}`;
  }
  try {
    return JSON.stringify(output).slice(0, 600);
  } catch (_) {
    return '';
  }
}

/** Real resume: finished lookups from the attempt that hit the chat wait, sent back by the UI. */
function priorToolResultsNote(prior) {
  if (!Array.isArray(prior) || !prior.length) return '';
  const lines = prior
    .slice(-MAX_PRIOR_TOOL_RESULTS)
    .filter((t) => t && typeof t === 'object' && typeof t.tool === 'string')
    .map((t) => `- ${t.tool}: ${compactToolOutput(t.output)}`)
    .filter((line) => line.length > 4);
  if (!lines.length) return '';
  return `\n\nFINISHED LOOKUPS FROM THE PREVIOUS ATTEMPT (it hit the chat wait; these already finished — reuse them; only look up what is NOT CONFIRMED or missing; doctor lookups re-run from cache instantly if you call them again):\n${lines.join('\n').slice(0, 8000)}\n`;
}

// POST /chat { messages: [{role, content}], system?: string, priorToolResults?: [] }
// content may be a string or multimodal parts (text + PNG/JPEG/WebP data URLs).
// Images are validated in-memory and forwarded to Grok/OpenAI vision; they are not persisted.
// Netlify (thei-max-guru.netlify.app) sends system = buildSystemPrompt(): rules + hospitals + carrier rules (~45KB) plus only the plan rows for the ask (client county from ZIP/workup, carrier, plan IDs).
// Auth (MAX_API_KEY) is the trust boundary — do not reject client system prompts or the live UI breaks.
// LLM: xAI Grok (OpenAI-compatible). Response shape stays Anthropic-like for the Netlify UI.
app.post('/chat', requireApiKey, requireAccessToken, chatRateLimit, async (req, res) => {
  const { system } = req.body;
  if (!Array.isArray(req.body.messages) || !req.body.messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  let messages;
  try {
    messages = normalizeMessages(req.body.messages, { validate: true });
  } catch (err) {
    if (err instanceof ImageValidationError || err.code === 'invalid_image') {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    return res.status(err.status || 400).json({ error: err.message || 'messages array required' });
  }

  const budgetCheck = budgetGuard.checkBeforeTurn(messages);
  if (!budgetCheck.allowed) {
    return res.status(402).json({
      error: budgetCheck.message,
      code: budgetCheck.code,
      budget: budgetCheck.usage,
    });
  }

  if (system) {
    if (typeof system !== 'string') {
      return res.status(400).json({ error: 'system must be a string' });
    }
    if (system.length > MAX_CLIENT_SYSTEM_CHARS) {
      return res.status(413).json({
        error: `system prompt too large (${system.length} chars; max ${MAX_CLIENT_SYSTEM_CHARS})`,
      });
    }

    const priorNote = priorToolResultsNote(req.body.priorToolResults);
    const mergedSystem = `${system}\n${TOOL_USE_APPENDIX}${priorNote}`;
    try {
      const data = await passThroughChat({
        system: mergedSystem,
        messages,
        deadlineMs: CHAT_DEADLINE_MS,
      });
      const budgetResult = budgetGuard.recordTurn({
        provider: data.provider,
        usageCalls: data.usageCalls,
      });
      const banners = [...budgetResult.banners];
      if (data.deadline) {
        banners.unshift(deadlineBanner(data.resume));
        delete data.deadline;
      }
      if (budgetCheck.overrideActivated) {
        banners.unshift({
          id: `budget-${budgetResult.usage.day}-override`,
          type: 'warning',
          message: 'Daily budget override is active until the next America/New_York day.',
        });
      }
      const contextNudge = budgetGuard.contextNudge(mergedSystem, messages);
      if (contextNudge) banners.push(contextNudge);
      data.banners = banners;
      data.budget = budgetResult.usage;
      delete data.usageCalls;
      return res.json(data);
    } catch (err) {
      console.error('Grok pass-through error:', err.message);
      if (err.payload) console.error('Grok payload:', JSON.stringify(err.payload).slice(0, 500));
      const status = err.status && Number.isInteger(err.status) ? err.status : 500;
      // Always return a string error — nested OpenAI {error:{message}} objects crash the Netlify UI
      // when it treats data.error as chat text and later calls .match on it.
      const msg =
        (err && err.message) ||
        (err.payload && err.payload.error && err.payload.error.message) ||
        (typeof err.payload?.error === 'string' ? err.payload.error : null) ||
        'Having trouble right now — try again in a moment.';
      if (status === 503) {
        return res.status(503).json({
          error: 'LLM is not configured yet — set OPENAI_API_KEY (LLM_PROVIDER=openai) or XAI_API_KEY on Railway.',
        });
      }
      return res.status(status).json({ error: String(msg) });
    }
  }

  // LEGACY MODE — KB-search path (scheduled for retirement).
  try {
    const { SYSTEM_PROMPT } = require('./services/claude');
    const data = await passThroughChat({
      system: SYSTEM_PROMPT,
      messages,
      deadlineMs: CHAT_DEADLINE_MS,
    });
    const budgetResult = budgetGuard.recordTurn({
      provider: data.provider,
      usageCalls: data.usageCalls,
    });
    const block = (data.content || []).find((item) => item.type === 'text');
    const banners = [...budgetResult.banners];
    if (data.deadline) {
      banners.unshift(deadlineBanner(data.resume));
    }
    if (budgetCheck.overrideActivated) {
      banners.unshift({
        id: `budget-${budgetResult.usage.day}-override`,
        type: 'warning',
        message: 'Daily budget override is active until the next America/New_York day.',
      });
    }
    const contextNudge = budgetGuard.contextNudge(SYSTEM_PROMPT, messages);
    if (contextNudge) banners.push(contextNudge);
    res.json({
      ok: true,
      reply: block?.text || "I'm having trouble right now — please try again.",
      banners,
      budget: budgetResult.usage,
    });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Having trouble right now — try again in a moment.' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'That request is too large. Attach PNG, JPEG, or WebP images under 4MB each.',
    });
  }
  return next(err);
});

// Preload knowledge on startup, then keep SEPs fresh from the live Hub tracker
loadKnowledge();
startSepRefreshScheduler();

app.listen(PORT, () => {
  const cfg = providerConfig();
  console.log(`Max Guru backend running on port ${PORT} (provider=${cfg.provider} model=${cfg.model})`);
});
