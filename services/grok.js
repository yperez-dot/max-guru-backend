// services/grok.js — Max Medicare Guru via xAI Grok (OpenAI-compatible API)
const { TOOLS, processTool } = require('./claude');

const XAI_BASE = process.env.XAI_API_BASE || 'https://api.x.ai/v1';
const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4.6';

function requireApiKey() {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    const err = new Error('XAI_API_KEY is not set — add it in Railway Variables');
    err.status = 503;
    throw err;
  }
  return key;
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
  // Frontend sends Anthropic-style { role, content } where content is a string.
  // Also accept OpenAI multi-part / tool messages if present.
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

async function callGrok({ system, messages, tools, maxTokens }) {
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

  console.log('OUTBOUND [grok redacted]', JSON.stringify({
    model: body.model,
    max_tokens: body.max_tokens,
    messageCount: body.messages.length,
    systemChars: system ? system.length : 0,
    tools: tools ? tools.length : 0,
  }));

  const res = await fetch(`${XAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || data?.error || `Grok HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

/**
 * Pass-through chat used by Netlify UI.
 * Returns Anthropic-shaped { content: [{type:'text', text}], toolResults? }
 * so artifacts/max-demo-FINAL-v7.html keep working unchanged.
 */
async function passThroughChat({ system, messages }) {
  const openaiTools = toOpenAITools(TOOLS);
  let apiMessages = normalizeMessages(messages);
  const collectedToolResults = [];
  let lastData = null;
  let lastMessage = null;

  for (let i = 0; i < 5; i++) {
    lastData = await callGrok({
      system,
      messages: apiMessages,
      tools: openaiTools,
      maxTokens: 8000,
    });
    lastMessage = lastData.choices?.[0]?.message || {};
    const toolCalls = lastMessage.tool_calls || [];

    if (!toolCalls.length) break;

    // Append assistant turn with tool_calls, then tool results
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
      console.log(`[Tool/grok] ${name}`);
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

  // Reactive fallback: model narrated a <tool_call> in text
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
    console.log(`[ReactiveToolCall/grok] ${toolName}`);
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
    lastData = await callGrok({
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
    provider: 'grok',
    role: 'assistant',
    content: [{ type: 'text', text: text || "I couldn't generate a response. Try again." }],
    stop_reason: 'end_turn',
    usage: lastData?.usage,
  };
  if (collectedToolResults.length) out.toolResults = collectedToolResults;
  return out;
}

/** Legacy KB path — returns plain string reply */
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
};
