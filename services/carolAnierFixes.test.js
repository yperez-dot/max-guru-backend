// Carol Anier PDF intake + follow-up regressions, 2026-11-25 (ZIP 33196).
// Fictional reuse of the live ask shape; no extra PHI.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const P = require('./pdfIntake');
const MP = require('./medicareProPrint');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const { parseCompareAsk } = require('./compareJobs');
const DN = require('./drugNames');
const exp = require('../artifacts/comparison-export.js');

const FIX = path.join(__dirname, 'fixtures/pdf/intake-carol-anier-print.txt');
const HTML = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');
const PRINT = fs.readFileSync(FIX, 'utf8');
const FILE = 'carol.anier.pcp info.pdf';
const ZIP = '33196';
const UHC = 'H5420-001';
const TYPED_GATES = 'No Medicaid, no MSP, no chronic condition';
const CORRECTION = 'Rebecca Hook is Rebekka Hooks';
const COMPOUND = 'Null is not a med, remove it. Yes, run other 2027 Miami-Dade plans.';

function carolIntake() {
  return P.parseIntakeText(PRINT, { filename: FILE });
}
function carolRequest() {
  return P.intakeRequestText(carolIntake(), { zip: ZIP });
}

describe('Bug 1: never use the agent as the client', () => {
  it('drops Yahoska Perez from the letterhead and uses the filename when the patient is not labeled', () => {
    const raw = MP.parseMedicareProPrint(PRINT);
    assert.notEqual(String(raw.clientName || '').toLowerCase(), 'yahoska perez');
    const it = carolIntake();
    assert.equal(it.clientName, 'Carol Anier');
    assert.equal(MP.clientNameFromFilename(FILE), 'Carol Anier');
    assert.equal(MP.isKnownAgentName('Yahoska Perez'), true);
    const req = carolRequest();
    assert.match(req, /^Carol Anier/);
    assert.doesNotMatch(req, /Yahoska Perez/i);
  });
});

describe('Bug 2: drop null/blank meds and never fuzzy-correct them', () => {
  it('drops Null at intake and parse, and resolveDrugName does not correct it to nullo', async () => {
    const it = carolIntake();
    assert.deepEqual(it.meds.map((m) => m.name), ['lisinopril 10 MG Oral Tablet', 'metformin 500 MG Oral Tablet']);
    assert.ok(!it.meds.some((m) => /null/i.test(m.name)));
    assert.equal(R.isBlankMedName('Null'), true);
    assert.equal(R.isBlankMedName('nullo'), true);
    assert.equal(R.isBlankMedName('None'), true);
    assert.ok(!R.medsFromAsk(carolRequest()).some((m) => /null/i.test(m)));
    DN._nameCache.clear();
    const hit = await DN.resolveDrugName('Null', async () => {
      throw new Error('RxNorm must not be called for a blank med placeholder');
    });
    assert.equal(hit.status, 'ignored');
    assert.doesNotMatch(String(hit.name || ''), /nullo/i);
  });
});

describe('Bug 3: match UHC MedicareMax FL-0028 to H5420-001', () => {
  it('resolves the CRM marketing name by carrier + FL-0028 and does not ask to confirm the ID', () => {
    const m = MP.matchPlanName('UHC MedicareMax Medicare Advantage FL-0028 (HMO)');
    assert.equal(m.planId, UHC);
    assert.equal(m.confidence, 'high');
    const it = carolIntake();
    assert.equal(it.currentPlan.planId, UHC);
    assert.equal(it.currentPlan.confidence, 'high');
    assert.ok(!it.questions.some((q) => q.kind === 'plan'));
    const f = parseCompareAsk(carolRequest());
    assert.deepEqual(f.currentPlans, [UHC]);
    assert.ok(f.plans.includes(UHC));
  });
});

describe('Bug 4: gating must be answered; typed answers count; no text re-ask after buttons', () => {
  it('parses a typed "No Medicaid, no MSP, no chronic condition" as completed gates', () => {
    const open = parseCompareAsk(carolRequest()).eligibility;
    assert.equal(open.medicaid, 'unknown');
    assert.equal(open.csnp, 'unknown');
    const el = R.eligibilityFromAsk(TYPED_GATES);
    assert.equal(el.medicaid, 'none');
    assert.equal(el.csnp, 'none');
    const closed = parseCompareAsk(`${carolRequest()}\n${TYPED_GATES}`).eligibility;
    assert.equal(closed.medicaid, 'none');
    assert.equal(closed.csnp, 'none');
  });

  it('the page does not auto-run a full PDF paste before the gate buttons are answered', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    assert.equal(html.includes('openWorkup(workup.id, fullRequest ? { pendingAsk: rawText }'), false);
    assert.match(html, /medicaidDone/);
    assert.match(html, /WS_MEDICAID\[answers\.medicaid\]\[1\]/);
    assert.equal(html.includes('Put it in the box'), false);
    assert.match(html, /startNewClient\(\); void wsSubmit\(t\);/);
  });
});

describe('Bug 5: after gating, current plan first plus alternative 2027 county plans', () => {
  it('a current-plan intake wants alternatives, and the current plan stays first', () => {
    const f = parseCompareAsk(`${carolRequest()}\n${TYPED_GATES}`);
    assert.equal(f.wantsAlternatives, true);
    assert.deepEqual(f.currentPlans, [UHC]);
    const countyPlans = R.gridPlansForCounty('Miami-Dade', 2027).filter((p) => !R.snpKind(p));
    assert.ok(countyPlans.length > 1, 'county has alternative 2027 core plans');
    assert.equal(f.currentPlans[0], UHC);
  });
});

describe('Bug 6: follow-ups are commands, not meds, and they clean exports', () => {
  it('treats a doctor correction, a med removal, and yes-to-run-other-plans as intents', () => {
    assert.deepEqual(N.doctorEqualsCorrections(CORRECTION), [{ said: 'Rebecca Hook', name: 'Rebekka Hooks', npi: '' }]);
    assert.deepEqual(R.medsFromAsk(CORRECTION), []);
    assert.deepEqual(R.medsFromAsk(COMPOUND), []);
    assert.ok(!R.medsFromAsk(CORRECTION).some((m) => /allium|hookeri/i.test(m)));
    const saved = ['lisinopril 10 MG Oral Tablet', 'nullo', 'metformin 500 MG Oral Tablet', 'Null is not a med', 'allium hookeri whole extract'];
    const gone = LW.medRemovalsIn(COMPOUND, saved);
    assert.ok(gone.includes('nullo'));
    const kept = saved.filter((m) => !gone.includes(m) && !R.isBlankMedName(m) && !R.isFollowUpCommand(m) && !/allium hookeri/i.test(m) && !/Rebecca Hook is Rebekka Hooks/i.test(m));
    // The allium row was a mis-parsed correction; once the correction is an intent it is never added.
    const after = R.medsFromAsk(`${carolRequest()}\n${CORRECTION}\n${COMPOUND}`);
    assert.ok(after.some((m) => /lisinopril/i.test(m)));
    assert.ok(after.some((m) => /metformin/i.test(m)));
    assert.ok(!after.some((m) => /null|nullo|hookeri|Rebecca Hook is/i.test(m)));
    const msgs = [
      { role: 'assistant', content: 'I can search other 2027 plans where they ARE in network — want me to?' },
      { role: 'user', content: COMPOUND },
    ];
    assert.equal(N.acceptedInNetworkSearchOffer(msgs, 1), true);
  });
});

describe('Bug 7: intake specialty shows when NPI taxonomy is Unknown', () => {
  it('uses Vascular surgeon for Michele Taubman when the NPI specialty is Unknown', () => {
    const it = carolIntake();
    const doc = it.doctors.find((d) => d.name === 'Michele Taubman');
    assert.equal(doc.specialty, 'Vascular surgeon');
    assert.equal(N.displaySpecialty({ specialty: 'Unknown', requestedSpecialty: 'Vascular surgeon' }), 'Vascular surgeon');
    assert.equal(N.displaySpecialty({ specialty: 'Neurology', requestedSpecialty: 'Oncologist' }), 'Neurology');
    assert.equal(exp.doctorExportLabel({ name: 'Michele Taubman', role: 'Unknown', requestedSpecialty: 'Vascular surgeon' }), 'Michele Taubman — Vascular surgeon');
  });
});

describe('Bug 8: structured intake UX', () => {
  it('has structured fields, a disabled Run Max until name+ZIP+plan, and no Put it in the box', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    assert.match(html, /data-testid="pdf-intake-name"/);
    assert.match(html, /data-testid="pdf-intake-zip"/);
    assert.match(html, /data-testid="pdf-intake-plan"/);
    assert.match(html, /data-testid="pdf-intake-need"/);
    assert.match(html, /useLabel="Run Max"/);
    assert.equal(html.includes('Put it in the box'), false);
    assert.match(html, /const canRun = nameOk && zipOk && planOk && open\.length === 0;/);
  });
});

describe('Bug 9: both Solis Guardian H0982-002 copies have deductible and chiropractic', () => {
  it('fills Medical Deductible and Chiropractic on every H0982-002 Miami-Dade copy', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    const block = html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(block);
    const plans = JSON.parse(block[1]);
    const copies = plans.filter((p) => (p.planId === 'H0982-002' || p.id === 'H0982-002') && p.county === 'Miami-Dade');
    assert.equal(copies.length, 2, 'do not dedupe — both copies stay');
    for (const p of copies) {
      assert.equal(p.planDeductible, '$0');
      assert.equal(p.chiropractic, '$0; routine: 12 visits/yr $0');
    }
  });
});

describe('Carol golden: end-to-end sequence plus a clean export', () => {
  it('replays intake → gates → correction → removal + yes, and keeps the export clean', () => {
    const it = carolIntake();
    assert.equal(it.clientName, 'Carol Anier');
    assert.equal(it.currentPlan.planId, UHC);
    assert.ok(!it.meds.some((m) => /null/i.test(m.name)));

    const request = carolRequest();
    const first = parseCompareAsk(request);
    assert.equal(first.clientName, 'Carol Anier');
    assert.equal(first.zip, ZIP);
    assert.deepEqual(first.currentPlans, [UHC]);
    assert.equal(first.eligibility.medicaid, 'unknown');
    assert.equal(first.wantsAlternatives, true);

    const gated = parseCompareAsk(`${request}\n${TYPED_GATES}`);
    assert.equal(gated.eligibility.medicaid, 'none');
    assert.equal(gated.eligibility.csnp, 'none');
    assert.equal(gated.currentPlans[0], UHC);
    assert.equal(gated.wantsAlternatives, true);

    assert.deepEqual(N.doctorEqualsCorrections(CORRECTION)[0].name, 'Rebekka Hooks');
    assert.deepEqual(R.medsFromAsk(CORRECTION), []);

    const savedMeds = ['lisinopril 10 MG Oral Tablet', 'nullo', 'metformin 500 MG Oral Tablet', 'Rebecca Hook is Rebekka Hooks'];
    const gone = LW.medRemovalsIn(COMPOUND, savedMeds);
    const exportMeds = savedMeds.filter((m) => !gone.includes(m) && !R.isBlankMedName(m) && !R.isFollowUpCommand(m));
    assert.deepEqual(exportMeds, ['lisinopril 10 MG Oral Tablet', 'metformin 500 MG Oral Tablet']);
    assert.ok(!exportMeds.some((m) => /nullo|null|Rebecca Hook is Rebekka Hooks/i.test(m)));

    const msgs = [
      { role: 'assistant', content: 'I can search other 2027 plans where they ARE in network — want me to?' },
      { role: 'user', content: COMPOUND },
    ];
    assert.equal(N.acceptedInNetworkSearchOffer(msgs, 1), true);

    const labels = exp.FIELD_ROWS.map((row) => row[0]);
    assert.equal(labels.indexOf('Medical Deductible'), labels.indexOf('Max Out of Pocket') + 1);
    assert.ok(labels.indexOf('Medical Deductible') < labels.indexOf('Other'));
    const benefit = exp.BENEFIT_ROWS.map((row) => row[0]);
    assert.ok(benefit.indexOf('Medical Deductible') > 0);
    assert.ok(benefit.indexOf('Medical Deductible') < benefit.indexOf('Other'));
    assert.ok(Math.abs(benefit.indexOf('Medical Deductible') - benefit.indexOf('MOOP')) === 1);
  });
});
