/**
 * HealthSun Health Plans (H5431) 2027 provider directory — name index.
 *
 * HealthSun's live FHIR directory answers at carrier level only, so its plan cells read
 * "not confirmed". The 2027 Provider and Pharmacy Directory (one PDF for Miami-Dade, Broward and
 * Palm Beach, current as of Sep 4, 2026) has NO NPIs; scripts/build_healthsun_index.py turns its
 * alphabetical Provider Index into data/healthsun-directory-2027.json, scoped by county from the
 * page each entry points to. Match is by name (same rules as Solis / CarePlus: surname words +
 * first name), so "Rajdeep S. Gadh" never matches Dr. Rundeep Gadh.
 *
 *   - LISTED in the client's county → In (one directory covers the HealthSun HMO plans there).
 *   - not listed → "checked, not confirmed" — NEVER Out. A name match can miss a real listing
 *     (spelling, a nickname, a hyphenated surname), and a false Out loses the client's doctor.
 *   - county with no index / no county → unavailable (❔ unchecked).
 */

const { fipsForZip, samePerson } = require('./solisDirectory');

let INDEX = null;
function loadIndex() {
  if (INDEX) return INDEX;
  try {
    INDEX = require('../data/healthsun-directory-2027.json');
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
function healthsunCheck({ firstName, middleName, lastName, zip } = {}) {
  const idx = loadIndex();
  const key = countyKeyForZip(zip);
  const county = key && idx.counties && idx.counties[key];
  if (!county || !(county.people || []).length || !lastName || !firstName) {
    return { status: 'unavailable', inNetwork: false, matches: [], county: key || '', partialList: true };
  }
  const matches = [];
  for (const e of county.people) {
    if (samePerson(e, { first: firstName, middle: middleName, last: lastName })) {
      matches.push({ name: `${e.last}, ${e.first}${e.cred ? ` ${e.cred}` : ''}`, pages: e.pages, county: key });
    }
  }
  return { status: 'checked', inNetwork: matches.length > 0, matches, county: key, asOf: county.asOf || null, partialList: true };
}

module.exports = { healthsunCheck, countyKeyForZip, COUNTY_LABEL };
