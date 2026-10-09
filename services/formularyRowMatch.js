/**
 * Match the product a plan was priced on to one row of a carrier's formulary book (HealthSun,
 * Solis). Both readers parse their rows into the same shape; this decides which row answers.
 *
 * Inputs: the RxNorm product medicare.gov priced ("esomeprazole 20 MG Delayed Release Oral Capsule",
 * "apixaban 5 MG Oral Tablet [Eliquis]") and/or the agent's words ("acyclovir ointment",
 * "rosuvastatin 10 mg"). Same ingredient (or RxNorm brand), same route, same form, same release
 * type, PAH only for a PAH ask, Rx over OTC, the typed / priced strength. No row, or candidate rows
 * whose restrictions disagree → null: the cell keeps "PA/QL ?", never "no restrictions".
 */

const ROUTES = ['oral', 'external', 'injection', 'subcutaneous', 'intravenous', 'intramuscular', 'ophthalmic', 'otic',
  'nasal', 'inhalation', 'rectal', 'vaginal', 'transdermal', 'sublingual', 'buccal', 'urethral/mucosal', 'topical'];
const FORMS = ['tablet', 'capsule', 'solution', 'suspension', 'syrup', 'liquid', 'ointment', 'cream', 'gel', 'lotion',
  'patch', 'packet', 'powder', 'aerosol', 'film', 'spray', 'drops', 'kit', 'pen', 'injector'];
const STRENGTH_RE = /(\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)*)\s*(mg|mcg|gm|g|ml|%|unit|units|meq)\b/gi;

function strengthsIn(text) {
  const out = [];
  const s = String(text || '');
  // RxNorm writes a 5% ointment as "0.05 MG/MG"; the books print "5%".
  for (const m of s.matchAll(/(\d*\.?\d+)\s*mg\/mg\b/gi)) out.push(`${Number((Number(m[1]) * 100).toFixed(4))} %`);
  for (const m of s.replace(/(\d*\.?\d+)\s*mg\/mg\b/gi, ' ').matchAll(STRENGTH_RE)) {
    const unit = m[2].toLowerCase().replace(/^gm$/, 'g').replace(/^units$/, 'unit');
    out.push(`${m[1].split('-').map(Number).join('-')} ${unit}`);
  }
  return out;
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

const signature = (f) => [f.pa, f.st, f.qlText || f.ql, f.bdPa, f.hrm, f.ed].join('|');

/**
 * The one parsed row that answers for the query, or null. Each parsed row carries
 * { first, alt, route, form, release, otc, rx, pah, base, strengths, flags }.
 */
function matchRows(parsedRows, query) {
  const q = parseQuery(query || {});
  if (!q.ingredient) return null;
  const names = [q.ingredient, q.brand].filter(Boolean);
  let cands = (parsedRows || []).filter((p) => (names.includes(p.first) || (p.alt && names.includes(p.alt))) && !p.otc);
  // Same route (an ointment row never answers for the tablet); rows without a route are oral.
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
  if (new Set(cands.map((p) => signature(p.flags))).size > 1) return null;
  return cands[0];
}

module.exports = { ROUTES, FORMS, STRENGTH_RE, strengthsIn, parseQuery, matchRows, signature };
