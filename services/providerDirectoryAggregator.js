const {
  queryDoctorsHcp,
  PLAN_LABEL: DOCTORS_LABEL,
  DOCTORS_SEARCH_URL,
} = require('./doctorsHcp');
const {
  queryAetnaPublic,
  CARRIER_LABEL: AETNA_LABEL,
} = require('./aetnaPublicSearch');
const {
  querySimplyFindcare,
  CARRIER_LABEL: SIMPLY_LABEL,
  GUEST_URL: SIMPLY_GUEST_URL,
} = require('./simplyFindcare');
const { solisLookupNote } = require('./solisDirectory');

const PUBLIC_DIRECTORY_SOURCES = {
  doctors: {
    carrier: DOCTORS_LABEL,
    label: 'Doctors HealthCare Plans public ProviderSearch',
    url: DOCTORS_SEARCH_URL,
  },
  aetna: {
    carrier: AETNA_LABEL,
    label: 'Aetna public Medicare Find Care',
    url: 'https://health.aetna.com/ahpublic/medicare-direct',
  },
  simply: {
    carrier: SIMPLY_LABEL,
    label: 'Simply Healthcare public Find Care',
    url: SIMPLY_GUEST_URL,
  },
  solis: {
    carrier: 'Solis Health Plans',
    label: 'Solis county provider directory PDF',
  },
};

async function safeLookup(run) {
  try {
    return await run();
  } catch (error) {
    return { inNetwork: false, plans: [], matches: [], error: error?.message || 'request_failed' };
  }
}

function normalizeCheck(key, result) {
  const source = PUBLIC_DIRECTORY_SOURCES[key];
  const plans = Array.isArray(result?.plans) ? result.plans.filter(Boolean) : [];
  const matched = Boolean(result?.inNetwork);
  return {
    carrier: source.carrier,
    source: source.label,
    sourceUrl: source.url,
    status: result?.error ? 'failed' : (matched ? 'matched' : 'not_found'),
    plans: matched ? (plans.length ? plans : [source.carrier]) : [],
    matches: Array.isArray(result?.matches) ? result.matches : [],
    error: result?.error || null,
  };
}

/**
 * Run the public carrier-directory adapters used by both Max chat and the
 * standalone /provider-lookup route. Solis is deliberately manual-only: its
 * public directory is a county PDF, not an NPI-searchable API.
 */
async function queryPublicCarrierDirectories(
  { npi, zip, state = 'FL', lastName = '' },
  dependencies = {}
) {
  const doctorsLookup = dependencies.queryDoctorsHcp || queryDoctorsHcp;
  const aetnaLookup = dependencies.queryAetnaPublic || queryAetnaPublic;
  const simplyLookup = dependencies.querySimplyFindcare || querySimplyFindcare;
  const solisNote = (dependencies.solisLookupNote || solisLookupNote)(zip);

  const [doctors, aetna, simply] = await Promise.all([
    safeLookup(() => doctorsLookup(npi)),
    safeLookup(() => aetnaLookup(npi, { zip, state, lastName })),
    safeLookup(() => simplyLookup(npi, { zip, lastName })),
  ]);

  const checks = [
    normalizeCheck('doctors', doctors),
    normalizeCheck('aetna', aetna),
    normalizeCheck('simply', simply),
    {
      carrier: PUBLIC_DIRECTORY_SOURCES.solis.carrier,
      source: PUBLIC_DIRECTORY_SOURCES.solis.label,
      sourceUrl: solisNote.directory?.url || solisNote.findAProviderUrl,
      status: 'manual',
      plans: [],
      matches: [],
      error: null,
      note: solisNote.reason,
    },
  ];

  return {
    affiliations: checks
      .filter((check) => check.status === 'matched')
      .map(({ carrier, source, sourceUrl, plans, matches }) => ({
        carrier,
        source,
        sourceUrl,
        plans,
        matches,
      })),
    checks,
    solis: solisNote,
  };
}

module.exports = {
  PUBLIC_DIRECTORY_SOURCES,
  normalizeCheck,
  queryPublicCarrierDirectories,
};
