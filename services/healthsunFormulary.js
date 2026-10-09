/**
 * HealthSun (H5431) 2027 formulary — PA / ST / QL only.
 *
 * medicare.gov prices HealthSun plans but never reports prior auth / step therapy / quantity
 * limits, so every HealthSun cell read "PA/QL ?". data/healthsun-formulary-2027.json is built from
 * HealthSun's bilingual formulary PDF (HPMS formulary ID 27026) by
 * scripts/build_healthsun_formulary.py. The book lists the plans it covers; it answers only for those.
 *
 * Tier and cost stay medicare.gov's. A medicare.gov "not covered" is never overridden. No matching
 * row (or rows that disagree) → null, and the cell keeps "PA/QL ?" — a missing row is never "none".
 * A row whose only requirements are MO / 90D / 100D means no PA / ST / QL (known), as with Solis.
 */

const fs = require('fs');
const path = require('path');

const { ROUTES, FORMS, strengthsIn, parseQuery, matchRows } = require('./formularyRowMatch');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'healthsun-formulary-2027.json');

let index;
function loadIndex() {
  if (index === undefined) {
    try {
      index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
      index.parsed = (index.rows || []).map(parseRow);
    } catch {
      index = null;
    }
  }
  return index;
}

/** One of the plans the book says it covers (H5431-001 … -026), for its year. */
function isHealthSunFormularyPlan(planId, year) {
  const idx = loadIndex();
  if (!idx) return false;
  if (idx.year && Number(year) && Number(year) !== Number(idx.year)) return false;
  const base = String(planId || '').trim().toUpperCase().slice(0, 9);
  return (idx.plans || []).includes(base);
}

function parseRow(row) {
  const name = String(row.name || '');
  const lower = name.toLowerCase();
  const words = lower.replace(/\(.*?\)/g, ' ').split(/\s+/).filter(Boolean);
  const routeAt = words.findIndex((w) => ROUTES.includes(w));
  const baseWords = (routeAt >= 0 ? words.slice(0, routeAt) : words).filter((w) => !/^\d/.test(w));
  const rest = routeAt >= 0 ? words.slice(routeAt + 1).join(' ') : '';
  return {
    row,
    lower,
    first: baseWords[0] || '',
    base: baseWords.join(' '),
    route: routeAt >= 0 ? (words[routeAt] === 'topical' ? 'external' : words[routeAt]) : null,
    form: FORMS.find((f) => new RegExp(`\\b${f}s?\\b`).test(rest)) || null,
    release: /extended release|\ber\b/.test(lower) ? 'er' : /delayed release|\bdr\b/.test(lower) ? 'dr' : null,
    otc: /\(otc\)/.test(lower),
    rx: /\(rx\)/.test(lower),
    pah: /\(pah\)/.test(lower),
    strengths: strengthsIn(lower),
    flags: { pa: row.pa, st: row.st, ql: row.ql, qlText: row.qlText, bdPa: row.bdPa, hrm: row.hrm, ed: row.ed },
  };
}

/**
 * PA / ST / QL for one drug on a HealthSun plan, or null when the book has no row for that
 * product (at that strength), or its candidate rows disagree.
 */
function healthsunRestrictions(query, planId, year) {
  const idx = loadIndex();
  if (!idx || !isHealthSunFormularyPlan(planId, year)) return null;
  const hit = matchRows(idx.parsed, query);
  if (!hit) return null;
  const r = hit.row;
  return {
    pa: r.pa,
    st: r.st,
    ql: r.ql,
    qlText: r.qlText || null,
    bdPa: r.bdPa,
    hrm: r.hrm,
    excludedDrug: r.ed || false,
    // The book prints the indication on the row ("tadalafil (pah)") — never inferred from PA.
    indication: hit.pah ? 'PAH' : null,
    pdfTier: r.tier,
    matchedName: r.name,
    source: `HealthSun 2027 formulary PDF (updated ${idx.asOf}, ID ${idx.formularyId} v${idx.version})`,
  };
}

module.exports = { healthsunRestrictions, isHealthSunFormularyPlan, parseQuery, INDEX_PATH, _loadIndex: loadIndex };
