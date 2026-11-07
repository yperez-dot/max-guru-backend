// Current-plan mention is a baseline, not an exclusive candidate filter (2026-11-07).
// Reproduction: ZIP 33190 Miami-Dade, 2027, currently on UHC MedicareMax FL-0028 H5420-001,
// doctors + meds. Directory / formulary cells in these tests are fixtures — never live lookups.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const C = require('./compareJobs');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const CW = require('../artifacts/client-workups.js');
const exp = require('../artifacts/comparison-export.js');

const PASTE = [
  'ZIP 33190 Miami-Dade.',
  'Currently on UHC MedicareMax FL-0028 H5420-001.',
  'Doctors: Cristiane Carvalho, George Sanchez, Yanelis Martin, Alix Salvant, Letty Villa, Enrique Angel Serrano, Nada Alyousha.',
  'Meds: calcium acetate, clonazepam 2mg, gabapentin cap 300mg, prolia, rosuvastatin 10mg, sertraline 100mg, xcopi tab 200.',
].join(' ');

const DOCTOR_NAMES = [
  'Cristiane Carvalho', 'George Sanchez', 'Yanelis Martin', 'Alix Salvant',
  'Letty Villa', 'Enrique Angel Serrano', 'Nada Alyousha',
];

function doc(name, ins = [], extra = {}) {
  return {
    requestedName: name,
    doctorName: extra.doctorName || name,
    npi: extra.npi || '1',
    status: extra.status || 'done',
    pending: [],
    failed: [],
    networks: extra.networks || [],
    inNetworkPlans: ins,
    outOfNetworkPlans: extra.out || [],
    carriersIn: extra.carriersIn || [],
    ...extra,
  };
}

function resolvedDocs() {
  const inBoth = ['UHC MedicareMax FL-0028 (HMO) (H5420-001)', 'Doctors DrMax-Dade (H4140-022)'];
  return DOCTOR_NAMES.map((name, i) => {
    if (name === 'George Sanchez') {
      return doc(name, [], { status: 'not_found', doctorName: '', npi: undefined });
    }
    return doc(name, inBoth, { npi: String(1000000000 + i) });
  });
}

function columnsOf(msgs, docs = resolvedDocs()) {
  const ask = N.comparisonAskText(msgs);
  const sel = N.selectComparison(docs, ask, {
    answered: true,
    meds: ['calcium acetate', 'clonazepam 2mg', 'gabapentin cap 300mg', 'prolia', 'rosuvastatin 10mg', 'sertraline 100mg', 'xcopi tab 200'],
    drugs: [
      { drugName: 'rosuvastatin 10mg', byPlanId: { 'H5420-001': { verified: true, tier: 1, costShare: '$0' } } },
      { drugName: 'xcopi tab 200', error: 'name_unconfirmed', lookups: [], byPlanId: {} },
    ],
  });
  return { ask, sel, ids: sel.columns.map((c) => String(c.planId).slice(0, 9)) };
}

describe('parser: current plan is baseline', () => {
  it('ZIP 33190 is Miami-Dade, year defaults to 2027', () => {
    const f = C.parseCompareAsk(PASTE);
    assert.equal(f.zip, '33190');
    assert.equal(R.countyFromAsk(PASTE), 'Miami-Dade');
    assert.equal(f.year, 2027);
    assert.ok(f.currentPlans.includes('H5420-001'), String(f.currentPlans));
    assert.equal(f.wantsAlternatives, true);
    assert.equal(f.exclusivePlanSet, false);
    assert.equal(R.isSelectedPlanCheck(PASTE), false);
    assert.equal(R.impliesCompareToCurrentPlan(PASTE), true);
  });

  it('explicit selected-only stays locked', () => {
    assert.equal(C.parseCompareAsk(`${PASTE} Only H5420-001`).wantsAlternatives, false);
    assert.equal(C.parseCompareAsk(`${PASTE} Is Dr Carvalho in network on H5420-001`).wantsAlternatives, false);
    assert.equal(C.parseCompareAsk(`${PASTE} Compare H5420-001, H4140-022`).wantsAlternatives, false);
    assert.equal(R.isExclusivePlanSet('I need to look only at H1019-006, H4140-023, and H0982-022. No other plans'), true);
  });
});

describe('candidate selection: original paste, repeat, loaded workup', () => {
  it('original request ranks 2027 Miami-Dade alternatives beside H5420-001', () => {
    const { ask, sel, ids } = columnsOf([{ role: 'user', content: PASTE }]);
    assert.match(ask, /Her current plan: H5420-001/);
    assert.equal(ids[0], 'H5420-001', ids.join(','));
    assert.ok(ids.length >= 2, `expected alternatives, got ${ids.join(',')}`);
    assert.ok(!sel.columns.some((c) => c.snp === 'dsnp' || c.snp === 'csnp'), ids.join(','));
    const dade = new Set(R.gridPlansForCounty('Miami-Dade').map((p) => String(p.planId || p.id).slice(0, 9)));
    for (const id of ids) assert.ok(dade.has(id), `${id} is not a 2027 Miami-Dade grid plan`);
    assert.ok(!ids.includes('H1045-005'), 'Broward-only UHC Preferred is not a Dade alternative');
    assert.ok(!ids.includes('H5420-003'), 'Broward MedicareMax FL-0029 is not a Dade alternative');
  });

  it('repeating the same brief still shops alternatives', () => {
    const msgs = [
      { role: 'user', content: PASTE },
      { role: 'assistant', content: '| Doctor | UHC MedicareMax · H5420-001 |\n|---|---|\n| Cristiane Carvalho | ✅ In |' },
      { role: 'user', content: PASTE },
    ];
    const { ids } = columnsOf(msgs);
    assert.equal(ids[0], 'H5420-001');
    assert.ok(ids.length >= 2, ids.join(','));
  });

  it('loaded structured workup with Plans: only current still shops alternatives', () => {
    const ctx = CW.compactWorkupContext({
      clientName: 'Test Client',
      zip: '33190',
      county: 'Miami-Dade',
      currentPlanIds: ['H5420-001'],
      plans: [{ planId: 'H5420-001', planName: 'UHC MedicareMax FL-0028', carrier: 'UnitedHealthcare' }],
      doctors: DOCTOR_NAMES.map((name) => ({ name, byPlanId: {} })),
      medications: ['calcium acetate', 'rosuvastatin 10mg', 'xcopi tab 200'].map((name) => ({ name, byPlanId: {} })),
    });
    assert.match(ctx, /LOADED CLIENT WORKUP/);
    assert.match(ctx, /Current plan: H5420-001/);
    const sets = LW.resolveWorkupSets([{ role: 'user', content: ctx }]);
    assert.ok(sets.currentPlan.includes('H5420-001'));
    const { ids, sel } = columnsOf([{ role: 'user', content: ctx }]);
    assert.equal(ids[0], 'H5420-001', ids.join(','));
    assert.ok(ids.length >= 2, `loaded workup locked to current only: ${ids.join(',')}`);
    assert.ok(!sel.columns.some((c) => c.snp === 'dsnp' || c.snp === 'csnp'));
  });

  it('Humana + HealthSun follow-up shops those carriers; that path does not make the first paste exclusive', () => {
    const first = columnsOf([{ role: 'user', content: PASTE }]);
    assert.ok(first.ids.length >= 2, `first paste still locked to current: ${first.ids.join(',')}`);
    assert.equal(first.ids[0], 'H5420-001');
    const msgs = [
      { role: 'user', content: PASTE },
      { role: 'assistant', content: '| Doctor | UHC MedicareMax · H5420-001 |\n|---|---|\n| Cristiane Carvalho | ✅ In |' },
      { role: 'user', content: 'show Humana, HealthSun' },
    ];
    const { ask, sel, ids } = columnsOf(msgs);
    assert.match(ask, /Carriers requested:.*Humana/i);
    assert.match(ask, /HealthSun/i);
    assert.match(sel.header, /Doctors × Humana, HealthSun/);
    assert.equal(ids[0], 'H5420-001');
    assert.ok(ids.some((id) => id.slice(0, 9) === 'H1036-054'), ids.join(','));
    assert.ok(ids.some((id) => id.slice(0, 9) === 'H5431-001'), ids.join(','));
    assert.ok(first.ids.length >= 2, 'carrier follow-up is a different path from the first-paste baseline');
  });

  it('exclusive look-only-at A, B, C stays current + exactly those plans', () => {
    const only = 'I need to look only at H1019-006, H4140-023, and H0982-022. No other plans';
    const msgs = [
      { role: 'user', content: PASTE },
      { role: 'assistant', content: '| Doctor | UHC · H5420-001 | CarePlus · H1019-006 |\n|---|---|---|\n| Cristiane Carvalho | ✅ In | ✅ In |' },
      { role: 'user', content: only },
    ];
    const { ask, ids } = columnsOf(msgs);
    assert.match(ask, /Exclusive named plan set/);
    assert.deepEqual(ids, ['H5420-001', 'H1019-006', 'H4140-023', 'H0982-022']);
  });

  it('Broward ZIP does not pick Miami-Dade-only alternatives', () => {
    const broward = 'ZIP 33322 Broward. Currently on UHC Preferred MA FL-0002 H1045-005. Doctors: Dr. Brad Glick. Meds: metformin.';
    const { ids } = columnsOf(
      [{ role: 'user', content: broward }],
      [doc('Brad Glick', ['UHC Preferred MA FL-0002 (HMO) (H1045-005)'])]
    );
    assert.equal(ids[0], 'H1045-005');
    assert.ok(ids.length >= 2, ids.join(','));
    const bwd = new Set(R.gridPlansForCounty('Broward').map((p) => String(p.planId || p.id).slice(0, 9)));
    for (const id of ids) assert.ok(bwd.has(id), `${id} is not a 2027 Broward grid plan`);
    assert.ok(!ids.includes('H5420-001'));
    assert.ok(!ids.includes('H4140-022'));
  });
});

describe('unresolved doctor or drug does not collapse alternative columns', () => {
  it('George Sanchez unresolved still leaves other-plan columns for known facts', () => {
    const { sel, ids } = columnsOf([{ role: 'user', content: PASTE }]);
    assert.ok(ids.length >= 2, ids.join(','));
    assert.ok(sel.doctors.some((d) => /George Sanchez/i.test(d.requestedName || '') && (d.status === 'not_found' || d.identityPending)));
    const table = N.gridTable(sel.doctors, sel.columns);
    assert.match(table, /H5420-001/);
    assert.ok(sel.columns.length >= 2);
    assert.match(table, /George Sanchez/);
  });

  it('xcopi name-unconfirmed does not drop alternative plan columns or the med row', () => {
    const { ask, sel, ids } = columnsOf([{ role: 'user', content: PASTE }]);
    assert.ok(ids.length >= 2, ids.join(','));
    const text = N.renderedAnswer(sel.doctors, ask, {
      drugs: [
        { drugName: 'rosuvastatin 10mg', byPlanId: { 'H5420-001': { verified: true, tier: 1, costShare: '$0' } } },
        { drugName: 'xcopi tab 200', error: 'name_unconfirmed', lookups: [], byPlanId: {} },
      ],
    });
    assert.match(text, /\*\*Doctors × top plans\*\*|\*\*Doctors × plans\*\*/);
    assert.ok((text.match(/H5420-001/g) || []).length >= 1);
    assert.match(text, /xcopi/i);
  });
});

describe('export follows the ranked table, not a current-plan-only lock', () => {
  it('a current-only paste is not an exclusive working set', () => {
    assert.deepEqual(exp.workingPlanIdsFromUserMessages([PASTE]), []);
  });

  it('Excel/PDF keeps current + ranked alternatives from the table', () => {
    const { ids, sel } = columnsOf([{ role: 'user', content: PASTE }]);
    const plans = sel.columns.map((c) => ({ planId: c.planId, planName: c.name, carrier: c.carrier }));
    const resolved = exp.resolveExportPlans(plans, PASTE, { userMessages: [PASTE], currentPlanIds: ['H5420-001'] });
    const out = resolved.map((p) => String(p.planId || p.id).slice(0, 9));
    assert.equal(out[0], 'H5420-001');
    assert.ok(out.length >= 2, out.join(','));
    for (const id of ids) assert.ok(out.includes(id), `export dropped ${id}`);
  });

  it('exclusive selected-only export stays current + A, B, C', () => {
    const only = 'I need to look only at H1019-006, H4140-023, and H0982-022. No other plans';
    assert.deepEqual(
      exp.workingPlanIdsFromUserMessages([PASTE, only]).map((id) => id.slice(0, 9)),
      ['H5420-001', 'H1019-006', 'H4140-023', 'H0982-022']
    );
  });
});
