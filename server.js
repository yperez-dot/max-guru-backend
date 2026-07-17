require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chat } = require('./services/claude');
const { loadKnowledge, getKnowledgeSummary } = require('./knowledge/loader');

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

// POST /chat { messages: [{role, content}], system?: string }
app.post('/chat', async (req, res) => {
  const { messages, system } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }
  try {
    const reply = await chat(messages, system);
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
