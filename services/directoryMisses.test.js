// Doctors HealthCare + Devoted: a finished directory check that does not list the NPI is ❌ Out;
// a failed or pending check stays ❔ unchecked. Live bug 2026-10-06: all 7 doctors showed
// "❔ not confirmed" on Doctors + Devoted although 4 / 3 of them are listed.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const n = require('./doctorPlanNarrow');
const { fhirCheck } = require('./providerNetwork');
const { queryDoctorsHcp } = require('./doctorsHcp');

const ASK = 'Compare UHC Preferred H1045-001, Doctors DrMax-Dade H4140-022, Solis Wellness H0982-016, Devoted CORE H1290-001 for these doctors';
const doc = (name, carriersIn, extra = {}) => ({
  doctorName: name, requestedName: name, npi: '1043665177', status: 'done', pending: [], failed: [],
  inNetworkPlans: [], outOfNetworkPlans: ['UHC Preferred MA FL-0001 HMO (H1045-001)'], carriersIn, ...extra,
});
const rowOf = (text, name) => text.split('\n').find((l) => l.startsWith(`| ${name}`)).split('|').map((c) => c.trim()).slice(1, -1);

describe('Doctors + Devoted cells', () => {
  it('listed → ✅ In; finished and not listed → ❌ Out', () => {
    const t = n.batchSummaryForModel([
      doc('Juan Diego Cedeno', ['Doctors HealthCare Plans', 'Devoted Health']),
      doc('Dileep Yavagal', []),
    ], ASK, {}).text;
    assert.deepEqual(rowOf(t, 'Juan Diego Cedeno').slice(1), ['❌ Out', '✅ In', '❔ unchecked', '✅ In']);
    assert.deepEqual(rowOf(t, 'Dileep Yavagal').slice(1), ['❌ Out', '❌ Out', '❔ unchecked', '❌ Out']);
  });

  it('a failed Devoted FHIR call or failed Doctors list stays ❔ unchecked, never Out', () => {
    const t = n.batchSummaryForModel([
      doc('Dileep Yavagal', [], { failed: ['Devoted Health (FHIR)', 'Doctors HealthCare Plans'] }),
    ], ASK, {}).text;
    const cells = rowOf(t, 'Dileep Yavagal');
    assert.equal(cells[2], '❔ unchecked');
    assert.equal(cells[4], '❔ unchecked');
  });

  it('a Florida Blue FHIR failure does not blank the Devoted cell', () => {
    const t = n.batchSummaryForModel([doc('Dileep Yavagal', [], { failed: ['Florida Blue (FHIR)'] })], ASK, {}).text;
    assert.equal(rowOf(t, 'Dileep Yavagal')[4], '❌ Out');
  });

  it('a pending check or an unconfirmed doctor match is never Out', () => {
    const pending = n.batchSummaryForModel([doc('Dileep Yavagal', [], { status: 'partial', pending: ['Doctors HealthCare Plans', 'FHIR (FL Blue / Cigna / HealthSun / Devoted)'] })], ASK, {}).text;
    assert.equal(rowOf(pending, 'Dileep Yavagal')[2], '❔ unchecked');
    assert.equal(rowOf(pending, 'Dileep Yavagal')[4], '❔ unchecked');
  });

  it('Doctors plans outside the shared DrMax/DrSelect network stay ❔ (no carrier-level Out)', () => {
    const ask = 'Compare Doctors HealthCare Plan C-SNP H4140-015 and Devoted CORE H1290-001 for these doctors';
    const t = n.batchSummaryForModel([doc('Dileep Yavagal', [])], ask, {}).text;
    const cells = rowOf(t, 'Dileep Yavagal');
    assert.ok(!/Out/.test(cells[1]), `Doctors C-SNP cell was ${cells[1]}`);
  });
});

describe('fhirCheck tells a miss from a failure', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('200 + entries → hit · 200 + none → miss · HTTP error / throw → failed', async () => {
    global.fetch = async (url) => {
      if (/devoted/.test(url)) return { ok: true, status: 200, json: async () => ({ entry: [{}, {}] }) };
      if (/bcbsfl/.test(url)) return { ok: false, status: 503, json: async () => ({}) };
      if (/cigna/.test(url)) throw new Error('socket hang up');
      return { ok: true, status: 200, json: async () => ({ total: 0, entry: [] }) };
    };
    const r = await fhirCheck('1043665177');
    assert.deepEqual(r.hits, ['Devoted Health']);
    assert.deepEqual(r.failed, ['Florida Blue', 'Cigna']);
  });
});

describe('Doctors API reply that is not a list', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('is a failed check (unchecked), not a miss', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: 'blocked' }) });
    const r = await queryDoctorsHcp('1043665177');
    assert.equal(r.inNetwork, false);
    assert.equal(r.error, 'request_failed');
  });

  it('two empty lists is a real miss', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ([]) });
    const r = await queryDoctorsHcp('1689661217');
    assert.equal(r.inNetwork, false);
    assert.equal(r.error, null);
  });
});

describe('named Solis plan', () => {
  it('says why Solis cells stay unchecked', () => {
    const t = n.batchSummaryForModel([doc('Dileep Yavagal', [])], ASK, {}).text;
    assert.match(t, /Solis has no live directory check/);
  });
});
