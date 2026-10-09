/**
 * Solis Health Plans (H0982) 2027 drug formulary — Solis is not on Sunfire and has no
 * consumer formulary API Max can call, so Solis drug cells came back "not confirmed".
 *
 * data/solis-formulary-2027.json is built from Solis's published Comprehensive Formulary PDF
 * (H0982_formulary27_C) by scripts/build_solis_formulary.py. One tier per drug, plan-wide:
 * the book covers every H0982 plan, so a hit is plan-level for any Solis plan that year.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'solis-formulary-2027.json');
const SALTS = /\s+(?:hcl|hydrochloride|besylate|calcium|magnesium|sodium|potassium|sulfate|succinate|tartrate|maleate|mesylate|fumarate|citrate|acetate|phosphate)$/i;

let index;
function loadIndex() {
  if (index === undefined) {
    try { index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { index = null; }
  }
  return index;
}

function isSolisPlan(planId) {
  return /^H0982/i.test(String(planId || '').trim());
}

/** Same shapes the builder indexed: full name, brand, generic, generic without its salt. */
function keysFor(drugName) {
  const base = String(drugName || '').toLowerCase().replace(/[*^#†‡]+/g, '').replace(/\s+/g, ' ').trim();
  if (!base) return [];
  const out = [base];
  const noDose = base.replace(/\b\d[\d.,/-]*\s*(?:mg|mcg|g|ml|%).*$/i, '').trim();
  if (noDose && noDose !== base) out.push(noDose);
  for (const k of [...out]) {
    const bare = k.replace(SALTS, '').trim();
    if (bare && bare !== k) out.push(bare);
    if (k.includes('-')) {
      const parts = k.split('-').map((p) => p.replace(SALTS, '').trim()).filter(Boolean);
      if (parts.length > 1) out.push(parts.join('-'));
    }
  }
  return [...new Set(out)].filter((k) => k.length > 2);
}

const STRENGTH_RE = /(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|%|unit)\b/i;

/** "2.5 mg" from "tadalafil tab 2.5 mg", or null. */
function strengthOf(name) {
  const m = String(name || '').match(STRENGTH_RE);
  return m ? `${Number(m[1])} ${m[2].toLowerCase()}` : null;
}

/** "QL (8 tablets/30 days)" → "QL 8/30". */
function qlShort(req) {
  const m = String(req || '').match(/QL\s*\((\d+)\s*\w+\s*\/\s*(\d+)\s*days?\)/i);
  return m ? `QL ${m[1]}/${m[2]}` : null;
}

/**
 * One book row as a lookup hit. The PDF's symbol table (p. 25): "^ This prescription drug is not
 * normally covered in a Medicare Prescription Drug Plan. The amount you pay … does not count
 * towards your total drug costs" — an excluded drug covered as a supplemental benefit (Tier 6
 * "Supplemental Drugs"). An indication is said only when the row prints it ("(pah)").
 */
function hitFromRow(hit, idx) {
  const req = String(hit.req || '');
  return {
    verified: true,
    tier: hit.tier,
    coverage: 'covered',
    pa: /\bPA\b/.test(req),
    st: /\bST\b/.test(req),
    ql: /\bQL\b/.test(req),
    qlText: qlShort(req),
    matchedName: hit.name,
    strength: strengthOf(hit.name),
    ...(/\^/.test(hit.name) ? { excludedDrug: true } : {}),
    ...(/\((?:pah|bph)\)/i.test(hit.name) ? { indication: hit.name.match(/\((pah|bph)\)/i)[1].toUpperCase() } : {}),
    source: `Solis 2027 Comprehensive Formulary PDF${idx.asOf ? ` (updated ${idx.asOf})` : ''}`,
  };
}

/** Every book row for the drug's base name, one per product ("tadalafil tab 2.5 mg", "… 10 mg^", "… 20 mg (pah)"). */
function rowsForDrug(drugName, idx) {
  const base = String(drugName || '').toLowerCase().replace(STRENGTH_RE, ' ').replace(/\((?:pah|bph)\)|\b(?:pah|bph)\b/g, ' ')
    .replace(/\b(?:tabs?|tablets?|caps?|capsules?)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base || !idx || !idx.drugs) return [];
  const seen = new Set();
  const out = [];
  for (const hit of Object.values(idx.drugs)) {
    const name = String(hit.name || '').toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const clean = name.replace(/[*^#†‡]+/g, '');
    if (!(clean === base || clean.startsWith(`${base} `))) continue;
    if (!strengthOf(clean)) continue;
    out.push(hit);
  }
  return out;
}

/**
 * Tier for one drug on a Solis plan, or null when the plan is not Solis, the year is not the
 * indexed one, or the drug is not in the book. A miss here is "not covered" per the published
 * formulary — the caller decides how to say that; it is never an invented tier.
 * A strength she typed must match that row ("tadalafil 10 mg" is the T6 row, never the 2.5 mg one).
 */
function solisFormularyLookup(drugName, planId, year) {
  const idx = loadIndex();
  if (!idx || !isSolisPlan(planId)) return null;
  if (idx.year && Number(year) && Number(year) !== Number(idx.year)) return null;
  const asked = strengthOf(drugName);
  if (asked) {
    const rows = rowsForDrug(drugName, idx).filter((h) => strengthOf(h.name) === asked);
    // Plain product first; the "(pah)" product only when she asked for it.
    const pick = rows.find((h) => /\((?:pah|bph)\)/i.test(h.name) === /\b(?:pah|bph)\b/i.test(drugName)) || rows[0];
    return pick ? hitFromRow(pick, idx) : null;
  }
  for (const key of keysFor(drugName)) {
    const hit = idx.drugs && idx.drugs[key];
    if (hit) return hitFromRow(hit, idx);
  }
  return null;
}

/**
 * Every strength the book lists for a drug on a Solis plan (no strength asked): oral tablets and
 * capsules only (never "acyclovir sodium iv soln 50 mg/ml" or a suspension), the asked form when
 * she named one, and no ER / ODT / chewable / buccal product unless she asked for it.
 */
function solisStrengthVariants(drugName, planId, year, askedForm = null) {
  const idx = loadIndex();
  if (!idx || !isSolisPlan(planId)) return [];
  if (idx.year && Number(year) && Number(year) !== Number(idx.year)) return [];
  const asked = String(drugName || '').toLowerCase();
  const formRe = askedForm === 'tablet' ? /\btab\b/ : askedForm === 'capsule' ? /\bcap\b/ : /\b(?:tab|cap)\b/;
  return rowsForDrug(drugName, idx)
    .filter((h) => {
      const n = String(h.name || '').toLowerCase();
      if (!formRe.test(n) || /\b(?:iv|inj|soln|susp|oint|cream|gel|patch)\b|\/\s*ml\b/.test(n)) return false;
      for (const w of ['er', 'xr', 'odt', 'chew', 'buccal', '24hr', '12hr']) {
        if (new RegExp(`\\b${w}\\b`).test(n) && !new RegExp(`\\b${w}\\b`).test(asked)) return false;
      }
      return true;
    })
    .map((h) => hitFromRow(h, idx));
}

// ─── PA / ST / QL for the product medicare.gov priced (same matching as HealthSun) ─────────────

const { strengthsIn, matchRows } = require('./formularyRowMatch');

// The book abbreviates: "tab", "cap", "oint", "susp", "soln", "iv soln", "ophth".
const SOLIS_FORMS = [['tablet', /\b(?:tab|tabs|chew)\b/], ['capsule', /\bcap\b/], ['ointment', /\boint\b/], ['cream', /\bcream\b/],
  ['gel', /\bgel\b/], ['lotion', /\blotion\b/], ['suspension', /\bsusp\b/], ['solution', /\b(?:soln|sol)\b/], ['syrup', /\bsyrup\b/],
  ['patch', /\bpatch\b/], ['spray', /\bspray\b/], ['aerosol', /\baero\b/], ['pen', /\bpen\b/], ['kit', /\bkit\b/]];

function solisRoute(n) {
  if (/\b(?:iv|inj)\b/.test(n)) return 'injection';
  if (/\bophth\b/.test(n)) return 'ophthalmic';
  if (/\botic\b/.test(n)) return 'otic';
  if (/\bnasal\b/.test(n)) return 'nasal';
  if (/\b(?:aero|inh)\b/.test(n)) return 'inhalation';
  if (/\b(?:oint|cream|gel|lotion|patch)\b/.test(n)) return 'external';
  return 'oral';
}

function parseSolisRow(hit) {
  const raw = String(hit.name || '').toLowerCase();
  const name = raw.replace(/[*^#†‡]+/g, '');
  // "SKYLA - levonorgestrel releasing iud …": brand first, the generic after " - ".
  const [head, generic] = name.split(/\s+-\s+/);
  const req = String(hit.req || '');
  const qlText = qlShort(req);
  return {
    row: hit,
    first: (head.match(/^[a-z][a-z'’-]*/) || [''])[0],
    alt: generic ? (generic.match(/^[a-z][a-z'’-]*/) || [''])[0] : null,
    base: head.replace(STRENGTH_RE, ' ').replace(/\s+/g, ' ').trim(),
    route: solisRoute(name),
    form: (SOLIS_FORMS.find(([, re]) => re.test(name)) || [null])[0],
    release: /\b(?:er|24hr|12hr|extended release)\b/.test(name) ? 'er' : /\b(?:dr|ec|delayed release)\b/.test(name) ? 'dr' : null,
    otc: false,
    rx: false,
    pah: /\((?:pah)\)/.test(name),
    strengths: strengthsIn(name),
    flags: {
      pa: /\bPA\b/.test(req),
      st: /\bST\b/.test(req),
      ql: /\bQL\b/.test(req),
      qlText,
      bdPa: /\bBD\b|B\/D/.test(req),
      hrm: false,
      // "^" = "not normally covered in a Medicare Prescription Drug Plan" (Tier 6 Supplemental Drugs, p. 25).
      ed: /\^/.test(raw),
    },
  };
}

let parsedRows = null;
function solisParsedRows() {
  if (parsedRows) return parsedRows;
  const idx = loadIndex();
  const seen = new Set();
  parsedRows = [];
  for (const hit of Object.values((idx && idx.drugs) || {})) {
    if (seen.has(hit.name)) continue;
    seen.add(hit.name);
    parsedRows.push(parseSolisRow(hit));
  }
  return parsedRows;
}

/**
 * The Solis book's row for the product medicare.gov priced (or the agent's words): tier and
 * PA / ST / QL. null when no row matches that product / strength, or candidate rows disagree.
 */
function solisRestrictions(query, planId, year) {
  const idx = loadIndex();
  if (!idx || !isSolisPlan(planId)) return null;
  if (idx.year && Number(year) && Number(year) !== Number(idx.year)) return null;
  const hit = matchRows(solisParsedRows(), query);
  if (!hit) return null;
  const f = hit.flags;
  return {
    pa: f.pa,
    st: f.st,
    ql: f.ql,
    qlText: f.qlText,
    bdPa: f.bdPa,
    hrm: false,
    excludedDrug: f.ed,
    indication: hit.pah ? 'PAH' : null,
    pdfTier: hit.row.tier,
    matchedName: hit.row.name,
    source: `Solis 2027 Comprehensive Formulary PDF${idx.asOf ? ` (updated ${idx.asOf})` : ''}`,
  };
}

module.exports = { solisFormularyLookup, solisStrengthVariants, solisRestrictions, strengthOf, isSolisPlan, keysFor, INDEX_PATH };
