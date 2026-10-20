// Doctor handling, Yahoska 2026-10-20:
// - Jorge Rivero: "Dr. Alejandro Lopez Rossitch, Robert Sirven, Jose Martinez, Ricardo Espinosa, Pavel Gazdovich, meds: …"
//   kept only the first doctor (the six meds after "meds:" outvoted the five names). Reloading recovers them.
// - Evelyn Nieves: "Priscilla Escalona = … NPI 1174811400" (two L's) never bound to "Priscila Escalona"; a resolved doctor
//   went back to the raw name on the next re-run; an empty "Notes:" header sat over "Question: …".
// - Ricardo Espinosa: a PA (NPI 1346449220) and a dentist (NPI 1083825665) share the name; Max silently took the PA.
// Golden flows: services/golden/scenarios/jorge-rivero-*.json, evelyn-nieves-*.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCompareAsk } = require('./compareJobs');
const LW = require('./loadedWorkup');
const N = require('./doctorPlanNarrow');
const { withRecoveredDoctors } = require('./workups');
const { sameNameCandidates } = require('./npiRegistry');
const W = require('../artifacts/client-workups.js');

const JORGE = 'Jorge Rivero, 33156, Dr. Alejandro Lopez Rossitch, Robert Sirven, Jose Martinez, Ricardo Espinosa, Pavel Gazdovich, meds: atorvastatin, dexlansoprazole, famotdidine, hydrochlorothiazide, ketoconazole, montelukast. Current plan is UHC Preferred Medicare Advantage FL-0001 (HMO) (H1045-1-0)';
const FIVE = ['Alejandro Lopez Rossitch', 'Robert Sirven', 'Jose Martinez', 'Ricardo Espinosa', 'Pavel Gazdovich'];

test('Jorge Rivero: all 5 doctors, whatever the "Dr." / label style; meds, ZIP, client and current plan unchanged', () => {
  const variants = {
    exact: JORGE,
    'no Dr.': JORGE.replace('Dr. ', ''),
    'Dr. on each': JORGE.replace(/(Robert|Jose|Ricardo|Pavel) /g, 'Dr. $1 '),
    'doctors: label': JORGE.replace('Dr. Alejandro', 'doctors: Dr. Alejandro'),
    'Doctors: label, no Dr.': JORGE.replace('Dr. Alejandro', 'Doctors: Alejandro'),
    'meds with no colon': JORGE.replace('meds:', 'meds'),
    'Medications:': JORGE.replace('meds:', 'Medications:'),
    'one per line': JORGE.replace(/, (?=Dr|Robert|Jose|Ricardo|Pavel)/g, '\n').replace(', meds:', '\nmeds:'),
  };
  for (const [what, text] of Object.entries(variants)) {
    const f = parseCompareAsk(text);
    assert.deepEqual(f.doctors.map((d) => d.name), FIVE, what);
    assert.equal(f.meds.length, 6, what);
    assert.equal(f.zip, '33156', what);
    assert.equal(f.clientName, 'Jorge Rivero', what);
    assert.deepEqual(f.plans, ['H1045-001'], what);
  }
});

test('reloading a workup whose saved doctors lost names re-reads them from the original request (unchecked)', () => {
  const w = { originalQuery: JORGE, doctors: [{ name: 'Alejandro Lopez-Rossitch', npi: '1528282167', byPlanId: { 'H1045-001': 'in' } }], history: [] };
  const r = withRecoveredDoctors(w);
  assert.deepEqual(r.doctors.map((d) => d.name), ['Alejandro Lopez-Rossitch', ...FIVE.slice(1)]);
  assert.deepEqual(r.recoveredDoctors, FIVE.slice(1));
  assert.deepEqual(r.doctors[1].byPlanId, {});
  assert.match(W.recoveredDoctorsNote(r), /^Added back Robert Sirven, Jose Martinez, Ricardo Espinosa, Pavel Gazdovich from the original request.*run all 5\.$/);
  // A doctor she removed (on an earlier saved version, gone now) stays removed.
  assert.deepEqual(withRecoveredDoctors({ ...w, history: [{ doctors: [{ name: 'Jose Martinez' }] }] }).recoveredDoctors, ['Robert Sirven', 'Ricardo Espinosa', 'Pavel Gazdovich']);
  // Nothing lost → unchanged object; a resolved doctor is the same doctor as the raw name.
  const full = { originalQuery: 'Evelyn Nieves, 33156, Dr. Priscila Escalona, Dr. Alejandro Lopez Rossitch, meds: metformin', doctors: [{ name: 'Priscilla Gabriela Escalona Villasmil', npi: '1174811400' }, { name: 'Alejandro Lopez Rossitch' }] };
  assert.equal(withRecoveredDoctors(full), full);
  assert.equal(W.recoveredDoctorsNote(full), '');
});

test('fuzzy same doctor: spelling, accents, Dr./MD, missing middle names — not a different first or last name', () => {
  const yes = [['Priscila Escalona', 'Priscilla Escalona'], ['Priscila Escalona', 'Dr. Priscilla Escalona, MD'], ['Priscilla Gabriela Escalona Villasmil', 'Priscilla Escalona'], ['José Martínez', 'Jose Martinez']];
  const no = [['Priscila Escalona', 'Karina Escalona'], ['Jose Martinez', 'Jorge Martinez'], ['Priscila Escalona', 'Priscila Gonzalez']];
  for (const [a, b] of yes) assert.ok(LW.fuzzySameDoctor(a, b), `${a} ≈ ${b}`);
  for (const [a, b] of no) assert.ok(!LW.fuzzySameDoctor(a, b), `${a} ≠ ${b}`);
});

const ESCALONA_Q = 'No exact match for:\n• "Priscila Escalona" — closest: Priscilla Gabriela Escalona Villasmil, MD (Internal Medicine, Endocrinology, Diabetes & Metabolism, Miami, NPI 1174811400); Karina Escalona Gonzalez, MD (Family Medicine, Miami, NPI 1255073672)\nReply "Priscila Escalona = Dr. Full Name".';
const ESPINOSA_Q = 'No exact match for:\n• "Ricardo Espinosa" — more than one provider with this name: Ricardo Espinosa, PA (Physician Assistant, Virginia Gardens, NPI 1346449220); Ricardo J. Espinosa, DMD (Dentist, Hialeah Gardens, NPI 1083825665)\nReply "Ricardo Espinosa = Dr. Full Name".';

test('candidate picks: two-L name, NPI, pasted candidate line, "the first one" / "1" / "2", "the dentist", a tie picks nothing', () => {
  const pick = (q, a) => N.candidatePicks(q, a).map((p) => `${p.asked}>${p.name}>${p.npi}`);
  const PRIS = ['Priscila Escalona>Priscilla Gabriela Escalona Villasmil>1174811400'];
  assert.deepEqual(pick(ESCALONA_Q, 'Priscilla Escalona = Priscilla Gabriela Escalona Villasmil, MD (Internal Medicine, Endocrinology, Diabetes & Metabolism, Miami, NPI 1174811400)'), PRIS);
  assert.deepEqual(pick(ESCALONA_Q, 'Priscila Escalona =Priscilla Gabriela Escalona Villasmil, MD'), PRIS);
  assert.deepEqual(pick(ESCALONA_Q, 'Priscilla Gabriela Escalona Villasmil, MD (Internal Medicine, Miami, NPI 1174811400)'), PRIS);
  assert.deepEqual(pick(ESCALONA_Q, 'the first one'), PRIS);
  assert.deepEqual(pick(ESCALONA_Q, '1'), PRIS);
  assert.deepEqual(pick(ESCALONA_Q, '2'), ['Priscila Escalona>Karina Escalona Gonzalez>1255073672']);
  const DMD = ['Ricardo Espinosa>Ricardo J. Espinosa>1083825665'];
  assert.deepEqual(pick(ESPINOSA_Q, 'the dentist'), DMD);
  assert.deepEqual(pick(ESPINOSA_Q, "he's a dentist"), DMD);
  assert.deepEqual(pick(ESPINOSA_Q, 'Ricardo J Espinosa'), DMD);
  assert.deepEqual(pick(ESPINOSA_Q, '1083825665'), DMD);
  assert.deepEqual(pick(ESPINOSA_Q, 'the PA'), ['Ricardo Espinosa>Ricardo Espinosa>1346449220']);
  // Retyping the shared name answers nothing: both candidates fit.
  assert.deepEqual(pick(ESPINOSA_Q, 'Ricardo Espinosa'), []);
  // A bare number with several doctors asked is ambiguous.
  assert.deepEqual(pick(`${ESCALONA_Q}\n• "Ricardo Espinosa" — closest: Ricardo J. Espinosa, DMD (Dentist, Hialeah Gardens, NPI 1083825665)`, '1'), []);
});

test('"X = Y" corrections: credential, "(specialty, city, NPI …)" and Dr. are not the name; the NPI is kept; plans / doses are not doctors', () => {
  assert.deepEqual(N.doctorEqualsCorrections('Priscilla Escalona = Priscilla Gabriela Escalona Villasmil, MD (Internal Medicine, Endocrinology, Diabetes & Metabolism, Miami, NPI 1174811400)'),
    [{ said: 'Priscilla Escalona', name: 'Priscilla Gabriela Escalona Villasmil', npi: '1174811400' }]);
  assert.deepEqual(N.doctorEqualsCorrections('Pinecrest Dentisry is Dr. Salome Fraga'), [{ said: 'Pinecrest Dentisry', name: 'Salome Fraga', npi: '' }]);
  assert.deepEqual(N.doctorEqualsCorrections('Levothyroxine Sodium is 0.2 mg'), []);
  assert.deepEqual(N.doctorEqualsCorrections('current plan = H5420-014'), []);
});

test('a doctor resolved earlier in the thread stays resolved on every later re-run', () => {
  const msgs = [
    { role: 'user', content: 'check the doctors' },
    { role: 'assistant', content: ESCALONA_Q },
    { role: 'user', content: 'Priscila Escalona =Priscilla Gabriela Escalona Villasmil, MD' },
    { role: 'assistant', content: 'table' },
    { role: 'user', content: 'remove careplus and add Doctors DrMax-Dade' },
  ];
  const res = N.threadDoctorResolutions(msgs, 4);
  const out = N.applyDoctorResolutions(['Alejandro Lopez Rossitch', 'Priscila Escalona'], res, {});
  assert.deepEqual(out.doctors, ['Alejandro Lopez Rossitch', 'Priscilla Gabriela Escalona Villasmil']);
  assert.deepEqual(out.npis, { 'Priscilla Gabriela Escalona Villasmil': '1174811400' });
});

test('an empty "Notes:" header over "Question: …" is dropped; one with notes under it stays', () => {
  assert.equal(N.dropDanglingListLines('table\n\n**Notes:**\n\nQuestion: Which doctor?'), 'table\n\n\nQuestion: Which doctor?');
  assert.equal(N.dropDanglingListLines('Notes:\n- CarePlus: not confirmed\nQuestion: x?'), 'Notes:\n- CarePlus: not confirmed\nQuestion: x?');
  assert.equal(N.dropDanglingListLines('table\nNotes:'), 'table');
});

// NPI registry records (NPPES, 2026-10-20), trimmed to what the reader uses.
const rec = (number, first, middle, last, credential, taxonomy, city, zip) => ({
  number, enumeration_type: 'NPI-1', basic: { first_name: first, middle_name: middle, last_name: last, credential },
  taxonomies: [{ desc: taxonomy, primary: true, code: /Dentist/.test(taxonomy) ? '122300000X' : '363A00000X' }],
  addresses: [{ address_purpose: 'LOCATION', city, postal_code: `${zip}0000`, state: 'FL' }],
});
const ESPINOSA_PA = rec('1346449220', 'RICARDO', '', 'ESPINOSA', 'P.A.', 'Physician Assistant', 'VIRGINIA GARDENS', '33166');
const ESPINOSA_DMD = rec('1083825665', 'RICARDO', 'J.', 'ESPINOSA', 'D.M.D.', 'Dentist', 'HIALEAH GARDENS', '33016');

test('same-name people near the ZIP are candidates (specialty, city, NPI) — never a silent pick; one person / a dental hint picks as before', () => {
  const c = sameNameCandidates([ESPINOSA_PA, ESPINOSA_DMD], 'Ricardo Espinosa', '33156');
  assert.deepEqual(c.map((x) => `${x.name} | ${x.specialty} | ${x.city} | ${x.npi}`), [
    'Ricardo Espinosa, PA | Physician Assistant | Virginia Gardens | 1346449220',
    'Ricardo J. Espinosa, DMD | Dentist | Hialeah Gardens | 1083825665',
  ]);
  assert.ok(c.every((x) => x.sameName));
  assert.deepEqual(sameNameCandidates([ESPINOSA_PA, ESPINOSA_DMD], 'Ricardo Espinosa DMD', '33156'), []);
  assert.deepEqual(sameNameCandidates([rec('1902235476', 'ROBERTO', '', 'SIRVEN', 'ARNP', 'Nurse Practitioner, Family', 'MIAMI', '33183')], 'Robert Sirven', '33156'), []);
  // Far away (Jacksonville) is not plausible for a 33156 client.
  assert.deepEqual(sameNameCandidates([ESPINOSA_PA, rec('1467511006', 'RICARDO', '', 'ESPINOSA', 'DMD', 'Dentist, General Practice', 'JACKSONVILLE', '32216')], 'Ricardo Espinosa', '33156'), []);
  // The question names every candidate.
  const q = N.renderedAnswer([{ requestedName: 'Ricardo Espinosa', doctorName: 'Ricardo Espinosa', status: 'not_found', suggestions: c, networks: [] }], 'Ricardo Espinosa, ZIP 33156. Compare H1045-001, H0982-022');
  assert.match(q, /"Ricardo Espinosa" — more than one provider with this name: Ricardo Espinosa, PA \(Physician Assistant, Virginia Gardens, NPI 1346449220\); Ricardo J\. Espinosa, DMD \(Dentist, Hialeah Gardens, NPI 1083825665\)/);
});

test('the compare card\'s question is part of the conversation the chat server reads', () => {
  const result = { planIds: ['H5420-014', 'H1036-054C', 'H1019-006'], questions: [ESCALONA_Q] };
  const out = W.messagesForApi([
    { role: 'queueResult', result },
    { role: 'user', content: 'Priscilla Escalona = Priscilla Gabriela Escalona Villasmil, MD' },
  ], null);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'assistant');
  assert.match(out[0].content, /^Comparison results \(H5420-014, H1036-054C, H1019-006\)\nNo exact match for:/);
  // A card that asked nothing adds no turn.
  assert.equal(W.messagesForApi([{ role: 'queueResult', result: { planIds: ['H5420-014'], questions: [] } }, { role: 'user', content: 'hi' }], null).length, 1);
});
