const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');
const CLAUDE_PATH = path.join(__dirname, 'claude.js');
const SERVER_PATH = path.join(__dirname, '../server.js');
const ARCHIVE_PATH = path.join(__dirname, '../artifacts/plan-data-2026.json');

function loadScriptPlans(html, id) {
  const m = html.match(
    new RegExp(`<script id="${id}" type="application/json">\\s*([\\s\\S]*?)\\s*</script>`)
  );
  assert.ok(m, `${id} block missing`);
  return JSON.parse(m[1]);
}

describe('live plan-data defaults to 2027', () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const plans = loadScriptPlans(html, 'plan-data');
  const archived = loadScriptPlans(html, 'plan-data-2026');
  const fileArchive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8'));

  it('marks live #plan-data as year 2027 and keeps a 2026 archive', () => {
    assert.ok(plans.length > 0);
    assert.equal(plans.every((p) => p.year === 2027), true);
    assert.equal(html.includes('DEFAULT_PLAN_YEAR = 2027'), true);
    assert.equal(html.includes('data-testid="plan-year-toggle"'), true);
    assert.equal(archived.length, 150);
    assert.equal(archived.every((p) => (p.year || 2026) === 2026), true);
    assert.equal(fileArchive.length, 150);
  });

  it('does not put HealthSpring / H5410 back on the 2027 grid', () => {
    const bad = plans.filter(
      (p) =>
        p.carrier === 'HealthSpring' ||
        String(p.id || '').toUpperCase().startsWith('H5410') ||
        String(p.planId || '').toUpperCase().startsWith('H5410')
    );
    assert.deepEqual(bad, []);
    const oldHs = archived.filter((p) => String(p.id || '').toUpperCase().startsWith('H5410'));
    assert.ok(oldHs.length >= 2, '2026 archive should still hold HealthSpring');
  });

  it('uses 2027 H1045-012 dollars, not the 2026 $4.8 premium', () => {
    const live = plans.filter((p) => String(p.id || p.planId).includes('H1045-012'));
    assert.equal(live.length, 2);
    for (const p of live) {
      assert.equal(p.year, 2027);
      assert.equal(p.premium, '$0');
      assert.match(String(p.moop), /9,850|9850/);
      assert.equal(String(p.premium).includes('4.8'), false);
    }
    const old = archived.filter((p) => String(p.id || p.planId).includes('H1045-012'));
    assert.ok(old.some((p) => String(p.premium).includes('4.8')));
  });

  it('keeps Gold Kidney H1526-002 on 2027 with a yellow-cell count', () => {
    // 2026-10-05 grid: MOOP / premium became confirmed (non-yellow) and synced.
    // 2026-10-17 grid: no yellow cells are left on the native sheet, so the
    // count is 0; it must still be a number so the page can flag leftovers.
    const gk = plans.filter((p) => String(p.id || p.planId) === 'H1526-002');
    assert.ok(gk.length >= 1);
    for (const p of gk) {
      assert.equal(p.year, 2027);
      assert.equal(typeof p.yellowLeft, 'number');
    }
  });

  it('carries the 10/8 grid resync: Solis H0982-034 Broward is filled in and the Part B givebacks follow the grid', () => {
    const row = (id, county) => {
      const hit = plans.find((p) => p.planId === id && p.county === county);
      assert.ok(hit, `${id} ${county} missing`);
      return hit;
    };
    // Was "*" in every core cell, with a $202.90 giveback the grid no longer has.
    const solis = row('H0982-034', 'Broward');
    assert.equal(solis.premium, '$7.30');
    assert.equal(solis.moop, '$3,200');
    assert.equal(solis.partBGiveback, '$0');
    assert.equal(solis.erCopay, '$50');
    for (const key of ['premium', 'moop', 'pcpCopay', 'specialistCopay', 'erCopay', 'urgentCareCopay', 'tier1', 'tier2', 'tier3', 'tier4', 'tier5', 'tier6', 'rxDeductible', 'otc', 'hearing', 'transportation']) {
      assert.notEqual(String(solis[key]).trim(), '*', `H0982-034 ${key} still *`);
    }
    // Givebacks that were blank in Max.
    assert.equal(row('H5431-017', 'Miami-Dade').partBGiveback, '$202.90');
    assert.equal(row('H1290-013', 'Miami-Dade').partBGiveback, '$202');
  });

  it('carries the 10/17 EOC resync: UHC and Gold Kidney docs from the native sheet', () => {
    const row = (id, county) => {
      const hit = plans.find((p) => p.planId === id && p.county === county);
      assert.ok(hit, `${id} ${county} missing`);
      return hit;
    };
    // EOCs that were "EOC pending" on the grid at the 10/8 sync.
    assert.match(row('H5420-001', 'Miami-Dade').eocUrl, /h5420001000_en\.pdf$/);
    assert.match(row('H5420-014', 'Miami-Dade').eocUrl, /h5420014000_en\.pdf$/);
    assert.match(row('H1045-005', 'Broward').eocUrl, /h1045005000_en\.pdf$/);
    // =HYPERLINK() formula cells (Gold Kidney October docs) are read as links.
    assert.match(row('H1526-002', 'Miami-Dade').eocUrl, /Y0171_H1526002_EOC_0926_M\.pdf$/);
    assert.match(row('H1526-012', 'Broward').sobUrl, /Y0171_H1526012_SB_0926_M\.pdf$/);
    // Header with the id glued to "DSNP" still syncs.
    assert.match(row('H1045-063', 'Broward').eocUrl, /PCFL27HP0418504_000$/);
    // The UHC FL-Y6 SOB pasted into the Wellcare column is not shown as Wellcare's.
    assert.ok(!String(row('H1032-250', 'Broward').sobUrl || '').includes('PCFL27HP0412434'));
    // Cents keep two decimals.
    assert.equal(row('H1526-002', 'Miami-Dade').premium, '$7.30');
  });
});

describe('prompts say PLAN DATA is 2027', () => {
  it('updates claude.js, HTML attach, and TOOL_USE_APPENDIX', () => {
    const claude = fs.readFileSync(CLAUDE_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const server = fs.readFileSync(SERVER_PATH, 'utf8');
    assert.match(claude, /PLAN DATA is THEI's 2027 Plan Comparison Grid/);
    assert.equal(claude.includes("PLAN DATA is THEI's 2026 Plan Comparison Grid"), false);
    assert.match(html, /PLAN DATA is THEI's \$\{attachedYear\} Plan Comparison Grid/);
    assert.match(html, /ATTACHED_PLAN_YEAR=\$\{attachedYear\}/);
    assert.match(html, /if \(has27\) return 2027/);
    assert.match(html, /AEP default 2027/);
    assert.match(server, /2027 AEP default/);
    assert.match(claude, /pending SoB/);
  });
});
