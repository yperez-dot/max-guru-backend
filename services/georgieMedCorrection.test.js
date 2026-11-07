// Georgie workup, 2026-11-07: after alternatives appeared under an explicit Humana/HealthSun
// carrier ask, the agent replied `xcopi = Xcopri (cenobamate) 200 mg.` Max kept the stale
// ❓ 'xcopi tab 200' — did you mean cenobamate 200 mg [xcopri]? row (check-name in every
// column) AND appended a priced Xcopri row. An accepted alias must REPLACE the original
// medication in the table, structured workup, export, and reload. Directory / formulary
// cells here are fixtures — not live coverage. Do not infer a C-SNP diagnosis from meds.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const C = require('./compareJobs');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const { mergeMedications } = require('./workups');
const CW = require('../artifacts/client-workups.js');
const exp = require('../artifacts/comparison-export.js');

const PASTE = [
  'ZIP 33190 Miami-Dade.',
  'Currently on UHC MedicareMax FL-0028 H5420-001.',
  'Doctors: Cristiane Carvalho, George Sanchez, Yanelis Martin, Alix Salvant, Letty Villa, Enrique Angel Serrano, Nada Alyousha.',
  'Meds: calcium acetate, clonazepam 2mg, gabapentin cap 300mg, prolia, rosuvastatin 10mg, sertraline 100mg, xcopi tab 200.',
].join(' ');

const CORRECTION = 'xcopi = Xcopri (cenobamate) 200 mg.';
const MEDS = ['calcium acetate', 'clonazepam 2mg', 'gabapentin cap 300mg', 'prolia', 'rosuvastatin 10mg', 'sertraline 100mg', 'xcopi tab 200'];
const DOCTOR_NAMES = [
  'Cristiane Carvalho', 'George Sanchez', 'Yanelis Martin', 'Alix Salvant',
  'Letty Villa', 'Enrique Angel Serrano', 'Nada Alyousha',
];

const PLANS3 = [
  { planId: 'H5420-001', name: 'UHC MedicareMax FL-0028' },
  { planId: 'H1036-054C', name: 'Humana Gold Plus' },
  { planId: 'H5431-001', name: 'HealthSun HealthAdvantage' },
];

function xcopiNameCheck() {
  return {
    drugName: 'xcopi tab 200',
    inputName: 'xcopi tab 200',
    error: 'name_unconfirmed',
    lookups: [],
    byPlanId: {},
    nameCheck: { status: 'not_found', input: 'xcopi tab 200', suggestion: 'cenobamate 200 mg [xcopri]', alternatives: [] },
  };
}

function xcopriPriced() {
  const cell = { verified: true, coverage: 'covered', tier: 5, costShare: '33%' };
  return {
    drugName: 'Xcopri 200mg',
    inputName: 'Xcopri (cenobamate) 200 mg',
    lookups: [],
    byPlanId: Object.fromEntries(PLANS3.map((p) => [p.planId, { planId: p.planId, ...cell }])),
  };
}

function assistantTable() {
  const head = `| Doctor | ${PLANS3.map((p) => `${p.name} · ${p.planId}`).join(' | ')} |`;
  const sep = `|---|${PLANS3.map(() => '---').join('|')}|`;
  const doc = `| Cristiane Carvalho · NPI 1 | ${PLANS3.map(() => '✅ In').join(' | ')} |`;
  const medHead = `| Drug | ${PLANS3.map((p) => `${p.name} · ${p.planId}`).join(' | ')} |`;
  const xcopi = `| ❓ 'xcopi tab 200' — did you mean cenobamate 200 mg [xcopri]? | ${PLANS3.map(() => '❓ check name').join(' | ')} |`;
  return `**Doctors × Humana, HealthSun**\n\n${head}\n${sep}\n${doc}\n\n**Meds**\n\n${medHead}\n${sep}\n${xcopi}`;
}

function msgsAfterCorrection() {
  return [
    { role: 'user', content: PASTE },
    { role: 'assistant', content: assistantTable() },
    { role: 'user', content: CORRECTION },
  ];
}

function isXcopiGhost(name) {
  return /\bxcopi\b/i.test(name) && !/\bxcopri\b/i.test(name);
}

describe('parser: xcopi = Xcopri replaces the original med', () => {
  it('reads the alias as a substitution of the listed xcopi row', () => {
    const subs = LW.medSubstitutionsIn(CORRECTION, MEDS);
    assert.equal(subs.length, 1, String(subs));
    assert.match(subs[0][0], /xcopi/i);
    assert.match(subs[0][1], /xcopri/i);
    assert.match(subs[0][1], /200\s*mg/i);
  });

  it('does not treat a dose confirm or a doctor "X is Dr. Y" as a med alias', () => {
    assert.deepEqual(LW.applyMedSubstitutions('Levothyroxine Sodium is 0.2 mg.', ['Levothyroxine Sodium']), ['Levothyroxine Sodium']);
    assert.deepEqual(LW.applyMedSubstitutions('Pinecrest Dentisry is Dr. Salome Fraga.', ['Levothyroxine Sodium']), ['Levothyroxine Sodium']);
  });

  it('combined paste + correction yields one Xcopri and no leftover xcopi', () => {
    const ask = N.comparisonAskText(msgsAfterCorrection());
    assert.match(ask, /Med substitution:/);
    const meds = R.medsFromAsk(ask);
    assert.ok(meds.some((m) => /xcopri|cenobamate/i.test(m)), String(meds));
    assert.ok(!meds.some(isXcopiGhost), String(meds));
    assert.ok(meds.some((m) => /sertraline/i.test(m)));
    assert.ok(meds.some((m) => /gabapentin/i.test(m)));
  });

  it('yes to the did-you-mean row is the same replacement', () => {
    const next = LW.applyMedSubstitutions('yes', MEDS, assistantTable());
    assert.ok(next.some((m) => /xcopri|cenobamate/i.test(m)), String(next));
    assert.ok(!next.some(isXcopiGhost), String(next));
  });
});

describe('chat table: one row after the accepted correction', () => {
  it('ghost ❓ xcopi row is gone once Xcopri is priced — no repeat confirmation', () => {
    const ask = N.comparisonAskText(msgsAfterCorrection());
    const table = N.medsTable([xcopiNameCheck(), xcopriPriced()], PLANS3, MEDS, { askText: ask });
    assert.match(table, /xcopri/i);
    assert.doesNotMatch(table, /did you mean/);
    assert.doesNotMatch(table, /❓ check name/);
    assert.doesNotMatch(table, /xcopi tab 200/i);
    const drugRows = table.split('\n').filter((l) => /^\|/.test(l) && !/^\| Drug \|/.test(l) && !/^\|---/.test(l));
    assert.equal(drugRows.filter((l) => /xcopri|xcopi|cenobamate/i.test(l)).length, 1, table);
  });

  it('server re-runs the comparison on the alias (does not leave the model to append a row)', () => {
    const fu = N.comparisonFollowUp(msgsAfterCorrection());
    assert.ok(fu, 'comparisonFollowUp must re-run so the table is rebuilt');
    assert.match(fu.reason, /med spelling correction/);
    assert.equal(fu.doctors.length, 7);
    assert.ok(fu.doctors.includes('Cristiane Carvalho'));
  });
});

describe('workup / export / reload: replace, never append', () => {
  it('mergeMedications maps the unresolved xcopi row onto Xcopri', () => {
    const merged = mergeMedications(
      [{ name: 'xcopi tab 200', byPlanId: {} }, { name: 'sertraline 100mg', byPlanId: {} }],
      [{ name: 'Xcopri (cenobamate) 200 mg', byPlanId: { 'H5420-001': { verified: true, tier: 5, coverage: 'covered' } } }]
    );
    assert.equal(merged.filter((m) => /xcopi|xcopri|cenobamate/i.test(m.name)).length, 1, merged.map((m) => m.name).join(' | '));
    assert.match(merged.find((m) => /xcopri|cenobamate/i.test(m.name)).name, /xcopri/i);
    assert.ok(merged.some((m) => /sertraline/i.test(m.name)));
  });

  it('a genuine added drug stays a separate row', () => {
    const merged = mergeMedications(
      [{ name: 'xcopi tab 200', byPlanId: {} }, { name: 'sertraline 100mg', byPlanId: {} }],
      [{ name: 'tamsulosin 0.4mg', byPlanId: {} }]
    );
    assert.equal(merged.length, 3, merged.map((m) => m.name).join(' | '));
    const listed = N.comparisonAskText([
      { role: 'user', content: PASTE },
      { role: 'user', content: 'Meds: tamsulosin 0.4mg' },
    ]);
    const meds = R.medsFromAsk(listed);
    assert.ok(meds.some((m) => /tamsulosin/i.test(m)));
    assert.ok(meds.some((m) => /xcopi/i.test(m)));
    assert.ok(meds.some((m) => /sertraline/i.test(m)));
  });

  it('reloaded structured facts keep Xcopri and do not restore xcopi', () => {
    const medications = mergeMedications(
      MEDS.map((name) => ({ name, byPlanId: {} })),
      [{ name: 'Xcopri (cenobamate) 200 mg', byPlanId: {} }]
    );
    const ctx = CW.compactWorkupContext({
      clientName: 'Test Client',
      zip: '33190',
      county: 'Miami-Dade',
      currentPlanIds: ['H5420-001'],
      plans: [{ planId: 'H5420-001', planName: 'UHC MedicareMax FL-0028', carrier: 'UnitedHealthcare' }],
      doctors: DOCTOR_NAMES.map((name) => ({ name, byPlanId: {} })),
      medications,
    });
    assert.doesNotMatch(ctx, /xcopi tab 200/i);
    assert.match(ctx, /Xcopri|cenobamate/i);
    const meds = R.medsFromAsk(N.comparisonAskText([{ role: 'user', content: ctx }]));
    assert.ok(meds.some((m) => /xcopri|cenobamate/i.test(m)), String(meds));
    assert.ok(!meds.some(isXcopiGhost), String(meds));
  });

  it('Excel/PDF folds the unresolved alias into the priced Xcopri row', () => {
    const folded = exp.foldExportDrugs([
      { name: 'xcopi tab 200', byPlanId: {} },
      { name: "❓ 'xcopi tab 200' — did you mean cenobamate 200 mg [xcopri]?", byPlanId: {} },
      { name: 'Xcopri (cenobamate) 200 mg', byPlanId: { 'H5420-001': { verified: true, tier: 5, coverage: 'covered', costShare: '33%' } } },
    ]);
    const names = folded.map((d) => d.name);
    assert.ok(!names.some((n) => /did you mean|❓/.test(n)), names.join(' | '));
    assert.equal(folded.filter((d) => /xcopi|xcopri|cenobamate/i.test(d.name)).length, 1, names.join(' | '));
    const payload = exp.buildExportPayload(PLANS3, `${PASTE}\n${CORRECTION}`, {
      userMessages: [PASTE, CORRECTION],
      drugs: [
        { name: 'xcopi tab 200', byPlanId: {} },
        { name: 'Xcopri (cenobamate) 200 mg', byPlanId: { 'H5420-001': { verified: true, tier: 5, coverage: 'covered' } } },
      ],
      chatTable: {
        planIds: PLANS3.map((p) => p.planId),
        rows: [],
        meds: [
          { name: "❓ 'xcopi tab 200' — did you mean cenobamate 200 mg [xcopri]?", byPlan: { 'H5420-001': 'Check name' } },
          { name: 'Xcopri200mg', byPlan: { 'H5420-001': 'T5 33%' } },
        ],
      },
    });
    const drugNames = payload.drugs.map((d) => d.name);
    assert.ok(!drugNames.some((n) => /did you mean|Check name|❓/.test(n)), drugNames.join(' | '));
    assert.equal(payload.drugs.filter((d) => /xcopi|xcopri|cenobamate/i.test(d.name)).length, 1, drugNames.join(' | '));
  });
});

describe('C-SNP: listed meds never confirm a diagnosis', () => {
  it('Georgie paste leaves C-SNP unknown and still asks for a confirmed diagnosis', () => {
    assert.equal(R.eligibilityFromAsk(PASTE).csnp, 'unknown');
    assert.equal(R.eligibilityFromAsk(`${PASTE}\n${CORRECTION}`).csnp, 'unknown');
    assert.deepEqual(
      R.csnpHintsFromMeds(['calcium acetate', 'clonazepam 2mg', 'gabapentin cap 300mg', 'prolia', 'rosuvastatin 10mg', 'sertraline 100mg', 'Xcopri (cenobamate) 200 mg']),
      []
    );
    const parsed = C.parseCompareAsk(PASTE);
    assert.equal(parsed.eligibility.csnp, 'unknown');
    const ask = N.comparisonAskText([{ role: 'user', content: PASTE }]);
    const sel = N.selectComparison(
      DOCTOR_NAMES.map((name, i) => ({
        requestedName: name,
        doctorName: name,
        npi: String(1000000000 + i),
        status: 'done',
        pending: [],
        failed: [],
        networks: [],
        inNetworkPlans: ['UHC MedicareMax FL-0028 (HMO) (H5420-001)'],
        outOfNetworkPlans: [],
        carriersIn: [],
      })),
      ask,
      { answered: true, meds: MEDS }
    );
    assert.ok((sel.questions || []).some((q) => /C-SNP qualifying chronic condition, confirmed by diagnosis/i.test(q)), String(sel.questions));
    assert.ok(!(sel.flags || []).some((f) => /C-SNP qualifying condition confirmed/i.test(f)));
    assert.ok(!sel.columns.some((c) => c.snp === 'csnp'));
  });
});
