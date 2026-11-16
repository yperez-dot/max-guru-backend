// Yahoska, 2026-11-12: comparing H1036-065C (Broward-only) with dual-county Humana
// plans without a county made Max assume Miami-Dade, warn "Not offered in Miami-Dade:
// H1036-065 (Broward grid)", and drop 065C from the doctor and med tables.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const R = require('./comparisonRules');
const N = require('./doctorPlanNarrow');
const E = require('../artifacts/comparison-export.js');

const RAY = 'Compare three 2027 Humana plans for client Ray Harris: Humana Gold Plus H1036-065C (HMO), Humana Gold Plus Giveback H1036-305 (HMO), and HumanaChoice Giveback H7617-110 (PPO).';

describe('county ask helpers', () => {
  it('H1036-065C is Broward-only; H1036-305 and H7617-110 are on both grids', () => {
    assert.deepEqual(R.countiesForPlanId('H1036-065C').sort(), ['Broward']);
    assert.ok(R.isCountySpecificPlan('H1036-065C'));
    const giveback = R.countiesForPlanId('H1036-305').sort();
    assert.deepEqual(giveback, ['Broward', 'Miami-Dade']);
    assert.equal(R.isCountySpecificPlan('H1036-305'), false);
  });

  it('needsCountyAsk is true when county is unknown and a named plan is county-specific', () => {
    assert.equal(R.needsCountyAsk(RAY, ['H1036-065C', 'H1036-305', 'H7617-110']), true);
    assert.equal(R.needsCountyAsk(`${RAY}\nThis is Broward.`, ['H1036-065C', 'H1036-305', 'H7617-110']), false);
    assert.equal(R.needsCountyAsk('ZIP 33186. Compare H1036-065C and H1036-305.', ['H1036-065C', 'H1036-305']), false);
    assert.equal(R.needsCountyAsk('what does H1036-305 offer?', ['H1036-305']), false);
  });
});

describe('selectComparison does not assume Miami-Dade', () => {
  it('asks Broward vs Miami-Dade and keeps H1036-065C when county is unknown', () => {
    const sel = N.selectComparison([], RAY, {});
    assert.equal(sel.needCounty, true);
    assert.ok(sel.questions.some((q) => q === R.COUNTY_QUESTION), sel.questions.join('\n'));
    assert.ok(sel.columns.some((c) => String(c.planId).toUpperCase().slice(0, 9) === 'H1036-065'), sel.columns.map((c) => c.planId).join(','));
    assert.ok(!sel.flags.some((f) => /Not offered in Miami-Dade/.test(f)), sel.flags.join('\n'));
    const text = N.renderedAnswer([], RAY, {});
    assert.match(text, /H1036-065/);
    assert.match(text, /Broward or Miami-Dade/);
    assert.doesNotMatch(text, /Not offered in Miami-Dade/);
  });

  it('after Broward, includes all three and does not ask again', () => {
    const sel = N.selectComparison([], `${RAY}\nThis is Broward.`, {});
    assert.equal(sel.needCounty, false);
    const ids = sel.columns.map((c) => String(c.planId).toUpperCase().slice(0, 9));
    assert.ok(ids.includes('H1036-065'));
    assert.ok(ids.includes('H1036-305'));
    assert.ok(ids.includes('H7617-110'));
    assert.ok(!sel.questions.includes(R.COUNTY_QUESTION));
    const text = N.renderedAnswer([], `${RAY}\nThis is Broward.`, {});
    assert.doesNotMatch(text, /Not offered in Broward/);
    assert.doesNotMatch(text, /Is the client in Broward or Miami-Dade/);
  });

  it('after Miami-Dade, drops H1036-065C with a not-offered warning', () => {
    const sel = N.selectComparison([], `${RAY}\nZIP 33186 Miami-Dade.`, {});
    assert.equal(sel.needCounty, false);
    assert.ok(!sel.columns.some((c) => String(c.planId).toUpperCase().slice(0, 9) === 'H1036-065'));
    assert.ok(sel.flags.some((f) => /Not offered in Miami-Dade: H1036-065/.test(f)), sel.flags.join('\n'));
  });

  it('does not ask again when county is already on the workup context', () => {
    const ask = `LOADED CLIENT WORKUP (structured facts only).\nClient: Ray Harris\nZIP/county: 33324 / Broward\n${RAY}`;
    const sel = N.selectComparison([], ask, {});
    assert.equal(sel.needCounty, false);
    assert.ok(sel.columns.some((c) => String(c.planId).toUpperCase().slice(0, 9) === 'H1036-065'));
  });
});

describe('export does not assume Miami-Dade', () => {
  it('exportCountyFromText is empty until Broward or Dade is said', () => {
    assert.equal(E.exportCountyFromText(RAY), '');
    assert.equal(E.exportCountyFromText(`${RAY}\nthis is Broward`), 'Broward');
    assert.equal(E.exportCountyFromText('ZIP 33186 Miami-Dade. Compare H1036-305.'), 'Miami-Dade');
  });

  it('benefitsTable does not warn not-offered when county is unknown', () => {
    const pool = R.gridPlansForCounty('');
    const rows = E.benefitPlansFor(['H1036-065C', 'H1036-305', 'H7617-110'], pool, '');
    assert.ok(rows.some((p) => String(p.planId).toUpperCase().slice(0, 9) === 'H1036-065'));
    const t = E.benefitsTable(rows, '');
    assert.doesNotMatch(t, /Not offered in Miami-Dade/);
    assert.match(t, /H1036-065/);
  });
});
