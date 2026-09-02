/**
 * Solis Health Plans (H0982) provider directory.
 *
 * THEI's Sunfire book does not return Solis networks. Find-a-provider is a
 * Webflow page; the interactive search is a placeholder. Live directories are
 * county PDFs on soliscdrapi.azurewebsites.net (probed 2026-09-02). NPIs are
 * not in the PDF as plain text, so Max cannot search them per lookup.
 *
 * Honest result: not searchable live — hand the agent the right county PDF.
 */

const FIND_A_PROVIDER = 'https://solishealthplans.com/2026/find-a-provider';
const AZURE_DOC = 'https://soliscdrapi.azurewebsites.net/doc';

const DIRECTORIES = {
  miamiDade: {
    key: 'miamiDade',
    county: 'Miami-Dade',
    url: `${AZURE_DOC}/ProvDirecMD_All_Current`,
    label: 'Solis Miami-Dade provider directory (PDF)',
  },
  browardPalmBeach: {
    key: 'browardPalmBeach',
    county: 'Broward & Palm Beach',
    url: `${AZURE_DOC}/ProvDirecBDPB_All_Current`,
    label: 'Solis Broward & Palm Beach provider directory (PDF)',
  },
  centralFl: {
    key: 'centralFl',
    county: 'Central Florida',
    url: `${AZURE_DOC}/ProvDirecCFL_All_Current`,
    label: 'Solis Central Florida provider directory (PDF)',
  },
};

/** Known THEI zips → county FIPS (12086 Miami-Dade, 12011 Broward, 12099 Palm Beach). */
const COUNTY_BY_ZIP = {
  '33196': '12086', '33186': '12086', '33176': '12086', '33183': '12086',
  '33015': '12086', '33012': '12086', '33145': '12086', '33126': '12086',
  '33010': '12086', '33054': '12086', '33166': '12086', '33174': '12086',
  '33004': '12011', '33009': '12011', '33019': '12011', '33021': '12011',
  '33060': '12011', '33064': '12011', '33312': '12011', '33317': '12011',
  '33328': '12011', '33334': '12011',
  '33401': '12099', '33411': '12099', '33426': '12099', '33433': '12099',
};

function fipsForZip(zip) {
  const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
  if (COUNTY_BY_ZIP[z]) return COUNTY_BY_ZIP[z];
  if (/^331|^332/.test(z)) return '12086';
  if (/^333/.test(z)) return '12011';
  if (/^330(1[0-8]|54)/.test(z)) return '12086'; // Hialeah / Opa-locka
  if (/^330/.test(z)) return '12011';
  if (/^334/.test(z)) return '12099';
  return null;
}

function directoryForZip(zip) {
  const fips = fipsForZip(zip);
  if (fips === '12086') return DIRECTORIES.miamiDade;
  if (fips === '12011' || fips === '12099') return DIRECTORIES.browardPalmBeach;
  return null;
}

function solisLookupNote(zip) {
  const directory = directoryForZip(zip);
  return {
    searchable: false,
    carrier: 'Solis Health Plans',
    contract: 'H0982',
    reason: 'Solis is not on THEI Sunfire provider search and has no public FHIR/ProviderSearch API. Directories are county PDFs.',
    findAProviderUrl: FIND_A_PROVIDER,
    directory,
    directories: directory ? [directory] : Object.values(DIRECTORIES),
  };
}

function formatSolisNote(zip) {
  const note = solisLookupNote(zip);
  const links = note.directories
    .map((d) => `${d.county}: ${d.url}`)
    .join('; ');
  return `Solis (H0982) is not on Sunfire and has no live provider API. Check ${links}. Find-a-provider: ${FIND_A_PROVIDER}`;
}

module.exports = {
  FIND_A_PROVIDER,
  DIRECTORIES,
  COUNTY_BY_ZIP,
  fipsForZip,
  directoryForZip,
  solisLookupNote,
  formatSolisNote,
};
