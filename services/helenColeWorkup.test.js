// Helen Cole (fictional) — four workup bugs from 2026-11-02:
// 1. "Meds: alprazolam, levothyroxine, and gabepentin" must not create a junk "and gabepentin" row
//    or re-ask "Did you mean gabapentin?" after auto-correct.
// 2. "look only at A, B, and C. No other plans" replaces the comparison set (no leftover current-plan column).
// 3. "remove healthsun and humana from comparison" drops both; chat + export columns match; one confirmation.
// 4. CarePlus Find Care guest lookup (mocked): listed → In, empty → Out, failed → not confirmed.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const C = require('./compareJobs');
const LW = require('./loadedWorkup');
const N = require('./doctorPlanNarrow');
const exp = require('../artifacts/comparison-export.js');
const { queryCareplusFindcare, resetSessionCache, THEI_CAREPLUS_NETWORKS } = require('./careplusFindcare');

const PASTE = 'Helen Cole, 33026, Dr. Brad Glick, Dr. William Rand, Dr. Phillip Cummings, Dr. James Bullock, Dr. Douglas Stringham, Dr. Ruchika Gadh, Meds: alprazolam, levothyroxine, and gabepentin. She is currently on UHC Preferred MA FL-0002 H1045-005';
const ONLY = 'I need to look only at H1019-001, H4140-023, and H0982-007. No other plans';
const REMOVE = 'remove healthsun and humana from comparison';

const TABLE_PLANS = [
  { planId: 'H1045-005', name: 'UHC Preferred MA FL-0002' },
  { planId: 'H1019-001', name: 'CarePlus CareOne Plus' },
  { planId: 'H4140-023', name: 'Doctors DrSelect-SFL' },
  { planId: 'H0982-007', name: 'Solis Healthy Living' },
  { planId: 'H5431-021', name: 'HealthSun VitalCare' },
  { planId: 'H1036-065C', name: 'Humana Gold Plus' },
];

function assistantTable(plans) {
  const ids = plans.map((p) => p.planId);
  const head = `| Doctor | ${plans.map((p) => `${p.name} · ${p.planId}`).join(' | ')} |`;
  const sep = `|---|${ids.map(() => '---').join('|')}|`;
  const row = `| Dr. Brad Glick · NPI 1 | ${ids.map(() => '✅ In').join(' | ')} |`;
  return `${head}\n${sep}\n${row}`;
}

describe('1. medication list connectors', () => {
  it('strips leading and / & / y and trailing punctuation', () => {
    assert.equal(R.stripListConnectors('and gabepentin'), 'gabepentin');
    assert.equal(R.stripListConnectors('& gabepentin.'), 'gabepentin');
    assert.equal(R.stripListConnectors('y gabepentin'), 'gabepentin');
    assert.deepEqual(R.splitMedList('alprazolam, levothyroxine, and gabepentin'), ['alprazolam', 'levothyroxine', 'gabepentin']);
    assert.deepEqual(R.splitMedList('alprazolam, levothyroxine, & gabepentin.'), ['alprazolam', 'levothyroxine', 'gabepentin']);
    assert.deepEqual(R.splitMedList('alprazolam, levothyroxine y gabepentin'), ['alprazolam', 'levothyroxine', 'gabepentin']);
  });

  it('parseCompareAsk does not keep a junk "and gabepentin" row', () => {
    const parsed = C.parseCompareAsk(PASTE);
    assert.deepEqual(parsed.meds.map((m) => m.toLowerCase()), ['alprazolam', 'levothyroxine', 'gabepentin']);
    assert.ok(!parsed.meds.some((m) => /^and\b/i.test(m)));
  });

  it('splitList strips connectors on doctor lists too', () => {
    assert.deepEqual(
      C.splitList('Dr. Brad Glick, Dr. William Rand, and Dr. Phillip Cummings'),
      ['Dr. Brad Glick', 'Dr. William Rand', 'Dr. Phillip Cummings']
    );
  });

  it('auto-corrected gabepentin is a verify note, not a Did-you-mean question', () => {
    const drugs = [{
      drugName: 'gabapentin',
      inputName: 'gabepentin',
      nameCorrection: { from: 'gabepentin', to: 'gabapentin' },
      lookups: [],
      byPlanId: { 'H1019-001': { planId: 'H1019-001', verified: true, tier: 1, coverage: 'covered', costShare: '$0' } },
    }];
    const out = N.renderedAnswer(
      [{ doctorName: 'Brad Glick', requestedName: 'Brad Glick', npi: '1', status: 'done', pending: [], failed: [], networks: [], inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] }],
      `${PASTE}\nNamed plan set: CarePlus CareOne Plus (H1019-001); Doctors DrSelect-SFL (H4140-023).`,
      { drugs }
    );
    assert.match(out, /gabepentin → gabapentin \(auto-corrected, verify\)/);
    assert.doesNotMatch(out, /Did you mean gabapentin/);
    assert.doesNotMatch(out, /and gabepentin/);
  });
});

describe('2. exclusive "only these plans / no other plans" replaces the set', () => {
  it('detects exclusive wording including Spanish solo', () => {
    assert.equal(R.isExclusivePlanSet(ONLY), true);
    assert.equal(R.isExclusivePlanSet('solo estos planes H1019-001 y H4140-023'), true);
    assert.equal(R.isExclusivePlanSet('just check Glinos on H5420-001'), false);
    assert.equal(R.isExclusivePlanSet("Only the 'Current plan' line is the client's current plan. Plans:\n- UHC (H1045-005)"), false);
  });

  it('look only at three IDs. No other plans → exactly those three, no current UHC column', () => {
    const msgs = [
      { role: 'user', content: PASTE },
      { role: 'assistant', content: assistantTable(TABLE_PLANS) },
      { role: 'user', content: ONLY },
    ];
    const ask = N.comparisonAskText(msgs);
    assert.match(ask, /Named plan set:/);
    assert.match(ask, /H1019-001/);
    assert.match(ask, /H4140-023/);
    assert.match(ask, /H0982-007/);
    assert.match(ask, /Exclusive named plan set/);
    const named = N.namedPlansFromAsk(ask);
    assert.deepEqual(named.map((p) => p.planId.slice(0, 9)).sort(), ['H0982-007', 'H1019-001', 'H4140-023']);
    assert.ok(!named.some((p) => p.planId.slice(0, 9) === 'H1045-005'), 'current plan must not stay as a column');
    const docs = [{
      requestedName: 'Brad Glick', doctorName: 'Brad Glick', npi: '1', status: 'done',
      pending: [], failed: [], networks: [], inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [],
    }];
    const sel = N.selectComparison(docs, ask, { answered: true });
    assert.deepEqual(sel.columns.map((c) => c.planId.slice(0, 9)).sort(), ['H0982-007', 'H1019-001', 'H4140-023']);
  });
});

describe('3. multi-carrier removal + export columns + one confirmation', () => {
  it('splits "healthsun and humana" and removes both from the table', () => {
    const rm = LW.planRemovals(REMOVE, TABLE_PLANS, ['H1045-005']);
    assert.ok(rm.remove.some((id) => id.slice(0, 9) === 'H5431-021'), rm.remove.join(','));
    assert.ok(rm.remove.some((id) => id.slice(0, 9) === 'H1036-065'), rm.remove.join(','));
    assert.deepEqual(rm.unmatched, []);
    const line = LW.planRemovalLines(rm, TABLE_PLANS).join(' ');
    assert.match(line, /I removed/);
    assert.match(line, /HealthSun/);
    assert.match(line, /Humana/);
    assert.doesNotMatch(line, /nothing removed/);
    assert.doesNotMatch(line, /Couldn't find "healthsun and humana"/);
  });

  it('one confirmation when one matches and one does not', () => {
    const rm = LW.planRemovals('remove healthsun and xyzcare from comparison', TABLE_PLANS, ['H1045-005']);
    const line = LW.planRemovalLines(rm, TABLE_PLANS).join(' ');
    assert.match(line, /I removed/);
    assert.match(line, /HealthSun/);
    assert.match(line, /Couldn't match "xyzcare"/);
    assert.equal(LW.planRemovalLines(rm, TABLE_PLANS).length, 1);
  });

  it('chat named set after the removal drops both carriers', () => {
    const msgs = [
      { role: 'user', content: PASTE },
      { role: 'assistant', content: assistantTable(TABLE_PLANS) },
      { role: 'user', content: REMOVE },
    ];
    const ask = N.comparisonAskText(msgs);
    assert.match(ask, /Named plan set:/);
    const named = N.namedPlansFromAsk(ask);
    const ids = named.map((p) => p.planId.slice(0, 9));
    assert.ok(!ids.includes('H5431-021'), ids.join(','));
    assert.ok(!ids.includes('H1036-065'), ids.join(','));
    assert.ok(ids.includes('H1045-005') || ids.includes('H1019-001'));
  });

  it('Excel working set drops Humana/HealthSun by carrier name (no IDs in the message)', () => {
    const working = exp.workingPlanIdsFromUserMessages([
      'Compare H1045-005, H1019-001, H4140-023, H0982-007, H5431-021, H1036-065C',
      REMOVE,
    ]);
    assert.ok(!working.some((id) => id.slice(0, 5) === 'H1036'), working.join(','));
    assert.ok(!working.some((id) => id.slice(0, 5) === 'H5431'), working.join(','));
    assert.ok(working.some((id) => id.slice(0, 9) === 'H1019-001'));
  });
});

describe('4. CarePlus Find Care guest lookup (mocked)', () => {
  beforeEach(() => resetSessionCache());

  function jsonRes(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { getSetCookie: () => [] },
      json: async () => body,
    };
  }
  function mockFetch(routes) {
    return async (url, options = {}) => {
      const u = String(url);
      assert.match(u, /findcare\.careplushealthplans\.com/);
      if (u.includes('/session/v1/config')) return jsonRes({ APIM_SUBSCRIPTION: 'test-key' });
      if (u.includes('/token/validate/guest')) return jsonRes(200);
      if (u.includes('/networks/medical')) return jsonRes({ current: [], future: [{ networkId: 4263, networkName: 'CarePlus27', coverageTypeId: 3 }] });
      if (u.includes('/providersearch/npi')) {
        const impl = routes.search;
        if (typeof impl === 'function') return impl(JSON.parse(options.body || '{}'), u);
        return jsonRes(impl);
      }
      throw new Error(`unexpected url ${url}`);
    };
  }

  it('a matching NPI is In for CarePlus27 / H1019-001 in Broward 33026', async () => {
    const hit = {
      resultCount: 1,
      results: [{
        providerId: 'p1',
        providerName: 'Glick, Brad DO',
        primarySpecialty: 'Dermatology',
        nationalProviderIdentifiers: ['1111111111'],
        address: { line1: '1 Main', city: 'Margate', state: 'FL', zipCode: '33063' },
      }],
    };
    const result = await queryCareplusFindcare('1111111111', { zip: '33026', planIds: ['H1019-001'] }, mockFetch({ search: hit }));
    assert.equal(result.error, null);
    assert.equal(result.inNetwork, true);
    assert.equal(result.source, 'findcare');
    assert.equal(result.partialList, false);
    assert.ok(result.plans.some((p) => /H1019-001/.test(p)));
    assert.deepEqual(result.outOfNetworkPlans, []);
  });

  it('successful empty search is Out, never not-confirmed', async () => {
    const result = await queryCareplusFindcare('1295829927', { zip: '33026', planIds: ['H1019-001'] }, mockFetch({ search: { resultCount: 0, results: [] } }));
    assert.equal(result.error, null);
    assert.equal(result.inNetwork, false);
    assert.equal(result.source, 'findcare');
    assert.ok(result.outOfNetworkPlans.some((p) => /H1019-001/.test(p)));
    const docs = [{
      requestedName: 'William J Rand', doctorName: 'William J Rand', npi: '1295829927', status: 'done',
      pending: [], failed: [],
      inNetworkPlans: [],
      outOfNetworkPlans: result.outOfNetworkPlans,
      carriersIn: [],
      networks: [{ carrier: 'CarePlus', inNetwork: false, status: 'checked', partialList: false, source: 'findcare', outOfNetworkPlans: result.outOfNetworkPlans }],
    }];
    const [col] = N.namedPlanColumns([{ planId: 'H1019-001', name: 'CarePlus CareOne Plus' }], [], docs);
    assert.deepEqual(col.out, ['William J Rand']);
    assert.deepEqual(col.notConfirmed, []);
  });

  it('a failed guest check is not Out (never guessed)', async () => {
    const result = await queryCareplusFindcare('1295829927', { zip: '33026', planIds: ['H1019-001'] }, mockFetch({
      search: () => jsonRes({ message: 'upstream timeout' }, 502),
    }));
    assert.equal(result.inNetwork, false);
    assert.deepEqual(result.outOfNetworkPlans, []);
    assert.ok(result.error || result.partialList);
  });

  it('CarePlus27 is the THEI 2027 CarePlus network', () => {
    assert.equal(THEI_CAREPLUS_NETWORKS[0].networkId, 4263);
    assert.ok(THEI_CAREPLUS_NETWORKS[0].plans.some((p) => p.cmsId === 'H1019-001'));
  });

  it('Excel/PDF: CarePlus guest empty is Out, not not-confirmed', () => {
    const plans = [{ planId: 'H1019-001', carrier: 'CarePlus', planName: 'CareOne Plus' }];
    const rows = exp.doctorsFromProviderLookups([{
      name: 'William J Rand',
      npi: '1295829927',
      networks: [{
        carrier: 'CarePlus',
        inNetwork: false,
        status: 'checked',
        partialList: false,
        source: 'findcare',
        plans: [],
        outOfNetworkPlans: ['CarePlus CareOne Plus (H1019-001)'],
      }],
    }], plans);
    assert.equal(rows[0].statuses[0], exp.NETWORK_OUT);
  });
});
