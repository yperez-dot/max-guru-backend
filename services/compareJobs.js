// services/compareJobs.js — Client Comparison mode.
//
// Comparisons don't go through the chat model. The agent's ask is parsed into
// fields (client, ZIP, doctors, meds, plans), then one background job runs every
// doctor and drug lookup in parallel and reports progress. No chat wait, no
// model timeouts, no plan dumps. Chat stays for questions.

const crypto = require('crypto');
const { lookupDoctor, NOT_CONFIRMED } = require('./providerNetwork');
const { lookupFormulary, toExportDrug, toExportDrugs, formatFormularyText } = require('./formularyLookup');
const { askConstraints, gridTable, medsTable, selectComparison, strengthNotes, medsLegendFor, quietRestrictionMarks, textPlanTypeAsk, planTypeAskLines, planTypeLineFor, currentPlanIdsIn } = require('./doctorPlanNarrow');
const { dedupeDoctorRows, duplicateQuestions } = require('./loadedWorkup');
const { eligibilityFromAsk, carriersRequested, LEGEND, MEDS_LEGEND, MEDS_FAILED_BANNER, IN_STAR_LEGEND, unlabeledMeds: unlabeledMedsList } = require('./comparisonRules');
const { expandMedList } = require('./drugNames');

// Candidates priced before the final top 3, so drug cost can break ties (rule 3).
const RX_SHORTLIST = Number(process.env.MAX_COMPARE_RX_SHORTLIST || 6);

const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const RX_CACHE_MS = Number(process.env.MAX_RX_CACHE_MS || 24 * 60 * 60 * 1000);
const DOCTOR_BUDGET_MS = Number(process.env.MAX_COMPARE_DOCTOR_BUDGET_MS || 90_000);
// A doctor still answering after DOCTOR_BUDGET_MS gets this much more before the card draws "⏱ timed out".
const CARD_RECHECK_MS = Number(process.env.MAX_COMPARE_RECHECK_MS || 90_000);
// Total time the card's med lookups get (they ran with no limit and could sit at "Checking meds 0/5").
const CARD_MEDS_BUDGET_MS = Number(process.env.MAX_COMPARE_MEDS_BUDGET_MS || 120_000);
const DRUG_CONCURRENCY = Number(process.env.MAX_COMPARE_DRUG_CONCURRENCY || 4);
// 15 was filled by addresses read as doctors and the rest were dropped silently (live bug, 2026-10-21): every
// doctor she lists is kept; past this many the extra ones are listed back to her, never dropped silently.
const MAX_DOCTORS = 30;
const MAX_MEDS = 20;
const MAX_PLANS = 6; // same cap as the UI (max-demo MAX_PLANS) — a 5th named plan was silently dropped

// "wondering if there's something better", "other options", "alternatives" → keep her plan as a column AND shop the county.
const ALTERNATIVES_RE = /\b(?:something|anything|options?|plans?)\s+(?:that(?:'s| is)\s+)?better\b|\bbetter\s+(?:options?|plans?|fit|deal)\b|\bother\s+(?:options?|plans?)\b|\balternatives?\b|\bsee\s+what\s+else\b|\bwhat\s+else\b|\bshop(?:ping)?\s+around\b|\bcompare\s+(?:it\s+)?(?:to|against|with)\s+others?\b|\bsomething\s+else\b/i;

const PLAN_ID_RE = /\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi;

// ─── parse ──────────────────────────────────────────────────────────────────

function splitList(text) {
  return String(text || '')
    .split(/\n|,|;|\band\b(?=\s+[A-Z])/)
    .map((s) => s.replace(/^[\s\-•*\d.)]+/, '').trim())
    .filter((s) => s && s.length > 1);
}

function section(text, label, stops) {
  const re = new RegExp(`\\b${label}\\s*:\\s*([\\s\\S]*?)(?=(?:\\b(?:${stops.join('|')})\\s*:)|$)`, 'i');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

// Plan ids as agents paste them: "H1045-5-0", "H1045-005-0", "H1045-5" → "H1045-005".
function normalizePlanIds(text) {
  return String(text || '').replace(/\b([HR]\d{4})-(\d{1,3})(?:-\d)?(?=[^\dA-Za-z-]|$)/gi, (m, a, b) => `${a.toUpperCase()}-${b.padStart(3, '0')}`);
}

const TITLE_SKIP = new Set(['and', 'y', '&']);

/** Free-form paste with no strict capitalization: "Marilyn and Angus butler. 33076. …" → "Marilyn and Angus Butler". */
function looseClientName(t) {
  // "Mr. and Mrs. Mazzeo" / "The Mazzeos" / "Mazzeo family" → keep the titles, drop the filler; the dots in Mr./Mrs. are not sentence ends.
  // "New client: Victor Rocha, ZIP …" — the label (with its colon) is not the name (Victor, 2026-10-08).
  const src = String(t || '').replace(/^\s+/, '').replace(/^(?:new\s+)?(?:client|patient|cliente)\s*[:\-–—]\s*/i, '').replace(/\b(Mr|Mrs|Ms|Miss)\.(?=\s)/gi, '$1');
  const head = src.split(/[\d\n,;:]|\.(?=\s|$)/)[0].replace(/\bzip(?:\s*code)?\s*$/i, '').replace(/^\s*(?:the|new client|client)\s+/i, '').replace(/\s+family\s*$/i, '').trim();
  if (!head || head.length > 70) return '';
  const words = head.split(/\s+/);
  if (words.length > 6) return '';
  // "Pinecrest Dentisry is Dr. Salome Fraga" / "Levothyroxine Sodium is 0.2 mg": a sentence, not a name.
  if (words.some((w) => /^(?:is|are|was|=|es|son|takes?|uses?|means)$/i.test(w))) return '';
  // "pls remove careplus" is an instruction, not a client (Gerry Cabrera, 2026-10-19).
  if (words.some((w) => /^(?:pls|plz|please|remove|drop|delete|add|check|grid|rerun|re-run|manually|careplus|devoted|dvoted|humana|aetna|wellcare|uhc|unitedhealthcare|cigna|simply|doctors|meds)$/i.test(w))) return '';
  if (!words.every((w) => /^[A-Za-z][A-Za-z'’-]*$|^&$/.test(w))) return '';
  if (/^(?:doctors?|drs?|meds?|medications?|compare|please|can|could|hi|hello|new|client|zip|plan|plans|current|show|add|check|look|find|help|she|he|they|his|her|their|no|none)$/i.test(words[0])) return '';
  // One word is a family name ("Mazzeos", "Mazzeo") — only when it clearly opens the paste, i.e. a delimiter followed it.
  if (words.length === 1 && (words[0].length < 3 || !/^[A-Za-z][A-Za-z'’-]+$/.test(words[0]))) return '';
  return words.map((w) => (TITLE_SKIP.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ').replace(/\b(Mr|Mrs|Ms)\b(?!\.)/g, '$1.');
}

/** Doctors typed as a plain list right after the ZIP: "33076. Ashwin Mehta, Jorge G. Ruiz, … no meds." */
function unlabeledDoctors(t, zip) {
  return unlabeledDoctorList(t, zip).names.join('\n');
}

/**
 * { names, unsure }: names = the plain-list doctors; unsure = items that might be a doctor but she typed no title and the
 * case gives no hint ("waddah allaf") — asked about ("Is "waddah allaf" a doctor?"), never dropped silently.
 */
function unlabeledDoctorList(t, zip) {
  const none = { names: [], unsure: [] };
  if (!zip) return none;
  const at = t.indexOf(zip);
  if (at < 0) return none;
  let rest = t.slice(at + zip.length).replace(/^[\s.,;:\-–—]+/, '');
  rest = rest.split(/(?<!\b(?:[A-Za-z]|[Dd][Rr][Aa]?[Ss]?|[Dd]oc))\.\s+(?=[A-Za-z])|\n\s*\n/)[0];
  // The doctor list ends where the meds / plan list starts: "…, Pavel Gazdovich, meds: atorvastatin, …". Without this cut
  // the six meds after the five doctors outvoted them and the whole plain list was thrown away, leaving only the one
  // name typed with "Dr." (Jorge Rivero, 2026-10-20: 4 of 5 doctors dropped).
  // A label with a colon ("meds:", "Plans:") or a lowercase list right after it ("meds atorvastatin"); "Med Eye Associates"
  // is a practice, not the label (Tony & Gerry Cabrera, 2026-10-19).
  rest = rest.split(/[,;\s]*\b(?:meds?|medications?|medicines?|medicamentos?|medicinas?|rx|drugs?|prescriptions?|current\s+plans?|plans?)\b\s*(?::|-\s)/i)[0];
  rest = rest.split(/[,;\s]*\b(?:[Mm]eds?|MEDS?|[Mm]edications?|[Mm]edicines?|[Mm]edicamentos?|[Rr]x|[Dd]rugs?|[Pp]rescriptions?|[Cc]urrent\s+plans?|[Cc]ompare)\s+(?=[a-z])/)[0];
  const TITLE_AT_RE = /^(?:Drs?|Dras?|Doc|Doctora?)(?:\.\s*|\s+)(?=[A-Za-z])/i;
  const DE = require('./doctorEntries');
  // "Kaitlin Ross (Primary Care), Baptist Primary, SW 96th St Ste 200, Miami 33196": one doctor and her metadata.
  const entries = DE.hasDoctorMetadata(rest) ? DE.readDoctorEntries(rest) : null;
  const items = entries ? entries.map((e) => ({ titled: TITLE_AT_RE.test(e.raw || ''), text: e.name, entry: e })) : rest.split(/\n|,|;|\band\b(?=\s+(?:[A-Z]|(?:drs?|dras?|doc|doctora?)\b))/i)
    .map((x) => x.replace(/^[\s\-•*\d.)]+/, '').replace(/[\s.]+$/, '').trim()).filter(Boolean)
    .map((x) => ({ titled: TITLE_AT_RE.test(x), text: x.replace(TITLE_AT_RE, '').trim() }));
  const words = (x) => x.split(/\s+/);
  const alpha = (x) => words(x).every((y) => /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’-]*$/.test(y));
  const notWords = (x) => !/^(?:no|none|medicaid|they|for|has|have|she|he|compare|add)\b/i.test(x) &&
    // "Med Eye Associates" is a practice, not the meds label; "Meds: …" / "meds metformin" are (Tony & Gerry Cabrera, 2026-10-19).
    !/^[Mm][Ee][Dd][Ss]?\b(?=\s*:|\s+[a-z])|^MEDS?\b|^Meds\b/.test(x);
  const capitalized = (x) => {
    const w = words(x);
    return w.length >= 2 && w.length <= 5 && /^[A-Z]/.test(w[0]) && /^[A-Z]/.test(w[w.length - 1]) && alpha(x) && notWords(x);
  };
  // "Dr." / "dr." is the strong signal: the case she typed the name in does not matter.
  // The same reader as any "Dr. …" in the ask, so "Dr. Lopez for her heart" is "Lopez" (one word: not a plain-list name).
  const titledName = (it) => it.titled && titledDoctorNames('Dr. ' + it.text).length > 0;
  const good = items.filter((it) => titledName(it) || (!it.titled && capitalized(it.text)));
  if (!entries && (!good.length || good.length * 2 < items.length)) return none;
  const DN = require('../artifacts/doctor-name.js');
  const unsure = items.filter((it) => !good.includes(it) && !it.titled && words(it.text).length >= 2 && words(it.text).length <= 3 && alpha(it.text) && notWords(it.text)
    && !words(it.text).some((w) => MED_WORD_RE.test(w) || DN.SPECIALTY_HINT_RE.test(w))).map((it) => it.text);
  // A metadata line names its doctor first: the address is the strong signal, so the case of the name does not matter.
  const good2 = entries ? items : good;
  if (entries && !good2.length) return none;
  const nameOf = (it) => (it.titled ? titledDoctorNames('Dr. ' + it.text)[0] || it.text : entries ? it.text.replace(/^[^(]+/, (h) => DN.displayPersonName(h.trim()) + (/\s$/.test(h) ? ' ' : '')) : DN.displayPersonName(it.text));
  return { names: good2.map(nameOf), unsure: entries ? [] : unsure, entries: entries ? good2.map((it) => ({ ...it.entry, name: nameOf(it) })) : [] };
}

const MED_WORD_RE = /^(?:meds?|medications?|medicines?|rx|drugs?|takes?|taking|medicamentos?|medicinas?|zip|plans?|compare|no|and|y)$/i;

/**
 * Doctors named with a title anywhere in the ask, no "Doctors:" label needed:
 * "Dr.Steven Barilla, Dr. Matthew Soff, Dra. Ana Ruiz, Doctora María López" (Martin Wiesenthal,
 * 2026-10-09: three doctors shared a sentence with six meds, so the plain-list reader saw too few names).
 */
function titledDoctors(t) {
  return titledDoctorNames(t).join('\n');
}

// Words that end a titled name ("Dr. Lopez for her heart", "dr. smith is her PCP", "Dr. Ruiz cardiologist").
const NAME_STOP_RE = /^(?:and|or|for|with|is|are|was|at|in|on|from|who|the|my|her|his|she|he|they|also|plus|but|to|of|as|that|this|has|have|had|takes?|taking|sees?|saw|meds?|medications?|rx|drugs?|zip|plans?|compare|current|no|none|pcp|primary|care|npi|md|do|dds|dmd|dpm|od)$/i;
const TITLE_WORD_RE = /^(?:dr|dra|drs|dras|doc|doctor|doctora)$/i;

/**
 * Every "Dr. …" name in the ask, in ANY case (Martha Muraglia, 2026-10-20: 6 of 8 doctors dropped — "Dr. WADDAH aLLAF",
 * "Dr. Mario del cid", "dr. laura martin" … failed the capitalized-name check; "dr." in lowercase was not a title at all).
 * The title is the strong signal: after it, a name in normal case ends at the first lowercase word that is not a surname
 * particle (the old rule); a name typed all lower / ALL CAPS / odd case ends at punctuation, a stop word or a role word.
 * At most 4 words; a surname particle ("del", "de la") keeps the next word whatever its case.
 */
function titledDoctorNames(t, { minWords = 2 } = {}) {
  const DN = require('../artifacts/doctor-name.js');
  const out = [];
  // The run stops before the next title, so "Dra.María López y Dr. Jorge G. Ruiz" is two names.
  const re = /(?:^|[^A-Za-zÀ-ÿ])(?:dr|dra|drs|dras|doc|doctor|doctora)\b\.?[ \t]*([A-Za-zÀ-ÿ](?:(?![^A-Za-zÀ-ÿ](?:dr|dra|drs|dras|doc|doctor|doctora)\b)[^,;:()\n])*)/gi;
  for (const m of String(t || '').matchAll(re)) {
    // A sentence end inside the run ("dr. simone vanhorn. Meds: …") — an initial ("Jorge G. Ruiz") is not one.
    const run = m[1].split(/(?<!\b[A-Za-z])\.(?:\s|$)/)[0];
    const raw = run.split(/\s+/).filter(Boolean);
    const normalFirst = raw.length && /^[A-ZÁÉÍÓÚÑ][a-zà-ÿ'’-]/.test(raw[0]);
    const words = [];
    let afterParticle = false;
    for (const w0 of raw) {
      const w = w0.replace(/[.,]+$/, (x) => (/^[A-Za-z]\.$/.test(w0) ? '.' : ''));
      if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.'’-]*$/.test(w)) break;
      if (TITLE_WORD_RE.test(w.replace(/\.$/, ''))) break; // "Dr. A and Dr. B" — the next title starts the next name
      const particle = words.length > 0 && DN.SURNAME_PARTICLES.has(w.toLowerCase());
      if (!afterParticle && !particle) {
        if (NAME_STOP_RE.test(w) || MED_WORD_RE.test(w) || (words.length && DN.SPECIALTY_HINT_RE.test(w))) break;
        if (normalFirst && words.length && /^[a-zà-ÿ]/.test(w)) break;
      }
      words.push(w);
      afterParticle = particle;
      if (words.length >= 5) break;
    }
    while (words.length && (DN.SURNAME_PARTICLES.has(words[words.length - 1].toLowerCase()) || MED_WORD_RE.test(words[words.length - 1]))) words.pop();
    const name = DN.displayPersonName(words.join(' ').trim());
    if (words.length >= minWords && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** Every doctor she typed with a title ("Dr. Lopez" too — one word): the doctors she meant to name. */
function doctorMentions(t) {
  return titledDoctorNames(t, { minWords: 1 });
}

/** Meds typed as a plain list after the ZIP/doctors — one reader shared with the chat path (comparisonRules). */
function unlabeledMeds(t, zip, doctors) {
  return unlabeledMedsList(t, zip, doctors).join('\n');
}

/** "Maria & Gaspar Padron, ZIP 33332 … Doctors: … Meds: … Compare H… " → fields. */
function parseCompareAsk(text) {
  const t = normalizePlanIds(String(text || '').replace(/\r/g, ''));
  const stops = ['doctors?', 'drs?', 'providers?', 'meds?', 'medications?', 'rx', 'drugs?', 'current\\s+plans?', 'plans?', 'compare', 'pharmacy', 'pharmacies', 'preferred\\s+pharmacy'];
  const constraints = askConstraints(t);

  const zip = (t.match(/\b(?:zip\s*(?:code)?\s*:?\s*)?(\d{5})\b/i) || [])[1] || '';
  const clientMatch = t.replace(/^\s*(?:new\s+)?(?:client|patient|cliente)\s*[:\-–—]\s*/i, '').match(/^\s*([A-Z][a-z]+(?:\s*(?:&|and|y)\s*[A-Z][a-z]+)?\s+[A-Z][A-Za-z'-]+)/);
  // A doctor mapping or a dose answer ("Pinecrest Dentisry is Dr. Salome Fraga", "X = Dr. Y", "Levothyroxine is 0.2 mg")
  // names no client (Gerry Cabrera, 2026-10-19: the client was renamed after the practice).
  const mappingLine = /^\s*[^.\n]{1,80}?\s(?:is|=|es|are)\s+(?:dr|dra|doctor|doctora)\b|^\s*[^.\n]{1,60}?\s*=\s*\S|^\s*[^.\n]{1,60}?\s(?:is|=)\s+\d/i.test(t);
  const practiceName = (x) => require('./comparisonRules').PRACTICE_WORD_RE.test(x);
  // "Add Dr. Mario del Cid, …" names a doctor to add, not the client (Martha Muraglia, 2026-10-20: client became "Add Dr").
  const instructionLead = (x) => /\b(?:drs?|dras?|doc|doctora?|add|remove|drop|delete|check|please|pls|run|rerun|update|change|swap|use|replace|also|show|export|include)\b/i.test(x);
  const strictName = clientMatch && !mappingLine && !practiceName(clientMatch[1]) && !instructionLead(clientMatch[1]) ? clientMatch[1].replace(/\s+/g, ' ').trim() : '';
  const looseName = mappingLine ? '' : looseClientName(t);
  const clientName = (looseName && looseName.toLowerCase().startsWith(strictName.toLowerCase()) ? looseName : (strictName || looseName)).replace(/^the\s+/i, '');
  const terminatingPlan = ((t.match(/\b([HR]\d{4}-\d{3}[A-Z]?)\b[^.\n]{0,25}?\b(?:terminat|ending)/i) || [])[1] || '').toUpperCase();

  let doctorsText = section(t, '(?:doctors?|drs?|providers?|physicians?|specialists?)', stops.filter((s) => !/doctor|dr|provider/.test(s)));
  let medsText = section(t, '(?:meds?|medications?|rx|drugs?)', stops.filter((s) => !/med|rx|drug/.test(s)));
  // Trim trailing sentences ("… Compare Humana …", "Give me 2-3 plans")
  const cut = (s) => s.split(/(?<!\b[A-Za-z])\.\s+(?=[A-Z])|\bcompare\b|\bgive me\b|\bsuggest\b|\bshow me\b/i)[0];
  // "Dr. Jorge Perez" must not be cut at the period after "Dr" (it left the doctor named just "Dr").
  let unsureDoctors = [];
  let plainEntries = [];
  if (!doctorsText) {
    // Plain list after the ZIP, plus every titled name ("Dr.Steven Barilla", "Dra. María López").
    const names = [];
    const plain = unlabeledDoctorList(t, zip);
    unsureDoctors = plain.unsure;
    plainEntries = plain.entries || [];
    for (const n of [...plain.names, ...titledDoctorNames(t)]) {
      const k = n.trim().toLowerCase();
      if (k && !names.some((x) => x.toLowerCase() === k)) names.push(n.trim());
    }
    doctorsText = names.join('\n');
  }
  doctorsText = doctorsText.replace(/\b(?:Drs?|Dras?|Doc)(?:\.\s*|\s+)(?=[A-Za-z])/gi, '');
  doctorsText = cut(doctorsText);
  // "Radomir Kosanovic, MD (spine specialist)": a credential after a comma is not a second doctor.
  doctorsText = doctorsText.replace(/,\s*(?:MD|M\.D\.?|DO|D\.O\.?|DPM|DDS|DMD|OD)\b\.?(?=\s*(?:\(|\n|;|,|$))/gi, '');
  medsText = cut(medsText);
  if (!medsText) {
    // "Medications esomeprazole, …" (label, no colon) before the unlabeled-list fallback.
    const labeled = require('./comparisonRules').medsFromAsk(t);
    medsText = labeled.length ? labeled.join('\n') : unlabeledMeds(t, zip, splitList(doctorsText).map((name) => ({ name })));
  }

  // "Carlos Santa-Cruz, MD (Urology, Coral Gables)": the commas inside the parentheses and the
  // credential after the name are not doctors of their own (Victor, 2026-10-08: 3 doctors read as 5).
  const CRED_ONLY_RE = /^(?:md|m\.d\.?|do|d\.o\.?|dpm|dds|dmd|od|np|pa|pa-c|aprn|arnp|phd|facc|facp|facs)\.?$/i;
  // Practice, street, city + ZIP and phone after a doctor are HER metadata, never doctors (live bug, 2026-10-21).
  const DE = require('./doctorEntries');
  const labeledEntries = plainEntries.length ? plainEntries : DE.hasDoctorMetadata(doctorsText) ? DE.readDoctorEntries(doctorsText) : [];
  const metaByName = new Map(labeledEntries.map((e) => [String(e.name).replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase(), e]));
  const doctorPieces = labeledEntries.length ? labeledEntries.map((e) => e.name.replace(/\([^)]*,[^)]*\)/g, ' ').trim()) : splitList(doctorsText.replace(/\([^)]*,[^)]*\)/g, ' '));
  const allDoctors = doctorPieces.filter((x) => !CRED_ONLY_RE.test(x.trim())).map((raw) => {
    const mustKeep = /must[- ]?keep/i.test(raw);
    let name = raw.replace(/\(?\s*must[- ]?keep\s*\)?/i, '');
    // "Rundeep Singh Gadh NPI 1407095615 (PCP)" — pull the NPI out so the lookup uses it
    // instead of searching for a name with ten digits glued on (Yahoska, 2026-10-07).
    let npi;
    const m = name.match(/\b(?:npi\s*#?\s*:?\s*)?(\d{10})\b/i);
    if (m) {
      npi = m[1];
      name = name.replace(m[0], ' ').replace(/\bnpi\b\s*#?\s*:?/i, ' ');
    }
    // "Yusleidi Gil MD (primary care)" -> "Yusleidi Gil (primary care)": a trailing credential is not part of the name.
    name = name.replace(/,?\s+(?:MD|M\.D\.?|DO|D\.O\.?|DPM|DDS|DMD|OD)\.?(?=\s*(?:\(|$))/i, '');
    // "Elias Feanny - Primary *", "Alan Chu - ENT", "Alan DelPar - UM": a one-word role / marker after a dash is not part of the name
    // (Melmoth Alexander, 2026-10-13: all four read "not found").
    name = name.replace(/\s*\*+\s*$/, '').replace(/\s+[-–—]\s+(?:primary(?:\s+care)?|pcp|ent|um|u\.m\.|[a-z]+ologist|surgeon|dentist|dds|dmd)\s*$/i, '');
    name = name.replace(/\s{2,}/g, ' ').replace(/[\s.,-]+$/, '').trim();
    // "WADDAH aLLAF" / "laura martin" → "Waddah Allaf" / "Laura Martin" (normal-case names stay as typed).
    // Only the name itself: a note in parentheses ("(primary care)", "(PCP)") stays as typed.
    name = name.replace(/^[^(]+/, (head) => require('../artifacts/doctor-name.js').displayPersonName(head) + (/\s$/.test(head) ? ' ' : ''));
    const meta = metaByName.get(raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase()) || metaByName.get(name.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase());
    const details = {};
    if (meta) for (const k of ['specialty', 'practice', 'address', 'city', 'zip', 'phone']) if (meta[k]) details[k] = meta[k];
    return { name, ...(npi ? { npi } : {}), mustKeep, ...details };
  }).filter((d) => (d.name || d.npi) && !/^(?:here|this|the|my|list)\b/i.test(d.name || '') && !CRED_ONLY_RE.test(d.name || '') && !/^(?:MD|DO|DDS|DMD|DPM|OD)\b\s*[-–—]/i.test(d.name || ''));
  const doctors = allDoctors.slice(0, MAX_DOCTORS);
  const overLimitDoctors = allDoctors.slice(MAX_DOCTORS).map((d) => d.name);
  // "acyclovir tablets & ointment" is two products, two rows.
  let meds = expandMedList(splitList(medsText).map((m) => require('./comparisonRules').cleanMedItem(m.replace(/\.$/, ''))).filter(Boolean)).slice(0, MAX_MEDS);
  // A sentence is a note, not a drug: "UM means University of Miami", "only Humana has those doctors".
  meds = meds.filter((m) => !/\b(?:means|only|has|have|those|doctors?|wants?|please)\b/i.test(m));
  meds = require('./comparisonRules').dropDoctorNamesFromMeds(meds, doctors)
    .filter((m) => !require('./comparisonRules').INSTRUCTION_WORD_RE.test(m) && !require('./comparisonRules').isPlanOrCarrierName(m));
  if (require('./comparisonRules').saidNoMeds(t)) meds = [];
  // A pasted MedicarePro "Prescriptions (5)" block ("atorvastatin calcium TAB 10MG" lines) — the
  // section parser above caught only the first line (Victor, 2026-10-08). Use the full Rx-line read.
  const rxMeds = require('./comparisonRules').medsFromAsk(t);
  if (/^\s*[A-Za-z][A-Za-z\- ]{2,40}?\s+(?:TAB|CAP|TBEC|CPDR|TB24|CP24|SOL|SOLN|INJ|PATCH|INH)\b/im.test(t) && rxMeds.length > meds.length) meds = rxMeds.slice(0, MAX_MEDS);
  // "Medications esomeprazole, …" with no colon — the shared reader catches what the section parser missed.
  if (!meds.length && rxMeds.length) meds = rxMeds.slice(0, MAX_MEDS);

  const skip = constraints.skip;
  const plans = [];
  for (const m of t.matchAll(PLAN_ID_RE)) {
    const id = m[1].toUpperCase();
    if (id === terminatingPlan || skip.has(id) || [...skip].some((x) => x.slice(0, 9) === id.slice(0, 9))) continue;
    // H1036-065C and H1036-065 are the same contract-PBP: keep one column.
    if (!plans.some((x) => x.slice(0, 9) === id.slice(0, 9))) plans.push(id);
  }

  // "only PPOs" / "compare all HMOs" anywhere in the paste: the same plan-type reader as a chat message
  // (doctorPlanNarrow.textPlanTypeAsk → planTypeAsk). Before, the card never read it and ranked HMOs (Robert and
  // Andrea, 2026-10-19).
  const typeAsk = textPlanTypeAsk(t);
  // Every "Dr. …" she typed must come out as a doctor: the ones the parser could not read are listed, never dropped
  // silently (Martha Muraglia, 2026-10-20: 8 typed, 2 kept).
  const DNm = require('../artifacts/doctor-name.js');
  const unreadDoctors = doctorMentions(t).filter((raw) => !doctors.some((d) => DNm.sameDoctorName(d.name, raw)
    || DNm.plainWords(d.name).join(' ') === DNm.plainWords(raw).join(' ')));
  return {
    clientName,
    zip,
    doctors,
    meds,
    // Typed with no title and no case hint ("waddah allaf") — Max asks whether it is a doctor instead of dropping it.
    unsureDoctors: unsureDoctors.filter((x) => !doctors.some((d) => DNm.plainWords(d.name).join(' ') === DNm.plainWords(x).join(' '))),
    unreadDoctors,
    // Past MAX_DOCTORS: listed back to her ("I can check 30 at a time — these weren't run: …"), never dropped silently.
    overLimitDoctors,
    // How many doctors the request named: every titled name plus the plain-list / labeled ones.
    doctorCount: Math.max(allDoctors.length + unreadDoctors.length, doctorMentions(t).length),
    plans: plans.slice(0, MAX_PLANS),
    // "current plan UHC H5420-001": her current plan, the first column (or left out of the other type's table).
    currentPlans: currentPlanIdsIn(t).filter((id) => id !== terminatingPlan && plans.some((x) => x.slice(0, 9) === id.slice(0, 9))),
    planType: typeAsk ? typeAsk.type : '',
    planTop: typeAsk ? typeAsk.top : 0,
    terminatingPlan,
    wantsAlternatives: ALTERNATIVES_RE.test(t) || (doctors.length > 0 && meds.length > 0 && require('./comparisonRules').impliesCompareToCurrentPlan(t, plans.length)),
    carriers: carriersRequested(t),
    noMedicaid: constraints.noMedicaid,
    // Medicaid / MSP level / C-SNP condition exactly as the agent stated them (never inferred).
    eligibility: eligibilityFromAsk(t),
    skip: [...skip].filter((id) => id !== terminatingPlan),
    // "Pharmacy: Walmart Neighborhood Pharmacy, 14720 SW 26th Street …" (typed or from a PDF): saved with the workup.
    pharmacy: section(t, '(?:preferred\\s+)?pharmacy', stops.filter((x) => !/pharmac/.test(x))).split('\n')[0].trim().slice(0, 200),
    year: /\b2026\b/.test(t) && !/\b2027\b/.test(t) ? 2026 : 2027,
  };
}

// ─── Rx cache (tiers don't change mid-season) ───────────────────────────────

const rxCache = new Map();

// A row failed for a reason that will not change on retry ("not a drug name", "no product of that
// form"); anything that looks like a network / service hiccup must be asked again next time.
const DETERMINISTIC_FAIL_RE = /^(?:name_unconfirmed|form_not_found)$/;
const TRANSIENT_FAIL_RE = /http_|timeout|empty_costs|creds|transport|unavailable|session_expired|abort/i;

/**
 * Keep a result for RX_CACHE_MS only when every plan row is final: verified (covered or not
 * covered) or failed deterministically. One plan's medicare_gov_http_0 used to be cached as
 * "not confirmed" for a day because another plan had answered (audit, 2026-10-09).
 */
function rxCacheable(value) {
  const rows = (value && value.lookups) || [];
  if (!rows.length) return false;
  return rows.every((l) => {
    if (l && l.verified) return true;
    const parts = String((l && l.reason) || '').split('|').filter(Boolean);
    return parts.some((r) => DETERMINISTIC_FAIL_RE.test(r)) && !parts.some((r) => TRANSIENT_FAIL_RE.test(r));
  });
}

// Brand drugs medicare.gov only prices with a strength ("Mounjaro" alone comes back empty on every plan — Evelyn
// Nieves, 2026-10-20). With no strength typed and no answer, retry the common starting strengths and flag the row
// "strength assumed — confirm dose".
const STARTING_STRENGTHS = {
  mounjaro: ['2.5 mg/0.5 mL', '5 mg/0.5 mL'],
  zepbound: ['2.5 mg/0.5 mL', '5 mg/0.5 mL'],
  ozempic: ['0.25 mg or 0.5 mg dose', '1 mg dose'],
  wegovy: ['0.25 mg/0.5 mL'],
  rybelsus: ['3 mg', '7 mg'],
  trulicity: ['0.75 mg/0.5 mL', '1.5 mg/0.5 mL'],
  repatha: ['140 mg/mL'],
  praluent: ['75 mg/mL'],
  jardiance: ['10 mg'],
  farxiga: ['10 mg'],
  eliquis: ['5 mg'],
  xarelto: ['20 mg'],
  januvia: ['100 mg'],
  entresto: ['24 mg-26 mg'],
};
const verifiedAny = (v) => Boolean(v && [...(v.lookups || []), ...Object.values(v.byPlanId || {})].some((l) => l && l.verified));
function startingStrengthsFor(drugName) {
  const t = String(drugName || '').trim();
  if (/\d/.test(t)) return []; // she typed a strength
  return STARTING_STRENGTHS[t.toLowerCase().replace(/\s+(?:pen|injection|tablets?|tabs?)$/, '')] || [];
}

async function lookupFormularyCached({ drugName, planIds, year }, { lookup = lookupFormulary } = {}) {
  const key = `${String(drugName).toLowerCase().trim()}|${year}|${[...planIds].sort().join(',')}`;
  const hit = rxCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  let value = await lookup({ drugName, planIds, year });
  if (!verifiedAny(value)) {
    for (const strength of startingStrengthsFor(drugName)) {
      const tried = await lookup({ drugName: `${drugName} ${strength}`, planIds, year }).catch(() => null);
      if (verifiedAny(tried)) {
        value = { ...tried, inputName: drugName, strengthAssumed: strength };
        break;
      }
    }
  }
  if (rxCacheable(value)) rxCache.set(key, { value, expiresAt: Date.now() + RX_CACHE_MS });
  return value;
}

// ─── jobs ───────────────────────────────────────────────────────────────────

const jobs = new Map();

// At most MAX_CONCURRENT comparisons run at once, across everyone. Carrier sites
// (Doctors, Devoted, UHC) are slow and throttle bursts, so extra clients wait their turn
// as status 'queued' with a position, and start automatically as a slot frees up.
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_COMPARE_CONCURRENCY || 2));
let activeRuns = 0;
const waiting = [];

function pumpQueue() {
  while (activeRuns < MAX_CONCURRENT && waiting.length) {
    const { job, deps } = waiting.shift();
    if (job.status !== 'queued') continue;
    activeRuns += 1;
    runJob(job, deps)
      .catch((e) => { job.status = 'error'; job.error = e.message; job.finishedAt = Date.now(); })
      .finally(() => { activeRuns -= 1; pumpQueue(); });
  }
}

function enqueueJob(job, deps) {
  waiting.push({ job, deps });
  pumpQueue();
}

function queuePosition(job) {
  if (job.status !== 'queued') return 0;
  const i = waiting.findIndex((w) => w.job === job);
  return i < 0 ? 0 : i + 1;
}

function queueState() {
  return { active: activeRuns, waiting: waiting.length, limit: MAX_CONCURRENT };
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
}

async function mapPool(items, limit, worker) {
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    queuePosition: queuePosition(job),
    error: job.error || null,
    input: job.input,
    progress: job.progress,
    result: job.result,
    startedAt: new Date(job.createdAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
}

const LEVELS = ['FBDE', 'QMB+', 'SLMB+', 'QMB', 'SLMB', 'QI', 'QDWI'];

function normalizeEligibility(e, noMedicaid) {
  const src = e && typeof e === 'object' ? e : {};
  const medicaid = noMedicaid ? 'none' : (['full', 'msp', 'none'].includes(src.medicaid) ? src.medicaid : 'unknown');
  const levels = medicaid === 'none' ? [] : (Array.isArray(src.levels) ? src.levels : []).map((l) => String(l).toUpperCase()).filter((l) => LEVELS.includes(l));
  const csnp = ['confirmed', 'none'].includes(src.csnp) ? src.csnp : 'unknown';
  return { medicaid, levels, csnp };
}

/** Agent-stated eligibility as plain words the selector reads back. */
function eligibilityText(e) {
  const parts = [];
  if (e.medicaid === 'none') parts.push('No Medicaid.');
  if (e.medicaid === 'full') parts.push(`Full Medicaid${e.levels.length ? ` (${e.levels.join(', ')})` : ''}.`);
  if (e.medicaid === 'msp') parts.push(e.levels.length ? `MSP only: ${e.levels.join(', ')}.` : 'MSP only.');
  if (e.csnp === 'confirmed') parts.push('C-SNP eligible.');
  if (e.csnp === 'none') parts.push('No C-SNP qualifying condition.');
  return parts.join(' ');
}

/**
 * The card's plan-type ask: a plan-type control's value ("PPO", "PPOs", "hmo only"), a plan-type ask typed in the
 * Plans field, or the card's ask text — read with the chat's reader (textPlanTypeAsk). { type, top } or null.
 */
function cardPlanTypeAsk(src, list) {
  const typed = typeof src.planType === 'string' ? textPlanTypeAsk(src.planType) : null;
  const inPlans = textPlanTypeAsk(list(src.plans).map((p) => String(p || '').trim()).filter((p) => p && !/^[HR]\d{4}-\d{3}[A-Z]?$/i.test(p)).join('\n'));
  const inAsk = typeof src.ask === 'string' ? textPlanTypeAsk(src.ask) : null;
  const a = typed || inPlans || inAsk;
  if (!a) return null;
  const top = Number(src.planTop);
  return { type: a.type, top: Number.isInteger(top) && top >= 1 && top <= 5 ? top : a.top };
}

/** Her current plan on the card: the one(s) she called current, else the single plan she typed (same as chat). */
function cardCurrentPlans(input) {
  const typed = input.plans || [];
  const said = (input.currentPlans || []).filter((id) => typed.some((x) => x.slice(0, 9) === id.slice(0, 9)));
  return said.length ? said : typed.length === 1 ? typed.slice() : [];
}

function normalizeInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => (Array.isArray(v) ? v : splitList(v));
  const typeAsk = cardPlanTypeAsk(src, list);
  const doctors = list(src.doctors).map((d) => (typeof d === 'string' ? { name: d } : d))
    .filter((d) => d && String(d.name || d.npi || '').trim())
    .map((d) => ({ name: String(d.name || d.npi).trim(), npi: d.npi ? String(d.npi) : undefined, mustKeep: Boolean(d.mustKeep) }))
    .slice(0, MAX_DOCTORS);
  const meds = expandMedList(list(src.meds).map((m) => String(m || '').trim()).filter(Boolean)).slice(0, MAX_MEDS);
  const plans = list(src.plans).map((p) => String(p || '').trim().toUpperCase()).filter((p) => /^[HR]\d{4}-\d{3}[A-Z]?$/.test(p)).slice(0, MAX_PLANS);
  return {
    clientName: String(src.clientName || '').trim().slice(0, 80),
    zip: String(src.zip || '').trim().slice(0, 5),
    doctors,
    meds,
    plans,
    terminatingPlan: String(src.terminatingPlan || '').trim().toUpperCase(),
    noMedicaid: Boolean(src.noMedicaid),
    wantsAlternatives: Boolean(src.wantsAlternatives),
    carriers: list(src.carriers).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 8),
    eligibility: normalizeEligibility(src.eligibility, Boolean(src.noMedicaid)),
    skip: list(src.skip).map((s) => String(s).toUpperCase()),
    year: Number(src.year) === 2026 ? 2026 : 2027,
    // Plan-type ask ('ppo' / 'hmo', '' = none) and how many to rank (top N, 5 by default).
    planType: typeAsk ? typeAsk.type : '',
    planTop: typeAsk ? typeAsk.top : 0,
    currentPlans: list(src.currentPlans).map((p) => String(p || '').trim().toUpperCase()).filter((p) => /^[HR]\d{4}-\d{3}[A-Z]?$/.test(p)).slice(0, MAX_PLANS),
    // Plans she just added to an existing set: never trimmed off the grid (doctorPlanNarrow "Plans she added:").
    addedPlans: list(src.addedPlans).map((p) => String(p || '').trim().toUpperCase()).filter((p) => /^[HR]\d{4}-\d{3}[A-Z]?$/.test(p)).slice(0, MAX_PLANS),
    planNames: src.planNames && typeof src.planNames === 'object'
      ? Object.fromEntries(Object.entries(src.planNames).slice(0, 10).map(([k, v]) => [String(k).toUpperCase(), String(v || '').slice(0, 80)]))
      : {},
  };
}

/** Plain text of the job inputs, for the doctor/plan helpers that read the ask. */
function askTextFor(input) {
  const parts = [];
  if (input.clientName) parts.push(input.clientName);
  if (input.zip) parts.push(`ZIP ${input.zip}`);
  if (input.terminatingPlan) parts.push(`Current plan ${input.terminatingPlan} terminating ${input.year}.`);
  if (input.noMedicaid) parts.push('No Medicaid.');
  else if (input.eligibility) parts.push(eligibilityText(input.eligibility));
  for (const id of input.skip) parts.push(`Skip ${id}.`);
  // A plan-type ask: the chat's own ask lines (doctorPlanNarrow.planTypeAskLines) — her current plan, the plans she
  // named after it, rank that type only — so the card and the chat pick the same columns for the same ask.
  if (input.planType === 'ppo' || input.planType === 'hmo') {
    const current = cardCurrentPlans(input);
    const include = input.plans.filter((id) => !current.some((c) => c.slice(0, 9) === id.slice(0, 9)));
    const block = planTypeAskLines({ type: input.planType, top: input.planTop || 5 }, { current, include });
    return [...(block.current ? [block.current] : []), parts.join(' '), ...block.lines, planTypeLineFor(input.planType)].join('\n');
  }
  if (input.plans.length) parts.push(`Compare ${input.plans.join(', ')}.`);
  if ((input.carriers || []).length) parts.push(`Carriers requested: ${input.carriers.join(', ')}.`);
  const text = parts.join(' ');
  return (input.addedPlans || []).length ? `${text}\nPlans she added: ${input.addedPlans.join(', ')}.` : text;
}

async function runJob(job, { lookupOneDoctor = lookupDoctor, lookupRx = lookupFormularyCached } = {}) {
  const input = job.input;
  const askText = askTextFor(input);
  try {
    // 1) Doctors — all at once; progress ticks as each one finishes.
    job.status = 'doctors';
    const deadlineAt = Date.now() + DOCTOR_BUDGET_MS;
    const doctorStructs = await Promise.all(input.doctors.map(async (d) => {
      let r;
      try {
        r = await lookupOneDoctor({ doctorName: d.name, npi: d.npi, zip: input.zip, year: input.year }, { deadlineAt, npiCap: 2 });
      } catch (e) {
        r = { status: 'error', doctorName: d.name, structured: { doctorName: d.name, networks: [] } };
      }
      job.progress.doctors.done += 1;
      return { ...(r.structured || {}), requestedName: d.name, ...(d.npi ? { requestedNpi: d.npi } : {}), status: r.status, mustKeep: Boolean(d.mustKeep) };
    }));
    // A doctor that ran out of time: the card is a background job (no browser wait), so it gets more time — re-checked
    // once (the unfinished lookup kept running into the cache) before the table is drawn. Only what is still unfinished
    // after that shows "⏱ timed out" (same cells as the chat).
    const slow = doctorStructs.map((d, k) => (d.status === 'timeout' || (d.status === 'partial' && (d.pending || []).length) ? k : -1)).filter((k) => k >= 0);
    if (slow.length && CARD_RECHECK_MS > 0) {
      job.status = 'rechecking';
      job.progress.recheck = { total: slow.length, done: 0 };
      const until = Date.now() + CARD_RECHECK_MS;
      await Promise.all(slow.map(async (k) => {
        const d = input.doctors[k];
        try {
          const r = await lookupOneDoctor({ doctorName: d.name, npi: d.npi, zip: input.zip, year: input.year }, { deadlineAt: until, npiCap: 2, background: true });
          if (r && r.status !== 'timeout') doctorStructs[k] = { ...(r.structured || {}), requestedName: d.name, ...(d.npi ? { requestedNpi: d.npi } : {}), status: r.status, mustKeep: Boolean(d.mustKeep) };
        } catch (_) { /* keep the timed-out row */ }
        job.progress.recheck.done += 1;
      }));
      job.result.rechecked = slow.length;
    }
    // Same doctor-set rules as the chat (loadedWorkup.js): one row per NPI; a look-alike without an NPI is asked about.
    const dedupedDoctors = dedupeDoctorRows(doctorStructs);
    doctorStructs.splice(0, doctorStructs.length, ...dedupedDoctors);
    job.result.doctors = doctorStructs;

    // 2) + 3) Plans and meds — Doctor/Drug Comparison Table Rules (doctorPlanNarrow.selectComparison).
    // Named plans stay the columns. Otherwise: eligible county pool → rank → top 3, with
    // every listed med priced on the shortlist first so drug cost can break ties and every
    // table plan already has its meds checked (rules 3 + 8).
    // A plan-type ask ranks the county's plans of that type exactly like the chat (renderedAnswer → selectComparison
    // with no named / pinned set): her current plan and named plans come from the ask lines (askTextFor).
    const typeMode = input.planType === 'ppo' || input.planType === 'hmo';
    const named = typeMode ? [] : input.plans.map((id) => ({ planId: id, name: (input.planNames && input.planNames[id]) || id }));
    // Her plan(s) + "is there something better?": keep them as the first column and shop the county for the rest.
    const pinned = named.length && (input.wantsAlternatives || (input.carriers || []).length) ? named.map((p) => p.planId) : [];
    const planSource = typeMode ? `plan_type_${input.planType}` : pinned.length ? 'current_plus_alternatives' : named.length ? 'named' : 'top_doctor_coverage';
    let rxPlanIds = named.map((p) => p.planId);
    if (typeMode) {
      // Every plan that can be a column is priced before the final pick (the type's columns + the ranked shortlist).
      const first = selectComparison(doctorStructs, askText, { meds: input.meds });
      rxPlanIds = [...new Set([...first.columns.map((c) => c.planId), ...first.ranked.slice(0, RX_SHORTLIST).map((c) => c.planId)])];
    } else if (!named.length || pinned.length) {
      const first = selectComparison(doctorStructs, askText, { named: [], meds: input.meds });
      rxPlanIds = [...new Set([...pinned, ...first.ranked.slice(0, RX_SHORTLIST).map((c) => c.planId)])];
    }

    job.status = 'meds';
    job.progress.meds.total = rxPlanIds.length ? input.meds.length : 0;
    const drugResults = new Array(input.meds.length);
    if (rxPlanIds.length && input.meds.length) {
      // The meds have their own budget: a formulary lookup that never answers drew "Checking meds 0/5" forever (Martha
      // Muraglia, 2026-10-20). Past it the med is "⏱ timed out" (never a final answer, never ranked by cost).
      const medsUntil = Date.now() + CARD_MEDS_BUDGET_MS;
      await mapPool(input.meds, DRUG_CONCURRENCY, async (drugName, i) => {
        try {
          const left = medsUntil - Date.now();
          if (left <= 0) throw Object.assign(new Error('timed out'), { timedOut: true });
          let timer;
          drugResults[i] = await Promise.race([
            Promise.resolve().then(() => lookupRx({ drugName, planIds: rxPlanIds, year: input.year })),
            new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timed out'), { timedOut: true })), left); }),
          ]).finally(() => clearTimeout(timer));
        } catch (e) {
          drugResults[i] = e && e.timedOut
            ? { drugName, error: 'timed out', timedOut: true, lookups: [], byPlanId: {} }
            : { drugName, error: e.message, lookups: [], byPlanId: {} };
        }
        job.progress.meds.done += 1;
      });
    }
    const drugs = drugResults.filter(Boolean);

    // No onlyPlanIds on a plan-type ask: the shortlist changed which plans count as "all of that type" and filled the
    // table with 0-In plans. Same call as the chat; its columns are the first pass's, all priced above.
    const sel = selectComparison(doctorStructs, askText, typeMode
      ? { meds: input.meds, drugs }
      : pinned.length
        ? { named: [], meds: input.meds, drugs, onlyPlanIds: rxPlanIds, pinPlanIds: pinned }
        : { named, meds: input.meds, drugs, onlyPlanIds: named.length ? undefined : rxPlanIds });
    // Compare-mode headers use the grid marketing names the UI sent.
    const columns = sel.columns.map((c) => ({ ...c, name: (input.planNames && input.planNames[c.planId]) || c.name }));
    const planIds = columns.map((c) => c.planId);
    job.result.planIds = planIds;
    // The card's "Plans:" line lists the grid's columns, not only the plan she typed (Edward Kennedy, 2026-10-17:
    // the grid had 3 plans and the card still said "Plans: H5420-001").
    job.result.planLabels = columns.map((c) => {
      const nm = String(c.name || '').replace(/\s*\*\*.*$/, '').trim();
      return nm && nm.toUpperCase() !== c.planId ? `${nm} (${c.planId})` : c.planId;
    });
    job.result.planSource = planSource;
    job.result.drugs = drugs.map((r) => ({
      drugName: r.drugName,
      byPlanId: r.byPlanId || {},
      notCoveredNote: r.notCoveredNote || null,
      ...(r.timedOut ? { timedOut: true } : {}),
      retriedProduct: r.retriedProduct || null,
      export: toExportDrugs(r),
      text: r.lookups ? formatFormularyText(r).slice(0, 1500) : `${r.drugName}: lookup failed (${r.error || 'unknown'})`,
    }));

    // 4) Tables (same look as chat) + the rule lines the UI shows above / below them.
    job.result.header = sel.header;
    // No "Why these plans" line in the result: the UI rendered it above the grid (Robin Forte, 2026-10-17 — PR #232
    // removed it from chat only). The selection reason is kept for logs/tests, never shown.
    job.result.selection = String(sel.whyLine || '').replace(/^Why these plans:\s*/i, '');
    job.result.doctorCount = input.doctors.length;
    job.result.doctorTable = gridTable(sel.doctors, columns);
    const medsFull = medsTable(drugs, columns, input.meds);
    job.result.medsTable = quietRestrictionMarks(medsFull);
    job.result.legend = LEGEND + (columns.some((p) => (p.inCarrier || []).length) ? ` · ${IN_STAR_LEGEND}` : '');
    job.result.medsLegend = medsLegendFor(medsFull);
    // Every lookup failed: the table carries the banner, and the UI shows it in red.
    job.result.medsLookupFailed = require('./doctorPlanNarrow').allDrugLookupsFailed(drugs); // same rule as the chat
    job.result.medsBanner = job.result.medsLookupFailed ? MEDS_FAILED_BANNER.replace(/\*\*/g, '') : null;
    // "⏱ 2 doctor checks ran out of time — …" above the table (same line as the chat).
    job.result.timedOutNote = require('./doctorPlanNarrow').timedOutNote(doctorStructs, drugs, { recheck: false }) || null;
    // Only plans in the grid get a "Could not verify" note: a county plan that was never shown (H1035-017 under Tony
    // and Gerry Cabrera's UHC / DrMax / Humana grid, 2026-10-19) is not part of her comparison.
    const cnvShown = (sel.couldNotVerify || []).filter((c) => planIds.some((id) => id.slice(0, 9) === String(c.planId).slice(0, 9)));
    job.result.couldNotVerify = {
      count: cnvShown.length,
      plans: cnvShown.slice(0, 3).map((c) => ({ planId: c.planId, name: c.name })),
    };
    job.result.sameNetwork = sel.sameNetwork.map((x) => ({ planId: x.plan.planId, name: x.plan.name, sameAs: x.twin.planId, diff: x.diff }));
    job.result.flags = [...sel.flags, ...strengthNotes(drugs, planIds)];
    job.result.questions = [...(sel.questions || []), ...duplicateQuestions(sel.doctors || doctorStructs).filter((q) => !(sel.questions || []).includes(q))];
    job.result.notConfirmed = doctorStructs.filter((d) => !['done', 'partial'].includes(d.status)).map((d) => d.requestedName);
    // toolResults in the shape the Excel/PDF export already reads.
    job.result.toolResults = [
      ...doctorStructs.map((d) => ({ tool: 'lookup_provider_network', output: d })),
      ...drugs.map((r) => ({ tool: 'lookup_formulary', output: { ...r, drug: toExportDrug(r), drugs: toExportDrugs(r) } })),
    ];
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  } finally {
    job.finishedAt = Date.now();
  }
}

function createJob(rawInput, owner, deps) {
  sweep();
  const input = normalizeInput(rawInput);
  if (!input.doctors.length && !input.meds.length) {
    const err = new Error('Add at least one doctor or medication.');
    err.status = 400;
    throw err;
  }
  if (!input.zip) {
    const err = new Error('ZIP is required for doctor network checks.');
    err.status = 400;
    throw err;
  }
  const job = {
    id: crypto.randomBytes(9).toString('hex'),
    owner: String(owner || ''),
    createdAt: Date.now(),
    finishedAt: null,
    status: 'queued',
    input,
    progress: { doctors: { done: 0, total: input.doctors.length }, meds: { done: 0, total: input.meds.length } },
    result: {},
  };
  jobs.set(job.id, job);
  enqueueJob(job, deps);
  return job;
}

function getJob(id, owner) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.owner && owner && job.owner !== String(owner)) return null;
  return job;
}

module.exports = {
  parseCompareAsk,
  doctorMentions,
  titledDoctorNames,
  normalizeInput,
  askTextFor,
  cardCurrentPlans,
  createJob,
  getJob,
  publicJob,
  runJob,
  normalizeInput,
  queueState,
  lookupFormularyCached,
  startingStrengthsFor,
  rxCacheable,
  NOT_CONFIRMED,
};
