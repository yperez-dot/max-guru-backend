// Client PDFs → the typed request (Yahoska, 2026-10-21). Fixtures: the two real PDFs she sent (care team + meds), with the
// client's name replaced (services/fixtures/pdf) — the layout, every provider and every med are as sent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./pdfIntake');
const C = require('./compareJobs');

const FIX = path.join(__dirname, 'fixtures', 'pdf');
const pdf = (f) => fs.readFileSync(path.join(FIX, f));
const hasPdftotext = spawnSync('pdftotext', ['-v']).status === 0 || spawnSync('pdftotext', ['-v']).stderr?.length > 0;
const read = async (...files) => P.readPdfIntake(files.map((f) => ({ name: f, dataBase64: pdf(f).toString('base64') })));

const TABLE_PEOPLE = ['Kaitlin Ross', 'Paula Montana de la Cadena', 'Priscilla Escalona Villasmil', 'Raul Rosario-Concepcion', 'Yanette Barcelo', 'Wiltz',
  'Pavel Gazdovich', 'Anne L. Kunkler', 'Emilio Rivero', 'Enrique Gallo', 'Angel Rodriguez', 'Luz Maria'];
const TABLE_MEDS = ['Repatha 140mg', 'Ezetimibe 10mg', 'Losartan Potassium 25mg', 'Synthroid 112 mcg', 'Mounjaro Injectable', 'Hydroxyzine 10mg',
  'Clobetasol Shampoo 0.05%', 'Clobetasol Cream 0.05%', 'Clobetasol Topical Solution 0.05%', 'Betamethasone 0.05%', 'Silver Sulfadiazine 1%', 'Tavaborole Solution 5%'];
const BLOCK_PEOPLE = ['Alejandro Lopez Rossitch', 'Yanette Barcelo', 'Hector Wiltz', 'Robert Sirven', 'Jose Martinez', 'Massiel Ruiz', 'Emilio Rivero', 'Pavel Gazdovich'];
const BLOCK_MEDS = ['Hydrochlorothiazide 12.5 mg', 'Atorvastatin 10/20 mg', 'Famotidine 40 mg', 'Montelukast 10 mg', 'Tavaborole External Solution 5%'];

test('only PDFs, at most 10 MB, at most 4 files', () => {
  assert.throws(() => P.decodePdf({ name: 'a.png', dataBase64: Buffer.from('\x89PNG....').toString('base64') }), /only PDF/);
  assert.throws(() => P.decodePdf({ name: 'a.pdf', dataUrl: 'data:image/png;base64,AAAA' }), /only PDF/);
  assert.throws(() => P.decodePdf({ name: 'big.pdf', dataBase64: 'A'.repeat(Math.ceil(P.MAX_PDF_BYTES * 4 / 3) + 100) }), (e) => e.status === 413);
  assert.equal(P.decodePdf({ name: 'x.pdf', dataBase64: pdf('intake-block-layout.pdf').toString('base64') }).bytes.length, pdf('intake-block-layout.pdf').length);
  return assert.rejects(P.readPdfIntake(Array.from({ length: 5 }, () => ({ name: 'x.pdf', dataBase64: 'JVBERi0=' }))), /up to 4/);
});

test('the PDF is read through stdin and never written to disk', () => {
  const src = fs.readFileSync(path.join(__dirname, 'pdfIntake.js'), 'utf8');
  assert.doesNotMatch(src, /writeFile|createWriteStream|mkdtemp/);
  assert.match(src, /\['-layout', '-enc', 'UTF-8', '-', '-'\]/);
});

test('table layout PDF (10 providers, 12 meds): every provider and med, NP/PA and supervising MD both kept', { skip: !hasPdftotext }, async () => {
  const r = await read('intake-table-layout.pdf');
  const it = r.intake;
  assert.equal(it.clientName, 'Elena Sample');
  assert.equal(it.zip, '', 'no client ZIP in the PDF — never a doctor address ZIP');
  assert.equal(it.providers.length, 10);
  assert.deepEqual(it.doctors.map((d) => d.name), TABLE_PEOPLE);
  assert.deepEqual(it.meds.map((m) => m.name), TABLE_MEDS);
  assert.deepEqual(it.skippedOtc, []);
  const derm = it.providers.find((p) => /Dermatolog/.test(p.specialty));
  assert.deepEqual(derm.people.map((x) => [x.name, x.role]), [['Yanette Barcelo', 'doctor'], ['Wiltz', 'supervising']]);
  assert.equal(derm.practice, 'Wiltz Dermatology');
  assert.equal(derm.address, '11760 SW 40th Street, Ste #451, Miami, FL 33175');
  assert.equal(derm.phone, '305-227-9233 / 305-245-1332');
  const eye = it.providers.find((p) => /Optometrist/.test(p.specialty));
  assert.equal(eye.practice, 'South Florida Vision Center at Navarro’s Pharmacy');
  assert.equal(it.meds.find((m) => /Repatha/.test(m.name)).prescriber, 'Dr. Paula Montana de la Cadena');
  assert.equal(it.meds.find((m) => /Topical Solution/.test(m.name)).strength, '0.05%', 'the wrapped "0.05%" stays with its med');
  // Incomplete names are asked about, never dropped or completed.
  assert.ok(it.questions.some((q) => /^Wiltz .*first name not given/.test(q.text)));
  assert.ok(it.questions.some((q) => /^Luz Maria .*last name not given/.test(q.text)));
  assert.ok(it.notes.some((n) => /No strength listed for Mounjaro Injectable/.test(n)));
  assert.ok(it.notes.some((n) => /enter her ZIP/.test(n)));
});

test('block layout PDF (6 providers, 7 items, Walmart): 10/20 mg asks, OTC skipped in one line, pharmacy kept', { skip: !hasPdftotext }, async () => {
  const r = await read('intake-block-layout.pdf');
  const it = r.intake;
  assert.equal(it.clientName, 'Jose Ejemplo Ruiz');
  assert.equal(it.providers.length, 6);
  assert.deepEqual(it.doctors.map((d) => d.name), BLOCK_PEOPLE);
  assert.deepEqual(it.meds.map((m) => m.name), BLOCK_MEDS);
  assert.deepEqual(it.skippedOtc.map((m) => m.name), ['Align Oral Capsule', 'Fiber Select Gummies']);
  assert.equal(it.meds.length + it.skippedOtc.length, 7);
  assert.equal(it.notes.filter((n) => /^Skipped 2 over-the-counter supplements/.test(n)).length, 1);
  assert.deepEqual(it.meds.find((m) => /Atorvastatin/.test(m.name)).strengthOptions, ['10 mg', '20 mg']);
  assert.deepEqual(it.questions.find((q) => q.kind === 'strength').options, ['10 mg', '20 mg']);
  const gi = it.providers.find((p) => /Gastro/.test(p.specialty));
  assert.deepEqual(gi.people.map((x) => [x.name, x.role, x.credential]), [['Jose Martinez', 'supervising', ''], ['Massiel Ruiz', 'np-pa', 'PA']]);
  const derm = it.providers.find((p) => /Dermatolog/.test(p.specialty));
  assert.deepEqual(derm.people.map((x) => [x.name, x.role]), [['Yanette Barcelo', 'doctor'], ['Hector Wiltz', 'supervising']]);
  const allergy = it.providers.find((p) => /Allerg/.test(p.specialty));
  assert.deepEqual([allergy.practice, allergy.people.map((x) => x.name)], ['Sirven & Associates', ['Robert Sirven']]);
  assert.equal(allergy.phone, '305-442-4116 / 786-460-2936');
  assert.deepEqual(it.pharmacy, { name: 'Walmart Neighborhood Pharmacy', address: '14720 SW 26th Street, Miami, FL 33185', phone: '786-584-4758' });
  assert.equal(it.providers[0].address, '8785 SW 165th Avenue, Ste #105, Miami, FL 33196');
});

test('a scanned PDF (no text layer) says so plainly and guesses nothing', { skip: !hasPdftotext }, async () => {
  const r = await read('intake-scanned-no-text.pdf');
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].noTextLayer, true);
  assert.match(r.results[0].error, /scan .*can't read it as text — I won't guess/);
  assert.equal(r.requestText, '');
  assert.deepEqual(r.intake.doctors, []);
});

test('the request text runs through the same typed-request parser with nothing dropped', { skip: !hasPdftotext }, async () => {
  for (const [file, people, meds, zip] of [['intake-table-layout.pdf', TABLE_PEOPLE, TABLE_MEDS, '33196'], ['intake-block-layout.pdf', BLOCK_PEOPLE, BLOCK_MEDS, '33175']]) {
    const r = await read(file);
    const text = P.intakeRequestText(r.intake, { zip, strengthPicks: { 'Atorvastatin 10/20 mg': '20 mg' } });
    const f = C.parseCompareAsk(text);
    assert.equal(f.zip, zip);
    assert.equal(f.clientName, r.intake.clientName);
    assert.deepEqual(f.doctors.map((d) => d.name.replace(/\s*\([^)]*\)\s*$/, '')), people, file);
    assert.equal(f.meds.length, meds.length, file);
    assert.deepEqual(f.unreadDoctors, []);
    assert.ok(f.doctors.filter((d) => d.address).length >= people.length - 1, 'addresses stay metadata of their doctor');
    if (/block/.test(file)) {
      assert.ok(f.meds.includes('Atorvastatin 20 mg'));
      assert.match(f.pharmacy, /^Walmart Neighborhood Pharmacy, 14720 SW 26th Street/);
    }
  }
});

test('two PDFs at once: one list, duplicates once, different client names flagged', { skip: !hasPdftotext }, async () => {
  const r = await read('intake-table-layout.pdf', 'intake-block-layout.pdf');
  assert.equal(r.results.length, 2);
  assert.ok(r.results.every((x) => x.ok));
  const names = r.intake.doctors.map((d) => d.name);
  assert.equal(names.filter((n) => n === 'Emilio Rivero').length, 1);
  assert.equal(names.filter((n) => n === 'Pavel Gazdovich').length, 1);
  assert.ok(names.includes('Massiel Ruiz') && names.includes('Luz Maria'));
  assert.match(r.intake.notes[0], /different clients/);
});

test('POST /compare/pdf: reads the files, refuses other types', { skip: !hasPdftotext }, async () => {
  const express = require('express');
  const { createCompareRouter } = require('../routes/compare');
  const app = express();
  app.use(express.json({ limit: '60mb' }));
  app.use('/compare', createCompareRouter({}));
  const srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  try {
    const url = `http://127.0.0.1:${srv.address().port}/compare/pdf`;
    const ok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ name: 'b.pdf', dataBase64: pdf('intake-block-layout.pdf').toString('base64') }] }) });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.intake.doctors.length, 8);
    assert.match(body.requestText, /^Jose Ejemplo Ruiz\nDoctors:\n/);
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ name: 'x.png', dataBase64: Buffer.from('nope').toString('base64') }] }) });
    assert.equal(bad.status, 415);
    const scan = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ name: 's.pdf', dataBase64: pdf('intake-scanned-no-text.pdf').toString('base64') }] }) });
    assert.equal(scan.status, 422);
    assert.match((await scan.json()).error, /scan/);
  } finally {
    srv.close();
  }
});

test('page: paperclip takes PDFs (desktop and mobile file picker), preview before anything runs, card has Upload PDF', () => {
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  assert.match(html, /data-testid="chat-attach-input"\s+type="file"\s+accept="image\/png,image\/jpeg,image\/webp,application\/pdf,\.pdf"\s+multiple/);
  assert.match(html, /function PdfIntakePreview\(/);
  assert.match(html, /const canRun = nameOk && zipOk && planOk && open\.length === 0;/);
  assert.match(html, /disabled=\{!canRun\}/, 'Run Max stays off until name, ZIP, and plan are set');
  assert.match(html, /onUse=\{\(t\) => \{ setPdfPreview\(null\); startNewClient\(\); void wsSubmit\(t\); \}\}/, 'composer PDF goes to the new-client gates, not a bare send');
  assert.match(html, /data-testid="ws-upload-pdf"/);
  assert.match(html, /useLabel="Run Max"/);
  assert.match(html, /data-testid="pdf-intake-name"/);
  assert.match(html, /data-testid="pdf-intake-plan"/);
  assert.equal(html.includes('Put it in the box'), false);
  assert.match(html, /app\.use|compareRequest\("POST", "\/pdf"/);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.use\('\/compare\/pdf', express\.json\(\{ limit: process\.env\.MAX_PDF_BODY_LIMIT \|\| '60mb' \}\)\);\napp\.use\(express\.json/);
  assert.match(html, /pharmacy ZIP hints/);
  assert.match(html, /data-testid="pdf-intake-need"/);
});

const MP = require('./medicareProPrint');
const PRINT_TXT = fs.readFileSync(path.join(FIX, 'intake-medicarepro-client-print.txt'), 'utf8');
const PRINT_PEOPLE = ['Marta Solano Ruiz', 'Luis Herrera', 'Marco Vidal', 'Elena Castro', 'Tomas Navarro', 'Rosa Benitez', 'Pablo Rivas', 'Coral Eyes', 'Diego Molina'];
const PRINT_MEDS = [
  'alprazolam 0.25 MG Oral Tablet',
  'atorvastatin 20 MG Oral Tablet',
  'meloxicam 15 MG Oral Tablet',
  'meloxicam 5 MG Oral Capsule',
  '24 HR oxcarbazepine 600 MG Extended Release Oral Tablet',
  'sertraline 50 MG Oral Tablet',
  'triamcinolone acetonide 0.00025 MG/MG Topical Ointment',
];

test('24 HR ER drugs keep the 24; numbered "1. Lipitor" still strips the list marker', () => {
  assert.match(P.medItem('24 HR oxcarbazepine 600 MG Extended Release Oral Tablet').name, /^24 HR oxcarbazepine/);
  assert.match(P.medItem('1. Atorvastatin 20 mg').name, /^Atorvastatin 20 mg/i);
  assert.equal(P.medItem('24 HR oxcarbazepine 600 MG Extended Release Oral Tablet').strength, '600 mg');
});

test('MedicarePro Client Print: detect, strip chrome, client vs agent, plan, providers, meds, pharmacies', () => {
  assert.equal(MP.isMedicareProClientPrint(PRINT_TXT), true);
  assert.equal(MP.matchPlanName('DEVOTED CORE 062 FL (HMO)').planId, 'H1290-062');
  assert.equal(MP.matchPlanName('DEVOTED CORE 062 FL (HMO)').confidence, 'high');
  const gold = MP.matchPlanName('Humana Gold Plus');
  assert.equal(gold.confidence, 'ambiguous');
  assert.ok(gold.candidates.some((id) => id.slice(0, 9) === 'H1036-054') && gold.candidates.some((id) => id.slice(0, 9) === 'H1036-065'), String(gold.candidates));

  const it = P.parseIntakeText(PRINT_TXT);
  assert.equal(it.clientName, 'Marina Solano');
  assert.equal(it.zip, '', 'never the office ZIP 33172 or a pharmacy ZIP');
  assert.deepEqual(it.zipHints, ['33032', '33033']);
  assert.equal(it.currentPlan.planId, 'H1290-062');
  assert.equal(it.currentPlan.confidence, 'high');
  assert.equal(it.currentPlan.effectiveDate, '01.01.2026');
  assert.deepEqual(it.doctors.map((d) => d.name), PRINT_PEOPLE);
  assert.equal(it.doctors.find((d) => d.name === 'Marta Solano Ruiz').specialty, 'PCP');
  assert.equal(it.doctors.find((d) => d.name === 'Diego Molina').specialty, 'PCP');
  const eyes = it.doctors.find((d) => d.name === 'Coral Eyes');
  assert.equal(eyes.role, 'practice');
  assert.match(eyes.note, /practice — no doctor named/);
  assert.equal(eyes.specialty, 'Optometrist');
  assert.ok(it.questions.some((q) => q.kind === 'pcp' && /Marta Solano Ruiz and Diego Molina/.test(q.text)));
  assert.ok(it.questions.some((q) => q.kind === 'doctor' && /Coral Eyes/.test(q.text)));
  assert.deepEqual(it.meds.map((m) => m.name), PRINT_MEDS);
  assert.ok(!it.meds.some((m) => /medicareproapp|Client Print|Drug Name|1\/4/.test(m.name)));
  assert.ok(!it.doctors.some((d) => /medicareproapp|Client Print|Camila Romero/.test(d.name)));
  assert.equal(it.pharmacies.length, 2);
  assert.equal(it.pharmacies[0].name, 'WALGREENS #01999');
  assert.match(it.pharmacies[0].address, /33032/);
  assert.equal(it.pharmacies[1].name, 'CVS PHARMACY #08888');
  assert.match(it.pharmacies[1].phone, /305\) 247-0200/);
  assert.ok(it.notes.some((n) => /Pharmacy ZIP hints/.test(n) && /33032/.test(n) && /33033/.test(n)));
  assert.ok(it.notes.some((n) => /enter her ZIP/i.test(n)));
  assert.doesNotMatch(it.notes.join('\n'), /33172/);

  const preview = P.intakeRequestText(it);
  assert.match(preview, /^Marina Solano\nCurrent plan: Devoted CORE 062 \(H1290-062\)/);
  assert.match(preview, /Coral Eyes \(Optometrist — practice — no doctor named\)/);
  assert.match(preview, /24 HR oxcarbazepine 600 MG Extended Release Oral Tablet/);
  assert.match(preview, /meloxicam 15 MG Oral Tablet/);
  assert.match(preview, /meloxicam 5 MG Oral Capsule/);
  assert.doesNotMatch(preview, /33172|33032|33033|\b2026\b/);
  assert.match(preview, /WALGREENS #01999.*CVS PHARMACY #08888/s);
});

test('MedicarePro Client Print PDF extract matches the text fixture', { skip: !hasPdftotext }, async () => {
  const r = await read('intake-medicarepro-client-print.pdf');
  assert.equal(r.results[0].ok, true);
  assert.equal(r.intake.clientName, 'Marina Solano');
  assert.equal(r.intake.currentPlan.planId, 'H1290-062');
  assert.equal(r.intake.doctors.length, 9);
  assert.equal(r.intake.meds.length, 7);
  assert.equal(r.intake.pharmacies.length, 2);
  assert.equal(r.intake.zip, '');
  assert.match(r.requestText, /Current plan: Devoted CORE 062 \(H1290-062\)/);
});

test('a pasted MedicarePro Client Print parses the same way (no office ZIP, no 2026 year, current plan mapped)', () => {
  const f = C.parseCompareAsk(PRINT_TXT);
  assert.equal(f.clientName, 'Marina Solano');
  assert.equal(f.zip, '', 'office ZIP 33172 and pharmacy ZIPs stay out');
  assert.equal(f.year, 2027);
  assert.deepEqual(f.currentPlans, ['H1290-062']);
  assert.ok(f.plans.includes('H1290-062'));
  assert.equal(f.wantsAlternatives, true);
  assert.deepEqual(f.doctors.map((d) => d.name.replace(/\s*\([^)]*\)\s*$/, '')), PRINT_PEOPLE);
  assert.ok(f.doctors.find((d) => /Coral Eyes/.test(d.name)));
  assert.equal(f.meds.length, 7);
  assert.ok(f.meds.some((m) => /24 HR oxcarbazepine/.test(m)));
  assert.ok(f.meds.some((m) => /meloxicam 15 MG Oral Tablet/.test(m)));
  assert.ok(f.meds.some((m) => /meloxicam 5 MG Oral Capsule/.test(m)));
  assert.ok(!f.meds.some((m) => /medicareproapp|Client Print/.test(m)));
  assert.match(f.pharmacy, /WALGREENS #01999/);
  assert.match(f.pharmacy, /CVS PHARMACY #08888/);
  assert.doesNotMatch(f.pharmacy, /33032|33033|33172/);

  const withZip = P.intakeRequestText(P.parseIntakeText(PRINT_TXT), { zip: '33177' });
  const g = C.parseCompareAsk(withZip);
  assert.equal(g.zip, '33177');
  assert.equal(g.year, 2027);
  assert.deepEqual(g.currentPlans, ['H1290-062']);
});

test('unmapped Plan Name is shown and asked; 0.00025 is not a ZIP', () => {
  const text = PRINT_TXT.replace('DEVOTED CORE 062 FL (HMO)', 'SOME UNKNOWN PLAN FL (HMO)');
  const it = P.parseIntakeText(text);
  assert.equal(it.currentPlan.planId, '');
  assert.ok(it.questions.some((q) => q.kind === 'plan' && /SOME UNKNOWN PLAN/.test(q.text)));
  assert.match(P.intakeRequestText(it), /Current plan: SOME UNKNOWN PLAN FL \(HMO\)/);
  assert.doesNotMatch(P.intakeRequestText(it), /H1290-062/);
  const f = C.parseCompareAsk('Marina Solano\nMeds: triamcinolone acetonide 0.00025 MG/MG Topical Ointment');
  assert.notEqual(f.zip, '00025');
});
