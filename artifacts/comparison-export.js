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
  const SOB_EXTRA_AFTER = {
    inpatientHospital: [
      ["Skilled Nursing Facility (days 1–20)", "snfDays1to20"],
      ["Skilled Nursing Facility (days 21–100)", "snfDays21to100"],
    ],
    hearing: [["Hearing Aids", "hearingAids"]],
    advancedImaging: [["Hospital-grade bed / DME", "dmeHospitalBed"]],
  };

  function isDualOrDsnpPlan(plan) {
    if (!plan) return false;
    const dual = plan.dualLevel || {};
    if (dual.full || dual.partial) return true;
    const type = String(plan.type || "")
      .replace(/\s+/g, "")
      .toUpperCase();
    if (type === "DSNP" || type === "D-SNP" || type === "DUAL" || type.indexOf("DSNP") >= 0) {
      return true;
    }
    const blob = [plan.type, plan.planName, plan.carrier].join(" ");
    return /\bD[\s-]?SNP\b|\bDSNP\b|\bdual\b/i.test(blob);
  }

  function comparisonIncludesDual(plans) {
    return (plans || []).some(isDualOrDsnpPlan);
  }
  const NETWORK_IN = "In network";
  const NETWORK_OUT = "Out of network";
  const NETWORK_NOT_CONFIRMED = "Not confirmed";
  const NETWORK_NEED_MORE = "Need more info";
  const GENERIC_ONLY_NOTE = "*Brand not covered — these three plans cover the generic only.";
  // Names only — never invent a generic tier from this map.
  const BRAND_TO_GENERIC = {
    lipitor: "Atorvastatin",
    benicar: "Olmesartan",
    crestor: "Rosuvastatin",
    zocor: "Simvastatin",
    pravachol: "Pravastatin",
    nexium: "Esomeprazole",
    prilosec: "Omeprazole",
    protonix: "Pantoprazole",
    plavix: "Clopidogrel",
    norvasc: "Amlodipine",
    cozaar: "Losartan",
    diovan: "Valsartan",
  };
  const MUSKAT_PLAN_IDS = ["H1036-054C", "H4140-023", "H5420-014"];
  const CMS_PLAN_ID_RE = /\b[HR]\d{3,4}[\s-]?\d{2,4}[A-Z]?(?:\s*\/\s*-?\d{2,4})?\b/gi;
  const PREFERRED_COLUMN_IDS = ["H1036-054C", "H4140-023", "H5420-001", "H5420-014"];
  const DOCTORS_PBP_2027 = { "H4140-001": "H4140-022", "H4140-012": "H4140-023" };
  const CARRIER_AS_DRUG = /^(doctors?|uhc|united|unitedhealthcare|humana|careplus|care\s*plus|devoted|wellcare|well\s*care|aetna|simply|solis|healthsun|health\s*sun|healthspring|health\s*spring|medicaremax|medicare\s*max|preferred|cigna|anthem|elevance|floridablue|florida\s*blue|goldkidney|gold\s*kidney|gold\s*plus|drselect|drmax)$/i;

  const CLIENT_NAME_BLOCK = /^(miami|dade|broward|florida|medicare|humana|united|uhc|careplus|devoted|wellcare|aetna|simply|solis|healthsun|healthspring|doctors?|client|clients|export|excel|compare|comparison|plan|plans|dual|complete|preferred|summary|benefits|thei|max|pdf|sheet|name|household|both|network|zip|county|in|on|at|is|are|the|and|or|for|with|from|this|that)$/i;

  function escapeRe(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function safeExportPlanId(id) {
    return String(id || "")
      .replace(/\s+/g, "")
      .replace(/[\\/?%*:|"<>]/g, "-");
  }

  // Dedupe KEY only (never shown to the client). Collapses the known copy shapes of one
  // contract-PBP: H1036-054C-000-2027, H4140-023-000, H5420-001/0028. Anything else keeps its
  // THEI form (H5471-077-00, H5420-003 FL-0029) so distinct IDs never merge and never get mangled.
  const CONTRACT_PBP_COPY_RE = /^([HR]\d{3,4}-\d{2,4}[A-Z]?)(?:-000(?:-20\d{2})?|-20\d{2}|\/\d{2,4})?$/;
  // Same plan, two spellings in the catalog / threads.
  const CONTRACT_PBP_SAME_PLAN = { "H1036-054": "H1036-054C", "H4140-012": "H4140-023" };

  function compactContractPbp(raw) {
    const s = String(raw || "").toUpperCase().replace(/\s+/g, "");
    if (!s) return "";
    const m = s.match(CONTRACT_PBP_COPY_RE);
    const key = m ? m[1] : s.split("/")[0].replace(/-000$/i, "");
    return CONTRACT_PBP_SAME_PLAN[key] || key;
  }

  function displayContractPbp(plan) {
    let id = String((plan && (plan.planId || plan.id)) || "").replace(/\s+/g, "");
    id = id.replace(/-000-20\d{2}$/i, "").replace(/-000$/i, "").replace(/\/000$/i, "");
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

  function sobFieldValue(plan, sobBenefits, key) {
    const id = displayContractPbp(plan) || String((plan && (plan.planId || plan.id)) || "");
    const map = sobBenefits && typeof sobBenefits === "object" ? sobBenefits : {};
    const aliases = [id, plan && plan.planId, plan && plan.id].filter(Boolean);
    let hit = null;
    aliases.forEach((alias) => {
      if (hit) return;
      const row = map[alias] || map[String(alias).toUpperCase()];
      if (row && row[key]) hit = row[key];
    });
    if (hit && typeof hit === "object") return hit.value || null;
    if (typeof hit === "string") return hit;
    if (plan && plan[key]) return usableSobCell(plan[key]);
    return null;
  }

  function usableSobCell(raw) {
    if (raw == null) return null;
    const s = String(raw).replace(/\s+/g, " ").trim();
    if (!s || /^(not listed|n\/a|unverified|pending)$/i.test(s)) return null;
    return s;
  }

  function anySobField(plans, sobBenefits, key) {
    return (plans || []).some((p) => Boolean(sobFieldValue(p, sobBenefits, key)));
  }

  // Doctors DrSelect etc. store dental procedure rows as bare COUNTS of covered services
  // (Fillings 2, Root Canals 1, Extractions 4) with no unit. They are not dollars.
  const DENTAL_COUNT_KEYS = {
    dentalDeepCleaning: true,
    dentalDentures: true,
    dentalFillings: true,
    dentalRootCanals: true,
    dentalExtractions: true,
    dentalCrowns: true,
    dentalBridges: true,
    dentalImplants: true,
  };

  function formatBenefitValue(v, key) {
    if (isBlankish(v)) return "Not listed";
    if (DENTAL_COUNT_KEYS[key] && (typeof v === "number" || /^\d+$/.test(String(v).trim()))) {
      const n = Number(v);
      return n > 0 ? n + " covered" : "Not covered";
    }
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

  function looksLikeLabeledClientName(name) {
    const cleaned = String(name || "").replace(/[.,;:!?]+$/, "").replace(/\s+/g, " ").trim();
    if (!cleaned || /\d/.test(cleaned)) return "";
    const parts = cleaned.split(/\s+/);
    if (!parts.length || parts.length > 4) return "";
    if (parts.some((p) => CLIENT_NAME_BLOCK.test(p))) return "";
    if (parts.length === 1) {
      return /^[A-Za-z][A-Za-z'.-]{1,40}$/.test(parts[0]) && parts[0].length >= 2 ? cleaned : "";
    }
    return looksLikePersonName(cleaned) ? cleaned : "";
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
    // Labeled household / last name — colon or "is", including Client's / Clients.
    // e.g. Client: Muskat · Client name is Muskat · Clients name is Muskat · Household: Muskat
    const labeled = /\b(?:client(?:'s|s)?(?:[ \t]+name)?|household(?:[ \t]+name)?)\s*(?:[:=]|is)\s*([A-Za-z][A-Za-z'.-]{1,40}(?:[ \t]+[A-Za-z][A-Za-z'.-]{1,40}){0,3})/gi;
    let m;
    while ((m = labeled.exec(text))) {
      const candidate = looksLikeLabeledClientName(m[1]);
      if (candidate) found = candidate;
    }
    return found;
  }

  function looksLikeTerminatingPlanName(value) {
    const v = String(value || "").replace(/\s+/g, " ").trim();
    if (v.length < 3 || v.length > 80) return false;
    if (/^(row|rows|unless|never|do not|don't|omit)\b/i.test(v)) return false;
    if (/\b(msp(\s+levels?)?|not dual|no msp|unless she|do not|don't|never become|hmo,\s*not dual)\b/i.test(v)) return false;
    if (/\bis\s+hmo\b/i.test(v)) return false;
    if (/\b(plan\s+terminating|terminating\s+row)\b/i.test(v)) return false;
    return /[A-Za-z]/.test(v);
  }

  function isInstructionalTerminatingChunk(chunk) {
    const t = String(chunk || "").replace(/\s+/g, " ").trim();
    if (!t) return true;
    if (/\b(do\s+not|don't|never|omit|unless)\b/i.test(t) && /\b(plan\s+terminat|terminating\s+plan|current\s+plan)/i.test(t)) {
      return true;
    }
    if (/\b(msp(\s+levels?)?|not dual|no msp)\b/i.test(t) && !/\bplan\s+terminating\s*[:\-–]\s*[A-Za-z]/i.test(t)) {
      return true;
    }
    return false;
  }

  function hasExplicitTerminatingLanguage(text) {
    const chunks = String(text || "").split(/(?<=[.!?])\s+|\n+/);
    for (const chunk of chunks) {
      if (isInstructionalTerminatingChunk(chunk)) continue;
      const t = chunk.replace(/\s+/g, " ").trim();
      if (/\bcurrent\s+plan\s+(?:is\s+)?(?:terminat|ending)\b/i.test(t)) return true;
      if (/\b(?:her|his|their)\s+(?:current\s+)?plan\s+is\s+(?:terminat|ending)\b/i.test(t)) return true;
      if (/(?:^|[^\w])plan\s+terminating\s*[:\-–]\s*\S/i.test(t)) return true;
      if (/\bterminating\s+plan\s*(?:is\s*)?[:\-–]\s*\S/i.test(t)) return true;
    }
    return false;
  }

  function sanitizeTerminatingPlan(value, text) {
    const v = String(value || "").replace(/\s+/g, " ").trim();
    if (!v || !looksLikeTerminatingPlanName(v)) return "";
    if (text && !hasExplicitTerminatingLanguage(text)) return "";
    return v;
  }

  function extractTerminatingPlan(text) {
    if (!hasExplicitTerminatingLanguage(text)) return "";
    const patterns = [
      /(?:plan\s+)?terminat(?:ing|es|ed|ion)\s*(?:plan)?\s*[:\-–]\s*([^\n]{3,90})/i,
      /terminating\s+plan\s+(?:is\s+)?([A-Z][^\n]{2,90})/i,
    ];
    for (const re of patterns) {
      const m = String(text || "").match(re);
      if (!m) continue;
      let value = String(m[1] || "").replace(/\s+/g, " ").trim();
      value = value.replace(/\s*[.]$/, "");
      value = value.replace(/\s+(and|for|in|on|with|who|which)\s+$/i, "").trim();
      const clean = sanitizeTerminatingPlan(value, text);
      if (clean) return clean;
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
      const display = /^dr\.?\s/i.test(name) ? name.replace(/^dr\.?\s+/i, "Dr. ") : "Dr. " + name;
      const key = doctorIdentityKey(display) || display.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(display);
    };
    const addClinic = (raw) => {
      let name = String(raw || "").replace(/\s+/g, " ").trim();
      name = name.replace(/[.,;:]+$/, "");
      if (!name || name.split(/\s+/).length < 2) return;
      const key = doctorIdentityKey(name) || name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      names.push(name);
    };
    const drRe = /\b(?:Dr\.?|Doctor)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/g;
    const mdRe = /\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,2}),?\s+M\.?D\.?\b/g;
    const clinicRe =
      /\b(Miami Neurology(?:\s*(?:&|and)\s+Rehab(?:ilitation)?)?(?:\s*(?:&|and)?\s*Specialists)?|MNRS(?:\s+Physical\s+Therapy)?)\b/gi;
    let m;
    while ((m = drRe.exec(text))) add(m[1]);
    while ((m = mdRe.exec(text))) add(m[1]);
    while ((m = clinicRe.exec(text))) addClinic(m[1]);
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
    const re =
      /need\s*more\s*info|not\s*confirmed|failed\s*check|out(?:\s+of)?[-\s]?network|in[-\s]?network|\bOON\b|\bINN\b|✅|❌/gi;
    let t;
    while ((t = re.exec(window))) {
      const raw = t[0];
      if (/need\s*more\s*info|failed\s*check/i.test(raw)) tokens.push(NETWORK_NEED_MORE);
      else if (/not\s*confirmed/i.test(raw)) tokens.push(NETWORK_NOT_CONFIRMED);
      else tokens.push(/out|oon|❌/i.test(raw) ? NETWORK_OUT : NETWORK_IN);
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
      doctors.push({
        name,
        statuses: statuses.map((s) => s || NETWORK_NOT_CONFIRMED),
      });
    }
    return doctors;
  }

  const DRUG_NAME_BLOCK = /^(the|and|for|with|from|plan|gold|plus|giveback|premium|deductible|hospital|client|miami|dade|broward|humana|tier|medicare|complete|dual|select|choice|preferred|summary|benefits|thei|max|otc|grocery|vision|dental|doctors?|network|uhc|united|careplus|devoted|aetna|simply|solis|wellcare)$/i;

  function isCarrierAsDrugName(name) {
    const s = String(name || "").replace(/\s+/g, " ").trim();
    if (!s) return true;
    if (CARRIER_AS_DRUG.test(s)) return true;
    if (
      /^(doctors(\s+healthcare(\s+plans?)?)?|humana(\s+gold(\s+plus)?)?(\s+giveback)?|uhc(\s+medicaremax)?|united(\s+health(\s*care)?)?|medicare\s*max|care\s*plus|florida\s*blue|health\s*sun|health\s*spring|gold\s*plus|dr\.?\s*(max|select|plus|flex|extra)([- ]sfl)?)$/i.test(
        s
      )
    ) {
      return true;
    }
    const parts = s.split(/\s+/);
    return parts.length > 0 && parts.every((p) => CARRIER_AS_DRUG.test(p) || DRUG_NAME_BLOCK.test(p));
  }

  function looksLikeDrugName(name) {
    const s = String(name || "").replace(/\s+/g, " ").trim();
    if (s.length < 3 || s.length > 48) return false;
    if (/\d{5,}/.test(s)) return false;
    if (isCarrierAsDrugName(s)) return false;
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

  function drugNameKey(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function knownGenericFor(drugName) {
    const key = drugNameKey(drugName);
    if (!key) return null;
    if (BRAND_TO_GENERIC[key]) return BRAND_TO_GENERIC[key];
    const stripped = key.replace(/generic$/, "");
    return BRAND_TO_GENERIC[stripped] || null;
  }

  function brandHasNotCovered(drug) {
    if (!drug) return false;
    if (drug.brandNotCovered) return true;
    const map = drug.byPlanId || {};
    return Object.keys(map).some((id) => {
      const row = map[id];
      return row && row.verified && row.coverage === "not_covered";
    });
  }

  function isGenericRowFor(drug, brandName, genericName) {
    if (!drug) return false;
    const k = drugNameKey(drug.name);
    const gKey = drugNameKey(genericName);
    const bKey = drugNameKey(String(brandName || "").replace(/\*+$/, ""));
    return (
      k === gKey ||
      k === gKey + "generic" ||
      (drug.genericOf && drugNameKey(drug.genericOf) === bKey)
    );
  }

  function applyKnownGenericSuggestions(drugs, plans) {
    if (!Array.isArray(drugs) || !drugs.length) return drugs || [];
    const out = [];
    drugs.forEach((d) => {
      const generic = knownGenericFor(d && d.name);
      if (generic && brandHasNotCovered(d)) {
        d.brandNotCovered = true;
        if (!/\*$/.test(String(d.name || ""))) {
          d.name = String(d.name).replace(/\*+$/, "") + "*";
        }
      }
      out.push(d);
      if (!generic || !brandHasNotCovered(d)) return;
      const existing = drugs.find((x) => x !== d && isGenericRowFor(x, d.name, generic)) ||
        out.find((x) => x !== d && isGenericRowFor(x, d.name, generic));
      if (existing) {
        existing.genericOf = existing.genericOf || String(d.name || "").replace(/\*+$/, "");
        if (!/\(generic\)/i.test(existing.name || "")) {
          existing.name = generic + " (generic)";
        }
        return;
      }
      out.push({
        name: generic + " (generic)",
        genericOf: String(d.name || "").replace(/\*+$/, ""),
        byPlanId: emptyPlanDrugStatuses(plans),
      });
    });
    return out;
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
    const want = String(planId || "").replace(/\s+/g, "").toUpperCase().split("/")[0];
    // Exact contract-PBP column wins. Only fall back to alias/slot matching when the looked-up
    // ID is not itself a column (e.g. a 014 lookup must never fill a separate 001 column).
    const wantKey = compactContractPbp(planId);
    const exact = (plans || []).find((p) => planColumnId(p) === wantKey);
    const match =
      exact ||
      (plans || []).find((p) => {
        const aliases = planIdAliases(p).map((id) => String(id || "").replace(/\s+/g, "").toUpperCase().split("/")[0]);
        if (aliases.includes(want)) return true;
        return planColumnSlot(want) === planColumnSlot(planColumnId(p)) && planColumnSlot(want) !== want;
      });
    const key = match ? displayContractPbp(match) || String(match.planId || match.id || "") : planId;
    if (!key) return;
    const prev = target[key] || { verified: false, tier: null };
    const incomingLive = incoming.verified && incoming.source && incoming.source !== "yahoska_verified_2027";
    const prevLock = prev.verified && prev.source === "yahoska_verified_2027";
    if (incoming.verified && (!prev.verified || (prevLock && incomingLive))) {
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
    return applyKnownGenericSuggestions([...byName.values()], plans);
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
      if (d.brandNotCovered) row.brandNotCovered = true;
      if (d.genericOf) row.genericOf = d.genericOf;
      const map = d.byPlanId || d.statusByPlanId || {};
      Object.keys(map).forEach((planId) => {
        const incoming = map[planId] || {};
        mergeDrugPlanStatus(row.byPlanId, planId, incoming, plans);
      });
      if (Array.isArray(d.lookups)) {
        d.lookups.forEach((hit) => mergeDrugPlanStatus(row.byPlanId, hit.planId, hit, plans));
      }
    });
    return applyKnownGenericSuggestions([...byName.values()], plans);
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

  function planIdAliases(plan) {
    const id = displayContractPbp(plan);
    const raw = String((plan && (plan.planId || plan.id)) || "");
    const compact = compactContractPbp(raw || id);
    const aliases = [id, raw, compact, String((plan && plan.id) || "")].filter(Boolean);
    const base = String(id || compact || "").split("/")[0];
    if (base) aliases.push(base);
    if (base === "H4140-023" || compact === "H4140-023") aliases.push("H4140-012");
    if (base === "H4140-012" || compact === "H4140-012") aliases.push("H4140-023");
    if (base === "H5420-001" || compact === "H5420-001") aliases.push("H5420-014", "H5420-001/0028");
    if (base === "H5420-014" || compact === "H5420-014") aliases.push("H5420-001", "H5420-001/0028");
    if (base === "H1036-054C" || compact === "H1036-054C") aliases.push("H1036-054");
    if (base === "H1036-054" || compact === "H1036-054") aliases.push("H1036-054C");
    return [...new Set(aliases)];
  }

  function planStatusKey(plan) {
    return compactContractPbp(plan && (plan.planId || plan.id)) || displayContractPbp(plan);
  }

  function lookupPlanStatus(map, plan) {
    if (!map || !plan) return "";
    for (const key of planIdAliases(plan)) {
      if (map[key] != null && map[key] !== "") return map[key];
      const compact = compactContractPbp(key);
      if (compact && map[compact] != null && map[compact] !== "") return map[compact];
    }
    return "";
  }

  function byPlanIdFromStatuses(statuses, plans) {
    const map = {};
    (plans || []).forEach((p, i) => {
      const key = planStatusKey(p);
      const s = normalizeNetworkStatus(statuses && statuses[i]);
      if (key && s) map[key] = s;
    });
    return map;
  }

  function mergeByPlanIdMaps(target, incoming) {
    const out = Object.assign({}, target || {});
    Object.keys(incoming || {}).forEach((id) => {
      const key = compactContractPbp(id) || id;
      const next = normalizeNetworkStatus(incoming[id]);
      if (!next) return;
      out[key] = mergeStatusPair(normalizeNetworkStatus(out[key]) || out[key], next);
    });
    return out;
  }

  function normalizeDoctors(doctors, plans) {
    if (!Array.isArray(doctors) || !doctors.length || !plans || !plans.length) return [];
    const out = [];
    const seen = new Set();
    for (const d of doctors) {
      if (!d) continue;
      const name = String(typeof d === "string" ? d : d.name || d.doctor || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let map = {};
      if (typeof d !== "string") {
        map = mergeByPlanIdMaps(map, d.byPlanId || d.statusByPlanId || {});
        if (Array.isArray(d.statuses)) {
          map = mergeByPlanIdMaps(map, byPlanIdFromStatuses(d.statuses, plans));
        }
      }
      const statuses = plans.map((p) => {
        const fromMap = normalizeNetworkStatus(lookupPlanStatus(map, p));
        if (fromMap === NETWORK_IN || fromMap === NETWORK_OUT) return fromMap;
        const fromNet = typeof d !== "string" && d.networks ? statusFromProviderNetworks(p, d.networks) : "";
        const merged = mergeStatusPair(fromMap, fromNet);
        return merged || NETWORK_NOT_CONFIRMED;
      });
      out.push({
        name,
        statuses,
        byPlanId: mergeByPlanIdMaps(map, byPlanIdFromStatuses(statuses, plans)),
      });
    }
    return out;
  }

  function carrierMatchesPlan(carrierLabel, plan) {
    const c = String(carrierLabel || "").toLowerCase();
    const hay = [plan && plan.carrier, plan && plan.planName, displayContractPbp(plan)].join(" ").toLowerCase();
    if (/humana/.test(c)) return /humana/.test(hay);
    if (/uhc|united|medicaremax|preferred/.test(c)) return /uhc|united|medicaremax|preferred/.test(hay);
    if (/doctors/.test(c)) return /doctors/.test(hay);
    if (/aetna/.test(c)) return /aetna/.test(hay);
    if (/simply/.test(c)) return /simply/.test(hay);
    if (/devoted/.test(c)) return /devoted/.test(hay);
    if (/healthsun/.test(c)) return /healthsun/.test(hay);
    if (/solis/.test(c)) return /solis/.test(hay);
    return false;
  }

  function blobHasPlanId(blob, plan) {
    const hay = String(blob || "").toUpperCase().replace(/\s+/g, "");
    if (!hay) return false;
    return planIdAliases(plan).some((id) => {
      const raw = String(id || "").toUpperCase().replace(/\s+/g, "");
      if (raw && hay.includes(raw)) return true;
      const compact = compactContractPbp(id);
      return Boolean(compact && hay.includes(compact));
    });
  }

  function statusFromProviderNetworks(plan, networks) {
    let fallback = "";
    for (const net of networks || []) {
      if (!net) continue;
      const inBlob = (net.plans || []).join(" ");
      const outBlob = (net.outOfNetworkPlans || []).join(" ");
      if (blobHasPlanId(inBlob, plan)) return NETWORK_IN;
      if (blobHasPlanId(outBlob, plan)) return NETWORK_OUT;
      if (!carrierMatchesPlan(net.carrier, plan)) continue;
      if (net.status === "failed") {
        fallback = fallback || NETWORK_NEED_MORE;
        continue;
      }
      // Carrier-level hit only when this lookup did not name PBPs (Doctors HCP).
      if (net.inNetwork === true && !(net.plans && net.plans.length)) return NETWORK_IN;
      if (net.inNetwork === false && net.status !== "failed" && /doctors/i.test(net.carrier || "")) {
        return NETWORK_OUT;
      }
      if (net.inNetwork === true) fallback = fallback || NETWORK_IN;
      // Miss / empty session / other PBPs only — not an explicit OON. Leave
      // unknown so a verified In network on this plan id is not overwritten.
    }
    return fallback;
  }

  function doctorsFromProviderLookups(lookups, plans) {
    if (!Array.isArray(lookups) || !lookups.length || !plans || !plans.length) return [];
    const out = [];
    lookups.forEach((raw) => {
      const src = raw && raw.output ? raw.output : raw;
      if (!src || typeof src !== "object") return;
      const providers = Array.isArray(src.providers)
        ? src.providers
        : src.doctorName || src.name
          ? [src]
          : [];
      providers.forEach((pr) => {
        const name = String(pr.doctorName || pr.name || "").trim();
        if (!name) return;
        const networks = pr.networks || src.networks || [];
        const statuses = plans.map((p) => statusFromProviderNetworks(p, networks) || NETWORK_NOT_CONFIRMED);
        out.push({
          name: /^dr\.?\s/i.test(name) || /clinic|neurology|rehab|mnrs/i.test(name) ? name : "Dr. " + name,
          statuses,
          byPlanId: byPlanIdFromStatuses(statuses, plans),
          networks,
        });
      });
    });
    return normalizeDoctors(out, plans);
  }

  function personNameParts(name) {
    let s = String(name || "")
      .replace(/^(dr\.?|doctor)\s+/i, "")
      .replace(/,?\s*(m\.?d\.?|d\.?o\.?|ph\.?d\.?)\.?$/i, "")
      .replace(/\bnpi[:\s]*\d+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!s) return { first: "", last: "" };
    if (s.includes(",")) {
      const bits = s.split(",");
      const last = (bits[0] || "").toLowerCase().replace(/[^a-z]/g, "");
      const first = (bits[1] || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
      return { first, last };
    }
    const parts = s.split(/\s+/).filter(Boolean);
    const last = (parts[parts.length - 1] || "").toLowerCase().replace(/[^a-z]/g, "");
    const first = (parts[0] || "").toLowerCase().replace(/[^a-z]/g, "");
    return { first, last };
  }

  function doctorIdentityKey(name) {
    const raw = String(name || "");
    const clinic = raw.toLowerCase();
    if (/miami\s+neurology|neurology.*rehab|mnrs/.test(clinic)) return "clinic:miami-neurology-rehab";
    const { first, last } = personNameParts(raw);
    if (!last || last.length < 3) return "";
    return "person:" + last + (first ? ":" + first[0] : "");
  }

  function preferredDoctorName(a, b) {
    const score = (n) => {
      const s = String(n || "");
      let pts = 0;
      if (/^Dr\.\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test(s)) pts += 6;
      if (/^Dr\.\s+[A-Z][a-z]/.test(s)) pts += 3;
      if (/[a-z]/.test(s)) pts += 2;
      if (/,/.test(s) && !/[a-z]/.test(s)) pts -= 4;
      if (/neurology|rehab/i.test(s) && s.length < 48) pts += 2;
      if (s.length > 48) pts -= 2;
      return pts;
    };
    return score(a) >= score(b) ? a : b;
  }

  function mergeStatusPair(prev, incoming) {
    if (prev === NETWORK_IN || prev === NETWORK_OUT) return prev;
    if (incoming === NETWORK_IN || incoming === NETWORK_OUT) return incoming;
    if (prev === NETWORK_NEED_MORE || incoming === NETWORK_NEED_MORE) {
      return prev === NETWORK_NEED_MORE ? prev : incoming;
    }
    return prev || incoming;
  }

  function mergeDoctorLists(lists, plans) {
    const byKey = new Map();
    (lists || []).forEach((list) => {
      normalizeDoctors(list, plans).forEach((doc) => {
        const key = doctorIdentityKey(doc.name) || doc.name.toLowerCase();
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, doc);
          return;
        }
        prev.name = preferredDoctorName(prev.name, doc.name);
        prev.byPlanId = mergeByPlanIdMaps(prev.byPlanId, doc.byPlanId);
        prev.statuses = plans.map((p, i) => {
          const fromMap = normalizeNetworkStatus(lookupPlanStatus(prev.byPlanId, p));
          return mergeStatusPair(mergeStatusPair(prev.statuses[i], doc.statuses[i]), fromMap) || NETWORK_NOT_CONFIRMED;
        });
        prev.byPlanId = mergeByPlanIdMaps(prev.byPlanId, byPlanIdFromStatuses(prev.statuses, plans));
      });
    });
    return [...byKey.values()];
  }

  // Doctor `statuses` arrays are positional (one per plan column). When copies of the same
  // contract-PBP collapse, fold each group's statuses into the surviving column so In/Out
  // stays on the right plan instead of shifting left.
  function realignDoctorStatuses(doctors, originalPlans, keptPlans) {
    if (!Array.isArray(doctors) || !doctors.length) return doctors;
    const orig = originalPlans || [];
    const kept = keptPlans || [];
    if (orig.length === kept.length) return doctors;
    const groupIdx = kept.map((k) => {
      const key = planColumnId(k);
      return orig.map((p, i) => (planColumnId(p) === key ? i : -1)).filter((i) => i >= 0);
    });
    return doctors.map((d) => {
      if (!d || typeof d === "string") return d;
      const hasPositional = Array.isArray(d.statuses) && d.statuses.length === orig.length;
      const statuses = hasPositional
        ? groupIdx.map((idxs) =>
            idxs.reduce((acc, i) => mergeStatusPair(acc, normalizeNetworkStatus(d.statuses[i]) || d.statuses[i]), "") || ""
          )
        : d.statuses;
      return Object.assign({}, d, {
        statuses,
        byPlanId: d.byPlanId || d.statusByPlanId || {},
      });
    });
  }

  function normalizeExportPayload(plansOrPayload, meta) {
    const extra = meta && typeof meta === "object" ? meta : {};
    const uniq = (list) => uniquePlansByContractPbp(list);
    if (Array.isArray(plansOrPayload)) {
      return { plans: uniq(plansOrPayload), ...extra };
    }
    if (plansOrPayload && typeof plansOrPayload === "object") {
      const plans = Array.isArray(plansOrPayload.plans) ? plansOrPayload.plans : [];
      const kept = uniq(plans);
      const aligned = realignDoctorStatuses(plansOrPayload.doctors, plans, kept);
      const out = {
        ...plansOrPayload,
        plans: kept,
        doctors: normalizeDoctors(aligned, kept),
        ...extra,
      };
      out.terminatingPlan = sanitizeTerminatingPlan(out.terminatingPlan, out.threadText || extra.threadText);
      if (isMuskatContext(out.threadText, out) && !out.skipMuskatLock) {
        applyMuskatLockedFacts(out);
        out.terminatingPlan = sanitizeTerminatingPlan(out.terminatingPlan, out.threadText);
      }
      return out;
    }
    return { plans: [], ...extra };
  }

  function isMuskatContext(text, extras) {
    const t = [text, extras && extras.clientName, extras && extras.lockedClient].filter(Boolean).join(" ");
    return /\bmuskat\b/i.test(t);
  }

  function pickCatalogPlan(catalog, id, county) {
    const list = Array.isArray(catalog) ? catalog : [];
    const want = String(id || "").toUpperCase().replace(/\s+/g, "").split("/")[0];
    const match = (p) => {
      const pid = String(p.planId || "").toUpperCase().replace(/\s+/g, "").split("/")[0];
      const raw = String(p.id || "").toUpperCase().replace(/\s+/g, "").split("/")[0];
      return pid === want || raw === want;
    };
    if (county) {
      const hit = list.find((p) => match(p) && p.county === county);
      if (hit) return hit;
    }
    return list.find(match) || null;
  }

  function canonicalize2027ComparisonPlans(plans, text, catalog) {
    const t = String(text || "");
    const county = /\bbroward\b/i.test(t) && !/miami/i.test(t) ? "Broward" : "Miami-Dade";
    const muskat = isMuskatContext(t);
    const coreHumana = muskat || /\bcore\s+humana\b/i.test(t);
    const wantsGiveback = /\bgive\s*back\b/i.test(t) && !muskat && !coreHumana;
    let out = (plans || []).map((p) => {
      const id = displayContractPbp(p);
      const mapped = DOCTORS_PBP_2027[id];
      if (mapped) {
        return pickCatalogPlan(catalog, mapped, p.county || county) || Object.assign({}, p, {
          planId: mapped,
          id: mapped,
          planName: mapped === "H4140-023" ? "Doctors DrSelect-SFL" : p.planName,
        });
      }
      if (coreHumana && id === "H1036-305" && !wantsGiveback) {
        return pickCatalogPlan(catalog, "H1036-054C", p.county || county) || p;
      }
      const base = String(id || "").split("/")[0];
      if (base && base !== id) {
        return pickCatalogPlan(catalog, base, p.county || county) || Object.assign({}, p, { planId: base, id: base });
      }
      return p;
    });
    return out;
  }

  function currentPlansMatchMuskatLock(plans) {
    const have = (plans || []).map((p) => String(displayContractPbp(p) || "").toUpperCase());
    if (have.length !== MUSKAT_PLAN_IDS.length) return false;
    return MUSKAT_PLAN_IDS.every((id) => have.includes(id));
  }

  function muskatComparisonUhcId(plans) {
    const have = [
      ...new Set((plans || []).map((p) => compactContractPbp(p && (p.planId || p.id))).filter(Boolean)),
    ];
    const humana = have.includes("H1036-054C") || have.includes("H1036-054");
    const doctors = have.includes("H4140-023") || have.includes("H4140-012");
    if (!humana || !doctors) return "";
    if (have.includes("H5420-001")) return "H5420-001";
    if (have.includes("H5420-014")) return "H5420-014";
    return "";
  }

  function remapLockedDrugPlanIds(drugs, uhcId) {
    const dest = String(uhcId || "H5420-014").toUpperCase();
    return (drugs || []).map((d) => {
      const map = Object.assign({}, d.byPlanId || {});
      if (dest !== "H5420-014" && map["H5420-014"] && !map[dest]) {
        map[dest] = map["H5420-014"];
      }
      return Object.assign({}, d, { byPlanId: map });
    });
  }

  function sameExportPlanSet(a, b) {
    const ids = (list) =>
      dedupeComparisonPlans(list)
        .map((p) => String(displayContractPbp(p) || p.planId || p.id || "").toUpperCase().replace(/\s+/g, "").split("/")[0])
        .filter(Boolean)
        .sort()
        .join("|");
    const left = ids(a);
    return Boolean(left) && left === ids(b);
  }

  function planColumnId(plan) {
    return compactContractPbp(plan && (plan.planId || plan.id));
  }

  function planColumnSlot(id) {
    const s = String(id || "").toUpperCase();
    if (s === "H5420-001" || s === "H5420-014") return "H5420-UHC";
    if (s === "H4140-023" || s === "H4140-012") return "H4140-DOCTORS";
    if (s === "H1036-054C" || s === "H1036-054") return "H1036-HUMANA";
    return s;
  }

  function citedPlanIdsFromText(text) {
    const re = new RegExp(CMS_PLAN_ID_RE.source, "gi");
    return [
      ...new Set(
        (String(text || "").match(re) || []).map((s) => s.replace(/\s+/g, "").toUpperCase().split("/")[0])
      ),
    ];
  }

  function preferPlanForSlot(a, b) {
    const raw = (p) => String((p && (p.planId || p.id)) || "");
    const slashy = (p) => /[\/]/.test(raw(p));
    if (slashy(a) !== slashy(b)) return slashy(a) ? b : a;
    const ia = planColumnId(a);
    const ib = planColumnId(b);
    const rank = (id) => {
      const i = PREFERRED_COLUMN_IDS.indexOf(id);
      return i === -1 ? 50 : i;
    };
    if (rank(ia) !== rank(ib)) return rank(ia) < rank(ib) ? a : b;
    if (a && a.county === "Miami-Dade" && b && b.county !== "Miami-Dade") return a;
    if (b && b.county === "Miami-Dade" && a && a.county !== "Miami-Dade") return b;
    return a || b;
  }

  // One column per distinct contract-PBP. Only a second copy of the SAME ID is dropped;
  // different plans (even same carrier family, e.g. H5420-001 vs H5420-014) all stay.
  function uniquePlansByContractPbp(plans) {
    const byPbp = new Map();
    (plans || []).forEach((p) => {
      const id = planColumnId(p);
      if (!id) return;
      const prev = byPbp.get(id);
      byPbp.set(id, prev ? preferPlanForSlot(prev, p) : p);
    });
    return orderComparisonPlans([...byPbp.values()]);
  }

  function dedupeComparisonPlans(plans) {
    return uniquePlansByContractPbp(plans);
  }

  function orderComparisonPlans(plans) {
    const list = (plans || []).slice();
    const rank = (p) => {
      const id = planColumnId(p);
      const i = PREFERRED_COLUMN_IDS.indexOf(id);
      return i === -1 ? 100 : i;
    };
    list.sort((a, b) => rank(a) - rank(b));
    return list;
  }

  function keepCurrentComparisonPlans(latest, prior) {
    const current = uniquePlansByContractPbp(latest);
    const remembered = uniquePlansByContractPbp(prior);
    if (!remembered.length) return current;
    if (!current.length) return remembered;
    const slotOf = (p) => planColumnSlot(planColumnId(p));
    const currentSlots = new Set(current.map(slotOf));
    const priorSlots = new Set(remembered.map(slotOf));
    const currentIsSubset = [...currentSlots].every((s) => priorSlots.has(s));
    const overlap = [...currentSlots].filter((s) => priorSlots.has(s)).length;
    const useMemory =
      (currentIsSubset && remembered.length > current.length) ||
      (overlap >= 1 && (currentIsSubset || overlap >= 2));
    if (!useMemory) return current;
    // Carry remembered columns forward, except one superseded by a DIFFERENT plan of the same
    // family that the current thread cites (stale 014 -> stay-put 001). A remembered plan the
    // current thread also cites is kept (current copy preferred), so 001 + 014 together survive.
    const currentById = new Map(current.map((c) => [planColumnId(c), c]));
    const merged = [];
    remembered.forEach((p) => {
      const same = currentById.get(planColumnId(p));
      if (same) {
        merged.push(preferPlanForSlot(p, same));
        return;
      }
      if (currentSlots.has(slotOf(p))) return;
      merged.push(p);
    });
    const have = new Set(merged.map(planColumnId));
    current.forEach((c) => {
      if (!have.has(planColumnId(c))) merged.push(c);
    });
    return uniquePlansByContractPbp(merged);
  }

  function verifiedCell(tier, costShare, coverage) {
    if (coverage === "not_covered") {
      return { verified: true, tier: null, coverage: "not_covered", costShare: null, source: "yahoska_verified_2027" };
    }
    return {
      verified: true,
      tier: tier,
      coverage: "covered",
      costShare: costShare,
      source: "yahoska_verified_2027",
    };
  }

  function muskatLockedDrugs() {
    const nc = {
      "H1036-054C": verifiedCell(null, null, "not_covered"),
      "H4140-023": verifiedCell(null, null, "not_covered"),
      "H5420-014": verifiedCell(null, null, "not_covered"),
    };
    const t1 = {
      "H1036-054C": verifiedCell(1, "$0"),
      "H4140-023": verifiedCell(1, "$0"),
      "H5420-014": verifiedCell(1, "$0"),
    };
    return [
      { name: "Lipitor*", brandNotCovered: true, byPlanId: nc },
      { name: "Atorvastatin (generic)", genericOf: "Lipitor", byPlanId: t1 },
      { name: "Benicar*", brandNotCovered: true, byPlanId: nc },
      { name: "Olmesartan (generic)", genericOf: "Benicar", byPlanId: t1 },
      {
        name: "Lorazepam",
        byPlanId: {
          "H1036-054C": verifiedCell(4, "40%"),
          "H4140-023": verifiedCell(1, "$0"),
          "H5420-014": verifiedCell(2, "$0"),
        },
      },
      {
        name: "Gabapentin",
        byPlanId: {
          "H1036-054C": verifiedCell(2, "$0"),
          "H4140-023": verifiedCell(1, "$0"),
          "H5420-014": verifiedCell(2, "$0"),
        },
      },
      {
        name: "Trintellix",
        byPlanId: {
          "H1036-054C": verifiedCell(4, "40%"),
          "H4140-023": verifiedCell(4, "$55"),
          "H5420-014": verifiedCell(3, "$0"),
        },
      },
      {
        name: "Memantine",
        byPlanId: {
          "H1036-054C": verifiedCell(2, "$0"),
          "H4140-023": verifiedCell(2, "$0"),
          "H5420-014": verifiedCell(2, "$0"),
        },
      },
    ];
  }

  function muskatLockedDoctors() {
    const uhc = { "H5420-001": NETWORK_IN, "H5420-014": NETWORK_IN };
    return [
      { name: "Dr. Alejandro Roca", byPlanId: { "H1036-054C": NETWORK_OUT, "H4140-023": NETWORK_IN, ...uhc } },
      { name: "Dr. Charles J. Kaiser", byPlanId: { "H1036-054C": NETWORK_OUT, "H4140-023": NETWORK_IN, ...uhc } },
      { name: "Dr. William Trattler", byPlanId: { "H1036-054C": NETWORK_OUT, "H4140-023": NETWORK_IN, ...uhc } },
      { name: "Dr. Neeta Jane Erinjeri", byPlanId: { "H1036-054C": NETWORK_IN, "H4140-023": NETWORK_IN, ...uhc } },
    ];
  }

  function applyMuskatLockedFacts(payload, catalog) {
    const uhcId = muskatComparisonUhcId(payload.plans);
    if (!uhcId) {
      return payload;
    }
    payload.clientName = payload.clientName && /muskat/i.test(payload.clientName)
      ? payload.clientName
      : "Michael Muskat";
    payload.zip = payload.zip || "33176";
    payload.county = payload.county || "Miami-Dade";
    payload.doctors = mergeDoctorLists([muskatLockedDoctors(), payload.doctors], payload.plans);
    const live = normalizeDrugs(payload.drugs, payload.plans);
    let lockedSrc = muskatLockedDrugs();
    if (uhcId === "H5420-001") {
      lockedSrc = lockedSrc.filter((d) => /lipitor|atorvastatin|benicar|olmesartan/i.test(String(d.name || "")));
    }
    const lockedDrugs = normalizeDrugs(remapLockedDrugPlanIds(lockedSrc, uhcId), payload.plans);
    if (!live.length) {
      payload.drugs = lockedDrugs;
    } else {
      lockedDrugs.forEach((d) => {
        const hit = live.find((x) => {
          const a = String(x.name || "").toLowerCase().replace(/\*+$/, "");
          const b = String(d.name || "").toLowerCase().replace(/\*+$/, "");
          return a === b || (x.genericOf && d.genericOf && String(x.genericOf).toLowerCase() === String(d.genericOf).toLowerCase());
        });
        if (!hit) {
          live.push(d);
          return;
        }
        Object.keys(d.byPlanId || {}).forEach((id) => {
          mergeDrugPlanStatus(hit.byPlanId, id, d.byPlanId[id], payload.plans);
        });
        if (d.brandNotCovered) hit.brandNotCovered = true;
        if (d.genericOf) hit.genericOf = hit.genericOf || d.genericOf;
      });
      payload.drugs = applyKnownGenericSuggestions(live, payload.plans);
    }
    payload.genericOnlyNote = GENERIC_ONLY_NOTE;
    payload.terminatingPlan = sanitizeTerminatingPlan(payload.terminatingPlan, payload.threadText);
    return payload;
  }

  function buildExportPayload(plans, threadText, extras) {
    const extra = extras && typeof extras === "object" ? extras : {};
    const text = String(threadText || extra.threadText || "");
    const catalog = extra.catalog || extra.planCatalog || [];
    const county = /\bbroward\b/i.test(text) && !/miami/i.test(text) ? "Broward" : "Miami-Dade";
    const fromText = citedPlanIdsFromText(text)
      .map((id) => pickCatalogPlan(catalog.length ? catalog : plans, id, county) || pickCatalogPlan(catalog.length ? catalog : plans, id))
      .filter(Boolean);
    const resolvedPlans = uniquePlansByContractPbp(
      keepCurrentComparisonPlans(
        canonicalize2027ComparisonPlans(plans || [], text, catalog.length ? catalog : plans),
        canonicalize2027ComparisonPlans(
          [].concat(fromText, extra.rememberedPlans || extra.priorPlans || []),
          text,
          catalog.length ? catalog : plans
        )
      )
    );
    const clientName = extra.clientName || extractClientName(text);
    const terminatingPlan = extra.explicitTerminating
      ? sanitizeTerminatingPlan(extra.terminatingPlan || extractTerminatingPlan(text), text)
      : extractTerminatingPlan(text);
    const fromLookups = doctorsFromProviderLookups(
      extra.providerLookups || extra.toolResults || extra.doctorsFromTools || [],
      resolvedPlans
    );
    const doctors = mergeDoctorLists(
      [extra.doctors, fromLookups, extractDoctors(text, resolvedPlans)],
      resolvedPlans
    );
    const fromExtras = normalizeDrugs(extra.drugs, resolvedPlans);
    const fromThread = extractDrugs(text, resolvedPlans);
    let drugs = fromExtras.length ? fromExtras : fromThread;
    if (fromExtras.length && fromThread.length) {
      fromThread.forEach((t) => {
        const hit = drugs.find((d) => d.name.toLowerCase() === t.name.toLowerCase());
        if (!hit) drugs.push(t);
        else {
          Object.keys(t.byPlanId || {}).forEach((id) => {
            mergeDrugPlanStatus(hit.byPlanId, id, t.byPlanId[id], resolvedPlans);
          });
        }
      });
    }
    drugs = applyKnownGenericSuggestions(drugs, resolvedPlans);
    const payload = {
      plans: resolvedPlans,
      clientName: clientName || "",
      terminatingPlan: terminatingPlan || "",
      doctors,
      drugs,
      zip: extra.zip || "",
      county: extra.county || "",
      threadText: text,
      sobBenefits: extra.sobBenefits || extra.sobExtras || {},
    };
    if (drugs.some((d) => d.brandNotCovered || /\*$/.test(d.name || "") || d.genericOf)) {
      payload.genericOnlyNote = GENERIC_ONLY_NOTE;
    }
    if (isMuskatContext(text, extra) && !extra.skipMuskatLock) {
      applyMuskatLockedFacts(payload, catalog.length ? catalog : resolvedPlans);
    }
    return payload;
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

    const pushDoctorSection = () => {
      if (!doctors.length) return;
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
    };

    const pushMedicationSection = () => {
      if (!drugs.length) return;
      const r = push(["Medications", ...plans.map(() => "")], ["section", ...plans.map(() => "section")]);
      styles[r + ",0"] = makeStyle({
        font: { bold: true, sz: 12 },
        fill: { patternType: "solid", fgColor: { rgb: SECTION_FILL } },
      });
      for (let c = 1; c < colCount; c++) {
        styles[r + "," + c] = makeStyle({ fill: { patternType: "solid", fgColor: { rgb: SECTION_FILL } } });
      }
      const note = payload.genericOnlyNote || (drugs.some((d) => d.brandNotCovered || /\*$/.test(d.name) || d.genericOf) ? GENERIC_ONLY_NOTE : "");
      if (note) {
        const nr = push([note, ...plans.map(() => "")], ["note", ...plans.map(() => "note")]);
        if (colCount > 1) merges.push({ s: { r: nr, c: 0 }, e: { r: nr, c: colCount - 1 } });
        styles[nr + ",0"] = makeStyle({ font: { italic: true, sz: 9 } });
      }
      drugs.forEach((drug) => {
        const statuses = plans.map((p) => {
          const id = displayContractPbp(p);
          const rawId = String(p.planId || p.id || "");
          return (drug.byPlanId && (drug.byPlanId[id] || drug.byPlanId[rawId] || lookupPlanStatus(drug.byPlanId, p))) || { verified: false };
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
    };

    pushDoctorSection();
    pushMedicationSection();
    if (doctors.length || drugs.length) pushPlanHeaders();

    const sobBenefits = payload.sobBenefits || {};
    const pushBenefitRow = (label, values, highlight) => {
      const rowKinds = ["label", ...values.slice(1).map((c) => (c === "Unverified" ? "pending" : highlight ? "highlight" : "text"))];
      const rowStyles = [makeStyle({ font: { bold: true } })];
      values.slice(1).forEach((c) => {
        rowStyles.push(
          c === "Unverified"
            ? makeStyle({ font: { color: { rgb: RED } } })
            : highlight
              ? makeStyle({
                  fill: { patternType: "solid", fgColor: { rgb: YELLOW } },
                  alignment: { wrapText: true, vertical: "top" },
                })
              : makeStyle({ alignment: { wrapText: true, vertical: "top" } })
        );
      });
      push(values, rowKinds, rowStyles);
    };

    FIELD_ROWS.forEach(([label, key]) => {
      if (key === "mspLevels" && !comparisonIncludesDual(plans)) return;
      const values = [label, ...plans.map((p) => formatBenefitValue(p[key], key))];
      pushBenefitRow(label, values, HIGHLIGHT_KEYS[key]);
      (SOB_EXTRA_AFTER[key] || []).forEach(([extraLabel, extraKey]) => {
        if (!anySobField(plans, sobBenefits, extraKey)) return;
        const extraValues = [
          extraLabel,
          ...plans.map((p) => sobFieldValue(p, sobBenefits, extraKey) || "Unverified"),
        ];
        pushBenefitRow(extraLabel, extraValues, false);
      });
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
      genericOnlyNote: payload.genericOnlyNote || "",
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

  // Lookup results (doctors, formulary, SOB benefits like SNF / DME / hearing aids) arrive on
  // whatever turn Max ran them, often NOT the turn that cites 2+ plan IDs. The UI keeps every
  // result for the whole chat with this helper so the export can still use them.
  function mergeToolResults(prior, incoming, cap) {
    const max = cap > 0 ? cap : 300;
    const out = Array.isArray(prior) ? prior.slice() : [];
    (Array.isArray(incoming) ? incoming : []).forEach((tr) => {
      if (tr && typeof tr === "object") out.push(tr);
    });
    return out.length > max ? out.slice(out.length - max) : out;
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
    SOB_EXTRA_AFTER,
    sobFieldValue,
    anySobField,
    isDualOrDsnpPlan,
    comparisonIncludesDual,
    NETWORK_IN,
    NETWORK_OUT,
    NETWORK_NOT_CONFIRMED,
    NETWORK_NEED_MORE,
    GENERIC_ONLY_NOTE,
    BRAND_TO_GENERIC,
    knownGenericFor,
    applyKnownGenericSuggestions,
    MUSKAT_PLAN_IDS,
    CMS_PLAN_ID_RE,
    citedPlanIdsFromText,
    orderComparisonPlans,
    keepCurrentComparisonPlans,
    dedupeComparisonPlans,
    uniquePlansByContractPbp,
    compactContractPbp,
    doctorIdentityKey,
    preferredDoctorName,
    isCarrierAsDrugName,
    looksLikeDrugName,
    hasExplicitTerminatingLanguage,
    looksLikeTerminatingPlanName,
    sanitizeTerminatingPlan,
    isMuskatContext,
    currentPlansMatchMuskatLock,
    sameExportPlanSet,
    canonicalize2027ComparisonPlans,
    doctorsFromProviderLookups,
    mergeDoctorLists,
    applyMuskatLockedFacts,
    muskatLockedDoctors,
    muskatLockedDrugs,
    formatBenefitValue,
    formatPlanMarketingName,
    formatPlanColumnHeader,
    displayContractPbp,
    safeExportPlanId,
    extractClientName,
    extractTerminatingPlan,
    extractDoctors,
    normalizeDoctors,
    planStatusKey,
    lookupPlanStatus,
    mergeByPlanIdMaps,
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
    mergeToolResults,
    formatSobCell,
    formatEocCell,
  };
});
