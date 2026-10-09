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

const ROUTES = ['oral', 'external', 'injection', 'subcutaneous', 'intravenous', 'intramuscular', 'ophthalmic', 'otic',
  'nasal', 'inhalation', 'rectal', 'vaginal', 'transdermal', 'sublingual', 'buccal', 'urethral/mucosal', 'topical'];
const FORMS = ['tablet', 'capsule', 'solution', 'suspension', 'syrup', 'liquid', 'ointment', 'cream', 'gel', 'lotion',
  'patch', 'packet', 'powder', 'aerosol', 'film', 'spray', 'drops', 'kit', 'pen', 'injector'];
const STRENGTH_RE = /(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)*)\s*(mg|mcg|gm|g|ml|%|unit|units|meq)\b/gi;

function strengthsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(STRENGTH_RE)) {
    const unit = m[2].toLowerCase().replace(/^gm$/, 'g').replace(/^units$/, 'unit');
    out.push(`${m[1].split('-').map(Number).join('-')} ${unit}`);
  }
  return out;
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
  };
}

/** What the priced product is: "esomeprazole 20 MG Delayed Release Oral Capsule" or the agent's words. */
function parseQuery({ drugName = '', productName = '', strength = null, indication = null }) {
  const src = String(productName || drugName || '').toLowerCase();
  const all = `${src} ${String(drugName || '').toLowerCase()}`;
  const words = src.replace(/\[.*?\]|\(.*?\)/g, ' ').replace(STRENGTH_RE, ' ').split(/[\s/]+/).filter(Boolean);
  const stop = new Set([...ROUTES, ...FORMS, 'delayed', 'extended', 'release', 'pulmonary', 'hypertension', 'hr', 'er', 'dr', 'tab', 'tabs', 'cap', 'caps', 'topical']);
  const ingredient = words.find((w) => !stop.has(w) && /^[a-z]/.test(w)) || '';
  const form = /\btab(let)?s?\b/.test(all) ? 'tablet' : /\bcap(sule)?s?\b/.test(all) ? 'capsule'
    : FORMS.find((f) => new RegExp(`\\b${f}s?\\b`).test(all)) || null;
  const route = /\b(?:ointment|cream|gel|lotion|topical)\b/.test(all) ? 'external' : /\b(?:ophthalmic|eye)\b/.test(all) ? 'ophthalmic' : 'oral';
  return {
    ingredient,
    // RxNorm branded product "apixaban 5 MG Oral Tablet [Eliquis]": the book lists it as "ELIQUIS …".
    brand: ((String(productName || '').match(/\[([^\]]+)\]/) || [])[1] || '').toLowerCase().split(/\s+/)[0] || null,
    form,
    route,
    release: /extended release|\b(?:er|xr|xl)\b/.test(all) ? 'er' : /delayed release|\bdr\b/.test(all) ? 'dr' : null,
    pah: /\b(?:pah|pulmonary hypertension)\b/.test(all) || /^pah$/i.test(String(indication || '')),
    strengths: strength ? strengthsIn(strength) : strengthsIn(productName || drugName),
  };
}

const signature = (r) => [r.pa, r.st, r.qlText || r.ql, r.bdPa, r.hrm, r.ed].join('|');

/**
 * PA / ST / QL for one drug on a HealthSun plan, or null when the book has no row for that
 * product (at that strength), or its candidate rows disagree.
 */
function healthsunRestrictions(query, planId, year) {
  const idx = loadIndex();
  if (!idx || !isHealthSunFormularyPlan(planId, year)) return null;
  const q = parseQuery(query || {});
  if (!q.ingredient) return null;
  let cands = idx.parsed.filter((p) => (p.first === q.ingredient || (q.brand && p.first === q.brand)) && !p.otc);
  // Same route (an ointment row never answers for the tablet); rows without a route are oral-ish.
  cands = cands.filter((p) => (p.route ? p.route === q.route : q.route === 'oral'));
  if (q.form) cands = cands.filter((p) => !p.form || p.form === q.form);
  cands = cands.filter((p) => (q.release ? !p.release || p.release === q.release : p.release !== 'er'));
  cands = cands.filter((p) => p.pah === q.pah);
  if (cands.some((p) => p.rx)) cands = cands.filter((p) => p.rx || !cands.some((x) => x.rx && x.base === p.base));
  if (q.strengths.length) {
    const exact = cands.filter((p) => p.strengths.length && q.strengths.every((s) => p.strengths.includes(s)));
    const generic = cands.filter((p) => !p.strengths.length);
    cands = exact.length ? exact : generic;
  }
  if (!cands.length) return null;
  if (new Set(cands.map((p) => signature(p.row))).size > 1) return null;
  const r = cands[0].row;
  return {
    pa: r.pa,
    st: r.st,
    ql: r.ql,
    qlText: r.qlText || null,
    bdPa: r.bdPa,
    hrm: r.hrm,
    excludedDrug: r.ed || false,
    // The book prints the indication on the row ("tadalafil (pah)") — never inferred from PA.
    indication: cands[0].pah ? 'PAH' : null,
    pdfTier: r.tier,
    matchedName: r.name,
    source: `HealthSun 2027 formulary PDF (updated ${idx.asOf}, ID ${idx.formularyId} v${idx.version})`,
  };
}

module.exports = { healthsunRestrictions, isHealthSunFormularyPlan, parseQuery, INDEX_PATH, _loadIndex: loadIndex };
