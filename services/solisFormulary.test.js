const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { solisFormularyLookup, solisStrengthVariants, isSolisPlan, keysFor, productIngredients, rowsForDrug } = require('./solisFormulary');
const idx = () => JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../data/solis-formulary-2027.json'), 'utf8'));

describe('Solis 2027 formulary index (Yahoska sent the PDF, 2026-10-07)', () => {
  it('finds Martin’s drugs on a Solis plan', () => {
    const o = solisFormularyLookup('Orgovyx', 'H0982-007', 2027);
    assert.equal(o.tier, 5);
    assert.equal(o.pa, true);
    assert.equal(o.ql, true);
    assert.equal(solisFormularyLookup('tadalafil', 'H0982-007', 2027).tier, 4);
    assert.equal(solisFormularyLookup('tamsulosin', 'H0982-007', 2027).tier, 1);
    assert.equal(solisFormularyLookup('esomeprazole', 'H0982-007', 2027).tier, 2);
  });

  it('matches a combo an agent types without the salts', () => {
    const r = solisFormularyLookup('amlodipine-benazepril', 'H0982-007', 2027);
    assert.equal(r.tier, 1);
    assert.match(r.matchedName, /benazepril/i);
  });

  it('matches a brand or its generic', () => {
    assert.equal(solisFormularyLookup('relugolix', 'H0982-007', 2027).tier, 5);
    assert.equal(solisFormularyLookup('Tamsulosin HCL', 'H0982-007', 2027).tier, 1);
  });

  it('answers only for Solis plans and only for the indexed year', () => {
    assert.equal(solisFormularyLookup('Orgovyx', 'H4140-023', 2027), null);
    assert.equal(solisFormularyLookup('Orgovyx', 'H0982-007', 2026), null);
    assert.equal(isSolisPlan('H0982-007'), true);
    assert.equal(isSolisPlan('H1036-065C'), false);
  });

  it('a drug that is not in the book returns null, never a guessed tier', () => {
    assert.equal(solisFormularyLookup('nonexistentdrugxyz', 'H0982-007', 2027), null);
    assert.equal(solisFormularyLookup('', 'H0982-007', 2027), null);
    assert.deepEqual(keysFor('a'), []);
  });

  it('plain amlodipine is the single-ingredient tablets, not combination products', () => {
    assert.deepEqual(productIngredients('amlodipine besylate tab 2.5 mg (base equivalent)'), ['amlodipine']);
    assert.deepEqual(productIngredients('amlodipine besylate-atorvastatin calcium tab 5-10 mg'), ['amlodipine', 'atorvastatin']);
    const rows = rowsForDrug('amlodipine', idx());
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((h) => /amlodipine besylate tab/i.test(h.name) && !/-/.test(h.name.replace(/base equivalent/i, ''))));
    const strengths = [...new Set(rows.map((h) => require('./solisFormulary').strengthOf(h.name)))].sort();
    assert.deepEqual(strengths, ['10 mg', '2.5 mg', '5 mg']);
    const vars = solisStrengthVariants('amlodipine', 'H0982-022', 2027);
    assert.ok(vars.every((v) => v.tier === 1 && !v.ql));
    assert.ok(!vars.some((v) => /atorvastatin|benazepril|valsartan|olmesartan|telmisartan/i.test(v.matchedName)));
  });

  it('an explicit combination search still matches that combo', () => {
    const combo = solisStrengthVariants('amlodipine-benazepril', 'H0982-022', 2027);
    assert.ok(combo.length >= 4);
    assert.ok(combo.every((v) => /benazepril/i.test(v.matchedName)));
    assert.equal(solisFormularyLookup('amlodipine-benazepril', 'H0982-007', 2027).tier, 1);
  });
});
