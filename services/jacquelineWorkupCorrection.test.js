// Jacqueline Alexander, 2026-10-17: a correction turn on her loaded workup dropped the saved doctors and swapped plans.
// Repro: open the saved workup (H5420-001, H4140-022, H4140-023; doctors; 8 meds) and send the message below.
// Prod answered with only Neeta Jane Erinjeri, columns UHC / DrMax-Dade / Aetna H1609-093 ("best 2 of the other 5")
// and every med unchecked.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');
const W = require('../artifacts/client-workups.js');
const { conversationAskText } = require('./planYear');
const { mergeDoctors } = require('./workups');
const G = require('./medicalGroupRules');

const SAVED_DOCTORS = [
  'Natalie Regalado - Baptist Medical Group', 'Andrew Sable - Gastro Health', 'Pasquel DeSantis - Endocrinologist - Baptist',
  'German Ojeda-Correal - Baptist Spine Specialist', 'Patricia Mueller', 'Charles Kaiser', 'Elvin Silvestry - Dental Associates',
  'Neeta Erinjerri - Surgeon at Baptist Cancer Institute', 'Neeta Erinjerri - Surgeon at Baptist', 'Alan Chu', 'James Esserman',
  'Pascual De Santis', 'Neeta Jane Erinjeri',
];
const MEDS = ['Atorvastatin Calcium', 'Gabapentin', 'Levothyroxine Sodium', 'Metoprolol Succinate', 'Ozempic', 'Pantoprazole Sodium', 'Telmisartan', 'Rinvoq'];
// Saved results from OLDER comparisons carry other plan IDs (Aetna H1609-093, Humana, Devoted …) in the context message.
const OLD_IDS = { 'H5420-001': 'IN', 'H1609-093': 'IN', 'H1036-054C': 'OUT', 'H5521-306': 'IN', 'H1290-073': 'IN' };
const WORKUP = {
  clientName: 'Jacqueline Alexander', zip: '33186', county: 'Miami-Dade', currentPlanIds: ['H5420-001'],
  plans: [
    { carrier: 'UHC', planName: 'MedicareMax FL-0028', planId: 'H5420-001' },
    { carrier: 'Doctors', planName: 'Doctors DrMax-Dade', planId: 'H4140-022' },
    { carrier: 'Doctors', planName: 'Doctors DrSelect-SFL', planId: 'H4140-023' },
  ],
  doctors: SAVED_DOCTORS.map((name, i) => ({ name, byPlanId: i % 2 ? OLD_IDS : {} })),
  medications: MEDS.map((name) => ({ name, byPlanId: { 'H5420-001': { tier: '1' }, 'H1609-093': { tier: '1' }, 'H1036-054C': { tier: '2' }, 'H5521-306': { tier: '1' } } })),
};
const ASK = 'Replace Dr. Natalie Regalado with Dr. Nathalie Regalado, Baptist Medical Group, NPI 1467795633. Remove Dr. Pasquel DeSantis Endocrinologist Baptist and both Neeta Erinjerri Surgeon rows, since Pascual De Santis and Neeta Jane Erinjeri are already on the list. Keep the same 3 plans (UHC H5420-001, Doctors DrMax-Dade H4140-022, Doctors DrSelect-SFL H4140-023), all other doctors and all medications.';

const msgsFor = (text, workup = WORKUP) => W.messagesForApi([{ role: 'user', content: text }], workup);
const askTextFor = (msgs) => N.comparisonAskText(msgs, conversationAskText(msgs));
const plansFor = (msgs) => { const t = askTextFor(msgs); return N.namedPlansFromAsk(t, N.askConstraints(t)).map((p) => p.planId); };

describe('saved-workup correction turn (Jacqueline Alexander, 2026-10-17)', () => {
  it('re-runs every saved doctor: Natalie → Nathalie with her NPI, the named rows removed, the rest kept', () => {
    const f = N.comparisonFollowUp(msgsFor(ASK));
    assert.ok(f, 'the server must re-run the comparison');
    assert.deepEqual(f.doctors, [
      'Nathalie Regalado', 'Andrew Sable - Gastro Health', 'German Ojeda-Correal - Baptist Spine Specialist', 'Patricia Mueller',
      'Charles Kaiser', 'Elvin Silvestry - Dental Associates', 'Alan Chu', 'James Esserman', 'Pascual De Santis', 'Neeta Jane Erinjeri',
    ]);
    assert.equal(f.npis['Nathalie Regalado'], '1467795633');
    assert.equal(f.zip, '33186');
  });

  it('keeps exactly her 3 plans: saved-result lines in the workup context never become columns', () => {
    assert.deepEqual(plansFor(msgsFor(ASK)), ['H5420-001', 'H4140-022', 'H4140-023']);
  });

  it('the table names her 3 plans with no auto-pick ("the 3 plans you named")', () => {
    const doc = (name) => ({ status: 'done', requestedName: name, doctorName: name, inNetworkPlans: [], outOfNetworkPlans: [], networks: [], carriersIn: [] });
    const r = N.selectComparison([doc('Pascual De Santis'), doc('Neeta Jane Erinjeri')], askTextFor(msgsFor(ASK)), {});
    assert.deepEqual(r.columns.map((c) => c.planId), ['H5420-001', 'H4140-022', 'H4140-023']);
    assert.match(r.whyLine, /the 3 plans you named/);
    assert.doesNotMatch(r.whyLine, /best \d of the other/);
  });

  it('prices all 8 saved meds in the same run', () => {
    assert.deepEqual(R.medsFromAsk(askTextFor(msgsFor(ASK))), MEDS);
  });

  it('a first turn with no plan IDs continues from the workup: its 3 plans are the columns', () => {
    const msgs = msgsFor('Remove Dr. Pasquel DeSantis, Pascual De Santis is already on the list.');
    assert.deepEqual(plansFor(msgs), ['H5420-001', 'H4140-022', 'H4140-023']);
    const f = N.comparisonFollowUp(msgs);
    assert.ok(f && !f.doctors.some((d) => /Pasquel/.test(d)) && f.doctors.includes('Pascual De Santis'));
    assert.equal(f.doctors.length, SAVED_DOCTORS.length - 1);
  });

  it('plan edits still edit the workup plan set', () => {
    assert.deepEqual(plansFor(msgsFor('add Humana H1036-054C')), ['H5420-001', 'H4140-022', 'H4140-023', 'H1036-054C']);
    assert.deepEqual(plansFor(msgsFor('drop H4140-023')), ['H5420-001', 'H4140-022']);
    assert.deepEqual(plansFor(msgsFor('Compare H5420-001 and H1609-093 only')), ['H5420-001', 'H1609-093']);
  });

  it('a removal touches only the doctors she named', () => {
    const c = N.doctorRemovalClauses('Remove Dr. Pasquel DeSantis Endocrinologist Baptist and both Neeta Erinjerri Surgeon rows, since Pascual De Santis and Neeta Jane Erinjeri are already on the list.');
    assert.ok(N.removedByClauses('Pasquel DeSantis - Endocrinologist - Baptist', c));
    assert.ok(N.removedByClauses('Neeta Erinjerri - Surgeon at Baptist Cancer Institute', c));
    assert.ok(N.removedByClauses('Neeta Erinjerri - Surgeon at Baptist', c));
    assert.ok(!N.removedByClauses('Neeta Jane Erinjeri', c));
    assert.ok(!N.removedByClauses('Pascual De Santis', c));
    assert.ok(!N.removedByClauses('Andrew Sable - Gastro Health', c));
    assert.deepEqual(N.doctorRemovalClauses('drop H1290-073'), [], 'a plan removal is not a doctor removal');
  });

  it('pasted doctor list: "Remove Dr. X, Y is already on the list" drops X only (Y is not renamed)', () => {
    const f = N.comparisonFollowUp([
      { role: 'user', content: 'Client ZIP 33186. Doctors: Pasquel DeSantis - Endocrinologist, Pascual De Santis, Alan Chu. Plans: H5420-001' },
      { role: 'assistant', content: 'table' },
      { role: 'user', content: 'Remove Dr. Pasquel DeSantis, Pascual De Santis is already on the list.' },
    ]);
    assert.deepEqual(f.doctors, ['Pascual De Santis', 'Alan Chu']);
  });

  it('saved doctors: a respelled row replaces the stale one instead of piling up', () => {
    const merged = mergeDoctors(
      [{ name: 'Natalie Regalado - Baptist Medical Group', npi: '1396060109', byPlanId: { 'H1036-054C': 'IN' } }, { name: 'Andrew Sable - Gastro Health', byPlanId: {} }],
      [{ name: 'Nathalie Regalado', npi: '1467795633', byPlanId: { 'H5420-001': 'IN' } }],
    );
    assert.deepEqual(merged.map((d) => d.name), ['Nathalie Regalado', 'Andrew Sable - Gastro Health']);
    assert.equal(merged[0].npi, '1467795633');
    assert.deepEqual(merged[0].byPlanId, { 'H5420-001': 'IN' }, 'the wrong person\'s old results do not carry over');
  });

  it('page: a server full-list re-run replaces the saved doctors even when the list got shorter (marker)', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /finalDoctorListRef\.current = result\.doctorList \? result\.doctorList\.doctors : null;/);
    assert.match(html, /if \(Array\.isArray\(finalList\) && finalList\.length && built\.doctors\.length\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*built\.replaceDoctors = true;/);
  });
});

describe('BHMG primary care carrier rule (Yahoska, 2026-10-17)', () => {
  const doc = (name, extra) => ({ status: 'done', requestedName: name, doctorName: name, npi: '', inNetworkPlans: [], outOfNetworkPlans: [], networks: [], carriersIn: [], ...extra });
  it('Nathalie Regalado (BHMG PCP) is Out on Humana and Doctors HealthCare even when a directory says In', () => {
    const docs = [doc('Nathalie Regalado', {
      doctorName: 'Nathalie Regalado, MD', npi: '1467795633', specialty: 'Internal Medicine',
      inNetworkPlans: ['UHC MedicareMax (H5420-001)', 'Humana Gold Plus (H1036-054C)'],
      networks: [{ carrier: 'Humana', inNetwork: true }, { carrier: 'Doctors HealthCare Plans', inNetwork: true }],
      carriersIn: ['Humana', 'Doctors HealthCare Plans'],
    })];
    const r = N.selectComparison(docs, 'ZIP 33186.\nDr. Nathalie Regalado, Baptist Medical Group, NPI 1467795633. Compare H5420-001, H4140-022, H1036-054C.', {});
    const col = (id) => r.columns.find((c) => c.planId === id);
    assert.deepEqual(col('H5420-001').in, ['Nathalie Regalado']);
    assert.deepEqual(col('H4140-022').out, ['Nathalie Regalado']);
    assert.deepEqual(col('H1036-054C').out, ['Nathalie Regalado']);
    assert.ok(!col('H1036-054C').in.includes('Nathalie Regalado'));
    assert.ok(r.flags.some((f) => /Baptist Health Medical Group primary care takes only/.test(f)));
  });

  it('accepted carriers: Aetna (not HMO), HealthSpring, Florida Blue, UHC MedicareMax only', () => {
    const rule = G.GROUP_RULES.find((x) => x.key === 'bhmg-pcp');
    assert.ok(rule.acceptsPlan({ carrier: 'UnitedHealthcare', planId: 'H5420-001', name: 'UHC MedicareMax FL-0028' }));
    assert.ok(!rule.acceptsPlan({ carrier: 'UnitedHealthcare', planId: 'H1045-001', name: 'UHC Preferred MA FL-0001' }));
    assert.ok(!rule.acceptsPlan({ carrier: 'Aetna', planId: 'H1609-093', name: 'Aetna Medicare Select HMO', type: 'HMO' }));
    assert.ok(rule.acceptsPlan({ carrier: 'Aetna', planId: 'H5521-306', name: 'Aetna Medicare Premier PPO', type: 'PPO' }));
    assert.ok(rule.acceptsPlan({ carrier: 'Florida Blue', planId: 'H1035-001', name: 'Florida Blue Medicare' }));
    assert.ok(!rule.acceptsPlan({ carrier: 'Humana', planId: 'H1036-054C', name: 'Humana Gold Plus' }));
    assert.ok(!rule.acceptsPlan({ carrier: 'Doctors HealthCare', planId: 'H4140-022', name: 'Doctors DrMax-Dade' }));
  });

  it('BHMG specialists and non-BHMG PCPs are not touched', () => {
    assert.equal(G.groupRuleFor(doc('Pasquel DeSantis', { specialty: 'Endocrinology' }), 'Pasquel DeSantis - Endocrinologist - Baptist Medical Group'), null);
    assert.equal(G.groupRuleFor(doc('Kelys Caballero', { specialty: 'Family Medicine' }), 'Dr. Kelys Caballero, her PCP'), null);
    assert.ok(G.groupRuleFor(doc('Ana Perez', { specialty: 'Family Medicine' }), 'Dr. Ana Perez - Baptist Health Medical Group'));
  });
});

describe('server follow-up table is not replaced by a narrower model re-check', () => {
  const prevEnv = { LLM_PROVIDER: process.env.LLM_PROVIDER, XAI_API_KEY: process.env.XAI_API_KEY };
  after(() => {
    for (const [k, v] of Object.entries(prevEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    delete require.cache[require.resolve('./grok')];
  });

  it('skips the model\'s one-doctor lookup and keeps the full table + returns the final doctor list', async () => {
    process.env.LLM_PROVIDER = 'grok';
    process.env.XAI_API_KEY = 'test-xai-key';
    delete require.cache[require.resolve('./grok')];
    const { passThroughChat } = require('./grok');
    const original = global.fetch;
    let round = 0;
    global.fetch = async () => {
      round += 1;
      const message = round === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup_provider_network', arguments: JSON.stringify({ doctors: [{ doctorName: 'Neeta Jane Erinjeri' }], zip: '33186' }) } }] }
        : { role: 'assistant', content: 'Here is the table.' };
      return { ok: true, json: async () => ({ id: 'x', model: 'grok-4.6', choices: [{ message }] }) };
    };
    const calls = [];
    try {
      const out = await passThroughChat({
        system: 'You are Max.',
        messages: msgsFor(ASK),
        deadlineMs: 60000,
        processToolFn: async (name, input) => {
          calls.push(input.doctors.map((d) => d.doctorName));
          const n = input.doctors.length;
          return { text: `TABLE ${n}`, structured: { doctors: input.doctors.map((d) => ({ requestedName: d.doctorName })), rendered: `**Doctors × top plans**\n| Doctor | A |\n|---|---|\n| ROWS ${n} | x |` } };
        },
      });
      assert.equal(calls.length, 1, 'only the server re-run ran');
      assert.equal(calls[0].length, 10);
      const text = out.content[0].text;
      assert.match(text, /ROWS 10/);
      assert.doesNotMatch(text, /ROWS 1 /);
      assert.ok(out.doctorList && out.doctorList.final);
      assert.equal(out.doctorList.doctors.length, 10);
    } finally {
      global.fetch = original;
    }
  });
});
