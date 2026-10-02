const fs = require('fs');
const path = require('path');
const { extractPlainText, summarizeContentForEstimate } = require('./chatImages');

const TIME_ZONE = 'America/New_York';
const DEFAULT_BUDGET_USD = 10;
const DEFAULT_WARN_PCTS = [50, 80];
const DEFAULT_CONTEXT_NUDGE_TOKENS = 120000;

const MODEL_RATES = [
  {
    provider: 'grok',
    model: /^grok-4\.6(?:$|-)/i,
    input: 2,
    cachedInput: 0.5,
    output: 6,
    longContextTokens: 200000,
    longInput: 4,
    longCachedInput: 1,
    longOutput: 12,
  },
  {
    provider: 'openai',
    model: /^gpt-4\.1(?:$|-)/i,
    input: 2,
    cachedInput: 0.5,
    output: 8,
  },
];

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseWarnPcts(value = process.env.MAX_SOFT_WARN_PCT) {
  const parsed = String(value || DEFAULT_WARN_PCTS.join(','))
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((pct) => Number.isFinite(pct) && pct > 0 && pct < 100);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function etDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function defaultState(day = etDayKey()) {
  return {
    day,
    spendUsd: 0,
    overrideActive: false,
    warnedPcts: [],
    turns: 0,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeState(value, day) {
  if (!value || value.day !== day) return defaultState(day);
  return {
    day,
    spendUsd: Math.max(0, Number(value.spendUsd) || 0),
    overrideActive: Boolean(value.overrideActive),
    warnedPcts: Array.isArray(value.warnedPcts)
      ? [...new Set(value.warnedPcts.map(Number).filter(Number.isFinite))]
      : [],
    turns: Math.max(0, Number(value.turns) || 0),
    updatedAt: value.updatedAt || new Date().toISOString(),
  };
}

function matchesOverridePhrase(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized) return false;
  return [
    /^(?:ok(?:ay)?\s+)?go over(?:\s+(?:the\s+)?budget)?$/,
    /^override(?:\s+(?:the\s+)?)?budget$/,
    /^continue anyway$/,
    /^proceed anyway$/,
    /^keep going(?: anyway)?$/,
    /^yes\s+(?:go over|override(?: the)? budget|continue anyway)$/,
  ].some((pattern) => pattern.test(normalized));
}

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== 'user') continue;
    return extractPlainText(messages[i].content);
  }
  return '';
}

function estimateContextTokens(system, messages) {
  let messageChars = 0;
  let imageTokens = 0;
  for (const message of messages || []) {
    const summary = summarizeContentForEstimate(message?.content);
    messageChars += summary.textChars;
    imageTokens += summary.imageTokens;
  }
  return Math.ceil((String(system || '').length + messageChars) / 4) + imageTokens;
}

function envRate(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveRates(provider, model, promptTokens = 0) {
  const overrideInput = envRate('MAX_MODEL_INPUT_USD_PER_M');
  const overrideCached = envRate('MAX_MODEL_CACHED_INPUT_USD_PER_M');
  const overrideOutput = envRate('MAX_MODEL_OUTPUT_USD_PER_M');
  if (overrideInput != null && overrideOutput != null) {
    return {
      input: overrideInput,
      cachedInput: overrideCached == null ? overrideInput : overrideCached,
      output: overrideOutput,
      source: 'env',
    };
  }

  const match = MODEL_RATES.find(
    (entry) => entry.provider === String(provider || '').toLowerCase() && entry.model.test(model || '')
  );
  if (!match) {
    return { input: 2, cachedInput: 0.5, output: 8, source: 'fallback' };
  }
  const isLong = match.longContextTokens && promptTokens >= match.longContextTokens;
  return {
    input: isLong ? match.longInput : match.input,
    cachedInput: isLong ? match.longCachedInput : match.cachedInput,
    output: isLong ? match.longOutput : match.output,
    source: isLong ? 'table-long-context' : 'table',
  };
}

function estimateUsageCost({ provider, model, usage }) {
  const promptTokens = Math.max(0, Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage?.completion_tokens ?? usage?.output_tokens) || 0);
  const cachedTokens = Math.min(
    promptTokens,
    Math.max(
      0,
      Number(
        usage?.prompt_tokens_details?.cached_tokens ??
          usage?.input_tokens_details?.cached_tokens ??
          usage?.cached_tokens
      ) || 0
    )
  );
  const rates = resolveRates(provider, model, promptTokens);
  const regularInputTokens = promptTokens - cachedTokens;
  const costUsd =
    (regularInputTokens * rates.input + cachedTokens * rates.cachedInput + outputTokens * rates.output) /
    1_000_000;
  return {
    costUsd,
    promptTokens,
    cachedTokens,
    outputTokens,
    rates,
  };
}

class BudgetGuard {
  constructor(options = {}) {
    this.filePath = options.filePath || process.env.MAX_USAGE_FILE || path.join(process.cwd(), 'data', 'max-usage.json');
    this.budgetUsd = positiveNumber(
      options.budgetUsd ?? process.env.MAX_DAILY_BUDGET_USD,
      DEFAULT_BUDGET_USD
    );
    this.warnPcts = options.warnPcts || parseWarnPcts();
    this.contextNudgeTokens = positiveNumber(
      options.contextNudgeTokens ?? process.env.MAX_CONTEXT_NUDGE_TOKENS,
      DEFAULT_CONTEXT_NUDGE_TOKENS
    );
    this.now = options.now || (() => new Date());
    this.state = this.readState();
  }

  currentDay() {
    return etDayKey(this.now());
  }

  readState() {
    const day = this.currentDay();
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')), day);
    } catch (_) {
      return defaultState(day);
    }
  }

  ensureCurrentDay() {
    const day = this.currentDay();
    if (this.state.day !== day) {
      this.state = defaultState(day);
      this.writeState();
    }
    return this.state;
  }

  writeState() {
    this.state.updatedAt = this.now().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  summary() {
    const state = this.ensureCurrentDay();
    return {
      day: state.day,
      timeZone: TIME_ZONE,
      spendUsd: Number(state.spendUsd.toFixed(6)),
      budgetUsd: this.budgetUsd,
      percentUsed: Number(((state.spendUsd / this.budgetUsd) * 100).toFixed(1)),
      overrideActive: state.overrideActive,
      warnedPcts: [...state.warnedPcts],
      turns: state.turns,
    };
  }

  checkBeforeTurn(messages) {
    const state = this.ensureCurrentDay();
    const overrideRequested = matchesOverridePhrase(lastUserText(messages));
    if (state.spendUsd >= this.budgetUsd && !state.overrideActive) {
      if (overrideRequested) {
        state.overrideActive = true;
        this.writeState();
        return { allowed: true, overrideActivated: true, usage: this.summary() };
      }
      return {
        allowed: false,
        code: 'daily_budget_reached',
        message:
          'Max has reached today’s $' +
          this.budgetUsd.toFixed(2) +
          ' budget. Say “OK go over,” “override budget,” or “continue anyway” to keep using Max today.',
        usage: this.summary(),
      };
    }
    return { allowed: true, overrideActivated: false, usage: this.summary() };
  }

  recordTurn({ provider, usageCalls = [] }) {
    const state = this.ensureCurrentDay();
    const estimates = usageCalls.map((call) =>
      estimateUsageCost({ provider, model: call.model, usage: call.usage })
    );
    const turnCostUsd = estimates.reduce((sum, estimate) => sum + estimate.costUsd, 0);
    state.spendUsd += turnCostUsd;
    state.turns += 1;

    const percentUsed = (state.spendUsd / this.budgetUsd) * 100;
    const crossed = this.warnPcts.filter(
      (pct) => percentUsed >= pct && !state.warnedPcts.includes(pct)
    );
    state.warnedPcts.push(...crossed);
    this.writeState();

    const banners = crossed.map((pct) => ({
      id: `budget-${state.day}-${pct}`,
      type: pct >= 80 ? 'warning' : 'info',
      message: `Max has used about ${Math.round(percentUsed)}% of today’s $${this.budgetUsd.toFixed(2)} budget.`,
    }));
    return {
      turnCostUsd: Number(turnCostUsd.toFixed(6)),
      estimates,
      banners,
      usage: this.summary(),
    };
  }

  contextNudge(system, messages) {
    const estimatedTokens = estimateContextTokens(system, messages);
    if (estimatedTokens < this.contextNudgeTokens) return null;
    return {
      id: 'long-thread',
      type: 'info',
      message: 'This chat is getting long. Start a new chat soon to keep Max fast and lower-cost.',
      estimatedTokens,
    };
  }
}

module.exports = {
  BudgetGuard,
  TIME_ZONE,
  etDayKey,
  estimateContextTokens,
  estimateUsageCost,
  matchesOverridePhrase,
  parseWarnPcts,
  resolveRates,
};
