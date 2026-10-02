const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { REPLY_STYLE_RULE } = require('./replyStyle');
const { SYSTEM_PROMPT } = require('./claude');

describe('Yahoska reply-style hard rule', () => {
  it('states lead-with-answer, short bullets, and no unsolicited export closers', () => {
    assert.match(REPLY_STYLE_RULE, /Lead with the answer/);
    assert.match(REPLY_STYLE_RULE, /drug list \+ verified tiers/);
    assert.match(REPLY_STYLE_RULE, /short bullets for parallel facts/i);
    assert.match(REPLY_STYLE_RULE, /remap explanations/);
    assert.match(REPLY_STYLE_RULE, /source essays/);
    assert.match(REPLY_STYLE_RULE, /cross-plan asides/);
    assert.match(REPLY_STYLE_RULE, /click Export Excel \/ Export PDF/);
    assert.match(REPLY_STYLE_RULE, /unless she explicitly asked to export/);
    assert.match(REPLY_STYLE_RULE, /Excel\/PDF chips already speak for themselves/);
  });

  it('is wired into SYSTEM_PROMPT and the live TOOL_USE_APPENDIX', () => {
    assert.ok(
      SYSTEM_PROMPT.includes(REPLY_STYLE_RULE),
      'legacy SYSTEM_PROMPT must include REPLY_STYLE_RULE'
    );

    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(server, /require\('\.\/services\/replyStyle'\)/);
    assert.match(server, /\$\{REPLY_STYLE_RULE\}/);
    assert.match(server, /Mention Export Excel \/ Export PDF only when the agent explicitly asked to export/);
  });
});
