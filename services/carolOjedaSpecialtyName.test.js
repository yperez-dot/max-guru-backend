// Bug 21: "Physical Medicine & Rehabilitation" must not split German Alberto
// Ojeda Correal into a second doctor, and a remove must not re-check or change
// anyone's cells (Carol Anier, 2026-11-25).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const C = require('./compareJobs');
const LW = require('./loadedWorkup');
const N = require('./doctorPlanNarrow');
const PN = require('./providerNetwork');
const { cleanDoctorQuery } = require('../artifacts/doctor-name.js');

const UHC = 'H5420-001';
const HUMANA = 'H1036-054C';
const DOCS = 'H4140-022';
const AETNA = 'H1609-093';
const HSUN = 'H5431-001';
const OJEDA_NPI = '1710150339';
const OJEDA = 'German Alberto Ojeda Correal';
const UHC_L = 'UHC MedicareMax FL-0028 (H5420-001)';
const HUMANA_L = 'Humana Gold Plus (H1036-054C)';
const DOCS_L = 'Doctors DrMax-Dade (H4140-022)';
const AETNA_L = 'Aetna Medicare Select Care (H1609-093)';
const HSUN_L = 'HealthSun HealthAdvantage (H5431-001)';

const CAROL_INTAKE = [
  'Client: Carol Anier',
  'ZIP 33196 Miami-Dade.',
  'Currently on UHC MedicareMax FL-0028 H5420-001.',
  'No Medicaid. No MSP. No C-SNP.',
  'Doctors (must-haves): Yusleidi De La Caridad Gil (Internal Medicine), Michele Taubman (Vascular surgeon), Jorge C Busse (Nephrology), German Alberto Ojeda Correal (Physical Medicine & Rehabilitation), Rebekka Hooks (Neuro-oncologist), Ian Christopher Bostock Rosenzweig (Thoracic Surgery), Heberto Ramon Valdes (Endocrinology), Kevin Michael Almerico (Pulmonary).',
  'Meds: Ezetimibe 10 mg tab, Gabapentin 400 mg cap, Propranolol HCL 80 mg tab, Topiramate 25 mg cap.',
].join('\n');

const LIVE_LINE_INTAKE = [
  'Carol Anier, ZIP 33196',
  'Current plan: UHC MedicareMax FL-0028 (H5420-001)',
  'Doctors:',
  'Yusleidi De La Caridad Gil (Internal Medicine)',
  'Michele Taubman (Vascular surgeon)',
  'Jorge C Busse (Internal Medicine Nephrology)',
  'German Alberto Ojeda Correal (Physical Medicine & Rehabilitation)',
  'Rebekka Emilia Hooks (Neurology / neuro-oncologist)',
  'Ian Christopher Bostock Rosenzweig (Thoracic Surgery)',
  'Heberto Ramon Valdes (Internal Medicine Endocrinology)',
  'Kevin Michael Almerico (Internal Medicine Pulmonary Disease)',
  'Meds: Ezetimibe oral tablet 10 mg; Gabapentin oral capsule 400 mg',
  'No Medicaid or MSP. Not looking at C-SNP plans.',
].join('\n');

const LIVE_SPLIT_TABLE = [
  '| Doctor | UHC MedicareMax (H5420-001) | Humana Gold Plus (H1036-054C) | Doctors DrMax-Dade (H4140-022) |',
  '|---|---|---|---|',
  `| ${OJEDA} (Physical Medicine | ❔ not confirmed | ❔ not confirmed | ❔ not confirmed |`,
  '| Rehabilitation) ⚠️ confirm match | ❔ not confirmed | ❔ not confirmed | ❔ not confirmed |',
  '| Michele Lynn Taubman · NPI 1477727360 | ✅ In | ✅ In | ✅ In |',
].join('\n');

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

describe('21 splitList and parseCompareAsk keep specialties with &, commas, and slashes on one doctor', () => {
  it('does not split "Physical Medicine & Rehabilitation" off Ojeda', () => {
    const commaLine = C.parseCompareAsk(CAROL_INTAKE);
    const liveLines = C.parseCompareAsk(LIVE_LINE_INTAKE);
    for (const [label, f] of [['comma list', commaLine], ['live lines', liveLines]]) {
      const names = f.doctors.map((d) => d.name);
      assert.equal(f.doctors.length, 8, `${label} expected 8 doctors, got ${names.join(' | ')}`);
      assert.equal(names.some((n) => /^Rehabilitation\)?$/i.test(String(n).trim()) || n === 'Rehabilitation)'), false, `${label} leaked a Rehabilitation row: ${names.join(' | ')}`);
      const ojeda = f.doctors.find((d) => /Ojeda/i.test(d.name));
      assert.ok(ojeda, `${label} missing Ojeda`);
      assert.match(ojeda.name, /German Alberto Ojeda Correal/i);
      assert.doesNotMatch(ojeda.name, /^German Alberto Ojeda Correal \(Physical Medicine$/);
      assert.equal(LW.cleanAskedDoctorName(ojeda.name), OJEDA);
      assert.equal(cleanDoctorQuery(ojeda.name), OJEDA);
    }
  });

  it('still splits two real doctors joined by & or and, and meds joined by &', () => {
    assert.deepEqual(C.splitList('Dr. Ana Perez & Dr. Luis Gomez'), ['Dr. Ana Perez', 'Dr. Luis Gomez']);
    assert.deepEqual(C.splitList('acyclovir tablets & ointment'), ['acyclovir tablets', 'ointment']);
  });

  it('strips comma and slash specialties from the lookup name and leaves nicknames', () => {
    assert.equal(LW.cleanAskedDoctorName('Jorge C Busse (Internal Medicine, Nephrology)'), 'Jorge C Busse');
    assert.equal(LW.cleanAskedDoctorName('Jane Roe (Psychiatry/Neurology)'), 'Jane Roe');
    assert.equal(LW.cleanAskedDoctorName(`${OJEDA} (Physical Medicine & Rehabilitation)`), OJEDA);
    assert.equal(LW.cleanAskedDoctorName(`${OJEDA} (Physical Medicine`), OJEDA);
    assert.equal(LW.cleanAskedDoctorName(`${OJEDA} (asked: ${OJEDA}, Physical Medicine & Rehabilitation)`), OJEDA);
    assert.equal(LW.cleanAskedDoctorName('Mary (Ann) Smith'), 'Mary (Ann) Smith');
    assert.equal(cleanDoctorQuery(`${OJEDA} (Physical Medicine`), OJEDA);
    assert.equal(cleanDoctorQuery('Jane Roe (Psychiatry/Neurology)'), 'Jane Roe');
  });
});

describe('21 lookup uses the clean name plus NPI 1710150339', () => {
  it('normalizeDoctorList strips the specialty and keeps the NPI', () => {
    const [d] = PN.normalizeDoctorList({
      doctors: [{ doctorName: `${OJEDA} (Physical Medicine & Rehabilitation)`, npi: OJEDA_NPI }],
    });
    assert.equal(d.doctorName, OJEDA);
    assert.equal(d.npi, OJEDA_NPI);
  });

  it('savedNpiFor matches Ojeda after the specialty is stripped', () => {
    const saved = [{ name: OJEDA, npi: OJEDA_NPI }];
    assert.equal(PN.savedNpiFor(`${OJEDA} (Physical Medicine & Rehabilitation)`, saved), OJEDA_NPI);
    assert.equal(PN.savedNpiFor(`${OJEDA} (Physical Medicine`, saved), OJEDA_NPI);
  });

  it('doctorLabel has a clean name: no &, no leaked specialty, no asked:', () => {
    const d = carolDoc(`${OJEDA} (Physical Medicine & Rehabilitation)`, OJEDA, OJEDA_NPI, [UHC, DOCS], []);
    assert.equal(N.identityIssue(d), '');
    const label = N.doctorLabel(d);
    assert.equal(label, `${OJEDA} · NPI ${OJEDA_NPI}`);
    assert.doesNotMatch(label, /&/);
    assert.doesNotMatch(label, /asked:/);
    assert.doesNotMatch(label, /Physical Medicine/i);
    assert.doesNotMatch(label, /confirm match/i);
  });
});

describe('21 parseDoctorTable joins a wrap at "&" and a remove reuses those cells', () => {
  it('joins the live split Ojeda rows into one clean name and keeps ❔ cells', () => {
    const parsed = LW.parseDoctorTable(LIVE_SPLIT_TABLE);
    assert.equal(parsed.rows.length, 2);
    const ojeda = parsed.rows.find((r) => /Ojeda/i.test(`${r.displayName} ${r.name}`));
    assert.ok(ojeda);
    assert.equal(ojeda.displayName, OJEDA);
    assert.equal(ojeda.cells[UHC], 'not_confirmed');
    assert.equal(ojeda.cells[HUMANA], 'not_confirmed');
    assert.equal(ojeda.cells[DOCS], 'not_confirmed');
    assert.equal(parsed.rows.some((r) => /^Rehabilitation/i.test(r.displayName)), false);
  });

  it('Remove Yusleidi Gil does not re-check Ojeda and does not flip Doctors ❔ to Out', () => {
    const prior = LW.parseDoctorTable(LIVE_SPLIT_TABLE);
    const ojeda = carolDoc(`${OJEDA} (Physical Medicine & Rehabilitation)`, OJEDA, OJEDA_NPI, [UHC, HUMANA, DOCS], []);
    // A wiped re-lookup would invent In/Out; reuse must win and keep ❔.
    const wiped = { ...ojeda, status: 'timeout', inNetworkPlans: [], outOfNetworkPlans: [] };
    const recheck = [];
    assert.equal(N.shouldReusePriorDoctor(wiped, prior, recheck), true);
    const removeMsgs = [
      { role: 'user', content: LIVE_LINE_INTAKE },
      { role: 'assistant', content: `${LIVE_SPLIT_TABLE}\n| **Doctors** | **1 in · 0 not in network · 0 unchecked · 1 not confirmed** | **1 in · 0 not in network · 0 unchecked · 1 not confirmed** | **1 in · 0 not in network · 0 unchecked · 1 not confirmed** |` },
      { role: 'user', content: 'Remove Yusleidi Gil' },
    ];
    const ask = N.comparisonAskText(removeMsgs);
    assert.equal(N.isDoctorOnlyColumnFollowUp('Remove Yusleidi Gil', removeMsgs), true);
    assert.deepEqual(N.doctorsToRecheckFromAsk([wiped], ask), []);
    const sel = N.selectComparison([wiped], ask, {
      answered: true,
      messages: removeMsgs,
      priorTable: prior,
      recheckDoctors: [],
    });
    const grid = N.gridTable(sel.doctors, sel.columns);
    const parsed = LW.parseDoctorTable(`${sel.header}\n${grid}`);
    const row = parsed.rows.find((r) => /Ojeda/i.test(`${r.displayName} ${r.name}`));
    assert.ok(row, `missing Ojeda row in\n${grid}`);
    assert.equal(row.displayName, OJEDA);
    assert.equal(row.cells[DOCS], 'not_confirmed', `Doctors cell changed on remove: ${row.cells[DOCS]}`);
    assert.equal(row.cells[UHC], 'not_confirmed');
    assert.doesNotMatch(grid, /Rehabilitation\)/);
    assert.doesNotMatch(N.doctorLabel(sel.doctors[0]), /asked:/);
  });
});

describe('21 Carol three-turn replay against PR logic', () => {
  it('initial, remove Gil, confirm Taubman and Ojeda: one clean Ojeda row, cells hold on remove', () => {
    const initialDocs = [
      carolDoc('Yusleidi De La Caridad Gil (Internal Medicine)', 'Yusleidi De La Caridad Gil', '1679101588', [UHC_L, AETNA_L, HSUN_L, DOCS_L], []),
      carolDoc('Michele Taubman (Vascular surgeon)', 'Michele Lynn Taubman', '1477727360', [UHC_L], [HSUN_L, DOCS_L]),
      carolDoc('Jorge C Busse (Nephrology)', 'Jorge C Busse', '1922091248', [UHC_L, AETNA_L, HSUN_L], [DOCS_L]),
      carolDoc(`${OJEDA} (Physical Medicine & Rehabilitation)`, OJEDA, OJEDA_NPI, [UHC_L, AETNA_L, HSUN_L, DOCS_L], []),
      carolDoc('Rebekka Hooks (Neuro-oncologist)', 'Rebekka Emilia Hooks', '1033614565', [UHC_L], [HSUN_L, DOCS_L]),
      carolDoc('Ian Christopher Bostock Rosenzweig (Thoracic Surgery)', 'Ian Christopher Bostock Rosenzweig', '1598104457', [AETNA_L, HSUN_L, DOCS_L], [UHC_L]),
      carolDoc('Heberto Ramon Valdes (Endocrinology)', 'Heberto Ramon Valdes', '1356731525', [UHC_L, AETNA_L, HSUN_L], [DOCS_L]),
      carolDoc('Kevin Michael Almerico (Pulmonary)', 'Kevin Michael Almerico', '1619339769', [UHC_L, AETNA_L, HSUN_L], [DOCS_L]),
    ];
    const parsedAsk = C.parseCompareAsk(CAROL_INTAKE);
    assert.equal(parsedAsk.doctors.filter((d) => /Ojeda|Rehabilitation/i.test(d.name)).length, 1);

    const initialMsgs = [{ role: 'user', content: CAROL_INTAKE }];
    const initialAsk = N.comparisonAskText(initialMsgs);
    const initialSel = N.selectComparison(initialDocs, initialAsk, { answered: true });
    const initialGrid = N.gridTable(initialSel.doctors, initialSel.columns);
    const initialParsed = LW.parseDoctorTable(`${initialSel.header}\n${initialGrid}`);
    const ojeda0 = initialParsed.rows.filter((r) => /Ojeda|Rehabilitation/i.test(`${r.displayName} ${r.name}`));
    assert.equal(ojeda0.length, 1, `expected one Ojeda row, got ${ojeda0.map((r) => r.displayName).join(' | ')}`);
    assert.equal(ojeda0[0].displayName, OJEDA);
    assert.equal(ojeda0[0].cells[UHC], 'in');
    assert.equal(ojeda0[0].cells[DOCS], 'in');
    assert.doesNotMatch(N.doctorLabel(initialDocs[3]), /&|asked:|Physical Medicine|confirm match/i);
    assert.doesNotMatch(N.doctorLabel(initialDocs[3]), /confirm match/i);

    const afterInitial = [...initialMsgs, { role: 'assistant', content: `${initialSel.header}\n\n${initialGrid}` }];
    const removeMsgs = [...afterInitial, { role: 'user', content: 'Remove Yusleidi Gil' }];
    const remaining = initialDocs.filter((d) => !/Gil/i.test(d.requestedName));
    const wiped = remaining.map((d) => ({ ...d, status: 'timeout', inNetworkPlans: [], outOfNetworkPlans: [] }));
    const prior1 = LW.lastDoctorTableResults(removeMsgs);
    const recheck1 = N.doctorsToRecheckFromAsk(wiped, N.comparisonAskText(removeMsgs));
    assert.deepEqual(recheck1, []);
    for (const d of remaining) {
      assert.equal(N.shouldReusePriorDoctor(d, prior1, recheck1), true, `should reuse ${d.requestedName}`);
    }
    const removeSel = N.selectComparison(wiped, N.comparisonAskText(removeMsgs), {
      answered: true,
      messages: removeMsgs,
      priorTable: prior1,
      recheckDoctors: recheck1,
    });
    const removeGrid = N.gridTable(removeSel.doctors, removeSel.columns);
    const removeParsed = LW.parseDoctorTable(`${removeSel.header}\n${removeGrid}`);
    assert.equal(removeParsed.rows.some((r) => /Gil/i.test(r.displayName)), false);
    const ojeda1 = removeParsed.rows.find((r) => /Ojeda/i.test(r.displayName));
    assert.equal(ojeda1.displayName, OJEDA);
    assert.equal(ojeda1.cells[UHC], 'in');
    assert.equal(ojeda1.cells[DOCS], 'in');
    assert.doesNotMatch(N.doctorLabel(removeSel.doctors.find((d) => /Ojeda/i.test(d.requestedName || d.doctorName))), /&|asked:|Physical Medicine/i);

    const afterRemove = [...removeMsgs, { role: 'assistant', content: `${removeSel.header}\n\n${removeGrid}` }];
    const confirmMsgs = [...afterRemove, { role: 'user', content: 'Yes, Taubman and Ojeda Correal are the right doctors' }];
    const confirmAsk = N.comparisonAskText(confirmMsgs);
    const prior2 = LW.lastDoctorTableResults(confirmMsgs);
    const recheck2 = N.doctorsToRecheckFromAsk(remaining, confirmAsk);
    assert.equal(recheck2.length, 2);
    assert.ok(recheck2.some((n) => /taubman/i.test(n)));
    assert.ok(recheck2.some((n) => /ojeda/i.test(n)));
    const confirmDocs = remaining.map((d) => (
      /Taubman|Ojeda/i.test(d.requestedName)
        ? { ...d, status: 'done' }
        : { ...d, status: 'timeout', inNetworkPlans: [], outOfNetworkPlans: [] }
    ));
    const confirmSel = N.selectComparison(confirmDocs, confirmAsk, {
      answered: true,
      messages: confirmMsgs,
      priorTable: prior2,
      recheckDoctors: recheck2,
    });
    const confirmGrid = N.gridTable(confirmSel.doctors, confirmSel.columns);
    const confirmParsed = LW.parseDoctorTable(`${confirmSel.header}\n${confirmGrid}`);
    const ojeda2 = confirmParsed.rows.find((r) => /Ojeda/i.test(r.displayName));
    assert.equal(ojeda2.displayName, OJEDA);
    assert.equal(ojeda2.cells[UHC], 'in');
    assert.equal(ojeda2.cells[DOCS], 'in');
    assert.doesNotMatch(N.doctorLabel(confirmSel.doctors.find((d) => /Ojeda/i.test(d.requestedName || d.doctorName))), /&|asked:|Physical Medicine|confirm match/i);
  });
});

describe('21 frontend intake replaces & in the specialty tag', () => {
  it('buildPdfIntakeRequest uses "and" so a stale parser cannot split on &', () => {
    const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /replace\(\/\\s\*&\\s\*\/g,\s*" and "/);
  });
});
