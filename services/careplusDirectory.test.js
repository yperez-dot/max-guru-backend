const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { careplusCheck, countyKeyForZip } = require('./careplusDirectory');
const { namedPlanColumns, corePlanIdsFor } = require('./doctorPlanNarrow');

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

describe('saved workup + "other plans comparable to what she has?"', () => {
  const { selectComparison, comparisonFollowUp, comparisonAskText } = require('./doctorPlanNarrow');
  const ctx = [
    'LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript). Resume these saved facts.',
    'Client: Sharon Mazzeo',
    'ZIP/county: 33324 / Broward',
    'Plans:',
    '- HealthSun VitalCare · H5431-021',
    'Doctors (names only — pass exactly these names to lookup_provider_network): Matthew Waldron; Jean-Jacques Rajter; Kenneth Zelnick; Jose A Guerra',
  ].join('\n');
  const msgs = [
    { role: 'user', content: ctx },
    { role: 'user', content: 'are there any other plans comparable to what she has?' },
  ];
  it('the server re-runs the comparison with the workup doctors instead of asking her current plan', () => {
    const f = comparisonFollowUp(msgs);
    assert.ok(f, 'follow-up expected');
    assert.match(f.reason, /alternatives/);
    assert.equal(f.doctors.length, 4);
    assert.equal(f.zip, '33324');
  });
  it('her saved plan leads and alternatives follow', () => {
    const ask = comparisonAskText(msgs);
    assert.match(ask, /Her current plan: H5431-021/);
    const mk = (n) => ({ requestedName: n, doctorName: n, status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: [], outOfNetworkPlans: [] });
    const sel = selectComparison(['A One', 'B Two'].map(mk), ask, {});
    assert.equal(sel.columns[0].planId, 'H5431-021', sel.columns.map((c) => c.planId).join(','));
    assert.ok(sel.columns.length >= 2, 'alternatives added');
  });
});

describe('her current plan stays in the comparison after she answers Max\'s questions', () => {
  const { selectComparison, comparisonAskText } = require('./doctorPlanNarrow');
  it('alternatives ask in an earlier message still pins the plan she typed', () => {
    const msgs = [
      { role: 'user', content: 'Sharon and George Mazzeo, 33324. Current plan H5431-021 HealthSun VitalCare. Are there any other plans comparable to what they have?\nDoctors: A One, B Two.' },
      { role: 'assistant', content: 'Questions:\n1. Do they have Medicaid?\n2. Which doctors are must-keep?' },
      { role: 'user', content: '1. no 2. Waldron' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'show me the meds too' },
      { role: 'user', content: 'and dental' },
      { role: 'user', content: 'thanks' },
    ];
    const ask = comparisonAskText(msgs);
    assert.match(ask, /Wants alternatives to the named plan/);
    assert.match(ask, /Her current plan: H5431-021/);
    const mk = (n) => ({ requestedName: n, doctorName: n, status: 'done', pending: [], failed: [], networks: [], carriersIn: [], inNetworkPlans: [], outOfNetworkPlans: [] });
    const sel = selectComparison(['A One', 'B Two'].map(mk), ask, {});
    assert.equal(sel.columns[0].planId, 'H5431-021', sel.columns.map((c) => c.planId).join(','));
    assert.ok(sel.columns.length >= 2);
  });
});

describe('Doctors HealthCare: both core plans lead', () => {
  const { selectComparison } = require('./doctorPlanNarrow');
  const mk = (n) => ({ requestedName: n, doctorName: n, status: 'done', pending: [], failed: [], networks: [], carriersIn: ['Doctors HealthCare'], inNetworkPlans: ['Doctors DrSelect-SFL (HMO) (H4140-023)'], outOfNetworkPlans: [] });
  it('Miami-Dade: DrMax-Dade H4140-022 and DrSelect-SFL H4140-023 both show', () => {
    const sel = selectComparison(['A One', 'B Two'].map(mk), 'Maria Perez ZIP 33178. No Medicaid. Carriers requested: Doctors HealthCare.', {});
    const ids = sel.columns.map((c) => c.planId.slice(0, 9));
    assert.ok(ids.includes('H4140-022') && ids.includes('H4140-023'), ids.join(','));
  });
  it('Broward: DrSelect-SFL H4140-023 is the only HMO core plan and leads', () => {
    const sel = selectComparison(['A One', 'B Two'].map(mk), 'Maria Perez ZIP 33324. No Medicaid. Carriers requested: Doctors HealthCare.', {});
    assert.equal(sel.columns[0].planId.slice(0, 9), 'H4140-023');
  });
});

describe('CarePlus core plans (Yahoska, 2026-10-07)', () => {
  it('Broward: CareOne Plus H1019-001 + CareAccess H1019-148, not all four', () => {
    assert.deepEqual(corePlanIdsFor('CarePlus', 'Broward'), ['H1019-001', 'H1019-148']);
  });
  it('Miami-Dade: only the core plans the grid offers there', () => {
    assert.deepEqual(corePlanIdsFor('CarePlus', 'Miami-Dade'), ['H1019-148']);
  });
});
