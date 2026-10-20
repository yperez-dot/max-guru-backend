// Robert and Andrea (2026-10-19): "CAN YOU PLEASE RUN THIS SEARCH FOR HUMANA PPO Humana Choice H7617-107 AND Humana
// Choice Giveback H7617-110" got the old 3-plan table back plus "Question: Are Sandman and Taub the providers below?"
// with nothing below it. Golden scenarios: services/golden/scenarios/robert-andrea-*.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const HF = require('./humanaFindcare');
const { _chatResultForTests: chatResult } = require('./grok');

test('H7617-107 and H7617-110 are 2027 Humana PPO plans in Miami-Dade plan data, checked in Humana Find Care (Medicare PPO27)', () => {
  for (const id of ['H7617-107', 'H7617-110']) {
    const row = R.gridPlansForCounty('Miami-Dade', 2027).find((g) => String(g.planId).toUpperCase() === id);
    assert.ok(row, `${id} in 2027 Miami-Dade plan data`);
    assert.equal(row.type, 'PPO');
    assert.equal(R.carrierOfPlan(row), 'Humana');
    const net = HF.THEI_HUMANA_NETWORKS.find((n) => (n.plans || []).some((p) => p.cmsId === id));
    assert.ok(net, `${id} on a Humana Find Care network`);
    assert.match(net.networkName, /PPO/);
  }
});

test('the model\'s "providers below" question is dropped when nothing is below it', () => {
  const reply = 'Here is the table.\n\nQuestion: Are Sandman and Taub the providers below?';
  assert.doesNotMatch(N.dropDanglingListLines(reply), /providers below/);
  const out = chatResult({ lastData: {}, text: reply, collectedToolResults: [], usageCalls: [], deadlineHit: false });
  const all = [out.content[0].text, (out.followUp && out.followUp.text) || ''].join('\n');
  assert.doesNotMatch(all, /providers below/);
  // A list that IS there stays.
  const listed = 'Which one is it? The closest providers below:\n• Yekutiel Sandman, MD (Urology, Miami, NPI 1013111491)';
  assert.equal(N.dropDanglingListLines(listed), listed);
});

test('with the server asking about the no-match doctors, the model\'s own version of that question is dropped', () => {
  const rendered = '**Doctors × top plans**\n\n| Doctor | UHC · H5420-001 |\n|---|---|\n| Yekutil Sandman | ❔ not confirmed |\n\n'
    + `${N.FOLLOW_UP_MARKER}\nNo exact match for:\n• "Yekutil Sandman" — closest: Yekutiel Sandman, MD (Urology, Miami, NPI 1013111491)\nReply "Yekutil Sandman = Dr. Full Name".`;
  const model = 'Question: Are Sandman and Taub the providers below?\nAre these the right doctors: Yekutiel Sandman?';
  const out = N.enforceRenderedTable(model, rendered);
  assert.match(out, /NPI 1013111491/);
  assert.doesNotMatch(out, /providers below|right doctors/);
});

test('marketing names: one grid plan per name is added, a shared name is asked about', () => {
  const r = N.planNamesInAsk('ADD HUMANA CHOICE AND HUMANA CHOICE GIVEBACK', 'Miami-Dade');
  assert.deepEqual(r.ids, ['H7617-107']);
  assert.deepEqual(r.ambiguous.map((a) => a.ids.sort()), [['H7617-110', 'H7617-145']]);
  // Not an ask: a plan she mentions is not added.
  assert.deepEqual(N.planNamesInAsk('she is on humana choice', 'Miami-Dade').ids, []);
});
