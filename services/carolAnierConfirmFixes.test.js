// Carol Anier follow-ups after #272 (2026-11-25): Need-line / Run Max UX, middle-name auto-accept,
// confirm replies, Miami-Dade Doctors plan, and first+last doctor removal.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const C = require('./compareJobs');
const aetna = require('./aetnaPublicSearch');

const HTML = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');

const TAUBMAN = {
  requestedName: 'Michele Taubman',
  doctorName: 'Michele Lynn Taubman',
  npi: '1477727360',
  status: 'done',
  pending: [],
  failed: [],
  networks: [],
  inNetworkPlans: ['UHC MedicareMax FL-0028 (HMO) (H5420-001)'],
  outOfNetworkPlans: [],
  carriersIn: ['UnitedHealthcare'],
};
const OJEDA = {
  requestedName: 'German Ojeda Correal',
  doctorName: 'German Alberto Ojeda Correal',
  npi: '1710150339',
  status: 'done',
  pending: [],
  failed: [],
  networks: [],
  inNetworkPlans: ['UHC MedicareMax FL-0028 (HMO) (H5420-001)', 'Aetna Medicare Select Care HMO (H1609-093)'],
  outOfNetworkPlans: [],
  carriersIn: ['UnitedHealthcare', 'Aetna'],
};

describe('11/12 intake Need line, Run Max, and helper copy', () => {
  it('shows Need only for missing fields, keeps Run Max sticky, and drops then Continue', () => {
    assert.equal(HTML.includes('then Continue'), false);
    assert.match(HTML, /then Run Max/);
    assert.match(HTML, /data-testid="pdf-intake-runbar"/);
    assert.match(HTML, /position: "sticky"/);
    assert.match(HTML, /Need: " \+ needBits.join\(", "\) \+ "\."/);
    assert.doesNotMatch(HTML, /needBits\.length \? \("Need: " \+ needBits\.join\(", "\) \+ \(noteHints/);
    assert.match(HTML, /!cardPdf && <div style=\{\{ marginTop: 8, display: "flex"/);
    assert.match(HTML, /!\(stage === "paste" && cardPdf\)/);
    assert.equal(HTML.includes('Put it in the box'), false);
  });
});

describe('13 middle-name-only match is auto-accepted', () => {
  it('Michele Taubman vs Michele Lynn Taubman (NPI 1477727360) is not a confirm-match flag', () => {
    assert.equal(N.identityIssue(TAUBMAN), '');
    const sel = N.selectComparison([TAUBMAN], 'Carol Anier, ZIP 33196. Current plan: H5420-001.', {});
    const row = sel.doctors.find((d) => d.npi === '1477727360');
    assert.equal(row.identityPending, '');
    assert.deepEqual(row.inNetworkPlans, TAUBMAN.inNetworkPlans);
    assert.doesNotMatch(N.doctorLabel(TAUBMAN), /confirm match/i);
  });

  it('cleans "Dr. … Confirm Match" off the asked name and still auto-accepts', () => {
    const polluted = {
      ...TAUBMAN,
      requestedName: 'Dr. Michele Lynn Taubman Confirm Match',
    };
    assert.equal(N.cleanAskedDoctorName(polluted.requestedName), 'Michele Lynn Taubman');
    assert.equal(N.identityIssue(polluted), '');
    assert.equal(N.shortDoctor(polluted), 'Michele Lynn Taubman');
    assert.doesNotMatch(N.doctorLabel(polluted), /Confirm Match/);
    assert.doesNotMatch(N.doctorLabel(polluted), /asked:/);
  });
});

describe('14/17 confirm replies confirm pending matches and re-run', () => {
  const question = 'Confirm the doctor match (their In/Out stays ❔ not confirmed until you do): Dr. Michele Lynn Taubman Confirm Match → Michele Lynn Taubman (NPI 1477727360); Dr. German Alberto Ojeda Correal Confirm Match → German Alberto Ojeda Correal (NPI 1710150339). Right doctors? If not, tell me who (no NPI needed).';
  const workup = [
    'LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript).',
    'Client: Carol Anier',
    'ZIP/county: 33196 / Miami-Dade',
    'Current plan: H5420-001',
    'Plans:',
    '- UHC MedicareMax (H5420-001)',
    '- Humana Gold Plus (H1036-054C)',
    '- Aetna Medicare Select Care (H1609-093)',
    'Doctors (names only — pass exactly these names to lookup_provider_network): Michele Lynn Taubman; German Alberto Ojeda Correal; Yusleidi De La Caridad Gil',
    'Doctor NPIs: Michele Lynn Taubman NPI 1477727360; German Alberto Ojeda Correal NPI 1710150339; Yusleidi De La Caridad Gil NPI 1679101588',
  ].join('\n');

  it('a compound "Yes, Taubman and Ojeda Correal are the right doctors" confirms both, even with Confirm Match in the prompt', () => {
    const reply = 'Remove Yusleidi Gil. Yes, Taubman and Ojeda Correal are the right doctors. Add Doctors Health Plan DrMax-Dade H4140-022.';
    const msgs = [
      { role: 'user', content: workup },
      { role: 'assistant', content: question },
      { role: 'user', content: reply },
    ];
    const ask = N.comparisonAskText(msgs);
    assert.match(ask, /Doctor matches confirmed:/);
    assert.match(ask, /Taubman/i);
    assert.match(ask, /Ojeda Correal/i);
    const verdicts = N.statementsFor(question, reply);
    // unnumbered path uses matchVerdicts; numbered statementsFor should agree when given the question
    const fromStmt = N.statementsFor(question, 'Yes, Taubman and Ojeda Correal are the right doctors.');
    assert.ok(fromStmt.some((s) => /Doctor matches confirmed:/.test(s) && /Taubman/i.test(s) && /Ojeda/i.test(s)), fromStmt.join(' | '));

    const sel = N.selectComparison([
      { ...TAUBMAN, requestedName: 'Dr. Michele Lynn Taubman Confirm Match' },
      { ...OJEDA, requestedName: 'Dr. German Alberto Ojeda Correal Confirm Match' },
    ], ask, {});
    assert.equal(sel.doctors[0].identityPending, '');
    assert.equal(sel.doctors[1].identityPending, '');
    assert.ok(sel.doctors[0].inNetworkPlans.length, 'Taubman network results stay after confirm');
    assert.ok(sel.doctors[1].inNetworkPlans.length, 'Ojeda network results stay after confirm');
    for (const d of sel.doctors) {
      assert.doesNotMatch(N.doctorLabel(d), /Confirm Match/);
      assert.doesNotMatch(N.shortDoctor(d), /^Dr\./);
    }
  });

  it('a plain yes confirms every pending match in the question', () => {
    const msgs = [
      { role: 'user', content: workup },
      { role: 'assistant', content: question },
      { role: 'user', content: 'yes' },
    ];
    const ask = N.comparisonAskText(msgs);
    assert.match(ask, /Doctor matches confirmed:/);
    const sel = N.selectComparison([
      { ...TAUBMAN, requestedName: 'Dr. Michele Lynn Taubman Confirm Match' },
      { ...OJEDA, requestedName: 'Dr. German Alberto Ojeda Correal Confirm Match' },
    ], ask, {});
    assert.ok(sel.doctors.every((d) => d.identityPending === ''));
  });

  it('follow-up confirmation re-runs with NPIs and does not store Confirm Match in names', () => {
    const reply = 'Yes, Taubman and Ojeda Correal are the right doctors.';
    const fu = N.comparisonFollowUp([
      { role: 'user', content: workup },
      { role: 'assistant', content: `| Doctor | UHC · H5420-001 | Humana · H1036-054C | Aetna · H1609-093 |\n|---|---|---|---|\n| Yusleidi De La Caridad Gil | ❌ | ❌ | ❌ |\n${question}` },
      { role: 'user', content: reply },
    ]);
    assert.ok(fu, 'confirmation should trigger a follow-up re-run');
    assert.match(String(fu.reason || ''), /doctor match confirmed|doctor corrections/i);
    assert.equal(fu.npis && (fu.npis['Michele Lynn Taubman'] || fu.npis[Object.keys(fu.npis).find((k) => /Taubman/i.test(k))]), '1477727360');
    assert.ok(!fu.doctors.some((d) => /Confirm Match|\bDr\./i.test(d)), fu.doctors.join(' | '));
  });

  it('titled name parser stops before Confirm Match', () => {
    const names = C.titledDoctorNames('Confirm the doctor match: Dr. Michele Lynn Taubman Confirm Match → Michele Lynn Taubman (NPI 1477727360)');
    assert.deepEqual(names, ['Michele Lynn Taubman']);
  });
});

describe('15 Miami-Dade top plans include Doctors Health Plan', () => {
  it('shops DrMax-Dade H4140-022 among Miami-Dade alternatives, current plan first', () => {
    const others = ['Ana Perez', 'Luis Gomez', 'Maria Lopez'].map((name, i) => ({
      requestedName: name,
      doctorName: name,
      npi: String(1000000000 + i),
      status: 'done',
      pending: [],
      failed: [],
      networks: [],
      inNetworkPlans: [
        'UHC MedicareMax FL-0028 (HMO) (H5420-001)',
        'Humana Gold Plus (H1036-054C)',
        'Aetna Medicare Select Care HMO (H1609-093)',
      ],
      outOfNetworkPlans: [],
      carriersIn: ['UnitedHealthcare', 'Humana', 'Aetna'],
    }));
    const ask = 'Carol Anier, ZIP 33196 Miami-Dade. Current plan: UHC MedicareMax FL-0028 (H5420-001).\nHer current plan: H5420-001.\nWants alternatives to the named plan(s).';
    const sel = N.selectComparison(others, ask, {
      answered: true,
      pinPlanIds: ['H5420-001'],
    });
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.equal(ids[0], 'H5420-001', ids.join(','));
    assert.ok(ids.includes('H4140-022'), `Doctors DrMax-Dade missing from ${ids.join(', ')}`);
  });
});

describe('16 Remove first+last, ignoring middle names; not-found lists every table plan', () => {
  it('Remove Yusleidi Gil matches Yusleidi De La Caridad Gil', () => {
    const clauses = LW.doctorRemovalClauses('Remove Yusleidi Gil. Yes, Taubman and Ojeda Correal are the right doctors.');
    assert.ok(clauses.length, 'expected a removal clause');
    assert.equal(LW.removedByClauses('Yusleidi De La Caridad Gil', clauses), true);
    assert.equal(LW.removedByClauses('Yusleidi De La Caridad Gil · Internal Medicine · NPI 1679101588', clauses), true);
    assert.equal(LW.removedByClauses('Michele Lynn Taubman', clauses), false);
  });

  it('does not treat that removal as a missing plan, and a true miss lists every table plan', () => {
    const plans = [
      { planId: 'H5420-001', name: 'UHC MedicareMax' },
      { planId: 'H1036-054C', name: 'Humana Gold Plus' },
      { planId: 'H1609-093', name: 'Aetna Medicare Select Care' },
      { planId: 'H4140-022', name: 'Doctors DrMax-Dade' },
    ];
    const skip = ['Yusleidi De La Caridad Gil', 'Michele Lynn Taubman'];
    const rm = LW.planRemovals('Remove Yusleidi Gil.', plans, ['H5420-001'], { skip });
    assert.deepEqual(rm.remove, []);
    assert.deepEqual(rm.unmatched, []);
    const miss = LW.planRemovals('Remove Zephyr Plan.', plans, ['H5420-001'], { skip });
    const line = LW.planRemovalLines(miss, plans).join(' ');
    assert.match(line, /Couldn't find "Zephyr Plan" in the table \(H5420-001, H1036-054C, H1609-093, H4140-022\)/);
  });

  it('lastTablePlanIds reads every H-number in a doctor table header, including a mid-dot 4th plan', () => {
    const header = 'Doctor\tUHC MedicareMax MA FL-0028 HMO · H5420-001\tHumana Gold Plus · H1036-054C\tAetna Medicare Select Care HMO · H1609-093\tDoctors DrMax-Dade · H4140-022';
    const ids = LW.lastTablePlanIds([{ role: 'assistant', content: header }]);
    assert.deepEqual(ids, ['H5420-001', 'H1036-054C', 'H1609-093', 'H4140-022']);
  });

  it('still keeps typo\'d Neeta Erinjerri removable without dropping Neeta Jane Erinjeri', () => {
    const c = LW.doctorRemovalClauses('remove both Neeta Erinjerri Surgeon rows');
    assert.equal(LW.removedByClauses('Neeta Erinjerri - Surgeon at Baptist', c), true);
    assert.equal(LW.removedByClauses('Neeta Jane Erinjeri', c), false);
  });
});

describe('Aetna H1609-093 plan-id labels (Hooks / not confirmed)', () => {
  it('normalizes an unhyphenated Aetna plan id so H1609-093 can match', () => {
    assert.equal(
      aetna.formatPlanLabel({ plan_name: 'Aetna Medicare Select Care (HMO)', plan_id: 'H1609093' }),
      'Aetna Medicare Select Care (HMO) (H1609-093)'
    );
    assert.equal(
      aetna.formatPlanLabel({ plan_name: 'Aetna Medicare Select (HMO)', plan_id: 'H1609-018-000' }),
      'Aetna Medicare Select (HMO) (H1609-018)'
    );
  });
});

const UHC = 'UHC MedicareMax FL-0028 (H5420-001)';
const AETNA = 'Aetna Medicare Select Care (H1609-093)';
const HSUN = 'HealthSun HealthAdvantage (H5431-001)';
const DOCS = 'Doctors DrMax-Dade (H4140-022)';
const COL_IDS = ['H5420-001', 'H1609-093', 'H5431-001', 'H4140-022'];

function carolDoc(requested, official, npi, ins, outs) {
  return {
    requestedName: requested,
    doctorName: official,
    npi,
    requestedNpi: npi,
    status: 'done',
    pending: [],
    failed: [],
    networks: [],
    inNetworkPlans: ins,
    outOfNetworkPlans: outs,
    carriersIn: [],
  };
}

// Fixture In/Out after parenthetical specialties are stripped (item 20) and unlisted Aetna
// grid plans are marked Out (item 19). These are the first-run cells that follow-ups must keep.
function carolInitialDoctors() {
  return [
    carolDoc('Yusleidi De La Caridad Gil (Internal Medicine)', 'Yusleidi De La Caridad Gil', '1679101588',
      [UHC, AETNA, HSUN, DOCS], []),
    carolDoc('Michele Taubman (Vascular surgeon)', 'Michele Lynn Taubman', '1477727360',
      [UHC], [HSUN, DOCS]),
    carolDoc('Jorge C Busse (Nephrology)', 'Jorge C Busse', '1922091248',
      [UHC, AETNA, HSUN], [DOCS]),
    carolDoc('German Alberto Ojeda Correal (Physical Medicine & Rehabilitation)', 'German Alberto Ojeda Correal', '1710150339',
      [UHC, AETNA, HSUN, DOCS], []),
    carolDoc('Rebekka Hooks (Neuro-oncologist)', 'Rebekka Emilia Hooks', '1033614565',
      [UHC], [AETNA, HSUN, DOCS]),
    carolDoc('Ian Christopher Bostock Rosenzweig (Thoracic Surgery)', 'Ian Christopher Bostock Rosenzweig', '1598104457',
      [AETNA, HSUN, DOCS], [UHC]),
    carolDoc('Heberto Ramon Valdes (Endocrinology)', 'Heberto Ramon Valdes', '1356731525',
      [UHC, AETNA, HSUN], [DOCS]),
    carolDoc('Kevin Michael Almerico (Pulmonary)', 'Kevin Michael Almerico', '1619339769',
      [UHC, AETNA, HSUN], [DOCS]),
  ];
}

const CAROL_INTAKE = [
  'Client: Carol Anier',
  'ZIP 33196 Miami-Dade.',
  'Currently on UHC MedicareMax FL-0028 H5420-001.',
  'No Medicaid. No MSP. No C-SNP.',
  'Doctors (must-haves): Yusleidi De La Caridad Gil (Internal Medicine), Michele Taubman (Vascular surgeon), Jorge C Busse (Nephrology), German Alberto Ojeda Correal (Physical Medicine & Rehabilitation), Rebekka Hooks (Neuro-oncologist), Ian Christopher Bostock Rosenzweig (Thoracic Surgery), Heberto Ramon Valdes (Endocrinology), Kevin Michael Almerico (Pulmonary).',
  'Meds: Ezetimibe 10 mg tab, Gabapentin 400 mg cap, Propranolol HCL 80 mg tab, Topiramate 25 mg cap.',
].join('\n');

function rowByLast(parsed, last) {
  const l = String(last).toLowerCase();
  return (parsed.rows || []).find((r) => {
    const n = `${r.displayName || ''} ${r.name || ''}`.toLowerCase();
    return n.split(/[^a-z]+/).includes(l);
  });
}

function cellOf(parsed, last, planId) {
  const row = rowByLast(parsed, last);
  return row ? row.cells[planId] : undefined;
}

function assertKept(parsed, last, expected) {
  const row = rowByLast(parsed, last);
  assert.ok(row, `missing row for ${last}`);
  for (const [id, status] of Object.entries(expected)) {
    assert.equal(row.cells[id], status, `${last} ${id} expected ${status}, got ${row.cells[id]}`);
  }
}

const PRESERVE_LASTS = [
  ['Gil', { 'H5420-001': 'in', 'H1609-093': 'in', 'H5431-001': 'in', 'H4140-022': 'in' }],
  ['Taubman', { 'H5420-001': 'in', 'H1609-093': 'not_confirmed', 'H5431-001': 'out', 'H4140-022': 'out' }],
  ['Busse', { 'H5420-001': 'in', 'H1609-093': 'in', 'H5431-001': 'in', 'H4140-022': 'out' }],
  ['Ojeda', { 'H5420-001': 'in', 'H1609-093': 'in', 'H5431-001': 'in', 'H4140-022': 'in' }],
  // Hooks Aetna is Out (not listed) after the item 19 fill, not ❔.
  ['Hooks', { 'H5420-001': 'in', 'H1609-093': 'out', 'H5431-001': 'out', 'H4140-022': 'out' }],
  ['Bostock', { 'H5420-001': 'out', 'H1609-093': 'in', 'H5431-001': 'in', 'H4140-022': 'in' }],
  ['Valdes', { 'H5420-001': 'in', 'H1609-093': 'in', 'H5431-001': 'in', 'H4140-022': 'out' }],
  ['Almerico', { 'H5420-001': 'in', 'H1609-093': 'in', 'H5431-001': 'in', 'H4140-022': 'out' }],
];

describe('20 parenthetical specialty is stripped before name compare', () => {
  it('strips (Vascular surgeon) and auto-accepts Michele Taubman as Michele Lynn Taubman', () => {
    assert.equal(N.cleanAskedDoctorName('Michele Taubman (Vascular surgeon)'), 'Michele Taubman');
    assert.equal(N.cleanAskedDoctorName('Rebekka Hooks (Neuro-oncologist)'), 'Rebekka Hooks');
    assert.equal(N.cleanAskedDoctorName('Ian Christopher Bostock Rosenzweig (Thoracic Surgery)'), 'Ian Christopher Bostock Rosenzweig');
    assert.equal(N.cleanAskedDoctorName('Mary (Ann) Smith'), 'Mary (Ann) Smith');
    const taubman = carolDoc('Michele Taubman (Vascular surgeon)', 'Michele Lynn Taubman', '1477727360', [UHC], []);
    assert.equal(N.identityIssue(taubman), '');
    assert.doesNotMatch(N.doctorLabel(taubman), /confirm match/i);
    assert.doesNotMatch(N.doctorLabel(taubman), /asked:/);
  });

  it('still flags Carlos Santa Cruz vs Carlos A Cruz as a mismatch', () => {
    const d = {
      requestedName: 'Carlos Santa Cruz',
      doctorName: 'Carlos A Cruz',
      npi: '1234567890',
      status: 'done',
      inNetworkPlans: [UHC],
      outOfNetworkPlans: [],
    };
    assert.equal(N.identityIssue(d), 'mismatch');
  });
});

describe('18 Carol sequence: initial, remove Gil, confirm — no result lost', () => {
  it('replays the full sequence and keeps every doctor cell and every plan column', () => {
    const initialDocs = carolInitialDoctors();
    const initialMsgs = [{ role: 'user', content: CAROL_INTAKE }];
    const initialAsk = N.comparisonAskText(initialMsgs);
    const initialSel = N.selectComparison(initialDocs, initialAsk, { answered: true });
    const initialIds = initialSel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.equal(initialIds[0], 'H5420-001', `current plan should be first, got ${initialIds.join(',')}`);
    for (const id of COL_IDS) {
      assert.ok(initialIds.includes(id), `initial columns missing ${id}: ${initialIds.join(',')}`);
    }
    // Taubman is not confirmed on Aetna in this first-run fixture (directory miss before a confirm re-check).
    const initialGrid = N.gridTable(initialSel.doctors, initialSel.columns);
    const initialParsed = LW.parseDoctorTable(`${initialSel.header}\n${initialGrid}`);
    for (const [last, cells] of PRESERVE_LASTS) assertKept(initialParsed, last, cells);
    assert.equal(N.identityIssue(initialDocs.find((d) => d.npi === '1477727360')), '');

    const afterInitial = [
      ...initialMsgs,
      { role: 'assistant', content: `${initialSel.header}\n\n${initialGrid}` },
    ];

    // Turn 2: Remove Yusleidi Gil — lock columns, do not re-check anyone, drop only Gil.
    const removeMsgs = [...afterInitial, { role: 'user', content: 'Remove Yusleidi Gil' }];
    const removeAsk = N.comparisonAskText(removeMsgs);
    assert.match(removeAsk, /Named plan set:/);
    assert.match(removeAsk, /H5431-001/);
    assert.match(removeAsk, /H1609-093/);
    assert.match(removeAsk, /H4140-022/);
    assert.match(removeAsk, /H5420-001/);
    assert.equal(N.isDoctorOnlyColumnFollowUp('Remove Yusleidi Gil', removeMsgs), true);
    assert.equal(N.isDoctorOnlyColumnFollowUp('Yes, run other plans', removeMsgs), false);

    const remaining = initialDocs.filter((d) => !/Gil/i.test(d.requestedName));
    // Simulate a wiped re-lookup for everyone except we pass the prior table and recheck nobody.
    const wiped = remaining.map((d) => ({
      ...d,
      status: 'timeout',
      inNetworkPlans: [],
      outOfNetworkPlans: [],
    }));
    const prior1 = LW.lastDoctorTableResults(removeMsgs);
    assert.equal(prior1.planIds.includes('H5431-001'), true);
    const recheck1 = N.doctorsToRecheckFromAsk(wiped, removeAsk);
    assert.deepEqual(recheck1, []);
    const removeSel = N.selectComparison(wiped, removeAsk, {
      answered: true,
      messages: removeMsgs,
      priorTable: prior1,
      recheckDoctors: recheck1,
    });
    const removeIds = removeSel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.deepEqual(removeIds, initialIds, `remove follow-up dropped a column: ${removeIds.join(',')}`);
    assert.ok(!removeSel.doctors.some((d) => /Gil/i.test(`${d.requestedName} ${d.doctorName}`)));
    const removeGrid = N.gridTable(removeSel.doctors, removeSel.columns);
    const removeParsed = LW.parseDoctorTable(`${removeSel.header}\n${removeGrid}`);
    assert.equal(rowByLast(removeParsed, 'Gil'), undefined);
    for (const [last, cells] of PRESERVE_LASTS) {
      if (last === 'Gil') continue;
      assertKept(removeParsed, last, cells);
    }
    // Reuse helper: nobody should be re-queried on a remove-only follow-up.
    for (const d of remaining) {
      assert.equal(N.shouldReusePriorDoctor(d, prior1, recheck1), true, `should reuse ${d.requestedName}`);
    }

    // Turn 3: confirm Taubman and Ojeda — re-check only those two; everyone else stays put.
    const afterRemove = [
      ...removeMsgs,
      { role: 'assistant', content: `${removeSel.header}\n\n${removeGrid}` },
    ];
    const confirmMsgs = [...afterRemove, { role: 'user', content: 'Yes, Taubman and Ojeda Correal are the right doctors' }];
    const confirmAsk = N.comparisonAskText(confirmMsgs);
    assert.match(confirmAsk, /Named plan set:/);
    assert.match(confirmAsk, /H5431-001/);
    assert.equal(N.isDoctorOnlyColumnFollowUp('Yes, Taubman and Ojeda Correal are the right doctors', confirmMsgs), true);

    const prior2 = LW.lastDoctorTableResults(confirmMsgs);
    const recheck2 = N.doctorsToRecheckFromAsk(remaining, confirmAsk);
    const recheckLasts = recheck2.map((n) => n.toLowerCase());
    assert.ok(recheck2.some((n) => /taubman/i.test(n)), `recheck missing Taubman: ${recheck2.join(' | ')}`);
    assert.ok(recheck2.some((n) => /ojeda/i.test(n)), `recheck missing Ojeda: ${recheck2.join(' | ')}`);
    assert.equal(recheck2.length, 2, `should re-check only the two confirmed doctors, got ${recheck2.join(' | ')}`);

    // Fresh lookup for the two confirmed doctors: Taubman's Aetna miss is now a checked Out.
    const taubmanFresh = {
      ...remaining.find((d) => /Taubman/i.test(d.requestedName)),
      inNetworkPlans: [UHC],
      outOfNetworkPlans: [AETNA, HSUN, DOCS],
      status: 'done',
    };
    const ojedaFresh = {
      ...remaining.find((d) => /Ojeda/i.test(d.requestedName)),
      inNetworkPlans: [UHC, AETNA, HSUN, DOCS],
      outOfNetworkPlans: [],
      status: 'done',
    };
    const confirmDocs = remaining.map((d) => {
      if (/Taubman/i.test(d.requestedName)) return taubmanFresh;
      if (/Ojeda/i.test(d.requestedName)) return ojedaFresh;
      return { ...d, status: 'timeout', inNetworkPlans: [], outOfNetworkPlans: [] };
    });
    for (const d of confirmDocs) {
      const reuse = N.shouldReusePriorDoctor(d, prior2, recheck2);
      if (/Taubman|Ojeda/i.test(d.requestedName)) assert.equal(reuse, false);
      else assert.equal(reuse, true, `should reuse ${d.requestedName}`);
    }

    const confirmSel = N.selectComparison(confirmDocs, confirmAsk, {
      answered: true,
      messages: confirmMsgs,
      priorTable: prior2,
      recheckDoctors: recheck2,
    });
    const confirmIds = confirmSel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.deepEqual(confirmIds, initialIds, `confirm follow-up dropped a column: ${confirmIds.join(',')}`);
    const confirmGrid = N.gridTable(confirmSel.doctors, confirmSel.columns);
    const confirmParsed = LW.parseDoctorTable(`${confirmSel.header}\n${confirmGrid}`);
    assert.equal(rowByLast(confirmParsed, 'Gil'), undefined);
    for (const [last, cells] of PRESERVE_LASTS) {
      if (last === 'Gil') continue;
      if (last === 'Taubman') {
        assertKept(confirmParsed, last, { ...cells, 'H1609-093': 'out' });
        continue;
      }
      assertKept(confirmParsed, last, cells);
    }
  });
});
