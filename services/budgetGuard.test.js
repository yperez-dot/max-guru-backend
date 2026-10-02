const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BudgetGuard,
  etDayKey,
  estimateUsageCost,
  matchesOverridePhrase,
} = require('./budgetGuard');

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-budget-'));
  const clock = { now: options.now || new Date('2026-01-15T15:00:00Z') };
  const guard = new BudgetGuard({
    filePath: path.join(dir, 'usage.json'),
    budgetUsd: options.budgetUsd || 10,
    warnPcts: options.warnPcts || [50, 80],
    contextNudgeTokens: 100,
    now: () => clock.now,
  });
  return {
    guard,
    clock,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function openAiUsage(costUsd) {
  return [{
    model: 'gpt-4.1',
    usage: { prompt_tokens: Math.round((costUsd / 2) * 1_000_000), completion_tokens: 0 },
  }];
}

test('recognizes explicit override phrases without matching casual language', () => {
  for (const phrase of ['OK go over', 'override budget', 'continue anyway', 'Proceed anyway', 'yes go over']) {
    assert.equal(matchesOverridePhrase(phrase), true, phrase);
  }
  for (const phrase of ['what is the budget?', 'continue', 'go over that again', 'okay']) {
    assert.equal(matchesOverridePhrase(phrase), false, phrase);
  }
});

test('emits the 50 and 80 percent banners once per ET day', (t) => {
  const { guard, cleanup } = fixture();
  t.after(cleanup);

  let result = guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(5) });
  assert.deepEqual(result.banners.map((banner) => banner.id.endsWith('-50')), [true]);

  result = guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(1) });
  assert.equal(result.banners.length, 0);

  result = guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(2) });
  assert.deepEqual(result.banners.map((banner) => banner.id.endsWith('-80')), [true]);

  result = guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(1) });
  assert.equal(result.banners.length, 0);
  assert.deepEqual(guard.summary().warnedPcts, [50, 80]);
});

test('soft-blocks at budget and enables override for the rest of that day', (t) => {
  const { guard, cleanup } = fixture();
  t.after(cleanup);

  guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(10) });
  const blocked = guard.checkBeforeTurn([{ role: 'user', content: 'look at Humana' }]);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'daily_budget_reached');

  const override = guard.checkBeforeTurn([{ role: 'user', content: 'OK go over' }]);
  assert.equal(override.allowed, true);
  assert.equal(override.overrideActivated, true);
  assert.equal(guard.summary().overrideActive, true);

  const later = guard.checkBeforeTurn([{ role: 'user', content: 'compare these plans' }]);
  assert.equal(later.allowed, true);
  assert.equal(later.overrideActivated, false);
});

test('reloads same-day spend and override from the persisted ledger', (t) => {
  const { guard, clock, cleanup } = fixture();
  t.after(cleanup);

  guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(10) });
  guard.checkBeforeTurn([{ role: 'user', content: 'override budget' }]);

  const reloaded = new BudgetGuard({
    filePath: guard.filePath,
    budgetUsd: 10,
    warnPcts: [50, 80],
    now: () => clock.now,
  });
  assert.equal(reloaded.summary().spendUsd, 10);
  assert.equal(reloaded.summary().overrideActive, true);
  assert.deepEqual(reloaded.summary().warnedPcts, [50, 80]);
});

test('America/New_York rollover resets spend, warnings, and override', (t) => {
  const { guard, clock, cleanup } = fixture({ now: new Date('2026-01-15T04:59:00Z') });
  t.after(cleanup);

  assert.equal(etDayKey(clock.now), '2026-01-14');
  guard.recordTurn({ provider: 'openai', usageCalls: openAiUsage(10) });
  guard.checkBeforeTurn([{ role: 'user', content: 'override budget' }]);
  assert.equal(guard.summary().overrideActive, true);

  clock.now = new Date('2026-01-15T05:01:00Z');
  const nextDay = guard.summary();
  assert.equal(nextDay.day, '2026-01-15');
  assert.equal(nextDay.spendUsd, 0);
  assert.equal(nextDay.overrideActive, false);
  assert.deepEqual(nextDay.warnedPcts, []);
});

test('cost estimate applies cached-input and long-context model rates', () => {
  const short = estimateUsageCost({
    provider: 'grok',
    model: 'grok-4.6',
    usage: {
      prompt_tokens: 100000,
      completion_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 50000 },
    },
  });
  assert.equal(short.costUsd, 0.131);

  const long = estimateUsageCost({
    provider: 'grok',
    model: 'grok-4.6',
    usage: { prompt_tokens: 200000, completion_tokens: 1000 },
  });
  assert.equal(long.costUsd, 0.812);
});

test('heavy context returns a start-new-chat nudge', (t) => {
  const { guard, cleanup } = fixture();
  t.after(cleanup);
  assert.equal(guard.contextNudge('small', [{ role: 'user', content: 'short' }]), null);
  const nudge = guard.contextNudge('x'.repeat(400), []);
  assert.equal(nudge.id, 'long-thread');
  assert.match(nudge.message, /Start a new chat/i);
});
