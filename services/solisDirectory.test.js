const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  DIRECTORIES,
  FIND_A_PROVIDER,
  fipsForZip,
  directoryForZip,
  solisLookupNote,
  formatSolisNote,
} = require('./solisDirectory');

describe('solisDirectory zip → county PDF', () => {
  it('maps Miami-Dade zips to the MD PDF', () => {
    assert.equal(fipsForZip('33176'), '12086');
    assert.equal(directoryForZip('33126').key, 'miamiDade');
    assert.match(directoryForZip('33176').url, /ProvDirecMD_All_Next/);
  });

  it('maps Broward and Palm Beach to the shared PDF', () => {
    assert.equal(directoryForZip('33312').key, 'browardPalmBeach');
    assert.equal(directoryForZip('33401').key, 'browardPalmBeach');
    assert.match(directoryForZip('33312').url, /ProvDirecBDPB_All_Next/);
  });

  it('does not invent a county for unknown zips — lists all three PDFs', () => {
    assert.equal(directoryForZip('32801'), null);
    const note = solisLookupNote('32801');
    assert.equal(note.searchable, false);
    assert.equal(note.directories.length, 3);
    assert.equal(note.findAProviderUrl, FIND_A_PROVIDER);
  });

  it('tells the agent Solis is not live-searchable', () => {
    const text = formatSolisNote('33176');
    assert.match(text, /not on Sunfire/i);
    assert.match(text, /2027 directory: Miami-Dade: \S+ProvDirecMD_All_Next/);
    assert.match(text, /solishealthplans\.com\/2027\/find-a-provider/);
    assert.match(formatSolisNote('33176', 2026), /ProvDirecMD_All_Current[\s\S]*2026\/find-a-provider/);
    assert.ok(Object.values(DIRECTORIES).every((d) => d.url.startsWith('https://')));
  });
});

describe('Solis 2027 directory index (name match)', () => {
  const { solisCheck } = require('./solisDirectory');
  it('Krajewski is listed in Miami-Dade (p. 93)', () => {
    const r = solisCheck({ firstName: 'EDUARDO', lastName: 'KRAJEWSKI', zip: '33172' });
    assert.equal(r.status, 'checked');
    assert.equal(r.inNetwork, true);
    assert.deepEqual(r.matches[0].pages, [93]);
  });
  it('Morytko, Cedeno, Del Conde Pozzi, Yavagal are not listed in Miami-Dade → checked miss', () => {
    for (const [f, l] of [['JOHN', 'MORYTKO'], ['JUAN', 'CEDENO'], ['IAN', 'DEL CONDE POZZI'], ['DILEEP', 'YAVAGAL']]) {
      const r = solisCheck({ firstName: f, lastName: l, zip: '33172' });
      assert.equal(r.status, 'checked', l);
      assert.equal(r.inNetwork, false, l);
    }
  });
  it('compound / hyphenated surnames and middle names match; a different first name does not', () => {
    assert.equal(solisCheck({ firstName: 'MAYTE', lastName: 'RUIZ-SANTIAGO', zip: '33172' }).inNetwork, true);
    assert.equal(solisCheck({ firstName: 'ANDREA', middleName: 'MELO', lastName: 'SOSA', zip: '33172' }).inNetwork, true);
    assert.equal(solisCheck({ firstName: 'CARLOS', lastName: 'SOSA', zip: '33172' }).inNetwork, false);
  });
  it('unknown county: a miss is not a check (unavailable), a hit still counts', () => {
    assert.equal(solisCheck({ firstName: 'JOHN', lastName: 'MORYTKO', zip: '' }).status, 'unavailable');
    assert.equal(solisCheck({ firstName: 'EDUARDO', lastName: 'KRAJEWSKI', zip: '' }).inNetwork, true);
  });
});

