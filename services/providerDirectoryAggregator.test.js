const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PUBLIC_DIRECTORY_SOURCES,
  queryPublicCarrierDirectories,
} = require('./providerDirectoryAggregator');

function dependencies(overrides = {}) {
  return {
    queryDoctorsHcp: async () => ({ inNetwork: false, matches: [], error: null }),
    queryAetnaPublic: async () => ({ inNetwork: false, plans: [], matches: [], error: null }),
    querySimplyFindcare: async () => ({ inNetwork: false, plans: [], matches: [], error: null }),
    solisLookupNote: () => ({
      searchable: false,
      reason: 'County PDFs only.',
      findAProviderUrl: 'https://example.test/solis',
      directory: { url: 'https://example.test/solis-miami' },
    }),
    ...overrides,
  };
}

describe('public carrier directories in Max lookup path', () => {
  it('returns a Doctors hit with an explicit carrier source', async () => {
    const result = await queryPublicCarrierDirectories(
      { npi: '1306409339', zip: '33176', lastName: 'Tharkur' },
      dependencies({
        queryDoctorsHcp: async () => ({ inNetwork: true, matches: [{ npi: '1306409339' }], error: null }),
      })
    );
    assert.deepEqual(result.affiliations[0].plans, ['Doctors HealthCare Plans']);
    assert.equal(result.affiliations[0].source, PUBLIC_DIRECTORY_SOURCES.doctors.label);
  });

  it('preserves Aetna plan labels and cites Aetna public Find Care', async () => {
    const result = await queryPublicCarrierDirectories(
      { npi: '1366434334', zip: '33176', lastName: 'Rivera' },
      dependencies({
        queryAetnaPublic: async () => ({
          inNetwork: true,
          plans: ['Aetna Medicare Select — H1609-094'],
          matches: [],
          error: null,
        }),
      })
    );
    const hit = result.affiliations.find((item) => item.carrier === 'Aetna Medicare');
    assert.deepEqual(hit.plans, ['Aetna Medicare Select — H1609-094']);
    assert.equal(hit.source, PUBLIC_DIRECTORY_SOURCES.aetna.label);
  });

  it('preserves Simply plan labels and cites Simply public Find Care', async () => {
    const result = await queryPublicCarrierDirectories(
      { npi: '1306409339', zip: '33176', lastName: 'Tharkur' },
      dependencies({
        querySimplyFindcare: async () => ({
          inNetwork: true,
          plans: ['Simply Extra (HMO)'],
          matches: [],
          error: null,
        }),
      })
    );
    const hit = result.affiliations.find((item) => item.carrier === 'Simply Healthcare');
    assert.deepEqual(hit.plans, ['Simply Extra (HMO)']);
    assert.equal(hit.source, PUBLIC_DIRECTORY_SOURCES.simply.label);
  });

  it('marks Solis manual-only and never invents an affiliation', async () => {
    const result = await queryPublicCarrierDirectories(
      { npi: '1306409339', zip: '33176', lastName: 'Tharkur' },
      dependencies()
    );
    const solis = result.checks.find((item) => item.carrier === 'Solis Health Plans');
    assert.equal(solis.status, 'manual');
    assert.deepEqual(solis.plans, []);
    assert.equal(result.affiliations.some((item) => item.carrier === 'Solis Health Plans'), false);
    assert.match(solis.sourceUrl, /solis-miami/);
  });

  it('distinguishes a carrier failure from an out-of-network miss', async () => {
    const result = await queryPublicCarrierDirectories(
      { npi: '1306409339', zip: '33176', lastName: 'Tharkur' },
      dependencies({ queryDoctorsHcp: async () => { throw new Error('timeout'); } })
    );
    const doctors = result.checks.find((item) => item.carrier === 'Doctors HealthCare Plans');
    assert.equal(doctors.status, 'failed');
    assert.equal(doctors.error, 'timeout');
  });
});
