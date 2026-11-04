const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { searchKnowledge, getKnowledgeByKey, loadKnowledge } = require('../knowledge/loader');

const ONBOARDING_DIR = path.join(__dirname, '../max-knowledge/onboarding');

describe('THEI onboarding / carrier contracting KB', () => {
  it('loads the four onboarding sources', () => {
    loadKnowledge({ force: true });
    for (const key of [
      'onboarding/process',
      'onboarding/carrier-contracting',
      'onboarding/release-transfer',
      'onboarding/nextere-steps',
    ]) {
      const doc = getKnowledgeByKey(key);
      assert.ok(doc, `expected ${key}`);
    }
  });

  it('UHC contracting question returns the onboarding source with UHC steps', () => {
    loadKnowledge({ force: true });
    const results = searchKnowledge("what's the contracting process for unitedhealthcare");
    assert.ok(results.length, 'expected KB hits');
    const keys = results.map((r) => r.key);
    assert.ok(
      keys.includes('onboarding/carrier-contracting'),
      `expected onboarding/carrier-contracting in keys=${keys.join(', ')}`
    );
    const hit = results.find((r) => r.key === 'onboarding/carrier-contracting');
    assert.match(hit.content, /UnitedHealthcare/i);
    assert.match(hit.content, /ucontracting@aiasvcs\.com/i);
    assert.match(hit.content, /Producer Express/i);
    assert.match(hit.content, /not Nextere/i);
  });

  it('Nextere source names only Doctors, HealthSun, Solis and tenant NHP', () => {
    const doc = getKnowledgeByKey('onboarding/nextere-steps');
    assert.match(doc, /tenant.*NHP/i);
    assert.match(doc, /Doctors/);
    assert.match(doc, /HealthSun/);
    assert.match(doc, /Solis/);
    assert.match(doc, /Do not use Nextere for UnitedHealthcare/i);
  });

  it('unattributed release slides stay unlabeled', () => {
    const doc = getKnowledgeByKey('onboarding/release-transfer');
    assert.match(doc, /Unattributed slides/);
    assert.match(doc, /Do not guess a carrier|do not guess the carrier/i);
    assert.match(doc, /USE MGA form[\s\S]*Humana MGA/i);
  });

  it('onboarding markdown has no SSN-shaped values', () => {
    const files = fs.readdirSync(ONBOARDING_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 4);
    for (const f of files) {
      const text = fs.readFileSync(path.join(ONBOARDING_DIR, f), 'utf8');
      assert.equal(
        /\b\d{3}-\d{2}-\d{4}\b/.test(text),
        false,
        `${f} must not contain SSN-shaped numbers`
      );
    }
  });
});
