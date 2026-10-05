const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workups = require('../artifacts/client-workups.js');

const HTML = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');

function scriptJson(id) {
  const m = HTML.match(new RegExp(`<script id="${id}" type="application/json">\\s*([\\s\\S]*?)\\s*</script>`));
  assert.ok(m, `${id} block missing`);
  return m[1];
}

// Load the real plan-selection code out of the page (it lives inside a babel <script>).
function loadSelector() {
  const a0 = HTML.indexOf('const DEFAULT_PLAN_YEAR = 2027;');
  const a1 = HTML.indexOf('const HOSPITALS =');
  const b0 = HTML.indexOf('// ---- Cost control: attach only plans that match this ask');
  const b1 = HTML.indexOf('function buildSystemPrompt(');
  assert.ok(a0 > 0 && a1 > a0 && b0 > a1 && b1 > b0, 'selector source markers missing');
  const sandbox = {
    window: { MaxClientWorkups: workups },
    document: {
      getElementById: (id) => ({ textContent: id === 'plan-data' || id === 'plan-data-2026' ? scriptJson(id) : '[]' }),
    },
    URLSearchParams,
    location: { search: '' },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    HTML.slice(a0, a1) + '\n' + HTML.slice(b0, b1) + '\n;globalThis.__t = { selectPlansForAsk, countyScopeLine, PLANS };',
    sandbox
  );
  return sandbox.__t;
}

const { selectPlansForAsk, countyScopeLine, PLANS } = loadSelector();
const user = (content) => ({ role: 'user', content });
const size = (rows) => JSON.stringify(rows).length;

describe('gridCountyForZip', () => {
  it('maps Miami-Dade and Broward ZIPs, and returns "" outside the grid', () => {
    assert.equal(workups.gridCountyForZip('33332'), 'Broward');
    assert.equal(workups.gridCountyForZip('33021'), 'Broward');
    assert.equal(workups.gridCountyForZip('33065'), 'Broward');
    assert.equal(workups.gridCountyForZip('33441'), 'Broward');
    assert.equal(workups.gridCountyForZip('33004'), 'Broward');
    assert.equal(workups.gridCountyForZip('33172'), 'Miami-Dade');
    assert.equal(workups.gridCountyForZip('33186'), 'Miami-Dade');
    assert.equal(workups.gridCountyForZip('33016'), 'Miami-Dade');
    assert.equal(workups.gridCountyForZip('33033'), 'Miami-Dade');
    assert.equal(workups.gridCountyForZip('33401'), ''); // Palm Beach — not on the grid
    assert.equal(workups.gridCountyForZip('32801'), '');
    assert.equal(workups.gridCountyForZip(''), '');
    assert.equal(workups.gridCountyForZip('33332-1234'), 'Broward');
  });
});

describe('county-only plan attachment', () => {
  it('the grid has both counties to choose from', () => {
    assert.ok(PLANS.some((p) => p.county === 'Broward'));
    assert.ok(PLANS.some((p) => p.county === 'Miami-Dade'));
  });

  it('a ZIP alone scopes a carrier ask to that county (no county word typed)', () => {
    const sel = selectPlansForAsk([user('Client ZIP 33332. Compare Humana and Aetna plans, dental and OTC.')]);
    assert.equal(sel.needClarify, false);
    assert.ok(sel.plans.length > 0);
    assert.ok(sel.plans.every((p) => p.county === 'Broward'));
    assert.deepEqual(Array.from(sel.meta.counties), ["Broward"]);
    assert.equal(sel.meta.countyVia, 'zip');
  });

  it('is much smaller than the same ask with no county known', () => {
    const scoped = selectPlansForAsk([user('ZIP 33332. Humana plans with dental.')]);
    const unscoped = selectPlansForAsk([user('Humana plans with dental.')]);
    assert.equal(unscoped.meta.countyVia, '');
    assert.ok(unscoped.plans.some((p) => p.county === 'Miami-Dade') && unscoped.plans.some((p) => p.county === 'Broward'));
    assert.ok(scoped.plans.length < unscoped.plans.length);
    assert.ok(size(scoped.plans) <= size(unscoped.plans) * 0.6);
  });

  it('the Padron plan IDs resolve to one Broward row each', () => {
    const sel = selectPlansForAsk([user('ZIP 33332 compare H1036-065C, H1609-018 and H1045-005')]);
    assert.ok(sel.plans.every((p) => p.county === 'Broward'));
    assert.deepEqual(Array.from(new Set(sel.plans.map((p) => p.planId))).sort(), ['H1036-065C', 'H1045-005', 'H1609-018']);
    assert.equal(sel.plans.length, 3);
  });

  it('a plan ID that exists in both counties keeps only the client county copy', () => {
    const counties = new Map();
    PLANS.forEach((p) => counties.set(p.planId, (counties.get(p.planId) || new Set()).add(p.county)));
    const shared = Array.from(counties).find(([, c]) => c.size === 2);
    assert.ok(shared, 'grid should have at least one plan sold in both counties');
    const id = shared[0];
    const none = selectPlansForAsk([user(`what does ${id} offer?`)]);
    assert.equal(none.plans.length, 2, 'no county known → both copies');
    const bro = selectPlansForAsk([user(`ZIP 33332 what does ${id} offer?`)]);
    assert.equal(bro.plans.length, 1);
    assert.equal(bro.plans[0].county, 'Broward');
    const mia = selectPlansForAsk([user(`ZIP 33172 what does ${id} offer?`)]);
    assert.equal(mia.plans.length, 1);
    assert.equal(mia.plans[0].county, 'Miami-Dade');
  });

  it('keeps a named plan that only exists in the other county instead of dropping it', () => {
    const byId = new Map();
    PLANS.forEach((p) => byId.set(p.planId, (byId.get(p.planId) || new Set()).add(p.county)));
    const brokenOnly = [...byId].find(([, counties]) => counties.size === 1 && counties.has('Miami-Dade'));
    if (!brokenOnly) return; // grid has no single-county plan right now
    const sel = selectPlansForAsk([user(`ZIP 33332 what does ${brokenOnly[0]} offer?`)]);
    assert.ok(sel.plans.some((p) => p.planId === brokenOnly[0]));
  });

  it('unknown county: no county filter, and a vague grid ask still asks which county', () => {
    const vague = selectPlansForAsk([user('compare plans with dental')]);
    assert.equal(vague.needClarify, true);
    const palm = selectPlansForAsk([user('ZIP 33401 compare plans with dental')]);
    assert.equal(palm.needClarify, true, 'a Palm Beach ZIP is not a grid county');
    assert.equal(palm.meta.counties.length, 0);
  });

  it('"both counties" still means both, even with a ZIP in the thread', () => {
    const sel = selectPlansForAsk([user('ZIP 33332. Show Humana plans in both counties')]);
    assert.ok(sel.plans.some((p) => p.county === 'Miami-Dade'));
    assert.ok(sel.plans.some((p) => p.county === 'Broward'));
    assert.equal(countyScopeLine(sel.meta), '');
  });

  it('a loaded workup with a wrong saved county still follows its ZIP', () => {
    const ctx = workups.compactWorkupContext({ clientName: 'Padron', zip: '33332', county: 'Miami-Dade', plans: [] });
    assert.match(ctx, /ZIP\/county: 33332 \/ Miami-Dade/);
    const sel = selectPlansForAsk([user(ctx), user('what is the dental on the Humana plan?')]);
    assert.deepEqual(Array.from(sel.meta.counties), ["Broward"]);
    assert.ok(sel.plans.every((p) => p.county === 'Broward'));
  });

  it('the workup ZIP still scopes follow-ups after more than 4 user turns', () => {
    const ctx = workups.compactWorkupContext({ clientName: 'Padron', zip: '33332', county: 'Broward', plans: [] });
    const turns = [user(ctx)];
    for (let i = 0; i < 6; i++) turns.push({ role: 'assistant', content: 'ok' }, user(`follow up ${i} about Humana dental`));
    const sel = selectPlansForAsk(turns);
    assert.deepEqual(Array.from(sel.meta.counties), ["Broward"]);
    assert.ok(sel.plans.length > 0 && sel.plans.every((p) => p.county === 'Broward'));
  });

  it('the newest county signal wins over an older one', () => {
    const sel = selectPlansForAsk([
      user('ZIP 33172, Humana plans'),
      { role: 'assistant', content: 'ok' },
      user('actually the client moved to Broward, show Humana plans'),
    ]);
    assert.deepEqual(Array.from(sel.meta.counties), ["Broward"]);
  });

  it('education questions attach no plan rows even when a ZIP is known', () => {
    const sel = selectPlansForAsk([user('ZIP 33332'), { role: 'assistant', content: 'ok' }, user("what's IRMAA?")]);
    assert.equal(sel.plans.length, 0);
  });

  it('tells the model which county it has, only when exactly one', () => {
    const sel = selectPlansForAsk([user('ZIP 33332 Humana plans')]);
    assert.match(countyScopeLine(sel.meta), /COUNTY SCOPE: PLAN DATA is limited to Broward plans \(from the client's ZIP\)/);
    assert.equal(countyScopeLine({ counties: [] }), '');
  });
});

describe('workup county follows the ZIP', () => {
  it('saves Broward for 33332 even when the first plan row says Miami-Dade', () => {
    const w = workups.buildWorkupFromExport(
      { plans: [{ planId: 'H1036-065C', planName: 'Humana Gold Plus', carrier: 'Humana', county: 'Miami-Dade' }] },
      { threadText: 'Maria Padron, ZIP 33332', zip: '33332' }
    );
    assert.equal(w.zip, '33332');
    assert.equal(w.county, 'Broward');
  });

  it('falls back to the old guess when the ZIP is outside the grid', () => {
    const w = workups.buildWorkupFromExport({ plans: [] }, { threadText: 'ZIP 33401 Palm Beach client', zip: '33401' });
    assert.equal(w.county, 'Palm Beach');
  });
});
