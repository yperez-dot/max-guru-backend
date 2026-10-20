// Yahoska, 2026-10-20: a lookup that runs out of time is not "❔ not confirmed". It reads "⏱ timed out" in the chat,
// the compare card and Excel/PDF ("Timed out — re-check", never blank), with a one-line note above the table, it is
// re-checked automatically, and drug cost never ranks plans while a med is timed out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');

const ASK = 'Ana Diaz, 33156. Compare H5420-014 and H1036-054C. meds: losartan, ezetimibe';
const timedDoc = { doctorName: 'Ana Diaz', requestedName: 'Ana Diaz', status: 'timeout', networks: [] };
const losartanOut = { drugName: 'losartan', timedOut: true, byPlanId: {}, lookups: [] };
const ezetimibe = { drugName: 'ezetimibe', lookups: [{ planId: 'H5420-014', verified: true, tier: 1 }, { planId: 'H1036-054C', verified: true, tier: 1 }], byPlanId: { 'H5420-014': { planId: 'H5420-014', verified: true, tier: 1, costShare: '$0' }, 'H1036-054C': { planId: 'H1036-054C', verified: true, tier: 1, costShare: '$0' } } };

test('chat table: ⏱ timed out cells, a count, a legend and one note line above the table', () => {
  const out = N.renderedAnswer([timedDoc], ASK, { drugs: [losartanOut, ezetimibe], recheck: true });
  const lines = out.split('\n');
  assert.equal(lines[0], '⏱ 1 doctor check and 1 med ran out of time — re-checking… the table updates here when they finish.');
  assert.match(lines.find((l) => /^\| Ana Diaz/.test(l)), /\| ⏱ timed out \| ⏱ timed out \|/);
  assert.match(lines.find((l) => /^\| losartan/i.test(l)), /\| ⏱ timed out \| ⏱ timed out \|/);
  assert.match(lines.find((l) => /^\| ezetimibe/i.test(l)), /T1 \$0/);
  assert.match(out, /1 timed out\*\*/);
  assert.match(out, new RegExp(R.TIMED_OUT_LEGEND));
  assert.doesNotMatch(out, /Medication lookup failed/);
});

test('a pending carrier (still answering at the deadline) is ⏱; a failed one stays ❔ unchecked', () => {
  const doc = (pending, failed) => ({ doctorName: 'Ana Diaz', requestedName: 'Ana Diaz', npi: '1111111111', status: 'partial', pending, failed, networks: [], inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] });
  const row = (d) => N.renderedAnswer([d], 'Ana Diaz, 33156. Compare H1036-054C and H5420-014').split('\n').find((l) => /^\| Ana Diaz/.test(l));
  assert.match(row(doc(['Humana'], [])), /⏱ timed out/);
  assert.doesNotMatch(row(doc([], ['Humana'])), /⏱/);
});

test('never rank by drug cost while a med is timed out', () => {
  const docs = [{ doctorName: 'Ana Diaz', requestedName: 'Ana Diaz', status: 'done', networks: [], inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] }];
  const sel = N.selectComparison(docs, 'Ana Diaz, 33156. Rank all eligible plans. meds: losartan', { drugs: [losartanOut] });
  assert.ok(!/drug cost/i.test(String(sel.whyLine || '')), sel.whyLine);
});

test('no timeouts: no note, no legend change (tables unchanged)', () => {
  const out = N.renderedAnswer([{ ...timedDoc, status: 'done', inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] }], ASK, { drugs: [ezetimibe] });
  assert.doesNotMatch(out, /⏱/);
});

test('Excel/PDF: a timed-out doctor and med say "Timed out — re-check", never blank or Unverified', () => {
  const exp = require('../artifacts/comparison-export.js');
  const { toExportDrug } = require('./formularyLookup');
  const plans = [{ planId: 'H5420-014', carrier: 'UnitedHealthcare', planName: 'UHC MedicareMax Complete Care FL-30', county: 'Miami-Dade' }, { planId: 'H1036-054C', carrier: 'Humana', planName: 'Humana Gold Plus', county: 'Miami-Dade' }];
  const drugs = [toExportDrug(losartanOut), toExportDrug(ezetimibe)];
  assert.equal(drugs[0].timedOut, true);
  const payload = exp.buildExportPayload(plans, '', { planSetFixed: true, toolResults: [{ tool: 'lookup_provider_network', output: timedDoc }], drugs });
  const model = exp.buildComparisonModel({ ...payload, clientName: 'Client X', keepPlanOrder: true });
  const rowOf = (name) => model.aoa.find((r) => String(r[0] || '').toLowerCase().startsWith(name));
  assert.deepEqual(rowOf('losartan').slice(1), ['Timed out — re-check', 'Timed out — re-check']);
  assert.ok(rowOf('ezetimibe').slice(1).every((c) => /Tier 1/.test(c)));
  const doctorRow = rowOf('dr. ana diaz') || rowOf('ana diaz');
  assert.ok(doctorRow, model.aoa.map((r) => r[0]).join(' | '));
  assert.deepEqual(doctorRow.slice(1), ['Timed out — re-check', 'Timed out — re-check']);
  // A chat table cell "⏱ timed out" reads the same way.
  assert.ok(exp.NETWORK_TIMED_OUT === 'Timed out — re-check');
});

test('the background re-check result becomes chat bubbles: header, updated grid, then its notes', () => {
  const W = require('../artifacts/client-workups.js');
  const r = W.recheckReply({ rendered: '**Doctors × top plans**\n\n| Doctor | A |\n|---|---|\n| Ana | ✅ In |\n\n<!-- max:follow-up -->\nSNP note.', doctorsRechecked: 1, medsRechecked: 2, stillTimedOut: 0 });
  assert.match(r.grid, /^✅ Re-check finished — 3 timed-out checks updated:\n\n\*\*Doctors × top plans\*\*/);
  assert.equal(r.followUp, 'SNP note.');
  assert.match(W.recheckReply({ rendered: 'x', stillTimedOut: 2 }).grid, /^⏱ Re-check finished — 2 still timed out/);
  const html = require('fs').readFileSync(require.resolve('../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /if \(result\.recheck && result\.recheck\.id\) void followRecheck\(result\.recheck\.id, gen\);/);
  assert.match(html, /API_BASE \+ "\/chat\/recheck\/"/);
  assert.match(html, /function recheckReply\(result\)/, 'client-workups.js is synced into the page');
});

test('chat response carries the re-check id, and it is not an export tool result', () => {
  const { _chatResultForTests: chatResult } = require('./grok');
  const out = chatResult({ lastData: {}, text: 'table', collectedToolResults: [{ tool: 'lookup_formulary', output: losartanOut }, { tool: 'recheck', output: { recheckId: 'abc' } }], usageCalls: [], deadlineHit: false });
  assert.deepEqual(out.recheck, { id: 'abc' });
  assert.ok(out.toolResults.every((t) => t.tool !== 'recheck'));
});

test('compare card: a slow doctor gets a re-check pass before the table is drawn; only what is still unfinished shows ⏱', async () => {
  const C = require('./compareJobs');
  const calls = [];
  const lookupOneDoctor = async (input, opts) => {
    calls.push({ name: input.doctorName, background: Boolean(opts.background) });
    const n = calls.filter((c) => c.name === input.doctorName).length;
    if (input.doctorName === 'Slow Finisher' && n === 1) return { status: 'timeout', doctorName: input.doctorName, structured: { doctorName: input.doctorName, networks: [], status: 'timeout' } };
    if (input.doctorName === 'Never Answers') return { status: 'timeout', doctorName: input.doctorName, structured: { doctorName: input.doctorName, networks: [], status: 'timeout' } };
    return { status: 'done', doctorName: input.doctorName, structured: { doctorName: input.doctorName, npi: input.doctorName === 'Slow Finisher' ? '1999999999' : '1888888888', networks: [], inNetworkPlans: ['Humana Gold Plus (H1036-054C)'], outOfNetworkPlans: [], carriersIn: ['Humana'] } };
  };
  const job = { input: C.normalizeInput({ clientName: 'Ana Diaz', zip: '33156', year: 2027, doctors: [{ name: 'Slow Finisher' }, { name: 'Never Answers' }], meds: [], plans: ['H1036-054C', 'H5420-014'] }), progress: { doctors: { done: 0, total: 2 }, meds: { done: 0, total: 0 } }, result: {} };
  await C.runJob(job, { lookupOneDoctor, lookupRx: async () => ({ lookups: [], byPlanId: {} }) });
  assert.deepEqual(calls.filter((c) => c.background).map((c) => c.name).sort(), ['Never Answers', 'Slow Finisher']);
  assert.equal(job.result.rechecked, 2);
  const table = job.result.doctorTable;
  assert.match(table.split('\n').find((l) => /Slow Finisher/.test(l)), /✅ In/);
  assert.match(table.split('\n').find((l) => /Never Answers/.test(l)), /⏱ timed out/);
  assert.equal(job.result.timedOutNote, '⏱ 1 doctor check ran out of time — send the same message again to re-check.');
  const W = require('../artifacts/client-workups.js');
  assert.ok(W.compareFollowUpLines(job.result).notes.includes(job.result.timedOutNote));
});

test('Excel/PDF built from the chat table: "⏱ timed out" cells export as "Timed out — re-check"', () => {
  const exp = require('../artifacts/comparison-export.js');
  const plans = [{ planId: 'H5420-014', carrier: 'UnitedHealthcare', planName: 'UHC MedicareMax', county: 'Miami-Dade' }, { planId: 'H1036-054C', carrier: 'Humana', planName: 'Humana Gold Plus', county: 'Miami-Dade' }];
  const t = N.renderedAnswer([timedDoc], 'Ana Diaz, 33156. Compare H5420-014 and H1036-054C. meds: losartan', { drugs: [losartanOut], recheck: true });
  const p = exp.buildExportPayload(plans, t, { chatTable: exp.latestChatTable([{ role: 'assistant', content: t }]), planSetFixed: true, toolResults: [], drugs: ['losartan'] });
  const rows = exp.buildComparisonModel({ ...p, clientName: 'X', keepPlanOrder: true }).aoa.filter((r) => /^(dr\. )?ana diaz$|^losartan$/i.test(String(r[0])));
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual(r.slice(1), ['Timed out — re-check', 'Timed out — re-check']);
});
