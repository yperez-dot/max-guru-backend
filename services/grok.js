// services/grok.js — Max Medicare Guru via OpenAI-compatible chat (Grok or OpenAI)
const { TOOLS, processTool } = require('./claude');
const { countImagesInMessages, normalizeMessages } = require('./chatImages');
const {
  shouldAutoLookupComparisonSob,
  uniquePlanIdsNeedingExportSob,
  askedOffGridFromText,
  messagePlainText,
  EXPORT_SOB_BENEFITS,
  gateSobPlanIds,
  maxSobLookupPlans,
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
// Browser aborts /chat at 120s (max-demo-FINAL-v7.html). The server must always
// answer before that, so the deadline is hard-capped below it.
const CHAT_DEADLINE_CAP_MS = Number(process.env.MAX_CHAT_DEADLINE_CAP_MS || 110_000);
const DEFAULT_CHAT_DEADLINE_MS = Math.min(
  CHAT_DEADLINE_CAP_MS,
  Number(process.env.MAX_CHAT_DEADLINE_MS || 105_000)
);
const DEFAULT_GROK_FETCH_MS = Number(process.env.MAX_GROK_FETCH_MS || 20_000);
// Time held back after tools so the model can still write the answer from what finished.
const FINAL_ANSWER_RESERVE_MS = Number(process.env.MAX_FINAL_ANSWER_RESERVE_MS || 28_000);
const TOOL_CONCURRENCY = Number(process.env.MAX_TOOL_CONCURRENCY || 8);
// Kept "taking longer than the chat wait" in both — the UI uses it to refill the composer.
const DEADLINE_REPLY =
  'This lookup is taking longer than the chat wait. The lookups that finished are saved — send the same ask again and I continue from them (doctor lookups come back from cache instead of re-running). I will not invent dollars.';
const DEADLINE_REPLY_EMPTY =
  'This ask is taking longer than the chat wait, and the model timed out before any doctor / Rx / SOB lookup ran — nothing was saved yet. Sending again starts fresh.';

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

function capToolPlanIds(name, input) {
  if (name !== 'lookup_sob_benefit' && name !== 'lookup_formulary') return input || {};
  const next = input && typeof input === 'object' ? { ...input } : {};
  const raw = [].concat(next.planId || [], next.planIds || []).filter(Boolean);
  if (raw.length <= maxSobLookupPlans()) return next;
  const capped = gateSobPlanIds(raw, { source: name });
  console.warn(
    `[Tool/${CONFIG.provider}] ${name} oversized planIds=${raw.length}; capping to ${capped.length}`
  );
  next.planIds = capped;
  delete next.planId;
  return next;
}

function remainingMs(deadline) {
  return deadline - Date.now();
}

function chatResult({ lastData, text, collectedToolResults, usageCalls, deadlineHit }) {
  const resumable = collectedToolResults.length > 0;
  const fallback = deadlineHit
    ? (resumable ? DEADLINE_REPLY : DEADLINE_REPLY_EMPTY)
    : "I couldn't generate a response. Try again.";
  const out = {
    id: lastData?.id,
    model: lastData?.model || DEFAULT_MODEL,
    provider: CONFIG.provider,
    role: 'assistant',
    content: [{ type: 'text', text: text || fallback }],
    stop_reason: deadlineHit ? 'deadline' : 'end_turn',
    usage: lastData?.usage,
    usageCalls,
  };
  if (deadlineHit) {
    out.deadline = true;
    out.resume = { resumable, finished: collectedToolResults.length };
  }
  if (collectedToolResults.length) out.toolResults = collectedToolResults;
  return out;
}

/** Plain-text doctor table from finished tool results — used only when the model itself ran out of time. */
function fallbackFromToolResults(collected) {
  const doctors = collected.filter((t) => t.tool === 'lookup_provider_network' && t.output && (t.output.doctorName || t.output.requestedName));
  if (!doctors.length) return '';
  const lines = ['Doctor network check (the model ran out of chat wait before writing the summary — these are the raw finished results):'];
  for (const d of doctors) {
    const o = d.output;
    const label = o.requestedName && o.doctorName && o.requestedName !== o.doctorName
      ? `${o.requestedName} (${o.doctorName}${o.npi ? `, NPI ${o.npi}` : ''})`
      : `${o.doctorName || o.requestedName}${o.npi ? ` (NPI ${o.npi})` : ''}`;
    if (o.status === 'timeout' || o.status === 'error') {
      lines.push(`- ${label}: NOT CONFIRMED — lookup did not finish.`);
      continue;
    }
    if (o.status === 'not_found') {
      lines.push(`- ${label}: NOT CONFIRMED — no NPI match.`);
      continue;
    }
    const inNets = (o.networks || []).filter((n) => n.inNetwork).map((n) => (
      n.plans && n.plans.length ? `${n.carrier} (${n.plans.join('; ')})` : n.carrier
    ));
    const pending = (o.pending || []).length ? ` — still pending: ${o.pending.join(', ')}` : '';
    lines.push(`- ${label}: ${inNets.length ? `In network — ${inNets.join(', ')}` : 'no in-network hit in the finished checks (not confirmed out)'}${pending}`);
  }
  lines.push('');
  lines.push('Plan suggestions did not fit in this wait. Send the same ask again — finished doctor lookups are saved and come back instantly.');
  return lines.join('\n');
}

async function mapConcurrent(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return out;
}

function raceUntil(promise, deadlineAt, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), Math.max(0, deadlineAt - Date.now()));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callChatCompletions({ system, messages, tools, maxTokens, timeoutMs }) {
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

  const ms = Math.max(1000, Number(timeoutMs) || DEFAULT_GROK_FETCH_MS);
  const res = await fetch(`${CONFIG.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
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
async function passThroughChat({ system, messages, processToolFn, deadlineMs }) {
  const runTool = typeof processToolFn === 'function' ? processToolFn : processTool;
  const openaiTools = toOpenAITools(TOOLS);
  let apiMessages = normalizeMessages(messages, { validate: false });
  const collectedToolResults = [];
  const usageCalls = [];
  let lastData = null;
  let lastMessage = null;
  let autoSobLookupDone = false;
  let deadlineHit = false;
  let answerText = '';
  const requested = Number(deadlineMs) > 0 ? Number(deadlineMs) : DEFAULT_CHAT_DEADLINE_MS;
  const deadline = Date.now() + Math.min(requested, CHAT_DEADLINE_CAP_MS);
  // Tools must stop here so the last model call still fits before the deadline.
  const reserve = Math.min(FINAL_ANSWER_RESERVE_MS, Math.floor((deadline - Date.now()) * 0.4));
  const toolDeadlineAt = deadline - reserve;
  // Thresholds scale with the reserve (production: 6s / 6s / 3s / 1.5s).
  const minModelMs = Math.max(500, Math.min(6000, reserve / 2));
  const minToolWindowMs = Math.min(6000, reserve / 2);
  const minToolStartMs = Math.min(3000, reserve / 4);
  const toolGraceMs = Math.min(1500, reserve / 10);

  const captureUsage = (data) => {
    if (!data?.usage) return;
    usageCalls.push({ model: data.model || DEFAULT_MODEL, usage: data.usage });
  };
  const grokTimeout = () => Math.max(500, Math.min(DEFAULT_GROK_FETCH_MS, remainingMs(deadline) - 1500));
  const toolTimeLeft = () => toolDeadlineAt - Date.now();

  const pushToolResult = (name, result) => {
    const text = resolveToolResult(result);
    if (result && typeof result === 'object' && Array.isArray(result.expand) && result.expand.length) {
      // Batch doctor lookup → one entry per doctor so Export Excel/PDF sees each one.
      for (const item of result.expand) collectedToolResults.push({ tool: name, output: item });
    } else {
      const structured = result && typeof result === 'object' && result.structured ? result.structured : { text };
      collectedToolResults.push({ tool: name, output: structured });
    }
    return text;
  };

  for (let i = 0; i < 6; i++) {
    if (remainingMs(deadline) < minModelMs) {
      deadlineHit = true;
      console.warn(`[chat] deadline before model round ${i + 1}; returning partial`);
      break;
    }
    // Past the tool window (or out of rounds): ask for the answer with no tools.
    const finalOnly = i === 5 || toolTimeLeft() < minToolWindowMs;
    try {
      lastData = await callChatCompletions({
        system,
        messages: finalOnly && i > 0
          ? apiMessages.concat([{
            role: 'user',
            content: 'Chat wait is almost up — no more lookups. Answer now from the finished tool results only. Any doctor/drug/benefit without a finished result is NOT CONFIRMED (never out-of-network, never an invented dollar).',
          }])
          : apiMessages,
        tools: finalOnly ? null : openaiTools,
        maxTokens: 8000,
        timeoutMs: grokTimeout(),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        deadlineHit = true;
        console.warn(`[chat] model fetch aborted: ${err.message}`);
        break;
      }
      throw err;
    }
    captureUsage(lastData);
    lastMessage = lastData.choices?.[0]?.message || {};
    const toolCalls = finalOnly ? [] : (lastMessage.tool_calls || []);

    if (!toolCalls.length) {
      answerText = typeof lastMessage.content === 'string' ? lastMessage.content : '';
      const probeMessages = apiMessages.concat(
        lastMessage && lastMessage.content
          ? [{ role: 'assistant', content: lastMessage.content }]
          : []
      );
      if (
        !finalOnly &&
        !autoSobLookupDone &&
        toolTimeLeft() >= 12000 &&
        shouldAutoLookupComparisonSob(probeMessages, collectedToolResults)
      ) {
        autoSobLookupDone = true;
        const planIds = uniquePlanIdsNeedingExportSob(probeMessages, collectedToolResults);
        if (planIds.length > maxSobLookupPlans()) {
          console.warn(
            `[AutoTool/${CONFIG.provider}] oversized SOB plan list (${planIds.length}); refusing grid dump`
          );
        } else if (planIds.length) {
          const asked = askedOffGridFromText(messagePlainText(probeMessages));
          console.log(`[AutoTool/${CONFIG.provider}] lookup_sob_benefit ${planIds.join(',')}`);
          const result = await runTool('lookup_sob_benefit', {
            planIds,
            benefits: asked.benefits.length ? asked.benefits.slice() : EXPORT_SOB_BENEFITS.slice(),
            query: asked.query || 'asked off-grid benefits',
            budgetMs: Math.max(4000, toolTimeLeft() - 2000),
          }, { messages, system, remainingMs: toolTimeLeft(), deadlineAt: toolDeadlineAt });
          const text = pushToolResult('lookup_sob_benefit', result);
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
          answerText = '';
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

    // All tool calls of a round run at once (8 doctors no longer wait on each other).
    // Each is bounded by toolDeadlineAt; an unfinished one comes back NOT CONFIRMED.
    const outcomes = await mapConcurrent(toolCalls, TOOL_CONCURRENCY, async (tc) => {
      const name = tc.function?.name || tc.name;
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch (_) {
        input = {};
      }
      input = capToolPlanIds(name, input);
      if (toolTimeLeft() < minToolStartMs) {
        return { tc, name, result: `Skipped ${name} — chat wait. NOT CONFIRMED. Answer with finished tool results. Do not invent dollars.`, skipped: true };
      }
      console.log(`[Tool/${CONFIG.provider}] ${name}`);
      const run = Promise.resolve()
        .then(() => runTool(name, input, {
          messages,
          system,
          remainingMs: toolTimeLeft(),
          deadlineAt: toolDeadlineAt,
        }))
        .catch((e) => `${name} error: ${e.message}`);
      const result = await raceUntil(run, toolDeadlineAt + toolGraceMs, () => ({
        text: `${name} did not finish before the chat wait — NOT CONFIRMED (not out-of-network, no invented dollars). It keeps running; asking again picks it up.`,
        structured: { text: 'NOT CONFIRMED — timed out', status: 'timeout', doctorName: input.doctorName },
      }));
      return { tc, name, result };
    });
    for (const { tc, name, result, skipped } of outcomes) {
      const text = skipped
        ? (collectedToolResults.push({ tool: name, output: { text: result } }), result)
        : pushToolResult(name, result);
      apiMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: text,
      });
    }
  }

  let text = answerText;
  if (deadlineHit) {
    const partial = fallbackFromToolResults(collectedToolResults);
    return chatResult({
      lastData,
      text: partial || '',
      collectedToolResults,
      usageCalls,
      deadlineHit,
    });
  }
  const toolMatch = text.match(
    /<tool_call>[\s\S]*?"name"\s*:\s*"(\w+)"[\s\S]*?(?:"arguments"|"parameters"|"input")\s*:\s*(\{[\s\S]*?\})[\s\S]*?<\/tool_call>/
  );
  if (toolMatch && toolTimeLeft() >= 8000) {
    const toolName = toolMatch[1];
    let toolInput = {};
    try {
      toolInput = JSON.parse(toolMatch[2]);
    } catch (_) {}
    toolInput = capToolPlanIds(toolName, toolInput);
    console.log(`[ReactiveToolCall/${CONFIG.provider}] ${toolName}`);
    const toolResult = await runTool(toolName, toolInput, {
      messages,
      system,
      remainingMs: toolTimeLeft(),
      deadlineAt: toolDeadlineAt,
    });
    const resolved = pushToolResult(toolName, toolResult);
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
    try {
      lastData = await callChatCompletions({
        system,
        messages: apiMessages,
        tools: null,
        maxTokens: 4000,
        timeoutMs: grokTimeout(),
      });
      captureUsage(lastData);
      lastMessage = lastData.choices?.[0]?.message || {};
      text = typeof lastMessage.content === 'string' ? lastMessage.content : '';
    } catch (err) {
      if (!(err && (err.name === 'TimeoutError' || err.name === 'AbortError'))) throw err;
      return chatResult({ lastData, text: fallbackFromToolResults(collectedToolResults), collectedToolResults, usageCalls, deadlineHit: true });
    }
  }

  return chatResult({ lastData, text, collectedToolResults, usageCalls, deadlineHit: false });
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
  capToolPlanIds,
  fallbackFromToolResults,
  CHAT_DEADLINE_CAP_MS,
  DEFAULT_CHAT_DEADLINE_MS,
  DEADLINE_REPLY,
  DEADLINE_REPLY_EMPTY,
};

