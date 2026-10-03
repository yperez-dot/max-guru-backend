/**
 * One Max chat turn. Independent of the HTTP socket so a dropped phone
 * connection cannot cancel Grok / tool work.
 */
const { passThroughChat } = require('./grok');
const { ImageValidationError, normalizeMessages } = require('./chatImages');

function errorStatus(err, fallback = 500) {
  return err && Number.isInteger(err.status) ? err.status : fallback;
}

function errorMessage(err, fallback) {
  return (
    (err && err.message) ||
    (err && err.payload && err.payload.error && err.payload.error.message) ||
    (typeof err?.payload?.error === 'string' ? err.payload.error : null) ||
    fallback
  );
}

function applyBudgetMeta(data, budgetGuard, budgetCheck, system, messages) {
  const budgetResult = budgetGuard.recordTurn({
    provider: data.provider,
    usageCalls: data.usageCalls,
  });
  const banners = [...budgetResult.banners];
  if (budgetCheck && budgetCheck.overrideActivated) {
    banners.unshift({
      id: `budget-${budgetResult.usage.day}-override`,
      type: 'warning',
      message: 'Daily budget override is active until the next America/New_York day.',
    });
  }
  const contextNudge = budgetGuard.contextNudge(system, messages);
  if (contextNudge) banners.push(contextNudge);
  const out = { ...data, banners, budget: budgetResult.usage };
  delete out.usageCalls;
  return out;
}

function validateChatInput(body, options = {}) {
  const maxClientSystemChars = Number(options.maxClientSystemChars || process.env.MAX_CLIENT_SYSTEM_CHARS || 400000);
  if (!Array.isArray(body && body.messages) || !body.messages.length) {
    const err = new Error('messages array required');
    err.status = 400;
    throw err;
  }
  let messages;
  try {
    messages = normalizeMessages(body.messages, { validate: true });
  } catch (err) {
    if (err instanceof ImageValidationError || err.code === 'invalid_image') {
      throw err;
    }
    const wrapped = new Error(err.message || 'messages array required');
    wrapped.status = err.status || 400;
    throw wrapped;
  }
  const system = body.system;
  if (system != null && system !== '') {
    if (typeof system !== 'string') {
      const err = new Error('system must be a string');
      err.status = 400;
      throw err;
    }
    if (system.length > maxClientSystemChars) {
      const err = new Error(
        `system prompt too large (${system.length} chars; max ${maxClientSystemChars})`
      );
      err.status = 413;
      throw err;
    }
  }
  return { messages, system: typeof system === 'string' ? system : '' };
}

async function executeChatTurn({
  system,
  messages,
  budgetGuard,
  budgetCheck,
  toolAppendix = '',
  passThrough = passThroughChat,
  getLegacySystemPrompt,
} = {}) {
  if (system) {
    const mergedSystem = `${system}\n${toolAppendix || ''}`;
    try {
      const data = await passThrough({ system: mergedSystem, messages });
      return {
        httpStatus: 200,
        body: applyBudgetMeta(data, budgetGuard, budgetCheck, mergedSystem, messages),
      };
    } catch (err) {
      console.error('Grok pass-through error:', err.message);
      if (err.payload) console.error('Grok payload:', JSON.stringify(err.payload).slice(0, 500));
      const status = errorStatus(err, 500);
      if (status === 503) {
        const fail = new Error(
          'LLM is not configured yet — set OPENAI_API_KEY (LLM_PROVIDER=openai) or XAI_API_KEY on Railway.'
        );
        fail.status = 503;
        throw fail;
      }
      const fail = new Error(
        String(errorMessage(err, 'Having trouble right now — try again in a moment.'))
      );
      fail.status = status;
      throw fail;
    }
  }

  const { SYSTEM_PROMPT } = getLegacySystemPrompt
    ? { SYSTEM_PROMPT: getLegacySystemPrompt() }
    : require('./claude');
  try {
    const data = await passThrough({ system: SYSTEM_PROMPT, messages });
    const budgeted = applyBudgetMeta(data, budgetGuard, budgetCheck, SYSTEM_PROMPT, messages);
    const block = (budgeted.content || []).find((item) => item.type === 'text');
    return {
      httpStatus: 200,
      body: {
        ok: true,
        reply: block?.text || "I'm having trouble right now — please try again.",
        banners: budgeted.banners,
        budget: budgeted.budget,
        content: budgeted.content,
        toolResults: budgeted.toolResults,
      },
    };
  } catch (err) {
    console.error('Chat error:', err.message);
    const fail = new Error('Having trouble right now — try again in a moment.');
    fail.status = 500;
    throw fail;
  }
}

module.exports = {
  validateChatInput,
  executeChatTurn,
  applyBudgetMeta,
};
