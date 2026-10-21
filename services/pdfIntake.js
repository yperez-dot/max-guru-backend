/**
 * Client PDFs (care-team / medication lists) → the same typed request Max already reads. Yahoska, 2026-10-21: clients
 * send PDFs with their doctors and meds; she uploads them instead of retyping.
 *
 * 1. extractPdfText: the PDF's own text layer (poppler `pdftotext -layout`, piped through stdin — the PDF is never
 *    written to disk and nothing of it is kept after the request). No text layer (a scan) → said plainly, never guessed.
 * 2. parseIntakeText: client, ZIP, providers (name, specialty, practice, address, phone — an NP/PA and the supervising MD
 *    both kept as doctors), meds (name, strength, form; "10/20 mg" asks which one; OTC supplements skipped and said so),
 *    pharmacy.
 * 3. intakeRequestText: the typed request ("Name, ZIP …\nDoctors:\n…\nMeds: …\nPharmacy: …") she reviews and edits; it
 *    then runs exactly like a typed request (parseCompareAsk → workup → doctor / drug lookups).
 */
const { spawn } = require('child_process');
const DE = require('./doctorEntries');

const MAX_PDF_BYTES = Number(process.env.MAX_PDF_BYTES || 10 * 1024 * 1024);
const MAX_PDFS = 4;
const EXTRACT_TIMEOUT_MS = Number(process.env.MAX_PDF_EXTRACT_MS || 20_000);

function intakeError(message, status = 400, code = 'pdf_invalid') {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

/** { name, bytes } from { name, dataBase64 | dataUrl }; only real PDFs ("%PDF-" header), ≤ 10 MB. */
function decodePdf(file) {
  const f = file && typeof file === 'object' ? file : {};
  const name = String(f.name || 'upload.pdf').slice(0, 120);
  let b64 = String(f.dataBase64 || f.data || '');
  const url = String(f.dataUrl || '');
  if (!b64 && url) {
    const m = url.match(/^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s);
    if (!m) throw intakeError(`${name}: not a PDF file.`, 415, 'pdf_type');
    if (m[1] && !/^application\/(?:pdf|x-pdf|octet-stream)$/i.test(m[1])) throw intakeError(`${name}: only PDF files can be read here.`, 415, 'pdf_type');
    b64 = m[2];
  }
  if (!b64) throw intakeError(`${name}: the file is empty.`);
  // base64 length → bytes, checked before decoding so a huge upload is refused cheaply.
  if (Math.floor((b64.length * 3) / 4) > MAX_PDF_BYTES + 4) throw intakeError(`${name} is larger than ${Math.round(MAX_PDF_BYTES / 1048576)} MB.`, 413, 'pdf_too_large');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_PDF_BYTES) throw intakeError(`${name} is larger than ${Math.round(MAX_PDF_BYTES / 1048576)} MB.`, 413, 'pdf_too_large');
  if (bytes.subarray(0, 1024).indexOf('%PDF-') < 0) throw intakeError(`${name}: only PDF files can be read here.`, 415, 'pdf_type');
  return { name, bytes };
}

function runPdftotext(bytes, { bin = process.env.MAX_PDFTOTEXT || 'pdftotext', timeoutMs = EXTRACT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['-layout', '-enc', 'UTF-8', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, text: '', error: err.message });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } finish({ ok: false, text: '', error: 'pdftotext_timeout' }); }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; if (out.length > 2_000_000) { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } } });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => finish({ ok: false, text: '', error: e && e.code === 'ENOENT' ? 'pdftotext_missing' : String(e.message || e) }));
    child.on('close', (code) => finish({ ok: code === 0, text: out, error: code ? `pdftotext_exit_${code}${/password|encrypt/i.test(err) ? '_encrypted' : ''}` : null }));
    child.stdin.on('error', () => { /* closed early: the exit code says why */ });
    child.stdin.end(bytes);
  });
}

/** { ok, text, noTextLayer, error } — the text layer only. */
async function extractPdfText(bytes, deps = {}) {
  const run = deps.pdftotext || runPdftotext;
  const r = await run(bytes);
  if (!r.ok) {
    if (/encrypted/.test(r.error || '')) return { ok: false, text: '', error: 'This PDF is password-protected. Remove the password (or print it to a new PDF) and upload it again.' };
    if (/missing/.test(r.error || '')) return { ok: false, text: '', error: 'The PDF reader is not available on the server right now. Type or paste the list instead.' };
    return { ok: false, text: '', error: "I couldn't open that PDF. Try printing it to a new PDF, or paste the text." };
  }
  const text = String(r.text || '').replace(/\f/g, '\n').replace(/\r/g, '');
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (letters < 25) {
    return { ok: true, text: '', noTextLayer: true, error: 'This PDF is a scan (a picture of the page, with no text in it), so I can\'t read it as text — I won\'t guess. Take a screenshot of it and use "Upload screenshot", or type the doctors and meds.' };
  }
  return { ok: true, text, noTextLayer: false };
}

// ─── parse ──────────────────────────────────────────────────────────────────────────────────────────────────────

const FOOTER_RE = /informational purposes only|AI responses may include mistakes|^\s*page\s+\d+(?:\s+of\s+\d+)?\s*$/i;
const PROVIDERS_HEAD_RE = /^\s*(?:■\s*|#+\s*)?(?:(?:my\s+)?care\s+team\b.*|(?:my\s+)?(?:doctors|providers|physicians|specialists)(?:\s*(?:&|and)\s*\w+)*\s*:?)\s*$/i;
const MEDS_HEAD_RE = /^\s*(?:■\s*|#+\s*)?(?:current\s+|active\s+|my\s+)?(?:medications?|prescriptions?|meds|medicines?|drugs?)(?:\s*(?:&|and|\/)\s*\w+)*(?:\s+list)?\s*:?\s*$/i;
const PHARMACY_HEAD_RE = /^\s*(?:■\s*|#+\s*)?(?:preferred\s+|my\s+)?pharmac(?:y|ies)\s*:?\s*$/i;
const OTC_RE = /\b(?:probiotics?|fiber|fibre|gumm(?:y|ies)|chewables?|align\b|culturelle|florastor|metamucil|benefiber|citrucel|melatonin|multi-?vitamins?|supplements?|fish\s+oil|omega-?3|glucosamine|chondroitin|turmeric|coq-?10|biotin|elderberry|collagen)\b/i;
const CREDENTIAL_RE = /,?\s*\b(MD|M\.D\.|DO|D\.O\.|DPM|DDS|DMD|OD|PA-C|PA|P\.A\.|NP|APRN|ARNP|FNP|FNP-C|CNP|PhD)\b\.?/gi;
const NON_MD_RE = /^(?:PA-C|PA|P\.A\.|NP|APRN|ARNP|FNP|FNP-C|CNP)$/i;

/** Pieces of a layout line: [{ s, e, text }] split at 2+ spaces. */
function chunksOf(line) {
  const out = [];
  for (const m of String(line || '').matchAll(/\S+(?: \S+)*/g)) out.push({ s: m.index, e: m.index + m[0].length, text: m[0].trim() });
  return out;
}

function sectionsOf(text) {
  const lines = String(text || '').split('\n');
  const out = { head: [], providers: [], meds: [], pharmacy: [] };
  let cur = 'head';
  for (const line of lines) {
    if (FOOTER_RE.test(line)) continue;
    const bare = line.replace(/^\s*■\s*/, '').trim();
    if (PROVIDERS_HEAD_RE.test(bare)) { cur = 'providers'; continue; }
    if (MEDS_HEAD_RE.test(bare)) { cur = 'meds'; continue; }
    if (PHARMACY_HEAD_RE.test(bare)) { cur = 'pharmacy'; continue; }
    out[cur].push(line.replace(/^(\s*)■\s*/, '$1'));
  }
  return out;
}

function clientFrom(headLines, all) {
  const src = [...headLines, ...all].join('\n');
  const m = src.match(/\b(?:patient(?:\s+name)?|client(?:\s+name)?|member(?:\s+name)?|name)\s*:\s*([A-Za-zÀ-ÿ'’.\- ]{3,60}?)(?=\s*(?:\||\s{2,}|\n|,|\bDOB\b|\bAs of\b|$))/i);
  const name = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  // The client's own ZIP only when it is labeled as hers — never a doctor's or the pharmacy's address.
  const z = src.match(/\b(?:patient|client|member|home)?\s*(?:zip(?:\s*code)?|address)\s*:\s*[^\n]*?\b(\d{5})(?:-\d{4})?\b/i);
  const zip = z ? z[1] : '';
  return { clientName: name, zip };
}

/** Rows of a column table: header chunks give the column starts; a row starts where its first column has text. */
function tableRows(lines, headerRe) {
  const at = lines.findIndex((l) => headerRe.test(l));
  if (at < 0) return null;
  const cols = chunksOf(lines[at]).map((c) => ({ s: c.s, name: c.text.toLowerCase() }));
  const colOf = (s) => { let k = 0; cols.forEach((c, i) => { if (c.s <= s + 3) k = i; }); return k; };
  const rows = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    const cells = cols.map(() => []);
    for (const ch of chunksOf(line)) cells[colOf(ch.s)].push(ch.text);
    // A wrapped piece of the first column ("0.05%" under "Clobetasol Topical Solution") continues the row above.
    const filled = cells.filter((c) => c.length).length;
    const starts = cells[0].length > 0 && !(rows.length && filled === 1 && /^[\d(%a-z.,&/-]/.test(cells[0][0]));
    if (starts || !rows.length) rows.push(cols.map(() => []));
    const row = rows[rows.length - 1];
    cells.forEach((c, i) => { if (c.length) row[i].push(c.join(' ')); });
  }
  return { cols: cols.map((c) => c.name), rows };
}

/** Block layout: "Primary Care      Dr. X" then indented detail lines (address, phone) under the name. */
function blockRows(lines) {
  const rows = [];
  let indent = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*\.\s*$/.test(line)) continue;
    const ch = chunksOf(line);
    if (ch[0].s < 4 && ch.length >= 2) {
      rows.push({ label: ch[0].text, lines: [ch.slice(1).map((c) => c.text).join('  ')] });
      indent = ch[1].s;
    } else if (rows.length && indent != null && ch[0].s >= Math.min(indent - 4, 8)) {
      rows[rows.length - 1].lines.push(ch.map((c) => c.text).join('  '));
    } else if (ch[0].s < 4 && ch.length === 1) {
      rows.push({ label: '', lines: [ch[0].text] });
      indent = ch[0].s;
    }
  }
  return rows;
}

const titleCaseWord = (w) => (w === w.toUpperCase() && w.length > 3 ? w.charAt(0) + w.slice(1).toLowerCase() : w);

/** "Dr. Yanette Barcelo (with Dr. Hector Wiltz)" → people; "Sirven & Associates (Dr. Robert Sirven)" → practice + person. */
function peopleOf(providerText, specialty) {
  let text = String(providerText || '').replace(/\s+/g, ' ').trim();
  const people = [];
  let practice = '';
  const notes = [];
  // Parentheticals: a supervising doctor ("with Dr. X"), a person under a practice ("(Dr. X)"), a practice
  // ("(Rivero Dental)"), or a note ("(Optometrist)").
  const parens = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim());
  text = text.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const mainIsPractice = DE.looksPractice(text) && !/^(?:dr|dra|doctor)\b/i.test(text);
  if (mainIsPractice) { practice = text; text = ''; }
  const person = (raw, role) => {
    let s = String(raw || '').trim();
    if (!s) return;
    let note = '';
    // "Wife Luz Maria": a relation word is not part of the name, and her last name was not given.
    const rel = s.match(/^(wife|husband|son|daughter|partner)\s+(.+)$/i);
    if (rel) { s = rel[2]; note = `listed as the ${rel[1].toLowerCase()} — last name not given, confirm it`; }
    const titled = /^\s*(?:dr|dra|doctor|doctora)\b/i.test(s);
    const creds = [...s.matchAll(CREDENTIAL_RE)].map((m) => m[1].toUpperCase().replace(/\./g, ''));
    s = s.replace(CREDENTIAL_RE, '').replace(/^\s*(?:dr|dra|doctor|doctora)\b\.?\s*/i, '').replace(/[,\s]+$/, '').trim();
    if (!s) return;
    const words = s.split(/\s+/);
    if (words.length === 1 && !note) note = 'first name not given — confirm the doctor';
    const credential = creds[0] || '';
    people.push({ name: words.map(titleCaseWord).join(' '), credential, titled, role: role || (credential && NON_MD_RE.test(credential) ? 'np-pa' : 'doctor'), ...(note ? { note } : {}) });
  };
  if (text) {
    // "Dr. Jose Martinez & Massiel Ruiz, PA" / "Yanette Barcelo w/ Dr. Wiltz" / "Dr. Angel Rodriguez & Wife Luz Maria".
    const parts = text.split(/\s+(?:&|and|w\/|with|\/)\s+|\s*\/\s*(?=dr\.?\s)/i).map((x) => x.trim()).filter(Boolean);
    parts.forEach((p, i) => person(p, i === 0 ? '' : /^(?:dr|dra|doctor)\b/i.test(p) && /\bw\/|\bwith\b/i.test(text) ? 'supervising' : ''));
  }
  for (const p of parens) {
    const withDr = p.match(/^(?:with|w\/|supervis\w*(?:\s+by)?|under)\s+(.+)$/i);
    if (withDr) { person(withDr[1], 'supervising'); continue; }
    if (/^(?:dr|dra|doctor)\b\.?\s+\S/i.test(p) || (mainIsPractice && /^[A-Z][a-z]+\s+[A-Z]/.test(p) && !DE.looksPractice(p))) { person(p, ''); continue; }
    if (DE.looksPractice(p)) { practice = practice || p; continue; }
    notes.push(p);
  }
  // An NP / PA with a supervising MD: both are candidates; the NP/PA is never dropped for the MD or the other way round.
  if (people.some((x) => x.role === 'np-pa') && people.some((x) => x.role !== 'np-pa')) people.forEach((x) => { if (x.role === 'doctor') x.role = 'supervising'; });
  const spec = notes.find((n) => /(?:ist|ian|ology|ics|care|dentist|surgeon|optometr)/i.test(n)) || '';
  return { people, practice, specialtyNote: spec, notes: notes.filter((n) => n !== spec) };
}

function splitDetails(lines) {
  const out = { practice: [], address: [], phone: [], notes: [] };
  for (const raw of lines) {
    const l = String(raw || '').replace(/\s{2,}/g, ' ').trim();
    if (!l || l === '—' || l === '-') continue;
    const phone = l.match(/^(?:phone|tel|ph)\b\s*:?\s*(.*)$/i);
    if (phone && (/\d/.test(phone[1]) || /:/.test(l))) { if (/\d/.test(phone[1])) out.phone.push(phone[1].trim().replace(/\s*\/$/, '')); continue; }
    if (DE.looksPhone(l) || /^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\s*\/?$/.test(l)) { out.phone.push(l.replace(/\s*\/$/, '')); continue; }
    if (/^\(.*\)$/.test(l)) { out.notes.push(l.slice(1, -1)); continue; }
    if (out.practice.length && !out.address.length && /^[A-Z][a-z]+$/.test(l)) { out.practice[out.practice.length - 1] += ' ' + l; continue; }
    if (!out.address.length && !DE.looksStreet(l) && !DE.looksCityZip(l) && !/,\s*(?:FL|Florida)\b/i.test(l)) { out.practice.push(l); continue; }
    out.address.push(l);
  }
  return {
    practice: out.practice.join(' '),
    address: out.address.map((a, i) => (i < out.address.length - 1 && !/,\s*$/.test(a) && !/^(?:FL|Florida)\b/i.test(out.address[i + 1]) ? a + ',' : a)).join(' ').replace(/,\s*$/, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim(),
    phone: out.phone.join(' / ').replace(/\s*\/\s*\/\s*/g, ' / '),
    notes: out.notes,
  };
}

function providersFrom(lines) {
  const providers = [];
  const table = tableRows(lines, /\bprovider\b.*\b(?:address|phone|location)\b|\b(?:doctor|physician)\b.*\b(?:address|phone)\b/i);
  if (table && table.rows.length) {
    const ci = (re) => table.cols.findIndex((c) => re.test(c));
    const cSpec = ci(/specialt|type|role/), cProv = ci(/provider|doctor|physician|name/), cAddr = ci(/address|location|office/), cPhone = ci(/phone|tel/);
    for (const r of table.rows) {
      const prov = cProv >= 0 ? r[cProv].join(' ') : '';
      const details = splitDetails([...(cAddr >= 0 ? r[cAddr] : []), ...(cPhone >= 0 ? r[cPhone].map((p) => 'Phone: ' + p) : [])]);
      providers.push({ specialty: cSpec >= 0 ? r[cSpec].join(' ') : '', providerText: prov, ...details });
    }
  } else {
    for (const b of blockRows(lines)) {
      const details = splitDetails(b.lines.slice(1));
      providers.push({ specialty: b.label, providerText: b.lines[0], ...details });
    }
  }
  return providers.filter((p) => p.providerText || p.practice).map((p) => {
    const who = peopleOf(p.providerText, p.specialty);
    const practice = [who.practice, p.practice].filter(Boolean).join(' / ');
    if (!who.people.length && practice) who.people.push({ name: practice, credential: '', role: 'practice', note: 'a practice — no doctor named' });
    const phone = String(p.phone || '').replace(/\s*\/\s*$/, '');
    return {
      specialty: [p.specialty, who.specialtyNote].filter(Boolean).join(' — ') || '',
      people: who.people,
      practice,
      address: p.address || '',
      phone,
      notes: [...who.notes, ...(p.notes || [])],
    };
  });
}

// ─── meds ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STRENGTH_RE = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*)\s*(mg|mcg|µg|g|ml|mL|%|units?|iu|meq)\b|(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)*)\s*%/i;

function medItem(raw, extra = {}) {
  let text = String(raw || '').replace(/\s+/g, ' ').replace(/^\s*(?:\d+[.)]?|[-•*·])\s+/, '').replace(/\s*\.\s*$/, '').trim();
  if (!text || /^\.+$/.test(text)) return null;
  const parens = [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]);
  const otc = OTC_RE.test(text);
  const sm = text.match(STRENGTH_RE);
  let strength = '';
  let strengthOptions = null;
  if (sm) {
    const num = (sm[1] || sm[3] || '').replace(/\s+/g, '');
    const unit = sm[2] ? sm[2].replace(/^µg$/i, 'mcg') : '%';
    strength = `${num}${unit === '%' ? '%' : ' ' + unit.toLowerCase()}`;
    // "Atorvastatin 10/20 mg": two strengths of ONE drug — ask which one. A combination product names two drugs
    // ("Amlodipine/Benazepril 10/20 mg", "Losartan-HCTZ 50-12.5") and its "10/20" is one strength.
    const name0 = text.slice(0, sm.index);
    if (/\//.test(num) && !/[/\-+]/.test(name0.replace(/\s+-\s+/g, ' ')) && !/\b(?:and|with|plus)\b/i.test(name0)) {
      strengthOptions = num.split('/').map((n) => `${n}${unit === '%' ? '%' : ' ' + unit.toLowerCase()}`);
    }
  }
  const name = text.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim().split(' ').map(titleCaseWord).join(' ');
  return {
    name,
    strength,
    ...(strengthOptions ? { strengthOptions } : {}),
    ...(otc ? { otc: true } : {}),
    ...(parens.length ? { note: parens.join('; ') } : {}),
    ...(!strength && !otc ? { noStrength: true } : {}),
    ...extra,
  };
}

function medsFrom(lines) {
  const table = tableRows(lines, /\b(?:medication|medicine|drug|prescription)s?\b.*\b(?:indication|purpose|reason|prescrib|dose|directions|provider)/i);
  const meds = [];
  if (table && table.rows.length) {
    const ci = (re) => table.cols.findIndex((c) => re.test(c));
    const cMed = Math.max(0, ci(/medication|medicine|drug|prescription/)), cWhy = ci(/indication|purpose|reason/), cBy = ci(/prescrib|provider|doctor/);
    for (const r of table.rows) {
      const it = medItem(r[cMed].join(' '), {
        ...(cWhy >= 0 && r[cWhy].length ? { indication: r[cWhy].join(' ') } : {}),
        ...(cBy >= 0 && r[cBy].length ? { prescriber: r[cBy].join(' ') } : {}),
      });
      if (it) meds.push(it);
    }
    return meds;
  }
  // A numbered / bulleted / plain list; "." spacer lines and wrapped lines are joined to their item.
  let cur = null;
  for (const line of lines) {
    const l = line.trim();
    if (!l || /^\.+$/.test(l)) continue;
    if (/^(?:\d+[.)]?|[-•*·])\s+\S/.test(l) || !cur) {
      cur = { raw: l };
      meds.push(cur);
    } else if (/^\s{6,}/.test(line) || /^[(\d%]/.test(l)) {
      cur.raw += ' ' + l;
    } else {
      cur = { raw: l };
      meds.push(cur);
    }
  }
  return meds.map((m) => medItem(m.raw)).filter(Boolean);
}

function pharmacyFrom(lines) {
  const ls = lines.map((l) => l.trim()).filter((l) => l && !/^\.+$/.test(l));
  if (!ls.length) return null;
  const d = splitDetails(ls.slice(1));
  return { name: ls[0].replace(/\s{2,}.*/, ''), address: [d.practice, d.address].filter(Boolean).join(', '), phone: d.phone };
}

/** The structured intake from a PDF's text layer. Nothing is dropped: every provider row and every med line comes back. */
function parseIntakeText(text) {
  const sec = sectionsOf(text);
  const { clientName, zip } = clientFrom(sec.head, []);
  const providers = providersFrom(sec.providers);
  const allMeds = medsFrom(sec.meds);
  const pharmacy = pharmacyFrom(sec.pharmacy);
  const meds = allMeds.filter((m) => !m.otc);
  const skippedOtc = allMeds.filter((m) => m.otc);
  const questions = [];
  for (const m of meds) {
    if (m.strengthOptions) questions.push({ kind: 'strength', med: m.name, text: `"${m.name}" lists two strengths — which one does she take?`, options: [...m.strengthOptions] });
  }
  for (const p of providers) {
    for (const who of p.people) if (who.note) questions.push({ kind: 'doctor', doctor: who.name, text: `${who.name}${p.specialty ? ` (${p.specialty})` : ''}: ${who.note}.` });
  }
  const doctors = providers.flatMap((p) => p.people.map((who) => ({
    name: who.name,
    ...(who.credential ? { credential: who.credential } : {}),
    ...(who.titled ? { titled: true } : {}),
    role: who.role,
    specialty: p.specialty,
    practice: p.practice,
    address: p.address,
    phone: p.phone,
    ...(who.note ? { note: who.note } : {}),
  })));
  return {
    clientName,
    zip,
    providers,
    doctors,
    meds,
    skippedOtc,
    pharmacy,
    questions,
    notes: [
      ...(skippedOtc.length ? [`Skipped ${skippedOtc.length} over-the-counter supplement${skippedOtc.length > 1 ? 's' : ''} (not covered by Part D): ${skippedOtc.map((m) => m.name).join(', ')}.`] : []),
      ...(meds.filter((m) => m.noStrength).length ? [`No strength listed for ${meds.filter((m) => m.noStrength).map((m) => m.name).join(', ')} — add it if she knows it.`] : []),
      ...(!zip ? ["The PDF doesn't list the client's own ZIP (only the doctors' addresses) — enter her ZIP."] : []),
    ],
  };
}

/** Several PDFs for one client: one list, nothing dropped, duplicates (same name) once. */
function mergeIntakes(list) {
  const out = { clientName: '', zip: '', providers: [], doctors: [], meds: [], skippedOtc: [], pharmacy: null, questions: [], notes: [] };
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const p of list.filter(Boolean)) {
    out.clientName = out.clientName || p.clientName;
    out.zip = out.zip || p.zip;
    out.pharmacy = out.pharmacy || p.pharmacy;
    out.providers.push(...p.providers);
    for (const d of p.doctors) if (!out.doctors.some((x) => key(x.name) === key(d.name))) out.doctors.push(d);
    for (const m of p.meds) if (!out.meds.some((x) => key(x.name) === key(m.name))) out.meds.push(m);
    for (const m of p.skippedOtc) if (!out.skippedOtc.some((x) => key(x.name) === key(m.name))) out.skippedOtc.push(m);
    for (const q of p.questions) if (!out.questions.some((x) => x.text === q.text)) out.questions.push(q);
    for (const n of p.notes) if (!out.notes.includes(n)) out.notes.push(n);
  }
  if (out.zip) out.notes = out.notes.filter((n) => !/client's own ZIP/.test(n));
  const names = [...new Set(list.filter(Boolean).map((p) => p.clientName).filter(Boolean).map((n) => n.toLowerCase()))];
  if (names.length > 1) out.notes.unshift(`These PDFs name different clients (${names.join(', ')}) — check they belong to the same person.`);
  return out;
}

/** The typed request she reviews — the same text the typed flow reads (doctor metadata after the name, by commas). */
function intakeRequestText(intake, { zip = '', clientName = '', strengthPicks = {} } = {}) {
  const it = intake || {};
  const name = clientName || it.clientName || '';
  const z = zip || it.zip || '';
  const lines = [[name, z ? `ZIP ${z}` : ''].filter(Boolean).join(', ')];
  lines.push('Doctors:');
  for (const d of it.doctors || []) {
    const tag = [d.specialty, d.credential && NON_MD_RE.test(d.credential) ? d.credential : '', d.role === 'supervising' ? 'supervising doctor' : '']
      .filter(Boolean).join('; ').replace(/,/g, ' ');
    const head = `${d.titled ? 'Dr. ' : ''}${d.name}${tag ? ` (${tag})` : ''}`;
    lines.push([head, d.role === 'practice' ? '' : d.practice, d.address, d.phone].filter(Boolean).join(', '));
  }
  const meds = (it.meds || []).map((m) => {
    const pick = strengthPicks[m.name];
    if (m.strengthOptions && pick) return m.name.replace(STRENGTH_RE, pick);
    return m.name;
  });
  lines.push('Meds: ' + meds.join('; '));
  if (it.pharmacy && it.pharmacy.name) lines.push('Pharmacy: ' + [it.pharmacy.name, it.pharmacy.address].filter(Boolean).join(', ').replace(/;/g, ','));
  return lines.join('\n');
}

/** files [{ name, dataBase64 }] → { results:[{ file, ok, noTextLayer, error }], intake, requestText }. Nothing is stored. */
async function readPdfIntake(files, deps = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) throw intakeError('Attach a PDF.');
  if (list.length > MAX_PDFS) throw intakeError(`Attach up to ${MAX_PDFS} PDFs at a time.`);
  const decoded = list.map(decodePdf);
  const results = [];
  const parsed = [];
  for (const f of decoded) {
    let r;
    try {
      r = await extractPdfText(f.bytes, deps);
    } finally {
      f.bytes.fill(0); // the PDF itself is not kept past this read
    }
    if (!r.ok || r.noTextLayer) { results.push({ file: f.name, ok: false, noTextLayer: Boolean(r.noTextLayer), error: r.error }); continue; }
    const p = parseIntakeText(r.text);
    parsed.push(p);
    results.push({ file: f.name, ok: true, doctors: p.doctors.length, providers: p.providers.length, meds: p.meds.length, skippedOtc: p.skippedOtc.length });
  }
  const intake = mergeIntakes(parsed);
  return { results, intake, requestText: parsed.length ? intakeRequestText(intake) : '' };
}

module.exports = {
  MAX_PDF_BYTES, MAX_PDFS,
  decodePdf, runPdftotext, extractPdfText, parseIntakeText, mergeIntakes, intakeRequestText, readPdfIntake,
  sectionsOf, peopleOf, medItem, chunksOf,
};
