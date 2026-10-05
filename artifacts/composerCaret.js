/**
 * Chat composer caret helpers.
 * Mobile Safari/Chrome often put the caret at index 0 (and scroll at the
 * start) when a filled input/textarea is focused, remounted, or given a
 * whole new value. Pin to the end in those reset cases only — never on
 * every keystroke, so mid-message edits stay put.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.MaxComposerCaret = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COMPOSER_MIN_PX = 46;
  const COMPOSER_MAX_PX = 160;

  function valueOf(el) {
    if (!el || el.value == null) return "";
    return String(el.value);
  }

  function shouldPinCaretToEnd(el) {
    if (!el) return false;
    const value = valueOf(el);
    if (!value) return false;
    const start = el.selectionStart == null ? 0 : el.selectionStart;
    const end = el.selectionEnd == null ? 0 : el.selectionEnd;
    const collapsedAtStart = start === 0 && end === 0;
    const entireValueSelected = start === 0 && end === value.length;
    const scrolledToStart = (el.scrollTop || 0) <= 1 && (el.scrollLeft || 0) <= 1;
    return (collapsedAtStart || entireValueSelected) && scrolledToStart;
  }

  function placeCaretAtEnd(el) {
    if (!el) return;
    const len = valueOf(el).length;
    if (typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(len, len);
      } catch (_) {
        el.selectionStart = len;
        el.selectionEnd = len;
      }
    } else {
      el.selectionStart = len;
      el.selectionEnd = len;
    }
    el.scrollTop = el.scrollHeight;
    el.scrollLeft = el.scrollWidth;
  }

  function pinCaretToEndIfReset(el) {
    if (shouldPinCaretToEnd(el)) placeCaretAtEnd(el);
  }

  function schedulePinCaretToEndIfReset(el) {
    if (!el) return;
    const run = function () {
      pinCaretToEndIfReset(el);
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () {
        requestAnimationFrame(run);
      });
    }
    setTimeout(run, 0);
    setTimeout(run, 50);
  }

  function resizeComposer(el, opts) {
    if (!el) return;
    const minPx = (opts && opts.minPx) || COMPOSER_MIN_PX;
    const maxPx = (opts && opts.maxPx) || COMPOSER_MAX_PX;
    const value = valueOf(el);
    const selStart = el.selectionStart == null ? 0 : el.selectionStart;
    const selEnd = el.selectionEnd == null ? selStart : el.selectionEnd;
    const atEnd = selStart >= value.length && selEnd >= value.length;
    const prevScroll = el.scrollTop || 0;
    el.style.height = "0px";
    const next = Math.min(maxPx, Math.max(minPx, el.scrollHeight || minPx));
    el.style.height = next + "px";
    if (typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(selStart, selEnd);
      } catch (_) {}
    }
    if (atEnd) {
      el.scrollTop = el.scrollHeight;
      el.scrollLeft = el.scrollWidth;
    } else {
      el.scrollTop = prevScroll;
    }
  }

  return {
    COMPOSER_MIN_PX,
    COMPOSER_MAX_PX,
    shouldPinCaretToEnd,
    placeCaretAtEnd,
    pinCaretToEndIfReset,
    schedulePinCaretToEndIfReset,
    resizeComposer,
  };
});
