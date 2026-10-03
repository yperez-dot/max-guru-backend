// services/grok.js — Max Medicare Guru via OpenAI-compatible chat (Grok or OpenAI)
const { TOOLS, processTool } = require('./claude');
const { countImagesInMessages, normalizeMessages } = require('./chatImages');
const {
  shouldAutoLookupComparisonSob,
  uniquePlanIdsNeedingExportSob,
  askedOffGridFromText,
  messagePlainText,
  EXPORT_SOB_BENEFITS,
} = require('./sobLookup');

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
      imageCount: countImagesInMessages(messages),
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
async function passThroughChat({ system, messages, processToolFn }) {
  const runTool = typeof processToolFn === 'function' ? processToolFn : processTool;
  const openaiTools = toOpenAITools(TOOLS);
  let apiMessages = normalizeMessages(messages, { validate: false });
  const collectedToolResults = [];
  const usageCalls = [];
  let lastData = null;
  let lastMessage = null;
  let autoSobLookupDone = false;

  const captureUsage = (data) => {
    if (!data?.usage) return;
    usageCalls.push({ model: data.model || DEFAULT_MODEL, usage: data.usage });
  };

  for (let i = 0; i < 5; i++) {
    lastData = await callChatCompletions({
      system,
      messages: apiMessages,
      tools: openaiTools,
      maxTokens: 8000,
    });
    captureUsage(lastData);
    lastMessage = lastData.choices?.[0]?.message || {};
    const toolCalls = lastMessage.tool_calls || [];

    if (!toolCalls.length) {
      const probeMessages = apiMessages.concat(
        lastMessage && lastMessage.content
          ? [{ role: 'assistant', content: lastMessage.content }]
          : []
      );
      if (
        !autoSobLookupDone &&
        shouldAutoLookupComparisonSob(probeMessages, collectedToolResults)
      ) {
        autoSobLookupDone = true;
        const planIds = uniquePlanIdsNeedingExportSob(probeMessages, collectedToolResults);
        if (planIds.length) {
          const asked = askedOffGridFromText(messagePlainText(probeMessages));
          console.log(`[AutoTool/${CONFIG.provider}] lookup_sob_benefit ${planIds.join(',')}`);
          const result = await runTool('lookup_sob_benefit', {
            planIds,
            benefits: asked.benefits.length ? asked.benefits.slice() : EXPORT_SOB_BENEFITS.slice(),
            query: asked.query || 'asked off-grid benefits',
          });
          const text = resolveToolResult(result);
          const structured =
            result && typeof result === 'object' && result.structured
              ? result.structured
              : { text };
          collectedToolResults.push({ tool: 'lookup_sob_benefit', output: structured });
          apiMessages.push({
            role: 'assistant',
            content: lastMessage.content || 'Looking up the asked off-grid benefit from each plan SOB, then EOC if needed.',
          });
          apiMessages.push({
            role: 'user',
            content:
              'Required SOB lookup because the agent asked for a benefit that is not on the THEI grid. ' +
              'Read the Summary of Benefits first, then the Evidence of Coverage if the SOB does not have it. ' +
              'Quote only this extract. Unverified if it is not in either. Never invent dollars. Never print chopped PDF fragments.\n' +
              text,
          });
          continue;
        }
      }
      break;
    }

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
      const result = await runTool(name, input);
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
    const toolResult = await runTool(toolName, toolInput);
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
    captureUsage(lastData);
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
    usageCalls,
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
  normalizeMessages,
  toOpenAITools,
  DEFAULT_MODEL,
  providerConfig,
};
