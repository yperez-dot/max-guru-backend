// Golden: a live loaded workup, 2026-10-21 3:41–3:48 PM ET (client name replaced; the doctors, addresses and
// meds are her paste as the card showed it — reconstructed from the live screenshot, one "Name (Specialty), Practice,
// Street, City ZIP" line per doctor).
// Bugs: (1) every comma piece became a doctor chip ("Baptist Primary", "SW 96th St Ste 200", "Miami 33196"), the 15-doctor
// cap filled with them and the last 5 doctors were dropped; (2) the paste's one plan replaced her 4 saved plans;
// (3) "Please remove Doctors DrMax-Dade · H4140-022" never dropped the column; (4) the next turn rebuilt from stale saved
// rows (Yanette Barcelo PA, Ricardo Espinosa P.A., Ketoconazole, Levothyroxine Sodium came back); (5) Clobetasol cream /
// solution read "not a drug name RxNorm knows"; (6) the original request's ZIP (33156) instead of her latest (33196).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./compareJobs');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const W = require('./workups');
const DE = require('./doctorEntries');
const CW = require('../artifacts/client-workups.js');
const { drugNameBase } = require('./drugNames');

const PASTE = [
  'Elena Sample, 33196',
  'Doctors:',
  'Kaitlin Ross (Primary Care), Baptist Primary, SW 96th St Ste 200, Miami 33196',
  'Paula Montana de la Cadena (Cardiology), S Dixie Hwy Ste 420, Pinecrest 33156',
  'Priscilla Escalona Villasmil (Endocrinology), SW 127th Ave, Miami 33186',
  'Raul Rosario-Concepcion (Neurology), SW 96th St Ste 406, Miami 33196',
  'Hector Wiltz (Dermatology), SW 40th St Ste 451, Miami 33175',
  'Pavel Gazdovich (Optometry), South Florida Vision Center, SW 26th St Ste 2408, Miami 33175',
  'Anne Kunkler (Retina), Retina Consultants of Miami, SW 37th Ave Ste 501, Miami 33133',
  'Emilio Rivero (Dentist), Rivero Dental, SW 42nd St Ste 206, Miami 33175',
  'Enrique Gallo (Orthodontist), Miami Center of Orthodontists',
  'Angel Rodriguez (Podiatry), W Flagler St Ste G1, Miami 33144',
  'Meds: Repatha 140 mg; Ezetimibe 10 mg; Losartan Potassium 25 mg; Synthroid 112 mg; Mounjaro injectable; Hydroxyzine 10 mg; Clobetasol 0.05% shampoo; Clobetasol 0.05% cream; Clobetasol 0.05% topical solution; Betamethasone 0.05%; Silver Sulfadiazine 1%; Tavaborole 5% solution',
  'Current plan: H5420-014',
].join('\n');
const DOCTORS = ['Kaitlin Ross (Primary Care)', 'Paula Montana de la Cadena (Cardiology)', 'Priscilla Escalona Villasmil (Endocrinology)', 'Raul Rosario-Concepcion (Neurology)',
  'Hector Wiltz (Dermatology)', 'Pavel Gazdovich (Optometry)', 'Anne Kunkler (Retina)', 'Emilio Rivero (Dentist)', 'Enrique Gallo (Orthodontist)', 'Angel Rodriguez (Podiatry)'];
const SAVED_PLANS = ['H5420-014', 'H1036-054C', 'H4140-022', 'H1036-121'];
const STALE = {
  clientName: 'Elena Sample', zip: '33156', currentPlanIds: ['H5420-014'],
  originalQuery: 'Elena Sample, 33156, Dr. Kaitlin Ross, Priscilla Escalona, Paula Montana De La Cadena, Yanette Barcelo PA, Ricardo Espinosa P.A.',
  plans: [{ planId: 'H5420-014', carrier: 'UHC', planName: 'UHC MedicareMax Complete Care FL-30' }, { planId: 'H1036-054C', carrier: 'Humana', planName: 'Humana Gold Plus' },
    { planId: 'H4140-022', carrier: 'Doctors', planName: 'Doctors DrMax-Dade' }, { planId: 'H1036-121', carrier: 'Humana', planName: 'Humana Gold Plus Diabetes & Heart' }],
  doctors: [{ name: 'Kaitlin Ross' }, { name: 'Yanette Barcelo PA' }, { name: 'Ricardo Espinosa P.A.' }, { name: 'Angel Rodriguez' }],
  medications: [{ name: 'Ketoconazole' }, { name: 'Levothyroxine Sodium' }, { name: 'Repatha 140 mg' }],
};

test('her paste: 10 doctors (addresses, practices and ZIPs are their metadata), 12 meds, nothing dropped', () => {
  const f = C.parseCompareAsk(PASTE);
  assert.equal(f.clientName, 'Elena Sample');
  assert.equal(f.zip, '33196');
  assert.deepEqual(f.doctors.map((d) => d.name), DOCTORS);
  assert.deepEqual(f.overLimitDoctors, []);
  assert.equal(f.doctorCount, 10);
  const ross = f.doctors[0];
  assert.deepEqual([ross.practice, ross.address, ross.zip], ['Baptist Primary', 'SW 96th St Ste 200, Miami 33196', '33196']);
  assert.equal(f.doctors[5].practice, 'South Florida Vision Center');
  assert.equal(f.doctors[8].practice, 'Miami Center of Orthodontists');
  assert.equal(f.meds.length, 12);
  assert.ok(!f.meds.includes('Current'), '"Current plan:" after the meds is not a med');
  assert.deepEqual(f.plans, ['H5420-014']);
  assert.deepEqual(f.currentPlans, ['H5420-014']);
  // The same list typed on one line (commas only) reads the same 10 doctors.
  const one = PASTE.replace(/\nDoctors:\n([\s\S]*?)\nMeds:/, (m, list) => '\nDoctors: ' + list.split('\n').join(', ') + '\nMeds:');
  assert.deepEqual(C.parseCompareAsk(one).doctors.map((d) => d.name), DOCTORS);
  // …and with no "Doctors:" label.
  assert.deepEqual(C.parseCompareAsk(PASTE.replace('Doctors:\n', '')).doctors.map((d) => d.name), DOCTORS);
});

test('metadata reader: streets, suites, city + ZIP, phones, practices are never doctors; people are', () => {
  for (const x of ['SW 96th St Ste 200', 'S Dixie Hwy Ste 420', 'W Flagler St Ste G1', '8785 SW 165th Avenue', 'Miami 33196', 'Pinecrest, FL 33156', 'FL 33175', '305-227-9233 / 305-245-1332', 'Baptist Primary', 'Rivero Dental', 'Retina Consultants of Miami']) {
    assert.ok(DE.isDoctorMetadata(x), x);
  }
  for (const x of ['Marcus St John', 'Kaitlin Ross (Primary Care)', 'Paula Montana de la Cadena', 'Dr. Angel Rodriguez']) assert.ok(!DE.isDoctorMetadata(x), x);
  assert.deepEqual(C.parseCompareAsk('New client: Victor Rocha, ZIP 33143.\nDoctors: Carlos Santa-Cruz, MD (Urology, Coral Gables); Marcus St John NPI 1073510269\nMeds: tadalafil 2.5mg').doctors.map((d) => d.name), ['Carlos Santa-Cruz', 'Marcus St John']);
  // More doctors than one run checks: listed back, never dropped silently.
  const many = 'Ana Ruiz, 33196\nDoctors: ' + Array.from({ length: 32 }, (_, i) => `Doc${String.fromCharCode(65 + (i % 26))}${i} Person${i}`).join(', ') + '\nMeds: metformin';
  const g = C.parseCompareAsk(many);
  assert.equal(g.doctors.length + g.overLimitDoctors.length, 32);
  assert.equal(g.doctorCount, 32);
});

test('her paste on the saved client keeps the 4 saved plans (current first) unless she says otherwise', () => {
  assert.deepEqual(CW.pastePlanSet(['H5420-014'], ['H5420-014'], STALE, PASTE), SAVED_PLANS);
  assert.deepEqual(CW.pastePlanSet(['H5420-014'], [], STALE, PASTE + '\ncompare only H5420-014'), ['H5420-014']);
  assert.deepEqual(CW.pastePlanSet([], [], STALE, PASTE.replace('Current plan: H5420-014', 'remove H4140-022')), ['H5420-014', 'H1036-054C', 'H1036-121']);
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /fields\.plans = CWk\.pastePlanSet\(f\.plans \|\| \[\], f\.currentPlans \|\| \[\], workup, rawText\)\.join\(", "\);/);
});

const thread = (workup, extra = []) => [{ role: 'user', content: CW.compactWorkupContext(workup) }, ...extra];
const TABLE = '| Doctor | UHC MedicareMax Complete Care FL-30 · H5420-014 | Humana Gold Plus · H1036-054C | Doctors DrMax-Dade · H4140-022 | Humana Gold Plus Diabetes & Heart · H1036-121 |\n|---|---|---|---|---|\n| Kaitlin Ross | ✅ In | ✅ In | ✅ In | ✅ In |';
const REMOVE = 'Please remove Doctors DrMax-Dade · H4140-022 from her comparison';
const ANGEL = 'Angel Rodriguez =Angel A Rodriguez, DPM (Podiatry, Miami, NPI 1679898589)';
const docRow = (name) => ({ doctorName: name, requestedName: name, status: 'done', networks: [], inNetworkPlans: ['UHC MedicareMax Complete Care FL-30 (H5420-014)', 'Humana Gold Plus (H1036-054C)', 'Doctors DrMax-Dade (H4140-022)', 'Humana Gold Plus Diabetes & Heart (H1036-121)'] });

test('"Please remove Doctors DrMax-Dade · H4140-022": the server re-runs now without it, and it stays gone after the Angel Rodriguez confirm', () => {
  const now = { ...STALE, zip: '33196', doctors: DOCTORS.map((n) => ({ name: n.replace(/\s*\(.*$/, '') })), medications: [{ name: 'Repatha 140 mg' }] };
  const m1 = thread(now, [{ role: 'assistant', content: TABLE }, { role: 'user', content: REMOVE }]);
  const fu = N.comparisonFollowUp(m1);
  assert.ok(fu, 'the removal re-runs on the server (left to the model it said "three-plan comparison" and kept the column)');
  assert.equal(fu.doctors.length, 10);
  const cols = (msgs) => N.selectComparison([docRow('Kaitlin Ross')], N.comparisonAskText(msgs), {}).columns.map((c) => c.planId);
  assert.deepEqual(cols(m1), ['H5420-014', 'H1036-054C', 'H1036-121']);
  assert.deepEqual(LW.resolveWorkupSets(m1).plans.map((p) => p.planId), ['H5420-014', 'H1036-054C', 'H1036-121']);
  const m2 = [...m1, { role: 'assistant', content: 'Here is the three-plan comparison.\n' + TABLE.replace(/ \| Doctors DrMax-Dade · H4140-022/, '').replace(/\| ✅ In \| ✅ In \| ✅ In \| ✅ In \|/, '| ✅ In | ✅ In | ✅ In |') }, { role: 'user', content: ANGEL }];
  const fu2 = N.comparisonFollowUp(m2);
  assert.ok(fu2.doctors.includes('Angel A Rodriguez'));
  assert.equal(fu2.npis['Angel A Rodriguez'], '1679898589');
  assert.equal(fu2.doctors.length, 10);
  assert.deepEqual(cols(m2), ['H5420-014', 'H1036-054C', 'H1036-121']);
  // Same with her paste in the thread (the labeled-list path).
  const m3 = thread(STALE, [{ role: 'user', content: PASTE }, { role: 'assistant', content: TABLE }, { role: 'user', content: REMOVE }]);
  assert.match(N.comparisonFollowUp(LW.withCurrentLists(m3)).reason, /plan removed: H4140-022/);
});

test('a new full list replaces the saved doctors and meds — for this turn and every later one', () => {
  const msgs = LW.withCurrentLists(thread(STALE, [{ role: 'user', content: PASTE }, { role: 'assistant', content: TABLE }, { role: 'user', content: REMOVE }]));
  const ctx = msgs[0].content;
  assert.doesNotMatch(ctx, /Yanette Barcelo|Ricardo Espinosa|Ketoconazole|Levothyroxine/);
  assert.match(ctx, /^Doctors \(names only[^:]*: Kaitlin Ross; Paula Montana de la Cadena; .*; Angel Rodriguez$/m);
  assert.equal(LW.workupFacts(msgs).doctors.length, 10);
  const meds = require('./comparisonRules').medsFromAsk(N.comparisonAskText(msgs));
  assert.equal(meds.length, 12);
  assert.ok(!meds.some((m) => /ketoconazole|levothyroxine/i.test(m)));
  const fu = N.comparisonFollowUp(msgs);
  assert.ok(!fu.doctors.some((d) => /Barcelo|Espinosa/.test(d)));
  // Without a full list the saved lists stay (a correction turn never wipes them).
  const kept = LW.withCurrentLists(thread(STALE, [{ role: 'user', content: ANGEL }]));
  assert.match(kept[0].content, /Yanette Barcelo PA/);
  const grok = fs.readFileSync(path.join(__dirname, 'grok.js'), 'utf8');
  assert.match(grok, /messages = require\('\.\/loadedWorkup'\)\.withCurrentLists\(messages\);\n  let apiMessages = normalizeMessages/);
});

test('saving: the new list replaces the saved one, a reload recovers from it (not the old request), ZIP is her latest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-meta-'));
  try {
    const store = new W.WorkupStore({ filePath: path.join(dir, 'w.json') });
    const owner = 'agent@example.com';
    const a = await store.upsert(owner, { ...STALE, plans: STALE.plans });
    const f = C.parseCompareAsk(PASTE);
    const b = await store.upsert(owner, {
      id: a.id, clientName: 'Elena Sample', zip: '33196', plans: STALE.plans,
      doctors: f.doctors.map((d) => ({ name: d.name.replace(/\s*\(.*$/, ''), practice: d.practice, address: d.address })),
      medications: f.meds.map((name) => ({ name })),
      replaceDoctors: true, replaceMedications: true, latestQuery: PASTE, pharmacy: 'Walmart Neighborhood Pharmacy, 14720 SW 26th Street, Miami, FL 33185',
    });
    assert.equal(b.doctors.length, 10);
    assert.ok(!b.doctors.some((d) => /Barcelo|Espinosa/.test(d.name)));
    assert.equal(b.doctors[0].address, 'SW 96th St Ste 200, Miami 33196');
    assert.equal(b.medications.length, 12);
    assert.ok(!b.medications.some((m) => /Ketoconazole|Levothyroxine/.test(m.name)));
    assert.equal(b.zip, '33196');
    assert.equal(b.pharmacy, 'Walmart Neighborhood Pharmacy, 14720 SW 26th Street, Miami, FL 33185');
    assert.equal(b.originalQuery, STALE.originalQuery, 'the original request is kept as history');
    const loaded = W.withRecoveredDoctors(b);
    assert.ok(!loaded.doctors.some((d) => /Barcelo|Espinosa/.test(d.name)), 'a reload never brings back doctors from the request it replaced');
    assert.equal(CW.workupZipLine(b), 'ZIP 33196 (Miami-Dade) — latest; the original request said 33156');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(CW.newestClientZip([{ role: 'user', content: 'Elena Sample, 33156, Dr. Kaitlin Ross' }, { role: 'user', content: PASTE }, { role: 'assistant', content: 'Paula Montana · Pinecrest 33156' }, { role: 'user', content: REMOVE }]), '33196');
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /built\.zip = window\.MaxClientWorkups\.newestClientZip\(messagesRef\.current, userMessageText\) \|\| prev\.zip/);
  assert.match(html, /if \(linesOf\(ws\.fields\.meds\)\.length && body\.medications && body\.medications\.length\) body\.replaceMedications = true;/);
  assert.match(html, /data-testid="workup-zip-line"/);
});

test('Clobetasol 0.05% cream / solution: strength and form are stripped for the RxNorm check, kept as the label', () => {
  for (const x of ['Clobetasol 0.05% shampoo', 'Clobetasol 0.05% cream', 'Clobetasol 0.05% topical solution', 'Clobetasol 0.05% solution', 'Clobetasol Cream 0.05%']) assert.equal(drugNameBase(x), 'clobetasol', x);
  assert.equal(drugNameBase('Tavaborole 5% solution'), 'tavaborole');
  assert.equal(drugNameBase('Silver Sulfadiazine 1%'), 'silver sulfadiazine');
  assert.equal(drugNameBase('Betamethasone 0.05%'), 'betamethasone');
  const f = C.parseCompareAsk(PASTE);
  assert.ok(f.meds.includes('Clobetasol 0.05% cream') && f.meds.includes('Clobetasol 0.05% topical solution'), 'the form stays on the med row');
});
