const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadKnowledge, getKnowledgeByKey, searchKnowledge } = require('../knowledge/loader');

describe('Carrier Ops knowledge and routing', () => {
  it('loads all three focused Hub documents with canonical URLs', () => {
    loadKnowledge({ force: true });
    const expected = {
      'hub/carrier-ops-devoted-hra': '/carrier-ops/devoted-hra',
      'hub/carrier-ops-uhc-fl-dsnp-crosswalk-2026': '/carrier-ops/uhc-fl-dsnp-crosswalk',
      'hub/carrier-ops-humana-plex-aep-2027': '/carrier-ops/humana-plex',
    };
    for (const [key, url] of Object.entries(expected)) {
      const doc = getKnowledgeByKey(key);
      assert.ok(doc, `${key} missing`);
      assert.match(doc, new RegExp(`agentmedicarehub\\.com${url.replaceAll('/', '\\/')}`));
    }
  });

  it('returns the Devoted SNP-only rule instead of the stale all-plans rule', () => {
    const results = searchKnowledge('Devoted HRA pay March 1 2026 SNP 5 calendar days');
    assert.equal(results[0].key, 'hub/carrier-ops-devoted-hra');
    assert.match(results[0].content, /C-SNP or D-SNP/);
    assert.match(results[0].content, /5 calendar days/);
    assert.match(results[0].content, /non-SNP HRAs are unpaid/);
  });

  it('finds UHC plan IDs and refuses inferred crosswalk rows', () => {
    const results = searchKnowledge('UHC H1045-063-000 Florida D-SNP crosswalk');
    assert.equal(results[0].key, 'hub/carrier-ops-uhc-fl-dsnp-crosswalk-2026');
    assert.match(results[0].content, /Never infer a row/);
    assert.match(results[0].content, /H1045-065-000/);
    assert.match(results[0].content, /without LTSS in Broward & Miami-Dade/);
    assert.match(results[0].content, /Members are crosswalking to H1045-063-000/);
  });

  it('limits PLEX phone guidance and keeps login links generic', () => {
    const doc = getKnowledgeByKey('hub/carrier-ops-humana-plex-aep-2027');
    assert.match(doc, /866-753-4920/);
    assert.match(doc, /Vantage \/ Agent Marketing Hub/);
    const phoneNumbers = doc.match(/\b\d{3}-\d{3}-\d{4}\b/g) || [];
    assert.deepEqual([...new Set(phoneNumbers)], ['866-753-4920']);
  });

  it('bakes Carrier Ops routing into backend and UI prompts', () => {
    const backend = fs.readFileSync(path.join(__dirname, 'claude.js'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    for (const prompt of [backend, ui]) {
      assert.match(prompt, /CARRIER OPS/);
      assert.match(prompt, /hub\/carrier-ops-/);
      assert.match(prompt, /866-753-4920/);
    }
  });
});
