// Fictional ZIP 33126 regression fixtures modeled on the 11.22.2026 bug log.
// No real client names or PHI.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const { splitList, parseCompareAsk } = require('./compareJobs');
const DN = require('./drugNames');
const exp = require('../artifacts/comparison-export.js');
const CW = require('../artifacts/client-workups.js');
const D = require('./devotedNetworks');
const { planNetworkStatus, STATUS } = require('./networkStatus');
const { isInNetworkStatus } = require('./aetnaPublicSearch');
const ZIP = '33126';
const DEVOTED = 'H1290-062';
const AETNA = 'H1609-093';
const HEALTHSUN = 'H5431-001';
const DRMAX = 'H4140-022';
const UHC = 'H5420-014';

const MENDEZ_Q = 'No exact match for:\n• "Luis Mendez" — more than one provider with this name: Luis E Mendez Luaces, APRN (Nurse Practitioner, Miami, NPI 1023741444); Luis E. Mendez, MD (Obstetrics & Gynecology, Coral Gables, NPI 1730187287)\nReply "Luis Mendez = Dr. Full Name".';

const FICTIONAL_DOCTORS = [
  'Sam Star MD neurology',
  'Gale Hillman',
  'Jenny Montes NPI 1999999911',
  'Luis Mendez',
  'Coral Gables Eyecare Center, Inc',
  'Rina Velez',
  'Omar Castillo PCP',
  'Priya Shah cardiology',
  'Elena Ruiz',
];

const FICTIONAL_MEDS = [
  '24 HR oxcarbazepine 600 MG Extended Release Oral Tablet',
  'triamcinolone 0.00025 MG/MG ointment',
  'estradiol 0.001 MG/MG topical gel',
  'estradiol 0.00313 MG/HR transdermal patch',
  'diclofenac 20 MG/ML topical solution',
  'Prolia',
  'finasteride 1 mg',
  'metformin 500 mg',
];

describe('Bug 15: doctor-confirm replies bind to a listed candidate NPI', () => {
  const pick = (a) => N.candidatePicks(MENDEZ_Q, a);
  it('specialty, city, credential, partial NPI, and yes all resolve to one NPI', () => {
    assert.equal(pick('Luis Mendez = Luis E. Mendez, MD (Obstetrics & Gynecology, Coral Gables, NPI 1730187287)')[0].npi, '1730187287');
    assert.equal(pick('Luis Mendez = Luis E. Mendez, MD Coral Gables')[0].npi, '1730187287');
    assert.equal(pick('Luis Mendez IS the Ob/Gyn in Coral Gables')[0].npi, '1730187287');
    assert.equal(pick('the APRN')[0].npi, '1023741444');
    assert.equal(pick('7287')[0].npi, '1730187287');
  });
  it('a spelled-correct First Last, MD binds to the asked name, not a different listed MD', () => {
    const q = '1. No exact match for:\n• "Pasquel DeSantis - Endocrinologist - Baptist" — closest: Joseph Desantis, ARNP (Miami)\n• "Neeta Erinjerri - Surgeon at Baptist" — did you mean Neeta Jane Erinjeri, MD (Surgery, Miami)? (looks like a spelling difference)';
    assert.equal(N.candidatePicks(q, 'Pascual De Santis, MD').length, 0);
    const r = N.comparisonFollowUp([
      { role: 'user', content: `Alex Rivera · ZIP ${ZIP}\nDoctors: Pasquel DeSantis - Endocrinologist - Baptist; Neeta Erinjerri - Surgeon at Baptist; Alan Chu\nPlans: ${DEVOTED}\nComparison results` },
      { role: 'assistant', content: q },
      { role: 'user', content: 'Pascual De Santis, MD' },
    ]);
    assert.ok(r && r.doctors.some((n) => /^Pascual De Santis/.test(n)));
    assert.ok(!r.doctors.some((n) => /Pasquel/.test(n)));
  });
  it('never stores the raw reply as a doctor name', () => {
    const msgs = [
      { role: 'user', content: 'check doctors' },
      { role: 'assistant', content: MENDEZ_Q },
      { role: 'user', content: 'Luis Mendez IS the Ob/Gyn in Coral Gables' },
    ];
    const res = N.threadDoctorResolutions(msgs, 2);
    assert.equal(res.length, 1);
    assert.equal(res[0].npi, '1730187287');
    assert.doesNotMatch(res[0].name, /IS the Ob/i);
    const stmts = N.statementsFor ? null : true;
    void stmts;
    const { statementsFor } = N;
    if (typeof statementsFor === 'function') {
      const s = statementsFor(MENDEZ_Q, 'Luis Mendez IS the Ob/Gyn in Coral Gables').join(' ');
      assert.match(s, /1730187287/);
      assert.doesNotMatch(s, /IS the Ob\/Gyn/);
    }
  });
});

describe('Bug 1/7: Devoted listed-but-unmapped is not mass Out', () => {
  it('empty refs + carrier listed → unmapped, no outPlans', () => {
    const v = D.devotedPlanVerdicts([], 2027, { carrierListed: true });
    assert.equal(v.unmapped, true);
    assert.equal(v.outPlans.length, 0);
    assert.equal(v.inPlans.length, 0);
  });
  it('empty refs + not listed → Out on every 2027 Devoted plan', () => {
    const v = D.devotedPlanVerdicts([], 2027, { carrierListed: false });
    assert.ok(v.outPlans.some((l) => /H1290-062/.test(l)));
  });
  it('FL HMO network is In on H1290-062', () => {
    const v = D.devotedPlanVerdicts([D.FL_HMO.ref], 2027);
    assert.ok(v.inPlans.some((l) => /H1290-062/.test(l)));
    assert.ok(v.outPlans.some((l) => /H1290-085/.test(l)));
  });
});

describe('Bug 17: removing one plan drops only that plan', () => {
  const plans = [
    { planId: DEVOTED, name: 'Devoted CORE 062' },
    { planId: UHC, name: 'UHC MedicareMax' },
    { planId: HEALTHSUN, name: 'HealthSun HealthAdvantage' },
    { planId: AETNA, name: 'Aetna Medicare Select Care' },
    { planId: DRMAX, name: 'Doctors DrMax-Dade' },
  ];
  it('Remove HealthSun HealthAdvantage · H5431-001 keeps Aetna and DrMax', () => {
    const rm = LW.planRemovals('Remove HealthSun HealthAdvantage · H5431-001', plans, [DEVOTED]);
    assert.deepEqual(rm.remove, [HEALTHSUN]);
    const left = LW.removeNamedPlans(plans, rm.remove).map((p) => p.planId);
    assert.deepEqual(left, [DEVOTED, UHC, AETNA, DRMAX]);
  });
  it('workingPlanIdsFromUserMessages does not drop H4140 because of the word doctors', () => {
    const ids = exp.workingPlanIdsFromUserMessages([
      `Compare ${DEVOTED}, ${UHC}, ${HEALTHSUN}, ${AETNA}, ${DRMAX}`,
      'Remove HealthSun HealthAdvantage · H5431-001',
    ]);
    assert.ok(ids.includes(AETNA));
    assert.ok(ids.includes(DRMAX));
    assert.ok(!ids.includes(HEALTHSUN));
  });
  it('keepPlanColumns leaves remaining Prolia cells unchanged', () => {
    const result = {
      columns: plans.map((p) => ({ planId: p.planId })),
      drugs: [{
        name: 'Prolia',
        byPlanId: {
          [DEVOTED]: { verified: true, coverage: 'not_covered' },
          [HEALTHSUN]: { verified: true, coverage: 'covered', tier: 4, costShare: '$30' },
          [AETNA]: { verified: true, coverage: 'covered', tier: 5, costShare: '33%' },
        },
      }],
    };
    const kept = LW.keepPlanColumns(result, [DEVOTED, UHC, AETNA, DRMAX]);
    assert.equal(kept.drugs[0].byPlanId[DEVOTED].coverage, 'not_covered');
    assert.equal(kept.drugs[0].byPlanId[HEALTHSUN], undefined);
    assert.equal(kept.drugs[0].byPlanId[AETNA].tier, 5);
  });
});

describe('Bugs 9-10: never In without a listing at this location', () => {
  it('Out-of-network at this location is not In-network', () => {
    assert.equal(isInNetworkStatus('Out-of-network at this location'), false);
    assert.equal(planNetworkStatus({
      carrierHit: true,
      locationOon: true,
      directoryFinished: true,
    }), STATUS.OUT);
  });
  it('Aetna carrier hit without this plan listed is not confirmed, not In*', () => {
    const doctor = {
      doctorName: 'Jenny Montes', requestedName: 'Jenny Montes', npi: '1999999911', status: 'done',
      inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: ['Aetna Medicare'],
      networks: [{
        carrier: 'Aetna Medicare', inNetwork: true, status: 'checked',
        plans: ['Aetna Dual (H1609-018)'],
        locationOon: true,
        matches: [{ networkStatus: 'Out-of-network at this location', address: '370 Minorca Ave, Coral Gables, FL 33134' }],
      }],
      failed: [], pending: [],
    };
    const cols = N.namedPlanColumns(
      [{ planId: AETNA, name: 'Aetna Medicare Select Care (H1609-093)' }],
      [],
      [doctor],
    );
    assert.ok(cols[0].out.includes(N.shortDoctor ? N.shortDoctor(doctor) : cols[0].out[0]) || cols[0].out.length === 1);
    assert.equal(cols[0].in.length, 0);
    assert.equal((cols[0].inCarrier || []).length, 0);
  });
});

describe('Bug 11: reopening a saved workup restores the snapshot', () => {
  it('leftover questions stage loses to compareResult', () => {
    const workup = {
      id: 'w1',
      planIds: [DEVOTED, AETNA],
      plans: [{ planId: DEVOTED }, { planId: AETNA }],
      doctors: [{ name: 'Sam Star' }, { name: 'Luis Mendez' }],
      eligibility: { medicaid: 'none', csnp: 'none', mustKeep: ['Sam Star'] },
      compareResult: { columns: [{ planId: DEVOTED }, { planId: AETNA }], doctors: [], drugs: [] },
    };
    const leftover = { stage: 'questions', answers: {}, job: { status: 'done' } };
    const r = CW.restoreWorkspaceFromWorkup(workup, leftover);
    assert.equal(r.preferSnapshot, true);
    assert.equal(r.ws.stage, 'done');
    assert.equal(r.ws.result, workup.compareResult);
    assert.equal(r.answers.medicaid, 0);
    assert.equal(r.answers.csnp, 0);
  });
});

describe('Bugs 2/5/14: med identity keeps strength, form, and one row each', () => {
  it('24 HR oxcarbazepine 600 MG ER keeps oxcarbazepine + 600 mg, not hr-as-ingredient', () => {
    const p = DN.medNameParts('24 HR oxcarbazepine 600 MG Extended Release Oral Tablet');
    assert.ok(p.ingredients.some((i) => /oxcarbazepine/.test(i)));
    assert.match(p.strength, /600/);
    assert.doesNotMatch(p.ingredients.join(' '), /\bhr\b/);
  });
  it('0.00025 MG/MG becomes 0.025% and keeps ointment', () => {
    const p = DN.medNameParts('triamcinolone 0.00025 MG/MG ointment');
    assert.match(p.strength, /0\.025\s*%/);
    assert.match(p.form, /ointment/);
  });
  it('estradiol gel and estradiol patch do not merge', () => {
    const gel = 'estradiol 0.001 MG/MG topical gel';
    const patch = 'estradiol 0.00313 MG/HR transdermal patch';
    assert.notEqual(exp.drugIdentityKey(gel), exp.drugIdentityKey(patch));
    assert.equal(require('./comparisonRules').sameDrug(gel, patch), false);
    const folded = exp.foldExportDrugs([{ name: gel, byPlanId: {} }, { name: patch, byPlanId: {} }, { name: 'Prolia', byPlanId: {} }]);
    assert.equal(folded.length, 3, folded.map((d) => d.name).join(' | '));
  });
  it('diclofenac topical solution is not the same core as diclofenac potassium', () => {
    assert.equal(DN.sameCoreDrug('diclofenac topical solution', 'diclofenac potassium'), false);
  });
  it('every entered med is its own row', () => {
    const rows = FICTIONAL_MEDS.map((name) => ({ name, byPlanId: {} }));
    const folded = exp.foldExportDrugs(rows);
    assert.equal(folded.length, FICTIONAL_MEDS.length, folded.map((d) => d.name).join(' | '));
  });
});

describe('Bug 13: never split Inc/LLC; never match a doctor entry to a pharmacy', () => {
  it('Cepero-style business name stays one doctor token', () => {
    const parts = splitList('Sam Star, Coral Gables Eyecare Center, Inc, Rina Velez');
    assert.ok(parts.some((p) => /Eyecare Center,\s*Inc/i.test(p)));
    assert.ok(!parts.some((p) => /^inc\.?$/i.test(p)));
  });
  it('parseCompareAsk at ZIP 33126 keeps the Inc clinic as one doctor', () => {
    const f = parseCompareAsk(`Alex Rivera, ${ZIP}. Current plan Devoted ${DEVOTED}. Doctors: ${FICTIONAL_DOCTORS.join(', ')}. Meds: Prolia.`);
    assert.ok(f.doctors.some((d) => /Eyecare Center,\s*Inc/i.test(d.name)));
    assert.ok(!f.doctors.some((d) => /^inc\.?$/i.test(d.name)));
  });
});

describe('Bug 16: doctor removal is one consistent result', () => {
  it('strips specialty/NPI suffix and does not also run plan unmatched', () => {
    const t = 'remove Inca Nica Inc (Dba Central Pharmacy) · Pharmacist · NPI 1881695716';
    assert.equal(LW.isDoctorLikeRemoval(t), true);
    assert.equal(LW.isComparisonRemoval(t), false);
    const clauses = LW.doctorRemovalClauses(t);
    assert.ok(clauses.length);
    assert.deepEqual(LW.doctorRemovalLines(['Inca Nica Inc (Dba Central Pharmacy)'], []), ['Inca Nica Inc (Dba Central Pharmacy) is removed.']);
    assert.deepEqual(LW.doctorRemovalLines([], ['Inca Nica Inc']), ['Couldn\'t find "Inca Nica Inc" — nothing removed.']);
  });
});

describe('Bug 12: one med-cell formatter; never Tier or middot', () => {
  it('T# $X / T# X% / Not covered / Confirm', () => {
    assert.equal(exp.formatMedCell({ verified: true, coverage: 'covered', tier: 4, costShare: '$30' }), 'T4 $30');
    assert.equal(exp.formatMedCell({ verified: true, coverage: 'covered', tier: 5, costShare: '33%' }), 'T5 33%');
    assert.equal(exp.formatMedCell({ verified: true, coverage: 'not_covered' }), 'Not covered');
    assert.equal(exp.formatMedCell({ verified: false }), 'Confirm');
  });
  it('fails if any med cell contains Tier or ·', () => {
    const cells = [
      exp.formatMedCell({ verified: true, coverage: 'covered', tier: 2, costShare: '$0', pa: true }),
      exp.formatMedCell({ verified: true, coverage: 'covered', tier: 3, costShare: '15%' }),
      N.drugCell({ verified: true, coverage: 'covered', tier: 4, costShare: '$30' }),
      N.drugCell({ verified: true, coverage: 'not_covered' }),
    ];
    for (const c of cells) {
      assert.doesNotMatch(c, /Tier/);
      assert.doesNotMatch(c, /·/);
    }
  });
  it('Prolia on HealthSun uses lookup status.tier, not a grid T5 guess', () => {
    const healthsun = { planId: HEALTHSUN, tier4: 30, tier5: 0.33 };
    const lookup = { verified: true, coverage: 'covered', tier: 4, costShare: '$30', restrictionsKnown: true };
    assert.equal(exp.formatMedCell(lookup, healthsun), 'T4 $30');
    assert.equal(N.drugCell(lookup), 'T4 $30');
  });
});

describe('Bugs 3/6: must-keep wording and count row match the cells', () => {
  it('planLine does not lump Out with not confirmed', () => {
    const p = { name: 'Aetna Select', planId: AETNA, in: [], out: ['Sam Star'], unknown: ['Gale Hillman'], notConfirmed: ['Gale Hillman'], inCarrier: [] };
    const line = N.planLine(p, 2);
    assert.match(line, /Not in network: Sam Star/);
    assert.doesNotMatch(line, /unchecked\/not confirmed: Sam Star/);
  });
  it('In* is not counted as unchecked', () => {
    const text = N.cellCountText(['✅ In', '✅ In*', '❌ Not in network (not listed)', '❔ not confirmed']);
    assert.doesNotMatch(text, /1 unchecked/);
  });
});

describe('Exports: no doctor NPI; extra grid rows present', () => {
  it('doctorExportLabel is name + specialty only', () => {
    assert.equal(exp.doctorExportLabel({ name: 'Dr. Sam Star', role: 'Neurology', npi: '1999999901' }), 'Dr. Sam Star — Neurology');
    assert.doesNotMatch(exp.doctorExportLabel({ name: 'Dr. Sam Star', role: 'Neurology', npi: '1999999901' }), /NPI/);
  });
  it('FIELD_ROWS includes Chiropractic, Other, Medical Deductible, SSBCI', () => {
    const labels = exp.FIELD_ROWS.map((r) => r[0]);
    assert.ok(labels.includes('Chiropractic'));
    assert.ok(labels.includes('Other'));
    assert.ok(labels.includes('Medical Deductible'));
    assert.ok(labels.includes('SSBCI Chronic Conditions'));
  });
});
