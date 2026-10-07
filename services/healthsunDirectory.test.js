const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { healthsunCheck, countyKeyForZip } = require('./healthsunDirectory');
const { namedPlanColumns } = require('./doctorPlanNarrow');

describe('HealthSun 2027 directory index (Yahoska sent the PDF, 2026-10-07)', () => {
  it('finds Martin’s listed Broward doctors with their PDF page', () => {
    const ead = healthsunCheck({ firstName: 'Daniel', middleName: 'N', lastName: 'Ead', zip: '33324' });
    assert.equal(ead.status, 'checked');
    assert.equal(ead.inNetwork, true);
    assert.match(ead.matches[0].name, /^EAD, DANIEL/);
    assert.ok(ead.matches[0].pages.length > 0);
    assert.equal(healthsunCheck({ firstName: 'Matthew', middleName: 'J', lastName: 'Soff', zip: '33324' }).inNetwork, true);
  });

  it('never matches a different first name on the same surname (Rundeep vs Rajdeep Gadh)', () => {
    const r = healthsunCheck({ firstName: 'Rundeep', middleName: 'Singh', lastName: 'Gadh', zip: '33324' });
    assert.equal(r.status, 'checked');
    assert.equal(r.inNetwork, false);
    assert.equal(healthsunCheck({ firstName: 'Rajdeep', middleName: 'S', lastName: 'Gadh', zip: '33324' }).inNetwork, true);
  });

  it('a county with no index is unavailable, never a miss', () => {
    const r = healthsunCheck({ firstName: 'Daniel', lastName: 'Ead', zip: '32801' }); // Orlando
    assert.equal(r.status, 'unavailable');
    assert.equal(r.inNetwork, false);
    assert.equal(countyKeyForZip('33172'), 'miamiDade');
    assert.equal(countyKeyForZip('33324'), 'broward');
  });

  it('no name → unavailable', () => {
    assert.equal(healthsunCheck({ lastName: 'Ead', zip: '33324' }).status, 'unavailable');
  });
});

describe('HealthSun plan columns: listed → In, not listed → not confirmed, never Out', () => {
  const doc = (name, net, extra = {}) => ({
    doctorName: name, requestedName: name, npi: '1', status: 'done', pending: [], failed: [],
    inNetworkPlans: [], outOfNetworkPlans: [],
    carriersIn: net.inNetwork ? ['HealthSun'] : [],
    networks: [{ carrier: 'HealthSun', ...net }],
    ...extra,
  });
  const plan = [{ planId: 'H5431-012', name: 'HealthSun HealthAdvantage Plan (HMO)' }];

  it('listed in the directory → plan-level In (not carrier-level In*)', () => {
    const d = doc('Daniel Ead', { inNetwork: true, status: 'checked', directoryStatus: 'checked' });
    const [col] = namedPlanColumns(plan, [], [d]);
    assert.equal(col.in.length, 1);
    assert.equal(col.inCarrier.length, 0);
    assert.equal(col.out.length, 0);
  });

  it('directory checked, not listed → not confirmed, never Out', () => {
    const d = doc('Bruce Kava', { inNetwork: false, status: 'checked', directoryStatus: 'checked' });
    const [col] = namedPlanColumns(plan, [], [d]);
    assert.equal(col.out.length, 0);
    assert.equal(col.notConfirmed.length, 1);
  });

  it('directory checked even though the live FHIR call failed → still not confirmed, never Out', () => {
    const d = doc('Bruce Kava', { inNetwork: false, status: 'failed', directoryStatus: 'checked' }, { failed: ['HealthSun (FHIR)'] });
    const [col] = namedPlanColumns(plan, [], [d]);
    assert.equal(col.out.length, 0);
    assert.equal(col.notConfirmed.length, 1);
  });

  it('FHIR failed and no directory for the county → unchecked, never Out', () => {
    const d = doc('Someone Else', { inNetwork: false, status: 'failed', directoryStatus: 'unavailable' }, { failed: ['HealthSun (FHIR)'] });
    const [col] = namedPlanColumns(plan, [], [d]);
    assert.equal(col.out.length, 0);
    assert.equal(col.in.length, 0);
    assert.equal(col.notConfirmed.length, 0);
    assert.equal(col.unknown.length, 1);
  });
});
