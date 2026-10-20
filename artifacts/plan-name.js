/**
 * One plan marketing-name cleaner for Max (2026-10-20). The THEI 2027 grid headers carry working tags that are
 * not part of the plan's name: "**NEW 2027**", "(NEW 2027)", "- NEW 2027", bare "**NEW**", and stray "**" bold
 * markers. The 2027 sync (scripts/thei_grid_common.py clean_plan_marketing_name, same rules) strips them before
 * #plan-data is written, and every place a name renders (chat tables, compare card, Excel/PDF export, year compare)
 * runs it again so a future sheet edit with the tag never reaches an agent. Works in Node and in the browser
 * (window.MaxPlanName, loaded before comparison-export.js).
 *
 * Only the tag and the markers go. Everything else stays as written: "NON-COMMISSIONABLE" on R0759-001, contract-PBP
 * IDs, "(HMO D-SNP)", "FL-0031", "C-SNP".
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.MaxPlanName = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEP = '[\\s\\-\\u2010-\\u2015:|\\u00b7]*';
  // "NEW 2027" in any case, with optional ** / brackets / a leading dash: "**NEW 2027**", "(NEW 2027)", "- New 2027".
  const NEW_YEAR_TAG_RE = new RegExp(SEP + '[(\\[]?\\s*\\**\\s*\\bnew\\s*(?:for\\s+)?2027\\b\\s*\\**\\s*[)\\]]?', 'gi');
  // Bare NEW as a tag: "**NEW**", "*NEW", "(NEW)", or an all-caps NEW ending the name ("Doctors DrExtraCare NEW").
  const BARE_NEW_TAG_RE = new RegExp(SEP + '(?:\\*+\\s*NEW\\b\\s*\\**|\\(\\s*\\**\\s*NEW\\s*\\**\\s*\\))', 'gi');
  const TRAILING_NEW_RE = /[\s\-\u2010-\u2015:|\u00b7]+NEW\s*$/;

  function cleanPlanName(name) {
    if (name == null) return '';
    let s = String(name).replace(/\s+/g, ' ');
    s = s.replace(NEW_YEAR_TAG_RE, ' ').replace(BARE_NEW_TAG_RE, ' ').replace(TRAILING_NEW_RE, ' ');
    s = s
      .replace(/\*{2,}/g, ' ') // stray bold markers: "**PPO**" → "PPO"
      .replace(/^\s*\*+|\*+\s*$/g, ' ') // a single leading / trailing "*"
      .replace(/\(\s*\)|\[\s*\]/g, ' ') // brackets the tag left empty
      .replace(/\s+([-\u2010-\u2015])\s+(?:[-\u2010-\u2015]\s+)+/g, ' $1 ') // "A - - B" → "A - B"
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-\u2010-\u2015:|\u00b7,]+|[\s\-\u2010-\u2015:|\u00b7,]+$/g, '') // dangling dashes / separators
      .trim();
    return s;
  }

  /** Copy of a plan object with a clean planName (other fields untouched). Same object back when nothing changes. */
  function withCleanPlanName(plan) {
    if (!plan || typeof plan !== 'object' || typeof plan.planName !== 'string') return plan;
    const clean = cleanPlanName(plan.planName);
    if (!clean || clean === plan.planName) return plan;
    return Object.assign({}, plan, { planName: clean });
  }

  function cleanPlanList(plans) {
    return Array.isArray(plans) ? plans.map(withCleanPlanName) : plans;
  }

  return { cleanPlanName, withCleanPlanName, cleanPlanList, NEW_YEAR_TAG_RE, BARE_NEW_TAG_RE };
});
