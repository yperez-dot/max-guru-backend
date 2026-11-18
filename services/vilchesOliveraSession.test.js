// Vilches-Olivera session (2026-11-18): new comparison set must replace the loaded
// workup for Show benefits / Export; "did you doctors plan?" is a Doctors HCP ask;
// all-carrier doctor answers always report Doctors; Baptist PCPs × MedicareMax is No.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const exp = require('../artifacts/comparison-export.js');
const R = require('./comparisonRules');
const { formatDoctorsNetworkLine } = require('./doctorsHcp');
const { formatDoctorText } = require('./providerNetwork');
const HN = require('./hospitalNetworks');
const G = require('./medicalGroupRules');

const CAREPLUS = ['H1019-006', 'H1019-148', 'H1019-136', 'H1019-154', 'H1019-123', 'H1019-150', 'H1019-121'];
const WORKUP_IDS = ['H5420-001', ...CAREPLUS];
const NEW_IDS = ['H1609-093', 'H1290-062', 'H5420-001'];

function docTable(ids, doctors) {
  const head = ['Doctor', ...ids.map((id) => `Plan · ${id}`)];
  const sep = head.map(() => '---');
  const rows = doctors.map((d) => [d, ...ids.map(() => '✅ In')]);
  return [
    '**Doctors × plans**',
    '',
    `| ${head.join(' | ')} |`,
    `|${sep.join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function thread() {
  const workupTable = docTable(WORKUP_IDS, ['Dr. A', 'Dr. B', 'Dr. C', 'Dr. D']);
  const newTable = docTable(NEW_IDS, ['Dr. A', 'Dr. B']);
  return [
    { role: 'user', content: 'Loaded client workup. ZIP 33125. Current plan H5420-001. Plans:\n- UHC MedicareMax (H5420-001)\n' + CAREPLUS.map((id) => `- CarePlus (${id})`).join('\n') },
    { role: 'assistant', content: workupTable },
    { role: 'user', content: 'lets create a comparison with Aetna, Devoted, and UHC MedicareMax' },
    { role: 'assistant', content: `Aetna Medicare Select Care (H1609-093), Devoted CORE (H1290-062), UHC MedicareMax (H5420-001).\n\n${newTable}` },
    { role: 'user', content: 'remove all the careplus plans. pls add Aetna core plan' },
    { role: 'assistant', content: `Comparison updated: H1609-093, H1290-062, H5420-001.\n\n${newTable}` },
    { role: 'user', content: 'Show benefits for these plans' },
  ];
}

describe('Vilches-Olivera: new comparison set replaces the workup for export', () => {
  it('latestChatTable does not merge the new 3-plan table into the 8-plan workup table', () => {
    const tbl = exp.latestChatTable(thread());
    assert.ok(tbl);
    assert.deepEqual(tbl.planIds.map((id) => String(id).slice(0, 9)), NEW_IDS);
    for (const id of CAREPLUS) {
      assert.ok(!tbl.planIds.includes(id), `${id} must not stay a column`);
    }
  });

  it('exportPlanIdsFromThread after "create a comparison" then remove-all-CarePlus add Aetna is the 3 named plans', () => {
    const ids = exp.exportPlanIdsFromThread(thread(), null, { currentPlanIds: ['H5420-001'] });
    assert.deepEqual(ids.map((id) => String(id).slice(0, 9)), ['H5420-001', 'H1609-093', 'H1290-062']);
  });

  it('workingPlanIdsFromUserMessages: remove all CarePlus then add an Aetna ID in one message', () => {
    const w = exp.workingPlanIdsFromUserMessages([
      'Compare H5420-001, H1019-006, H1019-148, H1019-136',
      'remove all the careplus plans. pls add H1609-093',
    ]);
    assert.deepEqual(w, ['H5420-001', 'H1609-093']);
  });

  it('userReplacesPlanSet matches the session wording', () => {
    assert.equal(exp.userReplacesPlanSet('lets create a comparison with Aetna, Devoted, and UHC MedicareMax'), true);
    assert.equal(exp.userReplacesPlanSet('remove all the careplus plans. pls add Aetna core plan'), true);
    assert.equal(exp.userReplacesPlanSet('try Alan Dal Pra'), false);
  });

  it('stale planSetFixed workup columns lose to the later chat table', () => {
    const workupPlans = WORKUP_IDS.map((planId) => ({ planId, id: planId, planName: planId }));
    const tbl = exp.latestChatTable(thread());
    const resolved = exp.resolveExportPlans(workupPlans, 'Show benefits for these plans', {
      planSetFixed: true,
      chatTable: tbl,
      userMessages: thread().filter((m) => m.role === 'user').map((m) => m.content),
      latestUserText: 'Show benefits for these plans',
      catalog: [...WORKUP_IDS, ...NEW_IDS].map((planId) => ({ planId, id: planId, planName: planId, county: 'Miami-Dade' })),
    });
    const ids = resolved.map((p) => String(p.planId || p.id).slice(0, 9));
    assert.deepEqual(ids.sort(), [...NEW_IDS].sort());
    for (const id of CAREPLUS) assert.ok(!ids.includes(id), `${id} leaked into export`);
  });
});

describe('Vilches-Olivera: "did you doctors plan?" is a Doctors HealthCare ask', () => {
  it('carriersRequested reads doctors-plan / DrSelect without treating a removal as an ask', () => {
    assert.deepEqual(R.carriersRequested('did you doctors plan?'), ['Doctors HealthCare']);
    assert.deepEqual(R.carriersRequested('did you Doctors Healthcare?'), ['Doctors HealthCare']);
    assert.ok(R.carriersRequested('check DrSelect for her PCP').includes('Doctors HealthCare'));
    assert.deepEqual(R.carriersRequested('remove the doctors plan'), []);
  });
});

describe('Vilches-Olivera: all-carrier answers always report Doctors HealthCare', () => {
  it('a finished miss is Not in network (not listed), not silent', () => {
    const line = formatDoctorsNetworkLine({ inNetwork: false, matches: [], error: null, source: 'live' }, '33125');
    assert.match(line, /Doctors HealthCare/);
    assert.match(line, /Not in network \(not listed\)/);
  });

  it('a PDF miss and an In hit both get a line', () => {
    assert.match(formatDoctorsNetworkLine({
      inNetwork: false, error: null, source: 'pdf_miss', pdfCounties: ['Miami-Dade'], pdfAsOf: 'Oct 2026',
    }, '33125'), /not listed in the 2027 Miami-Dade directory PDF/);
    assert.match(formatDoctorsNetworkLine({ inNetwork: true, source: 'pdf', error: null }, '33125'), /IN network \(H4140\)/);
  });

  it('formatDoctorText still names Doctors when other carriers are In', () => {
    const text = formatDoctorText({
      doctorName: 'Elizabeth Vilches-Olivera',
      zip: '33125',
      planYear: 2027,
      providerResults: [{
        name: 'ELIZABETH VILCHES-OLIVERA',
        npi: '1740522663',
        specialty: 'Internal Medicine',
        address: 'Miami, FL',
        inNetworkFor: ['Humana', 'HealthSun'],
        checkedGuest: ['FL Blue', 'Cigna', 'HealthSun', 'Devoted', 'Doctors'],
        lookupErrors: [],
        pending: [],
        doctorsResult: { inNetwork: false, matches: [], error: null, source: 'pdf_miss', pdfCounties: ['Miami-Dade', 'Broward'], pdfAsOf: 'Oct 2026' },
      }],
      sunfire: { labels: [], error: 'skipped' },
      timedOut: false,
    });
    assert.match(text, /In-network for: Humana, HealthSun/);
    assert.match(text, /Doctors HealthCare/);
    assert.match(text, /Not in network \(not listed\)/);
  });
});

describe('Baptist PCPs × MedicareMax No as of 01.01.2027; hospital stays Yes', () => {
  const medicareMax = { carrier: 'UnitedHealthcare', planId: 'H5420-001', name: 'UHC MedicareMax FL-0028' };
  it('grid cells', () => {
    assert.equal(HN.pcpIn('Baptist PCPs', medicareMax), false);
    assert.equal(HN.inNetwork('Baptist Hospital', medicareMax), true);
    assert.deepEqual(HN.yesCarriers('Baptist PCPs'), ['FL BLUE']);
  });

  it('BHMG 2027 primary care is Florida Blue only', () => {
    const rule = G.GROUP_RULES.find((x) => x.key === 'bhmg-pcp');
    assert.ok(rule.acceptsPlan({ carrier: 'Florida Blue', planId: 'H1035-017', name: 'Florida Blue Medicare' }, 2027));
    assert.ok(!rule.acceptsPlan(medicareMax, 2027));
    assert.ok(!rule.acceptsCarrier('MedicareMax', 2027));
    assert.match(rule.acceptsForYear(2027), /Florida Blue only/);
  });
});
