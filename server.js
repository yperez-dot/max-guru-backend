require('dotenv').config();
const express = require('express');
const cors = require('cors');
const {
  chat,
  TOOLS,
  processTool,
  SYSTEM_PROMPT,
  TOOL_USE_APPENDIX,
  detectProviderLookupIntent,
  parseNarratedToolCall,
  toolResultToText,
} = require('./services/claude');
const { loadKnowledge, getKnowledgeSummary } = require('./knowledge/loader');
const { requireApiKey, warnIfApiKeyMissing } = require('./middleware/auth');
const drugLookupRouter = require('./routes/drugLookup');
const providerLookupRouter = require('./routes/providerLookup');

const app = express();
const PORT = process.env.PORT || 3002;
const MAX_CLIENT_SYSTEM_CHARS = Number(process.env.MAX_CLIENT_SYSTEM_CHARS || 400000);
const MAX_MESSAGES = Number(process.env.MAX_CHAT_MESSAGES || 40);

const allowedOrigins = [
  'https://thei-max-guru.netlify.app',
  'https://agentmedicarehub.com',
  'https://www.agentmedicarehub.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
];

if (process.env.EXTRA_CORS_ORIGINS) {
  for (const o of process.env.EXTRA_CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)) {
    allowedOrigins.push(o);
  }
}

app.use(cors({
  origin: (origin, cb) => {
    // Browser requests must present an allowlisted Origin.
    // Non-browser clients (no Origin) still need MAX_API_KEY.
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'max-guru',
    authRequired: Boolean(process.env.MAX_API_KEY),
    ts: new Date().toISOString(),
  });
});

// Everything below requires API key when MAX_API_KEY is configured.
app.use(requireApiKey);

app.get('/knowledge', (req, res) => {
  res.json({ ok: true, summary: getKnowledgeSummary() });
});

app.use('/drug-search', drugLookupRouter);
app.use('/provider-lookup', providerLookupRouter);

function redactMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? `[${m.content.length} chars]`
        : Array.isArray(m.content)
          ? `[${m.content.length} blocks]`
          : '[content]',
  }));
}

function buildSystemPrompt(clientSystem) {
  const base =
    typeof clientSystem === 'string' && clientSystem.trim()
      ? clientSystem
      : SYSTEM_PROMPT;
  if (base.length > MAX_CLIENT_SYSTEM_CHARS) {
    const err = new Error(
      `system prompt too large (${base.length} chars; max ${MAX_CLIENT_SYSTEM_CHARS})`
    );
    err.status = 413;
    throw err;
  }
  // Always append server tool-use rules so frontend prompts cannot disable tools.
  return `${base}\n${TOOL_USE_APPENDIX}`;
}

async function runAnthropicPassThrough({ system, messages }) {
  const apiMessages = [...messages];
  let data;
  const collectedToolResults = [];

  // Pre-empt provider lookups so we don't depend on the model choosing tool_use.
  const intent = detectProviderLookupIntent(apiMessages);
  if (intent?.doctorName) {
    console.log('[PreTool] lookup_provider_network');
    const pre = await processTool('lookup_provider_network', {
      doctorName: intent.doctorName,
      zip: intent.zip || '33136',
    });
    const preText = toolResultToText(pre);
    collectedToolResults.push({
      tool: 'lookup_provider_network',
      output: pre?.structured || { text: preText },
    });
    apiMessages.push({
      role: 'user',
      content:
        `Provider network lookup was already run for "${intent.doctorName}". Use this data; do not invent network status.\n\n${preText}`,
    });
  }

  for (let i = 0; i < 5; i++) {
    const requestBody = {
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: apiMessages,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
    };
    console.log('OUTBOUND', JSON.stringify({
      model: requestBody.model,
      max_tokens: requestBody.max_tokens,
      tools: TOOLS.map(t => t.name),
      messages: redactMessages(apiMessages),
      systemChars: system.length,
    }));

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(requestBody),
    });
    data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      const err = new Error('Anthropic request failed');
      err.status = anthropicRes.status;
      err.payload = data;
      throw err;
    }
    if (data.stop_reason !== 'tool_use') break;

    apiMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const block of data.content) {
      if (block.type === 'tool_use') {
        console.log(`[Tool] ${block.name}`);
        const result = await processTool(block.name, block.input);
        const resolvedResult = toolResultToText(result);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resolvedResult,
        });
        const toolOutput =
          result && typeof result === 'object' && result.structured
            ? result.structured
            : { text: resolvedResult };
        collectedToolResults.push({ tool: block.name, output: toolOutput });
      }
    }
    apiMessages.push({ role: 'user', content: toolResults });
  }

  // Reactive fallback: model narrated a tool call as text/XML.
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const narrated = textBlock ? parseNarratedToolCall(textBlock.text) : null;
  if (narrated) {
    console.log(`[ReactiveToolCall] ${narrated.name}`);
    const toolResult = await processTool(narrated.name, narrated.input || {});
    const resolved = toolResultToText(toolResult);
    if (toolResult && typeof toolResult === 'object' && toolResult.structured) {
      collectedToolResults.push({ tool: narrated.name, output: toolResult.structured });
    } else {
      collectedToolResults.push({ tool: narrated.name, output: { text: resolved } });
    }
    const cleanText = textBlock.text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
      .replace(/```(?:json)?\s*\{[\s\S]*?"name"\s*:\s*"[^"]+"[\s\S]*?\}\s*```/g, '')
      .trim();
    apiMessages.push({
      role: 'assistant',
      content: [{ type: 'text', text: cleanText || 'Let me look that up...' }],
    });
    apiMessages.push({
      role: 'user',
      content: `Tool result for ${narrated.name}:\n${resolved}`,
    });
    const finalRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [{ type: 'text', text: system }],
        messages: apiMessages,
      }),
    });
    data = await finalRes.json();
    if (!finalRes.ok) {
      const err = new Error('Anthropic final request failed');
      err.status = finalRes.status;
      err.payload = data;
      throw err;
    }
  }

  if (collectedToolResults.length > 0) {
    data = { ...data, toolResults: collectedToolResults };
  }
  return data;
}

// POST /chat { messages: [{role, content}], system?: string }
app.post('/chat', async (req, res) => {
  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: `messages exceeds max of ${MAX_MESSAGES}` });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Pass-through when client supplies system (Netlify frontend with plan grid).
  // Auth (MAX_API_KEY) is the trust boundary; size is capped and tool rules are appended.
  if (system) {
    try {
      const mergedSystem = buildSystemPrompt(system);
      const data = await runAnthropicPassThrough({ system: mergedSystem, messages });
      return res.json(data);
    } catch (err) {
      if (err.status === 413) {
        return res.status(413).json({ error: err.message });
      }
      if (err.status && err.payload) {
        return res.status(err.status).json(err.payload);
      }
      console.error('Pass-through error:', err.message);
      return res.status(500).json({ error: 'Having trouble right now — try again in a moment.' });
    }
  }

  // LEGACY MODE — server-owned SYSTEM_PROMPT
  try {
    const reply = await chat(messages);
    res.json({ ok: true, reply });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Having trouble right now — try again in a moment.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

warnIfApiKeyMissing();
loadKnowledge();

app.listen(PORT, () => {
  console.log(`Max Guru backend running on port ${PORT}`);
});
