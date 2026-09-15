// services/grok.js — Max Medicare Guru via OpenAI-compatible chat (Grok or OpenAI)
const { TOOLS, processTool } = require('./claude');

/**
 * Provider selection (Railway Variables):
 *   LLM_PROVIDER=openai  → OPENAI_API_KEY (+ optional OPENAI_MODEL, OPENAI_API_BASE)
 *   LLM_PROVIDER=grok    → XAI_API_KEY     (+ optional GROK_MODEL, XAI_API_BASE)  [default]
 */
function providerConfig() {
  const provider = String(process.env.LLM_PROVIDER || 'grok').toLowerCase();
  if (provider === 'openai') {
    return {
      provider: 'openai',
      base: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4.1',
      keyEnv: 'OPENAI_API_KEY',
      key: process.env.OPENAI_API_KEY,
      label: 'OpenAI',
    };
  }
  return {
    provider: 'grok',
    base: process.env.XAI_API_BASE || 'https://api.x.ai/v1',
    model: process.env.GROK_MODEL || 'grok-4.6',
    keyEnv: 'XAI_API_KEY',
    key: process.env.XAI_API_KEY,
    label: 'Grok',
  };
}

const CONFIG = providerConfig();
const DEFAULT_MODEL = CONFIG.model;

function requireApiKey() {
  if (!CONFIG.key) {
    const err = new Error(
      `${CONFIG.keyEnv} is not set — add it in Railway Variables (LLM_PROVIDER=${CONFIG.provider})`
    );
    err.status = 503;
    throw err;
  }
  return CONFIG.key;
}

function toOpenAITools(anthropicTools) {
  return (anthropicTools || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function normalizeMessages(messages) {
  return (messages || []).map((m) => {
    if (typeof m.content === 'string' || m.content == null) {
      return { role: m.role, content: m.content ?? '' };
    }
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
        .map((b) => b.text || '')
        .join('\n');
      return { role: m.role, content: text };
    }
    return { role: m.role, content: String(m.content) };
  });
}

function resolveToolResult(result) {
  if (result && typeof result === 'object' && result.text) return result.text;
  if (typeof result === 'string') return result;
  return String(result);
}

async function callChatCompletions({ system, messages, tools, maxTokens }) {
  const key = requireApiKey();
  const body = {
    model: DEFAULT_MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
    max_tokens: maxTokens || 8000,
    temperature: 0.3,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  console.log(
    `OUTBOUND [${CONFIG.provider} redacted]`,
    JSON.stringify({
      model: body.model,
      max_tokens: body.max_tokens,
      messageCount: body.messages.length,
      systemChars: system ? system.length : 0,
      tools: tools ? tools.length : 0,
    })
  );

  const res = await fetch(`${CONFIG.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(
      data?.error?.message || data?.error || `${CONFIG.label} HTTP ${res.status}`
    );
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/** @deprecated use callChatCompletions */
async function callGrok(opts) {
  return callChatCompletions(opts);
}

/**
 * Pass-through chat used by Netlify UI.
 * Returns Anthropic-shaped { content: [{type:'text', text}], toolResults? }
 */
async function passThroughChat({ system, messages }) {
  const openaiTools = toOpenAITools(TOOLS);
  let apiMessages = normalizeMessages(messages);
  const collectedToolResults = [];
  let lastData = null;
  let lastMessage = null;

  for (let i = 0; i < 5; i++) {
    lastData = await callChatCompletions({
      system,
      messages: apiMessages,
      tools: openaiTools,
      maxTokens: 8000,
    });
    lastMessage = lastData.choices?.[0]?.message || {};
    const toolCalls = lastMessage.tool_calls || [];

    if (!toolCalls.length) break;

    apiMessages.push({
      role: 'assistant',
      content: lastMessage.content || null,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const name = tc.function?.name || tc.name;
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch (_) {
        input = {};
      }
      console.log(`[Tool/${CONFIG.provider}] ${name}`);
      const result = await processTool(name, input);
      const text = resolveToolResult(result);
      const structured =
        result && typeof result === 'object' && result.structured
          ? result.structured
          : { text };
      collectedToolResults.push({ tool: name, output: structured });
      apiMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: text,
      });
    }
  }

  let text = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
  const toolMatch = text.match(
    /<tool_call>[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?(?:"arguments"|"parameters"|"input")\s*:\s*(\{[\s\S]*?\})[\s\S]*?<\/tool_call>/
  );
  if (toolMatch) {
    const toolName = toolMatch[1];
    let toolInput = {};
    try {
      toolInput = JSON.parse(toolMatch[2]);
    } catch (_) {}
    console.log(`[ReactiveToolCall/${CONFIG.provider}] ${toolName}`);
    const toolResult = await processTool(toolName, toolInput);
    const resolved = resolveToolResult(toolResult);
    const cleanText = text
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
      .trim();
    apiMessages.push({
      role: 'assistant',
      content: cleanText || 'Let me look that up...',
    });
    apiMessages.push({
      role: 'user',
      content: `Tool result for ${toolName}:\n${resolved}`,
    });
    lastData = await callChatCompletions({
      system,
      messages: apiMessages,
      tools: openaiTools,
      maxTokens: 4000,
    });
    lastMessage = lastData.choices?.[0]?.message || {};
    text = typeof lastMessage.content === 'string' ? lastMessage.content : '';
    if (toolResult && typeof toolResult === 'object' && toolResult.structured) {
      collectedToolResults.push({ tool: toolName, output: toolResult.structured });
    } else {
      collectedToolResults.push({ tool: toolName, output: { text: resolved } });
    }
  }

  const out = {
    id: lastData?.id,
    model: lastData?.model || DEFAULT_MODEL,
    provider: CONFIG.provider,
    role: 'assistant',
    content: [{ type: 'text', text: text || "I couldn't generate a response. Try again." }],
    stop_reason: 'end_turn',
    usage: lastData?.usage,
  };
  if (collectedToolResults.length) out.toolResults = collectedToolResults;
  return out;
}

async function chat(messages, systemPrompt) {
  const data = await passThroughChat({
    system: systemPrompt,
    messages,
  });
  const block = (data.content || []).find((b) => b.type === 'text');
  return block?.text || "I'm having trouble right now — please try again.";
}

module.exports = {
  passThroughChat,
  chat,
  toOpenAITools,
  DEFAULT_MODEL,
  providerConfig,
};
