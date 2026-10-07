const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { careplusCheck, countyKeyForZip } = require('./careplusDirectory');
const { namedPlanColumns } = require('./doctorPlanNarrow');

describe('CarePlus 2027 directory index', () => {
  it('lists a doctor who is in the Miami-Dade index (name match, pages)', () => {
    const r = careplusCheck({ firstName: 'Niraj', middleName: '', lastName: 'Mehta', zip: '33178' });
    assert.equal(r.status, 'checked');
    assert.equal(r.inNetwork, true);
    assert.deepEqual(r.matches[0].pages, [106]);
    assert.equal(r.partialList, true);
  });
  it('a miss in a covered county is checked-not-listed (never Out)', () => {
    const r = careplusCheck({ firstName: 'Zzyzx', lastName: 'Nonexistent', zip: '33178' });
    assert.equal(r.status, 'checked');
    assert.equal(r.inNetwork, false);
  });
  it('Broward is covered: a listed Broward doctor is In, a miss is checked-not-listed', () => {
    const hit = careplusCheck({ firstName: 'Barry', lastName: 'Sarkell', zip: '33076' });
    assert.equal(hit.status, 'checked');
    assert.equal(hit.inNetwork, true);
    assert.equal(hit.county, 'broward');
    assert.equal(careplusCheck({ firstName: 'Zzyzx', lastName: 'Nonexistent', zip: '33076' }).inNetwork, false);
  });
  it('a county without an index is unavailable, not a miss', () => {
    assert.equal(countyKeyForZip('33076'), 'broward');
    const r = careplusCheck({ firstName: 'Ashwin', lastName: 'Mehta', zip: '32801' }); // Orlando — no CarePlus index loaded
    assert.equal(r.status, 'unavailable');
  });
});

describe('CarePlus plan columns', () => {
  const doc = (name, net) => ({
    requestedName: name, doctorName: name, status: 'done', pending: [], failed: [],
    inNetworkPlans: net.inNetwork ? ['CarePlus'] : [], outOfNetworkPlans: [],
    carriersIn: net.inNetwork ? ['CarePlus'] : [], networks: [{ carrier: 'CarePlus', ...net }],
  });
  const plan = [{ planId: 'H1019-065', name: 'CarePlus Premier (HMO) (H1019-065)' }];
  it('listed → In; not listed → not confirmed, never Out; no index → unchecked', () => {
    const docs = [
      doc('A One', { inNetwork: true, status: 'checked' }),
      doc('B Two', { inNetwork: false, status: 'checked' }),
      doc('C Three', { inNetwork: false, status: 'failed' }),
    ];
    const [col] = namedPlanColumns(plan, [], docs);
    assert.deepEqual(col.in, ['A One']);
    assert.deepEqual(col.out, []);
    assert.deepEqual(col.notConfirmed, ['B Two']);
    assert.deepEqual(col.unknown.sort(), ['B Two', 'C Three']);
  });
});
