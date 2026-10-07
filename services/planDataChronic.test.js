const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');

function livePlans() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(m, 'plan-data block missing');
  return JSON.parse(m[1]);
}

describe('2027 C-SNP chronic conditions come from the grid list, not the SSBCI link', () => {
  const plans = livePlans();

  it('H1036-121 (Humana Gold Plus Diabetes & Heart) lists its three qualifying conditions', () => {
    const rows = plans.filter((p) => p.id === 'H1036-121');
    assert.equal(rows.length, 2, 'Miami-Dade + Broward');
    for (const p of rows) {
      assert.match(p.chronicConditions, /Diabetes Mellitus/);
      assert.match(p.chronicConditions, /Chronic Heart Failure/);
      assert.match(p.chronicConditions, /Cardiovascular Disorders/);
      assert.equal(p.ssbciChronicConditions, 'Chronic Condition Look Up');
    }
  });

  it('no C-SNP has the "Chronic Condition Look Up" placeholder as its qualifying list', () => {
    const csnp = plans.filter((p) => p.type === 'C-SNP');
    assert.ok(csnp.length >= 30);
    const bad = csnp.filter((p) => !p.chronicConditions || /look\s*up/i.test(p.chronicConditions));
    assert.deepEqual(bad.map((p) => `${p.id} ${p.county}`), []);
  });
});
