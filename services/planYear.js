/**
 * Yahoska's plan-year rule for Max:
 * - Explicit 2026-only ask → 2026 summaries
 * - Unspecified year, 2027, or both years → 2027 (safer AEP default)
 * Do not guess when both years appear.
 */

const DEFAULT_PLAN_YEAR = 2027;
const ATTACHED_YEAR_RE = /ATTACHED_PLAN_YEAR\s*=\s*(2026|2027)/;

function hasYearToken(text, year) {
  return new RegExp(`\\b${year}\\b`).test(String(text || ''));
}

function userMessageText(content) {
  if (typeof content === 'string') {
    return content.trim().startsWith('data:image/') ? '' : String(content || '');
  }
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part.trim().startsWith('data:image/') ? '' : part;
      return part && (part.type === 'text' || typeof part.text === 'string') ? part.text || '' : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Last 4 user turns — same window the chat UI uses to attach PLAN DATA. */
function conversationAskText(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const users = msgs
    .filter((m) => m && m.role === 'user')
    .map((m) => userMessageText(m.content));
  return users.slice(-4).join('\n');
}

/**
 * Year from the agent's ask only. System prompts always mention 2027 and
 * must not be scanned here.
 *
 * 2026 and not 2027 → 2026
 * 2027 present (alone or with 2026) → 2027
 * neither → fallback (toggle / default)
 */
function detectPlanYear(text, fallback = DEFAULT_PLAN_YEAR) {
  const t = String(text || '');
  const has26 = hasYearToken(t, 2026);
  const has27 = hasYearToken(t, 2027);
  if (has26 && !has27) return 2026;
  if (has27) return 2027;
  return Number(fallback) === 2026 ? 2026 : DEFAULT_PLAN_YEAR;
}

function yearFromPlans(plans) {
  const list = Array.isArray(plans) ? plans : [];
  const years = list
    .map((p) => Number(p && p.year))
    .filter((y) => y === 2026 || y === 2027);
  if (!years.length) return null;
  if (years.every((y) => y === 2026)) return 2026;
  if (years.every((y) => y === 2027)) return 2027;
  return null;
}

function attachedPlanYear(systemText) {
  const m = String(systemText || '').match(ATTACHED_YEAR_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve which year's SOB / EOC files to open.
 * An explicit 2026-only ask wins over a missing or 2027 tool year.
 * Both years in the ask → 2027. Unspecified → 2027 unless the UI attached 2026.
 */
function resolveDocumentYear({
  year,
  askText = '',
  systemText = '',
  plans = [],
} = {}) {
  const ask = String(askText || '');
  const has26 = hasYearToken(ask, 2026);
  const has27 = hasYearToken(ask, 2027);
  if (has26 && has27) return DEFAULT_PLAN_YEAR;
  if (has26 && !has27) return 2026;
  if (has27) return DEFAULT_PLAN_YEAR;

  if (Number(year) === 2026) return 2026;
  if (Number(year) === 2027) return DEFAULT_PLAN_YEAR;

  const fromPlans = yearFromPlans(plans);
  if (fromPlans === 2026) return 2026;

  const fromSystem = attachedPlanYear(systemText);
  if (fromSystem === 2026) return 2026;

  return DEFAULT_PLAN_YEAR;
}

function urlYearHints(url) {
  const s = String(url || '');
  return {
    y26: /2026|SB26|SB_?2026|SB2026|_Current\b/i.test(s),
    y27: /2027|SB27|SB_?2027|SB2027|_Next\b/i.test(s),
  };
}

function urlLooksLikeWrongYear(url, year) {
  if (!url) return false;
  const { y26, y27 } = urlYearHints(url);
  const y = Number(year) || DEFAULT_PLAN_YEAR;
  if (y === 2026) return y27 && !y26;
  return y26 && !y27;
}

/** Prefer this year's wired URL. Never return a file that is clearly the other year. */
function resolveDocumentUrl(passed, wired, year) {
  const y = Number(year) || DEFAULT_PLAN_YEAR;
  const wiredUrl = String(wired || '').trim();
  const passedUrl = String(passed || '').trim();
  if (wiredUrl && !urlLooksLikeWrongYear(wiredUrl, y)) return wiredUrl;
  if (passedUrl && !urlLooksLikeWrongYear(passedUrl, y)) return passedUrl;
  return '';
}

module.exports = {
  DEFAULT_PLAN_YEAR,
  ATTACHED_YEAR_RE,
  conversationAskText,
  detectPlanYear,
  resolveDocumentYear,
  resolveDocumentUrl,
  urlLooksLikeWrongYear,
  attachedPlanYear,
  yearFromPlans,
};
