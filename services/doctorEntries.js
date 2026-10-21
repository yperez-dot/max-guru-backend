/**
 * Doctor lines as agents type (and client PDFs print) them: "Kaitlin Ross (Primary Care), Baptist Primary,
 * SW 96th St Ste 200, Miami 33196". The practice, street, city and ZIP are the doctor's metadata, never doctors of their
 * own (Live bug, 2026-10-21: every comma piece became a doctor chip, the 15-doctor cap was filled by addresses and
 * the last 5 doctors were dropped). One reader for the typed paste, the compare card and the PDF import.
 */
const STREET_SUFFIX = '(?:St|Street|Ave|Av|Avenue|Hwy|Highway|Blvd|Boulevard|Rd|Road|Ln|Lane|Ct|Court|Ter|Terr|Terrace|Pkwy|Parkway|Plz|Plaza|Cswy|Causeway|Trl|Trail|Cir|Circle|Pl|Place|Way|Dixie|Tpke|Turnpike|US-?1)';
const DIRECTIONAL = '(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\\.?';
const SUITE_RE = /\b(?:Ste|Suite|Unit|Bldg|Building|Fl|Floor|Rm|Room)\b\.?\s*#?\s*[A-Za-z0-9-]+|#\s*[A-Za-z]?\d+[A-Za-z]?\b/i;
const STREET_RE = new RegExp(
  // "8785 SW 165th Avenue", "13101 S. Dixie Hwy", "SW 96th St Ste 200", "W Flagler St Ste G1", "S Dixie Hwy Ste 420"
  `^(?:\\d+[A-Za-z]?\\s+)?(?:${DIRECTIONAL}\\s+)?(?:\\d+(?:st|nd|rd|th)\\s+|[A-Za-z.'-]+\\s+){0,3}${STREET_SUFFIX}\\b\\.?(?:\\s|,|$)`, 'i');
const ZIP_TAIL_RE = /^(?:[A-Za-z][A-Za-z .'-]{0,30}?,?\s+)?(?:(?:FL|Fla|Florida)\.?\s*)?\d{5}(?:-\d{4})?$/i;
const STATE_ONLY_RE = /^(?:FL|Fla|Florida)\.?$/i;
const PHONE_RE = /^(?:phone|tel|ph|fax)?\s*:?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:\/|or|,)\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})*$/i;
const PRACTICE_RE = /\b(?:associates?|dentistry|dental|dentists?|clinics?|group|center|centre|medical|practice|partners|institute|hospital|physicians|surgeons|orthodontists?|orthopa?edics|consultants|vision|eye\s+care|health(?:care)?|baptist|pharmacy|llc|inc|pllc|p\.?a\.?$|primary$|dermatology$|cardiology$|neurology$|podiatry$|pediatrics$|bldg|building|office|offices|specialists)\b/i;
const TITLED_RE = /^\s*(?:dr|dra|drs|dras|doctor|doctora)\b\.?\s*/i;
// Words that make a segment a person ("Paula Montana de la Cadena (Cardiology)"): 2–6 name words, optional note in ( ).
const PERSONISH_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’-]*(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’-]*){1,5}(?:\s*\([^)]*\))?$/;

function looksStreet(s) {
  const x = String(s || '').trim();
  if (!x) return false;
  if (/^\d+[A-Za-z]?\s+\S/.test(x) && !/^\d+\s*(?:mg|mcg|ml|%|units?)\b/i.test(x)) return true; // house number
  // "Marcus St John" is a person: a street needs a number or a direction ("W Flagler St", "SW 96th St").
  if (STREET_RE.test(x) && (/^\d|\b\d+(?:st|nd|rd|th)\b/i.test(x) || SUITE_RE.test(x) || new RegExp(`^${DIRECTIONAL}\\s`, 'i').test(x))) return true;
  if (SUITE_RE.test(x) && !TITLED_RE.test(x)) return true;
  return new RegExp(`^${DIRECTIONAL}\\s+\\d+(?:st|nd|rd|th)\\b`, 'i').test(x);
}
const looksCityZip = (s) => ZIP_TAIL_RE.test(String(s || '').trim()) || STATE_ONLY_RE.test(String(s || '').trim());
const looksPhone = (s) => PHONE_RE.test(String(s || '').trim());
function looksPractice(s) {
  const x = String(s || '').replace(/\([^)]*\)/g, ' ').trim();
  if (!x || TITLED_RE.test(x)) return false;
  return PRACTICE_RE.test(x);
}

/** A comma piece that describes a doctor (practice, street, suite, city, ZIP, phone) and is never a doctor itself. */
function isDoctorMetadata(segment) {
  const s = String(segment || '').trim();
  if (!s) return true;
  return looksStreet(s) || looksCityZip(s) || looksPhone(s) || looksPractice(s);
}

function splitTopLevel(text, seps) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth && seps.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function attachMeta(entry, seg) {
  const s = seg.trim();
  if (looksPhone(s)) { entry.phone = [entry.phone, s.replace(/^(?:phone|tel|ph)\s*:?\s*/i, '')].filter(Boolean).join(' / '); return; }
  const z = s.match(/\b(\d{5})(?:-\d{4})?$/);
  if (looksCityZip(s)) {
    if (z) entry.zip = z[1];
    const city = s.replace(/,?\s*(?:(?:FL|Fla|Florida)\.?\s*)?\d{5}(?:-\d{4})?$/i, '').replace(/,?\s*(?:FL|Fla|Florida)\.?$/i, '').trim();
    if (city && !entry.city) entry.city = city;
    entry.address = [entry.address, s].filter(Boolean).join(', ');
    return;
  }
  if (looksStreet(s)) { entry.address = [entry.address, s].filter(Boolean).join(', '); return; }
  if (looksPractice(s) && !entry.address) { entry.practice = [entry.practice, s].filter(Boolean).join(' / '); return; }
  // A bare city after the street ("…, Miami, FL 33175").
  entry.address = [entry.address, s].filter(Boolean).join(', ');
}

/**
 * Doctors section text → [{ name, specialty?, practice?, address?, city?, zip?, phone? }]. One line per doctor when the
 * lines carry metadata; otherwise every comma / semicolon piece that is not metadata is a doctor and the metadata after
 * it is attached to it. Nothing is dropped: a piece is either a doctor or the previous doctor's metadata.
 */
function readDoctorEntries(text) {
  const src = String(text || '').replace(/\r/g, '');
  const lines = src.split('\n').map((l) => l.replace(/^[\s\-•*·]+|^\d+[.)]\s+/g, '').trim()).filter(Boolean);
  const entries = [];
  const pushPerson = (seg) => {
    const raw = seg.replace(TITLED_RE, '').trim();
    const spec = (raw.match(/\(([^)]*)\)\s*$/) || [])[1];
    const e = { name: raw, raw: seg.trim() };
    if (spec && !/,/.test(spec)) e.specialty = spec.trim();
    entries.push(e);
    return e;
  };
  for (const line of lines) {
    const segs = splitTopLevel(line, [',', ';']);
    let cur = null;
    let prevStreet = false; // the piece before was a street with no ZIP yet: a bare city ("…, Coral Gables, FL") follows
    segs.forEach((seg, i) => {
      const titled = TITLED_RE.test(seg);
      const meta = !titled && isDoctorMetadata(seg);
      const bareCity = !titled && prevStreet && /^[A-Za-z][A-Za-z .'-]{1,30}$/.test(seg) && seg.split(/\s+/).length <= 3;
      if (i === 0) {
        // A wrapped address line ("13101 S. Dixie Hwy, Pinecrest, FL 33156" under the doctor) belongs to the doctor above;
        // anything else that opens a line is a doctor — a practice alone on its line ("Wiltz Dermatology") is one she sees.
        if (meta && !looksPractice(seg) && entries.length) { cur = entries[entries.length - 1]; attachMeta(cur, seg); }
        else cur = pushPerson(seg);
      } else if (bareCity || meta) {
        attachMeta(cur, seg);
      } else {
        cur = pushPerson(seg); // another person in the same line or list: "Dr. A, Dr. B" / "A (PCP), …, B (Cardiology), …"
      }
      prevStreet = !titled && looksStreet(seg) && !looksCityZip(seg);
      if (bareCity) prevStreet = false;
    });
  }
  return entries;
}

/** True when the text carries doctor metadata (a street, a city + ZIP, a phone) that must not become doctors. */
function hasDoctorMetadata(text) {
  return splitTopLevel(String(text || '').replace(/\n/g, ','), [',', ';']).some((s) => !TITLED_RE.test(s) && (looksStreet(s) || looksCityZip(s) || looksPhone(s)));
}

module.exports = { readDoctorEntries, isDoctorMetadata, hasDoctorMetadata, looksStreet, looksCityZip, looksPhone, looksPractice, splitTopLevel };
