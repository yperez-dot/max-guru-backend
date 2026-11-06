// Meg workup, 2026-11-06: typo "Richardo Machado" never bound to Ricardo Leoncio Machado NPI 1598736969.
// Every reply repeated the stale row, proposed unrelated Rafael/Alfredo Machado, and asked to re-run again.
// Sequence: load saved workup → "Dr. Ricardo Machado" → full name + NPI → "Yes, re run Dr. Machado".
// Screenshot of RICARDO MACHADO MD (cardiology, NPI 1598736969, Miami / Hialeah) is identity only — never In.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const R = require('./comparisonRules');
const W = require('../artifacts/client-workups.js');
const { mergeDoctors, withRecoveredDoctors } = require('./workups');
const { conversationAskText } = require('./planYear');

const NPI = '1598736969';
const AYALA = 'Ruben Javier Ayala';
const ARAN = 'Fernando Santiago Aran';
const TYPO = 'Richardo Machado';
const SHORT = 'Ricardo Machado';
const FULL = 'Ricardo Leoncio Machado';
const PLANS = ['H1045-001', 'H4140-022', 'H0982-022'];
const MEDS = ['amlodipine', 'ibandronate', 'rosuvastatin'];
const ORIGINAL = `Meg, 33176 Miami-Dade, doctors Ruben Ayala; Fernando Santiago Aran; ${TYPO}. Meds ${MEDS.join(', ')}. Plans H1045-001 UHC Preferred MA FL-0001 HMO; H4140-022 Doctors DrMax-Dade; H0982-022 Solis Healthy Living.`;

const WORKUP_UNRESOLVED = {
  clientName: 'Meg', zip: '33176', county: 'Miami-Dade', currentPlanIds: ['H1045-001'],
  plans: [
    { carrier: 'UHC', planName: 'Preferred MA FL-0001 HMO', planId: 'H1045-001' },
    { carrier: 'Doctors', planName: 'Doctors DrMax-Dade', planId: 'H4140-022' },
    { carrier: 'Solis', planName: 'Solis Healthy Living', planId: 'H0982-022' },
  ],
  doctors: [
    { name: AYALA, npi: '1326012303', byPlanId: { 'H1045-001': 'in' } },
    { name: ARAN, npi: '1235516907', byPlanId: { 'H1045-001': 'in' } },
    { name: TYPO, byPlanId: {} },
  ],
  medications: MEDS.map((name) => ({ name, byPlanId: {} })),
  originalQuery: ORIGINAL,
};

const CLARIFY = `No exact match for:\n• "${TYPO}" — closest: Rafael Machado, MD (Family Medicine, Miami, NPI 1111111111); Alfredo Machado, MD (Internal Medicine, Hialeah, NPI 2222222222)\nReply "${TYPO} = Dr. Full Name".`;

const msgsFor = (history, workup = WORKUP_UNRESOLVED) => W.messagesForApi(history, workup);
const plansFor = (msgs) => N.namedPlansFromAsk(N.comparisonAskText(msgs, conversationAskText(msgs)), N.askConstraints(N.comparisonAskText(msgs, conversationAskText(msgs)))).map((p) => p.planId);
const machado = (fu) => (fu.doctors || []).filter((d) => /machado/i.test(d));

describe('Meg Machado identity bind (replace, never duplicate)', () => {
  it('titled name + NPI sentence is an identity; surname-only "Dr. Machado" is not', () => {
    assert.deepEqual(N.identityFromUserMessage('Dr. Ricardo Machado'), { name: SHORT, npi: '' });
    const full = N.identityFromUserMessage(`Dr. ${FULL} is a cardiologist with the NPI number ${NPI}`);
    assert.equal(full.name, FULL);
    assert.equal(full.npi, NPI);
    assert.equal(N.identityFromUserMessage('Yes, re run Dr. Machado'), null);
  });

  it('maps the correction onto the unresolved typo row — one Machado, other doctors kept', () => {
    const people = [{ name: AYALA, npi: '1326012303' }, { name: ARAN, npi: '1235516907' }, { name: TYPO, npi: '' }];
    assert.equal(N.bindDoctorIdentity(people, { name: SHORT, npi: '' }, { [AYALA]: '1326012303', [ARAN]: '1235516907' }), true);
    assert.equal(people.filter((p) => /machado/i.test(p.name)).length, 1);
    assert.equal(people[2].name, SHORT);
    assert.equal(N.bindDoctorIdentity(people, { name: FULL, npi: NPI }, {}), true);
    assert.equal(people[2].name, FULL);
    assert.equal(people[2].npi, NPI);
    assert.equal(people.length, 3);
    assert.equal(people[0].name, AYALA);
    assert.equal(people[1].name, ARAN);
  });

  it('"Dr. Ricardo Machado" re-runs all three saved doctors; no Alfredo/Rafael row', () => {
    const msgs = msgsFor([
      { role: 'assistant', content: CLARIFY },
      { role: 'user', content: 'Dr. Ricardo Machado' },
    ]);
    const fu = N.comparisonFollowUp(msgs);
    assert.ok(fu, 'server must re-run the comparison');
    assert.equal(fu.doctors.length, 3);
    assert.deepEqual(machado(fu), [SHORT]);
    assert.ok(fu.doctors.includes(AYALA) && fu.doctors.includes(ARAN));
    assert.ok(!fu.doctors.some((d) => /rafael|alfredo/i.test(d)));
    assert.ok(!fu.doctors.includes(TYPO));
    assert.deepEqual(plansFor(msgs), PLANS);
    assert.deepEqual(R.medsFromAsk(N.comparisonAskText(msgs, conversationAskText(msgs))).map((m) => m.toLowerCase()), MEDS);
  });

  it('full name + NPI binds onto that row; NPI is passed on the follow-up', () => {
    const msgs = msgsFor([
      { role: 'assistant', content: CLARIFY },
      { role: 'user', content: 'Dr. Ricardo Machado' },
      { role: 'assistant', content: CLARIFY },
      { role: 'user', content: `Dr. ${FULL} is a cardiologist with the NPI number ${NPI}` },
    ]);
    const fu = N.comparisonFollowUp(msgs);
    assert.deepEqual(machado(fu), [FULL]);
    assert.equal(fu.npis[FULL], NPI);
    assert.equal(fu.doctors.length, 3);
    assert.ok(!Object.values(fu.npis || {}).includes('1111111111'));
    assert.ok(!Object.values(fu.npis || {}).includes('2222222222'));
  });

  it('full conversational sequence then "Yes, re run Dr. Machado" keeps the resolved row, not the typo', () => {
    const msgs = msgsFor([
      { role: 'assistant', content: CLARIFY },
      { role: 'user', content: 'Dr. Ricardo Machado' },
      { role: 'assistant', content: CLARIFY },
      { role: 'user', content: `Dr. ${FULL} is a cardiologist with the NPI number ${NPI}` },
      { role: 'assistant', content: `Did you mean ${FULL}? Want me to re-run Dr. Machado?` },
      { role: 'user', content: 'Yes, re run Dr. Machado' },
    ]);
    const fu = N.comparisonFollowUp(msgs);
    assert.ok(fu);
    assert.deepEqual(machado(fu), [FULL]);
    assert.equal(fu.npis[FULL], NPI);
    assert.equal(fu.doctors.length, 3, 'Ayala and Aran stay; Machado is not duplicated');
    assert.ok(!fu.doctors.includes(TYPO));
    assert.ok(!fu.doctors.some((d) => /rafael|alfredo/i.test(d)));
  });

  it('saved structured facts only / reload then yes-rerun uses the NPI, never Richardo', () => {
    const resolved = {
      ...WORKUP_UNRESOLVED,
      doctors: [
        { name: AYALA, npi: '1326012303', byPlanId: { 'H1045-001': 'in' } },
        { name: ARAN, npi: '1235516907', byPlanId: { 'H1045-001': 'in' } },
        { name: FULL, npi: NPI, byPlanId: {} },
      ],
    };
    const compact = W.compactWorkupContext(resolved);
    assert.match(compact, /structured facts only/i);
    assert.match(compact, new RegExp(`${FULL} NPI ${NPI}`));
    assert.doesNotMatch(compact, /Richardo/);
    const facts = LW.workupFacts([{ role: 'user', content: compact }]);
    assert.equal(facts.npis[FULL], NPI);
    assert.ok(facts.doctors.includes(FULL));
    assert.ok(!facts.doctors.includes(TYPO));

    const msgs = W.messagesForApi([{ role: 'user', content: 'Yes, re run Dr. Machado' }], resolved);
    const fu = N.comparisonFollowUp(msgs);
    assert.ok(fu);
    assert.deepEqual(machado(fu), [FULL]);
    assert.equal(fu.npis[FULL], NPI);
    assert.equal(fu.doctors.length, 3);
    assert.ok(!fu.doctors.includes(TYPO));
    assert.deepEqual(plansFor(msgs), PLANS);
  });

  it('originalQuery recovery / mergeDoctors cannot restore Richardo over a resolved NPI', () => {
    const saved = [{ name: FULL, npi: NPI, byPlanId: { 'H1045-001': 'in' } }, { name: AYALA, npi: '1326012303', byPlanId: {} }];
    const merged = mergeDoctors(saved, [{ name: TYPO, byPlanId: {} }]);
    assert.equal(merged.filter((d) => /machado/i.test(d.name)).length, 1);
    assert.equal(merged[0].name, FULL);
    assert.equal(merged[0].npi, NPI);

    const incoming = mergeDoctors([{ name: TYPO, byPlanId: {} }], [{ name: FULL, npi: NPI, byPlanId: {} }]);
    assert.equal(incoming[0].name, FULL);
    assert.equal(incoming[0].npi, NPI);

    const recovered = withRecoveredDoctors({ originalQuery: ORIGINAL, doctors: resolvedDoctors() });
    assert.equal(recovered.doctors.filter((d) => /machado/i.test(d.name)).length, 1);
    assert.ok(!recovered.doctors.some((d) => /Richardo/i.test(d.name)));
    assert.ok(!(recovered.recoveredDoctors || []).some((n) => /Richardo|Machado/i.test(n)));
  });

  it('candidate picks from unrelated Machado suggestions are not taken; NPI wins', () => {
    assert.deepEqual(N.candidatePicks(CLARIFY, 'Dr. Ricardo Machado'), []);
    assert.deepEqual(N.candidatePicks(CLARIFY, `Dr. ${FULL} is a cardiologist with the NPI number ${NPI}`), []);
    const people = [{ name: TYPO, npi: '' }];
    N.bindDoctorIdentity(people, { name: FULL, npi: NPI }, {});
    assert.equal(people[0].npi, NPI);
    assert.equal(people[0].name, FULL);
  });
});

function resolvedDoctors() {
  return [
    { name: AYALA, npi: '1326012303', byPlanId: {} },
    { name: ARAN, npi: '1235516907', byPlanId: {} },
    { name: FULL, npi: NPI, byPlanId: {} },
  ];
}
