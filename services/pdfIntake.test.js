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
  assert.match(html, /disabled=\{!zipOk \|\| open\.length > 0 \|\| !text\.trim\(\)\}/, 'no ZIP or an unanswered strength → it does not run');
  assert.match(html, /onUse=\{\(t\) => \{ setPdfPreview\(null\); send\(t\); \}\}/);
  assert.match(html, /data-testid="ws-upload-pdf"/);
  assert.match(html, /useLabel="Put it in the box"/);
  assert.match(html, /app\.use|compareRequest\("POST", "\/pdf"/);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /app\.use\('\/compare\/pdf', express\.json\(\{ limit: process\.env\.MAX_PDF_BODY_LIMIT \|\| '60mb' \}\)\);\napp\.use\(express\.json/);
});
