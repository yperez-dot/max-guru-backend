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
app.get('/debug-tools', (req, res) => {
  try {
    const { TOOLS } = require('./services/claude');
    res.json({ toolsType: typeof TOOLS, toolsIsArray: Array.isArray(TOOLS), toolsLength: Array.isArray(TOOLS) ? TOOLS.length : null, toolNames: Array.isArray(TOOLS) ? TOOLS.map(t => t.name) : null });
  } catch(e) { res.json({ error: e.message }); }
});

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
    // PASS-THROUGH MODE with tool support
    const { TOOLS, processTool } = require('./services/claude');
    try {
      const apiMessages = [...messages];
      let data;
      const collectedToolResults = [];  // v11: track all tool calls + results

      for (let i = 0; i < 5; i++) {
        const requestBody = {
          model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: apiMessages,
          tools: TOOLS,
        };
        console.log('TOOLS_CHECK', typeof TOOLS, Array.isArray(TOOLS) ? TOOLS.length : 'n/a');
        console.log('OUTBOUND', JSON.stringify({ ...requestBody, system: '[omitted]' }).slice(0, 1500));
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
            console.log(`[Tool] ${block.name}(${JSON.stringify(block.input)})`);
            const result = await processTool(block.name, block.input);
            const resolvedResult = typeof result === 'string' ? result : await result;
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resolvedResult });
            collectedToolResults.push({ name: block.name, input: block.input, result: resolvedResult });
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
          console.log(`[ReactiveToolCall] ${toolName}(${JSON.stringify(toolInput)})`);
          const toolResult = await processTool(toolName, toolInput);
          // Strip the tool call from the text and inject result
          const cleanText = textBlock.text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '').trim();
          apiMessages.push({ role: 'assistant', content: [{ type: 'text', text: cleanText || 'Let me look that up...' }] });
          apiMessages.push({ role: 'user', content: `Tool result for ${toolName}:\n${typeof toolResult === 'string' ? toolResult : await toolResult}` });
          // One more round to get final answer
          const finalRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6', max_tokens: 4000, system: [{ type: 'text', text: system }], messages: apiMessages }),
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
