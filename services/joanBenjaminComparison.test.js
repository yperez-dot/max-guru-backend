// Joan Benjamin workup (ZIP 33159, Miami-Dade, 2026-11-19): current plan
// UHC MedicareMax FL-0028 H5420-001; remove CarePlus H1019-006, add Humana H1036-054C.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const { guestPlanIdsFor, planIdsFrom } = require('./providerNetwork');
const { askTextFor } = require('./compareJobs');
const exp = require('../artifacts/comparison-export.js');

const SWAP = 'Remove CarePlus CareOne Plus H1019-006 and add Humana Gold Plus H1036-054C instead';
const FIRST = [
  'Joan Benjamin, ZIP 33159. Current plan UHC MedicareMax FL-0028 (H5420-001).',
  'Compare H5420-001, Doctors DrMax-Dade H4140-022, CarePlus CareOne Plus H1019-006.',
  'Doctors: Aaron Bernard Tuckler NPI 1760771000, Juan Viles-Gonzalez NPI 1669522173, Christopher Gomez NPI 1699926238.',
  'Meds: meloxicam 5 MG, metoprolol tartrate 37.5 MG, pantoprazole 20 MG, sotalol 120 MG.',
].join(' ');

const WK = `LOADED CLIENT WORKUP (structured facts only — not a prior chat transcript).
Client: Joan Benjamin
ZIP/county: 33159 / Miami-Dade
Current plan: H5420-001
Plans:
- UHC MedicareMax FL-0028 (H5420-001)
- Doctors DrMax-Dade (H4140-022)
- CarePlus CareOne Plus (H1019-006)
Doctors (names only — pass exactly these names to lookup_provider_network): Aaron Bernard Tuckler; Juan Viles-Gonzalez; Christopher Gomez`;

const TABLE_3 = [
  '**Doctors × plans**',
  '',
  '| Doctor | UHC MedicareMax FL-0028 · H5420-001 | Doctors DrMax-Dade · H4140-022 | CarePlus CareOne Plus · H1019-006 |',
  '|---|---|---|---|',
  '| Aaron Bernard Tuckler · NPI 1760771000 | ❔ unchecked | ✅ In | ✅ In |',
  '| Juan Viles-Gonzalez · NPI 1669522173 | ❔ unchecked | ✅ In | ❌ Not in network (not listed) |',
  '| Christopher Gomez · NPI 1699926238 | ❔ unchecked | ✅ In | ✅ In |',
].join('\n');

function msgs(extra = []) {
  return [
    { role: 'user', content: WK },
    { role: 'user', content: FIRST },
    { role: 'assistant', content: TABLE_3 },
    ...extra,
  ];
}

function ids9(list) {
  return list.map((x) => String(x.planId || x.id || x).toUpperCase().slice(0, 9));
}

describe('Joan Benjamin 2026-11-19: current plan always in the guest check', () => {
  it('ZIP 33159 is Miami-Dade', () => {
    assert.equal(R.countyForZip('33159'), 'Miami-Dade');
  });

  it('first named set includes her current plan and guestPlanIdsFor reads it with empty tool IDs', () => {
    const ask = N.comparisonAskText(msgs());
    assert.match(ask, /Named plan set:.*H5420-001/s);
    assert.match(ask, /H4140-022/);
    assert.match(ask, /H1019-006/);
    const ids = guestPlanIdsFor([undefined, ''], ask);
    assert.ok(ids.some((id) => id.slice(0, 9) === 'H5420-001'), ids.join(','));
    assert.ok(ids.some((id) => id.slice(0, 9) === 'H4140-022'), ids.join(','));
    assert.doesNotMatch(ask, /^Rank all eligible plans\.$/m);
  });

  it('compare-card askText still lists current + named plans for lookupOneDoctor', () => {
    const text = askTextFor({
      clientName: 'Joan Benjamin',
      zip: '33159',
      plans: ['H5420-001', 'H4140-022', 'H1019-006'],
      currentPlans: ['H5420-001'],
      doctors: [],
      meds: [],
      skip: [],
      carriers: [],
      addedPlans: [],
    });
    assert.deepEqual(guestPlanIdsFor([], text).map((id) => id.slice(0, 9)).sort(),
      ['H1019-006', 'H4140-022', 'H5420-001']);
  });
});

describe('Joan Benjamin 2026-11-19: remove CarePlus, add Humana H1036-054C', () => {
  const thread = msgs([{ role: 'user', content: SWAP }]);

  it('replacePlanPairs reads marketing names between the verb and the H-number', () => {
    const pairs = LW.replacePlanPairs(SWAP);
    assert.ok(pairs.some((p) => p.from === 'H1019-006' && p.to.slice(0, 9) === 'H1036-054'), JSON.stringify(pairs));
  });

  it('workupPlanAddSet drops CarePlus and adds Humana, current plan first', () => {
    const set = LW.workupPlanAddSet(SWAP, thread);
    const ids = ids9(set);
    assert.equal(ids[0], 'H5420-001');
    assert.ok(ids.includes('H4140-022'));
    assert.ok(ids.some((id) => id === 'H1036-054' || id === 'H1036-054C' || id.startsWith('H1036-054')));
    assert.ok(!ids.includes('H1019-006'), ids.join(','));
  });

  it('comparisonAskText emits the swapped Named plan set (no CarePlus, Humana in, current first)', () => {
    const ask = N.comparisonAskText(thread);
    const named = (ask.match(/^Named plan set:\s*(.+)$/m) || [])[1] || '';
    assert.match(named, /H5420-001/);
    assert.match(named, /H4140-022/);
    assert.match(named, /H1036-054/);
    assert.doesNotMatch(named, /H1019-006/);
    const ids = guestPlanIdsFor([], ask);
    assert.ok(ids.some((id) => id.slice(0, 9) === 'H5420-001'), ids.join(','));
    assert.ok(ids.some((id) => id.startsWith('H1036-054')), ids.join(','));
    assert.ok(!ids.some((id) => id.slice(0, 9) === 'H1019-006'), ids.join(','));
  });

  it('server re-runs the comparison for the remove+add', () => {
    const fu = N.comparisonFollowUp(thread);
    assert.ok(fu, 'follow-up expected so the new Humana column is checked');
    assert.equal(fu.doctors.length, 3);
    assert.equal(fu.zip, '33159');
  });
});

describe('Joan Benjamin 2026-11-19: Excel export uses the picked set', () => {
  const thread = [
    { role: 'user', content: FIRST },
    { role: 'assistant', content: TABLE_3 },
    { role: 'user', content: SWAP },
  ];

  it('workingPlanIdsFromUserMessages drops CarePlus and adds Humana', () => {
    const w = exp.workingPlanIdsFromUserMessages([FIRST, SWAP]);
    const ids = w.map((id) => String(id).slice(0, 9));
    assert.ok(!ids.includes('H1019-006'), ids.join(','));
    assert.ok(ids.includes('H5420-001'));
    assert.ok(ids.includes('H4140-022'));
    assert.ok(ids.some((id) => id === 'H1036-054' || id.startsWith('H1036')));
  });

  it('exportPlanIdsFromThread is current plan first, no CarePlus', () => {
    const ids = exp.exportPlanIdsFromThread(thread, null, { currentPlanIds: ['H5420-001'] })
      .map((id) => String(id).slice(0, 9));
    assert.equal(ids[0], 'H5420-001');
    assert.ok(!ids.includes('H1019-006'), ids.join(','));
    assert.ok(ids.includes('H4140-022'));
    assert.ok(ids.some((id) => id === 'H1036-054' || id.startsWith('H1036')));
  });

  it('applyThreadPlanSetEdits does not put CarePlus back when the add names Humana', () => {
    const ids = exp.applyThreadPlanSetEdits(
      ['H5420-001', 'H4140-022', 'H1019-006'],
      thread,
      (c) => c,
      1,
    ).map((id) => String(id).slice(0, 9));
    assert.deepEqual(ids.filter((id) => id === 'H1019-006'), []);
    assert.ok(ids.includes('H5420-001'));
    assert.ok(ids.some((id) => id.startsWith('H1036')));
  });

  it('realignDoctorStatuses remaps by plan ID when a same-length swap reorders columns', () => {
    const orig = [{ planId: 'H5420-001' }, { planId: 'H4140-022' }, { planId: 'H1019-006' }];
    const kept = [{ planId: 'H5420-001' }, { planId: 'H4140-022' }, { planId: 'H1036-054C' }];
    const doctors = [{ name: 'Aaron Bernard Tuckler', statuses: ['Not confirmed', 'In network', 'In network'] }];
    const aligned = exp.realignDoctorStatuses(doctors, orig, kept);
    assert.equal(aligned[0].statuses[0], 'Not confirmed');
    assert.equal(aligned[0].statuses[1], 'In network');
    assert.notEqual(aligned[0].statuses[2], 'In network');
  });

  it('❔ unchecked chat cells export as Not confirmed, not Need more info', () => {
    const tbl = exp.latestChatTable([{ role: 'assistant', content: TABLE_3 }]);
    const row = tbl.rows.find((r) => /Tuckler/i.test(r.name));
    assert.ok(row);
    assert.equal(row.byPlan['H5420-001'], exp.NETWORK_NOT_CONFIRMED);
    assert.notEqual(row.byPlan['H5420-001'], exp.NETWORK_NEED_MORE);
  });
});

describe('Joan Benjamin 2026-11-19: CarePlus H1019-006 benefits are its own grid row', () => {
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  const m = html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  const catalog = JSON.parse(m[1]);
  const careplus = catalog.find((p) => String(p.planId || p.id).toUpperCase().slice(0, 9) === 'H1019-006' && p.county === 'Miami-Dade');
  const humana = catalog.find((p) => /H1036-054/i.test(String(p.planId || p.id)) && p.county === 'Miami-Dade');

  it('live 2027 grid: CarePlus 006 and Humana 054C both have $500 MOOP; hearing is not the same', () => {
    assert.ok(careplus && humana, 'both plans on the Miami-Dade 2027 grid');
    assert.equal(String(careplus.moop).replace(/\s+/g, ''), String(humana.moop).replace(/\s+/g, ''));
    assert.match(String(careplus.hearing), /575/);
    assert.match(String(careplus.hearing), /750/);
    assert.match(String(humana.hearing), /199/);
    assert.match(String(humana.hearing), /475/);
    assert.notEqual(String(careplus.hearing), String(humana.hearing));
  });

  it('export cells are keyed by plan ID, not column index — swapping order does not copy Humana hearing onto CarePlus', () => {
    const plansA = [careplus, humana];
    const plansB = [humana, careplus];
    const modelA = exp.buildComparisonModel({ plans: plansA, keepPlanOrder: true, clientName: 'Joan Benjamin' });
    const modelB = exp.buildComparisonModel({ plans: plansB, keepPlanOrder: true, clientName: 'Joan Benjamin' });
    const hearingA = modelA.aoa.find((row) => /^Hearing/i.test(String(row[0])));
    const hearingB = modelB.aoa.find((row) => /^Hearing/i.test(String(row[0])));
    assert.ok(hearingA && hearingB);
    assert.match(String(hearingA[1]), /575/);
    assert.match(String(hearingA[2]), /199/);
    assert.match(String(hearingB[1]), /199/);
    assert.match(String(hearingB[2]), /575/);
    const moop = modelA.aoa.find((row) => /Max Out of Pocket/i.test(String(row[0])));
    assert.match(String(moop[1]), /500/);
    assert.match(String(moop[2]), /500/);
  });
});

describe('planIdsFrom still accepts a comma list', () => {
  it('reads every ID', () => {
    assert.deepEqual(planIdsFrom('H5420-001, H4140-022, H1036-054C').map((id) => id.slice(0, 9)),
      ['H5420-001', 'H4140-022', 'H1036-054']);
  });
});
