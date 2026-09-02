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
    assert.match(directoryForZip('33176').url, /ProvDirecMD_All_Current/);
  });

  it('maps Broward and Palm Beach to the shared PDF', () => {
    assert.equal(directoryForZip('33312').key, 'browardPalmBeach');
    assert.equal(directoryForZip('33401').key, 'browardPalmBeach');
    assert.match(directoryForZip('33312').url, /ProvDirecBDPB_All_Current/);
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
    assert.match(text, /ProvDirecMD_All_Current/);
    assert.ok(Object.values(DIRECTORIES).every((d) => d.url.startsWith('https://')));
  });
});
