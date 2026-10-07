const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const caret = require('../artifacts/composerCaret.js');
const HTML_PATH = path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html');

function fakeEl(overrides) {
  const el = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 200,
    scrollWidth: 400,
    clientHeight: 46,
    clientWidth: 280,
    style: { height: '46px' },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    ...overrides,
  };
  return el;
}

const PADRON = 'My clients have UnitedHealthcare UHC MedicareMax Complete Care FL-30 (HMO D-SNP) (H5430-14-0) and this plan is being discontinued for 2027. its for maria and gaspar padron. they have the following drs and meds: Ernesto Padron PCP. look up their drs too';

describe('composer caret helpers', () => {
  it('pins when focus left the caret at the start and scroll at the top', () => {
    const el = fakeEl({ value: PADRON, selectionStart: 0, selectionEnd: 0 });
    assert.equal(caret.shouldPinCaretToEnd(el), true);
    caret.revealComposerEnd(el);
    assert.equal(el.selectionStart, el.value.length);
    assert.equal(el.selectionEnd, el.value.length);
    assert.equal(el.scrollTop, el.scrollHeight);
    assert.equal(el.scrollLeft, el.scrollWidth);
  });

  it('pins when mobile select-all left the whole draft highlighted at the top', () => {
    const el = fakeEl({ value: PADRON, selectionStart: 0, selectionEnd: PADRON.length });
    assert.equal(caret.shouldPinCaretToEnd(el), true);
    caret.placeCaretAtEnd(el);
    assert.equal(el.selectionStart, PADRON.length);
    assert.equal(el.selectionEnd, PADRON.length);
  });

  it('scrolls to the end when caret is already at the end but the box shows the top', () => {
    const el = fakeEl({
      value: PADRON,
      selectionStart: PADRON.length,
      selectionEnd: PADRON.length,
      scrollTop: 0,
      scrollLeft: 0,
    });
    assert.equal(caret.shouldPinCaretToEnd(el), false);
    caret.revealComposerEnd(el);
    assert.equal(el.selectionStart, PADRON.length);
    assert.equal(el.scrollTop, el.scrollHeight);
  });

  it('does not yank a mid-message caret', () => {
    const el = fakeEl({
      value: PADRON,
      selectionStart: 8,
      selectionEnd: 8,
      scrollTop: 40,
      scrollLeft: 12,
    });
    assert.equal(caret.shouldPinCaretToEnd(el), false);
    caret.revealComposerEnd(el);
    assert.equal(el.selectionStart, 8);
    assert.equal(el.selectionEnd, 8);
    assert.equal(el.scrollTop, 40);
    assert.equal(el.scrollLeft, 12);
  });

  it('does not pin an empty composer', () => {
    const el = fakeEl({ value: '' });
    assert.equal(caret.shouldPinCaretToEnd(el), false);
    caret.revealComposerEnd(el);
    assert.equal(el.selectionStart, 0);
  });

  it('recognizes the Try again failure copy so the draft can be refilled', () => {
    assert.equal(caret.looksLikeFailedGuruReply("I couldn't generate a response. Try again."), true);
    assert.equal(caret.looksLikeFailedGuruReply("Couldn't reach Max. Check your connection and try again — if this keeps happening, Railway may be redeploying."), true);
    assert.equal(caret.looksLikeFailedGuruReply("Max is still working — try again in a minute. A long doctor or Rx check can outlast the browser wait."), true);
    assert.equal(caret.looksLikeFailedGuruReply('Got it — here is H1045-012 vs H1045-061.'), false);
  });

  it('keeps scroll and caret when resizing while editing in the middle', () => {
    const value = 'a'.repeat(80);
    const el = fakeEl({
      value,
      selectionStart: 10,
      selectionEnd: 10,
      scrollTop: 55,
      scrollHeight: 260,
    });
    caret.resizeComposer(el);
    assert.equal(el.selectionStart, 10);
    assert.equal(el.selectionEnd, 10);
    assert.equal(el.scrollTop, 55);
    assert.equal(el.style.height, `${caret.COMPOSER_MAX_PX}px`);
  });

  it('scrolls to the end when resizing with the caret at the end', () => {
    const value = 'a'.repeat(80);
    const el = fakeEl({
      value,
      selectionStart: value.length,
      selectionEnd: value.length,
      scrollTop: 0,
      scrollHeight: 180,
    });
    caret.resizeComposer(el);
    assert.equal(el.scrollTop, 180);
  });
});

describe('live UI wires the caret helpers', () => {
  it('inlines MaxComposerCaret and uses a textarea composer', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /MAX_COMPOSER_CARET_BEGIN/);
    assert.match(html, /root\.MaxComposerCaret = api/);
    assert.match(html, /<textarea/);
    assert.match(html, /data-testid="chat-composer"/);
    assert.match(html, /MaxComposerCaret\.scheduleRevealComposerEnd/);
    assert.match(html, /MaxComposerCaret\.placeCaretAtEnd/);
    assert.match(html, /refillComposerFromFailedSend/);
    assert.match(html, /data-testid="reuse-user-message"/);
    assert.doesNotMatch(html, /onKeyDown=\{\(e\) => e\.key === "Enter" && send\(\)\}/);
    assert.match(html, /\.max-composer-row textarea/);
  });
});

describe('Copy text button on Max replies', () => {
  it('assistant bubbles get a Copy text button that copies the rendered reply', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /data-testid="copy-reply"/);
    assert.match(html, /copyReply\(e, i, m\.content\)/);
    assert.match(html, /navigator\.clipboard\.writeText\(text\)/);
  });
});

describe('Show benefits button', () => {
  it('the export offer has a Show benefits button that asks Max for the benefits reply', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /data-testid="show-benefits"/);
    assert.match(html, /send\("Show benefits for these plans"\)/);
  });
});

describe('Comparison tables fit a phone', () => {
  it('table cells wrap and the table is full width, so plan columns are not pushed off-screen', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    const fn = html.slice(html.indexOf('function renderMdTable'), html.indexOf('// Lightweight, safe markdown-lite'));
    assert.doesNotMatch(fn, /whiteSpace: "nowrap"/);
    assert.match(fn, /width: "100%"/);
    assert.doesNotMatch(fn, /minWidth: i \? 120/);
  });
});

describe('Show benefits is offered once', () => {
  it('the button hides after Show benefits was already asked', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /String\(userMessageText\(x\.content\) \|\| ""\)\.trim\(\) === "Show benefits for these plans"/);
  });
});

describe('New client workspace', () => {
  it('replaces the queue screen: its own workspace, eligibility + must-have questions first, then auto-queue', () => {
    const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.doesNotMatch(html, /function QueuePanel\(/);
    assert.doesNotMatch(html, /function ComparePanel\(/);
    assert.match(html, /function ClientWsCard\(/);
    assert.match(html, /data-testid="new-client-header"/);
    assert.match(html, /data-testid="new-client-sidebar"/);
    assert.match(html, /are any of them a must\?/);
    // the comparison only starts once every question is answered
    const fn = html.slice(html.indexOf('const wsAnswer'), html.indexOf('const wsToggleMust'));
    assert.match(fn, /answers\.medicaid != null && answers\.csnp != null && mustDone/);
    // finished client updates the same workup and keeps its results
    const fin = html.slice(html.indexOf('const wsFinish'), html.indexOf('const wsPoll'));
    assert.match(fin, /body\.id = id/);
    assert.match(fin, /body\.compareResult = job\.result/);
  });
});
