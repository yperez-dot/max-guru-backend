/**
 * CarePlus Health Plans (H1019) 2027 provider directory — name index.
 *
 * Sunfire does not reliably return CarePlus networks (and an empty Sunfire answer is never an Out),
 * and CarePlus has no public search Max can call. The 2027 county PDFs (assets.humana.com
 * H1019FLHM01{JG,CG,IG}27pdf) end with an alphabetical index; scripts/build_careplus_index.py turns
 * it into data/careplus-directory-2027.json. No NPIs → match by name (same rules as Solis).
 *
 * The PDF says "This is a partial list". So:
 *   - LISTED  → In (every CarePlus plan in that county shares the one directory).
 *   - not listed → "checked, not confirmed" — NEVER Out.
 *   - county with no index (Broward until its PDF is added; anywhere else) → unavailable (❔ unchecked).
 */

const { fipsForZip, samePerson } = require('./solisDirectory');

let INDEX = null;
function loadIndex() {
  if (INDEX) return INDEX;
  try {
    INDEX = require('../data/careplus-directory-2027.json');
  } catch (_) {
    INDEX = { counties: {} };
  }
  return INDEX;
}

const COUNTY_LABEL = { miamiDade: 'Miami-Dade', broward: 'Broward', palmBeach: 'Palm Beach' };

function countyKeyForZip(zip) {
  let county = '';
  try { county = require('./comparisonRules').countyForZip(zip); } catch (_) { county = ''; }
  if (county === 'Miami-Dade') return 'miamiDade';
  if (county === 'Broward') return 'broward';
  if (/palm/i.test(county)) return 'palmBeach';
  const fips = fipsForZip(zip);
  if (fips === '12086') return 'miamiDade';
  if (fips === '12011') return 'broward';
  if (fips === '12099') return 'palmBeach';
  return null;
}

/**
 * → { status: 'checked'|'unavailable', inNetwork, matches: [{name, pages, county}], county, asOf, partialList: true }
 */
function careplusCheck({ firstName, middleName, lastName, zip } = {}) {
  const idx = loadIndex();
  const key = countyKeyForZip(zip);
  const county = key && idx.counties && idx.counties[key];
  if (!county || !lastName || !firstName) {
    return { status: 'unavailable', inNetwork: false, matches: [], county: key || '', partialList: true };
  }
  const matches = [];
  for (const e of county.people || []) {
    if (samePerson(e, { first: firstName, middle: middleName, last: lastName })) {
      matches.push({ name: `${e.last}, ${e.first}${e.cred ? ` ${e.cred}` : ''}`, pages: e.pages, county: key });
    }
  }
  return { status: 'checked', inNetwork: matches.length > 0, matches, county: key, asOf: county.asOf || null, partialList: true };
}

module.exports = { careplusCheck, countyKeyForZip, COUNTY_LABEL };
