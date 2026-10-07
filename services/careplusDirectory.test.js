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

describe('manual-check notes for carriers with no directory', () => {
  const { manualCheckNotes } = require('./doctorPlanNarrow');
  it('names Wellcare and Gold Kidney with where to check, once each', () => {
    const t = manualCheckNotes([{ carrier: 'Wellcare', name: 'Wellcare Simple (HMO)', planId: 'H1032-196' }, { carrier: '', name: 'Gold Kidney Heart (C-SNP)', planId: 'H1526-001' }, { carrier: 'Wellcare', name: 'Wellcare Giveback', planId: 'H1032-200' }]);
    assert.match(t, /Wellcare: no 2027 Wellcare directory/);
    assert.match(t, /Gold Kidney: .*providerportal\.goldkidney\.com.*\(844\) 294-6535/);
    assert.equal((t.match(/Wellcare:/g) || []).length, 1);
  });
  it('says nothing for carriers that have a directory', () => {
    assert.equal(manualCheckNotes([{ carrier: 'Humana', name: 'Humana Gold Plus', planId: 'H1036-054' }]), '');
  });
});

describe('core plan always leads a carrier comparison', () => {
  const { selectComparison } = require('./doctorPlanNarrow');
  it('Humana Gold Plus H1036-065C is first even when no doctor is confirmed on it', () => {
    const mk = (name, inP, outP) => ({ requestedName: name, doctorName: name, status: 'done', pending: [], failed: [], networks: [], carriersIn: ['Humana'], inNetworkPlans: inP, outOfNetworkPlans: outP });
    const docs = ['A One', 'B Two'].map((n) => mk(n, ['Humana Gold Plus Giveback (HMO) (H1036-305)'], ['HumanaChoice (PPO) (H7617-107)']));
    const sel = selectComparison(docs, 'Maria Perez ZIP 33076. No Medicaid. Carriers requested: Humana.', {});
    assert.equal(sel.columns[0].planId.slice(0, 9), 'H1036-065', sel.columns.map((c) => c.planId).join(','));
    assert.ok(sel.columns.length >= 2);
    assert.ok(sel.flags.some((f) => /core plan leads/.test(f)));
  });
});

describe('HMO is the default; PPOs only when asked', () => {
  const { askConstraints } = require('./doctorPlanNarrow');
  const assert3 = require('node:assert/strict');
  it('no PPO mention → HMO only', () => {
    assert3.equal(askConstraints('Marilyn Butler, 33076. Doctors: Dr. A B, Dr. C D').onlyHmo, true);
  });
  it('PPO mentioned → PPOs allowed', () => {
    assert3.equal(askConstraints('include PPO options too').onlyHmo, false);
    assert3.equal(askConstraints('she needs a PPO').onlyPpo, true);
    assert3.equal(askConstraints('she needs a PPO').onlyHmo, false);
  });
});
