// Live report, 2026-10-21 4:11–4:19 PM ET (client name replaced).
// (A) "Pls add Humana Gold Plus h1036-054 to the comparsion. Remove Doctos and Careplus": H1036-054C was added but the
//     Doctors and CarePlus columns stayed; the same reply asked "Did you mean remove Doctors DrMax-Dade?" AND said it dropped
//     both. Now: both removed ("Doctos" read as Doctors, said once), no question, and they stay gone on later turns.
// (B) The PDF said Jose Martinez is a Gastroenterologist at 11440 N Kendall Dr; Max offered cardiology / FNP / surgery
//     people. Robert Sirven is an Allergist at 8200 SW 117th Ave; Max matched a Family NP. The specialty and street now
//     rank / filter the NPI candidates and each mismatch is flagged in the question.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const CW = require('../artifacts/client-workups.js');
const NPI = require('./npiRegistry');
const SH = require('./specialtyHints');

const WK = {
  clientName: 'Jose Ejemplo Ruiz', zip: '33196', currentPlanIds: ['H5420-014'],
  plans: [{ planId: 'H5420-014', carrier: 'UHC', planName: 'UHC MedicareMax Complete Care FL-30' }, { planId: 'H4140-022', carrier: 'Doctors', planName: 'Doctors DrMax-Dade' }, { planId: 'H1019-006', carrier: 'CarePlus', planName: 'CarePlus CareOne Plus' }],
  doctors: [{ name: 'Alejandro Lopez Rossitch' }, { name: 'Jose Martinez' }], medications: [{ name: 'Famotidine 40 mg' }],
};
const TABLE3 = '| Doctor | UHC MedicareMax Complete Care FL-30 · H5420-014 | Doctors DrMax-Dade · H4140-022 | CarePlus CareOne Plus · H1019-006 |\n|---|---|---|---|\n| Alejandro Lopez Rossitch | ✅ In | ✅ In | ✅ In |';
const ASK = 'Pls add Humana Gold Plus h1036-054 to the comparsion. Remove Doctos and Careplus';
const row = { doctorName: 'Alejandro Lopez Rossitch', requestedName: 'Alejandro Lopez Rossitch', status: 'done', networks: [], inNetworkPlans: [] };
const cols = (msgs) => N.selectComparison([row], N.comparisonAskText(msgs), {}).columns.map((c) => c.planId);

test('(A) "Remove Doctos and Careplus" + add H1036-054: both columns go, Doctos = Doctors, acted on (no question)', () => {
  const msgs = [{ role: 'user', content: CW.compactWorkupContext(WK) }, { role: 'assistant', content: TABLE3 }, { role: 'user', content: ASK }];
  const rm = LW.planRemovals(ASK, WK.plans.map((p) => ({ planId: p.planId, name: p.planName })), ['H5420-014']);
  assert.deepEqual(rm.remove, ['H4140-022', 'H1019-006']);
  assert.deepEqual(rm.confirm, []);
  assert.deepEqual(rm.readAs.map((x) => [x.target, x.carrier]), [['Doctos', 'Doctors HealthCare']]);
  assert.ok(N.comparisonFollowUp(msgs), 'the server re-runs the table now');
  assert.deepEqual(LW.resolveWorkupSets(msgs).plans.map((p) => p.planId), ['H5420-014', 'H1036-054C']);
  assert.deepEqual(cols(msgs), ['H5420-014', 'H1036-054C']);
  const ask = N.comparisonAskText(msgs);
  assert.match(ask, /^Confirmed plan removal: H4140-022 \(Doctors DrMax-Dade\)\.$/m);
  assert.match(ask, /^Confirmed plan removal: H1019-006 \(CarePlus CareOne Plus\)\.$/m);
  assert.match(ask, /^Plans removed this turn — say so in one line, never ask about them: Doctors DrMax-Dade; CarePlus CareOne Plus \(read "Doctos" as Doctors HealthCare\)\.$/m);
  const out = N.renderedAnswer([row], ask, {});
  assert.match(out, /^Removed: Doctors DrMax-Dade; CarePlus CareOne Plus \(read "Doctos" as Doctors HealthCare\)\.$/m);
  assert.doesNotMatch(out, /Did you mean remove/);
  assert.doesNotMatch(out.split('\n').find((l) => /^\| Doctor/.test(l)), /H4140-022|H1019-006/);
  assert.doesNotMatch(ask, /Plan removal questions:/, 'acted on — never asked as well');
  // Later turns: still gone.
  const msgs2 = [...msgs, { role: 'assistant', content: '| Doctor | UHC MedicareMax Complete Care FL-30 · H5420-014 | Humana Gold Plus · H1036-054C |\n|---|---|---|\n| Alejandro Lopez Rossitch | ✅ In | ✅ In |' }, { role: 'user', content: 'Check Jose Martinez again' }];
  assert.deepEqual(cols(msgs2), ['H5420-014', 'H1036-054C']);
  assert.deepEqual(cols([...msgs2, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'export to excel' }]), ['H5420-014', 'H1036-054C']);
});

test('(A) list removals: "drop Aetna, Devoted" / a near miss is asked and said to stay; a verb ends the list', () => {
  const plans = [{ planId: 'H5420-014', name: 'UHC MedicareMax' }, { planId: 'H1609-018', name: 'Aetna Medicare Value' }, { planId: 'H1290-073', name: 'Devoted Core' }, { planId: 'H1036-054C', name: 'Humana Gold Plus' }];
  assert.deepEqual(LW.planRemovals('drop Aetna, Devoted', plans, ['H5420-014']).remove, ['H1609-018', 'H1290-073']);
  assert.deepEqual(LW.planRemovals('remove Aetna and add Humana H1036-121', plans, ['H5420-014']).remove, ['H1609-018']);
  const near = LW.planRemovals('remove the Gold Pluss plan', plans, ['H5420-014']);
  assert.equal(near.remove.length, 0);
  assert.equal(near.confirm.length, 1);
  // "Doctos" with no Doctors plan in the table: nothing removed, never a wrong plan.
  assert.deepEqual(LW.planRemovals('Remove Doctos', plans, ['H5420-014']).remove, []);
  // A pending question: the reply is told the plan stays until she answers.
  const msgs = [{ role: 'user', content: 'Compare UHC MedicareMax H5420-014, Aetna H1609-018, Humana Gold Plus H1036-054C' }, { role: 'assistant', content: '| Doctor | UHC MedicareMax · H5420-014 | Aetna Medicare Value · H1609-018 | Humana Gold Plus · H1036-054C |\n|---|---|---|---|\n| X | ✅ In | ✅ In | ✅ In |' }, { role: 'user', content: 'remove the Gold Pluss plan' }];
  const ask = N.comparisonAskText(msgs);
  assert.match(ask, /Plan removal questions: Did you mean remove/);
  assert.match(ask, /^Plans asked about stay in the table until she answers — never say they were removed\.$/m);
  assert.doesNotMatch(ask, /Plans removed this turn/);
});

// NPPES records (public provider data) for the two names.
const rec = (number, first, middle, last, cred, tax, street, zip, city = 'MIAMI') => ({
  number, enumeration_type: 'NPI-1', basic: { first_name: first, middle_name: middle, last_name: last, credential: cred },
  taxonomies: [{ desc: tax, primary: true }], addresses: [{ address_purpose: 'LOCATION', address_1: street, postal_code: `${zip}0000`, city }],
});
const NPPES = [
  rec('1073579330', 'JOSE', 'MANUEL', 'MARTINEZ', 'MD', 'Surgery', '1611 NW 12TH AVE', '33136'),
  rec('1912931312', 'JOSE', 'MANUEL', 'MARTINEZ', 'MD', 'Internal Medicine, Interventional Cardiology', '12494 SW 127TH AVE', '33186'),
  rec('1427669639', 'JOSE', 'F', 'MARTINEZ', '', 'Nurse Practitioner, Family', '10742 SW 138TH PL', '33186'),
  rec('1508853490', 'JOSE', 'LUIS', 'MARTINEZ', 'M.D.', 'Internal Medicine, Gastroenterology', '2140 W 68TH ST', '33016', 'HIALEAH'),
  rec('1376734962', 'IAN', 'R', 'MARTINEZ', 'MD', 'Internal Medicine, Gastroenterology', '100 MAIN ST', '32765', 'OVIEDO'),
  rec('1902235476', 'ROBERTO', '', 'SIRVEN', 'ARNP', 'Nurse Practitioner, Family', '8200 SW 117TH AVE STE 110', '33183'),
  rec('1538122247', 'VIVIANA', '', 'SIRVEN', 'MD', 'Allergy & Immunology', '8200 SW 117TH AVE STE 110', '33183'),
  rec('1639107212', 'ALBERTO', '', 'SIRVEN', 'MD', 'Obstetrics & Gynecology', '8200 SW 117TH AVE', '33183'),
];
function stubNppes() {
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    const last = (u.searchParams.get('last_name') || '').toUpperCase().replace(/\*$/, '');
    const first = (u.searchParams.get('first_name') || '').toUpperCase();
    const tax = (u.searchParams.get('taxonomy_description') || '').toLowerCase();
    const results = NPPES.filter((r) => r.basic.last_name.startsWith(last) && (!first || r.basic.first_name.startsWith(first.slice(0, 4))) && (!tax || r.taxonomies[0].desc.toLowerCase().includes(tax)));
    return { ok: true, json: async () => ({ results }) };
  };
  return () => { global.fetch = real; };
}

test('(B) specialty + street from the PDF rank and filter the NPI candidates; mismatches flagged', async () => {
  const restore = stubNppes();
  try {
    const martinezHints = SH.doctorHints({ doctorName: 'Jose Martinez (Gastroenterologist; supervising doctor)', address: '11440 N. Kendall Dr., Ste #306, Miami, FL 33176', hintZip: '33176' });
    assert.equal(martinezHints.spec.label, 'Gastroenterology');
    const r1 = await NPI.resolveNpiRecords({ doctorName: 'Jose Martinez', zip: '33176' });
    const a1 = await NPI.applyDoctorHints(r1, { doctorName: 'Jose Martinez', zip: '33176', hints: martinezHints });
    assert.equal(a1.ask[0].npi, '1508853490', 'the gastroenterologist with her name comes first');
    assert.ok(!a1.ask.some((c) => c.npi === '1376734962'), 'a different first name far away is not offered');
    for (const c of a1.ask.filter((x) => /Surgery|Cardiology/.test(x.specialty))) assert.equal(c.hintMismatch, 'Gastroenterology');
    const sirvenHints = SH.doctorHints({ doctorName: 'Robert Sirven', specialty: 'Allergist', address: '8200 SW 117th Avenue, Ste #110, Miami, FL 33183', hintZip: '33183' });
    const r2 = await NPI.resolveNpiRecords({ doctorName: 'Robert Sirven', zip: '33183' });
    const a2 = await NPI.applyDoctorHints(r2, { doctorName: 'Robert Sirven', zip: '33183', hints: sirvenHints });
    assert.ok(a2.ask, 'Roberto Sirven (Family NP) is never matched silently for an Allergist');
    assert.equal(a2.ask[0].npi, '1538122247');
    assert.equal(a2.ask[0].otherFirstName, true);
    const roberto = a2.ask.find((c) => c.npi === '1902235476');
    assert.equal(roberto && roberto.hintMismatch, 'Allergy & Immunology');
    // A specialty that fits one person with her name: that one, no question.
    const pcp = await NPI.applyDoctorHints(r1, { doctorName: 'Jose Martinez', zip: '33186', hints: SH.doctorHints({ doctorName: 'Jose Martinez (Cardiology)' }) });
    assert.equal(pcp.ask, null);
    assert.equal(pcp.picked, true);
    assert.equal(pcp.records[0].number, '1912931312');
    // No hint: unchanged.
    const none = await NPI.applyDoctorHints(r1, { doctorName: 'Jose Martinez', zip: '33176', hints: null });
    assert.equal(none.records, r1);
  } finally {
    restore();
  }
});

test('(B) hints come from the doctor tag, explicit fields, or her paste / PDF text in the thread; the question says it', () => {
  const meta = SH.threadDoctorMeta([{ role: 'user', content: 'Jose Ejemplo Ruiz\nDoctors:\nDr. Robert Sirven (Allergist), Sirven & Associates, 8200 SW 117th Avenue, Ste #110, Miami, FL 33183\nDr. Jose Martinez (Gastroenterologist; supervising doctor), 11440 N. Kendall Dr., Ste #306, Miami, FL 33176\nMeds: Famotidine 40 mg' }]);
  const h = SH.doctorHints({ doctorName: 'Robert Sirven' }, meta);
  assert.equal(h.spec.label, 'Allergy & Immunology');
  assert.match(h.address, /^8200 SW 117th Avenue/);
  assert.equal(SH.doctorHints({ doctorName: 'Dr. Jose Martinez' }, meta).spec.label, 'Gastroenterology');
  assert.equal(SH.doctorHints({ doctorName: 'Massiel Ruiz' }, meta), null);
  // An NP/PA filed as "Physician Assistant" is not a mismatch for "(Gastroenterologist; PA)".
  const pa = { basic: { credential: 'PA-C' }, taxonomies: [{ desc: 'Physician Assistant', primary: true }] };
  assert.equal(SH.specialtyFits(pa, SH.readSpecialty('Gastroenterologist; PA'), { hintText: 'Gastroenterologist; PA' }), null);
  assert.equal(SH.streetKey('11440 N. Kendall Dr., Ste #306'), SH.streetKey('11440 N KENDALL DR STE 306'));
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, 'doctorPlanNarrow.js'), 'utf8');
  assert.match(src, /if \(d\.hint && \(d\.suggestions \|\| \[\]\)\.some\(\(x\) => x && \(x\.hintFit \|\| x\.hintMismatch\)\)\)/);
  assert.match(fs.readFileSync(require('path').join(__dirname, 'compareJobs.js'), 'utf8'), /specialty: d\.specialty, address: d\.address, hintZip: d\.zip/);
});
