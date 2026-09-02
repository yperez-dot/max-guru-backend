const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAN_LABEL,
  SEARCH_TYPES,
  buildSearchBody,
  npiMatches,
  formatMatch,
} = require('./doctorsHcp');

describe('doctorsHcp search body', () => {
  it('sends PCPSpecialtiesCode as an array (empty string 400s on their API)', () => {
    const body = buildSearchBody({ providerType: 'pcp', npi: '1497949424' });
    assert.equal(body.ProviderType, 'pcp');
    assert.deepEqual(body.PCPSpecialtiesCode, []);
    assert.equal(body.ProviderNPI, '1497949424');
    assert.equal(body.ZipCode, '');
    assert.equal(typeof body.LimitMilesTo, 'number');
  });

  it('uses HospitalNPI instead of ProviderNPI for hospital searches', () => {
    const body = buildSearchBody({
      providerType: 'hos',
      npi: '1184725302',
      hospitalNpi: '1184725302',
    });
    assert.equal(body.ProviderNPI, '');
    assert.equal(body.HospitalNPI, '1184725302');
  });

  it('searches pcp and specialist', () => {
    assert.deepEqual(SEARCH_TYPES, ['pcp', 'spe']);
  });
});

describe('doctorsHcp NPI match', () => {
  it('matches numeric providerNpi to string NPI', () => {
    assert.equal(npiMatches({ providerNpi: 1497949424 }, '1497949424'), true);
    assert.equal(npiMatches({ providerNpi: '1497949424' }, 1497949424), true);
    assert.equal(npiMatches({ providerNpi: 1306409339 }, '1497949424'), false);
    assert.equal(npiMatches({}, '1497949424'), false);
  });

  it('formats a directory hit without claiming a CMS plan ID', () => {
    const row = formatMatch({
      providerNpi: 1497949424,
      providerName: 'MIREYA GARCIA MD',
      providerSpecialties: '(PCP) INTERNAL MEDICINE',
      providerAddress1: '8352 SW 8 ST',
      providerCityName: 'MIAMI',
      providerState: 'FL',
      providerZipCode: '33144',
      phone: '(305) 262-8282',
      pcpAcceptsNewPatients: 'Y',
    });
    assert.equal(row.npi, '1497949424');
    assert.match(row.address, /MIAMI/);
    assert.equal(PLAN_LABEL, 'Doctors HealthCare Plans');
  });
});
