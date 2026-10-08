// Paula Harris (2026-10-08): saved meds must reach the model every turn.
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('known meds note for the model', () => {
  const W = require('../artifacts/client-workups.js');
  const R = require('./comparisonRules.js');
  const ctx = W.compactWorkupContext({ clientName: 'Paula Harris', zip: '33169', county: 'Miami-Dade', medications: [{ name: 'amlodipine besylate TAB 5MG' }, { name: 'vitamin d CAP 1.25MG' }], doctors: [] });
  it('names the saved meds and forbids asking again', () => {
    const note = R.knownMedsNote([{ role: 'user', content: ctx }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'she has cardiovascular disorder' }]);
    assert.match(note, /amlodipine besylate TAB 5MG; vitamin d CAP 1.25MG/);
    assert.match(note, /Never ask her for medications/);
  });
  it('is empty when no meds are in the thread', () => {
    assert.equal(R.knownMedsNote([{ role: 'user', content: 'is Dr Smith in network 33178' }]), '');
  });
  it('/chat appends it to the system prompt', () => {
    assert.match(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), /\$\{priorNote\}\$\{knownMedsNote\(messages\)\}/);
  });
});
