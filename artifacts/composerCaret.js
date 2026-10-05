/**
 * Chat composer caret helpers.
 * Mobile Safari/Chrome often put the caret at index 0 (and scroll at the
 * start) when a filled input/textarea is focused, remounted, pasted, or
 * given a whole new value — e.g. putting a failed long ask back in the box.
 * Pin to the end in those reset cases only — never on every keystroke, so
 * mid-message edits stay put.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.MaxComposerCaret = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COMPOSER_MIN_PX = 46;
  const COMPOSER_MAX_PX = 200;

  function valueOf(el) {
    if (!el || el.value == null) return "";
    return String(el.value);
  }

  function looksLikeFailedGuruReply(text) {
    const t = String(text || "");
    return /couldn't generate a response/i.test(t) || /couldn't reach max/i.test(t);
  }

  function caretIsAtEnd(el) {
    if (!el) return false;
    const value = valueOf(el);
    if (!value) return false;
    const start = el.selectionStart == null ? 0 : el.selectionStart;
    const end = el.selectionEnd == null ? 0 : el.selectionEnd;
    return start >= value.length && end >= value.length;
  }

  function endIsVisible(el) {
    if (!el) return true;
    const maxScrollY = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
    const maxScrollX = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));
    return (el.scrollTop || 0) >= maxScrollY - 2 && (el.scrollLeft || 0) >= maxScrollX - 2;
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

  function revealComposerEnd(el) {
    if (!el || !valueOf(el)) return;
    if (shouldPinCaretToEnd(el)) {
      placeCaretAtEnd(el);
      return;
    }
    if (caretIsAtEnd(el) && !endIsVisible(el)) {
      el.scrollTop = el.scrollHeight;
      el.scrollLeft = el.scrollWidth;
    }
  }

  function pinCaretToEndIfReset(el) {
    if (shouldPinCaretToEnd(el)) placeCaretAtEnd(el);
  }

  function scheduleRevealComposerEnd(el) {
    if (!el) return;
    const run = function () {
      revealComposerEnd(el);
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () {
        requestAnimationFrame(run);
      });
    }
    [0, 50, 120, 300].forEach(function (ms) {
      setTimeout(run, ms);
    });
  }

  function schedulePinCaretToEndIfReset(el) {
    scheduleRevealComposerEnd(el);
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
    looksLikeFailedGuruReply,
    caretIsAtEnd,
    endIsVisible,
    shouldPinCaretToEnd,
    placeCaretAtEnd,
    revealComposerEnd,
    pinCaretToEndIfReset,
    scheduleRevealComposerEnd,
    schedulePinCaretToEndIfReset,
    resizeComposer,
  };
});
