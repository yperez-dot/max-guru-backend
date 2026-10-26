// Golden: Martha Muraglia (live, 2026-10-20, main dc1fcd3f). Her exact original request named 8 doctors — most typed in
// lowercase or odd case ("Dr. WADDAH aLLAF", "Dr. Mario del cid", "dr. laura martin") — and only 2 survived the
// capitalized-name check. Then: "add Dr. Waddah Allaf", "Add Dr. Mario del Cid, …" (5 more), two "X = Y (NPI …)"
// corrections in one comma-separated message. The table after the corrections showed 4 of 8 doctors, the Excel title read
// "Add Dr", the corrections were not in the export, the headers said "HumanaChoice", the workup said 33323 was
// Miami-Dade, and her current plan H5216-311 (not on the THEI grid) vanished from chat and export.
process.env.MAX_COMPARE_MEDS_BUDGET_MS = '300';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./compareJobs');
const N = require('./doctorPlanNarrow');
const W = require('./workups');
const CW = require('../artifacts/client-workups.js');
const E = require('../artifacts/comparison-export.js');
const PN = require('../artifacts/plan-name.js');
const DN = require('../artifacts/doctor-name.js');

const ORIGINAL = 'Martha Muraglia, 33323, Dr. Olivera Stojadinovic, Dr. WADDAH aLLAF, Dr. Selmo Satanosky, Dr. Mario del cid, Dr. darrel gachette, dr. laura martin, dr. nisharajmed kherada, dr. simone vanhorn. Meds: spironolactone, liothyronine, gabapentin, furosemide, amlodipine. Current plan is Humana Full Access Giveback H5216-311 (PPO). Compare with Humana Choice H7617-107\n and Humana Choice Giveback H7617-110';
const EIGHT = ['Olivera Stojadinovic', 'Waddah Allaf', 'Selmo Satanosky', 'Mario del Cid', 'Darrel Gachette', 'Laura Martin', 'Nisharajmed Kherada', 'Simone Vanhorn'];
const MEDS = ['spironolactone', 'liothyronine', 'gabapentin', 'furosemide', 'amlodipine'];
// Public NPI registry (NPPES), 2026-10-20: WADDAH ALLAF, M.D., Internal Medicine / Pulmonary Disease, mailing address
// Plantation FL 33324 (next to 33323), practice North Miami Beach — NPI 1386607836.
const ALLAF_NPI = '1386607836';

const PLANS = [
  { planId: 'H5216-311', planName: 'Humana Full Access Giveback H5216-311 (PPO)', carrier: 'Humana' },
  { planId: 'H7617-107', planName: 'Humana Choice', carrier: 'Humana' },
  { planId: 'H7617-110', planName: 'Humana Choice Giveback', carrier: 'Humana' },
];
// The workup as it was saved live: 2 doctors, ZIP 33323 with the county guessed from a plan row.
const SAVED = { clientName: 'Martha Muraglia', zip: '33323', county: 'Miami-Dade', currentPlanIds: ['H5216-311'], plans: PLANS, doctors: [], medications: MEDS.map((name) => ({ name, byPlanId: {} })), originalQuery: ORIGINAL };

const ids3 = PLANS.map((p) => p.planId);
const label = { 'H5216-311': 'HumanaChoice Giveback (H5216-311)', 'H7617-107': 'HumanaChoice (H7617-107)', 'H7617-110': 'HumanaChoice Giveback (H7617-110)' };
const doc = (name, st, npi) => ({ doctorName: name, requestedName: name, npi, status: 'done', networks: [], inNetworkPlans: st === 'in' ? ids3.map((i) => label[i]) : [], outOfNetworkPlans: st === 'out' ? ids3.map((i) => label[i]) : [], carriersIn: st === 'in' ? ['Humana'] : [] });
const RESULTS = [doc('Olivera Stojadinovic', 'in', '1861841850'), doc('Selmo Satanosky', 'in', '1669452447'), doc('Waddah Allaf', 'in', ALLAF_NPI),
  doc('Mario del Cid', 'in', '1407037872'), doc('Darrel Gachette', 'in', '1780247908'), doc('Laura Martin', 'out', '1356381834'),
  doc('Nisharahmed Ishakbhai Kherada', 'in', '1235373143'), doc('Simone Van-Horne', 'out', '1225052103')];

function thread(workup) {
  const ctx = CW.compactWorkupContext(workup);
  const t3 = '| Doctor | Humana Choice · H7617-107 | Humana Choice Giveback · H7617-110 |\n|---|---|---|\n| Olivera Stojadinovic | ✅ In | ✅ In |\n| Selmo Satanosky | ✅ In | ✅ In |\n| Waddah Allaf | ✅ In | ✅ In |';
  const q = t3 + '\n\nNo exact match for: "Nisharajmed Kherada" — did you mean Nisharahmed Ishakbhai Kherada, MD (Internal Medicine, Plantation, NPI 1235373143)? · "Simone Vanhorn" — did you mean Simone Van-Horne, MD (Family Medicine, Sunrise, NPI 1225052103)?';
  return [
    { role: 'user', content: ctx },
    { role: 'user', content: 'add Dr. Waddah Allaf' },
    { role: 'assistant', content: t3 },
    { role: 'user', content: 'Add Dr. Mario del Cid, Dr. Darrel Gachette, Dr. Laura Martin, Dr. Nisharajmed Kherada, and Dr. Simone Vanhorn' },
    { role: 'assistant', content: q },
    { role: 'user', content: 'Nisharajmed Kherada = Nisharahmed Ishakbhai Kherada, MD (Internal Medicine, Plantation, NPI 1235373143) , Simone Vanhorn = Simone Van-Horne, MD (Family Medicine, Sunrise, NPI 1225052103)' },
  ];
}
const LIVE_WORKUP = { ...SAVED, doctors: [{ name: 'Olivera Stojadinovic', byPlanId: {} }, { name: 'Selmo Satanosky', byPlanId: {} }] };

test('her exact original request: all 8 doctors, in normal case, with the meds, plans and current plan', () => {
  const f = C.parseCompareAsk(ORIGINAL);
  assert.equal(f.clientName, 'Martha Muraglia');
  assert.equal(f.zip, '33323');
  assert.deepEqual(f.doctors.map((d) => d.name), EIGHT);
  assert.equal(f.doctorCount, 8);
  assert.deepEqual(f.unreadDoctors, []);
  assert.deepEqual(f.meds, MEDS);
  assert.deepEqual(f.plans, ['H5216-311', 'H7617-107', 'H7617-110']);
  assert.deepEqual(f.currentPlans, ['H5216-311']);
});

test('"Dr."/"dr." is the strong signal: ALL CAPS, all lower and inverted case all read as names, shown in normal case', () => {
  assert.deepEqual(C.titledDoctorNames('DR. WADDAH ALLAF, dr waddah allaf, Dr. wADDAH aLLAF, Doctora maria DE LA cruz'), ['Waddah Allaf', 'Maria de la Cruz']);
  assert.equal(DN.displayPersonName('WADDAH aLLAF'), 'Waddah Allaf');
  assert.equal(DN.displayPersonName('Alan DelPar'), 'Alan DelPar');
  assert.equal(DN.displayPersonName("JOHN O'NEIL"), "John O'Neil");
  // A normal-case name still ends at her own words.
  assert.deepEqual(C.titledDoctorNames('Dr. Jorge Perez for her heart, Dra.María López y Dr. Jorge G. Ruiz'), ['Jorge Perez', 'María López', 'Jorge G. Ruiz']);
});

test('unsure → asked, never dropped; a request doctor that could not be read is listed', () => {
  const f = C.parseCompareAsk('Ana Ruiz, 33156, Jorge Perez, Ana Gil, waddah allaf. meds: metformin');
  assert.deepEqual(f.doctors.map((d) => d.name), ['Jorge Perez', 'Ana Gil']);
  assert.deepEqual(f.unsureDoctors, ['waddah allaf']);
  const g = C.parseCompareAsk('Ana Ruiz, 33156, Dr. Jorge Perez, Dr. Lopez, Dr. Ana Gil. meds: metformin');
  assert.deepEqual(g.doctors.map((d) => d.name), ['Jorge Perez', 'Lopez', 'Ana Gil']);
  assert.deepEqual(g.unreadDoctors, []);
  assert.equal(g.doctorCount, 3);
  const w = W.withRecoveredDoctors({ originalQuery: 'Ana Ruiz, 33156, Dr. Jorge Perez, Dr. Lopez, waddah allaf, Dr. Ana Gil. meds: metformin', zip: '33156', doctors: [] });
  const note = CW.recoveredDoctorsNote(w);
  assert.deepEqual(w.doctors.map((d) => d.name), ['Jorge Perez', 'Lopez', 'Ana Gil']);
  assert.match(note, /Added back Jorge Perez, Lopez, Ana Gil from the original request/);
  assert.match(note, /Is "waddah allaf" a doctor\? \(yes \/ no\)/);
});

test('loading her workup: all 8 doctors come back, the count matches the request, the checks run (no "ask me")', () => {
  const w = W.withRecoveredDoctors(SAVED);
  assert.deepEqual(w.doctors.map((d) => d.name), EIGHT);
  assert.equal(w.county, 'Broward', '33323 is Broward (Plantation / Sunrise)');
  assert.equal(w.expectedDoctorCount, undefined, 'all 8 read');
  const note = CW.recoveredDoctorsNote(w);
  assert.match(note, /^Added back Olivera Stojadinovic, Waddah Allaf, .*Simone Vanhorn from the original request.*Checking all 8 doctors now\.$/);
  assert.doesNotMatch(note, /Ask me to check/);
  const run = CW.recoveredDoctorsRunAsk(w);
  assert.equal(run, 'Check all 8 doctors and the 5 meds on the saved plans.');
  const fu = N.comparisonFollowUp([{ role: 'user', content: CW.compactWorkupContext(w) }, { role: 'user', content: run }]);
  assert.equal(fu.doctors.length, 8);
  assert.match(CW.compactWorkupContext(w), /ZIP\/county: 33323 \/ Broward/);
  // The page sends that ask on load.
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /recoveredDoctorsRunAsk\(workup\)[\s\S]{0,800}send\(runAsk\)/);
});

test('the live sequence: add 1, add 5, two corrections in one message → every re-run has all 8, corrected, with NPIs', () => {
  const msgs = thread(LIVE_WORKUP);
  assert.deepEqual(N.comparisonFollowUp(msgs.slice(0, 2)).doctors, ['Olivera Stojadinovic', 'Selmo Satanosky', 'Waddah Allaf']);
  assert.deepEqual(N.comparisonFollowUp(msgs.slice(0, 4)).doctors, ['Olivera Stojadinovic', 'Selmo Satanosky', 'Waddah Allaf', 'Mario del Cid', 'Darrel Gachette', 'Laura Martin', 'Nisharajmed Kherada', 'Simone Vanhorn']);
  const fu = N.comparisonFollowUp(msgs);
  assert.deepEqual(fu.doctors, ['Olivera Stojadinovic', 'Selmo Satanosky', 'Waddah Allaf', 'Mario del Cid', 'Darrel Gachette', 'Laura Martin', 'Nisharahmed Ishakbhai Kherada', 'Simone Van-Horne']);
  assert.deepEqual(fu.npis, { 'Nisharahmed Ishakbhai Kherada': '1235373143', 'Simone Van-Horne': '1225052103' });
  assert.deepEqual(N.doctorEqualsCorrections(msgs[5].content).map((c) => [c.said, c.name, c.npi]), [
    ['Nisharajmed Kherada', 'Nisharahmed Ishakbhai Kherada', '1235373143'], ['Simone Vanhorn', 'Simone Van-Horne', '1225052103']]);
});

test('her current plan H5216-311 (not on the THEI grid) stays the first column — chat and fresh paste', () => {
  const msgs = thread(LIVE_WORKUP);
  const ask = N.comparisonAskText(msgs);
  const sel = N.selectComparison(RESULTS, ask, {});
  assert.deepEqual(sel.columns.map((c) => c.planId), ['H5216-311', 'H7617-107', 'H7617-110']);
  assert.equal(sel.columns[0].offGrid, true);
  assert.ok(sel.flags.some((f) => /Current plan H5216-311 isn't on the THEI grid: it stays the first column/.test(f)));
  assert.ok(!sel.flags.some((f) => /isn't in Max's plan data/.test(f)));
  // Fresh paste: the wrapped "\n and …" line and "Current plan is …" keep all three, current first, typed name.
  const fresh = N.selectComparison([], N.comparisonAskText([{ role: 'user', content: ORIGINAL }]));
  assert.deepEqual(fresh.columns.map((c) => [c.planId, c.name]), [['H5216-311', 'Humana Full Access Giveback'], ['H7617-107', 'Humana Choice'], ['H7617-110', 'Humana Choice Giveback']]);
});

test('after the corrections the chat table lists all 8 doctors, current plan first, "Humana Choice" with a space', () => {
  const msgs = thread(LIVE_WORKUP);
  const out = N.renderedAnswer(RESULTS, N.comparisonAskText(msgs), { drugs: [] });
  const rows = out.split('\n').filter((l) => /^\| (?!Doctor|---|\*\*)/.test(l) && /NPI/.test(l));
  assert.equal(rows.length, 8);
  assert.match(out, /\| Doctor \| Humana Choice Giveback · H5216-311 \| Humana Choice · H7617-107 \| Humana Choice Giveback · H7617-110 \|/);
  assert.doesNotMatch(out, /HumanaChoice/);
  assert.equal(PN.cleanPlanName('HumanaChoice Giveback H5216-311 (PPO)'), 'Humana Choice Giveback H5216-311 (PPO)');
});

test('Excel/PDF: client "Martha Muraglia" (never "Add Dr"), the same 8 resolved doctors and results as the chat table, current plan first with "Not on grid" benefits', () => {
  const msgs = thread(LIVE_WORKUP);
  const out = N.renderedAnswer(RESULTS, N.comparisonAskText(msgs), { drugs: [] });
  const hist = [...msgs, { role: 'assistant', content: out }];
  assert.equal(E.extractClientName('Add Dr. Mario del Cid, Dr. Darrel Gachette, Dr. Laura Martin, Dr. Nisharajmed Kherada, and Dr. Simone Vanhorn'), '');
  assert.equal(C.parseCompareAsk('Add Dr. Mario del Cid, Dr. Darrel Gachette, Dr. Laura Martin').clientName, '');
  // Earlier lookups (the raw names, no result) are in the session too: the table wins.
  const early = [{ doctorName: 'Nisharajmed Kherada', requestedName: 'Nisharajmed Kherada', status: 'no_match', networks: [] }, { doctorName: 'Simone Vanhorn', requestedName: 'Simone Vanhorn', status: 'no_match', networks: [] }];
  const tr = [...early, ...RESULTS].map((o) => ({ tool: 'lookup_provider_network', output: o }));
  const plans = [{ id: 'H5216-311', planId: 'H5216-311', carrier: 'Humana', planName: 'Humana Full Access Giveback', offGrid: true },
    { id: 'H7617-107', planId: 'H7617-107', carrier: 'Humana', planName: 'Humana Choice', county: 'Broward', premium: '$0' },
    { id: 'H7617-110', planId: 'H7617-110', carrier: 'Humana', planName: 'Humana Choice Giveback', county: 'Broward', premium: '$0' }];
  const p = E.buildExportPayload(plans, E.conversationPlainText(hist), {
    planSetFixed: true, chatTable: E.latestChatTable(hist), toolResults: tr, clientName: 'Martha Muraglia', currentPlanIds: ['H5216-311'],
    userMessages: hist.filter((m) => m.role === 'user').map((m) => m.content), latestUserText: msgs[5].content,
  });
  const model = E.buildComparisonModel({ ...p, keepPlanOrder: true });
  assert.equal(model.aoa[0][0], 'Martha Muraglia');
  assert.deepEqual(model.aoa[1].slice(1), ['Humana Full Access Giveback\nH5216-311', 'Humana Choice\nH7617-107', 'Humana Choice Giveback\nH7617-110']);
  const row = (re) => model.aoa.find((r) => re.test(String(r[0])));
  assert.deepEqual(row(/Kherada/).slice(1), ['In network', 'In network', 'In network']);
  assert.match(row(/Kherada/)[0], /Nisharahmed Ishakbhai Kherada · NPI 1235373143/);
  assert.deepEqual(row(/Van-?Horne?/).slice(1), ['Not in network (not listed)', 'Not in network (not listed)', 'Not in network (not listed)']);
  assert.match(row(/Van-?Horne?/)[0], /Simone Van-Horne · NPI 1225052103/);
  assert.ok(!model.aoa.some((r) => /^Dr\. Simone Vanhorn$|Nisharajmed/.test(String(r[0]))), 'no stale uncorrected row');
  assert.equal(model.aoa.filter((r) => /· NPI \d{10}/.test(String(r[0]))).length, 8);
  assert.equal(row(/^Premium$/)[1], 'Not on grid');
  // The page keeps an off-grid table column in the export and the loaded workup's client name.
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /offGrid: true \}/);
  assert.match(html, /if \(wkSaved && String\(wkSaved\.clientName \|\| ""\)\.trim\(\)\) extra\.clientName/);
});

test('saving: the ZIP decides the county; a loaded workup keeps its name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'martha-'));
  try {
    const store = new W.WorkupStore({ filePath: path.join(dir, 'w.json') });
    const a = await store.upsert('agent@example.com', { clientName: 'Martha Muraglia', zip: '33323', county: 'Miami-Dade', plans: PLANS, doctors: [{ name: 'Olivera Stojadinovic' }] });
    assert.equal(a.county, 'Broward');
    const b = await store.upsert('agent@example.com', { id: a.id, clientName: 'Add Dr', county: 'Miami-Dade', plans: PLANS, doctors: [{ name: 'Mario del Cid' }] });
    assert.equal(b.clientName, 'Martha Muraglia');
    assert.equal(b.county, 'Broward');
    assert.equal(W.withZipCounty({ zip: '33323', county: 'Miami-Dade' }).county, 'Broward');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('compare card: a med lookup that never answers stops at its budget ("⏱ timed out"), never stuck at "Checking meds 0/5"', async () => {
  const job = { input: C.normalizeInput({ clientName: 'Martha Muraglia', zip: '33323', year: 2027, doctors: [{ name: 'Waddah Allaf' }], meds: MEDS, plans: ['H7617-107', 'H7617-110'] }), progress: { doctors: { done: 0, total: 1 }, meds: { done: 0, total: 0 } }, result: {} };
  const lookupOneDoctor = async (input) => ({ status: 'done', doctorName: input.doctorName, structured: doc('Waddah Allaf', 'in', ALLAF_NPI) });
  const started = Date.now();
  await C.runJob(job, { lookupOneDoctor, lookupRx: ({ drugName }) => (drugName === 'gabapentin' ? Promise.resolve({ drugName, lookups: [], byPlanId: {} }) : new Promise(() => {})) });
  assert.ok(Date.now() - started < 5000);
  assert.equal(job.status, 'done');
  assert.equal(job.progress.meds.done, 5);
  assert.deepEqual(job.result.drugs.filter((d) => d.timedOut).map((d) => d.drugName).sort(), ['amlodipine', 'furosemide', 'liothyronine', 'spironolactone']);
  assert.match(job.result.medsTable, /⏱ timed out/);
});

test('a message typed in this workup never queues behind a reply still running for the workup she left', () => {
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /const busyHere = loadingRef\.current && !\(inflightNow && inflightNow\.gen !== chatGenRef\.current\);/);
  assert.match(html, /const ownRun = inflightChatRef\.current && inflightChatRef\.current\.gen === chatGenRef\.current;\s*if \(ownRun\) return;/);
});
