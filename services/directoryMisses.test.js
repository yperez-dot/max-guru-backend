// Doctors HealthCare + Devoted: a finished directory check that does not list the NPI is ❌ Not in network (not listed);
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
  it('listed → ✅ In; finished and not listed → ❌ Not in network (not listed)', () => {
    const t = n.batchSummaryForModel([
      doc('Juan Diego Cedeno', ['Doctors HealthCare Plans', 'Devoted Health']),
      doc('Dileep Yavagal', []),
    ], ASK, {}).text;
    assert.deepEqual(rowOf(t, 'Juan Diego Cedeno').slice(1), ['❌ Not in network (not listed)', '✅ In', '❔ unchecked', '✅ In']);
    assert.deepEqual(rowOf(t, 'Dileep Yavagal').slice(1), ['❌ Not in network (not listed)', '❌ Not in network (not listed)', '❔ unchecked', '❌ Not in network (not listed)']);
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
    assert.equal(rowOf(t, 'Dileep Yavagal')[4], '❌ Not in network (not listed)');
  });

  it('a pending check or an unconfirmed doctor match is never Out', () => {
    const pending = n.batchSummaryForModel([doc('Dileep Yavagal', [], { status: 'partial', pending: ['Doctors HealthCare Plans', 'FHIR (FL Blue / Cigna / HealthSun / Devoted)'] })], ASK, {}).text;
    assert.equal(rowOf(pending, 'Dileep Yavagal')[2], '❔ unchecked');
    assert.equal(rowOf(pending, 'Dileep Yavagal')[4], '❔ unchecked');
  });

  it('Doctors is one network for all plans: a finished list that omits the NPI is Out for a Doctors C-SNP too', () => {
    const ask = 'Compare Doctors HealthCare Plan C-SNP H4140-015 and Devoted CORE H1290-001 for these doctors';
    const t = n.batchSummaryForModel([doc('Dileep Yavagal', [])], ask, {}).text;
    const cells = rowOf(t, 'Dileep Yavagal');
    assert.ok(/Not in network \(not listed\)/.test(cells[1]), `Doctors C-SNP cell was ${cells[1]}`);
  });
});

describe('fhirCheck tells a miss from a failure', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('200 + entries → hit · 200 + none → miss · HTTP error / throw → failed', async () => {
    global.fetch = async (url) => {
      if (/devoted/.test(url)) return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', entry: [{}, {}] }) };
      if (/bcbsfl/.test(url)) return { ok: false, status: 503, json: async () => ({}) };
      if (/cigna/.test(url)) throw new Error('socket hang up');
      return { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) };
    };
    const r = await fhirCheck('1043665177');
    assert.deepEqual(r.hits, ['Devoted Health']);
    assert.deepEqual(r.failed, ['Florida Blue', 'Cigna']);
  });
});

describe('FHIR: a 200 that is not a Bundle, and clinic NPIs (audit, 2026-10-07)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  // OperationOutcome is FHIR's own way of reporting a server error at HTTP 200.
  for (const [label, body] of [
    ['an OperationOutcome', { resourceType: 'OperationOutcome', issue: [{ severity: 'error' }] }],
    ['a bare array', []],
    ['an empty object', {}],
  ]) {
    it(`Devoted answering 200 with ${label} is failed (❔ unchecked), not a miss`, async () => {
      global.fetch = async (url) => (/devoted/.test(url)
        ? { ok: true, status: 200, json: async () => body }
        : { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) });
      const r = await fhirCheck('1043665177');
      assert.ok(r.failed.includes('Devoted Health'), `failed was ${JSON.stringify(r.failed)}`);
      assert.ok(!r.hits.includes('Devoted Health'));
    });
  }

  it('a clinic (NPI-2) with an empty PractitionerRole answer is failed, not a miss', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) });
    const r = await fhirCheck('1689860280', { isOrg: true });
    assert.deepEqual(r.hits, []);
    assert.ok(r.failed.includes('Devoted Health'));
  });

  it('a clinic that DOES come back listed keeps its hit', async () => {
    global.fetch = async (url) => (/devoted/.test(url)
      ? { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 1, entry: [{}] }) }
      : { ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) });
    const r = await fhirCheck('1689860280', { isOrg: true });
    assert.ok(r.hits.includes('Devoted Health'));
  });

  it('a person (NPI-1) with an empty answer is still a real miss', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ resourceType: 'Bundle', total: 0, entry: [] }) });
    const r = await fhirCheck('1043665177');
    assert.deepEqual(r.hits, []);
    assert.deepEqual(r.failed, []);
  });
});

describe('NPPES records know a clinic from a person', () => {
  const { npiRecordInfo } = require('./providerNetwork');
  it('NPI-2 is a clinic; NPI-1 is a person', () => {
    assert.equal(npiRecordInfo({ number: '1689860280', enumeration_type: 'NPI-2', basic: { organization_name: 'MIAMI NEUROLOGY & REHABILITATION SPECIALISTS' } }).isOrg, true);
    assert.equal(npiRecordInfo({ number: '1407095615', enumeration_type: 'NPI-1', basic: { first_name: 'RUNDEEP', last_name: 'GADH' } }).isOrg, false);
  });
  it('an org name with no first name reads as a clinic even without enumeration_type', () => {
    assert.equal(npiRecordInfo({ number: '1', basic: { organization_name: 'SAGE DENTAL GROUP' } }).isOrg, true);
  });
});

describe('Doctors API reply that is not a list', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('is a failed check (unchecked), not a miss', async () => {
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ message: 'blocked' }) });
    const r = await queryDoctorsHcp('1000000004');
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

describe('named Solis plan (2027 county directory index)', () => {
  const solisNet = (inNetwork, status = 'checked', matches = []) => ({ networks: [{ carrier: 'Solis Health Plans', inNetwork, status, directoryMatches: matches }] });
  it('listed → ✅ In with the PDF page in the flag; checked and not listed → ❌ Not in network (not listed)', () => {
    const t = n.batchSummaryForModel([
      doc('Eduardo Krajewski', ['Doctors HealthCare Plans', 'Solis Health Plans'], solisNet(true, 'checked', [{ name: 'KRAJEWSKI, EDUARDO MD', pages: [93], county: 'miamiDade' }])),
      doc('Dileep Yavagal', [], solisNet(false)),
    ], ASK, {}).text;
    assert.equal(rowOf(t, 'Eduardo Krajewski')[3], '✅ In');
    assert.equal(rowOf(t, 'Dileep Yavagal')[3], '❌ Not in network (not listed)');
    assert.match(t, /Eduardo Krajewski = KRAJEWSKI, EDUARDO MD \(p\. 93\)/);
  });
  it('no Solis check (county not covered / older lookup) stays ❔ unchecked, never Out', () => {
    const t = n.batchSummaryForModel([doc('Dileep Yavagal', [], solisNet(false, 'failed'))], ASK, {}).text;
    assert.equal(rowOf(t, 'Dileep Yavagal')[3], '❔ unchecked');
    const t2 = n.batchSummaryForModel([doc('Dileep Yavagal', [])], ASK, {}).text;
    assert.equal(rowOf(t2, 'Dileep Yavagal')[3], '❔ unchecked');
  });
});
