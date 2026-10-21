/**
 * Specialty / address hints for NPI candidates (live bug, 2026-10-21).
 * The client's PDF said Jose Martinez is a Gastroenterologist at 11440 N Kendall Dr Ste 306 (33176), but Max offered
 * only Interventional Cardiology MD / FNP / Surgery MD candidates and she picked the surgeon. Robert Sirven is an
 * Allergist at 8200 SW 117th Ave, but Max matched Roberto Sirven, a Family NP. When the request or PDF gives a
 * specialty or address, it ranks and filters the NPI candidates, and a mismatch is said in the confirm question.
 */
const SPECIALTIES = [
  // [what she wrote, NPPES taxonomy it means, label]
  [/gastro|\bgi\b|hepatolog/i, /gastroenterolog|hepatolog/i, 'Gastroenterology'],
  [/allerg|immunolog|asthma/i, /allergy|immunolog/i, 'Allergy & Immunology'],
  [/dermat|\bskin\b|mohs/i, /dermatolog|mohs/i, 'Dermatology'],
  [/cardi|heart/i, /cardi/i, 'Cardiology'],
  [/endocrin|diabet|thyroid/i, /endocrin/i, 'Endocrinology'],
  [/neurosurg|spine surg/i, /neurological surgery|neurosurg/i, 'Neurosurgery'],
  [/neurolog|\bneuro\b/i, /neurolog/i, 'Neurology'],
  [/optometr/i, /optometr/i, 'Optometry'],
  [/ophthalm|retina|glaucoma|cataract|\beye\b/i, /ophthalmolog|retina/i, 'Ophthalmology'],
  [/podiatr|\bfoot\b|\bdpm\b/i, /podiatr/i, 'Podiatry'],
  [/orthodont/i, /orthodont/i, 'Orthodontics'],
  [/dentist|dental|periodont|endodont|oral surg/i, /dentist|dental|orthodont|periodont|endodont|oral/i, 'Dentistry'],
  [/urolog/i, /urolog/i, 'Urology'],
  [/pulmon|\blung\b/i, /pulmon/i, 'Pulmonology'],
  [/rheumat/i, /rheumatolog/i, 'Rheumatology'],
  [/oncolog|hematolog|cancer/i, /oncolog|hematolog/i, 'Oncology / Hematology'],
  [/nephrolog|kidney/i, /nephrolog/i, 'Nephrology'],
  [/\bent\b|otolaryng|ear,? nose/i, /otolaryngolog/i, 'ENT'],
  [/psychiatr/i, /psychiatr/i, 'Psychiatry'],
  [/orthop/i, /orthop/i, 'Orthopedics'],
  [/ob\s*\/?\s*gyn|gynecolog|obstetric/i, /obstetric|gynecolog/i, 'OB/GYN'],
  [/primary care|\bpcp\b|family (?:medicine|doctor|practice)|internal medicine|general practi|internist/i, /family|internal medicine|general practice|primary care|adult health|geriatric/i, 'Primary care'],
];
// Words in a tag that say nothing about the specialty.
const NOISE_RE = /\b(?:supervising(?:\s+(?:doctor|physician|md))?|doctor|physician|wife|husband|son|daughter|note|pa-?c?|np|aprn|arnp|fnp|md|do)\b/gi;

/** The specialty she wrote, as { label, taxonomy } — null when none / not one we can read. */
function readSpecialty(text) {
  const t = String(text || '').replace(NOISE_RE, ' ');
  for (const [said, taxonomy, label] of SPECIALTIES) if (said.test(t)) return { label, taxonomy, said: String(text || '').split(/;/)[0].trim() };
  return null;
}

function taxonomyText(record) {
  return ((record && record.taxonomies) || []).map((t) => t.desc || '').join(' | ');
}
const MIDLEVEL_RE = /nurse practitioner|physician assistant|\b(?:np|pa-?c?|aprn|arnp|fnp)\b/i;

/** true / false / null (no specialty hint, or an NP/PA hint where NPPES lists only "Nurse Practitioner"). */
function specialtyFits(record, spec, { hintText = '' } = {}) {
  if (!spec) return null;
  const tax = taxonomyText(record);
  if (spec.taxonomy.test(tax)) return true;
  // "Massiel Ruiz (Gastroenterologist; PA)": NPPES files a PA as "Physician Assistant" — not a mismatch.
  if (MIDLEVEL_RE.test(hintText) && MIDLEVEL_RE.test(`${tax} ${(record && record.basic && record.basic.credential) || ''}`)) return null;
  return false;
}

/** House number + first street word ("11440 N. Kendall Dr" → 11440 / kendall). */
function streetKey(address) {
  const m = String(address || '').toLowerCase().replace(/[.,#]/g, ' ').match(/\b(\d{2,6})\s+(?:(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)\s+)?(\d+(?:st|nd|rd|th)?|[a-z]+)/);
  return m ? `${m[1]} ${m[2].replace(/(st|nd|rd|th)$/, '')}` : '';
}
function recordAddresses(record) {
  return [...((record && record.addresses) || []), ...((record && record.practiceLocations) || [])];
}
/** true when the record practices at the street she gave; null when she gave none. */
function addressFits(record, address) {
  const want = streetKey(address);
  if (!want) return null;
  return recordAddresses(record).some((a) => streetKey(`${a.address_1 || ''} ${a.address_2 || ''}`) === want);
}

/** Hints for one doctor: explicit fields, then the "(Specialty)" tag on the name, then her paste / PDF in the thread. */
function doctorHints(d = {}, threadMeta = null) {
  const name = String(d.doctorName || d.name || '');
  const tag = (name.match(/\(([^)]*)\)\s*$/) || [])[1] || '';
  const key = hintKey(name);
  const m = (threadMeta && key && threadMeta.get(key)) || {};
  const specialtyText = String(d.specialty || tag || m.specialty || '').trim();
  const address = String(d.address || m.address || '').trim();
  const spec = readSpecialty(specialtyText);
  if (!spec && !streetKey(address)) return null;
  return { specialtyText, spec, address, zip: String(d.hintZip || m.zip || '').slice(0, 5) };
}
function hintKey(name) {
  return String(name || '').replace(/\([^)]*\)/g, ' ').replace(/^\s*(?:dr|dra|doctor|doctora)\.?\s+/i, '').replace(/,.*$/, '')
    .replace(/\b(?:md|do|np|pa-?c?|aprn|arnp|fnp|dpm|od|dmd|dds)\b\.?/gi, ' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Doctor metadata from every user message in the thread (her paste, the PDF request text), newest wins. */
function threadDoctorMeta(messages = []) {
  const out = new Map();
  let parse;
  try { parse = require('./compareJobs').parseCompareAsk; } catch (_) { return out; }
  for (const m of messages || []) {
    if (!m || m.role !== 'user') continue;
    const t = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((c) => (c && c.text) || '').join('\n') : '');
    if (!t || t.length > 20000 || !/\(|\b\d{3,6}\s+\w/.test(t)) continue;
    let f;
    try { f = parse(t); } catch (_) { continue; }
    for (const d of (f && f.doctors) || []) {
      const k = hintKey(d.name);
      if (!k) continue;
      const specialty = d.specialty || (String(d.name).match(/\(([^)]*)\)\s*$/) || [])[1] || '';
      if (!specialty && !d.address) continue;
      out.set(k, { specialty, address: d.address || '', zip: d.zip || '' });
    }
  }
  return out;
}

/** One line for the confirm question: what the request says, and which candidates don't match it. */
function hintNote(hints) {
  if (!hints) return '';
  const bits = [hints.spec ? hints.spec.label : '', hints.address].filter(Boolean);
  return bits.length ? `request says ${bits.join(', ')}` : '';
}

module.exports = { readSpecialty, specialtyFits, addressFits, streetKey, doctorHints, threadDoctorMeta, hintKey, hintNote, taxonomyText };
