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
    return { doctors, plans, zip, current };
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

const REMOVE_RE = /\b(?:remove|drop|take out|delete|no more|get rid of|without|exclude|excluding)\s+(?:the\s+)?([^,.;\n]+?)(?=\s+(?:from|and|,)|[,.;\n]|$)/gi;

// "remove it" / "drop that one" / "take this off": a pronoun never names a plan — and never drops her current plan.
const PRONOUN_TARGET_RE = /^(?:it|that|this|them|those|these|that one|this one|the other(?: one)?|one)\b/i;
/** IDs (first 9 chars) she drops in this line ("Drop MedicareMax H5420-001") — they never come back as columns. */
function droppedIdsIn(line) {
  const dropped = new Set();
  for (const r2 of String(line || '').matchAll(/\b(?:remove|drop|take out|delete|no more|get rid of|without)\s+([^.;\n]*)/gi)) {
    const target = r2[1].split(/[,]|\b(?:and\s+)?(?:add|instead|but|then|show|keep|include|plus|with)\b/i)[0];
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
function removePlansNamedIn(current, line, currentIds) {
  let out = current.slice();
  const cur = (currentIds || []).map((x) => String(x).toUpperCase().slice(0, 9));
  const offGrid = currentPlanRemovedBy(line, cur, (id) => { const p = current.find((q) => q.planId.slice(0, 9).toUpperCase() === id); const g = gridRowFor(id, ''); return p ? carrierOf(p.name) : (g ? R.carrierOfPlan(g) : ''); });
  for (const r of String(line || '').matchAll(REMOVE_RE)) {
    const target = r[1].trim().toLowerCase();
    if (!target || PRONOUN_TARGET_RE.test(target)) continue;
    // "Remove Dr. Pasquel DeSantis …" removes a doctor row, not a plan.
    if (/^(?:dr|dra|doctor|doctora)\b/.test(target) || /\brows?\b/.test(target)) continue;
    const tWords = target.split(/[^a-z0-9-]+/).filter((w) => w.length > 1);
    out = out.filter((p) => {
      const id = p.planId.toLowerCase();
      if (target.includes(id.slice(0, 9))) return false;
      const byCarrier = carrierOf(target) && carrierOf(target) === carrierOf(p.name);
      const nameWords = `${p.name} ${carrierOf(p.name)}`.toLowerCase().split(/[^a-z0-9-]+/);
      const byName = tWords.length > 0 && tWords.every((w) => nameWords.includes(w));
      // A carrier or name drop never takes her current plan; only an off-the-grid / current-plan / ID removal does.
      if ((byCarrier || byName) && cur.includes(id.slice(0, 9).toUpperCase()) && !offGrid.has(id.slice(0, 9).toUpperCase())) return true;
      return !byCarrier && !byName;
    });
  }
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
/** Saved meds + the newest message → the med set for the re-run (names normalized, removals applied). */
function workupMedSet(savedMeds, latestText) {
  const tidy = (x) => R.tidyLongMedName ? R.tidyLongMedName(x) : String(x || '');
  const meds = (savedMeds || []).map(tidy).filter(Boolean);
  const gone = medRemovalsIn(latestText, meds);
  return meds.filter((m) => !gone.includes(m));
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
  messageText,
  // plans
  workupFacts, workupCarrierEditSet, WORKUP_LINE_RE, KEEP_EXACT_RE, PLAN_EDIT_VERB_RE, isPlanEditLine, PLAN_START,
  NEW_SET_VERB_RE, ONLY_PLANS_RE, REMOVE_RE, PRONOUN_TARGET_RE, KEEPS_CURRENT_RE, lineKeepsCurrentPlan, droppedIdsIn, removePlansNamedIn, OFF_GRID_RE, DROPS_CURRENT_RE, currentPlanRemovedBy, planLineVerdict, currentPlanFirst,
  // doctors
  respelledDoctors, looseSameDoctor, DOCTOR_REMOVE_RE, doctorRemovalClauses, NAME_TAIL_RE, SPECIALTY_RE, rawWords,
  doctorCoreWords, specialtyWords, removedByClauses, sameCoreDoctor, RESOLVED_DOCTOR, dedupeDoctorRows, DUPLICATE_Q_RE,
  duplicateQuestions, confirmedDuplicateRemovals,
  // meds
  MED_REMOVE_RE, medRemovalsIn, workupMedSet,
  // all three
  resolveWorkupSets,
};
