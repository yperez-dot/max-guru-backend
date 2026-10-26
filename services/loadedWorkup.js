// services/loadedWorkup.js — every set decision on a LOADED CLIENT WORKUP, in one place (overhaul, 2026-10-17).
//
// Yahoska's rules:
//   PLANS    keep every saved plan; add the plans / carriers she names; drop only on an explicit drop / remove /
//            without; narrow only on only / just / compare-these / keep-the-same-N; "it" never drops the current
//            plan; no sibling plans she did not ask for; her current plan is the first column.
//   DOCTORS  keep every saved doctor; her corrected spelling replaces the stale row; remove only the doctors she
//            names; a near-duplicate is asked about (never auto-dropped); rows merge only on the exact same NPI.
//   MEDS     keep every saved med (pharmacy-label names normalized, never dropped); remove only the meds she names.
//
// doctorPlanNarrow.js (comparisonAskText / namedPlansFromAsk / comparisonFollowUp / selectComparison) and the golden
// suite (services/golden) read these rules from here. Plan-grid helpers stay in doctorPlanNarrow (lazy require: it
// requires this file).

const R = require('./comparisonRules');
const DN = require('../artifacts/doctor-name.js');

const { plainWords, sameDoctorName, cleanName } = DN;
const N = () => require('./doctorPlanNarrow');
const carrierKey = (x) => N().carrierKey(x);
const carrierOf = (x) => N().carrierOf(x);
const gridRowFor = (id, county) => N().gridRowFor(id, county);
const corePlanIdsFor = (c, county) => N().corePlanIdsFor(c, county);

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  return '';
}

// ═══ PLANS ═══════════════════════════════════════════════════════════════════════════════════════════════════
/** Names / ZIP / plan IDs from the saved-workup context message the UI sends ("Loaded client workup …"). */
function workupFacts(msgs) {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const t = messageText(msgs[i]);
    if (!/Doctors \(names only/.test(t) && !/^Plans:/m.test(t)) continue;
    if (!/structured facts only/i.test(t)) continue;
    const docLine = (t.match(/^Doctors \(names only[^)]*\):\s*(.+)$/m) || [])[1] || '';
    const doctors = docLine.split(';').map((x) => x.replace(/\s*\*\s*$/, '').trim()).filter(Boolean);
    const plansBlock = (t.match(/^Plans:\s*\n((?:- .*\n?)+)/m) || [])[1] || '';
    const plans = [...plansBlock.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
    const zip = ((t.match(/^ZIP\/county:\s*(\d{5})/m) || [])[1]) || '';
    // Only the "Current plan:" line is her plan; the other saved plans are comparison columns
    // (Aetna H1609-093 was called her current plan — Maura, 2026-10-07). An old save with one plan: that one.
    const curLine = (t.match(/^Current plan(?:\(s\))?:\s*(.+)$/m) || [])[1] || '';
    const current = curLine
      ? [...curLine.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase())
      : (plans.length === 1 ? plans : []);
    // "Doctor NPIs (…): Jorge Perez NPI 1234567893; Ana Ruiz (PCP) NPI 1999999999" — which saved doctors are resolved.
    const npiLine = (t.match(/^Doctor NPIs[^:]*:\s*(.+)$/m) || [])[1] || '';
    const npis = {};
    for (const part of npiLine.split(';')) {
      const m = part.match(/^\s*(.+?)(?:\s*\([^)]*\))?\s+NPI\s+(\d{10})\s*$/);
      if (m) npis[m[1].trim()] = m[2];
    }
    const intakeLines = [];
    for (const re of [
      /^No Medicaid\.?$/m,
      /^Medicaid:\s+.+$/m,
      /^Full Medicaid.*$/m,
      /^MSP only.*$/m,
      /^C-SNP qualifying condition confirmed:.*$/m,
      /^No C-SNP qualifying condition\.?$/m,
      /^Must-keep doctors:.*$/m,
      /^Show quantity limits\.?$/m,
    ]) {
      const hit = t.match(re);
      if (hit) intakeLines.push(hit[0].replace(/\s+$/, '').replace(/\.$/, '') + '.');
    }
    const showQl = /Show quantity limits/i.test(t);
    const eligibility = {
      medicaid: /^No Medicaid/m.test(t) ? 'none' : /^Full Medicaid|^Medicaid:\s+full/im.test(t) ? 'full' : /^MSP only|^Medicaid:\s+MSP/im.test(t) ? 'msp' : 'unknown',
      csnp: /^C-SNP qualifying condition confirmed/m.test(t) ? 'confirmed' : /^No C-SNP qualifying condition/m.test(t) ? 'none' : 'unknown',
    };
    return { doctors, plans, zip, current, npis, intakeLines, showQl, eligibility };
  }
  return null;
}

function workupCarrierEditSet(text, msgs) {
  const t = String(text || '');
  const wk = workupFacts(msgs);
  if (!wk || !wk.plans.length) return [];
  // Plan IDs typed: the named-plan logic already handles "drop H5420-001, add H1036-054C" (Maura, 2026-10-07).
  if (/\b[HR]\d{4}-\d{3}/i.test(t)) return [];
  const county = R.countyFromAsk(msgs.map(messageText).join('\n')) || 'Miami-Dade';
  const dropped = R.carriersRejected(t);
  const addCarriers = [];
  const addIds = [];
  for (const m of t.matchAll(/\b(?:add|include|plus)\s+([^.;\n]+?)(?=\s+(?:and\s+)?(?:drop|remove|delete|re-?\s*t?un|re-?run|run|then)\b|[.;\n]|$)/gi)) {
    const seg = m[1];
    const ids = [...seg.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((x) => x[1].toUpperCase());
    if (ids.length) { ids.forEach((id) => addIds.push(id)); continue; }
    if (/\b(?:dr|dra|doctor|doctora)\b\.?\s+[A-Z]/i.test(seg)) continue; // "add Dr. X" adds a doctor
    for (const c of R.carriersRequested(`add ${seg}`)) if (!addCarriers.includes(c)) addCarriers.push(c);
  }
  // An edit of the saved set needs a carrier drop. A bare "add doctors, devoted, and aetna" stays a carrier ask
  // (best plans per carrier — Gail Carreno, 2026-10-08).
  if (!dropped.length) return [];
  const rows = R.gridPlansForCounty(county);
  const rowOf = (id) => rows.find((g) => String(g.planId || g.id).toUpperCase().slice(0, 9) === String(id).toUpperCase().slice(0, 9)) || gridRowFor(id, '');
  const carrierOfId = (id) => { const g = rowOf(id); return g ? R.carrierOfPlan(g) : ''; };
  const nameOf = (id) => { const g = rowOf(id); if (!g) return id; return carrierKey(String(g.planName || '')) ? String(g.planName) : `${g.carrier || ''} ${g.planName || ''}`.trim(); };
  const fullId = (id) => { const g = rowOf(id); return g ? String(g.planId || g.id).toUpperCase() : String(id).toUpperCase(); };
  const offGrid = currentPlanRemovedBy(t, wk.current, carrierOfId);
  const isCur = (id) => (wk.current || []).some((c) => String(c).toUpperCase().slice(0, 9) === String(id).toUpperCase().slice(0, 9));
  let ids = wk.plans.filter((id) => !dropped.includes(carrierOfId(id)) || (isCur(id) && !offGrid.has(String(id).toUpperCase().slice(0, 9))));
  for (const c of addCarriers) {
    if (dropped.includes(c) || ids.some((id) => carrierOfId(id) === c)) continue;
    const core = corePlanIdsFor(c, county)[0];
    if (core) ids.push(fullId(core));
  }
  for (const id of addIds) if (!ids.some((x) => x.slice(0, 9) === id.slice(0, 9))) ids.push(id);
  ids = ids.filter((id, k) => ids.findIndex((x) => x.slice(0, 9) === id.slice(0, 9)) === k);
  return ids.map((id) => ({ planId: fullId(id), name: nameOf(id) }));
}

/**
 * Loaded workup + one plan she asks about: "Can you check this plan Devoted C-SNP ENHANCED H1290-067?", "No careplus, I
 * want Devoted C-SNP ENHANCED H1290-067", "pls remove careplus. add dvoted to the grid" → her saved plans (current plan
 * first, a carrier she drops taken off) + that plan. Never a C-SNP run or a carrier's "best" plans (Gerry Cabrera,
 * 2026-10-19: four unasked C-SNPs replaced the saved set and the current plan left the grid). [] when it is not that ask.
 */
const PLAN_ASK_VERB_RE = /\b(?:check|show|add|include|run|price|look\s*at|compare|want|try|see|put)\b/i;
const PLAN_EDIT_ONLY_RE = /\b(?:remove|drop|delete|take\s+(?:out|off)|without|instead\s+of|replace|swap|only|just)\b[^.;\n]{0,40}\b[HR]\d{4}-\d{3}/i;
/** "replace H0982-007 with H5431-018" / "remove X and replace with Y" / "add Y instead of X". */
function replacePlanPairs(text) {
  const t = String(text || '');
  const pairs = [];
  const add = (from, to) => {
    const a = String(from || '').toUpperCase().slice(0, 9);
    const b = String(to || '').toUpperCase().slice(0, 9);
    if (a && b && a !== b && !pairs.some((p) => p.from === a && p.to === b)) pairs.push({ from: a, to: b });
  };
  for (const m of t.matchAll(/\b(?:replace|swap)\s+([HR]\d{4}-\d{3}[A-Z]?)\s+(?:with|for|to)\s+([HR]\d{4}-\d{3}[A-Z]?)/gi)) add(m[1], m[2]);
  for (const m of t.matchAll(/\b(?:remove|drop|delete|take\s+(?:out|off)|without)\s+([HR]\d{4}-\d{3}[A-Z]?)\b[^.;\n]{0,80}?\b(?:replace|swap|add|include)\s+(?:(?:it|that|them)\s+)?(?:with|for)?\s*([HR]\d{4}-\d{3}[A-Z]?)/gi)) add(m[1], m[2]);
  for (const m of t.matchAll(/\b(?:add|include|put)\s+([HR]\d{4}-\d{3}[A-Z]?)\s+instead\s+of\s+([HR]\d{4}-\d{3}[A-Z]?)/gi)) add(m[2], m[1]);
  return pairs;
}
/** Plan IDs in the header of Max's newest Doctor × plan table in this chat (its columns, in order). */
function lastTablePlanIds(msgs) {
  const list = Array.isArray(msgs) ? msgs : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'assistant') continue;
    const head = messageText(m).split('\n').find((l) => /^\|\s*(?:Doctor|Drug)\s*\|/.test(l.trim()));
    if (!head) continue;
    return [...new Set([...head.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((x) => x[1].toUpperCase()))];
  }
  return [];
}

const currentPlanOf = (msgs) => N().currentPlanOf(msgs);

function workupPlanAddSet(text, msgs) {
  const t = String(text || '').replace(/\b([HR]\d{4})-(\d{1,3})(?:-\d)?(?=[^\dA-Za-z-]|$)/gi, (m, a, b) => `${a.toUpperCase()}-${b.padStart(3, '0')}`);
  // The plans she is adding to: her saved workup's plans plus the columns of Max's last table (what she was looking
  // at). "CAN YOU PLEASE RUN THIS SEARCH FOR HUMANA PPO Humana Choice H7617-107 AND … H7617-110" on a chat whose
  // table showed UHC H5420-001, Humana H1036-054C and DrMax H4140-022 adds two columns to those three
  // (Robert and Andrea, 2026-10-19: the model re-sent the old table and the two Humana PPOs never ran).
  // A saved workup with comparison plans keeps its own list (a stale or wrong column on the last table never comes
  // back — Gerry Cabrera's CarePlus H1019-121); the last table's columns are the base only when nothing else is saved.
  const wk0 = workupFacts(msgs);
  const shown = lastTablePlanIds(msgs);
  const wk = wk0 ? { ...wk0, plans: wk0.plans.slice() } : (shown.length ? { plans: [], current: currentPlanOf(msgs) } : null);
  const savedOthers = wk ? wk.plans.filter((id) => !(wk.current || []).some((c) => String(c).toUpperCase().slice(0, 9) === String(id).toUpperCase().slice(0, 9))) : [];
  if (wk && !savedOthers.length) wk.plans = [...wk.plans, ...shown.filter((id) => !wk.plans.some((x) => x.slice(0, 9) === id.slice(0, 9)))];
  if (!wk || !wk.plans.length || KEEP_EXACT_RE.test(t)) return [];
  const county = R.countyFromAsk(msgs.map(messageText).join('\n')) || 'Miami-Dade';
  const rows = R.gridPlansForCounty(county);
  const rowOf = (id) => rows.find((g) => String(g.planId || g.id).toUpperCase().slice(0, 9) === String(id).toUpperCase().slice(0, 9)) || gridRowFor(id, '');
  const carrierOfId = (id) => { const g = rowOf(id); return g ? R.carrierOfPlan(g) : ''; };
  const typed = [...t.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((x) => x[1].toUpperCase());
  const pairs = replacePlanPairs(t);
  let adds = [];
  // "add Humana Choice Giveback" / "run Humana Gold Plus too": grid plans she names by marketing name (one plan per name).
  const byName = typed.length ? [] : N().planNamesInAsk(t, county).ids;
  if (byName.length && PLAN_ASK_VERB_RE.test(t) && !PLAN_EDIT_ONLY_RE.test(t) && !ONLY_PLANS_RE.test(t) && !NEW_SET_VERB_RE.test(t)) {
    adds = byName;
  } else if (typed.length) {
    // "remove X and replace with Y": keep the saved set, put Y in X's place (Carla Nguyen, 2026-10-26).
    if (pairs.length) {
      adds = pairs.map((p) => p.to);
    } else if (!PLAN_ASK_VERB_RE.test(t) || PLAN_EDIT_ONLY_RE.test(t) || ONLY_PLANS_RE.test(t) || NEW_SET_VERB_RE.test(t)) return [];
    else if (typed.length > 1 && /\bcompare\b/i.test(t)) return [];
    else adds = typed;
  } else {
    // "add dvoted to the grid": the plan of that carrier she named earlier in this chat (H1290-067).
    const segs = [...t.matchAll(/\b(?:add|include|plus|put)\s+([^.;\n]+)/gi)].map((m) => m[1]);
    const cars = [...new Set(segs.flatMap((sg) => R.carriersRequested(`add ${sg}`)))];
    if (!cars.length) return [];
    const wkAt = msgs.map(messageText).findLastIndex((x) => /structured facts only/i.test(x));
    const earlier = msgs.slice(wkAt + 1).filter((m) => m && m.role === 'user').map(messageText).reverse();
    for (const c of cars) {
      const hit = earlier.flatMap((x) => [...x.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((y) => y[1].toUpperCase())).find((id) => carrierOfId(id) === c);
      if (!hit) return []; // no plan of that carrier in this chat: the carrier-ask rules decide
      adds.push(hit);
    }
  }
  const dropped = R.carriersRejected(t);
  const isCur = (id) => (wk.current || []).some((c) => String(c).toUpperCase().slice(0, 9) === String(id).toUpperCase().slice(0, 9));
  const nameOf0 = (id) => { const g = rowOf(id); if (!g) return id; return carrierKey(String(g.planName || '')) ? String(g.planName) : `${g.carrier || ''} ${g.planName || ''}`.trim(); };
  const rm = planRemovals(t, wk.plans.map((id) => ({ planId: String(id).toUpperCase(), name: nameOf0(id) })), wk.current || []);
  const removed = new Set(rm.remove.map((id) => id.toUpperCase().slice(0, 9)));
  for (const p of pairs) removed.add(p.from);
  let ids = wk.plans.filter((id) => isCur(id) || (!removed.has(String(id).toUpperCase().slice(0, 9)) && !dropped.includes(carrierOfId(id))));
  // A replacement sits in the removed plan's slot so the rest of the set keeps its order.
  for (const p of pairs) {
    if (dropped.includes(carrierOfId(p.to))) continue;
    const at = wk.plans.findIndex((x) => String(x).toUpperCase().slice(0, 9) === p.from);
    if (at >= 0 && !ids.some((x) => x.slice(0, 9) === p.to.slice(0, 9))) {
      const before = ids.filter((x) => wk.plans.findIndex((y) => String(y).toUpperCase().slice(0, 9) === String(x).toUpperCase().slice(0, 9)) < at);
      ids = [...before, p.to, ...ids.filter((x) => !before.includes(x))];
    } else if (!ids.some((x) => x.slice(0, 9) === p.to.slice(0, 9))) ids.push(p.to);
  }
  for (const id of adds) if (!dropped.includes(carrierOfId(id)) && !removed.has(String(id).toUpperCase().slice(0, 9)) && !ids.some((x) => x.slice(0, 9) === id.slice(0, 9))) ids.push(id);
  ids = currentPlanFirst(ids, wk.current);
  if (ids.length === wk.plans.length && ids.every((id, k) => id === wk.plans[k]) && !adds.length) return [];
  const nameOf = (id) => { const g = rowOf(id); if (!g) return id; return carrierKey(String(g.planName || '')) ? String(g.planName) : `${g.carrier || ''} ${g.planName || ''}`.trim(); };
  const fullId = (id) => { const g = rowOf(id); return g ? String(g.planId || g.id).toUpperCase() : String(id).toUpperCase(); };
  const set = ids.map((id) => ({ planId: fullId(id), name: nameOf(id) }));
  // The plans she just added: never trimmed off the grid to make room (they are the point of her message).
  set.added = adds.filter((id) => set.some((p) => p.planId.slice(0, 9) === id.slice(0, 9))).map(fullId);
  return set;
}

/**
 * Plans the agent asked to compare, following her edits across the thread:
 * "Compare Humana H1036-065C, Aetna H1609-018, Devoted H1290-073" then
 * "remove devoted, add UHC H1045-005 instead" → Humana, Aetna, UHC.
 * Named plans are the columns — Max never swaps in its own top 3.
 */
// Lines of the loaded-workup context message (client-workups.js compactWorkupContext). Only its "Plans:"
// list is a plan set; the saved In/Out and medication lines carry the IDs of OLD comparison columns
// (Aetna H1609-093 …) and must never become columns (Jacqueline Alexander, 2026-10-17: her 3 named plans
// were added to 4 stale IDs from those lines, then cut to "best 2 of the other 5").
const WORKUP_LINE_RE = /^\s*(?:Client|ZIP\/county|Contacts|Current plan(?:\(s\))?|Plan Terminating):|^\s*(?:Plans|Needs):\s*$|^\s*Doctors \(names only|^\s*Doctor NPIs\b|^\s*Saved In\/Out results\b|^\s*Medications \(tiers\b/;

// "Keep the same 3 plans (UHC H5420-001, …)" / "only these plans: …": that list IS the set — nothing added.
const KEEP_EXACT_RE = /\b(?:keep|same|only|just|exactly|these)\b[^.;\n]{0,30}\bplans?\b|\bplans?\s+(?:only|exactly)\b/i;

// A plan-set edit needs a plan (ID or carrier) in the same sentence as the edit verb: "Replace Dr. Natalie
// Regalado with …" / "Remove Dr. Pasquel DeSantis …" edit doctors, not the plan list.
const PLAN_EDIT_VERB_RE = /\b(add|also|include|plus|instead|swap|replace|in place of|remove|drop|take out|delete|no more|get rid of|without)\b/i;

function isPlanEditLine(line) {
  return String(line || '').split(/(?<=[.!?])\s+/).some((s) => PLAN_EDIT_VERB_RE.test(s)
    && (/\b[HR]\d{4}-\d{3}/i.test(s) || Boolean(carrierKey(s.replace(/\b(?:dr|dra|doctor|doctora)\.?\s+[A-Z][^,.;]*/g, ' ')))));
}

// A pasted list of 2+ plans with a "use these" verb is a new set: "okao lets do H5420-014, H4140-022, …" (Gail Carreno).
const PLAN_START = String.raw`(?=["“]|[HR]\d{4}-|(?:uhc|united\w*|humana|aetna|devoted|doctors|solis|careplus|simply|wellcare|healthsun|florida\s+blue|these|those|this|plans?)\b)`;

const NEW_SET_VERB_RE = new RegExp(String.raw`\blet'?s\s+do\s+` + PLAN_START + String.raw`|^\s*(?:ok\w*[\s,]+)?do\s+` + PLAN_START + String.raw`|\buse\s+` + PLAN_START + String.raw`|\bgo\s+with\b|\bswitch\s+to\b|\bchange\s+(?:it\s+)?to\b|\brun\s+(?:these|them|it\s+on)\b`, 'i');

// A new plan set needs clear intent: "only H5420-001", "H5420-001 only", "just these plans", "just H1609-093".
// "just check Glinos on H5420-001" is not a new set ("just" there means "simply").
const ONLY_PLANS_RE = /\bonly\b|\bexclusively\b|\bjust\s+(?:(?:the|these|this|that|on|use|keep|show|compare|run)\s+)*(?:[HR]\d{4}-\d{3}|plans?\b|one\s+plan\b)/i;

// Stop at "and add" / ", add" / "from the table" — never at "and H1036-305" or ", H1036-305".
const REMOVE_RE = /\b(?:remove|drop|take out|delete|no more|get rid of|without|exclude|excluding)\s+(?:the\s+)?([^.;\n]+?)(?=\s+(?:from\b|and\s+(?:add|include|replace|swap|instead|keep|show|plus|with)\b)|,\s*(?:add|include|replace|swap|instead|keep|show|plus|with)\b|[.;\n]|$)/gi;

// "remove it" / "drop that one" / "take this off": a pronoun never names a plan — and never drops her current plan.
const PRONOUN_TARGET_RE = /^(?:it|that|this|them|those|these|that one|this one|the other(?: one)?|one)\b/i;
/** IDs (first 9 chars) she drops in this line ("Drop MedicareMax H5420-001") — they never come back as columns. */
function droppedIdsIn(line) {
  const dropped = new Set();
  for (const r2 of String(line || '').matchAll(/\b(?:remove|drop|take out|delete|no more|get rid of|without)\s+([^.;\n]*)/gi)) {
    const target = r2[1].split(/\s*(?:,\s*|\band\s+)?(?:add|instead|but|then|show|keep|include|plus|with)\b/i)[0];
    for (const idm of target.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)) dropped.add(idm[1].toUpperCase().slice(0, 9));
  }
  // "take H5420-001 off the grid"
  for (const m of String(line || '').matchAll(OFF_GRID_RE)) {
    for (const idm of String(m[1] || '').matchAll(/\b([HR]\d{4}-\d{3})/gi)) dropped.add(idm[1].toUpperCase());
  }
  return dropped;
}
// Her current plan leaves the grid only when she says so outright (Yahoska, 2026-10-17): "remove uhc off the grid",
// "remove the current plan", "take H5420-001 off the grid", or a drop that types its ID. "drop UHC" / "exclude UHC"
// drops UHC's other plans and keeps her current one.
const OFF_GRID_RE = /\b(?:remove|take|drop|delete|pull|get)\b([^.;\n]{0,60}?)\b(?:off|out\s+of|from)\s+(?:of\s+)?(?:the\s+|her\s+|this\s+)?(?:grid|table|comparison|columns?)\b/gi;
const DROPS_CURRENT_RE = /\b(?:without|not|exclude|excluding|skip|drop|remove|take\s+out|delete|no)\s+(?:her\s+|the\s+|my\s+|his\s+)?current(?:\s+plans?)?\b/i;
/** Her current plan IDs (first 9 chars) this line takes off the grid. carrierOfId(id) → that plan's carrier. */
function currentPlanRemovedBy(line, currentIds, carrierOfId) {
  const t = String(line || '');
  const cur = (currentIds || []).map((x) => String(x).toUpperCase().slice(0, 9));
  const out = new Set();
  if (!cur.length) return out;
  if (DROPS_CURRENT_RE.test(t)) cur.forEach((id) => out.add(id));
  for (const id of droppedIdsIn(t)) if (cur.includes(id)) out.add(id);
  for (const m of t.matchAll(OFF_GRID_RE)) {
    const seg = m[1] || '';
    if (/\bcurrent\b/i.test(seg)) cur.forEach((id) => out.add(id));
    for (const idm of seg.matchAll(/\b([HR]\d{4}-\d{3})/gi)) if (cur.includes(idm[1].toUpperCase())) out.add(idm[1].toUpperCase());
    const c = carrierOf(seg);
    if (c && carrierOfId) cur.filter((id) => carrierOfId(id) === c).forEach((id) => out.add(id));
  }
  return out;
}

/**
 * The plans a line's "remove devoted" / "drop H1290-073" leaves. A target matches a plan by its ID, its carrier, or
 * whole words of its name — never a substring: "remove it" used to drop every plan whose name holds "it" (UnITed…,
 * so her current UHC plan went). A pronoun never removes anything.
 */

// Plan removals in one message, matched against the plans in the CURRENT table ([{ planId, name }]).
// Exact (applied): a plan ID, a carrier by name ("remove careplus", "the doctors plan"), or every word of a plan name.
// Anything else — a typo or swapped words ("Doctors Dade Mac" for Doctors DrMax-Dade) — is never guessed: one close
// plan is asked as "Remove X (ID)? (yes/no)", several are listed, none is said in one line (Evelyn Nieves, 2026-10-20:
// "lets remove Doctors Dade Mac and add … H1036-121" added H1036-121 and silently kept H4140-022).
const REMOVAL_STOP = new Set(['the', 'plan', 'plans', 'column', 'columns', 'one', 'from', 'table', 'grid', 'please', 'pls', 'her', 'his', 'option', 'lets', 'let', 's']);
const CARRIER_WORDS = { careplus: 'CarePlus', humana: 'Humana', aetna: 'Aetna', devoted: 'Devoted', solis: 'Solis', wellcare: 'Wellcare', simply: 'Simply', uhc: 'UnitedHealthcare', unitedhealthcare: 'UnitedHealthcare', aarp: 'UnitedHealthcare', doctors: 'Doctors HealthCare', doctor: 'Doctors HealthCare' };
function removalTokens(x) {
  return String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !REMOVAL_STOP.has(w));
}
function planTokens(name) {
  const raw = String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const out = new Set(raw.replace(/unitedhealthcare/g, 'unitedhealthcare united healthcare uhc').replace(/careplus/g, 'careplus care plus').split(/[^a-z0-9]+/).filter(Boolean));
  // "DrMax-Dade" also reads as "dr", "max"; "MedicareMax" as "medicare", "max".
  for (const w of raw.split(/[^a-z0-9]+/)) {
    const m = w.match(/^(dr|medicare|care|gold|choice)(.+)$/);
    if (m) { out.add(m[1]); out.add(m[2]); }
  }
  return [...out];
}
function editDistance(x, y) {
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) cur[j] = Math.min(row[j] + 1, cur[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    row = cur;
  }
  return row[y.length];
}
function planRemovals(text, plans, currentIds = [], opts = {}) {
  const out = { remove: [], confirm: [], unmatched: [] };
  const list = (plans || []).filter((p) => p && p.planId);
  if (!list.length) return out;
  const cur = (currentIds || []).map((x) => String(x).toUpperCase().slice(0, 9));
  const isCur = (p) => cur.includes(p.planId.toUpperCase().slice(0, 9));
  const carrierOfP = (p) => carrierOf(p.name) || (() => { const g = gridRowFor(p.planId, ''); return g ? R.carrierOfPlan(g) : ''; })();
  const skipWords = (opts.skip || []).map((x) => String(x || '').toLowerCase()).filter(Boolean);
  for (const r of String(text || '').matchAll(REMOVE_RE)) {
    const target = r[1].trim();
    const low = target.toLowerCase();
    if (!low || PRONOUN_TARGET_RE.test(low)) continue;
    // "remove Dr. Pasquel …" (the capture stops at the period): a doctor row, not a plan.
    if (/^(?:dr|dra|doctor|doctora)$/.test(low) && /^\s*\.?\s*[A-Za-z]/.test(String(text).slice(r.index + r[0].length))) continue;
    if (/^(?:dr|dra|doctor|doctora)\.?\s+[a-z]/i.test(low) && !/^doctors?\s+(?:health|dr|plan)/i.test(low)) continue;
    if (/\brows?\b|\bmeds?\b|\bmedications?\b|\bdoctors?\s+(?:rows?|list)\b/.test(low)) continue;
    // A saved doctor or med she is removing is not a plan.
    if (skipWords.some((w) => w && (low.includes(w) || w.includes(low)))) continue;
    const ids = [...target.matchAll(/\b([HR]\d{4}-\d{1,3})/gi)].map((x) => x[1].toUpperCase().replace(/-(\d{1,3})$/, (m, d) => `-${d.padStart(3, '0')}`));
    if (ids.length) {
      for (const id of ids) {
        const hit = list.find((p) => p.planId.toUpperCase().slice(0, 9) === id.slice(0, 9));
        if (hit) out.remove.push(hit.planId);
        else out.unmatched.push(target);
      }
      continue;
    }
    const words = removalTokens(target);
    if (!words.length) continue;
    // Carrier only ("careplus", "the doctors plan", "humana plans").
    const carriers = [...new Set(words.map((w) => CARRIER_WORDS[w]).filter(Boolean))];
    if (carriers.length === 1 && words.every((w) => CARRIER_WORDS[w] === carriers[0])) {
      const hits = list.filter((p) => carrierOfP(p) === carriers[0] && !isCur(p));
      if (hits.length) { out.remove.push(...hits.map((p) => p.planId)); continue; }
      out.unmatched.push(target);
      continue;
    }
    // Every word of a plan name (any order).
    const exact = list.filter((p) => { const pt = planTokens(`${p.name} ${carrierOfP(p)}`); return words.every((w) => pt.includes(w)); });
    if (exact.length) { out.remove.push(...exact.filter((p) => !isCur(p) || exact.length === 1).map((p) => p.planId)); continue; }
    // Close but not exact: scored, then asked.
    const near = (a, b) => a === b || (Math.min(a.length, b.length) >= 3 && editDistance(a, b) <= (Math.min(a.length, b.length) >= 6 ? 2 : 1)) || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
    const scored = list.map((p) => {
      const pt = planTokens(`${p.name} ${carrierOfP(p)}`);
      const hit = words.filter((w) => pt.some((x) => near(w, x))).length;
      return { p, score: hit / words.length };
    }).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score);
    if (!scored.length) { out.unmatched.push(target); continue; }
    const best = scored.filter((x) => x.score === scored[0].score).map((x) => x.p);
    out.confirm.push({ target, plans: best });
  }
  out.remove = [...new Set(out.remove)];
  return out;
}
/** One-line questions / notes for planRemovals results (shared by chat and the compare card). */
function planRemovalLines(rm, plans = []) {
  const lines = [];
  const label = (p) => `${p.name} (${p.planId})`;
  for (const c of rm.confirm || []) {
    lines.push(c.plans.length === 1
      ? `Did you mean remove ${label(c.plans[0])}? (yes/no)`
      : `"${c.target}" could be ${c.plans.map(label).join(' or ')} — which one should I remove?`);
  }
  for (const u of rm.unmatched || []) {
    lines.push(`Couldn't find "${u}" in the table${plans.length ? ` (${plans.map((p) => p.planId).join(', ')})` : ''} — nothing removed.`);
  }
  return lines;
}

function removePlansNamedIn(current, line, currentIds) {
  let out = current.slice();
  const cur = (currentIds || []).map((x) => String(x).toUpperCase().slice(0, 9));
  const offGrid = currentPlanRemovedBy(line, cur, (id) => { const p = current.find((q) => q.planId.slice(0, 9).toUpperCase() === id); const g = gridRowFor(id, ''); return p ? carrierOf(p.name) : (g ? R.carrierOfPlan(g) : ''); });
  // Same matcher as the chat's removal questions (planRemovals): only an exact ID / carrier / plan-name removal applies
  // here; a close match waits for her yes.
  const rm = planRemovals(line, out, []);
  const gone = new Set(rm.remove.map((id) => id.toUpperCase().slice(0, 9)));
  const byId = new Set([...String(line || '').matchAll(REMOVE_RE)].flatMap((r) => [...r[1].matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((x) => x[1].toUpperCase())));
  // A carrier or name drop never takes her current plan; only an off-the-grid / current-plan / ID removal does.
  out = out.filter((p) => {
    const id9 = p.planId.slice(0, 9).toUpperCase();
    if (!gone.has(id9)) return true;
    return cur.includes(id9) && !offGrid.has(id9) && !byId.has(id9);
  });
  // "take H5420-014 off the grid" / "remove uhc off the grid" / "remove the current plan".
  for (const m of String(line || '').matchAll(OFF_GRID_RE)) {
    const seg = m[1] || '';
    const ids = [...seg.matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((x) => x[1].toUpperCase());
    const c = ids.length ? '' : carrierOf(seg);
    out = out.filter((p) => !ids.includes(p.planId.slice(0, 9).toUpperCase()) && !(c && carrierOf(p.name) === c));
  }
  return out.filter((p) => !offGrid.has(p.planId.slice(0, 9).toUpperCase()));
}
/**
 * How a line that names plans changes the set: 'new' (replace: only / just / keep the same N / compare these /
 * lets do X, Y), 'add' (on a loaded workup: keep every saved plan, add what is new), 'edit' (add to the set),
 * 'replace' (no workup: the named plans are the set).
 */
function planLineVerdict(line, found, { fromWorkup = false, haveSet = false } = {}) {
  const keepExact = found.length >= 2 && KEEP_EXACT_RE.test(line);
  const newSet = keepExact || ONLY_PLANS_RE.test(line) || (found.length >= 2 && NEW_SET_VERB_RE.test(line) && !isPlanEditLine(line));
  if (fromWorkup && haveSet && !newSet) return 'add';
  if (!keepExact && isPlanEditLine(line) && haveSet) return 'edit';
  return newSet ? 'new' : 'replace';
}
// "compare X and Y with her current plan" / "… vs what she has": a new set that still holds her current plan.
const KEEPS_CURRENT_RE = /\b(?:(?:her|his|the|their)\s+current(?:\s+plan)?|current\s+plan|what\s+(?:she|he)\s+(?:has|have)|(?:her|his)\s+(?:own\s+)?plan)\b/i;
function lineKeepsCurrentPlan(line) {
  return KEEPS_CURRENT_RE.test(String(line || '')) && !/\b(?:without|not|drop|remove|except|no)\s+(?:(?:her|his|the)\s+)?current\b/i.test(String(line || ''));
}
/** Her current plan first, the rest in order. */
function currentPlanFirst(plans, currentIds) {
  const cur = (currentIds || []).map((x) => String(x).toUpperCase().slice(0, 9));
  if (!cur.length) return plans.slice();
  const key = (p) => String((p && (p.planId || p.id)) || p || '').toUpperCase().slice(0, 9);
  return [...plans.filter((p) => cur.includes(key(p))), ...plans.filter((p) => !cur.includes(key(p)))];
}

// ═══ DOCTORS ═════════════════════════════════════════════════════════════════════════════════════════════════
// "Dr. Edgardo de Arriba …" in her message: the same doctor as the saved "Edgardo Dearriba" (same letters, spaces /
// hyphens / particles aside). Her spelling replaces the stale saved row in the re-run (Nancy Blanco De Pajaro, 2026-10-17).
function respelledDoctors(latest, doctors) {
  const said = [...String(latest || '').matchAll(/\b(?:Dr|Dra|Doctor|Doctora)\.?\s+([A-ZÀ-Ý][\wÀ-ÿ'’-]*(?:\s+(?:(?:de|del|la|las|los|da|das|do|dos|di|du|van|von|der|le|y)\s+)*[A-ZÀ-Ý][\wÀ-ÿ'’-]*){1,4})/g)].map((m) => m[1].trim());
  if (!said.length) return doctors;
  return doctors.map((nm) => said.find((s) => DN.sameNameIgnoringSpacing(nm, s) && s.replace(/\s+/g, ' ') !== nm) || nm);
}

/**
 * Her name for a doctor on the left of "X = Y" vs a saved / asked name, spelling aside: "Priscilla Escalona" ≈
 * "Priscila Escalona" (Evelyn Nieves, 2026-10-20 — the two-L spelling never matched the one-L row, so her pick was
 * dropped and the same question came back). Accents, Dr./MD, a missing middle name and a letter or two off are all the
 * same doctor; a different first or last name is not.
 */
function fuzzySameDoctor(known, said) {
  if (sameDoctorName(known, said)) return true;
  const strip = (x) => String(x || '').split(/\s+[-–—]\s+/)[0].replace(/\([^)]*\)/g, ' ');
  const a = plainWords(strip(known));
  const b = plainWords(strip(said));
  if (a.length < 2 || b.length < 2) return false;
  const lev = (x, y) => {
    let row = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i += 1) {
      const cur = [i];
      for (let j = 1; j <= y.length; j += 1) cur[j] = Math.min(row[j] + 1, cur[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      row = cur;
    }
    return row[y.length];
  };
  const near = (x, y) => x === y || (Math.min(x.length, y.length) >= 4 && lev(x, y) <= (Math.min(x.length, y.length) >= 7 ? 2 : 1));
  if (!near(a[0], b[0])) return false;
  // Last name she typed is one of the saved name's later words (two-part surnames: "Escalona Villasmil").
  if (!a.slice(1).some((w) => near(w, b[b.length - 1]))) return false;
  // Any middle word she typed is in the saved name (an initial is fine).
  return b.slice(1, -1).every((w) => w.length <= 1 || a.some((x) => near(x, w)));
}

/** Fuzzy "same doctor" for typo'd names: "Hoa Nguyne" ≈ "Hoa Nguyen", "Gloria St" ⊂ "Theresa Gloria St. Phillipe". */
function looseSameDoctor(known, said) {
  if (sameDoctorName(known, said)) return true;
  const a = plainWords(known);
  const b = plainWords(said);
  if (a.length < 2 || b.length < 2) return false;
  const lev = (x, y) => {
    let row = Array.from({ length: y.length + 1 }, (_, j) => j);
    for (let i = 1; i <= x.length; i += 1) {
      const cur = [i];
      for (let j = 1; j <= y.length; j += 1) cur[j] = Math.min(row[j] + 1, cur[j - 1] + 1, row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      row = cur;
    }
    return row[y.length];
  };
  return a[0] === b[0] && lev(a[a.length - 1], b[b.length - 1]) <= 2;
}

// "Remove Dr. Pasquel DeSantis Endocrinologist Baptist and both Neeta Erinjerri Surgeon rows, since Pascual De Santis
// and Neeta Jane Erinjeri are already on the list" (Jacqueline Alexander, 2026-10-17). A removal counts only for a
// doctor she NAMED: a saved row goes when every word of its name (before " - practice", role words dropped) is in
// the removal clause, spelled the same. So "Neeta Erinjerri - Surgeon …" (both rows) goes and "Neeta Jane Erinjeri"
// stays; the "since … already on the list" part is not a removal.
const DOCTOR_REMOVE_RE = /\b(?:remove|delete|drop|take\s+out|get\s+rid\s+of|take\s+off)\s+([^.;\n]+)/gi;

function doctorRemovalClauses(text) {
  const out = [];
  // "Dr." is not a sentence end.
  for (const m of String(text || '').replace(/\b(dr|dra|mr|mrs|ms|st)\./gi, '$1 ').matchAll(DOCTOR_REMOVE_RE)) {
    const clause = m[1].split(/\b(?:since|because|as\s+(?:they|she|he|both)|keep|but|they(?:'re| are)|already)\b/i)[0];
    // A plan removal ("drop H1290-073", "remove devoted") is not a doctor removal.
    if (/\b[HR]\d{4}-\d{3}/i.test(clause) && !/\b(?:dr|dra|doctor)\b\.?/i.test(clause)) continue;
    // "Remove Dr. A, Dr. B and both C rows": list parts. "…, Pascual De Santis is already on the list" is a statement
    // about a doctor who stays, not a target.
    const parts = clause.split(/,|\band\b|&/i).filter((x) => !/\b(?:is|are|stays?|staying|remains?|already|keep)\b/i.test(x));
    const words = plainWords(parts.join(' '));
    words.raw = rawWords(parts.join(' '));
    if (words.length) out.push(words);
  }
  return out;
}

// Words that start the description after a doctor's name when it was saved without " - " ("Dr. Neeta Erinjerri Surgeon
// At Baptist Cancer Institute", "Pasquel DeSantis Endocrinologist Baptist"): the name ends there.
const NAME_TAIL_RE = /^(?:at|of|from|with|in|for|surgeon|surgeons|surgery|surgical|baptist|institute|cancer|center|centre|hospital|group|medical|medicine|clinic|health|healthcare|associates|dental|spine|university|memorial|practice|physicians?|care|internist|internal|family|general|pediatric\w*|hematolog\w*|radiolog\w*|anesthes\w*|pain|sports|vascular|plastic|breast|cardio\w*|neuro\w*|gyn\w*|obgyn|ortho\w*|derm\w*|uro\w*|gastro\w*|onc\w*|endo\w*|rheum\w*|pulm\w*|nephro\w*|podiat\w*|ophth\w*|optom\w*|ent|psych\w*|specialist|pcp|primary|md|np|aprn|pa-c|llc|inc|pllc)$/;

// Specialty / role words: a removal that names one ("both Neeta Erinjerri Surgeon rows") only matches a row that
// carries a matching one, when the row carries any.
const SPECIALTY_RE = /^(?:surg\w*|cardio\w*|neuro\w*|gyn\w*|obgyn|ortho\w*|derm\w*|uro\w*|gastro\w*|onc\w*|endo\w*|rheum\w*|pulm\w*|nephro\w*|podiat\w*|ophth\w*|optom\w*|ent|psych\w*|internist|internal|family|pediatric\w*|hematolog\w*|radiolog\w*|anesthes\w*|pcp|primary)$/;

function rawWords(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z'-]+/).map((w) => w.replace(/^[-']+|[-']+$/g, '')).filter(Boolean);
}

/** The name part of a saved doctor row: before " - practice", and before the first descriptive word. */
function doctorCoreWords(name) {
  const head = String(name || '').split(/\s+[-–—]\s+/)[0];
  const words = rawWords(head).filter((w, i) => !(i === 0 && /^(?:dr|dra|doctor|doctora)$/.test(w)));
  const cut = words.findIndex((w, i) => i >= 1 && NAME_TAIL_RE.test(w));
  return plainWords((cut >= 0 ? words.slice(0, cut) : words).join(' '));
}

/** Specialty words a row or a clause carries (after the name). */
function specialtyWords(text) {
  return rawWords(text).filter((w) => SPECIALTY_RE.test(w)).map((w) => w.slice(0, 5));
}

function removedByClauses(name, clauses) {
  const core = doctorCoreWords(name);
  if (core.length < 2) return false;
  const rowSpec = specialtyWords(String(name || '').replace(/^\s*(?:dr|dra)\.?\s+/i, ''));
  return clauses.some((words) => {
    if (!core.every((w) => words.includes(w))) return false;
    const said = specialtyWords((words.raw || words).join(' '));
    return !said.length || !rowSpec.length || said.some((w) => rowSpec.includes(w));
  });
}

/** Same person by name: the name parts of both rows (descriptions dropped), first name equal, last name ≤2 edits. */
function sameCoreDoctor(a, b) {
  const x = doctorCoreWords(a);
  const y = doctorCoreWords(b);
  if (x.length < 2 || y.length < 2) return false;
  return looseSameDoctor(x.join(' '), y.join(' '));
}

/** Two rows name the same doctor: a shared last name across what she typed and what the registry returned. */
function sameNamedDoctor(a, b) {
  const lasts = (r) => [r.requestedName, r.doctorName].map((n) => doctorCoreWords(n || '')).filter((w) => w.length)
    .map((w) => w[w.length - 1].toLowerCase());
  const x = lasts(a);
  return lasts(b).some((l) => x.includes(l));
}

const RESOLVED_DOCTOR = (d) => Boolean(d && d.npi && !['not_found', 'timeout', 'error'].includes(d.status));

/**
 * One row per doctor in the comparison (Jacqueline Alexander, 2026-10-17): two rows with the same NPI collapse into one,
 * and an unresolved row whose saved name is a description of a resolved doctor ("Dr. Neeta Erinjerri Surgeon At Baptist
 * Cancer Institute" next to "Neeta Jane Erinjeri · NPI 1427310424") goes. Two resolved doctors with different NPIs
 * always both stay.
 */
function dedupeDoctorRows(rows) {
  const list = (rows || []).filter(Boolean);
  const out = [];
  for (const d of list) {
    // Merge only on the exact same NPI AND a name for the same doctor ("Dr. Garcia" and "Lazaro Garcia"). Two
    // different typed names that came back with one NPI both stay; a lookup mix-up is not hers to lose.
    const at = d.npi ? out.findIndex((o) => o.npi && String(o.npi) === String(d.npi) && sameNamedDoctor(o, d)) : -1;
    if (at >= 0) {
      if (!RESOLVED_DOCTOR(out[at]) && RESOLVED_DOCTOR(d)) out[at] = d;
      continue;
    }
    out.push(d);
  }
  // An unresolved row that reads like a description of a resolved doctor is NOT dropped: Max asks the agent first
  // (Yahoska, 2026-10-17: "no auto drop, have her confirm"). It goes only on her yes, or when she names it for removal.
  return out.map((d) => {
    if (RESOLVED_DOCTOR(d)) return d;
    const asked = d.requestedName || d.doctorName || '';
    const described = doctorCoreWords(asked).length < plainWords(String(asked).replace(/^\s*(?:dr|dra)\.?\s+/i, '')).length;
    const twin = described && out.find((o) => o !== d && RESOLVED_DOCTOR(o) && sameCoreDoctor(o.requestedName || o.doctorName, asked));
    return twin ? { ...d, duplicateOf: { name: cleanName(twin.doctorName || twin.requestedName), npi: String(twin.npi) } } : d;
  });
}

const DUPLICATE_Q_RE = /'([^'\n]{3,140})' looks like a duplicate of [^\n]*?Remove it\?/g;

/** The confirm questions for rows dedupeDoctorRows flagged. */
function duplicateQuestions(doctors) {
  return (doctors || []).filter((d) => d && d.duplicateOf)
    .map((d) => `❓ '${String(d.requestedName || d.doctorName).replace(/'/g, '’')}' looks like a duplicate of ${d.duplicateOf.name} (NPI ${d.duplicateOf.npi}). Remove it?`);
}

/** Names she said yes to removing, from Max's duplicate questions in the assistant turn right before `userAt`. */
function confirmedDuplicateRemovals(msgs, userAt) {
  const u = msgs[userAt];
  if (!u || u.role !== 'user') return [];
  const prev = msgs.slice(0, userAt).reverse().find((m) => m && m.role === 'assistant');
  if (!prev) return [];
  const asked = [...messageText(prev).matchAll(DUPLICATE_Q_RE)].map((m) => m[1].replace(/’/g, "'"));
  if (!asked.length) return [];
  const t = messageText(u).trim();
  if (/^\s*(?:no|nope|keep|don'?t)\b/i.test(t)) return [];
  if (!/^\s*(?:yes|yep|yeah|si|sí|correct|ok(?:ay)?|sure|remove(?:\s+(?:it|them|both|all))?|delete(?:\s+it)?|drop(?:\s+it)?)\b/i.test(t)) return [];
  return asked;
}

// ═══ MEDS ════════════════════════════════════════════════════════════════════════════════════════════════════
// "remove Farxiga", "she stopped taking metformin", "no longer on Eliquis", "drop the lisinopril": only the meds
// she names leave; every other saved med stays.
const MED_REMOVE_RE = /\b(?:remove|delete|drop|take\s+(?:out|off)|stopped(?:\s+taking)?|stop(?:\s+taking)?|no\s+longer\s+(?:takes?|taking|on)|discontinued|off\s+of)\s+(?:the\s+|her\s+|his\s+)?([^.;\n]+)/gi;
function medRemovalsIn(text, savedMeds) {
  const out = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(MED_REMOVE_RE)) {
    const clause = m[1].toLowerCase();
    if (/\b[HR]\d{4}-\d{3}\b/i.test(clause) || /\b(?:dr|dra|doctor)\b\.?/i.test(clause)) continue;
    for (const med of savedMeds || []) {
      const head = String(med).toLowerCase().split(/[\s/]+/).filter((w) => /^[a-z]{4,}$/.test(w))[0];
      if (head && new RegExp(`\\b${head}\\b`).test(clause)) out.add(med);
    }
  }
  return [...out];
}
// "Levothyroxine Sodium is 0.2 mg" / "levothyroxine 0.2 mg" / "the levothyroxine dose is 0.2 mg": the saved med is that
// strength from now on — the table, exports and saved workup read "Levothyroxine Sodium 0.2 mg" (Gerry Cabrera, 2026-10-19).
const DOSE_RE = /\b([A-Za-z][A-Za-z-]{3,})(?:\s+[A-Za-z-]+){0,2}?\s+(?:dose\s+)?(?:is|=|:|at|takes?)?\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ml|units?|%)\b/gi;
function confirmedDosesIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(DOSE_RE)) out.push({ head: m[1].toLowerCase(), dose: `${m[2]} ${m[3].toLowerCase()}` });
  return out;
}
function applyConfirmedDoses(text, meds) {
  const doses = confirmedDosesIn(text);
  if (!doses.length) return meds;
  return (meds || []).map((med) => {
    const words = String(med).toLowerCase().split(/[\s/]+/);
    const d = doses.find((x) => words[0] === x.head || (x.head.length >= 5 && words[0].startsWith(x.head.slice(0, 5))));
    if (!d) return med;
    const base = String(med).replace(/\s*\d+(?:\.\d+)?\s*(?:mg|mcg|ml|units?|%)\b.*$/i, '').trim();
    return `${base} ${d.dose}`;
  });
}

/** Saved meds + the newest message → the med set for the re-run (names normalized, removals applied). */
function workupMedSet(savedMeds, latestText) {
  const tidy = (x) => R.tidyLongMedName ? R.tidyLongMedName(x) : String(x || '');
  const meds = (savedMeds || []).map(tidy).filter(Boolean);
  const gone = medRemovalsIn(latestText, meds);
  return applyConfirmedDoses(latestText, meds.filter((m) => !gone.includes(m)));
}

// ═══ A NEW FULL LIST REPLACES THE SAVED ONES ═════════════════════════════════════════════════════════════════
/**
 * Her full doctor + med list typed on a loaded workup ("Doctors: … Meds: …") IS the list from then on: the saved
 * doctors and meds in the workup context are replaced by it, never merged. Live bug, 2026-10-21: after her new
 * paste, the next turn rebuilt the table from the saved rows and Yanette Barcelo PA, Ricardo Espinosa P.A.,
 * Ketoconazole and Levothyroxine Sodium came back although she had not listed them.
 */
function isFullClientList(text) {
  const t = String(text || '');
  if (/structured facts only/i.test(t)) return false;
  if (!/\b(?:doctors?|providers?|care\s+team)\s*:/i.test(t) || !/\b(?:meds?|medications?|prescriptions?|rx)\s*:/i.test(t)) return false;
  const f = require('./compareJobs').parseCompareAsk(t);
  return f.doctors.length >= 2 && f.meds.length >= 1 ? f : null;
}

function withCurrentLists(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const ctxAt = msgs.findIndex((m) => m && m.role === 'user' && /structured facts only/i.test(messageText(m)));
  if (ctxAt < 0) return msgs;
  let full = null;
  for (let i = msgs.length - 1; i > ctxAt && !full; i -= 1) if (msgs[i] && msgs[i].role === 'user') full = isFullClientList(messageText(msgs[i]));
  if (!full) return msgs;
  const names = full.doctors.map((d) => d.name.replace(/\s*\([^)]*\)\s*$/, '').trim());
  const keepName = (nm) => names.some((x) => looseSameDoctor ? looseSameDoctor(x, nm) : x.toLowerCase() === String(nm).toLowerCase());
  const out = [];
  let section = '';
  for (const line of messageText(msgs[ctxAt]).split('\n')) {
    if (/^Doctors \(names only/.test(line)) { out.push(line.replace(/:\s*.*$/, ': ') + names.join('; ')); section = ''; continue; }
    if (/^Doctor NPIs\b/.test(line)) {
      const kept = line.replace(/^[^:]*:\s*/, '').split(';').map((x) => x.trim()).filter((x) => keepName(x.replace(/\s*\([^)]*\)/g, '').replace(/\s+NPI\s+\d{10}\s*$/, '')));
      if (kept.length) out.push(line.replace(/:\s*.*$/, ': ') + kept.join('; '));
      section = ''; continue;
    }
    if (/^Saved In\/Out results\b/.test(line)) { section = 'saved'; out.push(line); continue; }
    if (/^Medications \(tiers\b/.test(line)) {
      section = 'meds';
      out.push(line);
      full.meds.forEach((m) => out.push('- ' + m));
      continue;
    }
    if (/^- /.test(line) && section === 'meds') continue;
    if (/^- /.test(line) && section === 'saved') { const nm = line.slice(2).replace(/\s*\[saved:.*$/, ''); if (keepName(nm)) out.push(line); continue; }
    if (!/^- /.test(line)) section = /^Plans:\s*$/.test(line) ? 'plans' : '';
    out.push(line);
  }
  if (!out.some((l) => /^Medications \(tiers\b/.test(l)) && full.meds.length) {
    out.push('Medications (tiers shown are verified formulary only; a med with no tier still needs lookup_formulary):');
    full.meds.forEach((m) => out.push('- ' + m));
  }
  out.push('Doctors and meds above are her NEWER full list (it replaced the saved lists): use only these.');
  const ctx = msgs[ctxAt];
  const content = out.join('\n');
  const next = msgs.slice();
  next[ctxAt] = Array.isArray(ctx.content) ? { ...ctx, content: [{ type: 'text', text: content }, ...ctx.content.filter((b) => b && b.type !== 'text')] } : { ...ctx, content };
  return next;
}

// ═══ ONE CALL ════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * The sets a loaded-workup thread resolves to: { plans:[{planId,name}], currentPlan:[ids], doctors:[names],
 * npis:{name:npi}, meds:[names], askText }. The same functions the live chat and compare jobs run.
 */
function resolveWorkupSets(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const n = N();
  const { conversationAskText } = require('./planYear');
  const askText = n.comparisonAskText(msgs, conversationAskText(msgs));
  const wk = workupFacts(msgs);
  const currentPlan = n.currentPlanOf ? n.currentPlanOf(msgs) : (wk ? wk.current : []);
  let named = n.namedPlansFromAsk(askText, n.askConstraints(askText));
  // A fresh ask that types her current plan ("Current plan is UHC MedicareMax … (H5420-1-0)") and names others to compare:
  // her current plan is in the set, first column (Tony Cabrera, 2026-10-19).
  if (!wk && named.length && currentPlan.length) {
    for (const id of [...currentPlan].reverse()) {
      if (!named.some((p) => String(p.planId).toUpperCase().slice(0, 9) === String(id).toUpperCase().slice(0, 9))) named = [{ planId: id, name: id }, ...named];
    }
  }
  const plans = currentPlanFirst(named, currentPlan);
  const fu = n.comparisonFollowUp(msgs);
  let doctors = fu && fu.doctors ? fu.doctors : (wk ? wk.doctors : []);
  if (!doctors.length) {
    // A fresh chat: the doctors she listed ("Doctors: A, B") in her newest message that lists any.
    const { parseCompareAsk } = require('./compareJobs');
    for (let i = msgs.length - 1; i >= 0 && !doctors.length; i -= 1) {
      if (msgs[i] && msgs[i].role === 'user') doctors = (parseCompareAsk(messageText(msgs[i])).doctors || []).map((d) => d.name);
    }
  }
  const meds = R.medsFromAsk(askText);
  return { plans, currentPlan, doctors, npis: (fu && fu.npis) || {}, meds, askText, followUp: fu };
}

module.exports = {
  planRemovals,
  planRemovalLines,
  messageText,
  // plans
  workupFacts, workupCarrierEditSet, workupPlanAddSet, replacePlanPairs, lastTablePlanIds, WORKUP_LINE_RE, KEEP_EXACT_RE, PLAN_EDIT_VERB_RE, isPlanEditLine, PLAN_START,
  NEW_SET_VERB_RE, ONLY_PLANS_RE, REMOVE_RE, PRONOUN_TARGET_RE, KEEPS_CURRENT_RE, lineKeepsCurrentPlan, droppedIdsIn, removePlansNamedIn, OFF_GRID_RE, DROPS_CURRENT_RE, currentPlanRemovedBy, planLineVerdict, currentPlanFirst,
  // doctors
  respelledDoctors, looseSameDoctor, fuzzySameDoctor, DOCTOR_REMOVE_RE, doctorRemovalClauses, NAME_TAIL_RE, SPECIALTY_RE, rawWords,
  doctorCoreWords, specialtyWords, removedByClauses, sameCoreDoctor, RESOLVED_DOCTOR, dedupeDoctorRows, DUPLICATE_Q_RE,
  duplicateQuestions, confirmedDuplicateRemovals,
  // meds
  MED_REMOVE_RE, medRemovalsIn, workupMedSet, confirmedDosesIn, applyConfirmedDoses,
  // all three
  resolveWorkupSets, isFullClientList, withCurrentLists,
};
