// Doctor/Drug Comparison Table Rules — the reply that motivated them said
// "most of these doctors in network" at 3/7, ranked an Aetna QMB-only plan as
// 1/7 with 6 doctors unchecked, asked for meds already listed, surfaced C-SNP and
// QMB plans before eligibility, and showed two same-network UHC plans with no
// "Why these plans" line.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const n = require('./doctorPlanNarrow');

const A = 'UHC MedicareMax MA FL-0028 (HMO) (H5420-001)';
const B = 'UHC MedicareMax Complete Care FL-30 (HMO C-SNP) (H5420-014)';
const C = 'Aetna Medicare QMB Only Select HMO (H1609-043)';

const doc = (req, name, npi, ins, outs = [], extra = {}) => ({
  requestedName: req, doctorName: name, npi, status: 'done', carriersIn: [], inNetworkPlans: ins, outOfNetworkPlans: outs, pending: [], ...extra,
});

// The client from the bug report (Miami-Dade, 7 doctors, 3 meds priced on one plan only).
const DOCTORS = [
  doc('Ian Del Conde', 'IAN DEL CONDE M.D.', '1000000001', [], [A, B]),
  doc('Juan D Cedeno', 'JUAN D CEDENO', '1000000002', [A, B]),
  doc('Mirel Sanchez', 'MIREL SANCHEZ', '1000000003', [], [A, B]),
  doc('Carlos Sosa', 'CARLOS SOSA MD', '1000000004', [A, B]),
  doc('Yavagal', 'DILEEP R YAVAGAL', '1000000005', [A, B, C]),
  doc('Krajewski', 'KAROL KRAJEWSKI', '1000000006', [], [A, B]),
  { requestedName: 'John Mortyko', status: 'not_found', networks: [] },
];
const DRUGS = [['Eliquis', 3, '$25'], ['Atorvastatin Calcium', 1, '$0'], ['Chlorthalidone', 2, '$0']]
  .map(([drugName, tier, costShare]) => ({ drugName, byPlanId: { 'H5420-001': { verified: true, tier, costShare } } }));
const ASK = 'Client ZIP 33172. Doctors: Ian Del Conde, Juan D Cedeno, Mirel Sanchez, Carlos Sosa, Yavagal, Krajewski, John Mortyko. Meds: Eliquis, atorvastatin, chlorthalidone. Suggest 2-3 plans';

afterEach(() => R.setGridForTests(null));

describe('rules text is wired into every system prompt', () => {
  it('SYSTEM_PROMPT carries all 11 hard rules', () => {
    const { SYSTEM_PROMPT } = require('./claude');
    assert.match(SYSTEM_PROMPT, /DOCTOR\/DRUG COMPARISON TABLE RULES \(HARD RULES/);
    for (const k of ['ELIGIBILITY FILTER FIRST', 'SELECTION POOL', 'RANKING ORDER', 'NETWORK DIVERSITY', 'WHY THESE PLANS', 'COUNT FORMAT', 'HEADER ACCURACY', 'RUN ALL KNOWN DATA BEFORE ASKING', 'UNIFORM UNKNOWN MARKER', 'PROVIDER IDENTITY', 'SNP FLAGS']) {
      assert.ok(SYSTEM_PROMPT.includes(k), `${k} missing`);
    }
  });
});

describe('the bug-report client (fallback reply)', () => {
  const text = n.fallbackAnswer(DOCTORS, ASK, { drugs: DRUGS });

  it('rule 7: no "most of these doctors in network" at 3 of 7', () => {
    assert.doesNotMatch(text, /most of these doctors in network/);
    assert.match(text, /^\*\*Doctors × top plans\*\* \(best confirmed match shown first — a count, not a recommendation\)$/m);
  });

  it('rule 5: "Why these plans" line above the table, naming county, order and exclusions', () => {
    const why = text.indexOf('Why these plans:');
    assert.ok(why > -1 && why < text.indexOf('| Doctor |'));
    assert.match(text, /Why these plans: \d+ eligible plans checked in Miami-Dade\. Ranked by doctors in → fewest out → drug cost → premium\. Excluded: .*C-SNPs — qualifying condition not confirmed.*D-SNPs — Medicaid not confirmed.*QMB-only plans — QMB not confirmed/);
  });

  it('rule 1: no C-SNP / QMB-only / D-SNP in the top 3 before eligibility', () => {
    const header = text.split('\n').find((l) => l.startsWith('| Doctor |'));
    assert.doesNotMatch(header, /H5420-014|H1609-043|C-SNP|QMB/);
    assert.match(header, /H5420-001/);
  });

  it('rule 6: counts are "X in · Y out · Z unchecked", never X/7', () => {
    // Yavagal / Krajewski are unconfirmed last-name matches → not counted until she confirms.
    assert.match(text, /\| \*\*Doctors\*\* \| \*\*2 in · 2 out · 3 unchecked\*\* \|/);
    assert.doesNotMatch(text, /\b\d\/7\b/);
  });

  it('rule 8: meds already listed are never asked for again', () => {
    assert.doesNotMatch(text, /Any meds/);
    assert.match(text, /\| Eliquis \| T3 \$25 \|/);
  });

  it('rule 9: unknown cells carry words, never a bare ❔; legends use identical wording', () => {
    assert.doesNotMatch(text, /❔ \|/);
    assert.match(text, /\| John Mortyko \| ❔ not confirmed \|/);
    const legends = text.split('\n').filter((l) => l.includes('❔ unchecked = never checked'));
    assert.equal(legends.length, 2, 'doctor + drug legend');
    for (const l of legends) assert.ok(l.includes(R.UNKNOWN_LEGEND));
  });

  it('rule 10: doctors as matched (full name + NPI); last-name-only asks flagged and confirmed', () => {
    assert.match(text, /\| Dileep R Yavagal \(asked: Yavagal\) · NPI 1000000005 ⚠️ confirm match \| ❔ not confirmed \|/);
    assert.match(text, /Ian Del Conde · NPI 1000000001/);
    assert.doesNotMatch(text, /M\.D\./);
    assert.match(text, /Confirm the doctor match \(their In\/Out stays ❔ not confirmed until you do\): Yavagal → Dileep R Yavagal \(NPI 1000000005\); Krajewski → Karol Krajewski/);
  });

  it('rule 11: Eliquis flags possible C-SNP eligibility, never assumed', () => {
    assert.match(text, /⚠️ Eliquis \(an anticoagulant\/antiplatelet\) → possible cardiovascular condition\. Possible C-SNP eligibility — agent must confirm diagnosis\./);
  });

  it('rule 1: eligibility questions come first', () => {
    const qs = text.split('**To narrow to 2–3 plans:**')[1];
    assert.match(qs, /^\n1\. Does the client have Medicaid or a Medicare Savings Program\?/);
    assert.match(qs, /\n2\. Does the client have a C-SNP qualifying chronic condition/);
  });
});

describe('once eligibility is confirmed', () => {
  it('rule 4: the same-network UHC C-SNP twin drops to "Same network as above" with its differences', () => {
    const text = n.fallbackAnswer(DOCTORS, `${ASK}. Full Medicaid. Has AFib, C-SNP eligible.`, { drugs: DRUGS });
    const header = text.split('\n').find((l) => l.startsWith('| Doctor |'));
    assert.match(header, /H5420-001/);
    assert.doesNotMatch(header, /H5420-014/);
    assert.match(text, /\*\*Same network as above\*\*\n- UHC MedicareMax Complete Care FL-30 .*H5420-014 — same doctor results as .*H5420-001; differs: .*C-SNP vs HMO/);
    assert.doesNotMatch(text, /Possible C-SNP eligibility/, 'no flag once the condition is confirmed');
  });

  it('a stated QMB level admits the QMB-only plan; a full-dual client is not QMB-only', () => {
    const qmb = n.selectComparison(DOCTORS, `${ASK}. She is QMB only.`);
    assert.ok(!qmb.excluded.some((x) => /QMB-only/.test(x.reason)));
    const full = n.selectComparison(DOCTORS, `${ASK}. Full Medicaid.`);
    assert.ok(full.excluded.some((x) => x.reason === 'QMB-only plans — client is not QMB'));
  });
});

describe('ranking, could-not-verify and the county pool (fixture grid)', () => {
  const G = (planId, carrier, planName, extra = {}) => ({ planId, carrier, planName, county: 'Miami-Dade', type: 'HMO', premium: '$0', moop: '$3,900', ...extra });
  const docs3 = (rows) => rows.map(([req, ins, outs]) => doc(req, req.toUpperCase(), '', ins, outs));
  const P1 = 'Humana Gold Plus (H1036-054C)';
  const P2 = 'Devoted Core (H1290-001)';
  const P3 = 'UHC MedicareMax FL-0028 (H5420-001)';
  const P4 = 'Aetna Medicare Select (H1609-018)';
  const fixture = [
    G('H1036-054C', 'Humana', 'Humana Gold Plus', { premium: '$7.30' }),
    G('H1290-001', 'Devoted', 'Devoted Core', { premium: '$0' }),
    G('H5420-001', 'UHC', 'UHC MedicareMax FL-0028'),
    G('H1609-018', 'Aetna', 'Aetna Medicare Select'),
    G('H1609-043', 'Aetna', 'Aetna Medicare QMB Only Select', { type: 'D-SNP', mspLevels: 'QMB only' }),
    G('H1045-005', 'UHC', 'UHC Preferred MA FL-0002', { county: 'Broward' }),
  ];

  it('rule 3: in ↓, out ↑, then drug cost, then premium; >half unchecked goes to "Could not verify"', () => {
    R.setGridForTests(fixture);
    const doctors = docs3([
      ['Ana Ruiz', [P1, P2, P3], []],
      ['Luis Gomez', [P1, P2], [P3]],
      ['Rosa Diaz', [P1, P2, P4], [P3]],
    ]);
    const drugs = [{ drugName: 'Metformin', byPlanId: { 'H1036-054C': { verified: true, tier: 1, costShare: '$5' }, 'H1290-001': { verified: true, tier: 1, costShare: '$0' } } }];
    const sel = n.selectComparison(doctors, 'ZIP 33172. No Medicaid. Meds: metformin', { drugs });
    // Humana and Devoted tie at 3 in / 0 out → Devoted wins on drug cost ($0 < $5).
    assert.deepEqual(sel.columns.map((c) => c.planId), ['H1290-001', 'H1036-054C', 'H5420-001']);
    assert.equal(sel.poolSize, 4, 'Broward plan and the QMB-only plan are not in the pool');
    assert.ok(sel.couldNotVerify.some((c) => c.planId === 'H1609-018'), 'Aetna: 1 in, 2 unchecked → could not verify');
    assert.match(sel.whyLine, /Excluded: QMB-only plans — no Medicaid\/MSP \(1\)/);
  });

  it('premium breaks a tie when drug cost is unknown — never invented', () => {
    R.setGridForTests(fixture);
    const doctors = docs3([['Ana Ruiz', [P1, P2], []], ['Luis Gomez', [P1, P2], []]]);
    const sel = n.selectComparison(doctors, 'ZIP 33172. No Medicaid. Meds: metformin');
    assert.deepEqual(sel.columns.slice(0, 2).map((c) => c.planId), ['H1290-001', 'H1036-054C']);
  });

  it('rule 7: "most of these doctors" only when a plan has more than half confirmed In', () => {
    R.setGridForTests(fixture);
    const sel = n.selectComparison(docs3([['Ana Ruiz', [P1], []], ['Luis Gomez', [P1], []]]), 'ZIP 33172. No Medicaid.');
    assert.match(sel.header, /most of these doctors in network/);
  });

  it('rule 2: plans a lookup returned that are off the county grid are named as excluded', () => {
    R.setGridForTests(fixture);
    const sel = n.selectComparison(docs3([['Ana Ruiz', ['UHC Preferred MA FL-0002 (H1045-005)', P3], []]]), 'ZIP 33172. No Medicaid.');
    assert.ok(!sel.columns.some((c) => c.planId === 'H1045-005'));
    assert.match(sel.whyLine, /plans a lookup returned that are not on the THEI Miami-Dade grid \(1\)/);
  });
});

describe('eligibility comes only from the agent', () => {
  it('a named QMB-only / Dual plan never reads as the client\'s own eligibility', () => {
    assert.equal(R.eligibilityFromAsk('Compare Aetna Medicare QMB Only Select H1609-043 and UHC Dual Complete H1889-002').medicaid, 'unknown');
  });
  it('parses full / MSP level / none / C-SNP statements', () => {
    assert.deepEqual(R.eligibilityFromAsk('Yes, full Medicaid'), { medicaid: 'full', levels: ['FBDE'], csnp: 'unknown' });
    assert.deepEqual(R.eligibilityFromAsk('MSP only — SLMB').levels, ['SLMB']);
    assert.equal(R.eligibilityFromAsk('No Medicaid. HMO ok').medicaid, 'none');
    assert.equal(R.eligibilityFromAsk('diagnosed with CHF').csnp, 'confirmed');
    assert.equal(R.eligibilityFromAsk('Meds: Eliquis').csnp, 'unknown', 'a med is never a diagnosis');
  });
  it('MSP without a level asks for the level instead of guessing', () => {
    const sel = n.selectComparison(DOCTORS, `${ASK}. MSP only.`);
    assert.match(sel.questions[0], /Which MSP level does the client have — QMB, SLMB, or QI\?/);
  });
});

describe('model tool result (chat path)', () => {
  it('hands the model the rule-built table and the exact formulary call for unpriced plans', () => {
    const { text } = n.batchSummaryForModel(DOCTORS, `${ASK}. Full Medicaid. Has AFib, C-SNP eligible.`, { drugs: [] });
    assert.match(text, /Why these plans: \d+ eligible plans checked in Miami-Dade/);
    assert.match(text, /MEDS ALREADY GIVEN — before answering, call lookup_formulary once per drug \(Eliquis, atorvastatin, chlorthalidone\) with planIds \[H5420-001[^\]]*\]/);
    assert.doesNotMatch(text, /Any meds to check/);
  });
});

describe('agent follow-ups (2026-10-06 replay: carriers by name, numbered answers, wrong matches)', () => {
  const A = 'UHC MedicareMax MA FL-0028 (HMO) (H5420-001)';
  const U = 'UHC Preferred MA FL-0001 (HMO) (H1045-001)';
  const docs = [
    doc('Ian Del Conde', 'CESAR A CONDE', '1932159043', [A, U], [], { carriersIn: ['Doctors HealthCare Plans'] }),
    doc('Juan D Cedeno', 'JUAN DIEGO CEDENO', '1043665177', [A], [U], { carriersIn: ['Doctors HealthCare Plans', 'Devoted Health'] }),
    doc('Carlos Sosa', 'AMANDA C SOSA RBT', '1073390662', [], [A, U]),
    doc('Yavagal', 'DILEEP RAJHAVENDRA YAVAGAL', '1689661217', [A], [U], { carriersIn: ['Devoted Health'] }),
  ];
  const firstAsk = 'Client ZIP 33172. Doctors: Ian Del Conde, Juan D Cedeno, Carlos Sosa, Yavagal. Meds: Eliquis. Suggest 2-3 2027 plans.';
  const maxQs = '**To narrow to 2–3 plans:**\n1. Does the client have Medicaid or a Medicare Savings Program? — Yes, full Medicaid / Yes, MSP only (QMB, SLMB, QI) / No.\n2. Does the client have a C-SNP qualifying chronic condition, confirmed by diagnosis? — Yes (which one) / No.\n3. Confirm the doctor match before I rely on it: Yavagal → Dileep Rajhavendra Yavagal (NPI 1689661217). Right doctors?';
  const reply = '1. no, 2. eliquis cardiovascular disorder. 3. yes those are are correct. so lets instea of these plans show Me doctors health, solis, devoted';
  const msgs = [{ role: 'user', content: firstAsk }, { role: 'assistant', content: maxQs }, { role: 'user', content: reply }];

  it('reads her numbered replies and the carrier ask', () => {
    const t = n.comparisonAskText(msgs);
    assert.match(t, /^No Medicaid\.$/m);
    assert.match(t, /^C-SNP qualifying condition confirmed: eliquis cardiovascular disorder\.$/m);
    assert.match(t, /^Doctor matches confirmed: Yavagal\.$/m);
    assert.match(t, /^Carriers requested: Doctors HealthCare, Solis, Devoted\.$/m);
    assert.deepEqual(R.carriersRequested('client wants doctos health and solis and cevoted'), ['Doctors HealthCare', 'Solis', 'Devoted']);
    assert.deepEqual(R.carriersRequested('Doctors: Juan Cedeno, Carlos Sosa. Suggest plans'), [], 'a doctor list is not a carrier ask');
  });

  it('columns are the carriers she asked for — one best eligible plan each', () => {
    const text = n.fallbackAnswer(docs, n.comparisonAskText(msgs), { answered: n.narrowingAnswered(msgs) });
    const header = text.split('\n').find((l) => l.startsWith('| Doctor |'));
    assert.match(header, /\| Doctors [^|]*H4140-\d{3}[^|]*\| Solis [^|]*H0982-\d{3}[^|]*\| Devoted [^|]*H1290-\d{3}[^|]*\|$/);
    assert.doesNotMatch(header, /UHC|Humana/);
    assert.match(text, /^Why these plans: you asked for Doctors HealthCare, Solis, Devoted — best eligible plan per carrier/m);
    assert.match(text, /D-SNPs — no Medicaid\/MSP/);
    assert.doesNotMatch(text, /Medicaid or a Medicare Savings Program\?|C-SNP qualifying chronic condition, confirmed/, 'answered — not asked again');
    assert.match(text, /Solis has no live directory check/);
  });

  it('a different first name is flagged, not counted, and asked about; a confirmed match counts', () => {
    const sel = n.selectComparison(docs, n.comparisonAskText(msgs), { answered: true });
    const label = (req) => n.doctorLabel(sel.doctors.find((d) => d.requestedName === req));
    assert.match(label('Ian Del Conde'), /^Cesar A Conde \(asked: Ian Del Conde\) · NPI 1932159043 ⚠️ different name — confirm match$/);
    assert.match(label('Carlos Sosa'), /Amanda C Sosa Rbt \(asked: Carlos Sosa\).*⚠️ different name/);
    assert.doesNotMatch(label('Yavagal'), /⚠️/, 'she confirmed Yavagal');
    assert.match(sel.questions[0], /Confirm the doctor match .*Ian Del Conde → Cesar A Conde \(NPI 1932159043\); Carlos Sosa → Amanda C Sosa Rbt.*If not, send the NPI\./);
    const table = n.gridTable(sel.doctors, sel.columns);
    assert.match(table, /\| Cesar A Conde [^\n]*\| ❔ not confirmed \| ❔ not confirmed \| ❔ not confirmed \|/);
    assert.match(table, /\| Dileep Rajhavendra Yavagal [^|]*\| [^|]*\| [^|]*\| ✅ In \|/, 'Devoted single network counts once confirmed');
  });

  it('newest ask wins: plan IDs after a carrier ask switch back to the named plans', () => {
    const t = n.comparisonAskText([...msgs, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'compare H5420-001 and H1045-001 instead' }]);
    assert.doesNotMatch(t, /Carriers requested/);
  });
});

describe('partial doctor-match answers', () => {
  const q = '**To narrow to 2–3 plans:**\n1. Does the client have Medicaid or a Medicare Savings Program? — Yes / No.\n2. Confirm the doctor match (their In/Out stays ❔ not confirmed until you do): Ian Del Conde → Cesar A Conde (NPI 1932159043); Yavagal → Dileep Rajhavendra Yavagal (NPI 1689661217). Right doctors? If not, send the NPI.';
  const ask = (a) => n.comparisonAskText([{ role: 'user', content: 'Client ZIP 33172. Doctors: Ian Del Conde, Yavagal.' }, { role: 'assistant', content: q }, { role: 'user', content: a }]);

  it('"Yavagal correct, Del Conde wrong" confirms one and rejects one — a blanket yes is not assumed', () => {
    const t = ask('1. no 2. Yavagal correct, Del Conde wrong');
    assert.match(t, /^Doctor matches confirmed: Yavagal\.$/m);
    assert.match(t, /^Doctor matches wrong: Ian Del Conde\.$/m);
  });

  it('a rejected match is never counted and Max asks for the NPI', () => {
    const A = 'UHC MedicareMax MA FL-0028 (HMO) (H5420-001)';
    const docs = [doc('Ian Del Conde', 'CESAR A CONDE', '1932159043', [A], []), doc('Yavagal', 'DILEEP RAJHAVENDRA YAVAGAL', '1689661217', [A], [])];
    const sel = n.selectComparison(docs, ask('1. no 2. Yavagal correct, Del Conde wrong'), { answered: true });
    const conde = sel.doctors.find((d) => d.requestedName === 'Ian Del Conde');
    assert.equal(conde.identityPending, 'wrong');
    assert.match(n.doctorLabel(conde), /⚠️ wrong doctor — send the NPI$/);
    assert.ok(sel.questions.some((x) => /^Send the NPI for Ian Del Conde — the match I found was the wrong doctor/.test(x)));
    assert.doesNotMatch(n.doctorLabel(sel.doctors[1]), /⚠️/);
  });
});

describe('Doctors HealthCare shared network (Yahoska, 2026-10-06)', () => {
  it('a Doctors directory hit is ✅ In for DrMax-Dade and DrSelect-SFL, still ✅ In* for Doctors C-SNP', () => {
    const d = doc('Juan D Cedeno', 'JUAN DIEGO CEDENO', '1043665177', [], [], { carriersIn: ['Doctors HealthCare Plans'] });
    const cols = n.namedPlanColumns([
      { planId: 'H4140-022', name: 'Doctors DrMax-Dade' },
      { planId: 'H4140-023', name: 'Doctors DrSelect-SFL' },
      { planId: 'H4140-024', name: 'Doctors DrExtraCare' },
    ], [], [d]);
    assert.deepEqual(cols.map((c) => [c.in.length, c.inCarrier.length]), [[1, 0], [1, 0], [0, 1]]);
  });
});
