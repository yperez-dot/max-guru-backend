// Grid working tags ("**NEW 2027**", stray "**") are not part of a plan's marketing name (2026-10-20).
// The 2027 sync strips them before #plan-data is written, and every render path cleans again.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PN = require('../artifacts/plan-name.js');
const EX = require('../artifacts/comparison-export.js');
const R = require('./comparisonRules');
const { gridTable } = require('./doctorPlanNarrow');

const HTML = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
function block(id) {
  const m = HTML.match(new RegExp(`<script id="${id}" type="application/json">\\s*([\\s\\S]*?)\\s*</script>`));
  assert.ok(m, `${id} block missing`);
  return JSON.parse(m[1]);
}

const CASES = [
  ['Humana Choice Giveback **NEW 2027', 'Humana Choice Giveback'],
  ['CarePlus CareBreeze **NEW 2027**', 'CarePlus CareBreeze'],
  ['Humana Choice Giveback NEW 2027**', 'Humana Choice Giveback'],
  ['Humana Choice Giveback (NEW 2027)', 'Humana Choice Giveback'],
  ['Humana Choice Giveback - NEW 2027', 'Humana Choice Giveback'],
  ['Humana Choice Giveback – new 2027', 'Humana Choice Giveback'],
  ['Humana Choice Giveback New 2027', 'Humana Choice Giveback'],
  ['Humana Choice Giveback NEW2027', 'Humana Choice Giveback'],
  ['Humana Choice Giveback [**NEW 2027**]', 'Humana Choice Giveback'],
  ['NEW 2027 - Humana Choice Giveback', 'Humana Choice Giveback'],
  ['Devoted GIVEBACK EXTRAS - NEW 2027 - Miami', 'Devoted GIVEBACK EXTRAS - Miami'],
  ['**Humana Choice Giveback**', 'Humana Choice Giveback'],
  ['  Humana   Choice Giveback  **  ', 'Humana Choice Giveback'],
  ['Doctors DrExtraCare **NEW**', 'Doctors DrExtraCare'],
  ['Doctors DrExtraCare NEW', 'Doctors DrExtraCare'],
  ['Wellcare Dual Align Unity (HMO D-SNP) NEW 2027', 'Wellcare Dual Align Unity (HMO D-SNP)'],
  ['Devoted C-SNP ENHANCED **NEW 2027', 'Devoted C-SNP ENHANCED'],
  ['Doctors DrPartialDual-SFL (HMO D-SNP) NEW 2027', 'Doctors DrPartialDual-SFL (HMO D-SNP)'],
  ['Complete Choice **PPO**', 'Complete Choice PPO'],
];

describe('cleanPlanName', () => {
  for (const [raw, want] of CASES) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(want)}`, () => assert.equal(PN.cleanPlanName(raw), want));
  }

  it('keeps NON-COMMISSIONABLE on R0759-001', () => {
    assert.equal(PN.cleanPlanName('AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE'), 'AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE');
    assert.equal(PN.cleanPlanName('AARP UHC Regional PPO FL-0031 **NON-COMMISSIONABLE**'), 'AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE');
  });

  it('never touches contract-PBP IDs or other name text', () => {
    for (const s of ['UHC MedicareMax FL-0028', 'Aetna Medicare Select HMO - H1609-018', 'Humana Gold Plus H1036-054C', 'UHC Dual Complete FL-Q3 (Reg. PPO D-SNP)',
      'Preferred Care Network H5420-001/0028', 'Brand New Plan', 'Newport Health Advantage', 'HumanaChoice 2027 PPO', 'CLOSED TO NEW ENROLL 2027']) {
      assert.equal(PN.cleanPlanName(s), s);
    }
  });

  it('withCleanPlanName leaves every other field alone', () => {
    const p = { id: 'H7617-145', planId: 'H7617-145', carrier: 'Humana', planName: 'Humana Choice Giveback **NEW 2027', premium: '$0' };
    const out = PN.withCleanPlanName(p);
    assert.deepEqual(out, { ...p, planName: 'Humana Choice Giveback' });
    assert.equal(p.planName, 'Humana Choice Giveback **NEW 2027', 'input not mutated');
    const clean = { id: 'R0759-001', planName: 'AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE' };
    assert.equal(PN.withCleanPlanName(clean), clean);
  });

  it('matches the Python sync cleaner (scripts/thei_grid_common.py) case for case', (t) => {
    const py = spawnSync('python3', ['-c', [
      'import json,sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '../scripts'))})`,
      'from thei_grid_common import clean_plan_marketing_name as c',
      'print(json.dumps([c(s) for s in json.loads(sys.stdin.read())]))',
    ].join('\n')], { input: JSON.stringify(CASES.map((c) => c[0]).concat(['AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE', 'Brand New Plan'])), encoding: 'utf8' });
    if (py.error || py.status !== 0) {
      if (/No module named 'openpyxl'|ENOENT/.test(String(py.stderr || py.error))) return t.skip('python3 / openpyxl not available');
      assert.fail(py.stderr || String(py.error));
    }
    const got = JSON.parse(py.stdout);
    const want = CASES.map((c) => c[1]).concat(['AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE', 'Brand New Plan']);
    assert.deepEqual(got, want);
  });
});

describe('committed 2027 #plan-data (regenerated from the grid sync)', () => {
  const plans = block('plan-data');

  it('has no NEW 2027 tag or stray ** in any 2027 plan name', () => {
    const bad = plans.filter((p) => /new\s*2027|\*/i.test(p.planName) || /\bNEW\s*$/.test(p.planName));
    assert.deepEqual(bad.map((p) => `${p.id} ${p.county}: ${p.planName}`), []);
  });

  it('R0759-001 keeps NON-COMMISSIONABLE in both counties', () => {
    const r = plans.filter((p) => p.id === 'R0759-001');
    assert.equal(r.length, 2);
    for (const p of r) assert.equal(p.planName, 'AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE');
  });

  it('new 2027 plans read by their marketing name', () => {
    const name = (id, county) => plans.find((p) => p.id === id && p.county === county).planName;
    assert.equal(name('H7617-145', 'Miami-Dade'), 'Humana Choice Giveback');
    assert.equal(name('H7617-145', 'Broward'), 'Humana Choice Giveback');
    assert.equal(name('H1019-154', 'Broward'), 'CarePlus CareBreeze');
    assert.equal(name('H4140-024', 'Broward'), 'Doctors DrExtraCare');
    assert.equal(name('H1032-250', 'Miami-Dade'), 'Wellcare Dual Align Unity (HMO D-SNP)');
  });
});

describe('render paths clean a tagged name (future sheet edits)', () => {
  const tagged = { id: 'H7617-145', planId: 'H7617-145', carrier: 'Humana', planName: 'Humana Choice Giveback **NEW 2027**', county: 'Miami-Dade', type: 'PPO', year: 2027 };
  const r0759 = { id: 'R0759-001', planId: 'R0759-001', carrier: 'UHC', planName: 'AARP UHC Regional PPO FL-0031 **NON-COMMISSIONABLE**', county: 'Miami-Dade', type: 'PPO', year: 2027 };
  afterEach(() => R.setGridForTests(null));

  it('Excel/PDF export column header', () => {
    assert.equal(EX.formatPlanMarketingName(tagged), 'Humana Choice Giveback');
    assert.equal(EX.formatPlanColumnHeader(tagged), 'Humana Choice Giveback\nH7617-145');
    assert.equal(EX.formatPlanMarketingName(r0759), 'AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE');
  });

  it('server grid (chat tables + compare card) reads clean names', () => {
    R.setGridForTests([tagged, r0759]);
    const names = R.gridPlansForCounty('Miami-Dade').map((p) => p.planName);
    assert.deepEqual(names.sort(), ['AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE', 'Humana Choice Giveback']);
  });

  it('chat table header', () => {
    const table = gridTable([], [{ planId: 'H7617-145', name: 'Humana Choice Giveback (NEW 2027)', in: [], out: [], unknown: [], carrier: 'Humana' }]);
    assert.match(table, /\| Doctor \| Humana Choice Giveback · H7617-145 \|/);
    assert.doesNotMatch(table.split('\n')[0], /NEW 2027|\*/);
  });

  it('page loads #plan-data through the cleaner and inlines artifacts/plan-name.js before the export lib', () => {
    const js = fs.readFileSync(path.join(__dirname, '../artifacts/plan-name.js'), 'utf8').replace(/\s+$/, '');
    const start = HTML.indexOf('<!-- MAX_PLAN_NAME_BEGIN -->');
    const stop = HTML.indexOf('<!-- MAX_PLAN_NAME_END -->');
    assert.ok(start > 0 && stop > start);
    assert.ok(HTML.slice(start, stop).includes(js), 'run: node scripts/sync_html_artifacts.js planname');
    assert.ok(start < HTML.indexOf('<!-- MAX_COMPARISON_EXPORT_BEGIN -->'));
    assert.match(HTML, /2027: \(window\.MaxPlanName \? window\.MaxPlanName\.cleanPlanList/);
  });
});
