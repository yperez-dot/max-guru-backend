require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chat } = require('./services/claude');
const { loadKnowledge, getKnowledgeSummary } = require('./knowledge/loader');
const drugLookupRouter = require('./routes/drugLookup');
const providerLookupRouter = require('./routes/providerLookup');

const app = express();
const PORT = process.env.PORT || 3002;

const allowedOrigins = [
  'https://thei-max-guru.netlify.app',
  'https://agentmedicarehub.com',
  'https://www.agentmedicarehub.com',
  'http://localhost:3000',
  'http://localhost:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '3mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'max-guru', ts: new Date().toISOString() });
});

// Knowledge index (for debugging)
app.get('/knowledge', (req, res) => {
  res.json({ ok: true, summary: getKnowledgeSummary() });
});

// POST /provider-lookup { doctorName, zip, state? }
app.use('/drug-search', drugLookupRouter);
app.use('/provider-lookup', providerLookupRouter);

// POST /chat { messages: [{role, content}], system?: string }
app.post('/chat', async (req, res) => {
  const { messages, system } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  if (system) {
    // PASS-THROUGH MODE — forward verbatim to Anthropic, return their raw response.
    // data.content[0].text works on the frontend identically to direct Claude.ai calls.
    // Status codes propagate so 4xx/5xx reach the frontend error handler.
    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify({
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
        }),
      });
      const data = await anthropicRes.json();
      return res.status(anthropicRes.status).json(data);
    } catch (err) {
      console.error('Pass-through error:', err.message);
      return res.status(500).json({ error: 'Having trouble right now — try again in a moment.' });
    }
  }

  // LEGACY MODE — KB-search path (scheduled for retirement).
  try {
    const reply = await chat(messages);
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
  console.log(`Max Guru backend running on port ${PORT}`);
});
