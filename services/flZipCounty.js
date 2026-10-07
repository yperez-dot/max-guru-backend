/**
 * Florida ZIP → county (data/fl-zip-county.json, built from the Census 2020 ZCTA↔county file by
 * scripts/build_fl_zip_county.js). Largest county first; a ZIP that straddles two counties lists
 * both. Falls back to the plan grid's Miami-Dade / Broward ZIP map. Unknown → [] (never a guess).
 */
let MAP = null;
function load() {
  if (MAP) return MAP;
  try { MAP = require('../data/fl-zip-county.json').zips || {}; } catch (_) { MAP = {}; }
  return MAP;
}

function countiesForZip(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (z.length !== 5) return [];
  const hit = load()[z];
  if (hit && hit.length) return [...hit];
  try {
    const c = require('./comparisonRules').countyForZip(z);
    if (c) return [c];
  } catch (_) { /* no grid */ }
  return [];
}

module.exports = { countiesForZip };
