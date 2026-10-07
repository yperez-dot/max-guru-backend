const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { solisFormularyLookup, isSolisPlan, keysFor } = require('./solisFormulary');

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
});
