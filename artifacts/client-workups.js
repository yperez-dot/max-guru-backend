/**
 * Structured client workups (Yahoska / Muskat-style comps).
 * Browser (window.MaxClientWorkups) + Node tests.
 * Never stores or resumes a full chat transcript.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.MaxClientWorkups = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WORKUP_CONTEXT_PREFIX = "LOADED CLIENT WORKUP";
  const NETWORK_IN = "IN";
  const NETWORK_OUT = "OUT";
  const NETWORK_NOT_CONFIRMED = "NOT CONFIRMED";
  const NETWORK_NEED_MORE = "NEED MORE INFO";

  function clip(value, max) {
    const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return s.slice(0, max);
  }

  function displayPlanId(plan) {
    let id = String((plan && (plan.planId || plan.id)) || "").replace(/\s+/g, "");
    id = id.replace(/-000$/i, "").replace(/\/000$/i, "");
    return id;
  }

  function marketingLabel(plan) {
    if (!plan) return "";
    const name = [plan.carrier, plan.planName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const id = displayPlanId(plan);
    if (name && id) return name + " (" + id + ")";
    return name || id;
  }

  function normalizeNetworkBucket(raw) {
    if (raw === true) return NETWORK_IN;
    if (raw === false) return NETWORK_OUT;
    const s = String(raw || "").trim();
    if (!s) return "";
    const upper = s.toUpperCase();
    if (upper === NETWORK_IN || upper === NETWORK_OUT || upper === NETWORK_NOT_CONFIRMED || upper === NETWORK_NEED_MORE) {
      return upper;
    }
    if (/need\s*more\s*info/i.test(s)) return NETWORK_NEED_MORE;
    if (/not\s*confirmed/i.test(s)) return NETWORK_NOT_CONFIRMED;
    if (/^(in[-\s]?network|inn|in|true|yes)$/i.test(s) || /\bin[-\s]?network\b/i.test(s)) return NETWORK_IN;
    if (/^(out(?:\s+of)?[-\s]?network|oon|out|false|no)$/i.test(s) || /\bout(?:\s+of)?[-\s]?network\b/i.test(s)) {
      return NETWORK_OUT;
    }
    return "";
  }

  function bucketToExportStatus(bucket) {
    if (bucket === NETWORK_IN) return "In network";
    if (bucket === NETWORK_OUT) return "Out of network";
    if (bucket === NETWORK_NOT_CONFIRMED) return "Not confirmed";
    if (bucket === NETWORK_NEED_MORE) return "Need more info";
    return "";
  }

  function extractZip(text) {
    const t = String(text || "");
    const fl = t.match(/\b(3[0-4]\d{3})(?:-\d{4})?\b/);
    if (fl) return fl[1];
    const any = t.match(/\b(\d{5})(?:-\d{4})?\b/);
    return any ? any[1] : "";
  }

  function extractCounty(text) {
    const t = String(text || "");
    if (/\bmiami[- ]?dade\b|\bdade\b/i.test(t)) return "Miami-Dade";
    if (/\bbroward\b/i.test(t)) return "Broward";
    if (/\bpalm\s*beach\b/i.test(t)) return "Palm Beach";
    return "";
  }

  function extractContacts(text) {
    const t = String(text || "");
    const labeled = t.match(/\bcontacts?\s*[:=]\s*([^\n]{3,200})/i);
    if (labeled) return clip(labeled[1], 200);
    const phone = t.match(/\b(\d{3}[-.\s]\d{3}[-.\s]\d{4})\b/);
    return phone ? phone[1] : "";
  }

  function extractNeeds(text) {
    const t = String(text || "");
    const labeled = t.match(/\b(?:needs?|looking for|priorities)\s*[:=]\s*([^\n]{3,300})/i);
    if (!labeled) return [];
    return labeled[1]
      .split(/[;,•]/)
      .map((s) => clip(s, 120))
      .filter(Boolean)
      .slice(0, 8);
  }

  function extractClientNameFromThread(thread) {
    const exp =
      (typeof globalThis !== "undefined" && globalThis.MaxComparisonExport) ||
      (typeof window !== "undefined" && window.MaxComparisonExport) ||
      null;
    if (!exp || typeof exp.extractClientName !== "function") return "";
    return clip(exp.extractClientName(thread), 80);
  }

  function slimPlan(plan) {
    if (!plan || typeof plan !== "object") return null;
    const planId = clip(plan.planId || plan.id || "", 40);
    if (!planId) return null;
    return {
      planId: planId,
      id: clip(plan.id || plan.planId || "", 40),
      planName: clip(plan.planName || "", 120),
      carrier: clip(plan.carrier || "", 80),
      county: clip(plan.county || "", 40),
    };
  }

  function doctorsFromExport(payload) {
    const plans = (payload && payload.plans) || [];
    const doctors = (payload && payload.doctors) || [];
    const out = [];
    doctors.forEach((d) => {
      if (!d || typeof d !== "object") return;
      const name = clip(d.name || "", 80);
      if (!name) return;
      const byPlanId = {};
      if (d.byPlanId && typeof d.byPlanId === "object") {
        Object.keys(d.byPlanId).forEach((id) => {
          const bucket = normalizeNetworkBucket(d.byPlanId[id]);
          if (bucket) byPlanId[id] = bucket;
        });
      }
      if (Array.isArray(d.statuses)) {
        d.statuses.forEach((status, i) => {
          const plan = plans[i];
          const bucket = normalizeNetworkBucket(status);
          if (bucket && plan) byPlanId[displayPlanId(plan)] = bucket;
        });
      }
      if (Object.keys(byPlanId).length) out.push({ name: name, byPlanId: byPlanId });
    });
    return out;
  }

  function medicationsFromExport(payload) {
    const drugs = (payload && payload.drugs) || [];
    const out = [];
    drugs.forEach((d) => {
      if (!d || typeof d !== "object") return;
      if (d.claimedTier != null) {
        /* discarded forever — never copy Daisy / client-stated tiers */
      }
      const name = clip(d.name || d.drug || "", 48);
      if (!name) return;
      const map = d.byPlanId || {};
      const byPlanId = {};
      Object.keys(map).forEach((id) => {
        const incoming = map[id] || {};
        if (!incoming.verified) return;
        const tier = Number(incoming.tier);
        const coverage = incoming.coverage === "not_covered" ? "not_covered" : incoming.coverage || null;
        if (!(tier >= 1 && tier <= 6) && coverage !== "not_covered") return;
        byPlanId[id] = {
          verified: true,
          tier: tier >= 1 && tier <= 6 ? tier : null,
          coverage: coverage,
          costShare: incoming.costShare ? clip(incoming.costShare, 40) : null,
          pa: incoming.pa === true ? true : incoming.pa === false ? false : null,
          st: incoming.st === true ? true : incoming.st === false ? false : null,
          source: incoming.source ? clip(incoming.source, 40) : null,
        };
      });
      if (Object.keys(byPlanId).length) out.push({ name: name, byPlanId: byPlanId });
    });
    return out;
  }

  function buildWorkupFromExport(payload, extras) {
    const extra = extras && typeof extras === "object" ? extras : {};
    const src = payload && typeof payload === "object" ? payload : {};
    const thread = extra.threadText || "";
    const plans = (Array.isArray(src.plans) ? src.plans : []).map(slimPlan).filter(Boolean).slice(0, 6);
    // Prefer a labeled name just stated in the thread over an empty/stale export payload.
    const extractedName = extractClientNameFromThread(thread);
    const clientName = clip(extractedName || extra.clientName || src.clientName || "", 80);
    const zip = clip(extra.zip || src.zip || extractZip(thread), 10);
    const county = clip(extra.county || src.county || extractCounty(thread) || (plans[0] && plans[0].county) || "", 40);
    const contacts = clip(extra.contacts || src.contacts || extractContacts(thread), 200);
    const needs = Array.isArray(extra.needs) && extra.needs.length ? extra.needs.map((n) => clip(n, 120)).filter(Boolean).slice(0, 8) : extractNeeds(thread);
    const terminatingPlan = clip(extra.terminatingPlan || src.terminatingPlan || "", 90);
    return {
      id: extra.id || src.id || "",
      clientName: clientName,
      zip: zip,
      county: county,
      contacts: contacts,
      plans: plans,
      planIds: plans.map((p) => p.planId),
      doctors: doctorsFromExport(src),
      medications: medicationsFromExport(src),
      needs: needs,
      terminatingPlan: terminatingPlan,
    };
  }

  function planIdKey(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function planMatches(catalogPlan, slim) {
    const want = planIdKey(slim.planId || slim.id);
    if (!want) return false;
    const pid = planIdKey(catalogPlan.planId);
    const id = planIdKey(catalogPlan.id);
    const hit = (pid && (pid === want || pid.indexOf(want) >= 0 || want.indexOf(pid) >= 0)) || (id && (id === want || id.indexOf(want) >= 0 || want.indexOf(id) >= 0));
    if (!hit) return false;
    if (slim.county && catalogPlan.county && slim.county !== catalogPlan.county) return false;
    return true;
  }

  function rehydratePlans(workupPlans, catalog) {
    const slims = Array.isArray(workupPlans) ? workupPlans : [];
    const list = Array.isArray(catalog) ? catalog : [];
    return slims.map((slim) => {
      const match = list.find((p) => planMatches(p, slim));
      return match || slim;
    });
  }

  function workupToExportPayload(workup, catalog) {
    const w = workup && typeof workup === "object" ? workup : {};
    const plans = rehydratePlans(w.plans, catalog);
    const doctors = (w.doctors || []).map((d) => ({
      name: d.name,
      byPlanId: Object.fromEntries(
        Object.entries(d.byPlanId || {}).map(([id, bucket]) => [id, bucketToExportStatus(bucket)])
      ),
    }));
    const drugs = (w.medications || []).map((m) => ({
      name: m.name,
      byPlanId: m.byPlanId || {},
    }));
    return {
      plans: plans,
      clientName: w.clientName || "",
      terminatingPlan: w.terminatingPlan || "",
      doctors: doctors,
      drugs: drugs,
    };
  }

  function compactWorkupContext(workup) {
    const w = workup && typeof workup === "object" ? workup : {};
    const lines = [
      WORKUP_CONTEXT_PREFIX + " (structured facts only — not a prior chat transcript). Continue this comparison. Do not ask to re-paste Daisy. Discard any client-stated Rx tiers. Call lookup_formulary for any unverified drug × named plan.",
    ];
    if (w.clientName) lines.push("Client: " + w.clientName);
    const place = [w.zip, w.county].filter(Boolean).join(" / ");
    if (place) lines.push("ZIP/county: " + place);
    if (w.contacts) lines.push("Contacts: " + w.contacts);
    const plans = w.plans || [];
    if (plans.length) {
      lines.push("Plans:");
      plans.forEach((p) => lines.push("- " + marketingLabel(p)));
    }
    const doctors = w.doctors || [];
    if (doctors.length) {
      lines.push("Doctors:");
      doctors.forEach((d) => {
        const bits = Object.keys(d.byPlanId || {}).map((id) => id + " " + d.byPlanId[id]);
        lines.push("- " + d.name + (bits.length ? ": " + bits.join("; ") : ""));
      });
    }
    const meds = w.medications || [];
    if (meds.length) {
      lines.push("Medications (verified formulary only):");
      meds.forEach((m) => {
        const bits = Object.keys(m.byPlanId || {}).map((id) => {
          const st = m.byPlanId[id] || {};
          if (st.coverage === "not_covered") return id + " Not covered";
          const cost = st.costShare ? " · " + st.costShare : "";
          return id + " Tier " + (st.tier || "?") + cost;
        });
        lines.push("- " + m.name + (bits.length ? ": " + bits.join("; ") : ""));
      });
    }
    const needs = w.needs || [];
    if (needs.length) {
      lines.push("Needs:");
      needs.forEach((n) => lines.push("- " + n));
    }
    if (w.terminatingPlan) lines.push("Plan Terminating: " + w.terminatingPlan);
    return lines.join("\n");
  }

  function isWorkupContextMessage(content) {
    const text = typeof content === "string" ? content : "";
    return text.indexOf(WORKUP_CONTEXT_PREFIX) === 0;
  }

  function messagesForApi(history, loadedWorkup) {
    const chat = (history || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({ role: m.role, content: m.content }));
    if (!loadedWorkup) return chat;
    const compact = compactWorkupContext(loadedWorkup);
    if (!compact) return chat;
    if (chat[0] && chat[0].role === "user" && isWorkupContextMessage(chat[0].content)) return chat;
    return [{ role: "user", content: compact }].concat(chat);
  }

  function workupListLabel(workup) {
    if (workup && workup.clientName) return workup.clientName;
    const ids = ((workup && workup.planIds) || []).slice(0, 2).join(" / ");
    return ids ? "Unnamed — " + ids : "Unnamed workup";
  }

  function formatUpdatedAt(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  return {
    WORKUP_CONTEXT_PREFIX,
    NETWORK_IN,
    NETWORK_OUT,
    NETWORK_NOT_CONFIRMED,
    NETWORK_NEED_MORE,
    normalizeNetworkBucket,
    bucketToExportStatus,
    extractZip,
    extractCounty,
    extractContacts,
    extractNeeds,
    buildWorkupFromExport,
    workupToExportPayload,
    compactWorkupContext,
    isWorkupContextMessage,
    messagesForApi,
    workupListLabel,
    formatUpdatedAt,
    rehydratePlans,
  };
});
