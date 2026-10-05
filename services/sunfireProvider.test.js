const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSunfireResponseText,
  querySunfireProviderList,
  inNetworkLabelsFromSunfirePlans,
  resetSunfireCircuit,
  retryableSunfireError,
} = require('./sunfireProvider');

const prev = {
  SUNFIRE_JWT: process.env.SUNFIRE_JWT,
  SUNFIRE_SFP: process.env.SUNFIRE_SFP,
};

describe('Sunfire provider/list harden', () => {
  beforeEach(() => {
    process.env.SUNFIRE_JWT = 'test-jwt';
    process.env.SUNFIRE_SFP = 'test-sfp';
    resetSunfireCircuit();
  });

  it('fails fast on empty JSON', () => {
    assert.throws(() => parseSunfireResponseText(''), { code: 'empty_json' });
    assert.throws(() => parseSunfireResponseText('   '), { code: 'empty_json' });
  });

  it('fails fast on truncated JSON', () => {
    assert.throws(() => parseSunfireResponseText('{"plans":['), { code: 'truncated_json' });
    const err = new Error('Unexpected end of JSON input');
    assert.equal(retryableSunfireError(err), true);
  });

  it('retries empty JSON once then opens the circuit', async () => {
    const calls = [];
    const fetchImpl = async () => {
      calls.push(Date.now());
      return { ok: true, status: 200, text: async () => '' };
    };
    const first = await querySunfireProviderList({
      providers: [{ id: '1497949424', name: 'Garcia', firstName: 'Mireya', radius: 25, primaryDoctor: true }],
      zip: '33332',
      year: 2027,
      fetchImpl,
    });
    assert.equal(first.ok, false);
    assert.equal(first.error, 'empty_json');
    assert.equal(first.retried, true);
    assert.equal(calls.length, 2);

    const second = await querySunfireProviderList({
      providers: [{ id: '1306409339', name: 'Tharkur', firstName: 'R', radius: 25, primaryDoctor: true }],
      zip: '33332',
      year: 2027,
      fetchImpl,
    });
    assert.equal(second.status, 'skipped');
    assert.match(second.error, /circuit_open/);
    assert.equal(calls.length, 2);
  });

  it('does not hang the next doctor after truncated JSON', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n += 1;
      return { ok: true, status: 200, text: async () => '{"plans":' };
    };
    await querySunfireProviderList({ zip: '33332', year: 2027, providers: [{ id: '1' }], fetchImpl });
    const skipped = await querySunfireProviderList({
      zip: '33332',
      year: 2027,
      providers: [{ id: '2' }],
      fetchImpl,
    });
    assert.equal(n, 2);
    assert.equal(skipped.status, 'skipped');
  });

  it('returns in-network labels from a valid payload', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          plans: [
            {
              id: '999',
              doctorInformation: [{ covered: 'Y', locations: [{ covered: 'Y' }] }],
            },
          ],
        }),
    });
    const result = await querySunfireProviderList({
      zip: '33125',
      year: 2027,
      providers: [{ id: '1497949424' }],
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    const labels = inNetworkLabelsFromSunfirePlans(result.plans, {
      999: { planName: 'CareComplete', carrier: 'CarePlus' },
    });
    assert.deepEqual(labels, ['CareComplete (CarePlus)']);
  });

  it('skips when credentials are missing', async () => {
    delete process.env.SUNFIRE_JWT;
    delete process.env.SUNFIRE_SFP;
    const result = await querySunfireProviderList({ zip: '33332', year: 2027, providers: [] });
    assert.equal(result.status, 'skipped');
    assert.equal(result.error, 'missing_credentials');
  });
});

describe('Sunfire env restore', () => {
  it('restores env after the suite', () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetSunfireCircuit();
    assert.ok(true);
  });
});
