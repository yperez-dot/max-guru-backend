// Padron 8-doctor regression: doctors run in parallel, a stuck carrier never
// holds the batch past its deadline, and cut-off work lands in the cache.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const knobs = {
  carrierMs: 50,
  npiMs: 20,
  hangHumanaFor: new Set(),
  hangNpiFor: new Set(),
  sunfireCalls: [],
  humanaCalls: 0,
  resolveHumana: [],
};

function stub(modName, exportsObj) {
  const file = require.resolve(path.join(__dirname, modName));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

const NPI_BY_NAME = {};
function npiFor(name) {
  if (!NPI_BY_NAME[name]) NPI_BY_NAME[name] = String(1000000000 + Object.keys(NPI_BY_NAME).length + 1);
  return NPI_BY_NAME[name];
}

stub('npiRegistry', {
  resolveNpiRecords: async ({ doctorName, npi }) => {
    if (knobs.hangNpiFor.has(doctorName)) await new Promise(() => {});
    await sleep(knobs.npiMs);
    if (/nobody/i.test(doctorName)) return [];
    const number = npi || npiFor(doctorName);
    return [{ number, basic: { first_name: doctorName.split(' ')[0], last_name: doctorName.split(' ').slice(-1)[0] }, taxonomies: [{ primary: true, desc: 'Internal Medicine' }], addresses: [] }];
  },
  displayName: (p) => `${p.basic.first_name} ${p.basic.last_name}`,
  allLocationAddresses: () => [{ address_1: '1 Main St', city: 'Weston', postal_code: '33332' }],
});
stub('doctorsHcp', { queryDoctorsHcp: async () => { await sleep(knobs.carrierMs); return { inNetwork: false }; }, PLAN_LABEL: 'Doctors HealthCare Plans' });
stub('aetnaPublicSearch', { queryAetnaPublic: async () => { await sleep(knobs.carrierMs); return { inNetwork: false, plans: [] }; }, CARRIER_LABEL: 'Aetna' });
stub('simplyFindcare', { querySimplyFindcare: async () => { await sleep(knobs.carrierMs); return { inNetwork: false, plans: [] }; }, CARRIER_LABEL: 'Simply' });
stub('uhcGuestSearch', {
  queryUhcGuest: async () => { await sleep(knobs.carrierMs); return { inNetwork: true, plans: ['UHC Dual Complete (H5420-001)'], outOfNetworkPlans: [], year: '2027' }; },
  CARRIER_LABEL: 'UnitedHealthcare',
  PLAN_YEAR: '2027',
  formatUhcAgentNote: () => 'UHC note',
});
stub('humanaFindcare', {
  queryHumanaFindcare: async (npi) => {
    knobs.humanaCalls += 1;
    const name = Object.keys(NPI_BY_NAME).find((k) => NPI_BY_NAME[k] === npi);
    if (knobs.hangHumanaFor.has(name)) {
      await new Promise((resolve) => knobs.resolveHumana.push(resolve));
    } else {
      await sleep(knobs.carrierMs);
    }
    return { inNetwork: true, plans: ['Humana Gold Plus (H1036-054)'], outOfNetworkPlans: [], checks: [{ status: 'in_network' }], year: '2027' };
  },
  CARRIER_LABEL: 'Humana',
  isHumanaLabel: (l) => /humana/i.test(l),
  formatHumanaAgentNote: () => 'Humana note',
});
stub('solisDirectory', { formatSolisNote: () => 'Solis: county PDF only.' });
stub('sunfireProvider', {
  querySunfireProviderList: async (opts) => {
    knobs.sunfireCalls.push(opts);
    return { ok: false, error: 'empty_json', plans: [] };
  },
  inNetworkLabelsFromSunfirePlans: () => [],
});

const originalFetch = global.fetch;
global.fetch = async () => ({ ok: false, json: async () => ({}) }); // FHIR misses

const { lookupProviderNetwork, clearProviderCache, normalizeDoctorList } = require('./providerNetwork');

const PADRON = [
  'Ernesto Padron', 'Oswaldo Sandoval', 'Carlos Sarduy', 'Eye Surgery Associates',
  'Michael Glassman', 'Jorge Diaz', 'Howard Bush', 'Alfred Desimone',
];

describe('lookup_provider_network batch (Padron 8 doctors)', () => {
  beforeEach(() => {
    clearProviderCache();
    knobs.carrierMs = 50;
    knobs.hangHumanaFor = new Set();
    knobs.hangNpiFor = new Set();
    knobs.sunfireCalls = [];
    knobs.humanaCalls = 0;
    knobs.resolveHumana = [];
  });
  after(() => {
    global.fetch = originalFetch;
  });

  it('runs all 8 doctors in parallel, not one after another', async () => {
    knobs.carrierMs = 200;
    const started = Date.now();
    const out = await lookupProviderNetwork({ doctors: PADRON.map((doctorName) => ({ doctorName })), zip: '33332' }, { deadlineAt: Date.now() + 5000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1200, `8 doctors took ${elapsed}ms — serial would be ~1.8s+`);
    assert.equal(out.expand.length, 8);
    assert.equal(out.structured.finished, 8);
    assert.match(out.text, /Finished: 8\/8/);
    for (const name of PADRON) assert.ok(out.text.includes(name), `${name} missing from batch text`);
  });

  it('returns by the deadline with NOT CONFIRMED for a stuck carrier and caches the late finish', async () => {
    knobs.hangHumanaFor = new Set(['Howard Bush']);
    const started = Date.now();
    const out = await lookupProviderNetwork({ doctors: PADRON.map((doctorName) => ({ doctorName })), zip: '33332' }, { deadlineAt: Date.now() + 600 });
    assert.ok(Date.now() - started < 1000, 'batch must not wait for the stuck Humana check');
    const bush = out.expand.find((d) => d.requestedName === 'Howard Bush');
    assert.equal(bush.status, 'partial');
    assert.ok(bush.pending.includes('Humana Find Care'));
    assert.match(out.text, /NOT CONFIRMED/);
    assert.equal(out.structured.finished, 7);

    // Humana answers after the chat wait; the next ask gets it from cache, no new Humana call.
    knobs.resolveHumana.forEach((r) => r());
    await sleep(80);
    const callsBefore = knobs.humanaCalls;
    const again = await lookupProviderNetwork({ doctors: [{ doctorName: 'Howard Bush' }, { doctorName: 'Jorge Diaz' }], zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(knobs.humanaCalls, callsBefore, 'resend must reuse cached lookups');
    assert.equal(again.structured.finished, 2);
    const bush2 = again.expand.find((d) => d.requestedName === 'Howard Bush');
    assert.equal(bush2.status, 'done');
    assert.ok(bush2.networks.find((n) => n.carrier === 'Humana').inNetwork);
  });

  it('marks a doctor whose NPI search never returns as NOT CONFIRMED (timeout)', async () => {
    knobs.hangNpiFor = new Set(['Carlos Sarduy']);
    const out = await lookupProviderNetwork({ doctors: [{ doctorName: 'Carlos Sarduy' }, { doctorName: 'Jorge Diaz' }], zip: '33332' }, { deadlineAt: Date.now() + 400 });
    const sarduy = out.expand.find((d) => d.requestedName === 'Carlos Sarduy');
    assert.equal(sarduy.status, 'timeout');
    assert.match(out.text, /Carlos Sarduy: NOT CONFIRMED/);
  });

  it('calls Sunfire without retry on the doctor path', async () => {
    await lookupProviderNetwork({ doctorName: 'Jorge Diaz', zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(knobs.sunfireCalls.length, 1);
    assert.equal(knobs.sunfireCalls[0].retry, false);
  });

  it('keeps the single-doctor shape for the UI export', async () => {
    const out = await lookupProviderNetwork({ doctorName: 'Jorge Diaz', zip: '33332' }, { deadlineAt: Date.now() + 2000 });
    assert.equal(out.expand, undefined);
    assert.equal(out.structured.doctorName, 'Jorge Diaz');
    assert.ok(Array.isArray(out.structured.networks));
  });

  it('dedupes doctors and merges doctorName with doctors[]', () => {
    const list = normalizeDoctorList({ doctorName: 'Jorge Diaz', doctors: [{ doctorName: 'Jorge Diaz' }, 'Howard Bush', { npi: '1234567890' }] });
    assert.deepEqual(list.map((d) => d.doctorName), ['Jorge Diaz', 'Howard Bush', '1234567890']);
  });
});
