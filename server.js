require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { passThroughChat, chat: grokChat, DEFAULT_MODEL, providerConfig } = require('./services/grok');
const { requireApiKey } = require('./middleware/auth');
const { accessEnabled, requireAccessToken, unlockHandler } = require('./middleware/access');
const { createRateLimiter } = require('./middleware/rateLimit');
const { loadKnowledge, getKnowledgeSummary } = require('./knowledge/loader');
const { startSepRefreshScheduler, refreshSepTracker, getStatus: getSepRefreshStatus } = require('./services/sepRefresh');
const drugLookupRouter = require('./routes/drugLookup');
const providerLookupRouter = require('./routes/providerLookup');

const app = express();
const PORT = process.env.PORT || 3002;

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
app.use(express.json({ limit: '3mb' }));

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

// POST /provider-lookup { doctorName, zip, state? }
app.use('/drug-search', requireApiKey, requireAccessToken, drugLookupRouter);
app.use('/provider-lookup', requireApiKey, requireAccessToken, providerLookupRouter);

const MAX_CLIENT_SYSTEM_CHARS = Number(process.env.MAX_CLIENT_SYSTEM_CHARS || 400000);
const TOOL_USE_APPENDIX = `

ADDITIONAL RUNTIME RULES (server-enforced):
- Use the provided tools via the API function-calling mechanism. Never invent <tool_call> XML or pretend you looked something up.
- For questions about whether a doctor/provider is in-network, call lookup_provider_network before answering.
- For medication name / NDC lookups, call search_drug before answering.
- For SEP / disaster SEP, compliance, SOA, certs, contracting, Medicaid/LIS, Hub ops topics: call search_knowledge (or get_knowledge_doc) before answering. Prefer hub/seps-by-state/FL for Florida SEP questions.
- Excel export: this UI can export a side-by-side .xlsx when you cite two or more plan IDs. NEVER say you cannot generate or export Excel/spreadsheets. When asked for Excel, restate the plan names with exact plan IDs and tell the agent to click the Export button under your message.
- For plan availability / similar plans outside Miami-Dade or Broward (or when the agent names another Florida county or ZIP such as Alachua, Orange, Hillsborough, Palm Beach): call discover_similar_plans BEFORE answering. List carrier + plan name + plan ID candidates and the medicare.gov Plan Compare link. Say the THEI benefit grid does not cover that county. Do NOT invent premiums, MOOP, or dental from memory. Do NOT rank or recommend a "best" plan (TPMO). Agent verifies in Sunfire / SOB / Plan Compare.
- CLIENT-FACING COMPARISON (preferred LOOK = Katy ChatGPT PDF design; DATA workflow = THEI client Google Sheet — one tab/client; sheet id 17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc; URL https://docs.google.com/spreadsheets/d/17yvEEoToayROnm6jR0sIfk9IbxJwVYWVhiqOJzsiCBc/edit):
  1) NAME FIRST: Ask for the client's full name if not already in the conversation (tab/header name). Never invent a name. Never use the placeholder "Client".
  2) THEI SHEET Drs/Rx: After the name is known, use that client's sheet tab for doctors and medications when possible. Max may not have live Google access — if Drs/Rx are not pasted, ask the agent to pull Drs/Rx from that sheet for the named client (examples: Sr. Perez ZIP+meds; Carol.Wong doctors True/False then benefits; Bonnie.Lane many specialists True/False). Do not invent Drs/Rx.
  3) PRESENTATION (Katy PDF): Title "{Year} Medicare Advantage Plan Comparison"; subhead "{Full Name} | ZIP {zip} – {County}, Florida | Prepared {Month Year}"; clean benefit table; then Doctors True/False section; then Rx section; SOB/Plan Compare sources + verify-before-enrollment footer. No ranking blurbs.
  4) LAYOUT — Plan columns: carrier + plan name + plan ID (2–4 plans). ZIP/county in the header. Out-of-area: discover_similar_plans + Plan Compare; Dade/Broward may use THEI PLAN DATA/grid. Do NOT invent benefit dollars.
  5) LAYOUT — Benefit rows (objective): premium, referrals, Part B giveback, MOOP, hospital, PCP, specialist, and other sourced benefits. Cite SOB / Plan Compare / grid.
  6) LAYOUT — Doctor rows: doctor name (+ specialty) with True/False or Yes/No in-network under each plan column. Call lookup_provider_network for each known doctor with client ZIP.
  7) LAYOUT — Rx rows: drug name with cost/copay under each plan when known. Call search_drug; note what was verified vs what agent must confirm on formulary.
  8) If doctors/Rx unknown after name: ask "Do they have doctors or meds on our sheet / that we should check?"
  9) TPMO: No ranking ("best" / "closest" / "highest"). Objective tables only. Prefer search_knowledge for client-plan-comparison.
`;

// POST /chat { messages: [{role, content}], system?: string }
// Netlify (thei-max-guru.netlify.app) always sends system = buildSystemPrompt() (~280KB plan grid).
// Auth (MAX_API_KEY) is the trust boundary — do not reject client system prompts or the live UI breaks.
// LLM: xAI Grok (OpenAI-compatible). Response shape stays Anthropic-like for the Netlify UI.
app.post('/chat', requireApiKey, requireAccessToken, chatRateLimit, async (req, res) => {
  const { messages, system } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
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

    const mergedSystem = `${system}\n${TOOL_USE_APPENDIX}`;
    try {
      const data = await passThroughChat({ system: mergedSystem, messages });
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
    const reply = await grokChat(messages, SYSTEM_PROMPT);
    res.json({ ok: true, reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Having trouble right now — try again in a moment.' });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Preload knowledge on startup, then keep SEPs fresh from the live Hub tracker
loadKnowledge();
startSepRefreshScheduler();

app.listen(PORT, () => {
  const cfg = providerConfig();
  console.log(`Max Guru backend running on port ${PORT} (provider=${cfg.provider} model=${cfg.model})`);
});
