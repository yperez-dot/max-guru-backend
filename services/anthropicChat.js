// services/anthropicChat.js — Claude (native Messages API) behind Max's OpenAI-shaped chat loop.
//
// grok.js speaks OpenAI chat/completions (messages with tool_calls / role:"tool",
// image_url parts). Anthropic's OpenAI-compat endpoint is test-only and has no
// prompt caching, and Max resends the whole plan grid every round — so this file
// translates to the native Messages API (with prompt caching) and back.
//
// Railway: LLM_PROVIDER=claude · ANTHROPIC_API_KEY · optional CLAUDE_MODEL (default claude-sonnet-5-5)
// · ANTHROPIC_WORKSPACE_ID (wrkspc_…) when the key is org-level, not scoped to a workspace.

const ANTHROPIC_VERSION = '2023-06-01';

function dataUrlToSource(url) {
  const m = String(url || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (m) return { type: 'base64', media_type: m[1], data: m[2] };
  if (/^https?:\/\//i.test(String(url || ''))) return { type: 'url', url: String(url) };
  return null;
}

/** OpenAI content (string | parts[]) → Anthropic content blocks. Empty text is dropped (API rejects it). */
function toBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return toBlocks(String(content));
  const out = [];
  for (const part of content) {
    if (typeof part === 'string') { out.push(...toBlocks(part)); continue; }
    if (!part) continue;
    if (part.type === 'text' || typeof part.text === 'string') {
      if (String(part.text || '').trim()) out.push({ type: 'text', text: String(part.text) });
      continue;
    }
    if (part.type === 'image_url' || part.image_url) {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
      const source = dataUrlToSource(url);
      if (source) out.push({ type: 'image', source });
      continue;
    }
    if (part.type === 'image' && part.source) out.push({ type: 'image', source: part.source });
  }
  return out;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

/** OpenAI messages → Anthropic messages (roles alternate; tool results ride in a user turn). */
function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text || '(empty)' }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = toBlocks(m.content);
      for (const tc of m.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || tc.name, input: parseArgs(tc.function?.arguments ?? tc.arguments) });
      }
      push('assistant', blocks);
      continue;
    }
    push('user', toBlocks(m.content));
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation continues)' }] });
  return out;
}

function toAnthropicTools(tools) {
  return (tools || []).map((t) => {
    const f = t.function || t;
    return { name: f.name, description: f.description || '', input_schema: f.parameters || f.input_schema || { type: 'object', properties: {} } };
  });
}

/**
 * Build the Messages API body. Cache breakpoints: the system prompt (tools + grid are
 * the same every round of a turn) and the latest message (each tool round reuses the
 * conversation so far).
 */
function buildAnthropicBody({ model, system, messages, tools, maxTokens, temperature = 0.3 }) {
  const body = {
    model,
    max_tokens: maxTokens || 8000,
    temperature,
    messages: toAnthropicMessages(messages),
  };
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tools && tools.length) {
    body.tools = toAnthropicTools(tools);
    body.tool_choice = { type: 'auto' };
  }
  const last = body.messages[body.messages.length - 1];
  const lastBlock = last && last.content[last.content.length - 1];
  if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
  return body;
}

const FINISH = { tool_use: 'tool_calls', end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'stop', pause_turn: 'stop' };

/** Anthropic response → the OpenAI chat/completions shape grok.js reads. */
function fromAnthropicResponse(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
    id: b.id,
    type: 'function',
    function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
  }));
  const u = data?.usage || {};
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  const fresh = Number(u.input_tokens) || 0;
  return {
    id: data?.id,
    model: data?.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: FINISH[data?.stop_reason] || 'stop',
    }],
    usage: {
      prompt_tokens: fresh + cacheRead + cacheWrite,
      completion_tokens: Number(u.output_tokens) || 0,
      prompt_tokens_details: { cached_tokens: cacheRead },
      cache_creation_input_tokens: cacheWrite,
    },
  };
}

async function callAnthropic({ base, key, model, system, messages, tools, maxTokens, timeoutMs, workspaceId = process.env.ANTHROPIC_WORKSPACE_ID }) {
  const body = buildAnthropicBody({ model, system, messages, tools, maxTokens });
  const res = await fetch(`${base.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      // Org-level keys must name a workspace (Console → Settings → Workspaces → ID).
      ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Claude HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return fromAnthropicResponse(data);
}

module.exports = {
  callAnthropic,
  buildAnthropicBody,
  toAnthropicMessages,
  toAnthropicTools,
  fromAnthropicResponse,
  ANTHROPIC_VERSION,
};
