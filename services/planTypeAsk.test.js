// Two plan comparisons for one client — one with only the HMOs, one with only the PPOs (Yahoska, 2026-10-19, Robert and
// Andrea, Miami-Dade 33186, current plan UHC H5420-001 HMO). Golden flows: services/golden/scenarios/robert-andrea-
// hmos-then-ppos.json, -ppos-then-hmos.json, -ppos-then-plain-ask.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('./doctorPlanNarrow');
const H = require('./golden/harness');
const exp = require('../artifacts/comparison-export.js');

const SC = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/scenarios/robert-andrea-hmos-then-ppos.json'), 'utf8'));
const run = (messages) => H.runScenario({ ...SC, messages });
const PPOS = ['H7617-107', 'H7617-110', 'H7617-145', 'R0759-001'];

test('HMO / PPO in any case, with or without the s, read as a plan-type-only ask', () => {
  for (const t of ['PPOs', 'only PPOs', 'only ppos', 'Only Ppo', 'PPO only', 'ppo ONLY', 'just the PPOs', 'show me the PPOs', 'Show me the ppo\'s',
    'all PPOs', 'top 5 PPOs', 'rank the PPO plans', 'rank the PPOs, top 5', 'what about PPOs?', 'she needs a PPO, top 5, without the current plan']) {
    assert.deepEqual(N.planTypeAsk(t) && N.planTypeAsk(t).type, 'ppo', t);
  }
  for (const t of ['compare all HMOs', 'just the HMOs', 'only hmos', 'HMO only', 'all hmos', 'show me the HMOs', 'rank the HMOs, top 5', 'Only HMOs please']) {
    assert.deepEqual(N.planTypeAsk(t) && N.planTypeAsk(t).type, 'hmo', t);
  }
  assert.equal(N.planTypeAsk('only PPOs').top, 5, 'top 5 by default');
  assert.equal(N.planTypeAsk('top 3 HMOs').top, 3);
  // Not a type-only ask: a carrier's plans of that type, a plan ID, both types, no type.
  for (const t of ['show me humana ppos', 'CAN YOU PLEASE RUN THIS SEARCH FOR HUMANA PPO Humana Choice H7617-107', 'HMO or PPO', 'add Dr. Smith', 'HMO ok']) {
    assert.equal(N.planTypeAsk(t), null, t);
  }
});

test('the plan type comes from her newest message only', () => {
  const msgs = (...texts) => texts.flatMap((t, k) => [...(k ? [{ role: 'assistant', content: 'table' }] : []), { role: 'user', content: t }]);
  const c = (m) => N.askConstraints(N.comparisonAskText(m));
  assert.deepEqual([c(msgs('only PPOs')).onlyPpo, c(msgs('only PPOs')).onlyHmo], [true, false]);
  // PPO ask, then an HMO ask: HMOs only (the PPO used to stick for the last 4 messages).
  assert.deepEqual([c(msgs('only PPOs', 'rank the HMOs, top 5')).onlyPpo, c(msgs('only PPOs', 'rank the HMOs, top 5')).onlyHmo], [false, true]);
  // PPO ask, then a message with no type: back to the normal HMO default.
  assert.deepEqual([c(msgs('show me the PPOs', 'add Dr. Smith')).onlyPpo, c(msgs('show me the PPOs', 'add Dr. Smith')).onlyHmo], [false, true]);
  // HMO ask, then a PPO ask.
  assert.equal(c(msgs('compare all HMOs', 'just the PPOs')).onlyPpo, true);
  // "either is fine": both types.
  assert.deepEqual([c(msgs('only PPOs', 'either is fine')).onlyPpo, c(msgs('only PPOs', 'either is fine')).onlyHmo], [false, false]);
});

test('every plural / casing variant gives the PPO-only table: 4 Dade PPOs, each its own column, current HMO left out', async () => {
  for (const t of ['PPOs', 'only PPOs', 'ONLY PPOS', 'PPO only', 'just the PPOs', 'show me the PPOs', 'all PPOs', 'top 5 PPOs', 'rank the PPO plans']) {
    const r = await run([t]);
    assert.ok(r.sets.followUp, `${t}: the server re-runs the comparison`);
    assert.deepEqual(H.gridHeaderIds(r.chat.grid), PPOS, `${t}: chat grid columns`);
    assert.match(r.chat.followUp, /Current plan \(UHC H5420-001, HMO\) left out since you asked for PPOs only\./, t);
    assert.doesNotMatch(`${r.chat.grid}\n${r.chat.followUp}`, /Why these plans|same doctor results as/i, t);
  }
  for (const t of ['HMOs', 'compare all HMOs', 'just the HMOs', 'Only hmos', 'HMO ONLY', 'show me the HMOs']) {
    const r = await run([t]);
    assert.ok(r.sets.followUp, `${t}: the server re-runs the comparison`);
    const ids = H.gridHeaderIds(r.chat.grid);
    assert.equal(ids[0], 'H5420-001', `${t}: current HMO first`);
    assert.ok(!ids.some((id) => PPOS.includes(id)), `${t}: no PPO column: ${ids}`);
    assert.doesNotMatch(r.chat.followUp || '', /left out since/, t);
  }
});

test('SNPs stay out of a type-only table unless Medicaid / a C-SNP condition is confirmed', async () => {
  const R = require('./comparisonRules');
  for (const t of ['only PPOs', 'compare all HMOs']) {
    const r = await run([t]);
    for (const id of H.gridHeaderIds(r.chat.grid).filter((x) => x !== 'H5420-001')) {
      assert.equal(R.snpKind(N.gridRowFor(id, 'Miami-Dade') || {}), '', `${t}: ${id} is not a SNP`);
    }
  }
});

test('each table\'s Export exports THAT table — the older HMO table, not the newer PPO table', async () => {
  const hmo = await run(['rank the HMOs, top 5']);
  const ppo = await run(['rank the HMOs, top 5', 'only PPOs']);
  const hmoIds = H.gridHeaderIds(hmo.chat.grid);
  assert.deepEqual(hmoIds, ['H5420-001', 'H1036-054C', 'H4140-022']);
  const offerA = { role: 'offer', content: 'export', tableId: 'tA', plans: hmoIds.map((planId) => ({ planId })) };
  const offerB = { role: 'offer', content: 'export', tableId: 'tB', plans: PPOS.map((planId) => ({ planId })) };
  const history = [
    { role: 'workup', workup: SC.workup },
    { role: 'user', content: 'rank the HMOs, top 5' },
    { role: 'assistant', content: hmo.chat.grid },
    offerA,
    { role: 'user', content: 'only PPOs' },
    { role: 'assistant', content: ppo.chat.grid },
    { role: 'assistant', content: ppo.chat.followUp, followUpOf: true },
    offerB,
  ];
  const opts = { currentPlanIds: ['H5420-001'] };
  // Before: every button read the whole chat, so the HMO table's button exported the PPO table.
  assert.deepEqual(exp.exportPlanIdsFromThread(history, null, opts), PPOS, 'whole chat = newest table (and no current HMO added)');
  const histA = exp.historyForExportOffer(history, offerA);
  assert.deepEqual(exp.exportPlanIdsFromThread(histA, null, opts), hmoIds, 'HMO table button → HMO columns');
  assert.deepEqual(exp.exportPlanIdsFromThread(exp.historyForExportOffer(history, offerB), null, opts), PPOS, 'PPO table button → PPO columns');
  // By index too, and an unknown offer falls back to the whole chat.
  assert.deepEqual(exp.exportPlanIdsFromThread(exp.historyForExportOffer(history, 3), null, opts), hmoIds);
  assert.equal(exp.historyForExportOffer(history, { tableId: 'nope' }).length, history.length);
  // The sheet itself: the HMO table's columns, doctors and meds.
  const tableA = exp.latestChatTable(histA);
  assert.deepEqual(tableA.planIds, hmoIds);
  assert.ok(tableA.rows.some((r) => /Regalado/i.test(r.name)), 'doctor rows from the HMO table');
  const plans = hmoIds.map((id) => { const g = N.gridRowFor(id, 'Miami-Dade') || {}; return { planId: id, carrier: g.carrier, planName: g.planName, county: 'Miami-Dade' }; });
  const model = exp.buildComparisonModel({ ...exp.buildExportPayload(plans, hmo.chat.grid, { chatTable: tableA, planSetFixed: true, toolResults: hmo.job.result.toolResults, drugs: [] }), keepPlanOrder: true });
  const head = model.aoa.find((row) => row.some((c) => /\b[HR]\d{4}-\d{3}/.test(String(c))));
  assert.deepEqual(head.slice(1).map((c) => (String(c).match(/[HR]\d{4}-\d{3}[A-Z]?/) || [''])[0].toUpperCase()), hmoIds, 'export columns = the HMO table');
  const regalado = model.aoa.find((row) => /Regalado/i.test(String(row[0])));
  assert.match(String(regalado[1]), /In/i, 'Regalado In on UHC H5420-001 (HMO table cell)');
});
