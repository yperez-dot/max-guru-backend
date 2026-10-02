const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { searchKnowledge, getKnowledgeByKey, loadKnowledge } = require('../knowledge/loader');

const CLAUDE_PATH = path.join(__dirname, 'claude.js');
const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');
const EXPORT_PATH = path.join(__dirname, '../scripts/export_2027_grid_to_kb.py');

describe('HealthSpring 2027 South Florida — no MA in Miami-Dade / Broward', () => {
  it('KB states there is no HealthSpring 2027 MA plan to enroll into', () => {
    loadKnowledge({ force: true });
    const doc = getKnowledgeByKey('carriers/healthspring-plans-florida-2027');
    assert.ok(doc, 'expected carriers/healthspring-plans-florida-2027');
    assert.match(doc, /no.*2027.*Medicare Advantage|no.*2027 MA/i);
    assert.match(doc, /Miami-Dade/);
    assert.match(doc, /Broward/);
    assert.match(doc, /HealthSpring/);
    assert.match(doc, /Cigna/);
    assert.match(doc, /not\*\* quote 2026 HealthSpring|Do not quote 2026 HealthSpring/i);
    assert.match(doc, /in-network with Cigna so consider HealthSpring/i);
    assert.match(doc, /stale/i);
  });

  it('search_knowledge for HealthSpring 2027 Miami-Dade hits the no-plan note', () => {
    loadKnowledge({ force: true });
    const results = searchKnowledge('HealthSpring 2027 Miami-Dade Broward');
    assert.ok(results.length, 'expected KB hits');
    const keys = results.map((r) => r.key);
    assert.ok(
      keys.includes('carriers/healthspring-plans-florida-2027'),
      `keys=${keys.join(', ')}`
    );
    const hit = results.find((r) => r.key === 'carriers/healthspring-plans-florida-2027');
    assert.match(hit.content, /no HealthSpring plan to enroll into/i);
  });

  it('2027 overview lists HealthSpring as not offered, not waiting on SoB', () => {
    const overview = getKnowledgeByKey('carriers/plan-grid-overview-2027');
    assert.ok(overview);
    assert.match(overview, /## Not offered in Miami-Dade \/ Broward 2027/);
    assert.match(overview, /HealthSpring \/ Cigna/);
    const waitingIdx = overview.indexOf('## Still waiting on the official October 1 SoB');
    const waitingBlock = waitingIdx >= 0 ? overview.slice(waitingIdx, waitingIdx + 400) : '';
    assert.equal(
      /HealthSpring/.test(waitingBlock),
      false,
      'HealthSpring must not sit in the waiting-on-SoB list'
    );
  });

  it('system prompts and export skip leftover HealthSpring Dade/Broward 2027 cells', () => {
    const claude = fs.readFileSync(CLAUDE_PATH, 'utf8');
    assert.match(claude, /19\. CARRIER GEOGRAPHY 2027/);
    assert.match(claude, /no HealthSpring plan to enroll into/);
    assert.match(claude, /she's in-network with Cigna so consider HealthSpring/);
    assert.match(claude, /Cigna\/HealthSpring directory hits are not a 2027 Miami-Dade or Broward MA enrollment option/);

    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /20c\. CARRIER GEOGRAPHY 2027/);
    assert.match(html, /no HealthSpring plan to enroll into/);
    assert.match(html, /she's in-network with Cigna so consider HealthSpring/);

    const exportPy = fs.readFileSync(EXPORT_PATH, 'utf8');
    assert.match(exportPy, /is_healthspring_dade_broward/);
    assert.match(exportPy, /Not offered in Miami-Dade \/ Broward 2027/);
    const commonPy = fs.readFileSync(path.join(__dirname, '../scripts/thei_grid_common.py'), 'utf8');
    assert.match(commonPy, /HealthSpring/);
    assert.match(commonPy, /H5410-/);
    const waitingList = exportPy.match(/waiting = \[\s*\n([\s\S]*?)\n    \]/);
    assert.ok(waitingList, 'expected export waiting = [ ... ] list');
    assert.equal(
      /HealthSpring/.test(waitingList[1]),
      false,
      'export waiting list must not re-add HealthSpring as waiting on SoB'
    );
  });
});
