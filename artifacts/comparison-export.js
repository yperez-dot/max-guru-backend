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
    advancedImaging: [
      ["DME", "dme"],
      ["DME", "dmeHospitalBed"],
    ],
  };
  const PLACED_SOB_EXPORT_KEYS = {
    snfDays1to20: true,
    snfDays21to100: true,
    dmeHospitalBed: true,
    hearingAids: true,
  };
  const GRID_TOPIC_RE =
    /\b(premium|part b(?:\s+(?:rebate|giveback|reduction))?|giveback|referrals?|msp levels?|moop|max out of pocket|out of pocket|inpatient hospital|outpatient hospital|pcp|primary care|specialist|emergency room|\ber\b|urgent care|advanced imaging|\bmri\b|\bct\b|\bpet\b|hearing services|hearing exam|dental|deep clean|denture|filling|root canal|extraction|crown|bridge|implant|vision|ambulance|transport(?:ation)?|companionship|custodial|rx deductible|tier\s*[1-6]|otc|grocery|food card|acupuncture|fitness|silver sneakers)\b/i;
  const KNOWN_OFF_GRID = [
    {
      benefits: ["skilled_nursing"],
      fieldKeys: ["snfDays1to20", "snfDays21to100"],
      re: /\b(snf|skilled nursing)\b/i,
      rows: [
        ["Skilled Nursing Facility (days 1–20)", "snfDays1to20"],
        ["Skilled Nursing Facility (days 21–100)", "snfDays21to100"],
      ],
    },
    {
      benefits: ["dme"],
      fieldKeys: ["dmeHospitalBed"],
      re: /\b(dme|hospital[-\s]?grade bed|hospital bed|durable medical)\b/i,
      rows: [["DME", "dmeHospitalBed"]],
    },
    {
      benefits: ["hearing_aids"],
      fieldKeys: ["hearingAids"],
      re: /\bhearing\s+aids?\b/i,
      rows: [["Hearing Aids", "hearingAids"]],
    },
    {
      benefits: ["chemotherapy"],
      fieldKeys: ["chemotherapy"],
      re: /\b(chemo(?:therapy)?|infusion therapy)\b/i,
      rows: [["Chemotherapy", "chemotherapy"]],
    },
    {
      benefits: ["home_health"],
      fieldKeys: ["homeHealth"],
      re: /\bhome health\b/i,
      rows: [["Home Health", "homeHealth"]],
    },
    {
      benefits: ["dialysis"],
      fieldKeys: ["dialysis"],
      re: /\bdialysis\b/i,
      rows: [["Dialysis", "dialysis"]],
    },
    {
      benefits: ["physical_therapy"],
      fieldKeys: ["physicalTherapy"],
      re: /\bphysical therapy\b/i,
      rows: [["Physical Therapy", "physicalTherapy"]],
    },
    {
      benefits: ["worldwide_emergency"],
      fieldKeys: ["worldwideEmergency"],
      re: /\b(worldwide emergency|foreign travel)\b/i,
      rows: [["Worldwide Emergency", "worldwideEmergency"]],
    },
    {
      benefits: ["post_discharge_meals"],
      fieldKeys: ["postDischargeMeals"],
      re: /\b(post[-\s]?discharge meals?|healthy meals?)\b/i,
      rows: [["Post-discharge Meals", "postDischargeMeals"]],
    },
  ];

  function slugBenefitKey(raw) {
    return String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40);
  }

  function titleFromSlug(slug) {
    return String(slug || "")
      .split("_")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function askedOffGridBenefits(text) {
    const src = String(text || "");
    const benefits = [];
    const fieldKeys = [];
    const rows = [];
    const seen = {};
    const add = (item) => {
      (item.benefits || []).forEach((b) => {
        if (b && benefits.indexOf(b) < 0) benefits.push(b);
      });
      (item.fieldKeys || []).forEach((k) => {
        if (k && fieldKeys.indexOf(k) < 0) fieldKeys.push(k);
      });
      (item.rows || []).forEach((r) => {
        if (!r || !r[1] || seen[r[1]]) return;
        seen[r[1]] = true;
        rows.push(r);
      });
    };
    const NEG_BEFORE = /(?:don'?t|dont|do not|doesn'?t|does not|never|no|not|without|skip|leave out|remove|drop)\s+[^.!?\n,;]{0,40}$/i;
    KNOWN_OFF_GRID.forEach((item) => {
      // "dont add SNFs" / "no dialysis" turns the benefit off; only a non-negated mention counts.
      const re = new RegExp(item.re.source, item.re.flags.replace("g", "") + "g");
      let hit;
      let live = false;
      while ((hit = re.exec(src))) {
        const before = src.slice(Math.max(0, hit.index - 30), hit.index);
        const after = src.slice(hit.index + hit[0].length, hit.index + hit[0].length + 14);
        // "dont add SNFs", "left SNF out", "no dialysis", "SNF not needed" turn the benefit off.
        const negated = NEG_BEFORE.test(before) || /(?:left|leave|leaving|skip|skipped|drop|dropped|removed?)\s+(?:\w+\s+){0,2}$/i.test(before) || /^s?\s*(?:out\b|off\b|not needed|isn'?t needed)/i.test(after);
        if (!negated) { live = true; break; }
        if (hit[0] === "") re.lastIndex += 1;
      }
      if (live) add(item);
    });
    const genericRe =
      /\b(?:need|needs|what's|whats|what is|does (?:it|this|the plan) cover|cover(?:age|ed)?(?: for)?|copay(?: for)?|cost (?:of|for)|how much (?:is|for))\s+([a-z][a-z0-9\s\-\/]{2,50})/gi;
    let m;
    while ((m = genericRe.exec(src))) {
      // "i dont need those" / "no need for" / "without coverage" is a negation, not a benefit she asked for.
      if (/(?:don'?t|dont|do not|doesn'?t|does not|didn'?t|never|no|not|without|skip)\s+(?:really\s+|even\s+)?$/i.test(src.slice(Math.max(0, m.index - 24), m.index))) continue;
      const phrase = m[1].replace(/\s+/g, " ").trim().replace(/[?.!,;:]+$/, "").replace(/^(?:a|an|the|her|his|their|those|these|that|this|any|some|more|all)\s+/i, "");
      if (!phrase || GRID_TOPIC_RE.test(phrase)) continue;
      // "does she need a PPO?" / "cover the official October 1 SoB" are not benefits (they became "aPpo" rows).
      if (/\b(ppo|hmo|pos|sob|eoc|pdf|snp|medicaid|msp|official|october|january|document|summary|directory|understood|noted|okay|thanks|please|snfs?)\b/i.test(phrase)) continue;
      if (KNOWN_OFF_GRID.some((item) => item.re.test(phrase))) continue;
      if (/^(the|a|an|this|that|her|his|their|plan|plans|benefit|benefits|for|on)$/i.test(phrase)) continue;
      // "need the client's full name", "need the NPI", "need more info" — not a benefit.
      if (/\b(client|name|npi|doctor|doctors|info|information|answer|confirm|title|plan|plans|meds?)\b/i.test(phrase)) continue;
      const key = slugBenefitKey(phrase);
      if (!key || seen[key]) continue;
      add({
        benefits: [key],
        fieldKeys: [key],
        rows: [[titleFromSlug(key), key]],
      });
    }
    return {
      asked: fieldKeys.length > 0,
      benefits,
      fieldKeys,
      rows,
      query: rows.map((r) => r[0]).join(", "),
    };
  }

  function askedExportSobBenefits(text) {
    return askedOffGridBenefits(text).asked;
  }

  const ASKED_SOB_EXPORT_KEYS = ["snfDays1to20", "snfDays21to100", "dmeHospitalBed"];
  const EXPORT_SOB_BENEFITS = ["skilled_nursing", "dme"];

  function resolveAskedOffGrid(meta) {
    if (meta && meta.askedInfo && typeof meta.askedInfo === "object") return meta.askedInfo;
    return askedOffGridBenefits((meta && (meta.threadText || meta.text)) || "");
  }

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
  const NETWORK_OUT = "Not in network (not listed)";
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
    lyrica: "Pregabalin",
    xanax: "Alprazolam",
    klonopin: "Clonazepam",
    ativan: "Lorazepam",
    valium: "Diazepam",
    synthroid: "Levothyroxine",
    wellbutrin: "Bupropion",
    elavil: "Amitriptyline",
    zoloft: "Sertraline",
    lexapro: "Escitalopram",
    neurontin: "Gabapentin",
    lotrel: "Amlodipine/Benazepril",
  };
  const MUSKAT_PLAN_IDS = ["H1036-054C", "H4140-023", "H5420-014"];
  const CMS_PLAN_ID_RE = /\b[HR]\d{3,4}[\s-]?\d{2,4}[A-Z]?(?:\s*\/\s*-?\d{2,4})?\b/gi;
  const CMS_PLAN_ID_RE_ONE = /\b[HR]\d{4}-\d{2,3}/i;
  const PREFERRED_COLUMN_IDS = ["H1036-054C", "H4140-023", "H5420-001", "H5420-014"];
  const DOCTORS_PBP_2027 = { "H4140-001": "H4140-022", "H4140-012": "H4140-023" };
  const CARRIER_AS_DRUG = /^(doctors?|uhc|united|unitedhealthcare|humana|careplus|care\s*plus|devoted|wellcare|well\s*care|aetna|simply|solis|healthsun|health\s*sun|healthspring|health\s*spring|medicaremax|medicare\s*max|preferred|cigna|anthem|elevance|floridablue|florida\s*blue|goldkidney|gold\s*kidney|gold\s*plus|drselect|drmax)$/i;

  const CLIENT_NAME_BLOCK = /^(miami|dade|broward|florida|medicare|humana|united|uhc|careplus|devoted|wellcare|aetna|simply|solis|healthsun|healthspring|doctors?|client|clients|export|excel|compare|comparison|plan|plans|dual|complete|preferred|summary|benefits|thei|max|pdf|sheet|name|household|both|network|zip|county|in|on|at|is|are|the|and|or|for|with|from|this|that)$/i;

  // Placeholder text from Max's own replies ('Reply like "X = Dr. Full Name"') — never a doctor row.
  const DOCTOR_TEMPLATE_RE = /^(?:dr\.?\s+|doctor\s+)?(?:(?:the\s+)?(?:full|first|last|doctor'?s?|provider'?s?)\s+name(?:\s+(?:here|last\s+name))?|first\s+last|name|full\s+name\s+here|john\s+doe|jane\s+doe)$/i;

  // Words an agent types in a reply ("both", "yes", "same") — never a medication row.
  const NON_DRUG_WORDS = new Set(
    "both all none no nope yes yeah yep ok okay sure same correct right wrong those these them they it this that either neither each other others another any meds med medication medications drug drugs rx generic brand unknown na idk she he her his their unchanged covered".split(" ")
  );

  function isNonDrugName(name) {
    const words = String(name || "")
      .toLowerCase()
      .replace(/\*+$/, "")
      .replace(/[^a-z0-9/\s-]+/g, " ")
      .split(/[\s/]+/)
      .filter(Boolean);
    if (!words.length) return true;
    return words.every((w) => NON_DRUG_WORDS.has(w));
  }

  // Salt / dosage-form / packaging words: "Amlodipine Besy-Benazepril HCL" and
  // "Amlodipine/Benazepril" are one drug; "Levothyroxine Sodium" is "Levothyroxine".
  const DRUG_SALT_WORDS = new Set(
    "besy besylate hcl hydrochloride hcl. hbr hydrobromide sodium na potassium calcium magnesium maleate mesylate succinate tartrate fumarate citrate sulfate acetate bromide phosphate hyclate monohydrate dihydrate trihydrate anhydrous dipropionate propionate valerate oral tablet tablets tab tabs capsule capsules cap caps caplet caplets chewable solution suspension pen injector injection auto autoinjector sureclick prefilled syringe generic mg mcg ml g unit units iu".split(" ")
  );

  /** Active-ingredient list for dedupe/matching ("Amlodipine Besy-Benazepril HCL 10-40mg" → ["amlodipine","benazepril"]). */
  function drugIngredients(name) {
    let s = String(name || "")
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\((?:generic|brand)\)/g, " ")
      .replace(/\*+/g, " ")
      .replace(/\b\d+(?:\.\d+)?(?:\s*[-\/]\s*\d+(?:\.\d+)?)*\s*(?:mg|mcg|µg|ug|g|ml|iu|units?|%)?(?:\s*\/\s*(?:ml|act|actuation|hr|h))?\b/g, " ");
    const parts = s.split(/\s*(?:\/|\+|-|&|,|\band\b|\bwith\b|\bw\/)\s*/);
    const out = [];
    parts.forEach((part) => {
      const words = part
        .replace(/[^a-z\s]+/g, " ")
        .split(/\s+/)
        .filter((w) => w && w.length > 1 && !DRUG_SALT_WORDS.has(w));
      if (!words.length) return;
      const ing = words.join(" ");
      if (out.indexOf(ing) < 0) out.push(ing);
    });
    return out;
  }

  /** Dedupe key for a medication row: sorted active ingredients. */
  function drugIdentityKey(name) {
    const ings = drugIngredients(name);
    if (!ings.length) return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    return ings.slice().sort().join("+");
  }

  /** Cleaner display between two aliases of one drug: no salt abbreviations, then shorter. */
  function preferredDrugName(a, b) {
    const noisy = (n) => {
      const words = String(n || "").toLowerCase().replace(/[^a-z\s]+/g, " ").split(/\s+/).filter(Boolean);
      return words.filter((w) => DRUG_SALT_WORDS.has(w)).length;
    };
    const keepMark = (n) => /\*$|\(generic\)/i.test(String(n || ""));
    if (keepMark(a) !== keepMark(b)) return keepMark(a) ? a : b;
    const na = noisy(a);
    const nb = noisy(b);
    if (na !== nb) return na < nb ? a : b;
    return a || b;
  }

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
    if (hit && typeof hit === "object") return usableSobCell(hit.value);
    if (typeof hit === "string") return usableSobCell(hit);
    if (plan && plan[key]) return usableSobCell(plan[key]);
    return null;
  }

  // PDF text scraped mid-sentence ("scription hearing aid…", "cal DME (e.g., …", bullets,
  // trailing ellipsis) must not print on a client sheet — show Unverified instead.
  function looksLikePdfFragment(s) {
    if (/[•]|\u2026$|\.\.\.$/.test(s)) return true;
    if (/^[a-z]/.test(s) && !/^(no|yes|up to|not|covered|included|days?)\b/.test(s)) return true;
    if (/\be\.g\.,|\(e\.g\./i.test(s)) return true;
    if ((s.match(/ · /g) || []).length >= 3) return true;
    return false;
  }

  function usableSobCell(raw) {
    if (raw == null) return null;
    const s = String(raw).replace(/\s+/g, " ").trim();
    if (!s || /^(not listed|n\/a|unverified|pending)$/i.test(s)) return null;
    if (looksLikePdfFragment(s)) return null;
    return s;
  }

  function anySobField(plans, sobBenefits, key) {
    return (plans || []).some((p) => Boolean(sobFieldValue(p, sobBenefits, key)));
  }

  function mergeSobBenefitMaps(base, incoming) {
    const out = Object.assign({}, base && typeof base === "object" ? base : {});
    if (!incoming || typeof incoming !== "object") return out;
    Object.keys(incoming).forEach((id) => {
      const row = incoming[id] && incoming[id].fields ? incoming[id].fields : incoming[id];
      if (!row || typeof row !== "object") return;
      out[id] = Object.assign({}, out[id] || {}, row);
    });
    return out;
  }

  function plansNeedingExportSob(plans, sobBenefits, fieldKeys) {
    const keys = fieldKeys && fieldKeys.length ? fieldKeys : ASKED_SOB_EXPORT_KEYS;
    return (plans || []).filter((p) => keys.some((key) => !sobFieldValue(p, sobBenefits, key)));
  }

  // When she asked for an off-grid benefit and chat never stored lookup_sob_benefit,
  // export looks those rows up itself from each plan's sobUrl (then EOC). Never invent dollars.
  // If she did not ask, do not fetch and do not add the rows. Grid rows stay as they are.
  async function fillExportSobBenefits(plans, sobBenefits, lookupFn, meta) {
    const askedInfo = resolveAskedOffGrid(meta);
    const asked =
      meta && meta.asked != null ? Boolean(meta.asked) : askedInfo.asked;
    const merged = mergeSobBenefitMaps({}, sobBenefits);
    if (!asked) return merged;
    const fieldKeys = (meta && meta.fieldKeys) || askedInfo.fieldKeys;
    const benefits = (meta && meta.benefits) || askedInfo.benefits;
    const query = (meta && meta.query) || askedInfo.query;
    const need = plansNeedingExportSob(plans, merged, fieldKeys);
    if (!need.length || typeof lookupFn !== "function") return merged;
    const planIds = need
      .map((p) => displayContractPbp(p) || (p && (p.planId || p.id)) || "")
      .map((id) => String(id).trim())
      .filter(Boolean);
    let incoming = {};
    try {
      const result = await lookupFn({
        planIds,
        plans: need,
        benefits: benefits && benefits.length ? benefits.slice() : EXPORT_SOB_BENEFITS.slice(),
        query: query || "asked off-grid benefits",
      });
      incoming = (result && (result.sobBenefits || result.byPlanId || result)) || {};
    } catch (_) {
      incoming = {};
    }
    return mergeSobBenefitMaps(merged, incoming);
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

  // Names that belong to doctors in the text: "Dr. X", the "Doctors:" list, and lines that carry a
  // specialty / NPI ("Cheryl L Case-Diaz (PCP)"). A client name is never one of them
  // (Maura's workup was saved as "Cheryl Case" — 2026-10-07).
  const DOCTOR_LINE_RE = /\b(?:pcp|primary\s+care|cardiolog\w*|dermatolog\w*|neurolog\w*|ophthalmolog\w*|gyn\w*|ob\/?gyn|oncolog\w*|urolog\w*|orthop\w*|gastro\w*|endocrin\w*|rheumat\w*|pulmon\w*|nephrolog\w*|podiatr\w*|psychiatr\w*|specialist|npi|m\.?d\.?|d\.?o\.?|aprn|arnp|np)\b/i;
  function doctorNamesIn(text) {
    const out = [];
    const t = String(text || "");
    for (const m of t.matchAll(/\bDr\.?\s+([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3})/g)) out.push(m[1]);
    for (const m of t.matchAll(/\b(?:doctors?|drs?|providers?)\s*:\s*([^\n]+)/gi)) {
      m[1].split(/[,;]|\band\b/).forEach((x) => out.push(x));
    }
    t.split(/\n/).forEach((line) => { if (DOCTOR_LINE_RE.test(line)) out.push(line); });
    return out.map((x) => String(x).toLowerCase());
  }
  function isDoctorName(candidate, doctorNames) {
    const words = String(candidate || "").toLowerCase().split(/[\s-]+/).filter((w) => w.length > 1);
    if (!words.length) return false;
    return doctorNames.some((d) => {
      const dw = d.split(/[^a-z']+/);
      return words.every((w) => dw.includes(w));
    });
  }

  function extractClientName(text) {
    if (!text) return "";
    const doctorNames = doctorNamesIn(text);
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
        if (looksLikePersonName(candidate) && !isDoctorName(candidate, doctorNames)) found = candidate;
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
    // Ask that opens with the household: "Maria & Gaspar Padron, ZIP 33332 …" / "Gaspar and Maria Padron: …"
    if (!found) {
      // The surname ends at a real delimiter — "Case-Diaz" is never cut to "Case" at its hyphen.
      const lead = String(text).match(/(?:^|\n)\s*([A-Z][a-z]+(?:\s*(?:&|and|y)\s*[A-Z][a-z]+)?\s+[A-Z][A-Za-z'-]*[A-Za-z])\s*(?:[,:.]|\s-\s)/);
      if (lead && !/\b(Medicare|Humana|Aetna|Devoted|Compare|Current|Plan|Doctors?|Meds?)\b/.test(lead[1]) && !isDoctorName(lead[1], doctorNames)) {
        found = lead[1].replace(/\s+/g, " ").trim();
      }
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
      // "Current plan H5420-014 terminating 2027"
      if (/\bcurrent\s+plan\s+[HR]\d{4}-\d{3}[A-Z]?\b[^.\n]{0,20}?\b(?:terminat|ending)/i.test(t)) return true;
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
      // "Current plan H5420-014 terminating 2027"
      /(?:current\s+plan\s+)?\b([HR]\d{4}-\d{3}[A-Z]?)\b[^.\n]{0,20}?\bterminat/i,
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
    // "❌ Not in network (not listed)" contains "in network" — read it as Out before the In test.
    if (/\bnot\s+(?:in[-\s]?network|listed)\b/i.test(s)) return NETWORK_OUT;
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

  // Doctor names scraped from chat text can pick up saved-result lines ("Name: H1045-005 IN"),
  // bare plan IDs ("Dr. H1036-065c Not Confirmed") and sentence runs ("Dr. Sarkell. Dr. Aguiar").
  // Clean what can be cleaned (cut at ":"), drop what cannot.
  function cleanDoctorName(raw) {
    let name = String(raw || "").replace(/\s+/g, " ").trim();
    name = name.replace(/\s*\[saved:[^\]]*\]/gi, "").replace(/\s*:.*$/, "").trim();
    name = name.replace(/\s+(?:in|out|in[-\s]?network|out(?:\s+of)?[-\s]?network|not\s+confirmed|need\s+more\s+info)$/i, "").trim();
    if (!name) return "";
    // "Mehta. Two questions" — a sentence ended; keep only what came before it (initials like "Jorge G. Ruiz" stay).
    if (/\.\s+Dr\.?\b/i.test(name) || /\bDr\.?\s+Dr\b/i.test(name)) return "";
    {
      const lead = (name.match(/^(?:Dr\.?|Doctor)\s+/i) || [""])[0];
      const body = name.slice(lead.length).replace(/(?<!\b[A-Za-z])(?<!\b(?:Jr|Sr|Mr|Ms|Mrs))\.\s+[A-Z].*$/, "").trim();
      name = (lead + body).trim();
    }
    if (!name) return "";
    if (/\b[HRS]\d{4}\s*-\s*\d{3}/i.test(name)) return "";
    if (/\.\s+Dr\.?\b/i.test(name) || /\bDr\.?\s+Dr\b/i.test(name)) return "";
    if (/\b(?:not\s+confirmed|out\s+of\s+network|in\s+network|need\s+more\s+info)\b/i.test(name)) return "";
    if (DOCTOR_TEMPLATE_RE.test(name)) return "";
    return name;
  }

  function findDoctorNames(text) {
    const names = [];
    const seen = new Set();
    const add = (raw) => {
      let name = cleanDoctorName(raw);
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
      /need\s*more\s*info|not\s*confirmed|failed\s*check|not\s+in[-\s]?network(?:\s*\(not\s+listed\))?|not\s+listed|out(?:\s+of)?[-\s]?network|in[-\s]?network|\bOON\b|\bINN\b|✅|❌/gi;
    let t;
    while ((t = re.exec(window))) {
      const raw = t[0];
      if (/need\s*more\s*info|failed\s*check/i.test(raw)) tokens.push(NETWORK_NEED_MORE);
      else if (/not\s*confirmed/i.test(raw)) tokens.push(NETWORK_NOT_CONFIRMED);
      else tokens.push(/out|oon|❌|^not\s/i.test(raw) ? NETWORK_OUT : NETWORK_IN);
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
    // "both" means both plans of a two-plan answer; on a 4-plan export it says nothing about
    // which columns, so it must not paint every column.
    if (tokens.length === 1 && ((both && plans.length <= 2) || hits.filter(Boolean).length === plans.length)) {
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
        // Prefer the status after the ID on its own line ("- H1036-121: Out"); a ±48-char
        // window alone picks up the previous bullet's status first.
        const lineEnd = idx >= 0 ? window.indexOf("\n", idx) : -1;
        const after = idx >= 0 ? window.slice(idx + id.length, lineEnd >= 0 ? lineEnd : undefined) : "";
        const local = idx >= 0 ? window.slice(Math.max(0, idx - 48), idx + id.length + 48) : window;
        const afterTokens = statusTokens(after);
        const localTokens = afterTokens.length ? afterTokens : statusTokens(local);
        if (localTokens.length) statuses[i] = localTokens[0];
        else if (tokens.length === 1) statuses[i] = tokens[0];
      });
    }
  }

  // The text a doctor's status is read from: the rest of the line the name is on. Only when
  // that line has no status ("Dr. X:" then "- H1045-012: In") do the following lines count,
  // and only while each names a plan. A 420-char run used to bleed the NEXT bullet into this
  // doctor ("✅ In on both: Rincon … \n❌ Out on both: Menendez" painted Rincon Out on a plan
  // that was never checked — Gail, H1045-018).
  function doctorStatusWindow(text, at) {
    const t = String(text || "");
    const lineEnd = t.indexOf("\n", at);
    const first = t.slice(at, lineEnd < 0 ? t.length : lineEnd).slice(0, 420);
    if (statusTokens(first).length || lineEnd < 0) return first;
    const lines = [first];
    let pos = lineEnd + 1;
    let used = first.length;
    while (pos < t.length && used < 420) {
      const next = t.indexOf("\n", pos);
      const line = t.slice(pos, next < 0 ? t.length : next);
      if (!CMS_PLAN_ID_RE_ONE.test(line) || /\b(?:Dr\.?|Doctor)\s+[A-Z]/.test(line)) break;
      lines.push(line);
      used += line.length + 1;
      if (next < 0) break;
      pos = next + 1;
    }
    return lines.join("\n");
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
        applyStatusesFromWindow(doctorStatusWindow(text, m.index), plans, statuses);
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
    if (isNonDrugName(s)) return false;
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
      drugIdentityKey(drug.name) === drugIdentityKey(genericName) ||
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
        unsure: Boolean(incoming.unsure),
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
      const key = drugIdentityKey(n);
      if (!byName.has(key)) {
        byName.set(key, { name: n, byPlanId: emptyPlanDrugStatuses(plans) });
      } else {
        const row = byName.get(key);
        row.name = preferredDrugName(row.name, n);
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
    return settleBrandNotCovered(applyKnownGenericSuggestions([...byName.values()], plans));
  }

  // One row per drug: "Amlodipine/Benazepril" and the catalog's "Amlodipine Besy-Benazepril HCL"
  // merge (verified tier wins per plan). Stray reply words ("both") are never a row.
  function normalizeDrugs(drugs, plans) {
    if (!Array.isArray(drugs) || !drugs.length || !plans || !plans.length) return [];
    const byName = new Map();
    const add = (name) => {
      const n = normalizeDrugName(name);
      if (!n || isNonDrugName(n) || isCarrierAsDrugName(n)) return null;
      const key = drugIdentityKey(n);
      if (!byName.has(key)) {
        byName.set(key, { name: n, byPlanId: emptyPlanDrugStatuses(plans) });
      } else {
        const row = byName.get(key);
        row.name = preferredDrugName(row.name, n);
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
    return settleBrandNotCovered(applyKnownGenericSuggestions([...byName.values()], plans));
  }

  // A brand the formulary lists as not covered, with its generic on its own row, reads
  // "Not covered" (the generic row carries the tier) — not "Confirm in Sunfire" (Gail / Xanax).
  function settleBrandNotCovered(drugs) {
    (drugs || []).forEach((d) => {
      if (!d || !d.byPlanId) return;
      const brand = String(d.name || "").replace(/\*+$/, "");
      const generic = knownGenericFor(brand);
      if (!generic) return;
      const gKey = drugIdentityKey(generic);
      const bKey = drugIdentityKey(brand);
      const hasGenericRow = drugs.some(
        (x) => x && x !== d && (drugIdentityKey(x.name) === gKey || (x.genericOf && drugIdentityKey(x.genericOf) === bKey))
      );
      if (!hasGenericRow) return;
      Object.keys(d.byPlanId).forEach((id) => {
        const cell = d.byPlanId[id];
        if (cell && cell.verified && cell.coverage === "not_covered" && cell.unsure) {
          d.byPlanId[id] = Object.assign({}, cell, { unsure: false });
        }
      });
    });
    return drugs;
  }

  function formatDrugCell(status, plan) {
    if (!status || !status.verified) return "Unverified";
    if (status.coverage === "not_covered" && status.unsure) return "Confirm in Sunfire";
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
      const name = cleanDoctorName(typeof d === "string" ? d : d.name || d.doctor || "");
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
        const fromNet =
          typeof d !== "string" && d.networks
            ? statusFromProviderNetworks(p, d.networks, { missIsUnknown: looksLikeOrganization(name) })
            : "";
        const merged = mergeStatusPair(fromMap, fromNet);
        return merged || NETWORK_NOT_CONFIRMED;
      });
      const row = {
        name,
        statuses,
        byPlanId: mergeByPlanIdMaps(map, byPlanIdFromStatuses(statuses, plans)),
      };
      if (typeof d !== "string") {
        const npi = String(d.npi || "").replace(/\D/g, "");
        if (npi.length === 10) row.npi = npi;
        if (Array.isArray(d.aliases) && d.aliases.length) row.aliases = d.aliases.slice();
      }
      out.push(row);
    }
    return out;
  }

  // "ERNESTO PADRON M.D" → "Dr. Ernesto Padron"; "EYE SURGERY ASSOCIATES LLC" → "Eye Surgery Associates".
  function cleanProviderDisplayName(raw) {
    let n = String(raw || "").replace(/\s+/g, " ").trim().replace(/^(dr|doctor)\.?\s+/i, "");
    const parts = n.split(/[\s,]+/).filter(Boolean);
    const CRED = /^(MD|DO|NP|PA|PAC|RN|APRN|ARNP|DDS|DMD|DPM|OD|DC|PHARMD|PHD|FNP|DNP|FACC|FACP|FACS|LLC|INC|PLLC|CORP)$/i;
    while (parts.length > 1 && CRED.test(parts[parts.length - 1].replace(/[.\-/]/g, ""))) parts.pop();
    n = parts.join(" ");
    if (n === n.toUpperCase() && /[A-Z]/.test(n)) n = n.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
    return looksLikeOrganization(n) ? n : "Dr. " + n;
  }

  /** Plan IDs the agent said are ending or to skip — never an export column. */
  function excludedPlanIdsFromText(text) {
    const t = String(text || "");
    const out = new Set();
    for (const m of t.matchAll(/\b(?:skip|exclude|drop|remove|without|not)\s+([HR]\d{4}-\d{3})/gi)) out.add(m[1].toUpperCase());
    for (const m of t.matchAll(/([HR]\d{4}-\d{3})[A-Z]?[^.\n]{0,40}?\b(terminating|ending|going away|non-?commissionable)/gi)) out.add(m[1].toUpperCase());
    return out;
  }

  function looksLikeOrganization(name) {
    const n = String(name || "").trim();
    if (!n || /^(dr|doctor)\b\.?\s/i.test(n)) return false;
    return /\b(neurology|rehab(?:ilitation)?|clinic|center|centre|institute|associates|group|hospital|medical|health|imaging|laboratory|therapy|specialists)\b/i.test(n);
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

  const SHARED_NETWORK_PLAN_IDS = { doctors: ["H4140-022", "H4140-023", "H4140-001", "H4140-012"] };

  function carrierHitIsPlanHit(carrierLabel, plan) {
    const c = String(carrierLabel || "").toLowerCase();
    if (!carrierMatchesPlan(carrierLabel, plan)) return false;
    // Solis: one network per county directory. Devoted: fallback only — a 2027 lookup carries
    // plan-level In/Out by network (C-SNP plans have their own network), checked first above.
    if (/devoted|solis/.test(c)) return true;
    if (/doctors/.test(c)) {
      const id = String((plan && (plan.planId || plan.id)) || "").toUpperCase().slice(0, 9);
      return SHARED_NETWORK_PLAN_IDS.doctors.indexOf(id) >= 0;
    }
    return false;
  }

  function statusFromProviderNetworks(plan, networks, opts) {
    let fallback = "";
    const missIsUnknown = Boolean(opts && opts.missIsUnknown);
    for (const net of networks || []) {
      if (!net) continue;
      const inBlob = (net.plans || []).join(" ");
      const outBlob = (net.outOfNetworkPlans || []).join(" ");
      if (blobHasPlanId(inBlob, plan)) return NETWORK_IN;
      if (blobHasPlanId(outBlob, plan)) return NETWORK_OUT;
      if (!carrierMatchesPlan(net.carrier, plan)) continue;
      if (net.status === "failed" || net.status === "pending") {
        fallback = fallback || NETWORK_NEED_MORE;
        continue;
      }
      // A carrier-level hit (no plan IDs) only counts as In where every plan shares one
      // network: Devoted (all plans) and Doctors DrMax-Dade / DrSelect-SFL (Yahoska,
      // 2026-10-06). Same rule as the chat table (doctorPlanNarrow.carrierHitIsPlanHit).
      if (net.inNetwork === true && !(net.plans && net.plans.length) && carrierHitIsPlanHit(net.carrier, plan)) return NETWORK_IN;
      // One-network directory (Devoted; Doctors DrMax/DrSelect) that answered and did not
      // list the doctor → Out. Same rule as the chat table (doctorPlanNarrow.directoryFinished).
      if (net.inNetwork === false && net.status === "checked" && !missIsUnknown && carrierHitIsPlanHit(net.carrier, plan)) return NETWORK_OUT;
      // Everything else is not an Out: an In for a DIFFERENT plan of the same carrier, a
      // carrier-level miss on a plan with its own network, or a clinic/org stays "Not confirmed".
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
        const missIsUnknown = looksLikeOrganization(name);
        const statuses = plans.map(
          (p) => statusFromProviderNetworks(p, networks, { missIsUnknown }) || NETWORK_NOT_CONFIRMED
        );
        const display = cleanProviderDisplayName(pr.requestedName || name);
        const row = {
          name: display,
          statuses,
          byPlanId: byPlanIdFromStatuses(statuses, plans),
          networks,
        };
        const npi = String(pr.npi || "").replace(/\D/g, "");
        if (npi.length === 10) row.npi = npi;
        // The registry's name for the requested one ("Rawan Jumean-Haddad" → RAWAN H JUMEAN) is an alias.
        const registry = cleanProviderDisplayName(name);
        if (registry && registry !== display) row.aliases = [registry];
        out.push(row);
      });
    });
    // Lookups arrive oldest first: a re-run of the same doctor (or the corrected spelling)
    // supersedes the earlier run plan by plan (Gail: Rincon Buendia re-run → In on Humana).
    let rows = [];
    out.forEach((r) => {
      const one = normalizeDoctors([r], plans)[0];
      if (one) rows = foldDoctorsLatestWins(rows, [one], plans);
    });
    return rows;
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
    // "Dr. Krajewski" has no first name — not first initial "k".
    const first = parts.length > 1 ? (parts[0] || "").toLowerCase().replace(/[^a-z]/g, "") : "";
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

  // ─── one row per doctor: aliases, spelling fixes, NPI ─────────────────────────
  const DOCTOR_CRED_RE = /^(md|do|np|pa|pac|rn|aprn|arnp|dds|dmd|dpm|od|dc|pharmd|phd|fnp|dnp|facc|facp|facs|mph|mba|jr|sr|ii|iii|iv)$/i;

  function doctorNameWords(name) {
    let s = String(name || "")
      .replace(/^\s*(?:dr\.?|doctor)\s*/i, "")
      .replace(/\bnpi\b[\s#:]*\d*/gi, " ")
      .replace(/\b\d+\b/g, " ")
      .replace(/\([^)]*\)/g, " ");
    if (s.indexOf(",") >= 0) {
      const bits = s.split(",").map((b) => b.trim()).filter(Boolean);
      const isCred = (b) => b.split(/\s+/).every((w) => DOCTOR_CRED_RE.test(w.replace(/[.\-]/g, "")));
      const rest = bits.slice(1).filter((b) => !isCred(b));
      // "MARGOLESKY, JASON" → "JASON MARGOLESKY"; "Jerry Martel, M.P.H." → "Jerry Martel".
      s = rest.length && bits[0].split(/\s+/).length === 1 ? rest.join(" ") + " " + bits[0] : [bits[0]].concat(rest).join(" ");
    }
    return s
      .split(/\s+/)
      .map((w) => w.replace(/[^A-Za-z'\-.]/g, "").replace(/^[.'-]+|[.'-]+$/g, ""))
      .filter((w) => w && !DOCTOR_CRED_RE.test(w.replace(/[.\-]/g, "")));
  }

  function doctorIdentity(name, npi) {
    const words = doctorNameWords(name).map((w) => w.toLowerCase().replace(/[.']/g, ""));
    const first = words.length > 1 ? words[0] : "";
    const surnames = [];
    const initials = [];
    words.slice(words.length > 1 ? 1 : 0).forEach((w) => {
      if (w.length === 1) {
        initials.push(w);
        return;
      }
      w.split("-").filter((x) => x.length >= 2).forEach((x) => surnames.push(x));
    });
    const n = String(npi || "").replace(/\D/g, "");
    return { first, surnames, initials, npi: n.length === 10 ? n : "", org: looksLikeOrganization(name) };
  }

  function editDistanceAtMost1(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
        continue;
      }
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  // "Eli" ~ "Elie", "Rowan" ~ "Rawan" (one-letter typo), "J" ~ "Jason". "Jose" vs "Josefina" stays apart.
  function firstNamesCompatible(a, b) {
    if (!a || !b) return true;
    if (a === b) return true;
    if (a.length === 1 || b.length === 1) return a[0] === b[0];
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 3 && long.indexOf(short) === 0 && long.length - short.length <= 2) return true;
    return short.length >= 4 && editDistanceAtMost1(a, b);
  }

  /** Same person? NPI decides when both rows have one; else a shared surname part + compatible first name. */
  function sameDoctorIdentity(a, b) {
    if (!a || !b) return false;
    if (a.npi && b.npi) return a.npi === b.npi;
    if (a.org || b.org) return false;
    const shared = a.surnames.some((x) => x.length >= 3 && b.surnames.indexOf(x) >= 0);
    if (!shared) return false;
    return firstNamesCompatible(a.first, b.first);
  }

  function doctorDisplayScore(name) {
    const s = String(name || "").replace(/^\s*(?:dr\.?|doctor)\s+/i, "");
    const words = doctorNameWords(s);
    let pts = 0;
    if (/[a-z]/.test(s)) pts += 4;
    if (/,/.test(s) && !/[a-z]/.test(s)) pts -= 4;
    words.forEach((w) => {
      if (w.length === 1 || /^[A-Za-z]\.$/.test(w)) pts += 0.5;
      else pts += w.split("-").filter(Boolean).length;
    });
    if (s.length > 48) pts -= 2;
    return pts;
  }

  /** Index of the existing row this doctor belongs to, or -1. A last-name-only row merges only when unambiguous. */
  function findDoctorGroup(rows, doc) {
    const ident = doctorIdentity(doc.name, doc.npi);
    if (ident.org || !ident.surnames.length) {
      const key = doctorIdentityKey(doc.name) || String(doc.name || "").toLowerCase();
      return rows.findIndex((r) => (doctorIdentityKey(r.name) || String(r.name || "").toLowerCase()) === key);
    }
    const hits = [];
    rows.forEach((r, i) => {
      if (sameDoctorIdentity(ident, doctorIdentity(r.name, r.npi))) hits.push(i);
      else if (Array.isArray(r.aliases) && r.aliases.some((a) => sameDoctorIdentity(ident, doctorIdentity(a, r.npi)))) hits.push(i);
    });
    if (!hits.length) return -1;
    if (hits.length === 1) return hits[0];
    // NPI match beats a fuzzy name match; otherwise ambiguous → its own row.
    const byNpi = hits.filter((i) => ident.npi && rows[i].npi === ident.npi);
    return byNpi.length === 1 ? byNpi[0] : -1;
  }

  function mergeStatusPair(prev, incoming) {
    // Two sources disagree (one In, one Out) → never pick one silently.
    if ((prev === NETWORK_IN && incoming === NETWORK_OUT) || (prev === NETWORK_OUT && incoming === NETWORK_IN)) {
      return NETWORK_NEED_MORE;
    }
    if (prev === NETWORK_IN || prev === NETWORK_OUT) return prev;
    if (incoming === NETWORK_IN || incoming === NETWORK_OUT) return incoming;
    if (prev === NETWORK_NEED_MORE || incoming === NETWORK_NEED_MORE) {
      return prev === NETWORK_NEED_MORE ? prev : incoming;
    }
    return prev || incoming;
  }

  function mergeDoctorLists(lists, plans) {
    const rows = [];
    (lists || []).forEach((list) => {
      normalizeDoctors(list, plans).forEach((doc) => {
        const idx = findDoctorGroup(rows, doc);
        if (idx < 0) {
          doc.aliases = [doc.name];
          rows.push(doc);
          return;
        }
        const prev = rows[idx];
        prev.aliases = (prev.aliases || [prev.name]).concat(doc.name);
        const pick = preferredDoctorName(prev.name, doc.name);
        // Same person under two spellings: keep the fuller name ("Elie R Haddad" over "Eli Haddad").
        prev.name =
          doctorIdentityKey(prev.name) === doctorIdentityKey(doc.name) || looksLikeOrganization(prev.name)
            ? pick
            : doctorDisplayScore(doc.name) > doctorDisplayScore(prev.name)
              ? doc.name
              : prev.name;
        if (!prev.npi && doc.npi) prev.npi = doc.npi;
        prev.byPlanId = mergeByPlanIdMaps(prev.byPlanId, doc.byPlanId);
        prev.statuses = plans.map((p, i) => {
          const fromMap = normalizeNetworkStatus(lookupPlanStatus(prev.byPlanId, p));
          return mergeStatusPair(mergeStatusPair(prev.statuses[i], doc.statuses[i]), fromMap) || NETWORK_NOT_CONFIRMED;
        });
        prev.byPlanId = mergeByPlanIdMaps(prev.byPlanId, byPlanIdFromStatuses(prev.statuses, plans));
      });
    });
    return rows;
  }

  /**
   * Fold doctor rows where the LATER result wins per plan (a re-run supersedes an earlier
   * run of the same doctor). A later Not confirmed / timeout never erases an earlier In/Out.
   */
  function foldDoctorsLatestWins(base, incoming, plans, opts) {
    // opts.conflict === "needMore": rows from DIFFERENT sources (saved payload / chat text vs a
    // live lookup) keep the old rule — an In-vs-Out disagreement exports as Need more info.
    const conflictRule = Boolean(opts && opts.conflict === "needMore");
    const rows = (base || []).slice();
    (incoming || []).forEach((doc) => {
      if (!doc || !doc.name) return;
      const idx = findDoctorGroup(rows, doc);
      if (idx < 0) {
        rows.push(Object.assign({}, doc, { aliases: [doc.name].concat(doc.aliases || []) }));
        return;
      }
      const prev = rows[idx];
      prev.aliases = (prev.aliases || [prev.name]).concat(doc.name);
      if (doctorDisplayScore(doc.name) > doctorDisplayScore(prev.name)) prev.name = doc.name;
      if (!prev.npi && doc.npi) prev.npi = doc.npi;
      prev.statuses = plans.map((p, i) => {
        const was = normalizeNetworkStatus(prev.statuses && prev.statuses[i]) || NETWORK_NOT_CONFIRMED;
        const now = normalizeNetworkStatus(doc.statuses && doc.statuses[i]);
        if (conflictRule) return mergeStatusPair(was === NETWORK_NOT_CONFIRMED ? "" : was, now) || NETWORK_NOT_CONFIRMED;
        if (now === NETWORK_IN || now === NETWORK_OUT) return now;
        if (now === NETWORK_NEED_MORE && was === NETWORK_NOT_CONFIRMED) return now;
        return was;
      });
      prev.byPlanId = byPlanIdFromStatuses(prev.statuses, plans);
    });
    return rows;
  }

  // ─── names the AGENT typed (never Max's replies) ─────────────────────────────
  const SPECIALTY_WORD_RE = /\b(?:pcp|primary\s+care|primary|neuro\w*|endo\w*|rheum\w*|cardio\w*|gastro\w*|gi|derm\w*|ophthal\w*|onco\w*|uro\w*|nephro\w*|pulmo\w*|podiat\w*|psych\w*|ortho\w*|ent|ob\/?gyn|gyn\w*|allerg\w*|hemat\w*|internist|surgeon|specialist|dentist|optometrist|doctor|dr)\b\.?/gi;

  /** Doctor names (and NPIs) from her own messages, oldest first. Used to back and name rows. */
  function userDoctorAliases(userText) {
    const out = [];
    const t = String(userText || "");
    // "Elie R Haddad, NPI 1740242361" — tie the NPI to the name before it.
    const npiFor = {};
    for (const m of t.matchAll(/([A-Za-z][A-Za-z'.\- ]{2,60}?)\s*,?\s*\bNPI\b\s*#?:?\s*(\d{10})/gi)) {
      const key = doctorNameWords(m[1].replace(SPECIALTY_WORD_RE, " ").replace(/^.*\b(?:correct|is|=)\s*:?\s*/i, "")).join(" ").toLowerCase();
      if (key) npiFor[key] = m[2];
    }
    let pos = 0;
    t.split(/(\n|,|;|=|:|\bis\s+correct\b|\band\b|\bor\b)/i).forEach((seg) => {
      const at = pos;
      pos += seg.length;
      const cleaned = seg
        .replace(/\bnpi\b[\s#:]*\d*/gi, " ")
        .replace(/\d+/g, " ")
        .replace(/^\s*(?:this|that|it)\s+(?:is|was)\s+(?:the\s+)?(?:correct|right)(?:\s+one)?\s*/i, " ")
        .replace(/\b(?:dr|dra|doctor)\.?\s*/gi, " ")
        .replace(SPECIALTY_WORD_RE, " ")
        .replace(/\s+/g, " ")
        .trim();
      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 4) return;
      if (!words.every((w) => /^[A-Za-z][A-Za-z'.-]*$/.test(w))) return;
      if (DOCTOR_TEMPLATE_RE.test(cleaned)) return;
      const key = doctorNameWords(cleaned).join(" ").toLowerCase();
      out.push({ name: cleaned, npi: npiFor[key] || "", at });
    });
    return out;
  }

  function doctorUserBacked(doc, aliases) {
    const ident = doctorIdentity(doc && doc.name, doc && doc.npi);
    return (aliases || []).some((a) => sameDoctorIdentity(ident, doctorIdentity(a.name, a.npi)));
  }

  function titleCaseName(name) {
    const s = String(name || "").trim();
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  /** Her correction names the row: when she typed 2+ spellings of one doctor, her latest wins ("rawan jumean-haddad"). */
  function applyUserDoctorNames(doctors, aliases) {
    (doctors || []).forEach((doc) => {
      if (!doc || looksLikeOrganization(doc.name)) return;
      const ident = doctorIdentity(doc.name, doc.npi);
      const mine = (aliases || []).filter((a) => {
        const ai = doctorIdentity(a.name, a.npi);
        if (sameDoctorIdentity(ident, ai)) return true;
        return (doc.aliases || []).some((x) => sameDoctorIdentity(doctorIdentity(x, doc.npi), ai));
      });
      const distinct = [...new Set(mine.map((a) => doctorNameWords(a.name).join(" ").toLowerCase()))];
      if (distinct.length < 2) return;
      const latest = mine.slice().sort((a, b) => a.at - b.at)[mine.length - 1];
      doc.name = "Dr. " + titleCaseName(doctorNameWords(latest.name).join(" "));
    });
    return doctors;
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
    payload.clientName = "Mr. and Mrs. Muskat";
    payload.zip = payload.zip || "33176";
    payload.county = payload.county || "Miami-Dade";
    payload.doctors = mergeDoctorLists([muskatLockedDoctors(), payload.doctors], payload.plans);
    // Margolesky + Miami Neurology & Rehab always get a row. If no lookup result reached the
    // export they show "Not confirmed" — never a guessed In/Out.
    [
      ["Dr. Jason Margolesky", /margolesky/i],
      ["Miami Neurology & Rehab", /miami\s+neurology/i],
    ].forEach(([label, re]) => {
      if ((payload.doctors || []).some((d) => re.test(String(d.name || "")))) return;
      const byPlanId = {};
      payload.plans.forEach((p) => {
        byPlanId[displayContractPbp(p)] = NETWORK_NOT_CONFIRMED;
      });
      payload.doctors.push({
        name: label,
        statuses: payload.plans.map(() => NETWORK_NOT_CONFIRMED),
        byPlanId,
      });
    });
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
    const excluded = excludedPlanIdsFromText(text);
    const allResolved = resolveExportPlans(plans, text, extra);
    const kept = allResolved.filter((p) => !excluded.has(String(p.planId || p.id || "").toUpperCase().slice(0, 9)));
    const resolvedPlans = kept.length ? kept : allResolved;
    const clientName = extra.clientName || extractClientName(text);
    const terminatingPlan = extra.explicitTerminating
      ? sanitizeTerminatingPlan(extra.terminatingPlan || extractTerminatingPlan(text), text)
      : extractTerminatingPlan(text);
    const fromLookups = doctorsFromProviderLookups(
      extra.providerLookups || extra.toolResults || extra.doctorsFromTools || [],
      resolvedPlans
    );
    // Doctor rows come from names SHE typed. Names that only appear in Max's replies — his own
    // 'Reply like "X = Dr. Full Name"' template, a candidate he floated — are not rows. Her
    // messages are only known when the chat passes them (userMessages); otherwise unchanged.
    const userMsgs = Array.isArray(extra.userMessages) ? extra.userMessages.map((m) => String(m || "")) : null;
    const userAliases = userMsgs ? userDoctorAliases(userMsgs.join("\n")) : [];
    let textDoctors = extractDoctors(text, resolvedPlans);
    let rememberedDoctors = extra.doctors;
    if (userAliases.length) {
      textDoctors = textDoctors.filter((d) => doctorUserBacked(d, userAliases));
      rememberedDoctors = (Array.isArray(rememberedDoctors) ? rememberedDoctors : []).filter(
        (d) => d && (typeof d === "string" ? doctorUserBacked({ name: d }, userAliases) : doctorUserBacked(d, userAliases))
      );
    }
    // Aliases of one doctor (saved rows, chat text, live lookups) collapse into one row. Within
    // the lookups the latest run already won per plan; across sources In-vs-Out stays Need more info.
    let doctors = foldDoctorsLatestWins(
      mergeDoctorLists([rememberedDoctors, textDoctors], resolvedPlans),
      fromLookups,
      resolvedPlans,
      { conflict: "needMore" }
    );
    if (userAliases.length) applyUserDoctorNames(doctors, userAliases);
    doctors = doctors.map((d) => {
      const row = Object.assign({}, d);
      delete row.aliases;
      return row;
    });
    // Drug checks from any earlier turn in the session count too (the meds turn
    // and the final plan answer are often different turns).
    const toolDrugs = [];
    (extra.toolResults || []).forEach((tr) => {
      if (!tr || (tr.tool !== "lookup_formulary" && tr.tool !== "search_drug")) return;
      const o = tr.output || {};
      if (o.drug) toolDrugs.push(o.drug);
      if (Array.isArray(o.drugs)) toolDrugs.push(...o.drugs);
    });
    const fromExtras = normalizeDrugs([...(Array.isArray(extra.drugs) ? extra.drugs : []), ...toolDrugs], resolvedPlans);
    const fromThread = extractDrugs(text, resolvedPlans);
    let drugs = fromExtras.length ? fromExtras : fromThread;
    if (fromExtras.length && fromThread.length) {
      fromThread.forEach((t) => {
        const hit = drugs.find((d) => drugIdentityKey(d.name) === drugIdentityKey(t.name));
        if (!hit) drugs.push(t);
        else {
          Object.keys(t.byPlanId || {}).forEach((id) => {
            mergeDrugPlanStatus(hit.byPlanId, id, t.byPlanId[id], resolvedPlans);
          });
        }
      });
    }
    drugs = settleBrandNotCovered(applyKnownGenericSuggestions(drugs, resolvedPlans));
    const payload = {
      plans: resolvedPlans,
      clientName: clientName || "",
      terminatingPlan: terminatingPlan || "",
      doctors,
      drugs,
      zip: extra.zip || "",
      county: extra.county || "",
      threadText: text,
      // What SHE typed (not Max's replies): the only text that can ask for an extra benefit row.
      askText: extra.askText != null ? String(extra.askText) : text,
      sobBenefits: extra.sobBenefits || extra.sobExtras || {},
      askedExportSob: extra.askedExportSob === true || askedExportSobBenefits(extra.askText != null ? extra.askText : text),
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
    const askedInfo = askedOffGridBenefits(payload.askText != null ? payload.askText : payload.threadText);
    const askedKeys = {};
    askedInfo.fieldKeys.forEach((k) => {
      askedKeys[k] = true;
    });
    // One "DME" row, whichever field the SOB filled — but only when she asked about DME / a hospital bed.
    if (askedKeys.dmeHospitalBed && anySobField(plans, sobBenefits, "dme")) askedKeys.dme = true;
    const printedExtras = {};
    const printedLabels = {};
    const pushBenefitRow = (label, values, highlight) => {
      // A hospital bed IS durable medical equipment: one "DME" row, never a separate bed row.
      if (printedLabels[label]) return;
      printedLabels[label] = true;
      // No yellow highlight on client sheets (Yahoska 10/5) — plain cells only.
      void highlight;
      const rowKinds = ["label", ...values.slice(1).map((c) => (c === "Unverified" ? "pending" : "text"))];
      const rowStyles = [makeStyle({ font: { bold: true } })];
      values.slice(1).forEach((c) => {
        rowStyles.push(
          c === "Unverified"
            ? makeStyle({ font: { color: { rgb: RED } } })
            : makeStyle({ alignment: { wrapText: true, vertical: "top" } })
        );
      });
      push(values, rowKinds, rowStyles);
    };

    FIELD_ROWS.forEach(([label, key]) => {
      if (key === "mspLevels" && !comparisonIncludesDual(plans)) return;
      const values = [label, ...plans.map((p) => formatBenefitValue(p[key], key))];
      pushBenefitRow(label, values, HIGHLIGHT_KEYS[key]);
      (SOB_EXTRA_AFTER[key] || []).forEach((extra) => {
        const extraLabel = extra[0];
        const extraKey = extra[1];
        // Only rows she asked for. A lookup that happened to return SNF / hearing aids must not add rows (Yahoska 2026-10-07).
        if (!askedKeys[extraKey]) return;
        printedExtras[extraKey] = true;
        const extraValues = [
          extraLabel,
          ...plans.map((p) => sobFieldValue(p, sobBenefits, extraKey) || "Unverified"),
        ];
        pushBenefitRow(extraLabel, extraValues, false);
      });
    });

    askedInfo.rows.forEach((extra) => {
      const extraLabel = extra[0];
      const extraKey = extra[1];
      if (!extraKey || printedExtras[extraKey]) return;
      printedExtras[extraKey] = true;
      const extraValues = [
        extraLabel,
        ...plans.map((p) => sobFieldValue(p, sobBenefits, extraKey) || "Unverified"),
      ];
      pushBenefitRow(extraLabel, extraValues, false);
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
      if (r === 0 && model.title) return { hpt: 24 };
      // Cells wrap now, so give each row enough lines for its longest cell (column ≈ 34 characters wide).
      const lines = row.reduce((mx, cell, c) => {
        const perLine = c === 0 ? 26 : 34;
        const n = String(cell == null ? "" : cell)
          .split("\n")
          .reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)), 0);
        return Math.max(mx, n);
      }, 1);
      if (lines > 1) return { hpt: Math.min(15 * lines + 4, 150) };
      void wrapped;
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
    applyGridAndCenter(ws, model);
  }

  // Thin grid lines on every table cell and centered text (Yahoska 2026-10-07). The client-name title row stays as is.
  function applyGridAndCenter(ws, model) {
    if (typeof XLSX === "undefined" || !XLSX.utils) return;
    const cols = (model.headers || []).length;
    const edge = { style: "thin", color: { rgb: "9A9A9A" } };
    model.aoa.forEach((row, r) => {
      if ((model.kinds[r] || [])[0] === "title") return;
      for (let c = 0; c < cols; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        if (!ws[addr]) ws[addr] = { t: "s", v: "" };
        const prev = ws[addr].s || {};
        ws[addr].s = Object.assign({}, prev, {
          border: { top: edge, bottom: edge, left: edge, right: edge },
          alignment: Object.assign({}, prev.alignment, { horizontal: "center", vertical: "center", wrapText: true }),
        });
      }
    });
    const ref = XLSX.utils.decode_range(ws["!ref"] || "A1");
    ref.e.c = Math.max(ref.e.c, cols - 1);
    ref.e.r = Math.max(ref.e.r, model.aoa.length - 1);
    ws["!ref"] = XLSX.utils.encode_range(ref);
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

  // "Find the plans that cover the most of her doctors … then the Excel" is a search, not an
  // export: only a message that is mainly an export request may skip the model and re-export the
  // last plans (Maura Soley, 2026-10-07). Everything else runs the full chat; export chips follow.
  const EXPORT_WORK_RE = /\b(find|search|look\s*(?:up|for)|lookup|compare|comparing|suggest|recommend|rank|ranked|ranking|top\s+\d|best|cover(?:s|ing)?|which\s+plans?|what\s+plans?|check|run|show\s+(?:me\s+)?(?:the\s+)?(?:top|best|plans?|other)|include|exclude|instead|switch|swap|add|remove|drop)\b/i;
  function isExportShortcutAsk(text) {
    const t = String(text || "");
    if (!wantsComparisonExport(t)) return false;
    if (citedPlanIdsFromText(t).length > 0) return false;
    if (CARRIER_ASK_RE.test(t)) return false; // names a carrier → new plans, not a re-export
    // Strip the export words themselves ("export this to excel", "side by side pdf") before
    // looking for any other work in the message.
    const rest = t
      .replace(/\b(?:then\s+)?(?:the\s+)?(?:excel|xlsx|spreadsheet|pdf|export(?:\s+(?:this|it|that|to|as|in))?|side[-\s]?by[-\s]?side|download|file|sheet)\b/gi, " ")
      .replace(/\b(?:please|pls|can you|could you|give me|send|make|create|generate|and|or|the|a|an|me|it|this|that|of|for|to|as|in|with|now|thanks?|ok(?:ay)?)\b/gi, " ")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .trim();
    if (EXPORT_WORK_RE.test(t.replace(/\bexport\s+(?:this|it|that)\b/gi, " "))) return false;
    // Long messages carry more than an export ask (doctors, meds, a ZIP …).
    return rest.split(/\s+/).filter(Boolean).length <= 6;
  }

  /** "UHC Preferred Care Preferred MA (H1045-001)" — never "UHC UHC …" when the plan name already starts with the carrier. */
  function planChatLabel(p) {
    const carrier = String((p && p.carrier) || "").trim();
    const name = String((p && (p.planName || p.name)) || "").trim();
    const id = String((p && (p.planId || p.id)) || "").trim();
    const first = (x) => x.toLowerCase().split(/\s+/)[0] || "";
    const carrierShown = !carrier || !name || name.toLowerCase().startsWith(carrier.toLowerCase()) || first(name) === first(carrier) ? "" : carrier + " ";
    return (carrierShown + name).trim() + (id ? " (" + id + ")" : "");
  }

  // "Show benefits for these plans": every column, looked up by contract-PBP across the WHOLE grid
  // (the client's county copy first), never just the county slice or the ranked subset — H1045-001
  // (her current plan) came back missing on the first try (Maura, 2026-10-07).
  function benefitPlansFor(ids, pool, county) {
    const norm = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const rows = Array.isArray(pool) ? pool : [];
    const out = [];
    (Array.isArray(ids) ? ids : []).forEach((raw) => {
      const id = String((raw && (raw.planId || raw.id)) || raw || "");
      const key = norm(id);
      if (!key || out.some((p) => norm(p.planId || p.id) === key)) return;
      const hits = rows.filter((p) => norm(p.planId || p.id) === key);
      const mine = county ? hits.filter((p) => p.county === county) : [];
      const row = mine[0] || hits[0];
      if (row) out.push(row);
      else out.push({ planId: id.toUpperCase().slice(0, 9), planName: (raw && raw.planName) || "", carrier: (raw && raw.carrier) || "", missing: true });
    });
    return out;
  }

  const BENEFIT_ROWS = [
    ["Premium", "premium"], ["Part B giveback", "partBGiveback"], ["MOOP", "moop"], ["PCP", "pcpCopay"],
    ["Specialist", "specialistCopay"], ["ER", "erCopay"], ["Urgent care", "urgentCareCopay"],
    ["Inpatient", "inpatientHospital"], ["Dental", "dental"], ["Vision", "vision"], ["Hearing", "hearing"],
    ["OTC", "otc"], ["Food / grocery card", "groceryCardDetail"], ["Referral", "referral"],
  ];

  /** One side-by-side benefit table for every column (same rows for all plans), from the grid. */
  function benefitsTable(plans, county) {
    const cols = (Array.isArray(plans) ? plans : []).filter(Boolean);
    if (!cols.length) return "";
    const cell = (v) => String(v == null || v === "" ? "—" : v).replace(/\s*\n\s*/g, " · ").replace(/\|/g, "/");
    const head = "| Benefit | " + cols.map((p) => planChatLabel(p).replace(/\|/g, "/")).join(" | ") + " |";
    const sep = "|---|" + cols.map(() => "---").join("|") + "|";
    const rows = BENEFIT_ROWS.map(([label, key]) => "| " + label + " | " + cols.map((p) => (p.missing ? "not on the grid" : cell(p[key]))).join(" | ") + " |");
    const notes = [];
    const away = county ? cols.filter((p) => !p.missing && p.county && p.county !== county) : [];
    if (away.length) notes.push("⚠️ Not offered in " + county + ": " + away.map((p) => (p.planId || p.id) + " (" + p.county + " grid)").join(", ") + ".");
    const missing = cols.filter((p) => p.missing);
    if (missing.length) notes.push("⚠️ Not on the 2027 grid: " + missing.map((p) => p.planId).join(", ") + ".");
    return ["**Benefits — THEI 2027 grid**", "", head, sep].concat(rows, notes.length ? [""].concat(notes) : [], ["", "Full benefits are in the Excel / PDF export."]).join("\n");
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

  function messageContentToText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "string" ? part : (part && part.text) || ""))
        .filter(Boolean)
        .join("\n");
    }
    return String(content || "");
  }

  // Max listing candidates and asking narrowing questions (Medicaid / must-keep /
  // HMO vs PPO) is not a finished comparison — no export offer, no autosave.
  // A reply that draws a doctor / med / benefit × plan table is a finished comparison: the export chips
  // always follow it, even when it also asks a question (Maura, 2026-10-07: Aetna grid had no chips).
  function hasComparisonTable(text) {
    const t = String(text || "");
    return /^\s*\|\s*\**(Doctor|Drug|Med|Medication|Benefit)s?\**\s*\|/im.test(t) && /\b[HR]\d{4}-\d{3}/i.test(t);
  }

  function isNarrowingReply(text) {
    const t = String(text || "");
    if (!/\?/.test(t)) return false;
    if (hasComparisonTable(t)) return false;
    return /medicaid or (an? )?(msp|medicare savings)|must-keep|hmo ok,? or do they need a ppo|once i have (those|these|your answers)|to narrow (it )?(down |to 2)/i.test(t);
  }

  function isExportOnlyAsk(text) {
    const t = String(text || "");
    if (!t || !wantsComparisonExport(t)) return false;
    return citedPlanIdsFromText(t).length < 1 && !askedExportSobBenefits(t);
  }

  function requestUpdatesComparison(text) {
    const t = String(text || "");
    if (!t) return false;
    if (citedPlanIdsFromText(t).length > 0) return true;
    if (askedExportSobBenefits(t)) return true;
    if (/\b(add|also|include|check|look\s*up|lookup|new)\b/i.test(t) && /\b(doctor|dr\.|clinic|drug|meds?|medication|rx|plan)\b/i.test(t)) {
      return true;
    }
    return false;
  }

  function lastUserComparisonAsk(messages, userMessageTextFn) {
    const toText = typeof userMessageTextFn === "function" ? userMessageTextFn : messageContentToText;
    let lastUser = "";
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "user") continue;
      const t = toText(m.content);
      if (!t) continue;
      if (!lastUser) lastUser = t;
      if (isExportOnlyAsk(t)) continue;
      return t;
    }
    return lastUser;
  }

  const CARRIER_ASK_RE = /\bdoc?to?r?s?'?\s*(?:health\s*care|healthcare|health|hc)\b|\bsol[iy]s\b|\b[cd]evoted\b|\bhumana\b|\baetna\b|\buhc\b|\bunited\s*health|\bsimply\b|\bwell\s*care\b|\bcare\s*plus\b|\bflorida blue\b|\bhealth\s*sun\b/i;
  const PLAN_SET_VERB_RE = /\b(show|compare|instead|use|switch|swap|look at|what about|how about|wants?|prefers?|only|give me|pull|run|try)\b/i;

  function switchesPlanSet(latest) {
    const t = String(latest || "").replace(/\b(?:doctors?|drs?|providers?)\s*:[^\n]*/gi, " ");
    return /\binstead of (?:these|those|the) plans\b/i.test(t) || (PLAN_SET_VERB_RE.test(t) && CARRIER_ASK_RE.test(t));
  }

  // "H5420-14-0" / "H5420-14" as agents type them → "H5420-014".
  function normalizeTypedPlanId(raw) {
    const s = String(raw || "").toUpperCase().replace(/\s+/g, "").split("/")[0];
    const m = s.match(/^([HR]\d{4})-?(\d{1,3})([A-Z]?)(?:-\d{1,3})?$/);
    if (!m) return s;
    return m[1] + "-" + m[2].padStart(3, "0") + m[3];
  }

  function typedPlanIds(text) {
    const re = /\b([HR]\d{4})-(\d{1,3})([A-Z]?)(?:-\d{1,3})?\b/gi;
    const out = [];
    for (const m of String(text || "").matchAll(re)) {
      const id = normalizeTypedPlanId(m[0]);
      if (out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  const PLAN_ADD_RE = /\b(add|also|include|plus|too|as\s+well|another)\b/i;
  const PLAN_USE_RE = /\b(use|go\s+with|pick|choose|want)\b/i;
  const PLAN_REMOVE_RE = /\b(remove|drop|take\s+off|take\s+out|without|skip|exclude|delete|no\s+longer)\b/i;

  /**
   * The plans she is working with NOW, from her own messages only: the latest message that
   * lists 2+ plan IDs sets the columns; later "add/also/too … H…" adds, "remove/drop H…"
   * removes. Plans Max mentioned, couldn't verify, or that came up earlier are not columns.
   * [] when her messages never listed plans (callers fall back to the old resolution).
   */
  function workingPlanIdsFromUserMessages(messages) {
    let set = null;
    (messages || []).forEach((raw) => {
      const t = String(raw || "");
      // Statements about her current/old plan are not asks ("she was switched to … H5420-14-0 for 2026").
      const ids = typedPlanIds(t);
      if (!ids.length) return;
      if (PLAN_REMOVE_RE.test(t) && set) {
        set = set.filter((id) => ids.indexOf(id) < 0);
        return;
      }
      if (PLAN_ADD_RE.test(t) && set) {
        ids.forEach((id) => {
          if (set.indexOf(id) < 0) set.push(id);
        });
        return;
      }
      if (ids.length >= 2) {
        set = ids.slice();
        return;
      }
      if (PLAN_ADD_RE.test(t) || PLAN_USE_RE.test(t)) {
        set = set || [];
        if (set.indexOf(ids[0]) < 0) set.push(ids[0]);
      }
    });
    return set || [];
  }

  function resolveExportPlans(plans, threadText, extra) {
    const meta = extra && typeof extra === "object" ? extra : {};
    const catalog = meta.catalog || meta.planCatalog || [];
    const pool = catalog.length ? catalog : plans;
    const text = String(threadText || "");
    const latest = String(meta.latestUserText || "");
    const county = /\bbroward\b/i.test(text + " " + latest) && !/miami/i.test(text + " " + latest) ? "Broward" : "Miami-Dade";
    const pick = (id) => pickCatalogPlan(pool, id, county) || pickCatalogPlan(pool, id);
    // Her working plan set wins over the union of every plan ever named in the thread
    // (Gail: 11 columns incl. HealthSun plans Max said it couldn't verify and a UHC plan never run).
    if (Array.isArray(meta.userMessages)) {
      const working = workingPlanIdsFromUserMessages(meta.userMessages);
      const picked = working.map((id) => pick(id) || (plans || []).find((p) => planColumnId(p) === compactContractPbp(id))).filter(Boolean);
      if (picked.length >= 2) {
        return uniquePlansByContractPbp(canonicalize2027ComparisonPlans(picked, latest || text, pool));
      }
    }
    const latestIds = citedPlanIdsFromText(latest);
    // "show me Doctors, Solis, Devoted" / "instead of these plans …" replaces the columns:
    // export exactly the plans the latest answer showed, never older plans from the thread.
    if (!latestIds.length && (plans || []).length && switchesPlanSet(latest)) {
      return uniquePlansByContractPbp(canonicalize2027ComparisonPlans(plans, latest || text, pool));
    }
    if (latestIds.length >= 2) {
      return uniquePlansByContractPbp(
        canonicalize2027ComparisonPlans(latestIds.map(pick).filter(Boolean), latest, pool)
      );
    }
    const fromText = citedPlanIdsFromText(text).map(pick).filter(Boolean);
    let resolved = uniquePlansByContractPbp(
      keepCurrentComparisonPlans(
        canonicalize2027ComparisonPlans(plans || [], text, pool),
        canonicalize2027ComparisonPlans(
          [].concat(fromText, meta.rememberedPlans || meta.priorPlans || []),
          text,
          pool
        )
      )
    );
    if (latestIds.length === 1) {
      const added = pick(latestIds[0]);
      if (added) {
        resolved = uniquePlansByContractPbp(
          canonicalize2027ComparisonPlans([].concat(resolved, added), latest || text, pool)
        );
      }
    }
    return resolved;
  }

  /** Only the agent's own messages — Max's replies ("like chemo, home health…") must not request benefit rows. */
  function conversationUserText(messages, userMessageTextFn) {
    return conversationPlainText((messages || []).filter((m) => m && m.role === "user"), userMessageTextFn);
  }

  /** Max's reply still ends with questions for the agent ("Questions:\n1. …?", "Before this narrows to 2–3 plans:") — not the time to offer benefits. */
  function hasOpenQuestions(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/\bBefore this narrows\b/i.test(t)) return true;
    const m = t.match(/(?:^|\n)\s*(?:Questions?|Two questions|Three questions)\s*:?\s*\n([\s\S]*)$/i);
    if (m && /(?:^|\n)\s*1[.)]\s+\S[^\n]*\?/.test(m[1])) return true;
    // A reply that ends in a numbered list where any of the trailing items asks something
    // ("Two things would let me finish:\n1. Do you want …?\n2. Is X = Y? Also, does …").
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    const tail = [];
    for (let i = lines.length - 1; i >= 0 && tail.length < 5; i -= 1) {
      if (!/^\d[.)]\s+/.test(lines[i]) && !(tail.length && /^[-–•]|^[a-z(]/.test(lines[i]))) break;
      tail.push(lines[i]);
    }
    return tail.some((l) => /^\d[.)]\s+/.test(l) && /\?/.test(l));
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
    ASKED_SOB_EXPORT_KEYS,
    EXPORT_SOB_BENEFITS,
    askedOffGridBenefits,
    askedExportSobBenefits,
    applySheetExtras,
    conversationUserText,
    hasOpenQuestions,
    sobFieldValue,
    anySobField,
    mergeSobBenefitMaps,
    plansNeedingExportSob,
    fillExportSobBenefits,
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
    resolveExportPlans,
    workingPlanIdsFromUserMessages,
    normalizeTypedPlanId,
    drugIngredients,
    drugIdentityKey,
    isNonDrugName,
    doctorIdentity,
    sameDoctorIdentity,
    userDoctorAliases,
    foldDoctorsLatestWins,
    settleBrandNotCovered,
    lastUserComparisonAsk,
    requestUpdatesComparison,
    isExportOnlyAsk,
    isNarrowingReply,
    hasComparisonTable,
    benefitPlansFor,
    benefitsTable,
    cleanProviderDisplayName,
    excludedPlanIdsFromText,
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
    isExportShortcutAsk,
    planChatLabel,
    wantsExcelExport,
    conversationPlainText,
    mergeToolResults,
    formatSobCell,
    formatEocCell,
  };
});
