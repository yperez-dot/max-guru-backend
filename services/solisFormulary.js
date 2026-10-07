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

/**
 * Tier for one drug on a Solis plan, or null when the plan is not Solis, the year is not the
 * indexed one, or the drug is not in the book. A miss here is "not covered" per the published
 * formulary — the caller decides how to say that; it is never an invented tier.
 */
function solisFormularyLookup(drugName, planId, year) {
  const idx = loadIndex();
  if (!idx || !isSolisPlan(planId)) return null;
  if (idx.year && Number(year) && Number(year) !== Number(idx.year)) return null;
  for (const key of keysFor(drugName)) {
    const hit = idx.drugs && idx.drugs[key];
    if (hit) {
      const req = String(hit.req || '');
      return {
        verified: true,
        tier: hit.tier,
        coverage: 'covered',
        pa: /\bPA\b/.test(req),
        st: /\bST\b/.test(req),
        ql: /\bQL\b/.test(req),
        matchedName: hit.name,
        source: `Solis 2027 Comprehensive Formulary PDF${idx.asOf ? ` (updated ${idx.asOf})` : ''}`,
      };
    }
  }
  return null;
}

module.exports = { solisFormularyLookup, isSolisPlan, keysFor, INDEX_PATH };
