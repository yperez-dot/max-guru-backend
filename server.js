require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chat } = require('./services/claude');
const { requireApiKey } = require('./middleware/auth');
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
    // Allow non-browser clients (no Origin) and allowlisted browser origins.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '3mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'max-guru', authRequired: true, ts: new Date().toISOString() });
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
- Use the provided tools via the API tool_use mechanism. Never invent <tool_call> XML or pretend you looked something up.
- For questions about whether a doctor/provider is in-network, call lookup_provider_network before answering.
- For medication name / NDC lookups, call search_drug before answering.
`;

// POST /chat { messages: [{role, content}], system?: string }
// Netlify (thei-max-guru.netlify.app) always sends system = buildSystemPrompt() (~280KB plan grid).
// Auth (MAX_API_KEY) is the trust boundary — do not reject client system prompts or the live UI breaks.
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

    // PASS-THROUGH MODE with tool support (required by Netlify frontend)
    const { TOOLS, processTool } = require('./services/claude');
    const mergedSystem = `${system}\n${TOOL_USE_APPENDIX}`;
    try {
      const apiMessages = [...messages];
      let data;
      const collectedToolResults = [];  // v11: track all tool calls + results

      for (let i = 0; i < 5; i++) {
        const requestBody = {
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: [{ type: 'text', text: mergedSystem, cache_control: { type: 'ephemeral' } }],
          messages: apiMessages,
          tools: TOOLS,
          tool_choice: { type: 'auto' },
        };
        console.log('OUTBOUND [redacted]', JSON.stringify({
          model: requestBody.model,
          max_tokens: requestBody.max_tokens,
          messageCount: requestBody.messages?.length,
          systemChars: mergedSystem.length,
          tools: Array.isArray(TOOLS) ? TOOLS.length : 0,
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
        if (!anthropicRes.ok) return res.status(anthropicRes.status).json(data);
        if (data.stop_reason !== 'tool_use') break;

        // Handle tool calls
        apiMessages.push({ role: 'assistant', content: data.content });
        const toolResults = [];
        for (const block of data.content) {
          if (block.type === 'tool_use') {
            console.log(`[Tool] ${block.name}`);
            const result = await processTool(block.name, block.input);
            const resolvedResult = (result && typeof result === 'object' && result.text)
              ? result.text
              : (typeof result === 'string' ? result : String(result));
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resolvedResult });
            const toolOutput = (result && typeof result === 'object' && result.structured)
              ? result.structured
              : { text: resolvedResult };
            collectedToolResults.push({ tool: block.name, output: toolOutput });
          }
        }
        apiMessages.push({ role: 'user', content: toolResults });
      }

      // Also handle text-narrated tool calls (Claude sometimes writes these as text)
      const textBlock = (data.content || []).find(b => b.type === 'text');
      if (textBlock) {
        const toolMatch = textBlock.text.match(/<tool_call>[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?(?:"arguments"|"parameters"|"input")\s*:\s*(\{[\s\S]*?\})[\s\S]*?<\/tool_call>/);
        if (toolMatch) {
          const toolName = toolMatch[1];
          let toolInput = {};
          try { toolInput = JSON.parse(toolMatch[2]); } catch(e) {}
          console.log(`[ReactiveToolCall] ${toolName}`);
          const toolResult = await processTool(toolName, toolInput);
          const resolved =
            (toolResult && typeof toolResult === 'object' && toolResult.text)
              ? toolResult.text
              : (typeof toolResult === 'string' ? toolResult : String(toolResult));
          // Strip the tool call from the text and inject result
          const cleanText = textBlock.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '').trim();
          apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: cleanText || 'Let me look that up...' }] });
          apiMessages.push({ role: 'user', content: `Tool result for ${toolName}:\n${resolved}` });
          // One more round to get final answer
          const finalRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 4000, system: [{ type: 'text', text: mergedSystem }], messages: apiMessages }),
          });
          data = await finalRes.json();
        }
      }

      // Attach toolResults to response for frontend (v11 export use)
      if (collectedToolResults.length > 0) {
        data = { ...data, toolResults: collectedToolResults };
      }
      return res.json(data);
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
