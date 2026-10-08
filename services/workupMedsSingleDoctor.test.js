// Paula Harris (2026-10-08): loaded workup with saved meds + ONE doctor typed in chat must run the full
// comparison (meds priced), not a single-doctor lookup that then asks for meds she already has.
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('loaded workup meds + one doctor', () => {
  const src = fs.readFileSync(path.join(__dirname, 'providerNetwork.js'), 'utf8');
  it('treats a loaded workup with saved meds as table mode even for one doctor', () => {
    assert.match(src, /const workupWithMeds = !tableMode && .*structured facts only/s);
    assert.match(src, /const meds = tableMode \|\| workupWithMeds \? medsFromAsk\(askText\) : \[\]/);
    assert.match(src, /if \(!tableMode && !workupWithMeds\) \{/);
  });
  it('the ask text of that thread carries the saved meds', () => {
    const W = require('../artifacts/client-workups.js');
    const D = require('./doctorPlanNarrow.js');
    const R = require('./comparisonRules.js');
    const { conversationAskText } = require('./planYear');
    const ctx = W.compactWorkupContext({ clientName: 'Paula Harris', zip: '33169', county: 'Miami-Dade', medications: [{ name: 'amlodipine besylate TAB 5MG' }, { name: 'pravastatin sodium TAB 20MG' }], doctors: [] });
    const msgs = [{ role: 'user', content: ctx }, { role: 'assistant', content: 'Loaded' }, { role: 'user', content: 'Yes, Her Dr is Dr. Elda Regalado' }];
    assert.deepEqual(R.medsFromAsk(D.comparisonAskText(msgs, conversationAskText(msgs))), ['amlodipine besylate TAB 5MG', 'pravastatin sodium TAB 20MG']);
  });
});
