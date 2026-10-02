const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { searchKnowledge, getKnowledgeByKey, loadKnowledge } = require('../knowledge/loader');

const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');
const CLAUDE_PATH = path.join(__dirname, 'claude.js');

function loadPlans() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const m = html.match(/<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(m, 'plan-data block missing');
  return { html, plans: JSON.parse(m[1]) };
}

describe('H1019-150 crowns / bridges in live plan-data', () => {
  it('uses 2027 grid Crowns=No / Bridges 30% (not the 2026 2-every-5 overlay)', () => {
    const { plans } = loadPlans();
    const hits = plans.filter((p) => (p.id || p.planId) === 'H1019-150');
    assert.equal(hits.length, 2);
    for (const p of hits) {
      assert.equal(p.year, 2027);
      assert.equal(p.dentalCrowns, 'No', `${p.county} crowns`);
      assert.match(String(p.dentalBridges), /Yes/i);
      assert.equal(/2 every 5 years/i.test(String(p.dentalCrowns)), false);
      assert.equal(/varies/i.test(String(p.dentalCrowns)), false);
    }
  });
});

describe('UI prompt + filter for dental procedures', () => {
  it('includes Rule 13b and does not send agents to ChatGPT on crowns', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /13b\. DENTAL PROCEDURE QUESTIONS/);
    assert.match(html, /Do NOT answer only "\$0 varies"/);
    assert.match(html, /do not send the agent to ChatGPT/);
    assert.match(html, /careplus-carecomplete-h1019-150/);
    const claude = fs.readFileSync(CLAUDE_PATH, 'utf8');
    assert.match(claude, /13b\. DENTAL PROCEDURE QUESTIONS/);
  });

  it('treats crowns and CareComplete as a plan-grid ask', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /crowns\?\|bridges\?\|implants\?\|dentures\?/);
    assert.match(html, /detectPlanNameHints/);
    assert.match(html, /care\\s\*complete/);
  });
});

describe('KB search hits H1019-150 crowns', () => {
  it('loads the focused CareComplete dental note', () => {
    loadKnowledge({ force: true });
    const doc = getKnowledgeByKey('carriers/careplus-carecomplete-h1019-150');
    assert.ok(doc);
    assert.match(doc, /Crowns \(2027\)/);
    assert.match(doc, /\*\*No\.\*\*/);
    assert.match(doc, /H1019-150/);
    assert.match(doc, /Bridges/);
    assert.match(doc, /do \*\*not\*\* quote the 2026/i);
  });

  it('search_knowledge for H1019-150 crowns returns the CarePlus note', () => {
    const results = searchKnowledge('H1019-150 crowns CareComplete');
    assert.ok(results.length, 'expected KB hits');
    const keys = results.map((r) => r.key);
    assert.ok(
      keys.some((k) => k.includes('careplus-carecomplete-h1019-150') || k.includes('careplus-plans-florida-2027')),
      `keys=${keys.join(', ')}`
    );
    const blob = results.map((r) => r.content).join('\n');
    assert.match(blob, /Crowns \(2027\)|Crowns = `No`|does \*\*not\*\* cover crowns/i);
  });

  it('2027 CarePlus KB has Crowns=No on both H1019-150 sections', () => {
    const md = getKnowledgeByKey('carriers/careplus-plans-florida-2027');
    assert.ok(md);
    const crowns = [...md.matchAll(/## CarePlus CareComplete[^\n]*\(H1019-150\)[\s\S]*?\| Crowns \| No \|/g)];
    assert.equal(crowns.length, 2, 'expected Crowns | No on Dade and Broward H1019-150');
  });
});
