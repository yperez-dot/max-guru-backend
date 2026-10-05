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
    style: { height: '46px' },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    ...overrides,
  };
  return el;
}

describe('composer caret helpers', () => {
  it('pins when focus left the caret at the start and scroll at the top', () => {
    const el = fakeEl({ value: 'long draft about H1045-012', selectionStart: 0, selectionEnd: 0 });
    assert.equal(caret.shouldPinCaretToEnd(el), true);
    caret.pinCaretToEndIfReset(el);
    assert.equal(el.selectionStart, el.value.length);
    assert.equal(el.selectionEnd, el.value.length);
    assert.equal(el.scrollTop, el.scrollHeight);
    assert.equal(el.scrollLeft, el.scrollWidth);
  });

  it('pins when mobile select-all left the whole draft highlighted at the top', () => {
    const value = 'Client: Muskat\nCompare H1045-012 and H1045-061';
    const el = fakeEl({ value, selectionStart: 0, selectionEnd: value.length });
    assert.equal(caret.shouldPinCaretToEnd(el), true);
    caret.placeCaretAtEnd(el);
    assert.equal(el.selectionStart, value.length);
    assert.equal(el.selectionEnd, value.length);
  });

  it('does not yank a mid-message caret', () => {
    const value = 'Client: Muskat — compare two plans';
    const el = fakeEl({
      value,
      selectionStart: 8,
      selectionEnd: 8,
      scrollTop: 40,
      scrollLeft: 12,
    });
    assert.equal(caret.shouldPinCaretToEnd(el), false);
    caret.pinCaretToEndIfReset(el);
    assert.equal(el.selectionStart, 8);
    assert.equal(el.selectionEnd, 8);
    assert.equal(el.scrollTop, 40);
    assert.equal(el.scrollLeft, 12);
  });

  it('does not pin an empty composer', () => {
    const el = fakeEl({ value: '' });
    assert.equal(caret.shouldPinCaretToEnd(el), false);
    caret.pinCaretToEndIfReset(el);
    assert.equal(el.selectionStart, 0);
  });

  it('keeps scroll and caret when resizing while editing in the middle', () => {
    const value = 'a'.repeat(80);
    const el = fakeEl({
      value,
      selectionStart: 10,
      selectionEnd: 10,
      scrollTop: 55,
      scrollHeight: 180,
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
    assert.match(html, /MaxComposerCaret\.schedulePinCaretToEndIfReset/);
    assert.match(html, /MaxComposerCaret\.placeCaretAtEnd/);
    assert.doesNotMatch(html, /onKeyDown=\{\(e\) => e\.key === "Enter" && send\(\)\}/);
    assert.match(html, /\.max-composer-row textarea/);
  });
});
