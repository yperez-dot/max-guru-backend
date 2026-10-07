// services/grok.js — Max Medicare Guru via OpenAI-compatible chat (Grok, OpenAI or Claude)
const { TOOLS, processTool } = require('./claude');
const { callAnthropic } = require('./anthropicChat');
const { countImagesInMessages, normalizeMessages } = require('./chatImages');
const { fallbackAnswer, narrowingAnswered, comparisonAskText, comparisonFollowUp, enforceRenderedTable } = require('./doctorPlanNarrow');
const { conversationAskText } = require('./planYear');
const {
  shouldAutoLookupComparisonSob,
  uniquePlanIdsNeedingExportSob,
  askedOffGridFromText,
  messagePlainText,
  EXPORT_SOB_BENEFITS,
  userPlainText,
  gateSobPlanIds,
  maxSobLookupPlans,
} = require('./sobLookup');

/**
 * Provider selection (Railway Variables):
 *   LLM_PROVIDER=openai  → OPENAI_API_KEY (+ optional OPENAI_MODEL, OPENAI_API_BASE)
 *   LLM_PROVIDER=grok    → XAI_API_KEY     (+ optional GROK_MODEL, XAI_API_BASE)  [default]
 *   LLM_PROVIDER=claude  → ANTHROPIC_API_KEY (+ optional CLAUDE_MODEL, ANTHROPIC_API_BASE)
 *                          native Messages API with prompt caching (services/anthropicChat.js)
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
  if (provider === 'claude' || provider === 'anthropic') {
    return {
      provider: 'claude',
      base: process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1',
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      keyEnv: 'ANTHROPIC_API_KEY',
      key: process.env.ANTHROPIC_API_KEY,
      label: 'Claude',
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

/** Short doctor answer from finished tool results — used only when the model itself ran out of time. */
function fallbackFromToolResults(collected, askText = '', messages = []) {
  const doctors = collected
    .filter((t) => t.tool === 'lookup_provider_network' && t.output && (t.output.doctorName || t.output.requestedName))
    .map((t) => t.output);
  if (!doctors.length) return '';
  const drugs = collected
    .filter((t) => t.tool === 'lookup_formulary' && t.output && t.output.byPlanId)
    .map((t) => t.output);
  const body = fallbackAnswer(doctors, askText, { answered: narrowingAnswered(messages), drugs });
  // The tables are built from finished lookups and are the answer — no "ran out
  // of chat wait" footer. A doctor that didn't finish already shows ❔ in the table.
  return body;
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
  if (CONFIG.provider === 'claude') {
    return callAnthropic({ base: CONFIG.base, key, model: DEFAULT_MODEL, system, messages, tools, maxTokens: body.max_tokens, timeoutMs: ms });
  }
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
  // MAX_GROK_FETCH_MS caps later rounds. The FIRST round reads the whole plan
  // grid + thread and can legitimately take >40s; cutting it there meant
  // "timed out before any lookup ran". It may use everything up to the tool window.
  let modelRound = 0;
  const grokTimeout = () => {
    const cap = modelRound === 0
      ? Math.max(DEFAULT_GROK_FETCH_MS, toolDeadlineAt - Date.now() - 4000)
      : DEFAULT_GROK_FETCH_MS;
    return Math.max(500, Math.min(cap, remainingMs(deadline) - 1500));
  };
  const toolTimeLeft = () => toolDeadlineAt - Date.now();

  const pushToolResult = (name, result) => {
    const text = resolveToolResult(result);
    if (result && typeof result === 'object' && Array.isArray(result.expand) && result.expand.length) {
      // Batch doctor lookup → one entry per doctor so Export Excel/PDF sees each one.
      for (const item of result.expand) collectedToolResults.push({ tool: name, output: item });
      for (const extra of result.extraToolResults || []) {
        if (extra && extra.tool && extra.output) collectedToolResults.push(extra);
      }
    } else {
      const structured = result && typeof result === 'object' && result.structured ? result.structured : { text };
      collectedToolResults.push({ tool: name, output: structured });
    }
    return text;
  };

  // A comparison follow-up ("show me Doctors, Solis, Devoted", "1. no 2. … 3. yes") must
  // re-run the comparison. The model sometimes answers from its own previous reply instead,
  // which silently drops the carriers / answers — so the server runs it before the model does.
  const followUp = comparisonFollowUp(messages);
  if (followUp && toolTimeLeft() >= 15000) {
    console.log(`[AutoTool/${CONFIG.provider}] comparison follow-up: ${followUp.reason}; ${followUp.doctors.length} doctors, ZIP ${followUp.zip || '?'}`);
    const result = await raceUntil(
      Promise.resolve().then(() => runTool('lookup_provider_network', {
        doctors: followUp.doctors.map((doctorName) => ({ doctorName })),
        zip: followUp.zip || undefined,
      }, { messages, system, remainingMs: toolTimeLeft(), deadlineAt: toolDeadlineAt })).catch((e) => `lookup_provider_network error: ${e.message}`),
      toolDeadlineAt + toolGraceMs,
      () => '',
    );
    if (result) {
      const text = pushToolResult('lookup_provider_network', result);
      apiMessages.push({
        role: 'user',
        content:
          `Server re-ran the doctor/plan comparison for the agent's latest message (${followUp.reason}). ` +
          'This result already applies her answers and carrier choice. Copy its header, "Why these plans" line and tables as-is; ' +
          'do not re-rank, swap plans, or reuse the previous table. Do not call lookup_provider_network again for these doctors.\n' +
          text,
      });
    }
  }

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
            content: 'Chat wait is almost up — no more lookups. Answer now from the finished tool results only, SHORT: follow the ANSWER FORMAT in the tool result if there is one (one line per doctor with carrier names, max 3 candidate plans, then the narrowing questions). Never list every plan. Any doctor/drug/benefit without a finished result is NOT CONFIRMED (never out-of-network, never an invented dollar).',
          }])
          : apiMessages,
        tools: finalOnly ? null : openaiTools,
        // Short final answer = fast final answer.
        maxTokens: finalOnly && i > 0 ? 2500 : 8000,
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
    modelRound += 1;
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
          const asked = askedOffGridFromText(userPlainText(probeMessages));
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
    const partial = fallbackFromToolResults(collectedToolResults, comparisonAskText(messages, conversationAskText(messages)), messages);
    const out = chatResult({
      lastData,
      text: partial || '',
      collectedToolResults,
      usageCalls,
      deadlineHit,
    });
    if (partial && /\|---/.test(partial)) {
      // A full doctor/meds table is an answer, not a timeout: keep the resume data, drop the warning banner.
      delete out.deadline;
      out.stop_reason = 'end_turn';
    }
    return out;
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
      return chatResult({ lastData, text: fallbackFromToolResults(collectedToolResults, comparisonAskText(messages, conversationAskText(messages)), messages), collectedToolResults, usageCalls, deadlineHit: true });
    }
  }

  // Doctor/med network answers always use the server-rendered table (same layout, same cells
  // every time); the model's own bullets or re-drawn tables are dropped.
  const rendered = [...collectedToolResults].reverse()
    .find((t) => t && t.tool === 'lookup_provider_network' && t.output && t.output.rendered);
  if (rendered) text = enforceRenderedTable(text, rendered.output.rendered);
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
  callChatCompletions,
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

