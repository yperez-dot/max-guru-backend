const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PLAN_LABEL,
  SEARCH_TYPES,
  buildSearchBody,
  npiMatches,
  formatMatch,
  doctorsPdfCheck,
  queryDoctorsHcp,
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

describe('Doctors API bursts (2026-10-06: back-to-back calls 404, spaced calls 200)', () => {
  process.env.MAX_DOCTORS_HCP_RETRY_MS = '5';
  async function withFetch(handler, fn) {
    const saved = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => { const b = JSON.parse(opts.body); calls.push(b.ProviderType); return handler(b, calls.length); };
    try { return await fn(calls); } finally { global.fetch = saved; }
  }
  const { queryDoctorsHcp } = require('./doctorsHcp');
  const ok = (hits) => ({ ok: true, status: 200, json: async () => hits });
  const nf = { ok: false, status: 404, json: async () => ({}) };

  it('retries a 404 and finds the doctor (Cedeno, Urology)', async () => {
    await withFetch((b, n) => (n === 1 ? nf : ok(b.ProviderType === 'pcp' ? [] : [{ providerNpi: '1000000004', providerSpecialties: 'UROLOGY' }])), async (calls) => {
      const r = await queryDoctorsHcp('1000000004');
      assert.equal(r.inNetwork, true);
      assert.equal(r.error, null);
      assert.deepEqual(calls, ['pcp', 'pcp', 'spe'], 'PCP then specialist, one at a time');
    });
  });

  it('a list that keeps failing is an error, not a miss', async () => {
    await withFetch((b) => (b.ProviderType === 'spe' ? nf : ok([])), async () => {
      const r = await queryDoctorsHcp('1740401322');
      assert.equal(r.inNetwork, false);
      assert.equal(r.error, 'request_failed');
    });
  });
});

describe('doctorsHcp 2027 PDF index', () => {
  it('finds Dr. Gadh (NPI 1407095615) in the Broward directory', () => {
    const hits = doctorsPdfCheck('1407095615');
    assert.ok(hits.some((h) => h.county === 'broward' && h.page > 0));
  });

  it('returns nothing for an NPI that is not listed', () => {
    assert.deepEqual(doctorsPdfCheck('1000000000'), []);
    assert.deepEqual(doctorsPdfCheck(''), []);
  });

  it('queryDoctorsHcp answers In from the PDF without calling the live site', async () => {
    const realFetch = global.fetch;
    global.fetch = () => { throw new Error('live site should not be called'); };
    try {
      const r = await queryDoctorsHcp('1407095615');
      assert.equal(r.inNetwork, true);
      assert.equal(r.error, null);
      assert.match(r.matches[0].address, /Broward p\. \d+/);
    } finally {
      global.fetch = realFetch;
    }
  });
});
