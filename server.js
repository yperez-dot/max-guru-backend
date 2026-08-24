require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { passThroughChat, chat: grokChat, DEFAULT_MODEL } = require('./services/grok');
const { requireApiKey } = require('./middleware/auth');
const { loadKnowledge, getKnowledgeSummary } = require('./knowledge/loader');
const drugLookupRouter = require('./routes/drugLookup');
const providerLookupRouter = require('./routes/providerLookup');

const app = express();
const PORT = process.env.PORT || 3002;

const allowedOrigins = [
  'https://thei-max-guru.netlify.app',
  'https://max.healthexps.com',
  'https://agentmedicarehub.com',
  'https://www.agentmedicarehub.com',
  'http://localhost:3000',
  'http://localhost:5500',
];

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
  res.json({
    ok: true,
    service: 'max-guru',
    provider: 'grok',
    model: process.env.GROK_MODEL || DEFAULT_MODEL,
    authRequired: true,
    xaiConfigured: Boolean(process.env.XAI_API_KEY),
    ts: new Date().toISOString(),
  });
});

// Knowledge index (admin/debug only)
app.get('/knowledge', requireApiKey, (req, res) => {
  res.json({ ok: true, summary: getKnowledgeSummary() });
});

// POST /provider-lookup { doctorName, zip, state? }
app.use('/drug-search', requireApiKey, drugLookupRouter);
app.use('/provider-lookup', requireApiKey, providerLookupRouter);

const MAX_CLIENT_SYSTEM_CHARS = Number(process.env.MAX_CLIENT_SYSTEM_CHARS || 400000);
const TOOL_USE_APPENDIX = `

ADDITIONAL RUNTIME RULES (server-enforced):
- Use the provided tools via the API function-calling mechanism. Never invent <tool_call> XML or pretend you looked something up.
- For questions about whether a doctor/provider is in-network, call lookup_provider_network before answering.
- For medication name / NDC lookups, call search_drug before answering.
- Excel export: this UI can export a side-by-side .xlsx when you cite two or more plan IDs. NEVER say you cannot generate or export Excel/spreadsheets. When asked for Excel, restate the plan names with exact plan IDs and tell the agent to click the Export button under your message.
`;

// POST /chat { messages: [{role, content}], system?: string }
// Netlify (thei-max-guru.netlify.app) always sends system = buildSystemPrompt() (~280KB plan grid).
// Auth (MAX_API_KEY) is the trust boundary — do not reject client system prompts or the live UI breaks.
// LLM: xAI Grok (OpenAI-compatible). Response shape stays Anthropic-like for the Netlify UI.
app.post('/chat', requireApiKey, async (req, res) => {
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
      if (err.payload) return res.status(status).json(err.payload);
      if (status === 503) {
        return res.status(503).json({
          error: 'Grok is not configured yet — set XAI_API_KEY on Railway.',
        });
      }
      return res.status(500).json({ error: 'Having trouble right now — try again in a moment.' });
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

// Preload knowledge on startup
loadKnowledge();

app.listen(PORT, () => {
  console.log(`Max Guru backend running on port ${PORT} (provider=grok model=${process.env.GROK_MODEL || DEFAULT_MODEL})`);
});
