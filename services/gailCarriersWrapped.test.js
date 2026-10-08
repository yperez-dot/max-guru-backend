// Gail Carreno, 2026-10-08. A loaded workup, then:
//   1. "add doctors, devoted, and aetna to her plan comp."  → only Doctors HealthCare came back
//   2. four plans pasted in quotes that wrapped across lines → only Doctors DrMax/DrSelect came back
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const R = require('./comparisonRules');
const { conversationAskText } = require('./planYear');

const WORKUP = [
  "LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript). Resume these saved facts as a starting point. If the agent later asks for different plans, doctors, drugs, or a benefit that is not on the grid, follow that NEW request for chat and Excel/PDF. Do not lock the export to this snapshot. Only the 'Current plan' line is the client's current plan (if there is no such line and one plan is listed, that one is); every other plan below is a comparison column — never call it her current plan. When the agent asks for other, comparable or better plans, compare alternatives against her current plan, keep it as a column, and never ask which plan she has.",
  'Client: Gail Carreno', 'ZIP/county: 33186 / Miami-Dade', 'Plans:',
  '- Humana Humana Gold Plus (H1036-054C)', '- UHC UHC MedicareMax FL-0028 (H5420-001)',
  '- UHC UHC MedicareMax Complete Care FL-30 (H5420-014)', '- Aetna Aetna Medicare Select Care (H1609-093)',
  '- HealthSun HealthSun HealthAdvantage (H5431-001)', '- HealthSun HealthSun MediMax (H5431-006)',
  'Doctors (names only — pass exactly these names to lookup_provider_network): Natalia Rincon Buendia; Yanelis Martin',
].join('\n');
const M1 = 'add doctors, devoted, and aetna to her plan comp.';
const M2 = 'okao lets do "UHC MedicareMax Complete Care FL-30\n H5420-014"m Doctors DrMax-Dade · H4140-022, "Devoted CORE 037 \nH1290-037", Aetna Medicare Select Care H1609-093';
const T1 = [{ role: 'user', content: WORKUP }, { role: 'assistant', content: 'Loaded.' }, { role: 'user', content: M1 }];
const T2 = [...T1, { role: 'assistant', content: 'table' }, { role: 'user', content: M2 }];
const DOCS = ['Natalia Rincon Buendia', 'Yanelis Martin'].map((n) => ({
  doctorName: n, requestedName: n, npi: '1', status: 'done', pending: [], failed: [],
  inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [], networks: [],
}));
const select = (msgs) => N.selectComparison(DOCS, N.comparisonAskText(msgs, conversationAskText(msgs)), {});

describe('Gail Carreno: carrier ask after a loaded workup', () => {
  it('the workup rules text is never read as a Doctors HealthCare ask', () => {
    const ask = N.comparisonAskText(T1.slice(0, 2), conversationAskText(T1.slice(0, 2)));
    assert.doesNotMatch(ask, /Carriers requested/);
  });

  it('"add doctors, devoted, and aetna" asks for all three carriers', () => {
    assert.deepEqual(R.carriersRequested(M1).sort(), ['Aetna', 'Devoted', 'Doctors HealthCare']);
    const sel = select(T1);
    assert.match(sel.header, /Doctors HealthCare, Devoted, Aetna/);
    const carriers = new Set(sel.columns.map((c) => c.planId.slice(0, 5)));
    for (const c of ['H4140', 'H1290', 'H1609']) assert.ok(carriers.has(c), `missing ${c}: ${[...carriers]}`);
  });
});

describe('Gail Carreno: a pasted plan list that wraps inside quotes', () => {
  it('all four named plans are the columns, in her order', () => {
    assert.deepEqual(select(T2).columns.map((c) => c.planId), ['H5420-014', 'H4140-022', 'H1290-037', 'H1609-093']);
  });

  it('plan names come out clean', () => {
    const line = M2.replace(/\n\s*/g, ' ');
    assert.deepEqual(N.namedPlansFromAsk(line, { skip: new Set() }).map((p) => p.name), [
      'UHC MedicareMax Complete Care FL-30', 'Doctors DrMax-Dade', 'Devoted CORE 037', 'Aetna Medicare Select Care',
    ]);
  });

  it('a named-plan message decides the columns even with no "compare/show" verb', () => {
    const sel = select(T2);
    assert.match(sel.header, /your plans/);
    assert.doesNotMatch(sel.header, /carriers you asked for/);
  });
});
