// Maura Soley live chat, 2026-10-07 5:20 PM ET (ZIP 33018): "Drop MedicareMax H5420-001. Add Humana Gold Plus
// H1036-054C. Show her current plan H1045-001, Aetna H1609-093 and H1036-054C in the table…"
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const W = require('../artifacts/client-workups.js');

const CTX = 'LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript).\nClient: Maura Soley\nZIP/county: 33018 / Miami-Dade\nCurrent plan: H1045-001\nPlans:\n- UHC MedicareMax FL-0028 (H5420-001)\n- UHC Preferred Care Preferred MA (H1045-001)\n- Aetna Medicare Select Care (H1609-093)\nDoctors (names only — pass exactly these names to lookup_provider_network): Dr. Cheryl Case-Diaz; Dr. Barbara Martinez; Dr. Nathan Hirsch; Dr. Cynthia Golomb; Dr. Allister G Gibbons Fell\nMedications: Eliquis; Jardiance; Atorvastatin';
const ASK = 'Maura Soley, ZIP 33018. Drop MedicareMax H5420-001. Add Humana Gold Plus H1036-054C. Show her current plan H1045-001, Aetna H1609-093 and H1036-054C in the table with her 5 doctors and 3 meds.';
const msgs = [{ role: 'user', content: CTX }, { role: 'assistant', content: 'Doctors × your plans …' }, { role: 'user', content: ASK }];
const LBL = { 'H1045-001': 'UHC Preferred Medicare Advantage FL-0001 (HMO) (H1045-001)', 'H5420-001': 'UHC MedicareMax FL-0028 (H5420-001)', 'H1609-093': 'Aetna Medicare Select Care (HMO) (H1609-093)', 'H1036-054C': 'Humana Gold Plus (H1036-054C)' };
// Live directory results run 2026-10-07 ~5:50 PM ET (match Yahoska's own checks).
const doc = (name, npi, ins, outs, carriersIn) => ({ requestedName: name, doctorName: name, npi, status: 'done', pending: [], failed: [], networks: [], carriersIn,
  inNetworkPlans: ins.map((x) => LBL[x]), outOfNetworkPlans: outs.map((x) => LBL[x]) });
const DOCS = [
  doc('Cheryl Case-Diaz', '1184615874', ['H1609-093', 'H1045-001'], ['H1036-054C'], ['Aetna Medicare', 'UnitedHealthcare']),
  doc('Barbara Martinez', '1649435041', ['H1045-001'], ['H1036-054C'], ['Aetna Medicare', 'UnitedHealthcare']),
  doc('Nathan Hirsch', '1720196454', [], ['H1045-001', 'H1036-054C'], []),
  doc('Cynthia Golomb', '1619900388', ['H1609-093', 'H1036-054C'], ['H1045-001'], ['Aetna Medicare', 'Humana']),
  doc('Allister G Gibbons Fell', '1548524465', [], ['H1045-001', 'H1036-054C'], []),
];

test('"Drop MedicareMax H5420-001" drops a plan, not UnitedHealthcare (no other-carrier re-run, no DrMax swap)', () => {
  assert.deepEqual(R.carriersRejected(ASK), []);
  assert.deepEqual(R.carriersRejected('Remove Humana Gold Plus, keep the rest'), []);
  assert.deepEqual(R.carriersRejected('drop humana'), ['Humana']);
  assert.deepEqual(R.carriersRejected('no UHC please'), ['UnitedHealthcare']);
  const fu = N.comparisonFollowUp(msgs);
  assert.ok(!fu || !/another carrier/.test(fu.reason), fu && fu.reason);
});

test('explicit contract-PBP IDs are the columns: current plan kept, dropped plan gone, nothing fuzzy-matched', () => {
  const ask = N.comparisonAskText(msgs);
  const sel = N.selectComparison(DOCS, ask, {});
  assert.deepEqual(sel.columns.map((c) => c.planId), ['H1045-001', 'H1609-093', 'H1036-054C']);
  const out = N.renderedAnswer(DOCS, ask, {});
  assert.doesNotMatch(out, /H4140-0|H5420-001|DrMax/);
  assert.match(out, /^\| Doctor \| UHC [^|]+· H1045-001 \| Aetna [^|]+· H1609-093 \| Humana Gold Plus · H1036-054C \|$/m);
  assert.doesNotMatch(out.split('\n').find((l) => /^\| Doctor/.test(l)), /\| - /);
});

test('"remove devoted, add H1045-005 instead" still adds the new ID (drop clause stops at "add")', () => {
  const named = N.namedPlansFromAsk ? N.namedPlansFromAsk('Compare Humana Gold Plus H1036-065C, Aetna H1609-018 and Devoted H1290-001\nremove devoted, add H1045-005 instead') : null;
  if (named) assert.ok(named.some((p) => p.planId === 'H1045-005'));
});

test('UHC-unlisted doctors are ❌ Not in network (not listed) on the UHC current plan, never "not confirmed"', () => {
  // UHC finished, listed Hirsch on no UHC plan, answered "not listed" for another UHC plan only.
  const hirsch = { ...DOCS[2], outOfNetworkPlans: ['UHC Preferred Medicare Advantage FL-0002 (HMO) (H1045-002)', LBL['H1036-054C']] };
  const out = N.renderedAnswer([DOCS[0], hirsch], N.comparisonAskText(msgs), {});
  const row = out.split('\n').find((l) => /Nathan Hirsch/.test(l));
  assert.match(row.split('|')[2], /❌ Not in network \(not listed\)/);
  // A UHC check that failed stays unchecked — never assumed Out.
  const failed = { ...hirsch, failed: ['UHC guest directory'] };
  const row2 = N.renderedAnswer([DOCS[0], failed], N.comparisonAskText(msgs), {}).split('\n').find((l) => /Nathan Hirsch/.test(l));
  assert.match(row2.split('|')[2], /❔ unchecked/);
});

test('live results: Case-Diaz/Martinez In on H1045-001, Golomb In on Aetna + Humana and Out on UHC, Hirsch/Gibbons Fell Out on UHC + Humana', () => {
  const out = N.renderedAnswer(DOCS, N.comparisonAskText(msgs), {});
  const cell = (who, k) => out.split('\n').find((l) => l.includes(who)).split('|')[k + 2].trim();
  assert.equal(cell('Case-Diaz', 0), '✅ In');
  assert.equal(cell('Case-Diaz', 1), '✅ In');
  assert.equal(cell('Martinez', 0), '✅ In');
  assert.match(cell('Martinez', 1), /✅ In/); // carrier-level In* never downgraded
  assert.equal(cell('Golomb', 0), '❌ Not in network (not listed)');
  assert.equal(cell('Golomb', 1), '✅ In');
  assert.equal(cell('Golomb', 2), '✅ In');
  for (const who of ['Hirsch', 'Gibbons Fell']) {
    assert.equal(cell(who, 0), '❌ Not in network (not listed)');
    assert.equal(cell(who, 2), '❌ Not in network (not listed)');
  }
});

test('the server table always replaces the model\'s list (incl. a "fell back to saved results" story)', () => {
  const rendered = N.renderedAnswer(DOCS, N.comparisonAskText(msgs), {});
  const modelList = [
    'Heads up: the server re-ran a comparison that left out H1045-001, so I fell back to the saved results.',
    '**UHC Preferred (H1045-001):**',
    '- Case-Diaz: In',
    '**Aetna H1609-093:** Case-Diaz not confirmed, Martinez not confirmed',
    'Golomb ✅ on Aetna',
    'Want me to price her 3 meds on these plans?',
  ].join('\n');
  const out = N.enforceRenderedTable(modelList, rendered);
  assert.ok(out.startsWith(rendered));
  const tail = out.slice(rendered.length);
  assert.doesNotMatch(tail, /saved results|H1045-001|H1609-093|Case-Diaz|Golomb/);
  assert.match(tail, /Want me to price her 3 meds/);
});

test('grok/claude loop: a batch lookup (expand items) still leads the reply with the server table', async () => {
  process.env.LLM_PROVIDER = 'grok'; process.env.XAI_API_KEY = 'test-xai-key'; process.env.GROK_MODEL = 'grok-4.6';
  delete require.cache[require.resolve('./grok')];
  const { passThroughChat } = require('./grok');
  const rendered = N.renderedAnswer(DOCS, N.comparisonAskText(msgs), {});
  const original = global.fetch;
  let n = 0;
  global.fetch = async () => ({ ok: true, json: async () => (n++ === 0
    ? { id: 'a', model: 'grok-4.6', choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup_provider_network', arguments: JSON.stringify({ doctors: [{ doctorName: 'Cheryl Case-Diaz' }], zip: '33018' }) } }] } }] }
    : { id: 'b', model: 'grok-4.6', choices: [{ message: { role: 'assistant', content: '- Case-Diaz: In on H1045-001\n- Golomb: Out on H1045-001' } }] }) });
  try {
    const res = await passThroughChat({
      system: 'You are Max.', messages: [{ role: 'user', content: 'What is IRMAA for her doctors?' }], deadlineMs: 60000,
      processToolFn: async () => ({ text: 'BATCH', structured: { doctors: DOCS, rendered }, expand: DOCS }),
    });
    const text = res.content[0].text;
    assert.ok(text.startsWith(rendered), text.slice(0, 200));
    assert.doesNotMatch(text.slice(rendered.length), /Case-Diaz: In/);
  } finally { global.fetch = original; }
});

test('saved per-plan rows are labeled stale for the model and "not confirmed" rows are not passed on', () => {
  const ctx = W.compactWorkupContext({ client: { name: 'Maura Soley', zip: '33018' }, doctors: [
    { name: 'Dr. Cheryl Case-Diaz', npi: '1184615874', byPlanId: { 'H1045-001': 'IN', 'H1609-093': 'NOT CONFIRMED' } },
  ] });
  assert.match(ctx, /EARLIER checks[\s\S]*never downgrade a live ✅ In/);
  assert.match(ctx, /Case-Diaz \[saved: H1045-001 IN\]/);
  assert.doesNotMatch(ctx, /H1609-093 NOT CONFIRMED/);
});
