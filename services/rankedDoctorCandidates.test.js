// Ranked / plan-type tables show the near-match doctor candidates too (Yahoska, 2026-10-19: "add the doctor matches to
// ranked tables too"). Robert and Andrea, Miami-Dade 33186: she typed "Yekutil Sandman" and "Daid Taub"; the NPI
// registry's closest real providers are Yekutiel Sandman (NPI 1013111491) and David Andrew Taub (NPI 1891804696).
// Golden flows: services/golden/scenarios/robert-andrea-only-ppos-doctor-candidates.json,
// -only-ppos-confirm-candidates.json, -confirmed-then-only-ppos.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('./doctorPlanNarrow');
const H = require('./golden/harness');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/scenarios', f), 'utf8'));
const PPOS = ['H7617-107', 'H7617-110', 'H7617-145', 'R0759-001'];
const rowOf = (grid, who) => String(grid || '').split('\n').find((l) => l.startsWith(`| ${who}`)) || '';
const cellsOf = (grid, who) => rowOf(grid, who).split('|').slice(2, -1).map((x) => x.trim());

test('"only PPOs": candidates (name, specialty, city, NPI) in the notes bubble, and the ranking says it left them out', async () => {
  const run = await H.runScenario(load('robert-andrea-only-ppos-doctor-candidates.json'));
  assert.deepEqual(H.gridHeaderIds(run.chat.grid), PPOS);
  const fu = run.chat.followUp;
  assert.match(fu, /"Yekutil Sandman" — closest: Yekutiel Sandman, MD \(Urology, Miami, NPI 1013111491\)/);
  assert.match(fu, /"Daid Taub" — closest: David Andrew Taub, MD \(Urology, Boca Raton, NPI 1891804696\)/);
  assert.match(fu, /^Ranking left out Yekutil Sandman and Daid Taub \(not confirmed yet\)\./m);
  // The candidates are in the follow-up bubble, never the grid bubble; no "providers below" with nothing below.
  assert.doesNotMatch(run.chat.grid, /No exact match|closest:/);
  assert.doesNotMatch(`${run.chat.grid}\n${fu}`, /providers below/i);
  // Still unconfirmed: ❔ not confirmed on every PPO (never ❌).
  assert.ok(cellsOf(run.chat.grid, 'Daid Taub').every((c) => /not confirmed/.test(c)));
  // The model is told the server already asks it.
  const sum = N.batchSummaryForModel(run.job.result.doctors || [], run.sets.askText).text;
  assert.match(sum, /server already shows the doctor-match question/);
  assert.doesNotMatch(sum, /Q\d\. No exact match/);
});

test('she picks the candidates: each is checked by NPI on every plan in the table, the table stays PPO-only, and they count', async () => {
  for (const f of ['robert-andrea-only-ppos-confirm-candidates.json', 'robert-andrea-confirmed-then-only-ppos.json']) {
    const run = await H.runScenario(load(f));
    assert.deepEqual(H.gridHeaderIds(run.chat.grid), PPOS, f);
    assert.equal(run.sets.npis['Yekutiel Sandman'], '1013111491', f);
    assert.equal(run.sets.npis['David Andrew Taub'], '1891804696', f);
    assert.deepEqual(cellsOf(run.chat.grid, 'Yekutiel Sandman · NPI 1013111491').map((c) => c.replace(/\s*\(.*$/, '')), ['✅ In', '✅ In', '✅ In', '❌ Not in network'], f);
    assert.deepEqual(cellsOf(run.chat.grid, 'David Andrew Taub · NPI 1891804696'), ['✅ In', '✅ In', '✅ In', '✅ In'], f);
    // Counted in the ranking: the count row has no "not confirmed" doctors left.
    assert.match(rowOf(run.chat.grid, '**Doctors**'), /6 in · 1 not in network · 0 unchecked/, f);
    assert.doesNotMatch(run.chat.followUp, /No exact match|Ranking left out/, f);
  }
});

test('candidate picks: names, "X = Y", NPI, bare yes (one candidate only)', () => {
  const q = [
    'No exact match for:',
    '• "Yekutil Sandman" — closest: Yekutiel Sandman, MD (Urology, Miami, NPI 1013111491)',
    '• "Daid Taub" — closest: David Andrew Taub, MD (Urology, Boca Raton, NPI 1891804696); Harvey Carl Taub, MD (Urology, Ocala, NPI 1679523294)',
    'Reply "Yekutil Sandman = Dr. Full Name".',
  ].join('\n');
  const pick = (a) => N.candidatePicks(q, a).map((p) => `${p.asked}>${p.name}>${p.npi}`).sort();
  const both = ['Daid Taub>David Andrew Taub>1891804696', 'Yekutil Sandman>Yekutiel Sandman>1013111491'];
  assert.deepEqual(pick('Yekutiel Sandman, David Andrew Taub'), both);
  assert.deepEqual(pick('yes, Yekutiel Sandman and David Andrew Taub'), both);
  assert.deepEqual(pick('Yekutil Sandman = Yekutiel Sandman\nDaid Taub = Dr. David Andrew Taub, MD'), both);
  assert.deepEqual(pick('Taub is 1679523294'), ['Daid Taub>Harvey Carl Taub>1679523294']);
  assert.deepEqual(pick('Harvey Taub'), ['Daid Taub>Harvey Carl Taub>1679523294']);
  // A bare yes takes only a doctor with one candidate (Taub has two: still asked).
  assert.deepEqual(pick('yes'), ['Yekutil Sandman>Yekutiel Sandman>1013111491']);
  // Not an answer: plan asks, other names.
  assert.deepEqual(pick('only PPOs'), []);
  assert.deepEqual(pick('Maria Lopez'), []);
});
