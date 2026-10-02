/**
 * Max client plan comparison export (Yahoska / Arias Lazo layout).
 * Works in the browser (window.MaxComparisonExport) and in Node tests.
 * Benefit dollars always come from plan objects — never from chat prose.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.MaxComparisonExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PURPLE = "5B2C8B";
  const PURPLE_FONT = "FFFFFF";
  const GREEN = "1B7A3A";
  const RED = "9B1C3C";
  const YELLOW = "FFF2A8";
  const TITLE_COLOR = "2A1540";
  const LINK_BLUE = "0563C1";
  const SECTION_FILL = "F3EEF7";

  // Sample labels and order. Keys map to THEI #plan-data fields.
  const FIELD_ROWS = [
    ["Premium", "premium"],
    ["Part B Rebate", "partBGiveback"],
    ["Referrals Needed?", "referral"],
    ["MSP Levels", "mspLevels"],
    ["Max Out of Pocket", "moop"],
    ["Inpatient Hospital", "inpatientHospital"],
    ["Outpatient Hospital", "outpatientHospital"],
    ["PCP", "pcpCopay"],
    ["Specialist", "specialistCopay"],
    ["ER", "erCopay"],
    ["Urgent Care", "urgentCareCopay"],
    ["Advanced Imaging (MRI, CT, PET)", "advancedImaging"],
    ["Hearing Services", "hearing"],
    ["Dental", "dental"],
    ["Deep Cleaning", "dentalDeepCleaning"],
    ["Dentures", "dentalDentures"],
    ["Fillings", "dentalFillings"],
    ["Root Canals", "dentalRootCanals"],
    ["Extractions", "dentalExtractions"],
    ["Crowns", "dentalCrowns"],
    ["Bridges", "dentalBridges"],
    ["Implants", "dentalImplants"],
    ["Vision Allowance", "vision"],
    ["Ambulance", "ambulance"],
    ["Transportation", "transportation"],
    ["Companionship", "companionship"],
    ["Custodial Care", "custodialCare"],
    ["RX Deductible", "rxDeductible"],
    ["Tier 1", "tier1"],
    ["Tier 2", "tier2"],
    ["Tier 3", "tier3"],
    ["Tier 4", "tier4"],
    ["Tier 5", "tier5"],
    ["Tier 6", "tier6"],
    ["OTC", "otc"],
    ["Grocery Card", "groceryCardDetail"],
    ["Acupuncture", "acupuncture"],
    ["Fitness", "fitness"],
  ];

  const HIGHLIGHT_KEYS = { hearing: true, otc: true };
  const NETWORK_IN = "In network";
  const NETWORK_OUT = "Out of network";
  const NETWORK_NOT_CONFIRMED = "Not confirmed";
  const NETWORK_NEED_MORE = "Need more info";

  const CLIENT_NAME_BLOCK = /^(miami|dade|broward|florida|medicare|humana|united|uhc|careplus|devoted|wellcare|aetna|simply|solis|healthsun|healthspring|doctors?|client|export|excel|compare|comparison|plan|dual|complete|preferred|summary|benefits|thei|max|pdf|sheet)$/i;

  function escapeRe(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function safeExportPlanId(id) {
    return String(id || "")
      .replace(/\s+/g, "")
      .replace(/[\\/?%*:|"<>]/g, "-");
  }

  function displayContractPbp(plan) {
    let id = String((plan && (plan.planId || plan.id)) || "").replace(/\s+/g, "");
    id = id.replace(/-000$/i, "").replace(/\/000$/i, "");
    return id;
  }

  function formatPlanMarketingName(plan) {
    if (!plan) return "";
    const rawId = String(plan.planId || plan.id || "").replace(/\s+/g, "");
    const dispId = displayContractPbp(plan);
    const stripIds = (s) => {
      let out = String(s || "");
      if (rawId) out = out.replace(new RegExp(escapeRe(rawId), "ig"), " ");
      if (dispId && dispId !== rawId) out = out.replace(new RegExp(escapeRe(dispId), "ig"), " ");
      return out.replace(/\s+/g, " ").trim();
    };
    let name = stripIds(plan.planName);
    let carrier = stripIds(plan.carrier);
    if (!name) name = carrier;
    else if (carrier) {
      const n = name.toLowerCase();
      const c = carrier.toLowerCase();
      if (c === n) {
        /* already the same */
      } else if (n.startsWith(c) || c.includes(n)) {
        if (c.length > n.length && c.includes(n)) name = carrier;
      } else if (!c.startsWith(n) && !n.includes(c)) {
        name = (carrier + " " + name).replace(/\s+/g, " ").trim();
      }
    }
    return String(name || "").replace(/\s+/g, " ").trim();
  }

  function formatPlanColumnHeader(plan) {
    const name = formatPlanMarketingName(plan);
    const id = displayContractPbp(plan);
    return id ? name + "\n" + id : name;
  }

  function isBlankish(v) {
    if (v === undefined || v === null) return true;
    const s = String(v).trim();
    return s === "" || /^["'\s*]+$/.test(s);
  }

  function normalizeGapToken(s) {
    const t = String(s).trim();
    if (/^not\s*listed$/i.test(t)) return "Not listed";
    if (/^n\/a$/i.test(t)) return "N/A";
    if (/^sob\s*pending$/i.test(t)) return "SOB pending";
    if (/^eoc\s*pending$/i.test(t)) return "EOC pending";
    return t;
  }

  function formatBenefitValue(v, key) {
    if (isBlankish(v)) return "Not listed";
    if (key === "partBGiveback" && typeof v === "number") {
      return v === 0 ? "$0" : "$" + v;
    }
    if (typeof v === "number") {
      if (v > 0 && v < 1) return Math.round(v * 1000) / 10 + "%";
      return "$" + v;
    }
    if (Array.isArray(v)) return v.length ? v.join("; ") : "Not listed";
    return normalizeGapToken(v);
  }

  function formatSobCell(plan) {
    const url = plan && plan.sobUrl ? String(plan.sobUrl).trim() : "";
    if (url) return { text: "Summary of Benefits", url };
    return { text: "SOB pending" };
  }

  function formatEocCell(plan) {
    const url = plan && plan.eocUrl ? String(plan.eocUrl).trim() : "";
    if (url) return { text: "Evidence of Coverage", url };
    return { text: "EOC pending" };
  }

  function looksLikePersonName(name) {
    const parts = String(name || "").trim().split(/\s+/);
    if (parts.length < 2 || parts.length > 4) return false;
    if (/\d/.test(name)) return false;
    return parts.every((p) => {
      if (CLIENT_NAME_BLOCK.test(p)) return false;
      return /^(?:[A-Z][A-Za-z.'-]+|de|del|la|le|da|van|von)$/i.test(p);
    });
  }

  function extractClientName(text) {
    if (!text) return "";
    // Do not use the /i flag: it makes [A-Z] match lowercase and grabs "for both plans".
    const name = "([A-Z][a-zA-Z'-]+(?:\\s+[A-Z][a-zA-Z'-]+){1,3})";
    const patterns = [
      new RegExp("\\b[Cc]lient(?:\\s+[Nn]ame)?\\s*[:=]\\s*" + name, "g"),
      new RegExp("\\b[Cc]lient(?:\\s+[Nn]ame)?\\s+is\\s+" + name, "g"),
      new RegExp("\\bfor\\s+" + name + "(?:\\s+in\\b|\\s*[,.]|\\s*$)", "g"),
    ];
    let found = "";
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text))) {
        const candidate = m[1].replace(/\s+/g, " ").trim();
        if (looksLikePersonName(candidate)) found = candidate;
      }
    }
    // Labeled household / last name (e.g. Client: Muskat) — only when explicitly labeled.
    const labeled = /\b(?:client(?:\s+name)?|household)\s*[:=]\s*([A-Za-z][A-Za-z'.-]{1,40}(?:\s+[A-Za-z][A-Za-z'.-]{1,40}){0,3})/gi;
    let m;
    while ((m = labeled.exec(text))) {
      const candidate = m[1].replace(/\s+/g, " ").trim();
      if (looksLikePersonName(candidate) || /^[A-Za-z][A-Za-z'.-]{1,40}$/.test(candidate)) {
        found = candidate;
      }
    }
    return found;
  }

  function extractTerminatingPlan(text) {
    if (!text) return "";
    const patterns = [
      /(?:plan\s+)?terminat(?:ing|es|ed|ion)\s*(?:plan)?\s*[:\-–]\s*([^\n]{3,90})/i,
      /plan\s+terminating\s+([A-Z][^\n]{2,90})/i,
      /terminating\s+plan\s+(?:is\s+)?([A-Z][^\n]{2,90})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      let value = String(m[1] || "").replace(/\s+/g, " ").trim();
      value = value.replace(/\s*[.]$/, "");
      value = value.replace(/\s+(and|for|in|on|with|who|which)\s+$/i, "").trim();
      if (value.length >= 3 && /[A-Za-z]/.test(value)) return value;
    }
    return "";
  }

  function normalizeNetworkStatus(raw) {
    if (raw === true) return NETWORK_IN;
    if (raw === false) return NETWORK_OUT;
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/need\s*more\s*info/i.test(s)) return NETWORK_NEED_MORE;
    if (/not\s*confirmed/i.test(s)) return NETWORK_NOT_CONFIRMED;
    if (/^(in[-\s]?network|inn|in|true|yes|✅)$/i.test(s) || /^IN$/i.test(s) || /\bin[-\s]?network\b/i.test(s)) {
      return NETWORK_IN;
    }
    if (
      /^(out(?:\s+of)?[-\s]?network|oon|out|false|no|❌)$/i.test(s) ||
      /^OUT$/i.test(s) ||
      /\bout(?:\s+of)?[-\s]?network\b/i.test(s)
    ) {
      return NETWORK_OUT;
    }
    return "";
  }

  function findDoctorNames(text) {
    const names = [];
    const seen = new Set();
    const add = (raw) => {
      let name = String(raw || "").replace(/\s+/g, " ").trim();
      name = name.replace(/[.,;:]+$/, "");
      if (!name || /^(Max|Select|Plus|Flex|Extra|Complete)$/i.test(name)) return;
      const parts = name.split(/\s+/);
      if (parts.length < 2) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(/^dr\.?\s/i.test(name) ? name.replace(/^dr\.?\s+/i, "Dr. ") : "Dr. " + name);
    };
    const drRe = /\b(?:Dr\.?|Doctor)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/g;
    const mdRe = /\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,2}),?\s+M\.?D\.?\b/g;
    let m;
    while ((m = drRe.exec(text))) add(m[1]);
    while ((m = mdRe.exec(text))) add(m[1]);
    return names;
  }

  function planMentionedIn(window, plan) {
    const id = String(plan.planId || plan.id || "").replace(/\s+/g, "");
    const disp = displayContractPbp(plan);
    const hay = String(window || "").toUpperCase().replace(/\s+/g, "");
    if (id && hay.includes(id.toUpperCase().replace(/\s+/g, ""))) return true;
    if (disp && disp !== id && hay.includes(disp.toUpperCase().replace(/\s+/g, ""))) return true;
    return false;
  }

  function statusTokens(window) {
    const tokens = [];
    const re = /out(?:\s+of)?[-\s]?network|in[-\s]?network|\bOON\b|\bINN\b|✅|❌/gi;
    let t;
    while ((t = re.exec(window))) {
      tokens.push(/out|oon|❌/i.test(t[0]) ? NETWORK_OUT : NETWORK_IN);
    }
    return tokens;
  }

  function applyStatusesFromWindow(window, plans, statuses) {
    const tokens = statusTokens(window);
    if (!tokens.length) return;
    const hits = plans.map((p) => planMentionedIn(window, p));
    const anyPlan = hits.some(Boolean);
    const both = /\bboth\b|\ball\s+(?:plans|of\s+them)\b/i.test(window);

    if (tokens.length === plans.length && !anyPlan) {
      tokens.forEach((s, i) => {
        statuses[i] = s;
      });
      return;
    }
    if (tokens.length === 1 && (both || hits.filter(Boolean).length === plans.length)) {
      statuses.forEach((_, i) => {
        statuses[i] = tokens[0];
      });
      return;
    }
    if (anyPlan) {
      plans.forEach((p, i) => {
        if (!hits[i]) return;
        const id = displayContractPbp(p);
        const upper = window.toUpperCase();
        const idx = upper.indexOf(id.toUpperCase());
        const local = idx >= 0 ? window.slice(Math.max(0, idx - 48), idx + id.length + 48) : window;
        const localTokens = statusTokens(local);
        if (localTokens.length) statuses[i] = localTokens[0];
        else if (tokens.length === 1) statuses[i] = tokens[0];
      });
    }
  }

  function extractDoctors(text, plans) {
    if (!text || !plans || !plans.length) return [];
    const names = findDoctorNames(text);
    const doctors = [];
    for (const name of names) {
      const statuses = plans.map(() => "");
      const bare = name.replace(/^Dr\.?\s+/i, "");
      const re = new RegExp("(?:Dr\\.?\\s+)?" + escapeRe(bare), "ig");
      let m;
      while ((m = re.exec(text))) {
        applyStatusesFromWindow(text.slice(m.index, m.index + 420), plans, statuses);
      }
      if (statuses.some(Boolean)) {
        doctors.push({
          name,
          statuses: statuses.map((s) => s || "Not listed"),
        });
      }
    }
    return doctors;
  }

  const DRUG_NAME_BLOCK = /^(the|and|for|with|from|plan|gold|plus|giveback|premium|deductible|hospital|client|miami|dade|broward|humana|tier|medicare|complete|dual|select|choice|preferred|summary|benefits|thei|max|otc|grocery|vision|dental|doctor|network)$/i;

  function looksLikeDrugName(name) {
    const s = String(name || "").replace(/\s+/g, " ").trim();
    if (s.length < 3 || s.length > 48) return false;
    if (/\d{5,}/.test(s)) return false;
    const parts = s.split(/\s+/);
    if (parts.length > 4) return false;
    if (parts.some((p) => DRUG_NAME_BLOCK.test(p))) return false;
    return /[A-Za-z]{3,}/.test(s);
  }

  function normalizeDrugName(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/[.,;:]+$/, "")
      .trim();
  }

  function parseFormularyLookupLine(line) {
    if (!/FORMULARY_LOOKUP/i.test(line || "")) return null;
    const get = (key) => {
      const m = String(line).match(new RegExp("(?:^|\\s)" + key + "=([^\\s]+)", "i"));
      return m ? m[1] : "";
    };
    const drug = normalizeDrugName((get("drug") || "").replace(/_/g, " "));
    const planId = get("plan");
    if (!drug || !planId) return null;
    const verifiedNo = /verified=no/i.test(line);
    const tier = parseInt(get("verified_tier"), 10);
    const coverage = get("coverage");
    return {
      name: drug,
      planId,
      verified: !verifiedNo && ((tier >= 1 && tier <= 6) || coverage === "not_covered"),
      tier: tier >= 1 && tier <= 6 ? tier : null,
      coverage: coverage || (tier ? "covered" : null),
      costShare: (get("cost_share") || "").replace(/_/g, " ") || null,
      pa: get("pa") === "yes" ? true : get("pa") === "no" ? false : null,
      st: get("st") === "yes" ? true : get("st") === "no" ? false : null,
      source: get("source") || null,
      year: parseInt(get("year"), 10) || null,
    };
  }

  function extractClaimedMeds(text) {
    const meds = [];
    const seen = new Set();
    const re =
      /\b([A-Za-z][A-Za-z0-9'\/.+-]{2,}(?:\s+(?:\d+(?:\.\d+)?\s*(?:mg|mcg)|[A-Za-z][A-Za-z0-9'\/.+-]{2,})){0,3})\s+[\(:]?\s*(?:T(?:ier)?\s*)([1-6])\b/gi;
    let m;
    while ((m = re.exec(text || ""))) {
      const name = normalizeDrugName(m[1]);
      if (!looksLikeDrugName(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      meds.push({ name });
    }
    return meds;
  }

  function extractVerifiedLookups(text) {
    const rows = [];
    String(text || "")
      .split(/\n/)
      .forEach((line) => {
        const parsed = parseFormularyLookupLine(line);
        if (parsed) rows.push(parsed);
      });
    return rows;
  }

  function emptyPlanDrugStatuses(plans) {
    const byPlanId = {};
    (plans || []).forEach((p) => {
      const id = displayContractPbp(p) || String(p.planId || p.id || "");
      byPlanId[id] = { verified: false, tier: null, costShare: null };
    });
    return byPlanId;
  }

  function mergeDrugPlanStatus(target, planId, incoming, plans) {
    if (!incoming) return;
    const match = (plans || []).find((p) => {
      const id = String(p.planId || p.id || "");
      const disp = displayContractPbp(p);
      return (
        String(planId || "").replace(/\s+/g, "").toUpperCase() === id.replace(/\s+/g, "").toUpperCase() ||
        String(planId || "").replace(/\s+/g, "").toUpperCase() === String(disp || "").replace(/\s+/g, "").toUpperCase() ||
        String(planId || "").toUpperCase().indexOf(String(disp || "").toUpperCase()) >= 0
      );
    });
    const key = match ? displayContractPbp(match) || String(match.planId || match.id || "") : planId;
    if (!key) return;
    const prev = target[key] || { verified: false, tier: null };
    if (incoming.verified && !prev.verified) {
      target[key] = {
        verified: true,
        tier: incoming.tier || null,
        coverage: incoming.coverage || null,
        costShare: incoming.costShare || null,
        pa: incoming.pa,
        st: incoming.st,
        source: incoming.source || null,
      };
    } else if (!target[key]) {
      target[key] = { verified: false, tier: null, costShare: incoming.costShare || null };
    }
  }

  function extractDrugs(text, plans) {
    const byName = new Map();
    const add = (name) => {
      const n = normalizeDrugName(name);
      if (!looksLikeDrugName(n)) return null;
      const key = n.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { name: n, byPlanId: emptyPlanDrugStatuses(plans) });
      }
      return byName.get(key);
    };
    extractClaimedMeds(text).forEach((med) => {
      add(med.name);
    });
    extractVerifiedLookups(text).forEach((hit) => {
      const row = add(hit.name);
      if (!row) return;
      mergeDrugPlanStatus(row.byPlanId, hit.planId, hit, plans);
    });
    return [...byName.values()];
  }

  function normalizeDrugs(drugs, plans) {
    if (!Array.isArray(drugs) || !drugs.length || !plans || !plans.length) return [];
    const byName = new Map();
    const add = (name) => {
      const n = normalizeDrugName(name);
      if (!n) return null;
      const key = n.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { name: n, byPlanId: emptyPlanDrugStatuses(plans) });
      }
      return byName.get(key);
    };
    drugs.forEach((d) => {
      if (!d || typeof d === "string") {
        if (typeof d === "string") add(d);
        return;
      }
      const row = add(d.name || d.drug || d.drugName);
      if (!row) return;
      const map = d.byPlanId || d.statusByPlanId || {};
      Object.keys(map).forEach((planId) => {
        const incoming = map[planId] || {};
        mergeDrugPlanStatus(row.byPlanId, planId, incoming, plans);
      });
      if (Array.isArray(d.lookups)) {
        d.lookups.forEach((hit) => mergeDrugPlanStatus(row.byPlanId, hit.planId, hit, plans));
      }
    });
    return [...byName.values()];
  }

  function formatDrugCell(status, plan) {
    if (!status || !status.verified) return "Unverified";
    if (status.coverage === "not_covered") return "Not covered";
    if (!status.tier) return "Unverified";
    const cost =
      status.costShare ||
      formatBenefitValue(plan && plan["tier" + status.tier], "tier" + status.tier);
    const flags = [status.pa ? "PA" : "", status.st ? "ST" : ""].filter(Boolean).join("/");
    const costBit = cost && cost !== "Not listed" ? " · " + cost : "";
    return "Tier " + status.tier + costBit + (flags ? " · " + flags : "");
  }

  function normalizeDoctors(doctors, plans) {
    if (!Array.isArray(doctors) || !doctors.length || !plans || !plans.length) return [];
    const out = [];
    for (const d of doctors) {
      if (!d || typeof d === "string") continue;
      const name = String(d.name || d.doctor || "").trim();
      if (!name) continue;
      let statuses = [];
      if (Array.isArray(d.statuses)) {
        statuses = d.statuses.map((s) => normalizeNetworkStatus(s) || (s ? String(s) : "Not listed"));
      } else if (d.byPlanId || d.statusByPlanId) {
        const map = d.byPlanId || d.statusByPlanId;
        statuses = plans.map((p) => {
          const id = String(p.planId || p.id || "");
          const disp = displayContractPbp(p);
          return normalizeNetworkStatus(map[id] || map[disp] || map[p.id]) || "Not listed";
        });
      }
      if (!statuses.some((s) => s && s !== "Not listed")) continue;
      out.push({
        name,
        statuses: plans.map((_, i) => statuses[i] || "Not listed"),
      });
    }
    return out;
  }

  function normalizeExportPayload(plansOrPayload, meta) {
    const extra = meta && typeof meta === "object" ? meta : {};
    if (Array.isArray(plansOrPayload)) {
      return { plans: plansOrPayload, ...extra };
    }
    if (plansOrPayload && typeof plansOrPayload === "object") {
      const plans = Array.isArray(plansOrPayload.plans) ? plansOrPayload.plans : [];
      return { ...plansOrPayload, plans, ...extra };
    }
    return { plans: [], ...extra };
  }

  function buildExportPayload(plans, threadText, extras) {
    const extra = extras && typeof extras === "object" ? extras : {};
    const text = String(threadText || "");
    const clientName = extra.clientName || extractClientName(text);
    const terminatingPlan = extra.terminatingPlan || extractTerminatingPlan(text);
    const doctors = normalizeDoctors(extra.doctors, plans).length
      ? normalizeDoctors(extra.doctors, plans)
      : extractDoctors(text, plans);
    const fromExtras = normalizeDrugs(extra.drugs, plans);
    const fromThread = extractDrugs(text, plans);
    const drugs = fromExtras.length ? fromExtras : fromThread;
    if (fromExtras.length && fromThread.length) {
      fromThread.forEach((t) => {
        const hit = drugs.find((d) => d.name.toLowerCase() === t.name.toLowerCase());
        if (!hit) drugs.push(t);
        else {
          Object.keys(t.byPlanId || {}).forEach((id) => {
            mergeDrugPlanStatus(hit.byPlanId, id, t.byPlanId[id], plans);
          });
        }
      });
    }
    return {
      plans: plans || [],
      clientName: clientName || "",
      terminatingPlan: terminatingPlan || "",
      doctors,
      drugs,
    };
  }

  function comparisonExportFilename(payload, ext) {
    const plans = (payload && payload.plans) || [];
    const ids = plans.map((p) => safeExportPlanId(displayContractPbp(p))).filter(Boolean).join("_");
    const name = payload && payload.clientName
      ? safeExportPlanId(String(payload.clientName).replace(/\s+/g, "_"))
      : "";
    const base = name
      ? name + "_Plan_Comparison" + (ids ? "_" + ids : "")
      : "Plan_Comparison" + (ids ? "_" + ids : "");
    return base + "." + (ext || "xlsx");
  }

  function makeStyle(partial) {
    return partial;
  }

  function buildComparisonModel(plansOrPayload, meta) {
    const payload = normalizeExportPayload(plansOrPayload, meta);
    const plans = payload.plans || [];
    const doctors = normalizeDoctors(payload.doctors, plans);
    const drugs = normalizeDrugs(payload.drugs, plans).length
      ? normalizeDrugs(payload.drugs, plans)
      : extractDrugs(
          typeof payload.threadText === "string" ? payload.threadText : "",
          plans
        );
    const headers = ["", ...plans.map(formatPlanColumnHeader)];
    const aoa = [];
    const merges = [];
    const hyperlinks = [];
    const styles = {};
    const kinds = []; // parallel to aoa: row of cell kinds
    const colCount = headers.length;

    const push = (row, rowKinds, rowStyles) => {
      const r = aoa.length;
      aoa.push(row);
      kinds.push(rowKinds || row.map(() => "text"));
      if (rowStyles) {
        rowStyles.forEach((s, c) => {
          if (s) styles[r + "," + c] = s;
        });
      }
      return r;
    };

    const title = payload.clientName || "";
    if (title) {
      const r = push([title, ...plans.map(() => "")], ["title", ...plans.map(() => "title")]);
      if (colCount > 1) merges.push({ s: { r, c: 0 }, e: { r, c: colCount - 1 } });
      styles[r + ",0"] = makeStyle({
        font: { bold: true, sz: 16, color: { rgb: TITLE_COLOR } },
        alignment: { vertical: "center" },
      });
    }

    if (payload.terminatingPlan) {
      push(
        ["Plan Terminating", payload.terminatingPlan, ...plans.slice(1).map(() => "")],
        ["label", "text", ...plans.slice(1).map(() => "text")]
      );
      const r = aoa.length - 1;
      if (colCount > 2) merges.push({ s: { r, c: 1 }, e: { r, c: colCount - 1 } });
      styles[r + ",0"] = makeStyle({ font: { bold: true } });
    }

    const headerStyle = makeStyle({
      font: { bold: true, color: { rgb: PURPLE_FONT }, sz: 11 },
      fill: { patternType: "solid", fgColor: { rgb: PURPLE } },
      alignment: { wrapText: true, vertical: "center", horizontal: "center" },
    });

    const pushPlanHeaders = () => {
      const r = push(headers, ["label", ...plans.map(() => "header")]);
      for (let c = 1; c < colCount; c++) styles[r + "," + c] = headerStyle;
      styles[r + ",0"] = makeStyle({
        fill: { patternType: "solid", fgColor: { rgb: PURPLE } },
        font: { bold: true, color: { rgb: PURPLE_FONT } },
      });
      return r;
    };

    pushPlanHeaders();

    if (doctors.length) {
      const r = push(["Doctors", ...plans.map(() => "")], ["section", ...plans.map(() => "section")]);
      styles[r + ",0"] = makeStyle({
        font: { bold: true, sz: 12 },
        fill: { patternType: "solid", fgColor: { rgb: SECTION_FILL } },
      });
      for (let c = 1; c < colCount; c++) {
        styles[r + "," + c] = makeStyle({ fill: { patternType: "solid", fgColor: { rgb: SECTION_FILL } } });
      }
      doctors.forEach((doc) => {
        const values = [doc.name, ...doc.statuses];
        const rowKinds = ["label", ...doc.statuses.map((s) => (s === NETWORK_IN ? "in" : s === NETWORK_OUT ? "out" : "text"))];
        const rowStyles = [makeStyle({ font: { bold: true } })];
        doc.statuses.forEach((s) => {
          if (s === NETWORK_IN) {
            rowStyles.push(makeStyle({ font: { color: { rgb: GREEN }, bold: true } }));
          } else if (s === NETWORK_OUT) {
            rowStyles.push(makeStyle({ font: { color: { rgb: RED } } }));
          } else {
            rowStyles.push(null);
          }
        });
        push(values, rowKinds, rowStyles);
      });
    }

    if (drugs.length) {
      const r = push(["Medications", ...plans.map(() => "")], ["section", ...plans.map(() => "section")]);
      styles[r + ",0"] = makeStyle({
        font: { bold: true, sz: 12 },
        fill: { patternType: "solid", fgColor: { rgb: SECTION_FILL } },
      });
      for (let c = 1; c < colCount; c++) {
        styles[r + "," + c] = makeStyle({ fill: { patternType: "solid", fgColor: { rgb: SECTION_FILL } } });
      }
      drugs.forEach((drug) => {
        const statuses = plans.map((p) => {
          const id = displayContractPbp(p);
          const rawId = String(p.planId || p.id || "");
          return (drug.byPlanId && (drug.byPlanId[id] || drug.byPlanId[rawId])) || { verified: false };
        });
        const cells = statuses.map((s, i) => formatDrugCell(s, plans[i]));
        const values = [drug.name, ...cells];
        const rowKinds = ["label", ...cells.map((c) => (c === "Unverified" ? "pending" : "text"))];
        const rowStyles = [makeStyle({ font: { bold: true } })];
        cells.forEach((c) => {
          rowStyles.push(
            c === "Unverified"
              ? makeStyle({ font: { color: { rgb: RED } } })
              : makeStyle({ alignment: { wrapText: true, vertical: "top" } })
          );
        });
        push(values, rowKinds, rowStyles);
      });
    }

    if (doctors.length || drugs.length) {
      pushPlanHeaders();
    }

    FIELD_ROWS.forEach(([label, key]) => {
      const values = [label, ...plans.map((p) => formatBenefitValue(p[key], key))];
      const highlight = HIGHLIGHT_KEYS[key];
      const rowKinds = ["label", ...plans.map(() => (highlight ? "highlight" : "text"))];
      const rowStyles = [makeStyle({ font: { bold: true } })];
      plans.forEach(() => {
        rowStyles.push(
          highlight
            ? makeStyle({
                fill: { patternType: "solid", fgColor: { rgb: YELLOW } },
                alignment: { wrapText: true, vertical: "top" },
              })
            : makeStyle({ alignment: { wrapText: true, vertical: "top" } })
        );
      });
      push(values, rowKinds, rowStyles);
    });

    const sobRow = ["Summary of Benefits"];
    const sobKinds = ["label"];
    const sobStyles = [makeStyle({ font: { bold: true } })];
    plans.forEach((p) => {
      const cell = formatSobCell(p);
      sobRow.push(cell.text);
      if (cell.url) {
        sobKinds.push("link");
        sobStyles.push(makeStyle({ font: { color: { rgb: LINK_BLUE }, underline: true } }));
        hyperlinks.push({ r: aoa.length, c: sobRow.length - 1, url: cell.url, text: cell.text });
      } else {
        sobKinds.push("pending");
        sobStyles.push(null);
      }
    });
    push(sobRow, sobKinds, sobStyles);

    const eocRow = ["Evidence of Coverage"];
    const eocKinds = ["label"];
    const eocStyles = [makeStyle({ font: { bold: true } })];
    plans.forEach((p) => {
      const cell = formatEocCell(p);
      eocRow.push(cell.text);
      if (cell.url) {
        eocKinds.push("link");
        eocStyles.push(makeStyle({ font: { color: { rgb: LINK_BLUE }, underline: true } }));
        hyperlinks.push({ r: aoa.length, c: eocRow.length - 1, url: cell.url, text: cell.text });
      } else {
        eocKinds.push("pending");
        eocStyles.push(null);
      }
    });
    push(eocRow, eocKinds, eocStyles);

    return {
      payload,
      title,
      aoa,
      kinds,
      merges,
      hyperlinks,
      styles,
      headers,
      doctors,
      drugs,
      filenameXlsx: comparisonExportFilename(payload, "xlsx"),
      filenamePdf: comparisonExportFilename(payload, "pdf"),
      cols: [{ wch: 28 }, ...plans.map(() => ({ wch: 36 }))],
    };
  }

  function applySheetExtras(ws, model) {
    ws["!cols"] = model.cols;
    ws["!merges"] = model.merges;
    const rowHeights = model.aoa.map((row, r) => {
      const header = (model.kinds[r] || []).includes("header");
      const wrapped = row.some((cell) => String(cell || "").includes("\n"));
      if (header) return { hpt: 36 };
      if (wrapped) return { hpt: 32 };
      if (r === 0 && model.title) return { hpt: 24 };
      return { hpt: 18 };
    });
    ws["!rows"] = rowHeights;
    model.hyperlinks.forEach((h) => {
      const addr = (typeof XLSX !== "undefined" && XLSX.utils ? XLSX.utils.encode_cell({ r: h.r, c: h.c }) : null);
      if (!addr || !ws[addr]) return;
      ws[addr].l = { Target: h.url, Tooltip: h.text || h.url };
    });
    Object.keys(model.styles).forEach((key) => {
      const parts = key.split(",");
      const r = Number(parts[0]);
      const c = Number(parts[1]);
      const addr = typeof XLSX !== "undefined" && XLSX.utils ? XLSX.utils.encode_cell({ r, c }) : null;
      if (!addr || !ws[addr]) return;
      ws[addr].s = model.styles[key];
    });
  }

  function getXlsx() {
    if (typeof XLSX !== "undefined") return XLSX;
    if (typeof window !== "undefined" && window.XLSX) return window.XLSX;
    return null;
  }

  function exportComparisonToExcel(plansOrPayload, meta) {
    const X = getXlsx();
    if (!X) {
      if (typeof alert === "function") alert("Export library didn't load -- please refresh and try again.");
      return null;
    }
    const model = buildComparisonModel(plansOrPayload, meta);
    if (!model.payload.plans.length) return null;
    const ws = X.utils.aoa_to_sheet(model.aoa);
    applySheetExtras(ws, model);
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, "Comparison");
    X.writeFile(wb, model.filenameXlsx);
    return model;
  }

  function getJsPdf() {
    const g = typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : {};
    if (g.jspdf && g.jspdf.jsPDF) return g.jspdf.jsPDF;
    if (g.jsPDF) return g.jsPDF;
    return null;
  }

  function exportComparisonToPdf(plansOrPayload, meta) {
    const JsPDF = getJsPdf();
    if (!JsPDF) {
      if (typeof alert === "function") alert("PDF library didn't load -- please refresh and try again.");
      return null;
    }
    const model = buildComparisonModel(plansOrPayload, meta);
    if (!model.payload.plans.length) return null;
    const planCount = model.payload.plans.length;
    const landscape = planCount >= 2;
    const doc = new JsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "pt", format: "letter" });
    const margin = 28;
    let y = 36;
    if (model.title) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(42, 21, 64);
      doc.text(model.title, margin, y);
      y += 18;
    }
    if (model.payload.terminatingPlan) {
      doc.setFontSize(10);
      doc.setTextColor(40, 40, 40);
      doc.setFont("helvetica", "bold");
      doc.text("Plan Terminating", margin, y);
      doc.setFont("helvetica", "normal");
      doc.text(String(model.payload.terminatingPlan), margin + 110, y);
      y += 14;
    }

    // Use rows from first plan-header onward
    let start = 0;
    for (let i = 0; i < model.aoa.length; i++) {
      if ((model.kinds[i] || [])[1] === "header") {
        start = i;
        break;
      }
    }
    const tableRows = model.aoa.slice(start + 1);
    const tableKinds = model.kinds.slice(start + 1);

    if (typeof doc.autoTable !== "function") {
      // Fallback: simple text table so PDF still downloads
      doc.setFontSize(9);
      model.aoa.forEach((row) => {
        if (y > 560) {
          doc.addPage();
          y = 36;
        }
        doc.text(row.map((c) => String(c || "").replace(/\n/g, " · ")).join("   |   "), margin, y, { maxWidth: 720 });
        y += 14;
      });
      doc.save(model.filenamePdf);
      return model;
    }

    doc.autoTable({
      startY: y + 4,
      head: [model.headers.map((h) => String(h || ""))],
      body: tableRows.map((row) => row.map((c) => String(c == null ? "" : c))),
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 3, valign: "top", overflow: "linebreak" },
      headStyles: { fillColor: [91, 44, 139], textColor: 255, fontStyle: "bold", halign: "center" },
      columnStyles: { 0: { cellWidth: 120, fontStyle: "bold" } },
      didParseCell: function (data) {
        if (data.section !== "body") return;
        const kindRow = tableKinds[data.row.index] || [];
        const kind = kindRow[data.column.index];
        if (kind === "in") {
          data.cell.styles.textColor = [27, 122, 58];
          data.cell.styles.fontStyle = "bold";
        } else if (kind === "out") {
          data.cell.styles.textColor = [155, 28, 60];
        } else if (kind === "highlight") {
          data.cell.styles.fillColor = [255, 242, 168];
        } else if (kind === "section") {
          data.cell.styles.fillColor = [243, 238, 247];
          data.cell.styles.fontStyle = "bold";
        } else if (kind === "header") {
          data.cell.styles.fillColor = [91, 44, 139];
          data.cell.styles.textColor = 255;
          data.cell.styles.fontStyle = "bold";
        } else if (kind === "link") {
          data.cell.styles.textColor = [5, 99, 193];
        }
      },
      didDrawCell: function (data) {
        if (data.section !== "body") return;
        const kindRow = tableKinds[data.row.index] || [];
        if (kindRow[data.column.index] !== "link") return;
        const aoaRow = start + 1 + data.row.index;
        const link = model.hyperlinks.find((h) => h.r === aoaRow && h.c === data.column.index);
        if (link) {
          doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: link.url });
        }
      },
      margin: { left: margin, right: margin },
    });

    doc.save(model.filenamePdf);
    return model;
  }

  function wantsComparisonExport(text) {
    const t = String(text || "");
    return (
      /\b(excel|xlsx|spreadsheet|pdf)\b/i.test(t) ||
      /\bexport\s+(this|it|that|to|as|in)\b/i.test(t) ||
      (/\bside[-\s]?by[-\s]?side\b/i.test(t) && /\b(excel|export|sheet|pdf)\b/i.test(t))
    );
  }

  function wantsExcelExport(text) {
    return wantsComparisonExport(text);
  }

  function conversationPlainText(messages, userMessageTextFn) {
    const toText =
      typeof userMessageTextFn === "function"
        ? userMessageTextFn
        : function (content) {
            if (typeof content === "string") return content;
            if (Array.isArray(content)) {
              return content
                .map((part) => (typeof part === "string" ? part : (part && part.text) || ""))
                .filter(Boolean)
                .join("\n");
            }
            return String(content || "");
          };
    return (messages || [])
      .filter((m) => m && m.role !== "offer" && m.role !== "workup")
      .map((m) => toText(m.content))
      .filter(Boolean)
      .join("\n");
  }

  return {
    FIELD_ROWS,
    HIGHLIGHT_KEYS,
    NETWORK_IN,
    NETWORK_OUT,
    NETWORK_NOT_CONFIRMED,
    NETWORK_NEED_MORE,
    formatBenefitValue,
    formatPlanMarketingName,
    formatPlanColumnHeader,
    displayContractPbp,
    safeExportPlanId,
    extractClientName,
    extractTerminatingPlan,
    extractDoctors,
    normalizeDoctors,
    extractDrugs,
    extractClaimedMeds,
    extractVerifiedLookups,
    parseFormularyLookupLine,
    normalizeDrugs,
    formatDrugCell,
    normalizeNetworkStatus,
    normalizeExportPayload,
    buildExportPayload,
    buildComparisonModel,
    comparisonExportFilename,
    exportComparisonToExcel,
    exportComparisonToPdf,
    wantsComparisonExport,
    wantsExcelExport,
    conversationPlainText,
    formatSobCell,
    formatEocCell,
  };
});
