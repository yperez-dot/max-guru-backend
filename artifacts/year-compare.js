/**
 * Max same-plan 2026 vs 2027 compare (chat reply + Excel/PDF export).
 * Works in the browser (window.MaxYearCompare) and in Node tests.
 *
 * Every value comes from plan objects (#plan-data 2027, #plan-data-2026) and the
 * public CMS files in #year-compare-cms (2027 plan crosswalk + 2026/2027 landscape).
 * Differences are computed here, never by the model.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.MaxYearCompare = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const PURPLE = "5B2C8B";
  const PURPLE_FONT = "FFFFFF";
  const TITLE_COLOR = "2A1540";
  const LINK_BLUE = "0563C1";
  const SECTION_FILL = "F3EEF7";
  // Pale orange, not yellow: yellow means "unconfirmed" on the THEI grid.
  const CHANGED_FILL = "FCE4D6";
  const CHANGED_FONT = "B4470F";
  const MUTED_FONT = "6B6B6B";
  const MAX_PLANS = 6;

  const CHANGED = "Changed";
  const SAME = "Same";
  const REVIEW = "Review";
  const NEW = "New";
  const DASH = "—";
  const NEW_NOTE = "New for 2027 — no 2026 plan";

  function exportLib() {
    if (root && root.MaxComparisonExport) return root.MaxComparisonExport;
    if (typeof require === "function") {
      try {
        return require("./comparison-export.js");
      } catch (_) {
        /* browser */
      }
    }
    return {};
  }

  // ─── IDs ───────────────────────────────────────────────────────────────────

  /** H1036-054C / H129-002 / H1045-012-000 / H5420-001/0028 → H1036-054 (CMS contract-plan). */
  function normalizePlanKey(raw) {
    const m = String(raw || "").toUpperCase().match(/\b([HRS])\s*(\d{3,4})\s*[-_ ]\s*(\d{1,3})/);
    if (!m) return "";
    let contract = m[2];
    if (contract.length === 3) contract += "0"; // "H129-002" in the 2026 grid is Devoted H1290
    return m[1] + contract + "-" + String(Number(m[3])).padStart(3, "0");
  }

  const ID_RE = /\b[HRS]\s?\d{3,4}[\s-]?\d{2,4}[A-Z]?(?:\s*\/\s*-?\d{2,4})?\b/gi;

  function planIdsInText(text) {
    const out = [];
    (String(text || "").match(ID_RE) || []).forEach((raw) => {
      const key = normalizePlanKey(raw);
      if (key && !out.includes(key)) out.push(key);
    });
    return out;
  }

  function planKey(plan) {
    return normalizePlanKey(plan && (plan.planId || plan.id));
  }

  function countyHint(text) {
    const t = String(text || "");
    const b = /\bbroward\b/i.test(t);
    const d = /\bmiami[-\s]?dade\b|\bdade\b/i.test(t);
    if (b && !d) return "Broward";
    if (d && !b) return "Miami-Dade";
    const zips = t.match(/\b3\d{4}\b/g) || [];
    for (let i = zips.length - 1; i >= 0; i--) {
      const n = Number(zips[i]);
      if (n === 33004 || n === 33009 || (n >= 33019 && n <= 33029) || (n >= 33060 && n <= 33077) || (n >= 33301 && n <= 33394) || (n >= 33441 && n <= 33443)) return "Broward";
      if ((n >= 33010 && n <= 33018) || (n >= 33030 && n <= 33039) || (n >= 33054 && n <= 33056) || (n >= 33090 && n <= 33092) || (n >= 33101 && n <= 33299)) return "Miami-Dade";
    }
    return "";
  }

  // ─── Intent ────────────────────────────────────────────────────────────────

  const YEAR_PAIR_RE = /\b2026\s*(?:vs\.?|versus|v\.?|to|→|->|and|&|with|against|or)\s*2027\b|\b2027\s*(?:vs\.?|versus|v\.?|and|&|with|against|or)\s*2026\b/i;
  const COMPARE_WORD_RE = /\b(compare|comparison|vs\.?|versus|changes?|changed|changing|differences?|different|diff)\b|→|->/i;
  const YOY_RE = /\byear[-\s]?over[-\s]?year\b|\byoy\b/i;
  const WHAT_CHANGED_RE = /\bwhat(?:'?s|\s+has|\s+is|\s+will)?\s+chang(?:ed|ing|e)\b|\b(?:changes?|differences?)\s+(?:from|since|vs\.?|versus)\s+(?:last\s+year|this\s+year|2026)\b|\b(?:changed|changing)\s+(?:from|since)\s+(?:last\s+year|2026)\b|\bsame\s+plan\b.*\b(?:2026|last\s+year)\b/i;
  const WHAT_DIFFERENT_RE = /\bwhat(?:'?s|\s+is|\s+will\s+be)?\s+different\b|\bdifferences?\b/i;
  const TIME_CONTEXT_RE = /\b(2026|2027|last\s+year|next\s+year|this\s+year|new\s+year|aep)\b/i;

  /**
   * True when she wants the SAME plan compared across plan years.
   * opts.hasPlanContext: a plan was already on the table (earlier year compare / comparison).
   */
  function wantsYearCompare(text, opts) {
    const t = String(text || "");
    if (!t.trim()) return false;
    if (YOY_RE.test(t)) return true;
    if (YEAR_PAIR_RE.test(t) && COMPARE_WORD_RE.test(t)) return true;
    const ids = planIdsInText(t);
    const time = TIME_CONTEXT_RE.test(t);
    if (WHAT_CHANGED_RE.test(t)) {
      // Two plans + "what changed" with no year words is still a year question; one plan is the common case.
      if (ids.length || time) return true;
      return Boolean(opts && opts.hasPlanContext);
    }
    // "What's different" / "differences" is usually plan vs plan: only a year compare with a year word.
    if (WHAT_DIFFERENT_RE.test(t) && time && /\b(last\s+year|next\s+year|2026)\b/i.test(t)) return true;
    return false;
  }

  // ─── CMS data ──────────────────────────────────────────────────────────────

  let cmsCache = null;
  function loadCmsFromDom() {
    if (cmsCache) return cmsCache;
    try {
      const el = typeof document !== "undefined" && document.getElementById("year-compare-cms");
      cmsCache = el ? JSON.parse(el.textContent || "{}") : {};
    } catch (_) {
      cmsCache = {};
    }
    return cmsCache;
  }

  function crosswalkRows(cms) {
    return (cms && Array.isArray(cms.crosswalk) && cms.crosswalk) || [];
  }

  function landscapeRow(cms, year, id, county) {
    const y = cms && cms.landscape && cms.landscape[String(year)];
    return (y && id && y[id + "|" + county]) || null;
  }

  /** Product name without plan type / IDs / filler, as a token set. */
  function productTokens(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b[hrs]\d{4}-\d{3}[a-z]?\b/g, " ")
      .replace(/\b\d{3}\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((w) => w && !/^(fl|sfl|the|plan|hmo|ppo|pos|snp|d|c|medicare|advantage)$/.test(w));
  }

  function planTypeOf(name) {
    const m = String(name || "").match(/\(([^)]*)\)\s*$/);
    return m ? m[1].trim() : "";
  }

  function nameSimilarity(a, b) {
    const ta = productTokens(a);
    const tb = productTokens(b);
    if (!ta.length || !tb.length) return 0;
    const inter = ta.filter((w) => tb.includes(w)).length;
    return inter / Math.max(ta.length, tb.length);
  }

  /** Same contract-plan ID but CMS shows a different product (name family or SNP type). */
  function productChanged(row) {
    if (!row || !row.prev || row.prev !== row.cur) return false;
    if ((row.prevSnp || "") !== (row.curSnp || "")) return true;
    const a = productTokens(row.prevName);
    const b = productTokens(row.curName);
    if (!a.length || !b.length) return false;
    const aInB = a.every((w) => b.includes(w));
    const bInA = b.every((w) => a.includes(w));
    return !aInB && !bInA;
  }

  // ─── Pairing (crosswalk) ───────────────────────────────────────────────────

  function find2026(plans2026, id, county) {
    return (plans2026 || []).find((p) => planKey(p) === id && p.county === county) || null;
  }

  function plans2027For(plans2027, id) {
    return (plans2027 || []).filter((p) => planKey(p) === id);
  }

  function shortCmsName(name) {
    return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  }

  /**
   * One 2027 grid plan (one county) → its 2026 side.
   * kind: renewal | consolidated | renumbered | no2026row | new
   */
  function pairFor(plan27, ctx, from2026Id) {
    const cms = ctx.cms || {};
    const id = planKey(plan27);
    const county = plan27.county;
    const rows = crosswalkRows(cms).filter((r) => r.cur === id);
    const selfRow = rows.find((r) => r.prev === id) || null;
    const prevs = [];
    rows.forEach((r) => {
      if (r.prev && !prevs.includes(r.prev)) prevs.push(r.prev);
    });
    const curName = (rows[0] && rows[0].curName) || "";
    const pair = {
      id27: id,
      county,
      plan27,
      plan26: null,
      id26: null,
      kind: "new",
      status: rows.length ? rows.map((r) => r.status).filter((s, i, a) => a.indexOf(s) === i).join(" / ") : "",
      notes: [],
      flags: [],
      otherPredecessors: [],
      tailNotes: [],
    };

    if (from2026Id) {
      const p26 = find2026(ctx.plans2026, from2026Id, county);
      const row = rows.find((r) => r.prev === from2026Id);
      pair.id26 = from2026Id;
      pair.plan26 = p26;
      pair.kind = from2026Id === id ? (prevs.length > 1 ? "consolidated" : "renewal") : (p26 ? "renumbered" : "no2026row");
      pair.otherPredecessors = prevs.filter((p) => p !== from2026Id);
      if (row && from2026Id !== id) {
        pair.notes.push(`Renumbered: 2026 ${from2026Id} ${shortCmsName(row.prevName)} → 2027 ${id} ${shortCmsName(row.curName)} (CMS: ${row.status})`);
      }
    } else if (!rows.length) {
      // Not in the CMS crosswalk file: fall back to a same-ID 2026 row if we have one.
      const p26 = find2026(ctx.plans2026, id, county);
      if (p26) {
        pair.kind = "renewal";
        pair.plan26 = p26;
        pair.id26 = id;
      } else {
        pair.kind = "new";
      }
    } else if (!prevs.length) {
      pair.kind = "new";
    } else if (selfRow && find2026(ctx.plans2026, id, county)) {
      pair.plan26 = find2026(ctx.plans2026, id, county);
      pair.id26 = id;
      pair.otherPredecessors = prevs.filter((p) => p !== id);
      pair.kind = pair.otherPredecessors.length ? "consolidated" : "renewal";
    } else {
      const onFile = prevs.filter((p) => p !== id && find2026(ctx.plans2026, p, county));
      const sameIdIn2026 = selfRow && landscapeRow(cms, 2026, id, county);
      if (sameIdIn2026) {
        // The same plan ID was sold in this county in 2026; THEI just has no 2026 row for it.
        pair.kind = "no2026row";
        pair.id26 = id;
        pair.otherPredecessors = prevs.filter((p) => p !== id);
        if (onFile.length) {
          pair.tailNotes.push(
            "For a full benefit compare from a plan that moved in, ask with its 2026 ID: " +
              onFile.map((p) => `"${p} 2026 vs 2027"`).join(" or ")
          );
        }
      } else if (onFile.length) {
        const scored = onFile
          .map((p) => {
            const r = rows.find((x) => x.prev === p);
            return { p, r, score: nameSimilarity(r && r.prevName, curName || plan27.planName) };
          })
          .sort((a, b) => b.score - a.score || (a.p < b.p ? -1 : 1));
        const best = scored[0];
        pair.kind = "renumbered";
        pair.id26 = best.p;
        pair.plan26 = find2026(ctx.plans2026, best.p, county);
        pair.otherPredecessors = prevs.filter((p) => p !== best.p);
        pair.notes.push(`Renumbered: 2026 ${best.p} ${shortCmsName(best.r && best.r.prevName)} → 2027 ${id} ${shortCmsName(curName)} (CMS: ${best.r ? best.r.status : "crosswalk"})`);
      } else {
        pair.kind = "no2026row";
        pair.id26 = selfRow ? id : prevs[0];
        pair.otherPredecessors = prevs.filter((p) => p !== pair.id26);
      }
    }

    if (pair.kind === "new") {
      pair.notes.push(NEW_NOTE);
    }
    if (pair.kind === "no2026row") {
      const land26 = landscapeRow(cms, 2026, pair.id26, county);
      pair.notes.push(
        land26
          ? `No 2026 THEI grid row for ${county} — premium and MOOP compared from CMS only (2026 ${pair.id26} ${shortCmsName(land26.planName)})`
          : `Not offered in ${county} in 2026 (CMS: ${pair.status || "service area change"}) — 2027 values only`
      );
      if (!land26) pair.kind = "new";
    }
    if (pair.otherPredecessors.length && pair.kind !== "new") {
      const names = pair.otherPredecessors.map((p) => {
        const r = rows.find((x) => x.prev === p);
        return p + (p === id ? " (same ID)" : "") + (r && r.prevName ? " " + shortCmsName(r.prevName) : "");
      });
      pair.notes.push("Other 2026 plans moved into this plan: " + names.join("; "));
    }
    const sameIdRow = rows.find((r) => r.prev === id && r.cur === id);
    if (sameIdRow && productChanged(sameIdRow) && pair.id26 === id) {
      pair.flags.push(
        `⚠ Same plan ID, different product: 2026 ${shortCmsName(sameIdRow.prevName)} → 2027 ${shortCmsName(sameIdRow.curName)}`
      );
    }
    pair.notes.push.apply(pair.notes, pair.tailNotes);
    delete pair.tailNotes;
    const typeRow = rows.find((r) => r.prev === pair.id26);
    if (typeRow) {
      const a = planTypeOf(typeRow.prevName);
      const b = planTypeOf(typeRow.curName);
      if (a && b && a !== b) pair.notes.push(`Plan type: ${a} → ${b}`);
    }
    return pair;
  }

  /** Plans in the 2026 data / crosswalk that end: 2026 side only. */
  function endingPair(id26, county, ctx) {
    const rows = crosswalkRows(ctx.cms).filter((r) => r.prev === id26);
    const status = rows.map((r) => r.status).filter((s, i, a) => a.indexOf(s) === i).join(" / ") || "not in CMS crosswalk";
    const successors = rows.filter((r) => r.cur).map((r) => r.cur + " " + shortCmsName(r.curName));
    return {
      id27: null,
      county,
      plan27: null,
      plan26: find2026(ctx.plans2026, id26, county),
      id26,
      kind: "ending",
      status,
      notes: [
        successors.length
          ? `Not on the THEI 2027 grid for ${county}. CMS moves members to: ${successors.join("; ")}`
          : `Not offered in 2027 (CMS: ${status})`,
      ],
      flags: [],
      otherPredecessors: [],
    };
  }

  /**
   * Resolve plan IDs from her ask (or fallback IDs) into year pairs.
   * ctx: { plans2026, plans2027, cms, county? }
   */
  function resolveYearPairs(ids, ctx, opts) {
    const options = opts || {};
    const hint = options.county || "";
    const pairs = [];
    const unresolved = [];
    const seen = {};
    const add = (p) => {
      const k = (p.id27 || "x") + "|" + (p.id26 || "x") + "|" + p.county;
      if (seen[k]) return;
      seen[k] = true;
      pairs.push(p);
    };
    (ids || []).forEach((id) => {
      const live = plans2027For(ctx.plans2027, id);
      if (live.length) {
        let pick = live;
        if (hint && live.some((p) => p.county === hint)) pick = live.filter((p) => p.county === hint);
        else if (live.length > 1) pick = [live.find((p) => p.county === "Miami-Dade") || live[0]];
        pick.forEach((p) => {
          const pair = pairFor(p, ctx);
          if (!hint && live.length > 1) {
            const other = live.find((x) => x.county !== p.county);
            if (other) pair.notes.push(`Also offered in ${other.county} — say "${other.county}" for that county's numbers`);
          }
          add(pair);
        });
        return;
      }
      // A 2026 ID: follow the crosswalk forward to the 2027 grid plan(s).
      const old = (ctx.plans2026 || []).filter((p) => planKey(p) === id);
      const succ = crosswalkRows(ctx.cms).filter((r) => r.prev === id && r.cur);
      const counties = hint ? [hint] : old.length ? old.map((p) => p.county).filter((c, i, a) => a.indexOf(c) === i) : ["Miami-Dade", "Broward"];
      let hit = false;
      counties.forEach((county) => {
        succ.forEach((r) => {
          const p27 = plans2027For(ctx.plans2027, r.cur).find((p) => p.county === county);
          if (!p27) return;
          hit = true;
          add(pairFor(p27, ctx, id));
        });
      });
      if (!hit) {
        if (old.length) {
          counties.forEach((county) => {
            if (find2026(ctx.plans2026, id, county)) add(endingPair(id, county, ctx));
          });
        } else {
          unresolved.push(id);
        }
      }
    });
    return { pairs: pairs.slice(0, MAX_PLANS), unresolved, truncated: pairs.length > MAX_PLANS };
  }

  // ─── Normalization + compare ───────────────────────────────────────────────

  const TIER_KEYS = { tier1: 1, tier2: 1, tier3: 1, tier4: 1, tier5: 1, tier6: 1 };
  const COUNT_KEYS = {
    dentalDeepCleaning: 1, dentalDentures: 1, dentalFillings: 1, dentalRootCanals: 1,
    dentalExtractions: 1, dentalCrowns: 1, dentalBridges: 1, dentalImplants: 1,
  };
  // Rows read as money / percent amounts → Changed or Same.
  const NUMERIC_KEYS = {
    premium: 1, partBGiveback: 1, moop: 1, pcpCopay: 1, specialistCopay: 1, erCopay: 1,
    urgentCareCopay: 1, rxDeductible: 1, tier1: 1, tier2: 1, tier3: 1, tier4: 1, tier5: 1,
    tier6: 1, otc: 1, vision: 1, dental: 1, hearing: 1, inpatientHospital: 1,
    outpatientHospital: 1, advancedImaging: 1, ambulance: 1, partDDeductible: 1,
  };
  const BOOL_KEYS = { referral: 1, dentalImplants: 1 };

  function fmtMoney(n) {
    const v = Math.round(Number(n) * 100) / 100;
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }

  function fmtPct(n) {
    return Math.round(Number(n) * 10) / 10 + "%";
  }

  function isBlank(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    const s = String(v).trim();
    return s === "" || /^(not listed|unverified|pending|sob pending|tbd)$/i.test(s);
  }

  const NONE_RE = /^(no|none|not covered|not offered|n\/a|na|not applicable|no coverage|\$?0 \(not covered\))$/i;
  const YES_RE = /^(yes|y|covered|included|required)$/i;

  /** Bare number → its display/compare reading for this row. */
  function readNumber(n, key) {
    if (TIER_KEYS[key] && n > 0 && n < 1) return { kind: "amount", tokens: [fmtPct(n * 100)], display: fmtPct(n * 100) };
    if (COUNT_KEYS[key] && n === 0) return { kind: "none", tokens: [], display: "Not covered" };
    if (COUNT_KEYS[key]) return { kind: "amount", tokens: ["#" + n], display: n + " covered" };
    return { kind: "amount", tokens: [fmtMoney(n)], display: fmtMoney(n) };
  }

  function periodOf(s) {
    if (/(\/\s*mo\b|\/\s*month|per\s+month|x\s+month|\bmonthly\b|a\s+month|\bmo\b)/i.test(s)) return "mo";
    if (/(\/\s*q(?:tr|uarter)?\b|per\s+quarter|x\s+quarter|\bquarterly\b|every\s+3\s+months)/i.test(s)) return "qtr";
    if (/(\/\s*yr\b|\/\s*year|per\s+year|x\s+(?:1\s+)?year|\bannual(?:ly)?\b|\byearly\b|a\s+year)/i.test(s)) return "yr";
    return "";
  }

  /**
   * Normalize one cell for comparing. Returns
   * { kind: blank|unclear|none|yes|amount|text, tokens: [...], period, display, text }.
   */
  function normalizeValue(v, key) {
    if (isBlank(v)) return { kind: "blank", tokens: [], period: "", display: "Not listed", text: "" };
    if (typeof v === "number" && key === "partBGiveback" && v > 0 && v < 10 && Number.isInteger(v)) {
      return { kind: "unclear", tokens: [], period: "", display: v + " (unclear, check SOB)", text: String(v) };
    }
    if (typeof v === "number") return Object.assign({ period: "", text: String(v) }, readNumber(v, key));
    if (Array.isArray(v)) v = v.join("; ");
    const raw = String(v).replace(/\s+/g, " ").trim();
    if (/^[*\s]+$/.test(raw)) return { kind: "unclear", tokens: [], period: "", display: "* (see SOB)", text: "*" };
    const bare = raw.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(%)?$/);
    if (bare) {
      const n = Number(bare[1].replace(/,/g, ""));
      if (bare[2]) return { kind: "amount", tokens: [fmtPct(n)], period: "", display: fmtPct(n), text: raw };
      // "50" on a drug tier could be $50 or 50%; "2" as a Part B giveback is not a real amount.
      // Show it exactly as stored and send it to Review instead of guessing.
      if (!/^\$/.test(raw) && ((TIER_KEYS[key] && n >= 1) || (key === "partBGiveback" && n > 0 && n < 10 && !/\./.test(raw)))) {
        return { kind: "unclear", tokens: [], period: "", display: raw + " (unclear, check SOB)", text: raw };
      }
      const r = readNumber(n, key);
      return Object.assign({ period: "", text: raw }, r);
    }
    if (NONE_RE.test(raw)) return { kind: "none", tokens: [], period: "", display: raw, text: raw.toLowerCase() };
    if (YES_RE.test(raw)) return { kind: "yes", tokens: [], period: "", display: raw, text: raw.toLowerCase() };
    const tokens = [];
    raw.replace(/\$\s*([\d,]+(?:\.\d+)?)/g, (_m, n) => {
      const t = fmtMoney(Number(n.replace(/,/g, "")));
      if (!tokens.includes(t)) tokens.push(t);
      return _m;
    });
    raw.replace(/(\d+(?:\.\d+)?)\s*%/g, (_m, n) => {
      const t = fmtPct(Number(n));
      if (!tokens.includes(t)) tokens.push(t);
      return _m;
    });
    raw.replace(/\bdays?\s*(\d+)\s*[-–]\s*(\d+)/gi, (_m, a, b) => {
      const t = "days " + a + "-" + b;
      if (!tokens.includes(t)) tokens.push(t);
      return _m;
    });
    // A leading "Yes"/"No" on a yes/no row (e.g. "Yes — PCP referral") still reads as yes/no.
    if (BOOL_KEYS[key] && !tokens.length) {
      if (/^yes\b/i.test(raw)) return { kind: "yes", tokens: [], period: "", display: raw, text: raw.toLowerCase() };
      if (/^no\b/i.test(raw)) return { kind: "none", tokens: [], period: "", display: raw, text: raw.toLowerCase() };
    }
    return {
      kind: tokens.length ? "amount-text" : "text",
      tokens: tokens.sort(),
      period: periodOf(raw),
      display: raw,
      text: raw.toLowerCase().replace(/[^a-z0-9$%.]+/g, " ").trim(),
    };
  }

  function sameTokens(a, b) {
    if (a.tokens.length !== b.tokens.length) return false;
    return a.tokens.every((t, i) => t === b.tokens[i]);
  }

  /** Changed | Same | Review | "" (both blank). */
  function compareValues(v26, v27, key) {
    const a = normalizeValue(v26, key);
    const b = normalizeValue(v27, key);
    if (a.kind === "blank" && b.kind === "blank") return { change: "", a, b };
    if (a.kind === "blank" || b.kind === "blank" || a.kind === "unclear" || b.kind === "unclear") {
      return { change: REVIEW, a, b };
    }
    if (a.text && a.text === b.text) return { change: SAME, a, b };
    const flat = (x) => (x.kind === "none" || x.kind === "yes" ? x.kind : null);
    if (flat(a) && flat(b)) return { change: flat(a) === flat(b) ? SAME : CHANGED, a, b };
    const isAmt = (x) => x.kind === "amount" || x.kind === "amount-text";
    if (flat(a) === "none" && isAmt(b)) {
      return { change: b.tokens.every((t) => t === "$0") ? REVIEW : CHANGED, a, b };
    }
    if (flat(b) === "none" && isAmt(a)) {
      return { change: a.tokens.every((t) => t === "$0") ? REVIEW : CHANGED, a, b };
    }
    if (isAmt(a) && isAmt(b) && (NUMERIC_KEYS[key] || (a.kind === "amount" && b.kind === "amount"))) {
      const samePeriod = !a.period || !b.period || a.period === b.period;
      if (sameTokens(a, b)) return { change: samePeriod ? SAME : CHANGED, a, b };
      // One side only adds detail ("$1,500" vs "$1,500 allowance · $0 copay"): wording, not a clear change.
      const sub = (x, y) => x.tokens.length && x.tokens.every((t) => y.tokens.includes(t));
      if (samePeriod && (sub(a, b) || sub(b, a))) return { change: REVIEW, a, b };
      return { change: CHANGED, a, b };
    }
    return { change: REVIEW, a, b };
  }

  // ─── Rows ──────────────────────────────────────────────────────────────────

  const CMS_ROWS = [
    ["Monthly Premium (CMS, before Extra Help)", "premium"],
    ["Max Out of Pocket — in-network (CMS)", "moop"],
    ["Part D Deductible (CMS, before Extra Help)", "partDDeductible"],
    ["Overall Star Rating (CMS)", "starRating"],
  ];
  // Grid rows CMS already covers (no duplicate rows on the client sheet).
  const REPLACED_BY_CMS = { premium: true, moop: true };

  function isDual(plan) {
    if (!plan) return false;
    const t = [plan.type, plan.planName, plan.mspLevels].join(" ");
    return /d-?snp|dual|medi-?medi/i.test(t) || Boolean(plan.dualLevel && (plan.dualLevel.full || plan.dualLevel.partial));
  }

  function displayFor(v, key) {
    const n = normalizeValue(v, key);
    if (n.kind === "blank") return "Not listed";
    return n.display;
  }

  function cmsCell(row, key) {
    if (!row) return null;
    if (key === "starRating") return row.starRating || null;
    return row[key] || null;
  }

  /** Per pair, per row: { v26, v27, change }. */
  function compareRow(pair, key, source, cms) {
    if (source === "cms") {
      const l26 = pair.id26 ? landscapeRow(cms, 2026, pair.id26, pair.county) : null;
      const l27 = pair.id27 ? landscapeRow(cms, 2027, pair.id27, pair.county) : null;
      const raw26 = cmsCell(l26, key);
      const raw27 = cmsCell(l27, key);
      if (pair.kind === "new") return { v26: "No 2026 plan", v27: raw27 || (key === "starRating" ? "Not posted yet" : "Not listed"), change: NEW };
      if (pair.kind === "ending") return { v26: raw26 || "Not listed", v27: "Not offered", change: DASH };
      if (key === "starRating" && !raw27) {
        return { v26: raw26 || "Not listed", v27: "Not posted yet", change: "Pending" };
      }
      if (!raw26 && !raw27) return { v26: "Not listed", v27: "Not listed", change: "" };
      const cmp = compareValues(raw26, raw27, key);
      return { v26: raw26 || "Not listed", v27: raw27 || "Not listed", change: cmp.change };
    }
    const p26 = pair.plan26;
    const p27 = pair.plan27;
    if (pair.kind === "new") return { v26: DASH, v27: displayFor(p27 && p27[key], key), change: NEW, blank: isBlank(p27 && p27[key]) };
    if (pair.kind === "ending") return { v26: displayFor(p26 && p26[key], key), v27: "Not offered", change: DASH, blank: isBlank(p26 && p26[key]) };
    if (pair.kind === "no2026row") return { v26: "Not on file", v27: displayFor(p27 && p27[key], key), change: DASH, blank: isBlank(p27 && p27[key]) };
    const cmp = compareValues(p26 && p26[key], p27 && p27[key], key);
    return {
      v26: cmp.a.kind === "blank" ? "Not listed" : cmp.a.display,
      v27: cmp.b.kind === "blank" ? "Not listed" : cmp.b.display,
      change: cmp.change,
      blank: cmp.change === "",
    };
  }

  function benefitRows(pairs, cms) {
    const lib = exportLib();
    const fieldRows = (lib.FIELD_ROWS && lib.FIELD_ROWS.length ? lib.FIELD_ROWS : []).slice();
    const anyDual = pairs.some((p) => isDual(p.plan27) || isDual(p.plan26));
    const out = [];
    CMS_ROWS.forEach(([label, key]) => {
      const cells = pairs.map((p) => compareRow(p, key, "cms", cms));
      if (cells.every((c) => c.change === "" && c.v26 === "Not listed" && c.v27 === "Not listed")) return;
      out.push({ section: "cms", label, key, cells });
    });
    const cmsHas = (key) => out.some((r) => r.key === key);
    fieldRows.forEach(([label, key]) => {
      if (key === "mspLevels" && !anyDual) return;
      if (REPLACED_BY_CMS[key] && cmsHas(key)) return;
      const cells = pairs.map((p) => compareRow(p, key, "grid", cms));
      // No junk rows: skip a row that is blank on both years for every plan.
      if (cells.every((c) => c.blank)) return;
      out.push({ section: "grid", label, key, cells });
    });
    return out;
  }

  // ─── Model (shared by chat, Excel, PDF) ────────────────────────────────────

  /** Grid working notes ("**NEW 2027", "COMMISSIONABLE 2027") are not part of the marketing name. */
  function cleanPlanName(name) {
    return String(name || "")
      .replace(/\*+/g, " ")
      .replace(/\b(?:NON-)?COMMISSIONABLE(?:\s+20\d\d)?\b/gi, " ")
      .replace(/\bNEW(?:\s+20\d\d)?\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function marketing(plan) {
    const lib = exportLib();
    if (!plan) return "";
    const clean = Object.assign({}, plan, { planName: cleanPlanName(plan.planName), carrier: cleanPlanName(plan.carrier) });
    return typeof lib.formatPlanMarketingName === "function" ? lib.formatPlanMarketingName(clean) : clean.planName;
  }

  /** Contract-PBP as agents write it: H1036-054C stays, H5471-064-0 → H5471-064, H129-002 → H1290-002. */
  function displayId(plan, fallback) {
    const raw = String((plan && (plan.planId || plan.id)) || fallback || "").toUpperCase().replace(/\s+/g, "");
    const m = raw.match(/^([HRS]\d{4}-\d{3}[A-Z]?)(?![0-9])/);
    if (m) return m[1];
    return normalizePlanKey(raw) || raw;
  }

  function columnHeader(year, plan, fallbackId, fallbackName) {
    const name = plan ? marketing(plan) : fallbackName || "";
    const id = plan ? displayId(plan) : fallbackId || "";
    return [String(year), name, id].filter(Boolean).join("\n");
  }

  function pairHeaders(pair, cms) {
    let h26;
    if (pair.kind === "new") h26 = "2026\nNo 2026 plan";
    else if (pair.plan26) h26 = columnHeader(2026, pair.plan26);
    else {
      const l26 = landscapeRow(cms, 2026, pair.id26, pair.county);
      h26 = columnHeader(2026, null, pair.id26, l26 ? shortCmsName(l26.planName) : "");
    }
    const h27 = pair.plan27 ? columnHeader(2027, pair.plan27) : "2027\nNot offered";
    return [h26, h27, "Change"];
  }

  function pairNote(pair) {
    const kindLabel = {
      renewal: "Same plan ID renewed (CMS crosswalk)",
      consolidated: "Same plan ID renewed; other 2026 plans folded in (CMS crosswalk)",
      renumbered: "",
      no2026row: "",
      new: "",
      ending: "",
    }[pair.kind];
    return [pair.county, kindLabel].concat(pair.flags, pair.notes).filter(Boolean).join(" · ");
  }

  function pairCounts(rows, idx) {
    const c = { changed: 0, same: 0, review: 0 };
    rows.forEach((r) => {
      const ch = r.cells[idx].change;
      if (ch === CHANGED) c.changed++;
      else if (ch === SAME) c.same++;
      else if (ch === REVIEW) c.review++;
    });
    return c;
  }

  function safeName(s) {
    return String(s || "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  }

  function yearCompareFilename(pairs, clientName, ext) {
    const ids = pairs
      .map((p) => {
        const id27 = p.plan27 ? displayId(p.plan27) : "";
        if (p.kind === "renumbered" && p.id26 && id27) return safeName(p.id26 + "_to_" + id27);
        return safeName(id27 || p.id26);
      })
      .filter(Boolean)
      .join("_");
    const base = (clientName ? safeName(clientName.replace(/\s+/g, "_")) + "_" : "") + "2026_vs_2027" + (ids ? "_" + ids : "");
    return base + "." + (ext || "xlsx");
  }

  function sobCell(plan, year) {
    const url = plan && plan.sobUrl ? String(plan.sobUrl).trim() : "";
    return url ? { text: year + " Summary of Benefits", url } : { text: plan ? "SOB pending" : DASH };
  }

  function eocCell(plan, year) {
    const url = plan && plan.eocUrl ? String(plan.eocUrl).trim() : "";
    return url ? { text: year + " Evidence of Coverage", url } : { text: plan ? "Not on file" : DASH };
  }

  /**
   * Build the export / chat model.
   * payload: { pairs, clientName, cms? }
   */
  function buildYearCompareModel(payload) {
    const pairs = (payload && payload.pairs) || [];
    const cms = (payload && payload.cms) || loadCmsFromDom();
    const clientName = (payload && payload.clientName) || "";
    const rows = benefitRows(pairs, cms);
    const colCount = 1 + pairs.length * 3;
    const aoa = [];
    const kinds = [];
    const styles = {};
    const merges = [];
    const hyperlinks = [];
    const push = (row, rowKinds) => {
      aoa.push(row);
      kinds.push(rowKinds);
      return aoa.length - 1;
    };
    const fill = (rgb) => ({ patternType: "solid", fgColor: { rgb } });

    if (clientName) {
      const r = push([clientName].concat(Array(colCount - 1).fill("")), Array(colCount).fill("title"));
      if (colCount > 1) merges.push({ s: { r, c: 0 }, e: { r, c: colCount - 1 } });
      styles[r + ",0"] = { font: { bold: true, sz: 16, color: { rgb: TITLE_COLOR } }, alignment: { vertical: "center" } };
    }

    const headers = [""];
    pairs.forEach((p) => headers.push.apply(headers, pairHeaders(p, cms)));
    const hr = push(headers, ["label"].concat(Array(colCount - 1).fill("header")));
    for (let c = 0; c < colCount; c++) {
      styles[hr + "," + c] = {
        font: { bold: true, color: { rgb: PURPLE_FONT }, sz: 11 },
        fill: fill(PURPLE),
        alignment: { wrapText: true, vertical: "center", horizontal: "center" },
      };
    }

    const noteRow = ["Plan note"];
    pairs.forEach((p) => noteRow.push(pairNote(p), "", ""));
    const nr = push(noteRow, ["label"].concat(Array(colCount - 1).fill("note")));
    styles[nr + ",0"] = { font: { bold: true } };
    pairs.forEach((p, i) => {
      const c = 1 + i * 3;
      merges.push({ s: { r: nr, c }, e: { r: nr, c: c + 2 } });
      styles[nr + "," + c] = { font: { italic: true, sz: 9, color: { rgb: p.flags.length ? CHANGED_FONT : TITLE_COLOR } }, alignment: { wrapText: true, vertical: "top" } };
    });

    const section = (label) => {
      const r = push([label].concat(Array(colCount - 1).fill("")), Array(colCount).fill("section"));
      for (let c = 0; c < colCount; c++) styles[r + "," + c] = { font: { bold: true, sz: 12 }, fill: fill(SECTION_FILL) };
    };

    let lastSection = "";
    rows.forEach((row) => {
      if (row.section !== lastSection) {
        section(row.section === "cms" ? "Medicare.gov plan data (CMS)" : "Plan benefits (THEI grid)");
        lastSection = row.section;
      }
      const vals = [row.label];
      const rk = ["label"];
      row.cells.forEach((cell) => {
        vals.push(cell.v26, cell.v27, cell.change || "");
        const k = cell.change === CHANGED ? "changed" : cell.change === SAME ? "same" : cell.change === REVIEW ? "review" : "text";
        rk.push(k === "changed" ? "changed-cell" : "text", k === "changed" ? "changed-cell" : "text", k);
      });
      const r = push(vals, rk);
      styles[r + ",0"] = { font: { bold: true } };
      row.cells.forEach((cell, i) => {
        const c = 1 + i * 3;
        if (cell.change === CHANGED) {
          styles[r + "," + c] = { fill: fill(CHANGED_FILL) };
          styles[r + "," + (c + 1)] = { fill: fill(CHANGED_FILL), font: { bold: true } };
          styles[r + "," + (c + 2)] = { fill: fill(CHANGED_FILL), font: { bold: true, color: { rgb: CHANGED_FONT } } };
        } else if (cell.change === SAME) {
          styles[r + "," + (c + 2)] = { font: { color: { rgb: MUTED_FONT } } };
        } else if (cell.change === REVIEW) {
          styles[r + "," + (c + 2)] = { font: { italic: true, color: { rgb: PURPLE } } };
        }
      });
    });

    const linkRow = (label, fn) => {
      const vals = [label];
      const rk = ["label"];
      const r = aoa.length;
      pairs.forEach((p, i) => {
        const c = 1 + i * 3;
        [fn(p.plan26, 2026), fn(p.plan27, 2027)].forEach((cell, j) => {
          vals.push(cell.text);
          rk.push(cell.url ? "link" : "text");
          if (cell.url) {
            hyperlinks.push({ r, c: c + j, url: cell.url, text: cell.text });
            styles[r + "," + (c + j)] = { font: { color: { rgb: LINK_BLUE }, underline: true } };
          }
        });
        vals.push("");
        rk.push("text");
      });
      push(vals, rk);
      styles[r + ",0"] = { font: { bold: true } };
    };
    linkRow("Summary of Benefits", sobCell);
    linkRow("Evidence of Coverage", eocCell);

    const sources = (cms && cms.sources) || {};
    const srcText = [
      "Change: Changed = amounts differ · Same = same amounts · Review = wording differs or one year not listed, check the SOB.",
      "Sources: THEI 2026 / 2027 Plan Comparison Grids" +
        (sources.landscape2026 ? "; " + sources.landscape2026 : "") +
        (sources.landscape2027 ? "; " + sources.landscape2027 : "") +
        (sources.crosswalk ? "; " + sources.crosswalk : "") + ".",
    ].join("\n");
    const sr = push([srcText].concat(Array(colCount - 1).fill("")), Array(colCount).fill("source"));
    if (colCount > 1) merges.push({ s: { r: sr, c: 0 }, e: { r: sr, c: colCount - 1 } });
    styles[sr + ",0"] = { font: { italic: true, sz: 8, color: { rgb: MUTED_FONT } }, alignment: { wrapText: true, vertical: "top", horizontal: "left" } };

    return {
      pairs,
      clientName,
      title: clientName,
      rows,
      headers,
      aoa,
      kinds,
      styles,
      merges,
      hyperlinks,
      colCount,
      counts: pairs.map((_, i) => pairCounts(rows, i)),
      cols: [{ wch: 30 }].concat(...pairs.map(() => [{ wch: 30 }, { wch: 30 }, { wch: 11 }])),
      filenameXlsx: yearCompareFilename(pairs, clientName, "xlsx"),
      filenamePdf: yearCompareFilename(pairs, clientName, "pdf"),
    };
  }

  // ─── Chat reply ────────────────────────────────────────────────────────────

  function oneLine(s, max) {
    const t = String(s == null ? "" : s).replace(/\s*\n\s*/g, " · ").replace(/\s+/g, " ").trim();
    const lim = max || 70;
    return t.length > lim ? t.slice(0, lim - 1).trim() + "…" : t;
  }

  function pairTitle(pair) {
    const p = pair.plan27 || pair.plan26;
    const id = pair.plan27 ? displayId(pair.plan27) : pair.id26;
    return `${marketing(p)} ${id} (${pair.county})`;
  }

  function buildYearCompareChat(model, extra) {
    const lines = [];
    const info = extra || {};
    model.pairs.forEach((pair, i) => {
      if (i) lines.push("");
      lines.push(`**2026 → 2027: ${pairTitle(pair)}**`);
      pair.flags.forEach((f) => lines.push(f));
      pair.notes
        .filter((n) => !/^Also offered in/.test(n))
        .forEach((n) => lines.push("_" + n + "_"));
      const changed = model.rows.filter((r) => r.cells[i].change === CHANGED);
      if (pair.kind === "new" || pair.kind === "ending") {
        model.rows
          .filter((r) => r.section === "cms" && r.key !== "starRating")
          .forEach((r) => {
            const c = r.cells[i];
            lines.push(`- ${r.label}: ${pair.kind === "new" ? "2027 " + oneLine(c.v27) : "2026 " + oneLine(c.v26)}`);
          });
      } else if (changed.length) {
        lines.push("Changed:");
        changed.forEach((r) => {
          const c = r.cells[i];
          lines.push(`- ${r.label}: ${oneLine(c.v26)} → ${oneLine(c.v27)}`);
        });
      } else {
        lines.push("No amount changes found on the grid rows.");
      }
      const n = model.counts[i];
      if (pair.kind !== "new" && pair.kind !== "ending") {
        const rowsWord = (k) => k + (k === 1 ? " row" : " rows");
        lines.push(`Unchanged: ${rowsWord(n.same)}` + (n.review ? ` · Review (wording differs / not listed one year): ${rowsWord(n.review)} — see export` : ""));
      }
      const s26 = pair.plan26 && pair.plan26.sobUrl;
      const s27 = pair.plan27 && pair.plan27.sobUrl;
      const links = [];
      if (s26) links.push(`[2026 SoB](${s26})`);
      if (s27) links.push(`[2027 SoB](${s27})`);
      if (links.length) lines.push("SOB: " + links.join(" · "));
      const also = pair.notes.find((x) => /^Also offered in/.test(x));
      if (also) lines.push("_" + also + "_");
    });
    if (info.unresolved && info.unresolved.length) {
      lines.push("", `Not found in the 2026 or 2027 plan data: ${info.unresolved.join(", ")}.`);
    }
    if (info.truncated) lines.push("", `Showing the first ${MAX_PLANS} plans.`);
    lines.push("", "Export Excel or PDF below.");
    return lines.join("\n");
  }

  // ─── Entry point for the chat UI ───────────────────────────────────────────

  /** "Maria Arias Lazo what" → "Maria Arias Lazo" (stop at the first lowercase word that is not a name particle). */
  function tidyClientName(name) {
    const words = String(name || "").replace(/[.,;:!?]+/g, " ").trim().split(/\s+/).filter(Boolean);
    const out = [];
    for (const w of words) {
      if (/^[a-z]/.test(w) && !/^(de|del|la|le|da|van|von|y)$/.test(w)) break;
      out.push(w);
    }
    return out.join(" ");
  }

  /**
   * opts: { text, threadText, fallbackIds, plans2026, plans2027, cms, clientName }
   * → { pairs, unresolved, chatText, payload } or null when no plan could be resolved.
   */
  function runYearCompare(opts) {
    const o = opts || {};
    const cms = o.cms || loadCmsFromDom();
    let ids = planIdsInText(o.text);
    if (!ids.length) ids = (o.fallbackIds || []).map(normalizePlanKey).filter(Boolean);
    ids = ids.filter((x, i, a) => a.indexOf(x) === i);
    if (!ids.length) return null;
    const ctx = { plans2026: o.plans2026 || [], plans2027: o.plans2027 || [], cms };
    const county = countyHint(o.text) || countyHint(o.threadText);
    const res = resolveYearPairs(ids, ctx, { county });
    if (!res.pairs.length) {
      return { pairs: [], unresolved: res.unresolved, chatText: `I couldn't find ${ids.join(", ")} in the 2026 or 2027 plan data.`, payload: null };
    }
    const lib = exportLib();
    const clientName = tidyClientName(
      o.clientName ||
        (typeof lib.extractClientName === "function" ? lib.extractClientName(String(o.threadText || o.text || "")) : "") ||
        ""
    );
    const payload = { pairs: res.pairs, clientName, requestIds: ids };
    const model = buildYearCompareModel(Object.assign({ cms }, payload));
    return {
      pairs: res.pairs,
      unresolved: res.unresolved,
      model,
      payload,
      chatText: buildYearCompareChat(model, res),
    };
  }

  // ─── Excel / PDF ───────────────────────────────────────────────────────────

  function getXlsx() {
    if (typeof XLSX !== "undefined") return XLSX; // eslint-disable-line no-undef
    if (root && root.XLSX) return root.XLSX;
    return null;
  }

  function buildYearCompareSheet(X, model) {
    const ws = X.utils.aoa_to_sheet(model.aoa);
    ws["!cols"] = model.cols;
    ws["!merges"] = model.merges;
    ws["!rows"] = model.aoa.map((row, r) => {
      const k = model.kinds[r] || [];
      if (k.includes("header")) return { hpt: 48 };
      if (k[0] === "title") return { hpt: 24 };
      if (k[0] === "source") return { hpt: 30 };
      if (k[1] === "note") {
        const longest = row.reduce((m, cell) => Math.max(m, String(cell || "").length), 0);
        return { hpt: Math.min(15 * Math.max(1, Math.ceil(longest / 80)) + 6, 120) };
      }
      const lines = row.reduce((mx, cell, c) => {
        const per = c === 0 ? 28 : (c - 1) % 3 === 2 ? 10 : 28;
        const n = String(cell == null ? "" : cell).split("\n").reduce((s, part) => s + Math.max(1, Math.ceil(part.length / per)), 0);
        return Math.max(mx, n);
      }, 1);
      return { hpt: lines > 1 ? Math.min(15 * lines + 4, 150) : 18 };
    });
    const edge = { style: "thin", color: { rgb: "9A9A9A" } };
    model.aoa.forEach((row, r) => {
      const k0 = (model.kinds[r] || [])[0];
      for (let c = 0; c < model.colCount; c++) {
        const addr = X.utils.encode_cell({ r, c });
        if (!ws[addr]) ws[addr] = { t: "s", v: "" };
        const own = model.styles[r + "," + c] || {};
        if (k0 === "title") {
          ws[addr].s = own;
          continue;
        }
        const leftAlign = k0 === "source" || (model.kinds[r] || [])[c] === "note";
        ws[addr].s = Object.assign({}, own, {
          border: { top: edge, bottom: edge, left: edge, right: edge },
          alignment: Object.assign({ horizontal: leftAlign ? "left" : "center", vertical: "center", wrapText: true }, own.alignment || {}, leftAlign ? { horizontal: "left" } : { horizontal: "center" }),
        });
      }
    });
    model.hyperlinks.forEach((h) => {
      const addr = X.utils.encode_cell({ r: h.r, c: h.c });
      if (ws[addr]) ws[addr].l = { Target: h.url, Tooltip: h.text || h.url };
    });
    return ws;
  }

  function buildYearCompareWorkbook(X, payload) {
    const model = buildYearCompareModel(payload);
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, buildYearCompareSheet(X, model), "2026 vs 2027");
    return { wb, model };
  }

  function exportYearCompareToExcel(payload) {
    const X = getXlsx();
    if (!X) {
      if (typeof alert === "function") alert("Export library didn't load -- please refresh and try again."); // eslint-disable-line no-alert
      return null;
    }
    const { wb, model } = buildYearCompareWorkbook(X, payload);
    if (!model.pairs.length) return null;
    X.writeFile(wb, model.filenameXlsx);
    return model;
  }

  function getJsPdf() {
    if (root && root.jspdf && root.jspdf.jsPDF) return root.jspdf.jsPDF;
    if (root && root.jsPDF) return root.jsPDF;
    return null;
  }

  // jsPDF's built-in Helvetica has no arrow / warning glyphs.
  function pdfText(s) {
    return String(s == null ? "" : s).replace(/→/g, "->").replace(/⚠\uFE0F?\s*/g, "Warning: ").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  }

  /** One table per plan (2026 | 2027 | Change) so wide multi-plan compares stay readable. */
  function renderYearComparePdf(doc, model) {
    const margin = 28;
    model.pairs.forEach((pair, i) => {
      if (i) doc.addPage();
      let y = 36;
      if (model.title) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        doc.setTextColor(42, 21, 64);
        doc.text(model.title, margin, y);
        y += 18;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(42, 21, 64);
      doc.text(pdfText(`2026 vs 2027 — ${pairTitle(pair)}`), margin, y);
      y += 13;
      const note = pairNote(pair);
      if (note) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(pair.flags.length ? 180 : 60, pair.flags.length ? 71 : 60, pair.flags.length ? 15 : 60);
        const lines = doc.splitTextToSize(pdfText(note), 540);
        doc.text(lines, margin, y);
        y += lines.length * 10;
      }
      const c0 = 1 + i * 3;
      const head = [["", pdfText(model.headers[c0]), pdfText(model.headers[c0 + 1]), "Change"]];
      const body = [];
      const bodyKinds = [];
      const links = [];
      model.aoa.forEach((row, r) => {
        const k = model.kinds[r] || [];
        if (k[0] === "title" || k.includes("header") || k[1] === "note" || k[0] === "source") return;
        if (k[0] === "section") {
          body.push([row[0], "", "", ""]);
          bodyKinds.push(["section", "section", "section", "section"]);
          return;
        }
        body.push([row[0], row[c0], row[c0 + 1], row[c0 + 2]].map(pdfText));
        bodyKinds.push([k[0], k[c0], k[c0 + 1], k[c0 + 2]]);
        model.hyperlinks.filter((h) => h.r === r && (h.c === c0 || h.c === c0 + 1)).forEach((h) => links.push({ row: body.length - 1, col: h.c - c0 + 1, url: h.url }));
      });
      if (typeof doc.autoTable !== "function") {
        doc.setFontSize(8);
        body.forEach((row) => {
          if (y > 740) {
            doc.addPage();
            y = 36;
          }
          doc.text(row.join("  |  ").replace(/\n/g, " · "), margin, y, { maxWidth: 540 });
          y += 12;
        });
        return;
      }
      doc.autoTable({
        startY: y + 4,
        head,
        body,
        theme: "grid",
        styles: { fontSize: 8, cellPadding: 3, valign: "top", overflow: "linebreak" },
        headStyles: { fillColor: [91, 44, 139], textColor: 255, fontStyle: "bold", halign: "center" },
        columnStyles: { 0: { cellWidth: 130, fontStyle: "bold" }, 3: { cellWidth: 56, halign: "center" } },
        didParseCell: function (data) {
          if (data.section !== "body") return;
          const kind = (bodyKinds[data.row.index] || [])[data.column.index];
          if (kind === "section") {
            data.cell.styles.fillColor = [243, 238, 247];
            data.cell.styles.fontStyle = "bold";
          } else if (kind === "changed" || kind === "changed-cell") {
            data.cell.styles.fillColor = [252, 228, 214];
            if (kind === "changed") {
              data.cell.styles.textColor = [180, 71, 15];
              data.cell.styles.fontStyle = "bold";
            }
          } else if (kind === "same") {
            data.cell.styles.textColor = [107, 107, 107];
          } else if (kind === "review") {
            data.cell.styles.textColor = [91, 44, 139];
            data.cell.styles.fontStyle = "italic";
          } else if (kind === "link") {
            data.cell.styles.textColor = [5, 99, 193];
          }
        },
        didDrawCell: function (data) {
          if (data.section !== "body") return;
          const link = links.find((l) => l.row === data.row.index && l.col === data.column.index);
          if (link) doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: link.url });
        },
        margin: { left: margin, right: margin },
      });
      const after = (doc.lastAutoTable && doc.lastAutoTable.finalY) || y;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7);
      doc.setTextColor(107, 107, 107);
      const src = pdfText(model.aoa[model.aoa.length - 1][0] || "");
      doc.text(doc.splitTextToSize(src, 540), margin, Math.min(after + 14, 770));
    });
    return doc;
  }

  function exportYearCompareToPdf(payload) {
    const JsPDF = getJsPdf();
    if (!JsPDF) {
      if (typeof alert === "function") alert("PDF library didn't load -- please refresh and try again."); // eslint-disable-line no-alert
      return null;
    }
    const model = buildYearCompareModel(payload);
    if (!model.pairs.length) return null;
    const doc = new JsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    renderYearComparePdf(doc, model);
    doc.save(model.filenamePdf);
    return model;
  }

  return {
    NEW_NOTE,
    CMS_ROWS,
    normalizePlanKey,
    planIdsInText,
    countyHint,
    wantsYearCompare,
    loadCmsFromDom,
    productChanged,
    nameSimilarity,
    pairFor,
    resolveYearPairs,
    normalizeValue,
    compareValues,
    buildYearCompareModel,
    buildYearCompareChat,
    buildYearCompareWorkbook,
    buildYearCompareSheet,
    renderYearComparePdf,
    runYearCompare,
    yearCompareFilename,
    exportYearCompareToExcel,
    exportYearCompareToPdf,
  };
});
