// services/doctorPlanNarrow.js — turn a multi-doctor network check into a short
// answer: one line per doctor, a doctor × plan coverage count, and the 2–3
// narrowing questions Max still needs before naming 2–3 plans.
//
// Counts are objective ("6 of 8 doctors in network"), not a ranking (TPMO).
// A plan only counts as Out for a doctor when that carrier's guest directory
// (UHC / Humana) finished and listed the plan as out-of-network. Everything
// else that is not In is "not confirmed".

// Doctor names: one normalizer for the grid, the lookups and the exports.
const DN = require('../artifacts/doctor-name.js');
const PLAN_NAME = require('../artifacts/plan-name.js');
const { plainWords, cleanName, titleCase, sameDoctorName, ROLE_WORDS_RE } = DN;
// Loaded-workup set rules (plans / doctors / meds) live in one module.
const LW = require('./loadedWorkup');
const { workupFacts, workupCarrierEditSet, WORKUP_LINE_RE, KEEP_EXACT_RE, PLAN_EDIT_VERB_RE, isPlanEditLine, PLAN_START, NEW_SET_VERB_RE, ONLY_PLANS_RE, REMOVE_RE, respelledDoctors, looseSameDoctor, DOCTOR_REMOVE_RE, doctorRemovalClauses, NAME_TAIL_RE, SPECIALTY_RE, rawWords, doctorCoreWords, specialtyWords, removedByClauses, sameCoreDoctor, RESOLVED_DOCTOR, dedupeDoctorRows, DUPLICATE_Q_RE, duplicateQuestions, confirmedDuplicateRemovals } = LW;

const PLAN_ID_RE = /\(([HR]\d{4}-\d{3}[A-Z]?)\)\s*$/i;

function planIdOf(label) {
  const m = String(label || '').match(PLAN_ID_RE);
  return m ? m[1].toUpperCase() : null;
}

function planNameOf(label) {
  return String(label || '').replace(PLAN_ID_RE, '').trim();
}

function planTypeOf(label) {
  const t = String(label || '');
  if (/d-?snp|\bdual\b/i.test(t)) return 'dsnp';
  if (/\bppo\b/i.test(t)) return 'ppo';
  return 'hmo';
}

function carrierOf(label) {
  const t = String(label || '');
  if (/humana/i.test(t)) return 'Humana';
  if (/\buhc\b|aarp|unitedhealthcare/i.test(t)) return 'UnitedHealthcare';
  if (/aetna/i.test(t)) return 'Aetna';
  if (/simply/i.test(t)) return 'Simply';
  if (/doctors/i.test(t)) return 'Doctors HealthCare';
  if (/wellcare/i.test(t)) return 'Wellcare';
  if (/careplus/i.test(t)) return 'CarePlus';
  if (/devoted/i.test(t)) return 'Devoted';
  if (/solis/i.test(t)) return 'Solis';
  return '';
}

function shortDoctor(d) {
  return String(d.requestedName || d.doctorName || '').trim();
}

/**
 * What the agent already told Max: no Medicaid → no D-SNP; "skip H…" and the
 * terminating plan are never candidates; "PPO only" / "HMO only" narrows type.
 */
/** "other plans comparable to what she has", "something better", "alternatives", "what else" — shop around from her current plan. */
// A ranking ask over the whole county ("plans that cover the most of her doctors", "top 3", "rank").
// "all Dade Core plans", "every core plan in Broward", "core plans in Miami-Dade".
const CORE_ALL_RE = /\b(?:all|every|each)\s+(?:the\s+|of\s+the\s+)?(?:(?:miami[-\s]?)?dade\s+|broward\s+)?core\s+plans?\b|\bcore\s+plans?\s+(?:in|for|across)\s+(?:miami[-\s]?)?(?:dade|broward)\b/i;
const CORE_ALL_LINE = 'Core plans: every regular (non-SNP) plan on the county grid, every carrier.';
const RANK_ASK_RE = /\bcover(?:s|ing)?\s+(?:the\s+)?most\b|\bmost\s+of\s+(?:her|his|their|the)\s+(?:\d+\s+)?doctors\b|\btop\s+\d\b|\brank(?:ed|ing)?\b|\bbest\s+plans?\s+for\s+(?:her|his)\s+doctors\b/i;
const WANTS_ALTERNATIVES_RE = /\b(?:something|anything|options?|plans?)\s+(?:that(?:'s| is)\s+)?better\b|\bbetter\s+(?:options?|plans?|fit|deal)\b|\b(?:any\s+)?other\s+(?:options?|plans?)\b|\balternatives?\b|\bwhat\s+else\b|\bsee\s+what\s+else\b|\bshop(?:ping)?\s+around\b|\bsomething\s+else\b|\b(?:comparable|similar)\s+(?:to|plans?|options?)\b|\bplans?\s+(?:comparable|similar)\b/i;

function askConstraints(askText) {
  const t = String(askText || '');
  const noMedicaid = /\b(no|not on|without|sin|doesn'?t have|don'?t have)\s+(medicaid|msp|dual|qmb|slmb)\b|\bnot dual\b|\bmedicaid:?\s*no\b/i.test(t);
  const hasMedicaid = !noMedicaid && /\b(full medicaid|has medicaid|have medicaid|dual eligible|full dual|qmb|slmb|\bmsp only)\b/i.test(t);
  const skip = new Set();
  for (const m of t.matchAll(/\b(?:skip|exclude|not|no|drop|remove|without)\s+([HR]\d{4}-\d{3}[A-Z]?)/gi)) skip.add(m[1].toUpperCase());
  for (const m of t.matchAll(/([HR]\d{4}-\d{3}[A-Z]?)[^.\n]{0,40}?\b(terminating|ending|going away|non-?commissionable)/gi)) skip.add(m[1].toUpperCase());
  // comparisonAskText writes the plan type of her NEWEST message only ("Plan type: PPO only." / "HMO only." / "any." /
  // "default."): a PPO ask never sticks to the next HMO ask (Robert and Andrea, 2026-10-19). Without that line (one
  // message read on its own) the message's own words decide.
  const line = (t.match(/^Plan type: (PPO only|HMO only|any|default)\.$/m) || [])[1];
  const type = line ? { 'PPO only': 'ppo', 'HMO only': 'hmo', any: 'any', default: '' }[line] : planTypeIn(t);
  const onlyPpo = type === 'ppo';
  // HMO is the default: PPOs stay out unless she says PPO (Yahoska 2026-10-07: "lets not include ppos unless we specify").
  const onlyHmo = type === 'hmo' || type === '';
  return { noMedicaid, hasMedicaid, skip, onlyPpo, onlyHmo };
}

// Plan-type words, any case, with or without the "s": HMO, hmos, PPOs, PPO's.
const TYPE_WORD_RE = /\b(hmo|ppo)(?:'?s)?\b/gi;
// "only PPOs", "PPO only", "just the PPOs", "show me the PPOs", "all PPOs", "compare all HMOs", "top 5 PPOs",
// "rank the PPO plans", "she needs a PPO": she wants that plan type and nothing else.
const TYPE_ONLY_RE = (w) => new RegExp(
  `\\b(?:only|just|all|every|show|list|see|compare|rank|ranked|ranking|top\\s+\\d|run|check|search|find|give|pull|look\\s+at|what\\s+about|how\\s+about|need|needs|wants?|must\\s+be|prefers?)\\b[^.?!\\n]{0,30}?\\b${w}(?:'?s)?\\b`
  + `|\\b${w}(?:'?s)?\\s*(?:only|plans?|options?)\\b|^\\s*(?:the\\s+)?${w}(?:'?s)?\\s*[.?!]*\\s*$`, 'i');

/**
 * The plan type ONE message asks for: 'ppo' / 'hmo' (that type only), 'any' (both types welcome: "either is fine",
 * "HMO or PPO", a PPO plan she named), '' (nothing said — HMO default).
 */
function planTypeIn(text) {
  const t = String(text || '');
  if (!t.trim() || isWorkupMessage(t)) return '';
  if (/\bany network\b|\beither(?:\s+one)?\s+is\s+fine\b|\b(?:hmo|ppo)s?\s+or\s+(?:a\s+)?(?:hmo|ppo)s?\b/i.test(t)) return 'any';
  const types = new Set([...t.matchAll(TYPE_WORD_RE)].map((m) => m[1].toLowerCase()));
  if (!types.size) return '';
  if (types.size > 1) return 'any';
  const type = [...types][0];
  const other = type === 'ppo' ? 'hmo' : 'ppo';
  // "no PPOs" / "not an HMO": the other type only.
  if (new RegExp(`\\b(?:no|not|without|exclude|excluding|except|skip)\\s+(?:the\\s+|any\\s+|an?\\s+)?${type}(?:'?s)?\\b`, 'i').test(t)) return other;
  // A plan ID she typed is a named-plan ask: its type never narrows anything.
  if (/\b[HR]\d{4}-\d{3}/i.test(t)) return type === 'ppo' ? 'any' : '';
  if (TYPE_ONLY_RE(type).test(t)) return type;
  // A PPO named some other way ("HUMANA PPO Humana Choice H7617-107"): PPOs may be columns, HMOs too.
  return type === 'ppo' ? 'any' : '';
}

/**
 * A plan-TYPE ask with no carrier and no plan ID ("only PPOs", "show me the PPOs", "compare all HMOs", "top 5 PPOs"):
 * rank every plan of that type in her county on her doctors and meds. { type, top } or null.
 */
function planTypeAsk(text) {
  const t = String(text || '');
  if (!t.trim() || isWorkupMessage(t) || /\b[HR]\d{4}-\d{3}/i.test(t)) return null;
  const type = planTypeIn(t);
  if (type !== 'ppo' && type !== 'hmo') return null;
  // "show me humana ppos" / "aetna hmo": a carrier's plans of that type (planTypeSetFromAsk / the carrier ask).
  if (R.carriersRequested(t).length || R.carriersUnresolved(t).length) return null;
  // Her answer to Max's numbered questions ("1. no 2. ppo") is read with those questions (statementsFor).
  if (Object.keys(numberedAnswers(t)).length >= 2) return null;
  const top = Number((t.match(/\btop\s+(\d)\b/i) || [])[1]) || 5;
  return { type, top: Math.max(1, Math.min(5, top)) };
}

/** "Plan type: …" line for the ask text: her newest message only (a Max question she answered in it counts). */
function planTypeLine(msgs) {
  // A doctor-match answer keeps the plan type of the ask it answers ("only PPOs", then "Yekutiel Sandman, David Taub").
  const lastUserAt = rankAskAt(msgs);
  if (lastUserAt < 0) return 'Plan type: default.';
  const latest = messageText(msgs[lastUserAt]);
  let type = planTypeIn(latest);
  const prev = msgs.slice(0, lastUserAt).reverse().find((m) => m && m.role === 'assistant');
  if (prev) {
    const qs = askedQuestions(messageText(prev));
    const answers = numberedAnswers(latest);
    qs.forEach((q, k) => {
      if (!q || !answers[k] || !/HMO OK|PPO/i.test(q)) return;
      const st = statementsFor(q, answers[k])[0] || '';
      type = /Needs a PPO/.test(st) ? 'ppo' : /either|both|any/i.test(answers[k]) ? 'any' : 'hmo';
    });
  }
  return planTypeLineFor(type);
}

/** The "Plan type: …" line askConstraints reads, for one plan type ('ppo' / 'hmo' / 'any' / ''). */
function planTypeLineFor(type) {
  return `Plan type: ${{ ppo: 'PPO only', hmo: 'HMO only', any: 'any' }[type] || 'default'}.`;
}

/**
 * The ask-text lines of a plan-type ask ("only PPOs", "compare all HMOs"), the same for the chat (comparisonAskText)
 * and the compare card (compareJobs.askTextFor): selectComparison ranks every plan of that type in her county, her
 * current plan pinned first unless it is the other type (then left out, said in one line), plans she named pinned
 * after it, each plan its own column (no folding of same-network twins), SNPs out unless eligibility is confirmed.
 * typeAsk = { type, top } from planTypeAsk. Returns { current, lines }: the "Her current plan" line (chat puts it
 * first, and only when no other line already says it) and the rest, in order.
 */
function planTypeAskLines(typeAsk, { current = [], include = [], excluded = [], zip = '' } = {}) {
  const lines = [];
  if (excluded.length) lines.push(`Carriers excluded: ${excluded.join(', ')}.`);
  lines.push('Rank all eligible plans.');
  lines.push(`Plan-type ask: ${typeAsk.type.toUpperCase()}s only.`);
  lines.push(`Top ${typeAsk.top}.`);
  if (include.length) lines.push(`Include plans: ${include.join(', ')}.`);
  if (zip) lines.push(`ZIP ${zip}.`);
  return { current: current.length ? `Her current plan: ${current.join(', ')}.` : '', lines };
}

/**
 * The plan-type ask in a free-form paste (the compare card's text box, or a plan-type control's value: "PPO",
 * "only PPOs", "HMOs"): every sentence / line is read with planTypeAsk — the same reader as a chat message — and
 * the last one that asks for a type wins. A sentence with a plan ID ("current plan UHC H5420-001") or a carrier
 * ("show me humana ppos") is not a type ask, exactly as in chat. { type, top } or null.
 */
function textPlanTypeAsk(text) {
  const t = String(text || '');
  if (!t.trim() || isWorkupMessage(t)) return null;
  let found = null;
  for (const seg of t.split(/\n+|(?<!\b(?:Dr|Dra|Mr|Mrs|Ms|St|Jr|Sr|[A-Z]))[.!?;]+(?=\s|$)/)) {
    const a = planTypeAsk(seg.trim());
    if (a) found = a;
  }
  return found;
}

// ─── her pick from the "No exact match" candidates ──────────────────────────────────────────────────────────────
// Max's question lists, per doctor she typed, the closest real providers the NPI registry found:
//   • "Daid Taub" — closest: David Andrew Taub, MD (Urology, Boca Raton, NPI 1891804696); Harvey Carl Taub, MD (…)
// Her reply names one ("Yekutiel Sandman and David Andrew Taub", "Daid Taub = David Andrew Taub", "yes" when each
// doctor has one candidate): that candidate — name and NPI — replaces the doctor she typed, and is checked on every
// plan in the table (Robert and Andrea, 2026-10-19: "Yekutil Sandman" / "Daid Taub" on an "only PPOs" table).
const editDistance = (x, y) => {
  let row = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let a = 1; a <= x.length; a += 1) { const cur = [a]; for (let b = 1; b <= y.length; b += 1) cur[b] = Math.min(row[b] + 1, cur[b - 1] + 1, row[b - 1] + (x[a - 1] === y[b - 1] ? 0 : 1)); row = cur; }
  return row[y.length];
};
const CRED_RE = /,?\s*\b(?:MD|M\.D\.|DO|D\.O\.|DDS|DMD|DPM|OD|ARNP|APRN|NP|PA-C?|PhD)\b\.?/gi;
function doctorMatchCandidates(questionText) {
  const out = [];
  for (const m of String(questionText || '').matchAll(/^\s*[•*-]\s*["“]([^"”]+)["”]\s*[—–-]\s*(?:closest:|did you mean)\s*(.+)$/gim)) {
    const cands = [];
    for (const part of m[2].split(/;\s*/)) {
      const c = part.match(/^\s*([^(?]+?)\s*\(([^)]*)\)/);
      if (!c) continue;
      const npi = (c[2].match(/\bNPI\s*(\d{10})\b/) || [])[1] || '';
      cands.push({ name: c[1].replace(CRED_RE, '').trim(), npi });
    }
    if (cands.length) out.push({ asked: m[1].trim(), candidates: cands });
  }
  return out;
}
function candidatePicks(questionText, answerText) {
  const rows = doctorMatchCandidates(questionText);
  if (!rows.length) return [];
  const a = String(answerText || '').trim();
  const picks = [];
  const take = (row, cand) => { if (!picks.some((p) => p.asked === row.asked)) picks.push({ asked: row.asked, name: cand.name, npi: cand.npi }); };
  // A bare "yes" / "yes to both": each doctor with exactly one candidate takes it.
  if (/^\s*(?:yes|yep|yeah|correct|ok(?:ay)?|right)(?:\s+(?:to\s+)?(?:both|all|all of them|them|those|that|please))?[.!]?\s*$/i.test(a)) {
    for (const row of rows) if (row.candidates.length === 1) take(row, row.candidates[0]);
    return picks;
  }
  const looksLike = (said, cand) => {
    const sw = plainWords(said);
    const cw = plainWords(cand.name);
    if (sw.length < 2 || cw.length < 2) return false;
    const last = sw[sw.length - 1];
    return editDistance(sw[0], cw[0]) <= 1 && cw.slice(1).some((w) => editDistance(w, last) <= 1)
      && sw.slice(1, -1).every((w) => w.length <= 1 || cw.some((x) => editDistance(x, w) <= 1));
  };
  const askedLike = (said, row) => {
    const sw = plainWords(said);
    const aw = plainWords(row.asked);
    return sw.length >= 1 && aw.length >= 1 && editDistance(sw[sw.length - 1], aw[aw.length - 1]) <= 2 && (sw.length < 2 || editDistance(sw[0], aw[0]) <= 2);
  };
  const segs = a.replace(CRED_RE, '').split(/[\n;]|,|\band\b|&/i);
  for (const seg0 of segs) {
    const seg = seg0.replace(/^\s*(?:yes|yep|yeah|correct|ok(?:ay)?|its|it's|it is|use|try|the right one is|i mean)\b[\s,:-]*/i, '').replace(/^\s*(?:dr|dra|doctor)\.?\s+/i, '').replace(/[.!?]+\s*$/, '').trim();
    if (!seg) continue;
    const npi = (seg.match(/\b(\d{10})\b/) || [])[1];
    const eq = seg.split(/\s*(?:=|→|->|\bis actually\b|\bshould be\b|\bis\b)\s*/i);
    const left = eq.length > 1 ? eq[0] : '';
    const right = (eq.length > 1 ? eq.slice(1).join(' ') : seg).replace(/^\s*(?:dr|dra|doctor)\.?\s+/i, '').trim();
    const pool = rows.filter((row) => !left || askedLike(left, row));
    const hits = [];
    for (const row of pool) for (const cand of row.candidates) if ((npi && cand.npi === npi) || (!npi && looksLike(right, cand))) hits.push([row, cand]);
    const byRow = [...new Set(hits.map((h) => h[0]))];
    if (byRow.length === 1) take(byRow[0], hits.find((h) => h[0] === byRow[0])[1]);
  }
  return picks;
}

/** Her candidate picks in every reply up to lastUserAt, applied to the doctor list: { doctors, npis }. */
function pickedDoctors(msgs, lastUserAt, doctors) {
  const list = (doctors || []).slice();
  const npis = {};
  for (let i = 1; i <= lastUserAt; i += 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const prev = msgs.slice(0, i).reverse().find((x) => x && x.role === 'assistant');
    if (!prev) continue;
    for (const pk of candidatePicks(messageText(prev), messageText(m))) {
      const k = list.findIndex((nm) => sameDoctorName(nm, pk.asked) || plainWords(nm).join(' ') === plainWords(pk.asked).join(' '));
      if (k < 0) continue;
      list[k] = pk.name;
      if (pk.npi) npis[pk.name] = pk.npi;
    }
  }
  return { doctors: list, npis };
}

/** The latest message only answers Max's doctor-match question (no plan, carrier or plan-type ask in it). */
function isDoctorMatchAnswer(msgs, at) {
  const t = messageText(msgs[at]);
  if (!t.trim() || /\b[HR]\d{4}-\d{3}/i.test(t) || R.carriersRequested(t).length || planTypeIn(t)) return false;
  const prev = msgs.slice(0, at).reverse().find((m) => m && m.role === 'assistant');
  if (!prev || !/No exact match for:/i.test(messageText(prev))) return false;
  return candidatePicks(messageText(prev), t).length > 0;
}
/** The user message whose ranking / plan-type ask the newest turn continues: her doctor-match answers ride on it. */
function rankAskAt(msgs) {
  let at = msgs.map((m) => m && m.role).lastIndexOf('user');
  while (at > 0 && isDoctorMatchAnswer(msgs, at)) {
    const prevUser = msgs.slice(0, at).map((m) => m && m.role).lastIndexOf('user');
    if (prevUser < 0) break;
    at = prevUser;
  }
  return at;
}

/** Plan rows: who is In / Out / not confirmed, sorted by In count. */
function coverageMatrix(doctors0) {
  // Dentists never rank plans (their cells come from the dental networks).
  const doctors = (doctors0 || []).filter((d) => d && !isDentalProvider(d));
  const ok = doctors.filter((d) => d.status === 'done' || d.status === 'partial');
  const plans = new Map();
  for (const d of ok) {
    for (const label of d.inNetworkPlans || []) {
      const id = planIdOf(label);
      if (!id) continue; // carrier-only hits (FHIR) can't be counted per plan
      if (!plans.has(id)) {
        plans.set(id, { planId: id, name: planNameOf(label), label, carrier: carrierOf(label), type: planTypeOf(label), in: [], out: [], unknown: [] });
      }
    }
  }
  for (const row of plans.values()) {
    for (const d of doctors || []) {
      const name = shortDoctor(d);
      const inIds = new Set((d.inNetworkPlans || []).map(planIdOf).filter(Boolean));
      const outIds = new Set((d.outOfNetworkPlans || []).map(planIdOf).filter(Boolean));
      if (inIds.has(row.planId)) row.in.push(name);
      else if (outIds.has(row.planId)) row.out.push(name);
      else row.unknown.push(name);
    }
  }
  return [...plans.values()].sort((a, b) => (
    b.in.length - a.in.length || a.out.length - b.out.length || a.planId.localeCompare(b.planId)
  ));
}

const ASKED = {
  medicaid: /medicaid|\bdual\b|d-?snp|\bqmb\b|\bslmb\b|\bfbde\b|extra help|\blis\b|no medicaid|not dual|sin medicaid/i,
  network: /\bhmo\b|\bppo\b|either is fine|any network/i,
  mustKeep: /must[- ]?keep|must have|can drop|can lose|priority doctor|keep (all|only)|most important/i,
  rx: /\b(rx|meds?|medications?|drugs?|prescriptions?|no meds|medicamentos?)\b/i,
};

/** True when Max already asked the narrowing questions and the agent replied after. */
function narrowingAnswered(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const text = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || '').join(' ') : '');
  const askedAt = msgs.map((m, i) => (m && m.role === 'assistant' && /Medicare Savings Program|must-keep|To narrow to 2/i.test(text(m)) ? i : -1)).filter((i) => i >= 0).pop();
  return askedAt != null && msgs.slice(askedAt + 1).some((m) => m && m.role === 'user');
}

/** Doctor asked by last name only ("Yavagal", "Dr. Krajewski") — the NPI match needs the agent's OK. */
function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('\n');
  return '';
}

/**
 * A plan name pasted in quotes often wraps: '"UHC MedicareMax Complete Care FL-30\n H5420-014"'.
 * Rejoin a line to the next while its double quotes are unbalanced, so one plan stays on one line
 * (Gail, 2026-10-08: 4 named plans read as 3 lines and only the last line's 2 survived).
 */
function joinWrappedQuotes(text) {
  const out = [];
  let buf = null;
  for (const line of String(text || '').split('\n')) {
    buf = buf === null ? line : `${buf} ${line.trim()}`;
    if ((buf.match(/["\u201C\u201D]/g) || []).length % 2 === 0) { out.push(buf); buf = null; }
  }
  if (buf !== null) out.push(buf);
  return out.join('\n');
}

/** The loaded-workup message is saved facts plus rules text, never the agent's ask. */
function isWorkupMessage(t) {
  return /^\s*LOADED CLIENT WORKUP\b/.test(t) || /structured facts only/i.test(t);
}

/** "1. no, 2. eliquis cardiovascular disorder. 3. yes" → { 1: 'no', 2: 'eliquis …', 3: 'yes' } */
function numberedAnswers(text) {
  const t = ` ${String(text || '')}`;
  const marks = [...t.matchAll(/(?:^|[\s,;(])(?:q|#)?([1-9])\s*[.):-]?\s+(?=\S)/gi)];
  const out = {};
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : t.length;
    const k = Number(m[1]);
    if (!out[k]) out[k] = t.slice(start, end).replace(/^[\s,;.]+|[\s,;.]+$/g, '');
  });
  return out;
}

/** The numbered questions in Max's last narrowing message, in order. */
function askedQuestions(text) {
  const t = String(text || '');
  const qs = [];
  // A question may run over several lines (a doctor question lists one bullet per doctor): it ends at the next number or a blank line.
  for (const m of t.matchAll(/(?:^|\n|\s)(?:Q)?([1-9])[.)]\s+([\s\S]*?)(?=(?:\n\s*(?:Q)?[1-9][.)]\s)|(?:\s(?:Q)?[1-9][.)]\s)|\n\s*\n|$)/g)) qs[Number(m[1])] = m[2].trim();
  return qs;
}

const NO_RE = /^\s*(no|nope|none|n\/a|na|ninguno|ninguna|no tiene)\b/i;
const YES_RE = /^\s*(yes|yep|yeah|si|sí|correct|right|confirmed|ok|those are|they are)\b|\bcorrect\b/i;

const NEG_RE = /\b(wrong|incorrect|not (the )?(right|correct|same)|isn'?t|aren'?t|different|no)\b/i;

/**
 * "yes" confirms every listed match; "Yavagal and Krajewski correct, Del Conde and
 * Sosa wrong" confirms two and rejects two. A name she does not mention stays open.
 */
function matchVerdicts(names, answer) {
  const a = String(answer || '');
  const clauses = a.split(/[,;.]|\bbut\b/i).map((c) => c.trim()).filter(Boolean);
  const key = (nm) => plainWords(nm).slice(-1)[0] || '';
  const ok = [];
  const bad = [];
  let anyNamed = false;
  for (const nm of names) {
    const k = key(nm);
    const clause = k ? clauses.find((c) => plainWords(c).includes(k)) : null;
    if (!clause) continue;
    anyNamed = true;
    (NEG_RE.test(clause) ? bad : ok).push(nm);
  }
  if (!anyNamed) {
    if (NO_RE.test(a) || /\b(wrong|incorrect)\b/i.test(a)) bad.push(...names);
    else if (YES_RE.test(a)) ok.push(...names);
  }
  const out = [];
  if (ok.length) out.push(`Doctor matches confirmed: ${ok.join(', ')}.`);
  if (bad.length) out.push(`Doctor matches wrong: ${bad.join(', ')}.`);
  return out;
}

/**
 * "Carlos Sosa = Glenda Sosa", "Mortyko is Dr. John Mortell", "Sosa -> Glenda Sosa".
 * Only names already on her doctor list can be replaced.
 */
function substitutionsIn(text, knownNames) {
  const out = [];
  // "Replace Dr. Natalie Regalado with Dr. Nathalie Regalado, Baptist Medical Group, NPI 1467795633".
  for (const r of String(text || '').replace(/\b(dr|dra)\./gi, '$1').matchAll(/\b(?:replace|change|swap|correct)\s+(?:dr\s+)?([A-Za-zÀ-ÿ'.-]+(?:\s+[A-Za-zÀ-ÿ'.-]+){1,3}?)\s+(?:with|to|by)\s+(?:dr\s+)?([A-Za-zÀ-ÿ'.-]+(?:\s+[A-Za-zÀ-ÿ'.-]+){1,2}?)(?=\s*(?:[,.;(\n]|$|\s+(?:npi|from|at|of)\b))/gi)) {
    const from = (knownNames || []).find((k) => sameDoctorName(k, r[1]) || sameDoctorName(String(k).split(/\s+[-–—]\s+/)[0], r[1]));
    if (from && !sameDoctorName(from, r[2])) out.push([from, r[2].trim()]);
  }
  for (const part of String(text || '').replace(/^\s*(?:yes|yep|yeah|correct|ok(?:ay)?)\b[\s.,!:;-]*/i, '').split(/[;\n]|,(?=\s*[A-Za-z][^,]*?(?:=|→|->|\bis\b))/)) {
    const m = part.match(/^\s*(?:\d+[.)]\s*)?(?:dr\.?\s*)?([A-Za-z][A-Za-z .'-]{1,70}?)\s*(?:=|→|->|\bis actually\b|\bis really\b|\bshould be\b|\bmeans\b|\bis\b)\s*(?:dr\.?\s*)?([A-Za-z][A-Za-z .,'-]{2,60}?)\s*[.!]?\s*$/i);
    if (!m) continue;
    // "Pascual De Santis is already on the list" / "is fine" / "is in network" is a statement, not a new name.
    if (/^(?:already|also|still|on|in|not|the|a|an|fine|ok(?:ay)?|good|right|correct|covered|listed|there|staying|her|his|my|our)\b/i.test(m[2].trim())) continue;
    const from = (knownNames || []).find((k) => sameDoctorName(k, m[1]));
    if (from && !sameDoctorName(from, m[2])) out.push([from, m[2].trim()]);
  }
  return out;
}

/** Turn her reply to Max's numbered questions into plain statements the selector reads. */
function statementsFor(question, answer) {
  const q = String(question || '');
  const a = String(answer || '').trim();
  if (!a) return [];
  if (/Medicaid or a Medicare Savings Program/i.test(q)) {
    if (NO_RE.test(a)) return ['No Medicaid.'];
    if (/full/i.test(a)) return [`Full Medicaid. ${a}.`];
    if (/msp|qmb|slmb|\bqi\b|qdwi|partial/i.test(a)) return [`MSP only: ${a}.`];
    return [];
  }
  if (/Which MSP level/i.test(q)) return [`MSP only: ${a}.`];
  if (/C-SNP qualifying/i.test(q)) {
    if (NO_RE.test(a)) return ['No C-SNP qualifying condition.'];
    return [`C-SNP qualifying condition confirmed: ${a}.`];
  }
  if (/Confirm the (doctor )?match/i.test(q)) {
    const names = [...q.matchAll(/(?:^|[:;]\s*)([^:;→]+?)\s*→/g)].map((m) => m[1].trim());
    return matchVerdicts(names, a);
  }
  if (/No exact match/i.test(q)) {
    const asked = [...q.matchAll(/"([^"]+)"\s*—/g)].map((m) => m[1].trim());
    const subs = substitutionsIn(a, asked);
    // "yes" → take every "did you mean …?" spelling fix offered in the question.
    if (!subs.length && YES_RE.test(a) && !NO_RE.test(a)) {
      for (const m of q.matchAll(/"([^"]+)"\s*—\s*did you mean ([^(?]+?)(?:,\s*[A-Z.]{2,8})?\s*(?:\(|\?)/g)) subs.push([m[1].trim(), m[2].trim()]);
      if (subs.length) return subs.map(([from, to]) => `Doctor substitution: ${from} => ${to}.`);
    }
    if (!subs.length && asked.length === 1 && /[a-z]{3}/i.test(a) && !NO_RE.test(a)) {
      subs.push([asked[0], a.replace(/^\s*(?:try|use|maybe|it'?s|its|is|=|check|add|change(?:\s+(?:it|him|her|that))?\s+to|switch(?:\s+(?:it|him|her))?\s+to|replace(?:\s+(?:it|him|her))?\s+with|should\s+be|spelled|instead)\s*/i, '').replace(/^dr\.?\s*/i, '').replace(/[.]+$/, '').trim()]);
    }
    return subs.map(([from, to]) => `Doctor substitution: ${from} => ${to}.`);
  }
  if (/must-keep/i.test(q)) return [`Must-keep doctors: ${a}.`];
  if (/HMO OK|PPO/i.test(q)) return [/ppo/i.test(a) && !/hmo ok|either/i.test(a) ? 'Needs a PPO.' : `Network: ${a} (HMO ok).`];
  if (/meds/i.test(q)) {
    if (NO_RE.test(a)) return ['No meds.'];
    // "both" / "yes" / "same" answers the question, it is not a drug name.
    return R.isNonDrugAnswer(a) ? [] : [`Meds: ${a}`];
  }
  return [];
}

/**
 * The ask text the comparison reads: her recent messages, plus
 *  - her numbered replies to Max's questions turned into statements
 *    ("1. no" → "No Medicaid.", "3. yes" → "Doctor matches confirmed: …"),
 *  - the carriers she asked to see ("show me doctors health, solis, devoted"),
 *    newest request wins over older plan IDs.
 */
function comparisonAskText(messages, baseText) {
  const msgs = Array.isArray(messages) ? messages : [];
  const lines = [String(baseText != null ? baseText : msgs.filter((m) => m && m.role === 'user').slice(-4).map(messageText).join('\n'))];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (!m || m.role !== 'assistant') continue;
    const qs = askedQuestions(messageText(m));
    if (!qs.length) continue;
    const reply = msgs.slice(i + 1).find((x) => x && x.role === 'user');
    if (!reply) continue;
    const answers = numberedAnswers(messageText(reply));
    qs.forEach((q, k) => { if (q && answers[k]) statementsFor(q, answers[k]).forEach((st) => lines.push(st)); });
  }
  // A workspace result pasted into chat ("Doctors: …\nPlans: H5420-001"): that single plan is the client's current plan.
  // Without this line the follow-up turns dropped it and showed three other plans (Jackie Alexander, 2026-10-13).
  if (!lines.some((l) => /^Her current plan:/m.test(l))) {
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (!m || m.role !== 'user') continue;
      const t = messageText(m);
      if (isWorkupMessage(t) || !/\b(?:doctors?|drs?)\s*:/i.test(t)) continue;
      const ids = [...new Set([...(t.match(/^Plans?:\s*([^\n]+)$/im) || ['', ''])[1].matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((x) => x[1].toUpperCase()))];
      if (ids.length === 1) lines.unshift(`Her current plan: ${ids[0]}.`);
      break;
    }
  }
  // A loaded workup that names the client's current plan: it is the first column on every follow-up
  // (Jackie: UHC H5420-001 vanished after the three doctor corrections, 2026-10-13).
  if (!lines.some((l) => /^Her current plan:/m.test(l))) {
    const wk0 = workupFacts(msgs);
    if (wk0 && wk0.current.length) lines.unshift(`Her current plan: ${wk0.current.join(', ')}.`);
  }
  // "any other plans comparable to what she has?" — her saved/named plan is the CURRENT plan; add alternatives around it.
  // It stays true for the whole thread: answering Max's follow-up questions must not drop her current plan.
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const mt = messageText(m);
    // The loaded-workup message is not her ask: its rules text says "other, comparable or better
    // plans" and its plan list held the Aetna comparison column (Maura, 2026-10-07).
    if (/structured facts only/i.test(mt)) continue;
    if (!WANTS_ALTERNATIVES_RE.test(mt) && !R.impliesCompareToCurrentPlan(mt)) continue;
    lines.push('Wants alternatives to the named plan(s).');
    // Plan IDs she typed with that ask — unless the recent messages already carry them.
    // "compare Humana H1036-054C and DrMax H4140-022 with her current plan": those IDs are the other side, not hers
    // (golden suite, Edward Kennedy shape — they were read as her current plan and UHC H5420-001 vanished).
    const idsHere = LW.lineKeepsCurrentPlan(mt)
      ? currentPlanIdsIn(mt)
      : [...new Set([...mt.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((x) => x[1].toUpperCase()))];
    const wk = workupFacts(msgs);
    const current = idsHere.length ? idsHere : (wk ? wk.current : []);
    // First, so any plan she names later in the thread (a swap / add) still wins over it.
    if (current.length) lines.unshift(`Her current plan: ${current.join(', ')}.`);
    if (wk && wk.zip && !/\b3\d{4}\b/.test(lines.join('\n'))) lines.push(`ZIP ${wk.zip}.`);
    break;
  }
  // Newest user message that asks for carriers or names plan IDs decides the columns.
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const t = joinWrappedQuotes(messageText(m));
    // Its rules text ("…asks for different plans, doctors, drugs…") read as a Doctors HealthCare
    // ask whenever her own message named no carrier (Gail, 2026-10-08).
    if (isWorkupMessage(t)) continue;
    const carriers = R.carriersRequested(t);
    // "HUMANA WONT WORK THEN. check on another plan": other carriers, re-checked now — not
    // the old carrier ask and not the plans she already named (Maura, 2026-10-07).
    // "Find the plans that cover the most of her 5 doctors … Include UHC MedicareMax FL-0028.
    // Exclude Humana. Show the top 3": rank every eligible plan in the county — a carrier she
    // names inside "include <plan>" / "exclude <carrier>" is not a carrier ask (Maura, 2026-10-07).
    // "Search all Dade Core plans for Dr X. What does she take?": every regular (non-SNP) plan on the county grid,
    // every carrier — not Devoted's "CORE" plans, not the last comparison's plans, no Medicaid / C-SNP questions
    // (Yahoska, 2026-10-17: "I asked what core plans, not just Devoted … I want to see what's in network").
    if (CORE_ALL_RE.test(t)) {
      lines.push('Rank all eligible plans.');
      lines.push(CORE_ALL_LINE);
      if (/\b(?:miami[-\s]?)?dade\b/i.test(t)) lines.push('County: Miami-Dade.');
      else if (/\bbroward\b/i.test(t)) lines.push('County: Broward.');
      break;
    }
    // Loaded workup + "Drop careplus and add Humana": her saved plans minus the dropped carrier plus the added
    // carrier's core plan — nothing else. "They are in network with Humana and Doctors" is not a carrier ask, and a
    // carrier already in the set never pulls in its sibling plans (Nancy Blanco De Pajaro, 2026-10-17: DrSelect-SFL
    // H4140-023 appeared unasked and UHC H5420-001 was dropped).
    // "check this plan Devoted C-SNP ENHANCED H1290-067" / "add dvoted to the grid": saved plans + that plan (Gerry Cabrera, 2026-10-19).
    if (i === msgs.map((x) => x && x.role).lastIndexOf('user') && !/\b[HR]\d{4}-\d{3}/i.test(t)) {
      const byName = planNamesInAsk(t, R.countyFromAsk(msgs.map(messageText).join('\n')) || 'Miami-Dade');
      const amb = byName.ambiguous;
      const cap = (x) => x.replace(/\b([a-z])/g, (c) => c.toUpperCase());
      if (amb.length) lines.push(`Plan names not matched: ${amb.map((a) => `${cap(a.name)} (${a.ids.join(' or ')})`).join(' | ')}.`);
      // Only an ambiguous name: the plans already on the grid stay as they are (no carrier swap) until she gives the ID.
      if (amb.length && !byName.ids.length) {
        const wkB = workupFacts(msgs.slice(0, i + 1));
        const base = wkB && wkB.plans.length ? wkB.plans : LW.lastTablePlanIds(msgs.slice(0, i + 1));
        if (base.length) {
          const nm = (id) => { const row = gridRowFor(id, ''); return row ? (carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim()) : id; };
          lines.push(`Named plan set: ${base.map((id) => `${nm(id)} (${id})`).join('; ')}.`);
          break;
        }
      }
    }
    // "only PPOs" / "show me the PPOs" / "compare all HMOs" / "top 5 PPOs" in her NEWEST message: rank every plan of that
    // type in her county on her doctors and meds — top 5, or all of them when the county has 5 or fewer. Before, these
    // re-sent the saved table or fell back to HMOs (Robert and Andrea, 2026-10-19).
    // Her answer to the doctor-match question under that table keeps the ranking she asked for (rankAskAt).
    const typeAsk = i === rankAskAt(msgs) ? planTypeAsk(t) : null;
    if (typeAsk) {
      // Same lines as the compare card's plan-type ask (planTypeAskLines, compareJobs.askTextFor).
      const block = planTypeAskLines(typeAsk, {
        current: currentPlanOf(msgs.slice(0, i + 1)),
        excluded: excludedCarriers(msgs.slice(0, i + 1)),
        zip: /\b3\d{4}\b/.test(lines.join('\n')) ? '' : newestZip(msgs.slice(0, i + 1)),
      });
      lines.push(...block.lines);
      if (block.current && !/^Her current plan:/m.test(lines.join('\n'))) lines.unshift(block.current);
      break;
    }
    const addSet = require('./loadedWorkup').workupPlanAddSet(t, msgs.slice(0, i + 1));
    if (addSet.length) {
      if (addSet.added && addSet.added.length) lines.push(`Plans she added: ${addSet.added.join(', ')}.`);
      lines.push(`Named plan set: ${addSet.map((pl) => `${pl.name} (${pl.planId})`).join('; ')}.`);
      break;
    }
    const editSet = workupCarrierEditSet(t, msgs.slice(0, i + 1));
    if (editSet.length) {
      lines.push(`Named plan set: ${editSet.map((pl) => `${pl.name} (${pl.planId})`).join('; ')}.`);
      break;
    }
    const typeSet = planTypeSetFromAsk(t, msgs.slice(0, i + 1));
    if (typeSet.length) {
      lines.push(`Named plan set: ${typeSet.map((pl) => `${pl.name} (${pl.planId})`).join('; ')}.`);
      break;
    }
    // "yeah run her drs on the csnps with cardiovascular disorders": the agent confirms the condition —
    // rank the county's C-SNPs for that condition, current plan pinned (Maura, 2026-10-07).
    const csnpRun = R.csnpRunAsk(t);
    if (RANK_ASK_RE.test(t) || csnpRun) {
      const excluded = excludedCarriers(msgs.slice(0, i + 1));
      if (excluded.length) lines.push(`Carriers excluded: ${excluded.join(', ')}.`);
      lines.push('Rank all eligible plans.');
      if (csnpRun) {
        const conds = R.conditionsIn(t);
        lines.push(`Run C-SNPs${conds.length ? ` for ${conds.join(' / ')}` : ''} — agent-confirmed condition.`);
        if (!/\btop\s+\d\b/i.test(t)) lines.push('Top 4.');
      }
      const top = (t.match(/\btop\s+(\d)\b/i) || [])[1];
      if (top) lines.push(`Top ${top}.`);
      const include = [];
      for (const m of t.matchAll(/\b(?:include|including|add|plus|also)\s+([^.;\n]+)/gi)) {
        const ids = [...namedPlansFromAsk(m[1], askConstraints(m[1])).map((pl) => pl.planId), ...gridPlansByName(m[1], R.countyFromAsk(t))];
        for (const id of ids) if (!include.some((x) => x.slice(0, 9) === id.slice(0, 9))) include.push(id);
      }
      if (include.length) lines.push(`Include plans: ${include.join(', ')}.`);
      const current = currentPlanOf(msgs.slice(0, i + 1));
      if (current.length && !/^Her current plan:/m.test(lines.join('\n'))) lines.unshift(`Her current plan: ${current.join(', ')}.`);
      if (!/\b3\d{4}\b/.test(lines.join('\n'))) {
        const zip = newestZip(msgs.slice(0, i + 1));
        if (zip) lines.push(`ZIP ${zip}.`);
      }
      break;
    }
    const other = R.carriersRejected(t).length > 0 || R.wantsOtherCarrier(t);
    if (other) {
      const excluded = excludedCarriers(msgs.slice(0, i + 1));
      if (excluded.length) lines.push(`Carriers excluded: ${excluded.join(', ')}.`);
      if (carriers.length) lines.push(`Carriers requested: ${carriers.join(', ')}.`);
      else lines.push('Wants another carrier.');
      if (R.carriersUnresolved(t).length) lines.push(`Carriers not recognized: ${R.carriersUnresolved(t).join(' | ')}.`);
      const current = currentPlanOf(msgs.slice(0, i + 1));
      if (current.length && !/^Her current plan:/m.test(lines.join('\n'))) lines.unshift(`Her current plan: ${current.join(', ')}.`);
      if (!/\b3\d{4}\b/.test(lines.join('\n'))) {
        const zip = newestZip(msgs.slice(0, i + 1));
        if (zip) lines.push(`ZIP ${zip}.`);
      }
      break;
    }
    // Unmatched names count on their own only in a "compare … to X" ask; otherwise next to a carrier she named.
    const unmatched = carriers.length || /\bcompar/i.test(t) ? R.carriersUnresolved(t) : [];
    if (carriers.length || unmatched.length) {
      if (carriers.length) lines.push(`Carriers requested: ${carriers.join(', ')}.`);
      // A name she listed that matches no carrier is said, never dropped (Robin Forte, 2026-10-17).
      if (unmatched.length) lines.push(`Carriers not recognized: ${unmatched.join(' | ')}.`);
      // Her current plan stays a column in a carrier ask (Doctors HealthCare dropped H1045-001 — Enrique, 2026-10-07).
      const current = currentPlanOf(msgs.slice(0, i + 1));
      if (current.length && !/^Her current plan:/m.test(lines.join('\n'))) lines.unshift(`Her current plan: ${current.join(', ')}.`);
      break;
    }
    // A message that names plan IDs decides the columns — "lets do H5420-014, H4140-022, …" needs no verb.
    const idsNamed = new Set((t.match(/\b[HR]\d{4}-\d{3}/gi) || []).map((x) => x.toUpperCase())).size;
    if (idsNamed >= 2 || (idsNamed && /\b(compare|show|add|instead|vs|do|use|run|go with|check|re-?check|re-?run|verify)\b/i.test(t))) break;
  }
  // The plan type comes from her newest message only (askConstraints reads this line, not the older messages).
  lines.push(planTypeLine(msgs));
  return lines.join('\n');
}

/** Carriers she ruled out and has not asked for again since (oldest → newest). */
function excludedCarriers(msgs) {
  const out = new Set();
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const t = messageText(m);
    for (const c of R.carriersRequested(t)) out.delete(c);
    for (const c of R.carriersRejected(t)) out.add(c);
  }
  return [...out];
}

/** Current plan from what she typed, else the loaded workup's "Current plan:" line. */
function currentPlanOf(msgs) {
  const typed = currentPlanIdsIn(msgs.filter((x) => x && x.role === 'user' && !/structured facts only/i.test(messageText(x))).map(messageText).join('\n'));
  if (typed.length) return typed;
  const wk = workupFacts(msgs);
  return wk ? wk.current : [];
}

/** Her client's current plan IDs ("current plan UHC Preferred H1045-001", "Her current plan: …"). */
function currentPlanIdsIn(text0) {
  const text = normalizeTypedPlanIds(text0);
  const ids = [];
  const re = /\b(?:current(?:ly)?(?:\s+plan)?|is\s+on|stay(?:ing)?\s+on|her\s+plan|his\s+plan)\b[^.\n]{0,60}?\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi;
  for (const m of String(text || '').matchAll(re)) {
    // "compare her current plan with Humana H1036-054C" — that ID is the other side, not hers.
    if (/\b(?:with|vs\.?|versus|against|to|and|or|instead)\b/i.test(m[0].slice(0, m[0].length - m[1].length))) continue;
    const id = m[1].toUpperCase();
    if (!ids.some((x) => x.slice(0, 9) === id.slice(0, 9))) ids.push(id);
  }
  return ids;
}

function newestZip(msgs) {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const z = (messageText(m).match(/\b(3[234]\d{3})\b/) || [])[1];
    if (z) return z;
  }
  const wk = workupFacts(msgs);
  return wk && wk.zip ? wk.zip : '';
}



// "show me aetna csnp, aetna core, and her current plan on a grid\" (Maura, 2026-10-07): each part names
// a plan TYPE of a carrier. Those plans are the columns — never dropped for eligibility, nothing added.
const PLAN_TYPE_RE = /\b(c-?snps?|chronic(?:\s+care)?|d-?snps?|dual|core|flagship|hmo|ppo)\b/i;
function planTypeSetFromAsk(text, msgs) {
  const t = String(text || '');
  if (/structured facts only/i.test(t) || /\b[HR]\d{4}-\d{3}/i.test(t)) return [];
  const parts = t.split(/,|;|\band\b|&|\bplus\b|\bvs\.?\b|\bversus\b/i).map((x) => x.trim()).filter(Boolean);
  const typed = parts.filter((x) => carrierKey(x) && PLAN_TYPE_RE.test(x));
  if (!typed.length) return [];
  const county = R.countyFromAsk(t) || R.countyFromAsk(msgs.map(messageText).join('\n')) || 'Miami-Dade';
  const wk = workupFacts(msgs);
  const rows = R.gridPlansForCounty(county);
  const out = [];
  const add = (id, name) => {
    const key = String(id).toUpperCase().slice(0, 9);
    if (key && !out.some((x) => x.planId.slice(0, 9) === key)) out.push({ planId: key, name: name || key });
  };
  const nameOf = (row) => (carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim());
  for (const part of parts) {
    if (/\b(current|existing|her|his)\s+plan\b/i.test(part) && !carrierKey(part)) {
      for (const id of currentPlanOf(msgs)) { const row = gridRowFor(id, county); add(id, row ? nameOf(row) : id); }
      continue;
    }
    const carrier = carrierKey(part);
    const type = (part.match(PLAN_TYPE_RE) || [])[1];
    if (!carrier || !type) continue;
    const mine = rows.filter((r) => R.carrierOfPlan(r) === carrier);
    let hits = [];
    if (/c-?snp|chronic/i.test(type)) hits = mine.filter((r) => R.snpKind(r) === 'csnp');
    else if (/d-?snp|dual/i.test(type)) hits = mine.filter((r) => R.snpKind(r) === 'dsnp');
    else if (/ppo/i.test(type)) hits = mine.filter((r) => /ppo/i.test(String(r.type || '')));
    else {
      // Core: a grid plan named "Core", else her saved plan of that carrier, else the carrier's core HMO.
      hits = mine.filter((r) => /\bcore\b/i.test(String(r.planName || '')) && !R.snpKind(r));
      if (!hits.length && wk) hits = mine.filter((r) => wk.plans.includes(String(r.planId).toUpperCase().slice(0, 9)) && !R.snpKind(r));
      if (!hits.length) hits = mine.filter((r) => corePlanIdsFor(carrier, county).includes(String(r.planId).toUpperCase().slice(0, 9)));
    }
    hits.slice(0, 3).forEach((r) => add(r.planId, nameOf(r)));
  }
  return out;
}


// "CAN YOU PLEASE RUN THIS SEARCH FOR HUMANA PPO Humana Choice H7617-107 AND Humana Choice Giveback H7617-110" /
// "add Humana Choice Giveback" / "check H7617-107 too": she names plans to run her doctors and meds on. The server
// re-runs the comparison with those plans added — the model alone re-sent its previous table with neither plan in it
// (Robert and Andrea, 2026-10-19). Returns the plan IDs she named ([] when the message is not a plan ask).
const PLAN_ASK_RE = /\b(?:check|re-?check|re-?run|run|search|look\s*(?:up|at)|verify|add|include|plus|show|compare|price|try|see|put)\b/i;
function namedPlanAskIds(text, msgs) {
  const t = normalizeTypedPlanIds(String(text || ''));
  if (!t.trim() || isWorkupMessage(t) || !PLAN_ASK_RE.test(t)) return [];
  if (/^\s*(?:remove|drop|delete|take\s+out|get\s+rid\s+of|without|no\s+more)\b/i.test(t)) return [];
  const ids = [...new Set([...t.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase()))];
  if (ids.length) return ids;
  const county = R.countyFromAsk((msgs || []).map(messageText).join('\n')) || 'Miami-Dade';
  const byName = planNamesInAsk(t, county);
  // An ambiguous name still re-runs: the follow-up bubble asks which plan ID she meant.
  return byName.ids.length ? byName.ids : byName.ambiguous.length ? ['a plan name that matches more than one plan'] : gridPlansByName(t, county);
}

function comparisonFollowUp(messages) {
  const out = comparisonFollowUpRaw(messages);
  if (!out || !Array.isArray(out.doctors)) return out;
  const msgs = Array.isArray(messages) ? messages : [];
  const lastUserAt = msgs.map((m) => m && m.role).lastIndexOf('user');
  const latest = lastUserAt >= 0 ? messageText(msgs[lastUserAt]) : '';
  const doctors = respelledDoctors(latest, out.doctors);
  if (doctors.every((d, k) => d === out.doctors[k])) return out;
  const npis = { ...(out.npis || {}) };
  out.doctors.forEach((d, k) => { if (doctors[k] !== d && npis[d]) { npis[doctors[k]] = npis[d]; delete npis[d]; } });
  return { ...out, doctors, reason: `${out.reason} + doctor corrections`, ...(Object.keys(npis).length ? { npis } : {}) };
}

function comparisonFollowUpRaw(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const lastUserAt = msgs.map((m) => m && m.role).lastIndexOf('user');
  if (lastUserAt < 0) return null;
  const latest = messageText(msgs[lastUserAt]);
  const reasons = [];
  const planAsk = namedPlanAskIds(latest, msgs.slice(0, lastUserAt + 1));
  const carriers = R.carriersRequested(latest);
  if (carriers.length) reasons.push(`carriers asked: ${carriers.join(', ')}`);
  const rejected = R.carriersRejected(latest);
  const wantsOther = rejected.length > 0 || R.wantsOtherCarrier(latest);
  if (wantsOther) reasons.push(`another carrier${rejected.length ? ` (not ${rejected.join(', ')})` : ''}`);
  if (WANTS_ALTERNATIVES_RE.test(latest)) {
    const wk = workupFacts(msgs.slice(0, lastUserAt + 1));
    if (wk && wk.doctors.length >= 1 && wk.plans.length) {
      reasons.push('alternatives to her saved plan');
      return { reason: reasons.join(' + '), doctors: wk.doctors, zip: wk.zip };
    }
  }
  // "Find the plans that cover the most of her 5 doctors" on a loaded workup: rank with the saved doctors
  // (full names; their saved NPIs are reused by lookup_provider_network).
  if (R.csnpRunAsk(latest)) reasons.push('run C-SNPs (agent-confirmed condition)');
  // "only PPOs" / "compare all HMOs": a ranking of that plan type — the server re-runs it, never the saved table.
  const typeAsk = planTypeAsk(latest);
  if (typeAsk) reasons.push(`${typeAsk.type.toUpperCase()}s only`);
  if ((RANK_ASK_RE.test(latest) || R.csnpRunAsk(latest) || typeAsk) && !/\b(?:doctors?|drs?|providers?)\s*:/i.test(latest)) {
    const wk = workupFacts(msgs.slice(0, lastUserAt + 1));
    if (wk && wk.doctors.length >= 2) {
      if (RANK_ASK_RE.test(latest) || typeAsk) reasons.push('rank all plans by her doctors');
      // A doctor she already confirmed from the "No exact match" candidates is that provider here too — counted in the
      // ranking, not ❔ not confirmed again (Robert and Andrea, 2026-10-19).
      const picked = pickedDoctors(msgs, lastUserAt, wk.doctors);
      return { reason: reasons.join(' + '), doctors: picked.doctors, zip: newestZip(msgs.slice(0, lastUserAt + 1)) || wk.zip, ...(Object.keys(picked.npis).length ? { npis: picked.npis } : {}) };
    }
  }
  const prevAssistant = msgs.slice(0, lastUserAt).reverse().find((m) => m && m.role === 'assistant');
  if (prevAssistant && askedQuestions(messageText(prevAssistant)).filter(Boolean).length && Object.keys(numberedAnswers(latest)).length) {
    reasons.push('numbered answers');
  }
  // Doctors + ZIP from the newest user message that listed them ("Doctors: …").
  const { parseCompareAsk } = require('./compareJobs'); // lazy: compareJobs requires this file
  for (let i = lastUserAt; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const t = messageText(m);
    // A plan ask on a chat whose doctors were typed as a plain list ("Robert and Andrea, 33186, Dr. Nathalie Regalado,
    // Dr. Michael Weitz, …") — no "Doctors:" label: that earlier message is the doctor list.
    const plainList = (planAsk.length || typeAsk || isDoctorMatchAnswer(msgs, lastUserAt)) && i < lastUserAt && !isWorkupMessage(t) && /\b(?:dr|dra|doctor)\.?\s+[A-Z]/i.test(t)
      && parseCompareAsk(t).doctors.length >= 2;
    if (!/\b(?:doctors?|drs?|providers?)\s*:/i.test(t) && !plainList) continue;
    const f = parseCompareAsk(t);
    if (f.doctors.length < 2) return null;
    let names = f.doctors.map((d) => d.name);
    // Her corrections ("Carlos Sosa = Glenda Sosa"), in the latest message or as answers.
    // Every correction she made after listing the doctors still applies (oldest first).
    const later = msgs.slice(i + 1, lastUserAt + 1).filter((x) => x && x.role === 'user').map(messageText);
    const subs = [
      ...later.flatMap((t2) => substitutionsIn(t2, names)),
      ...[...comparisonAskText(msgs).matchAll(/Doctor substitution: (.+?) => (.+?)\.$/gm)].map((x) => [x[1], x[2]]),
    ];
    if (substitutionsIn(latest, names).length) reasons.push('doctor corrections');
    const prevQ = prevAssistant ? messageText(prevAssistant) : '';
    // A candidate she picked from the "No exact match" list: that provider (name + NPI) replaces the doctor she typed.
    const picks = candidatePicks(prevQ, latest);
    const pickNpis = {};
    for (const pk of picks) {
      const from = names.find((nm) => sameDoctorName(nm, pk.asked) || plainWords(nm).join(' ') === plainWords(pk.asked).join(' '));
      if (!from) continue;
      subs.push([from, pk.name]);
      if (pk.npi) pickNpis[pk.name] = pk.npi;
      if (!reasons.includes('doctor corrections')) reasons.push('doctor corrections');
    }
    // "Try Alan Dal Pra" / "its Zubair Ansari" in answer to ONE "No exact match" doctor: that name replaces it, and the
    // other doctors stay in the run (Melmoth Alexander, 2026-10-13: the reply re-ran only the new doctor).
    if (!picks.length && /No exact match for/i.test(prevQ) && !Object.keys(numberedAnswers(latest)).length) {
      const askedNames = [...prevQ.matchAll(/"([^"]+)"\s*—/g)].map((x) => x[1].trim());
      const said = latest.replace(/^\s*(?:try|use|maybe|its|it's|it is|is|=|check|add|change(?:\s+(?:it|him|her|that))?\s+to|switch(?:\s+(?:it|him|her))?\s+to|replace(?:\s+(?:it|him|her))?\s+with|should\s+be|spelled|instead)\s+/i, '').replace(/^dr\.?\s+/i, '').replace(/[.!?]+\s*$/, '').trim();
      const wordsSaid = said.split(/\s+/).filter(Boolean);
      if (askedNames.length === 1 && wordsSaid.length >= 2 && wordsSaid.length <= 5 && /^[A-Za-zÀ-ÿ'.,\- ]+$/.test(said) && !carriers.length) {
        subs.push([askedNames[0], said]);
        reasons.push('doctor corrections');
      }
    }
    // Several "No exact match" doctors and she just types the right name ("Pascual De Santis, MD", "yes, and the
    // endocrinologist is Pascual De Santis"): it goes to the one asked name it plainly resembles.
    if (!picks.length && /No exact match for/i.test(prevQ) && !carriers.length) {
      const asked = [...prevQ.matchAll(/"([^"]+)"\s*—/g)].map((x) => x[1].trim());
      if (asked.length > 1) {
        const letters = (w) => String(w || '').toLowerCase().replace(/[^a-z]/g, '');
        const lev = (x, y) => {
          let row = Array.from({ length: y.length + 1 }, (_, j) => j);
          for (let a = 1; a <= x.length; a += 1) { const cur = [a]; for (let b = 1; b <= y.length; b += 1) cur[b] = Math.min(row[b] + 1, cur[b - 1] + 1, row[b - 1] + (x[a - 1] === y[b - 1] ? 0 : 1)); row = cur; }
          return row[y.length];
        };
        const segs = latest.replace(/,\s*(?:MD|DO|DDS|DMD|DPM|OD|ARNP)\b\.?/gi, '').split(/[\n;.]|\band\b/i);
        for (let seg of segs) {
          seg = seg.replace(/^\s*(?:yes|yep|yeah|ok(?:ay)?|correct|try|use|the\s+[a-z]+\s+(?:is|=)|[a-z]+\s+is)[\s,:-]*/i, '').replace(/^\s*dr\.?\s+/i, '').trim();
          const w = seg.split(/\s+/).filter(Boolean);
          if (w.length < 2 || w.length > 4 || !/^[A-Za-zÀ-ÿ'\- ]+$/.test(seg)) continue;
          const first = letters(w[0]);
          const last = w.slice(1).map(letters).join('');
          const hits = asked.filter((nm) => {
            const t = nm.split(/\s+[-–—]\s+/)[0].split(/\s+/).filter(Boolean);
            if (t.length < 2) return false;
            const af = letters(t[0]);
            const al = t.slice(1).map(letters).join('');
            return lev(first, af) <= 3 && lev(last, al) <= 2;
          });
          if (hits.length === 1 && !subs.some(([f]) => f === hits[0])) { subs.push([hits[0], seg]); if (!reasons.includes('doctor corrections')) reasons.push('doctor corrections'); }
        }
      }
    }
    // "yes" to "did you mean Neeta Jane Erinjeri, MD (…)?" — in this reply or any earlier one: the spelling Max found
    // replaces the name she typed.
    for (let k = i + 1; k < lastUserAt; k += 1) {
      const qa = msgs[k];
      const ua = msgs[k + 1];
      if (!qa || qa.role !== 'assistant' || !ua || ua.role !== 'user') continue;
      const q = messageText(qa);
      const yesText = messageText(ua);
      // A bare "yes" on its own line counts even when her other corrections share the message
      // ("yes\nPasquel … = Dr. Pascual De Santis, MD\nYes, Natalie C Regalado Dc" — Jacqueline Alexander, 2026-10-13).
      const startsYes = /^\s*(?:yes|yep|yeah|correct|ok(?:ay)?)\b/i.test(yesText) || /^\s*(?:yes|yep|yeah|correct|ok(?:ay)?)[.!,]?\s*$/im.test(yesText);
      if (!/No exact match for/i.test(q) || (!startsYes && !/\byes\b/i.test(yesText))) continue;
      for (const x of q.matchAll(/["“]([^"”]+)["”]\s*[—–-]\s*did you mean\s+([^(?]+?)\s*(?:\(|\?)/g)) {
        // "Pascual De Santis MD. yes to Neeta": a yes later in the message counts when it names that doctor.
        if (!startsYes && !yesText.toLowerCase().includes(String(x[2]).trim().split(/\s+/)[0].toLowerCase())) continue;
        const to = x[2].replace(/,\s*(?:MD|DO|DDS|DMD|DPM|OD|ARNP|PA-C?)\b.*$/i, '').trim();
        if (to && !subs.some(([f]) => sameDoctorName(f, x[1]))) { subs.push([x[1].trim(), to]); if (!reasons.includes('doctor corrections')) reasons.push('doctor corrections'); }
      }
    }
    if (WANTS_ALTERNATIVES_RE.test(latest) && /\b[HR]\d{4}-\d{3}[A-Z]?\b/i.test(latest)) reasons.push('alternatives to her current plan');
    // "Confirm the doctor match: Natalie Regalado - Baptist Medical Group → Natalie C Regalado Dc (NPI 1396060109). Right doctor?"
    // + "Yes, Natalie C Regalado Dc": that NPI is looked up on every plan. Re-running the name alone left her
    // unchecked / not confirmed on every column (Jacqueline Alexander, 2026-10-13).
    const confirmed = {};
    for (let k = i + 1; k < lastUserAt; k += 1) {
      const qa = msgs[k];
      const ua = msgs[k + 1];
      if (!qa || qa.role !== 'assistant' || !ua || ua.role !== 'user') continue;
      const yesText = messageText(ua);
      const bareYes = /^\s*(?:yes|yep|yeah|correct|ok(?:ay)?)[.!]?\s*$/i.test(yesText);
      for (const x of messageText(qa).matchAll(/(?:^|[:;\n]\s*)([^:;\n→]+?)\s*→\s*([^(\n→]+?)\s*\(NPI\s*(\d{10})\)/g)) {
        const mw = plainWords(x[2]);
        const last = mw[mw.length - 1] === 'dc' || mw[mw.length - 1] === 'md' ? mw[mw.length - 2] : mw[mw.length - 1];
        const ok = bareYes || yesText.split('\n').some((l) => /\b(?:yes|yeah|yep|correct|right|confirm(?:ed)?)\b/i.test(l)
          && !/\b(?:no|not|wrong)\b/i.test(l) && last && plainWords(l).includes(last));
        if (ok) confirmed[x[1].replace(/^\s*(?:[•*-]|also)\s*/i, '').trim()] = x[3];
      }
    }
    if (Object.keys(confirmed).length && !reasons.includes('doctor corrections')) reasons.push('doctor match confirmed');
    // Her yes to "'X' looks like a duplicate of Y. Remove it?": that row leaves the run.
    const dupYes = confirmedDuplicateRemovals(msgs, lastUserAt);
    if (dupYes.length) {
      const before = names.length;
      names = names.filter((nm) => !dupYes.some((x) => plainWords(x).join(' ') === plainWords(nm).join(' ')));
      if (names.length < before) reasons.push('duplicate removal confirmed');
    }
    // "Remove Dr. X" after the list: only the doctors she named leave the run.
    const removals = later.flatMap(doctorRemovalClauses);
    if (removals.length) {
      const before = names.length;
      names = names.filter((nm) => !removedByClauses(nm, removals));
      if (names.length < before && doctorRemovalClauses(latest).length) reasons.push('doctor removals');
    }
    if (planAsk.length && !reasons.length) reasons.push(`plans she named: ${planAsk.join(', ')}`);
    if (!reasons.length) return null;
    for (const [from, to] of subs) names = names.map((nm) => (sameDoctorName(nm, from) ? to : nm));
    const zip = f.zip || (msgs.slice(0, lastUserAt + 1).map(messageText).join(' ').match(/\b(3\d{4})\b/) || [])[1] || '';
    const npis = {};
    for (const nm of names) for (const [asked, npi] of Object.entries(confirmed)) if (sameDoctorName(nm, asked)) npis[nm] = npi;
    for (const nm of names) if (pickNpis[nm]) npis[nm] = pickNpis[nm];
    // One entry per doctor: a corrected spelling that lands on a name already listed is that name.
    const unique = names.filter((nm, k) => names.findIndex((o) => plainWords(o).join(' ') === plainWords(nm).join(' ')) === k);
    return { reason: reasons.join(' + '), doctors: unique, zip, ...(Object.keys(npis).length ? { npis } : {}) };
  }
  // "check on another plan" on a loaded workup (no "Doctors:" line in the chat): its doctors.
  if (wantsOther) {
    const wk = workupFacts(msgs.slice(0, lastUserAt + 1));
    if (wk && wk.doctors.length >= 2) return { reason: reasons.join(' + '), doctors: wk.doctors, zip: wk.zip || newestZip(msgs.slice(0, lastUserAt + 1)) };
  }
  // A loaded workup + a doctor correction / NPI / confirmation: re-run ALL her saved doctors with the
  // corrections applied. The model used to run only the corrected two and swap the plans (Paula Harris, 2026-10-13).
  const fixed = workupDoctorFixes(msgs, lastUserAt, reasons.includes('numbered answers'));
  if (fixed) return fixed;
  // A loaded workup + "check Glinos on H5420-001" / "is Glinos in on UHC FL-0028?" / "add George Glinos": re-run
  // EVERY saved doctor on EVERY saved plan (plus a plan or doctor she adds). The model used to look up only the doctor
  // she named and the table collapsed to the one plan she mentioned (Robin Forte, 2026-10-17).
  const check = workupDoctorCheck(msgs, lastUserAt);
  if (check) return check;
  return null;
}

const NETWORK_CHECK_RE = /\b(?:check|re-?check|re-?run|run|look\s*up|verify|confirm|in[-\s]?network|in\s+on|is\s+(?:he|she|they|it|dr\.?\s+\S+|\S+)\s+in\b|takes?|accepts?|participat\w*|listed|covered|add(?:ed)?|include)\b/i;
function workupDoctorCheck(msgs, lastUserAt) {
  const wk = workupFacts(msgs.slice(0, lastUserAt + 1));
  if (!wk || !wk.doctors.length || !wk.plans.length) return null;
  const latest = messageText(msgs[lastUserAt]);
  if (isWorkupMessage(latest) || !NETWORK_CHECK_RE.test(latest)) return null;
  const core = (nm) => plainWords(String(nm || '').split(/\s+[-–—]\s+/)[0]);
  const words = plainWords(latest);
  const named = wk.doctors.filter((d) => { const c = core(d); const last = c[c.length - 1]; return last && last.length >= 3 && words.includes(last); });
  const doctors = wk.doctors.slice();
  // "add George Glinos" / "add Dr. Jane Roe": a doctor not on the saved list joins the run.
  const add = latest.match(/\b(?:add|include)\s+(?:(?:[Dd]ra?|[Dd]octora?)\.?\s+)?([A-ZÀ-Ý][\wÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'.-]+){1,3})/);
  let added = '';
  if (add && !carrierKey(add[1]) && !/\b[HR]\d{4}-\d{3}/i.test(add[1])) {
    const nm = add[1].trim();
    if (!doctors.some((d) => sameDoctorName(d, nm) || looseSameDoctor(d, nm) || core(d).slice(-1)[0] === plainWords(nm).slice(-1)[0])) { doctors.push(nm); added = nm; }
  }
  const planAsk = named.length || added ? [] : namedPlanAskIds(latest, msgs.slice(0, lastUserAt + 1));
  if (!named.length && !added && !planAsk.length) return null;
  return {
    reason: `check on her saved workup — all ${doctors.length} saved doctors on all saved plans${added ? ` (added ${added})` : ''}${planAsk.length ? ` + plans she named: ${planAsk.join(', ')}` : ''}`,
    doctors,
    zip: wk.zip || newestZip(msgs.slice(0, lastUserAt + 1)),
  };
}





const ADD_DOCTOR_RE = /\b(?:add|added|also|include|forgot|missing|primary|pcp|her doctor)\b/i;
const FIX_STOP_RE = /^(?:its|it's|it|is|use|this|for|the|npi|dr|doctor|her|his|she|he|with|actually|should|be|that|no|yes)$/i;

function workupDoctorFixes(msgs, lastUserAt, numbered) {
  const wk = workupFacts(msgs.slice(0, lastUserAt + 1));
  if (!wk || wk.doctors.length < 2) return null;
  const wkAt = msgs.findIndex((m) => m && m.role === 'user' && isWorkupMessage(messageText(m)));
  const people = wk.doctors.map((name) => ({ name, npi: '' }));
  let touched = false;
  for (let i = wkAt + 1; i <= lastUserAt; i += 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const prev = msgs.slice(0, i).reverse().find((x) => x && x.role === 'assistant');
    const asked = prev && /No exact match|No NPI match|did you mean|Confirm the (?:doctor )?match|confirm match|right provider/i.test(messageText(prev));
    const t = messageText(m);
    // Her pick from the "No exact match" candidates: that provider, with the NPI Max showed, on every plan in the table.
    const picks = prev ? candidatePicks(messageText(prev), t) : [];
    for (const pk of picks) {
      const who = people.find((p) => sameDoctorName(p.name, pk.asked) || plainWords(p.name).join(' ') === plainWords(pk.asked).join(' '));
      if (!who) continue;
      who.name = pk.name;
      who.npi = pk.npi || '';
      touched = true;
    }
    if (picks.length) continue;
    // "it didnt add her primary… Dr. Kelys Caballero" / "add Dr. Kelys Caballero": a doctor added to the saved list.
    if (ADD_DOCTOR_RE.test(t) && !/\b[HR]\d{4}-\d{3}/i.test(t) && !R.carriersRequested(t).length) {
      const nm = (t.match(/\b(?:dr|dra|doctor|doctora)\.?\s+([A-ZÀ-Ý][\wÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][\wÀ-ÿ'.-]+){0,3})/) || [])[1];
      if (nm && !people.some((p) => looseSameDoctor(p.name, nm) || sameDoctorName(p.name, nm))) { people.push({ name: nm.trim(), npi: '' }); touched = true; }
    }
    // "Replace Dr. Natalie Regalado with Dr. Nathalie Regalado, Baptist Medical Group, NPI 1467795633" /
    // "the doctor is Dr. Nathalie Regalado (spelled with an h)": a corrected spelling of ONE saved doctor. Every other saved
    // doctor stays in the run (Jackie Alexander, 2026-10-17: the reply re-ran only the corrected doctor and swapped the plans).
    const lev = (x, y) => {
      let row = Array.from({ length: y.length + 1 }, (_, j) => j);
      for (let a = 1; a <= x.length; a += 1) { const cur = [a]; for (let b = 1; b <= y.length; b += 1) cur[b] = Math.min(row[b] + 1, cur[b - 1] + 1, row[b - 1] + (x[a - 1] === y[b - 1] ? 0 : 1)); row = cur; }
      return row[y.length];
    };
    const spellFixes = [];
    const rep = t.match(/\b(?:replace|change|swap|correct)\s+(?:dr\.?\s+)?([A-Za-zÀ-ÿ'.-]+(?:\s+[A-Za-zÀ-ÿ'.-]+){0,3}?)\s+(?:with|to|by)\s+(?:dr\.?\s+)?([A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+){1,2})/i);
    if (rep) spellFixes.push(rep[2].trim());
    const isDr = t.match(/\bthe doctor is\s+(?:dr\.?\s+)?([A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+){1,2})/i);
    if (isDr) spellFixes.push(isDr[1].trim());
    const fixedNpis = [...t.matchAll(/\b(\d{10})\b/g)];
    for (const to of spellFixes) {
      const tw = plainWords(to);
      if (tw.length < 2) continue;
      const hit = people.find((p) => {
        const pw = plainWords(p.name);
        return pw.length >= 2 && pw.some((w) => w.length > 3 && lev(w, tw[tw.length - 1]) <= 1) && lev(pw[0], tw[0]) <= 2;
      });
      if (hit && !sameDoctorName(hit.name, to) || (hit && hit.name !== to)) {
        hit.name = to.replace(/\s+/g, ' ');
        if (fixedNpis.length === 1) hit.npi = fixedNpis[0][1];
        touched = true;
      }
    }
    // "Pinecrest Dentisry is Dr. Salome Fraga" / "Pinecrest Modern Dentistry = Dr. Salome Fraga": the saved row she names
    // (fuzzy — her spelling may be off) becomes that doctor; every other saved doctor stays in the run (Gerry Cabrera,
    // 2026-10-19: the grid showed only Salome Fraga).
    const mapped = [];
    for (const seg of t.split(/[\n;]|(?<!\b(?:[Dd]ra?|[Mm]rs?|[Mm]s|[Ss]t|[A-Z]))\.(?:\s+|$)/)) {
      const mm = seg.match(/^\s*(?:and\s+)?(?:the\s+)?([A-Za-zÀ-ÿ'’&.-]+(?:\s+[A-Za-zÀ-ÿ'’&.-]+){0,5}?)\s+(?:is|=|→|->|is\s+actually|should\s+be)\s+(?:(?:dr|dra|doctor|doctora)\.?\s+)([A-ZÀ-Ý][A-Za-zÀ-ÿ'’.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'’.-]+){1,3})\s*[.!]?\s*$/i);
      if (!mm) continue;
      const fw = plainWords(mm[1]).filter((w) => !['dr', 'the'].includes(w));
      if (!fw.length) continue;
      const hit = people.find((p) => {
        const pw = plainWords(p.name);
        return fw.every((w) => pw.some((x) => x === w || (w.length > 3 && lev(x, w) <= 2))) && lev(pw[0], fw[0]) <= 2;
      });
      if (hit && !sameDoctorName(hit.name, mm[2])) {
        hit.name = mm[2].replace(/\s+/g, ' ').trim();
        hit.npi = '';
        mapped.push(hit.name);
        touched = true;
      }
    }
    if (mapped.length) continue;
    // Her yes to Max's duplicate question removes exactly that row.
    const dupYes = confirmedDuplicateRemovals(msgs, i);
    for (let k = people.length - 1; k >= 0; k -= 1) {
      if (dupYes.some((x) => plainWords(x).join(' ') === plainWords(people[k].name).join(' '))) { people.splice(k, 1); touched = true; }
    }
    if (dupYes.length) continue;
    // "Remove Dr. X …": named saved rows leave the run (only the doctors she named).
    const removals = doctorRemovalClauses(t);
    if (removals.length) {
      for (let k = people.length - 1; k >= 0; k -= 1) {
        if (removedByClauses(people[k].name, removals)) { people.splice(k, 1); touched = true; }
      }
    }
    const npis = [...t.matchAll(/\b(\d{10})\b/g)];
    if (spellFixes.length || removals.length) continue;
    if (!asked && !npis.length && !(i === lastUserAt && numbered)) continue;
    touched = true;
    // 1) NPI next to a name: "use this for Theresa 1306218243".
    for (const n of npis) {
      const before = t.slice(0, n.index).split(/[\s,;]+/).filter(Boolean).reverse();
      const words = [];
      for (const w of before) { if (FIX_STOP_RE.test(w) || /\d/.test(w)) break; words.unshift(w); if (words.length >= 4) break; }
      const who = people.find((p) => words.length && (looseSameDoctor(p.name, words.join(' ')) || plainWords(p.name).includes(plainWords(words[words.length - 1])[0] || '#')));
      if (who) who.npi = n[1];
    }
    // 2) "its Theresa Gloria St. Phillipe APRN, and Hoa Nguyen": each named part replaces the doctor it matches.
    if (asked && !npis.length) {
      for (const raw of t.split(/,|;|\band\b/i)) {
        const part = raw.replace(/^\s*(?:its|it's|it is|is|use|this is|actually|yes[,.]?)\s+/i, '').replace(/[.!]+\s*$/, '').trim();
        if (plainWords(part).length < 2 || /\b(correct|match|right|yes|no)\b/i.test(part) || ADD_DOCTOR_RE.test(part)) continue;
        const who = people.find((p) => !p.npi && looseSameDoctor(p.name, part));
        if (who) who.name = part;
      }
    }
  }
  if (!touched) return null;
  // A corrected spelling can land on a name already saved ("Natalie Regalado" -> "Nathalie Regalado", NPI 1467795633,
  // when both were on the list): one row per doctor — same NPI or same name.
  for (let k = people.length - 1; k > 0; k -= 1) {
    const p = people[k];
    if (people.slice(0, k).some((q) => (p.npi && q.npi === p.npi) || plainWords(q.name).join(' ') === plainWords(p.name).join(' '))) {
      const first = people.slice(0, k).find((q) => (p.npi && q.npi === p.npi) || plainWords(q.name).join(' ') === plainWords(p.name).join(' '));
      if (!first.npi && p.npi) first.npi = p.npi;
      people.splice(k, 1);
    }
  }
  const npis = {};
  for (const p of people) if (p.npi) npis[p.name] = p.npi;
  return { reason: 'doctor corrections (saved workup)', doctors: people.map((p) => p.name), zip: wk.zip || newestZip(msgs.slice(0, lastUserAt + 1)), npis };
}

function lastNameOnly(d) {
  const asked = String((d && d.requestedName) || '')
    .replace(/\b(dr|md|m\.d|do|d\.o|pcp|primary|cardio\w*|neuro\w*|gyn\w*|obgyn|ortho\w*|derm\w*|uro\w*|gastro\w*|onc\w*|endo\w*|rheum\w*|pulm\w*|nephro\w*|podiat\w*|ophth\w*|optom\w*|ent|psych\w*|specialist|doctor)\b\.?/gi, ' ')
    .replace(/[^A-Za-zÀ-ÿ' -]/g, ' ')
    .trim();
  return Boolean(asked) && asked.split(/\s+/).filter(Boolean).length === 1;
}

function personalize(questions, askText) {
  // Use the client names when the ask has "X & Y Lastname"; otherwise "the client".
  const m = String(askText || '').match(/\b([A-Z][a-z]+)\s*(?:&|and|y)\s*([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
  const who = m ? `${m[1]} and ${m[2]}` : 'the client';
  return questions.map((q) => q
    .replace('Does {client} have', m ? `Do ${who} have` : 'Does the client have')
    .replace(/\{client\}/g, who));
}


function shortPlanHeader(p) {
  // No grid tag ("**NEW 2027**", stray "**") in a chat-table header (artifacts/plan-name.js).
  const name = PLAN_NAME.cleanPlanName(p.name || '')
    // Aetna names already carry the ID ("Aetna Medicare Select HMO - H1609-018") — don't print it twice.
    .replace(new RegExp(`\\s*[-–·(]?\\s*${String(p.planId || '').slice(0, 9)}[A-Z]?\\)?\\s*$`, 'i'), '')
    .replace(/Medicare Advantage/gi, 'MA')
    .replace(/\((?:Regional )?(HMO-POS|HMO|PPO)(?: D-SNP)?\)/i, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return !name || name.toUpperCase() === p.planId.toUpperCase() ? p.planId : `${name} · ${p.planId}`;
}

const CELL = { in: '✅ In', inCarrier: '✅ In*', out: '❌ Not in network (not listed)' }; // = comparisonRules NOT_LISTED_CELL

/** Doctors down the side, plans across the top. */
/**
 * Plans the agent named in her latest ask ("Compare Humana Gold Plus H1036-065C,
 * Aetna Medicare Select H1609-018 …"). Named plans are the columns — Max never
 * swaps in its own top 3 when she asked for specific plans.
 */
function plansInLine(line, constraints) {
  const out = [];
  const seen = new Set();
  const re = /(?:^|[,;:.]|\bcompare\b|\band\b|\bvs\.?\b|\bshow(?: me| m)?\b|\badd\b|\binclude\b|\bplus\b)\s*([^,;:.\n]{0,60}?)\s*\(?\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    const id = m[2].toUpperCase();
    const key = id.slice(0, 9);
    if (seen.has(key)) continue;
    if (constraints && [...constraints.skip].some((x) => x.slice(0, 9) === key)) continue;
    // "Current plan H5420-014 terminating" is context, not a column.
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 25);
    // "Show her current plan H1045-001, Aetna …" asks for it as a column (Maura, 2026-10-07 5:20 PM).
    const showsCurrent = /\b(?:show|include|compare|add|keep|with)\b[^.;]{0,20}current plan\s*$/i.test(line.slice(Math.max(0, m.index - 40), m.index + m[0].length - m[2].length).replace(/\(\s*$/, ''));
    if (/terminat|ending/i.test(after) || (/current plan\s*$/i.test(m[1]) && !showsCurrent)) continue;
    seen.add(key);
    const name = String(m[1] || '')
      .replace(/^\s*[-•*]\s+/, '')
      .replace(/^.*\b(compare|vs\.?|and|show(?: me| m)?|add|include|plus|instead of|lets|let's)\s+/i, '')
      .replace(/\*+/g, '').replace(/\b(new 2027|plan|instead)\b/gi, '').replace(/[·•]+\s*$/, '')
      // "lets do \"UHC MedicareMax …" → "UHC MedicareMax …" (Gail, 2026-10-08)
      .replace(/^\s*(?:do|use|run|go with)\s+/i, '').replace(/["\u201C\u201D]+/g, '').replace(/\s+/g, ' ').trim()
      // "check Doctors DrMax-Dade · H4140-022 again" → "Doctors DrMax-Dade" (Victor, 2026-10-08)
      .replace(LEAD_VERB_RE, '').trim();
    out.push({ planId: id, index: m.index, name: name || id });
  }
  // An ID with no separator before it ('…H5420-014"m Doctors DrMax-Dade · H4140-022') was skipped:
  // the text since the previous ID is its name. Same skip / terminating rules (Gail, 2026-10-08).
  for (const m2 of line.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)) {
    const id = m2[1].toUpperCase();
    const key = id.slice(0, 9);
    if (seen.has(key)) continue;
    if (constraints && [...constraints.skip].some((x) => x.slice(0, 9) === key)) continue;
    const after = line.slice(m2.index + m2[0].length, m2.index + m2[0].length + 25);
    const before = line.slice(0, m2.index);
    if (/terminat|ending/i.test(after) || /current plan\s*$/i.test(before)) continue;
    seen.add(key);
    const prev = [...before.matchAll(/\b[HR]\d{4}-\d{3}[A-Z]?\b/gi)].pop();
    const name = before.slice(prev ? prev.index + prev[0].length : 0)
      .replace(/^[\s"\u201C\u201D')\]]*[a-z]?\b\s*/, '') // closing quote + stray letter: '"m '
      .replace(/["\u201C\u201D*]+/g, '').replace(/[·•,]+\s*$/, '').replace(/\s+/g, ' ').trim()
      .replace(LEAD_VERB_RE, '').trim();
    out.push({ planId: id, index: m2.index, name: name || id });
  }
  return out.sort((a, b) => a.index - b.index).map(({ index, ...p }) => ({ ...p, name: typedPlanName(p.name, p.planId) }));
}

// Her request words are never part of a plan's name: "CAN YOU PLEASE RUN THIS SEARCH FOR HUMANA PPO Humana Choice
// H7617-107" was a column headed "THIS SEARCH FOR HUMANA PPO Humana Choice" (Robert and Andrea, 2026-10-19). A grid
// plan whose typed name carries them takes its grid name.
const REQUEST_WORDS_RE = /\b(?:can|could|would|you|please|pls|run|search|this|that|these|for|check|look|find|her|his|their|them|me|us|on|again|too|also|and)\b/i;
function typedPlanName(name, planId) {
  const nm = String(name || '').trim();
  if (!nm || !REQUEST_WORDS_RE.test(nm)) return nm;
  const row = gridRowFor(planId, '');
  if (!row) return nm.replace(/^.*\b(?:for|on)\s+/i, '').trim() || nm;
  return carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim();
}

const LEAD_VERB_RE = /^(?:(?:pls|please|can you|could you|now|also|then)\s+)*(?:re-?check|check|re-?run|run|try|look at|look up|verify|do|use|go with)\s+(?:(?:on|for|the)\s+)?(?:again\s+)?/i;




// Plan IDs as agents paste them from Sunfire: "H5420-1-0" / "H5420-001-0" → "H5420-001" (Tony Cabrera, 2026-10-19:
// "Current plan is UHC MedicareMax … (H5420-1-0)" was not read as her current plan in the chat path).
function normalizeTypedPlanIds(text) {
  return String(text || '').replace(/\b([HR]\d{4})-(\d{1,3})(?:-\d)?(?=[^\dA-Za-z-]|$)/gi, (m, a, b) => `${a.toUpperCase()}-${b.padStart(3, '0')}`);
}

function namedPlansFromAsk(askText0, constraints) {
  const askText = normalizeTypedPlanIds(askText0);
  // comparisonAskText already resolved her plan edit into one set ("Named plan set: …"): that list, in its order, is the
  // set — the same one selectComparison draws. Re-reading her message line by line put the plans she added in front of
  // the current plan on the compare card (Robert and Andrea, 2026-10-19).
  const setLines = [...String(askText || '').matchAll(/^Named plan set: (.+)$/gm)];
  if (setLines.length) {
    const fromLine = setLines[setLines.length - 1][1].replace(/\.$/, '').split(';').map((x) => {
      const m = x.match(/^\s*(.*?)\s*\(([HR]\d{4}-\d{3}[A-Z]?)\)\s*$/i);
      return m ? { planId: m[2].toUpperCase(), name: m[1] || m[2].toUpperCase() } : null;
    }).filter(Boolean)
      .filter((p) => !(constraints && [...constraints.skip].some((x) => x.slice(0, 9) === p.planId.slice(0, 9))));
    if (fromLine.length) return fromLine;
  }
  let current = [];
  // Her current plan (comparisonAskText's "Her current plan:" line): a new set that mentions it keeps it, first.
  const currentIds = [...String((String(askText || '').match(/^Her current plan:\s*([^\n]+)$/m) || ['', ''])[1]).matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
  // The loaded workup's "Current plan:" line: a carrier drop never takes that plan off (loadedWorkup.currentPlanRemovedBy).
  const workupCurrentIds = [...String((String(askText || '').match(/^\s*Current plan(?:\(s\))?:\s*([^\n]+)$/m) || ['', ''])[1]).matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
  const withCurrent = (set, line) => {
    if (!currentIds.length || !LW.lineKeepsCurrentPlan(line)) return set;
    const missing = currentIds.filter((id) => !set.some((p) => p.planId.slice(0, 9) === id.slice(0, 9)));
    const named = (id) => {
      const row = gridRowFor(id, '');
      return { planId: id, name: row ? (carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim()) : id };
    };
    return LW.currentPlanFirst([...missing.map(named), ...set], currentIds);
  };
  let workup = null; // { plans: [], inPlans: bool } while reading the loaded-workup block
  let fromWorkup = false; // the current set is her saved workup's plans (plus plans she added)
  const endWorkup = () => {
    if (workup && workup.plans.length) { current = workup.plans.slice(); fromWorkup = true; }
    workup = null;
  };
  for (const line of joinWrappedQuotes(askText).split('\n')) {
    if (/^\s*LOADED CLIENT WORKUP\b/.test(line)) { workup = { plans: [], inPlans: false }; continue; }
    if (workup) {
      if (WORKUP_LINE_RE.test(line)) { workup.inPlans = /^\s*Plans:\s*$/.test(line); continue; }
      if (/^\s*-\s/.test(line)) {
        if (workup.inPlans) {
          for (const f of plansInLine(line, constraints)) if (!workup.plans.some((p) => p.planId.slice(0, 9) === f.planId.slice(0, 9))) workup.plans.push(f);
        }
        continue;
      }
      endWorkup();
    }
    if (!line.trim()) continue;
    // comparisonAskText's marker of the plans she just added (selectComparison reads it) is not a plan list.
    if (/^(?:Plans she added|Plan names not matched):/.test(line)) continue;
    // Removals first ("remove devoted", "drop H1290-073") — loadedWorkup.js rules: whole words / carrier / ID; a pronoun
    // ("remove it") never removes a plan.
    current = LW.removePlansNamedIn(current, line, [...currentIds, ...workupCurrentIds]);
    // IDs she drops in this line ("Drop MedicareMax H5420-001") never come back as columns.
    const dropped = LW.droppedIdsIn(line);
    // "Show her current plan H1045-001, Aetna H1609-093 and H1036-054C in the table": that list IS the set.
    const showAt = [...line.matchAll(/\b(?:show|compare)\b(?=[^.]*\b[HR]\d{4}-\d{3})/gi)].pop();
    if (showAt) {
      const shown = plansInLine(line.slice(showAt.index), constraints).filter((f) => !dropped.has(f.planId.slice(0, 9)));
      if (shown.length >= 2) {
        current = withCurrent(shown.map((f) => {
          if (f.name.split(/\s+/).length >= 3 && f.name !== f.planId) return f;
          const row = R.gridPlansForCounty('').find((g) => String(g.planId || g.id).toUpperCase().slice(0, 9) === f.planId.slice(0, 9));
          return row ? { ...f, name: carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim() } : f;
        }), line);
        fromWorkup = false;
        continue;
      }
    }
    const found = plansInLine(line, constraints).filter((f) => !dropped.has(f.planId.slice(0, 9)));
    if (!found.length) continue;
    // On a loaded workup, a line that only MENTIONS a plan ("check Glinos on H5420-001") keeps every saved plan and adds
    // what is new; only a clear new set replaces them (Robin Forte, 2026-10-17). Rules: loadedWorkup.planLineVerdict.
    const verdict = LW.planLineVerdict(line, found, { fromWorkup, haveSet: current.length > 0 });
    if (verdict === 'add' || verdict === 'edit') {
      for (const f of found) if (!current.some((p) => p.planId.slice(0, 9) === f.planId.slice(0, 9))) current.push(f);
      continue;
    }
    current = withCurrent(found, line);
    fromWorkup = false;
  }
  if (workup) endWorkup();
  return current;
}

// The carrier's core (flagship, non-SNP) plan: when she compares that carrier it always leads, even if its
// doctors could not be confirmed — a carrier comparison that skips the core plan is not useful (Yahoska 2026-10-07).
// Core = the plans on the THEI grid's HMO tabs ("Dade - HMO", "BWD - HMO"); the first-listed HMO plan of the carrier
// leads (Humana → Gold Plus H1036-054C Dade / H1036-065C Broward). SNP and PPO tabs are not core.
function corePlanIdsFor(carrier, county) {
  const rows = R.gridPlansForCounty(county).filter((g) => String(g.type || '').toUpperCase() === 'HMO' && R.carrierOfPlan(g) === carrier);
  const ids = rows.map((r) => String(r.planId || r.id).toUpperCase().slice(0, 9));
  // Doctors HealthCare: every HMO-tab plan is core (Yahoska 2026-10-07: "both core plans … they're both good") —
  // DrMax-Dade H4140-022 + DrSelect-SFL H4140-023 in Miami-Dade; Broward's grid has DrSelect only.
  if (carrier === 'Doctors HealthCare') return [...new Set(ids)];
  // UHC core: "UHC Preferred" (Yahoska, 2026-10-07) = UHC Preferred MA FL-0002 H1045-005 when the county grid has it.
  if (carrier === 'UnitedHealthcare' && ids.includes('H1045-005')) return ['H1045-005'];
  // CarePlus core (Yahoska 2026-10-07): CareOne Plus H1019-001 + CareAccess H1019-148 "for now" — not all four.
  if (carrier === 'CarePlus') {
    const core = ['H1019-001', 'H1019-148'].filter((id) => ids.includes(id));
    if (core.length) return core;
  }
  return ids.length ? [ids[0]] : [];
}
const isHmoTab = (c) => String((c.grid && c.grid.type) || '').toUpperCase() === 'HMO';

// Carriers whose Florida MA plans all share one provider network.
// Devoted is only a FALLBACK here: each Devoted plan has its own network (FL HMO / FL HMO
// D-SNP / FL HMO C-SNP — services/devotedNetworks.js), and a finished 2027 FHIR check gives
// plan-level In/Out labels that win above (inIds/outIds). The carrier-level rule only
// applies when no plan-level answer exists (e.g. an unmapped year).
// Solis: one HMO network per county directory — a listing covers every Solis plan there.
// Doctors HealthCare: one network for every H4140 plan (Yahoska, 2026-10-07).
// HealthSun: one 2027 directory covers its HMO plans in a county (Yahoska sent the PDF, 2026-10-07).
const SINGLE_NETWORK_CARRIERS = ['Devoted', 'Solis', 'CarePlus', 'Doctors HealthCare', 'HealthSun'];
// A listing is plan-level In, a miss is never Out: CarePlus's PDF says "partial list"; HealthSun's
// has no NPIs, so its match is by name and can miss a real listing.
const PARTIAL_DIRECTORY_CARRIERS = ['CarePlus', 'HealthSun'];
// Plans that share one carrier network, so a directory hit counts as plan-level In.
// Doctors HealthCare: DrMax-Dade (H4140-022) and DrSelect-SFL (H4140-023) share one
// network — confirmed by Yahoska 2026-10-06. 001/012 are the same products' prior IDs.
// Doctors' C-SNP / D-SNP plans are NOT confirmed and stay ✅ In*.
const SHARED_NETWORK_PLANS = {
  'Doctors HealthCare': ['H4140-022', 'H4140-023', 'H4140-001', 'H4140-012'],
};

function carrierHitIsPlanHit(carrier, planId) {
  if (SINGLE_NETWORK_CARRIERS.includes(carrier)) return true;
  const ids = SHARED_NETWORK_PLANS[carrier];
  return Boolean(ids && ids.includes(String(planId || '').toUpperCase().slice(0, 9)));
}

function carrierKey(label) {
  const c = carrierOf(label);
  if (c) return c;
  const t = String(label || '');
  if (/florida blue|bcbs/i.test(t)) return 'Florida Blue';
  if (/healthsun/i.test(t)) return 'HealthSun';
  return '';
}

/** Columns for the named plans: plan-level In/Out when a directory gave one, carrier-level In* otherwise. */
/** A dentist (DDS/DMD, dental taxonomy): Medicare medical networks do not list dentists, so ❌ there is not a medical miss. */
function isDentalProvider(d) {
  if (d && (d.isDentist || (d.dental && d.dental.isDentist))) return true;
  const t = [d && d.doctorName, d && d.requestedName, d && d.taxonomy, d && d.specialty, d && d.taxonomyDescription, ...((d && d.taxonomies) || []).map((x) => (x && (x.desc || x.description)) || x)].filter((x) => typeof x === 'string').join(' ');
  return /\b(?:dds|dmd|dentist\w*|dentisry|dental)\b/i.test(t);
}

function namedPlanColumns(named, matrix, doctors) {
  return named.map((np) => {
    const row = matrix.find((p) => p.planId.slice(0, 9) === np.planId.slice(0, 9));
    // A plan named by ID only ("H1019-006") has no carrier word, and the lookup matrix only knows
    // plans a directory listed by ID — so CarePlus / Doctors carrier hits never reached the cell
    // and every one read "not confirmed" (Victor Rocha, 2026-10-08). The THEI grid knows the carrier.
    const grid = carrierKey(np.name) || (row && row.carrier) ? null : gridRowFor(np.planId, '');
    const carrier = carrierKey(np.name) || (row && row.carrier) || (grid ? R.carrierOfPlan(grid) : '') || '';
    const col = { planId: np.planId, name: row ? row.name : np.name, carrier, type: row ? row.type : planTypeOf(np.name), in: [], inCarrier: [], out: [], unknown: [], notConfirmed: [] };
    for (const d of doctors) {
      const who = shortDoctor(d);
      // A dentist row is drawn from the plan's DENTAL network (gridTable → dentalCell) and never counts toward
      // In / Out / unchecked or the ranking (Gerry Cabrera, 2026-10-19).
      if (isDentalProvider(d)) { (col.dental = col.dental || []).push(who); continue; }
      const inIds = new Set((d.inNetworkPlans || []).map(planIdOf).filter(Boolean).map((x) => x.slice(0, 9)));
      const outIds = new Set((d.outOfNetworkPlans || []).map(planIdOf).filter(Boolean).map((x) => x.slice(0, 9)));
      const key = np.planId.slice(0, 9);
      if (inIds.has(key)) col.in.push(who);
      else if (outIds.has(key)) col.out.push(who);
      else if (carrier && (d.carriersIn || []).some((c) => carrierKey(c) === carrier || c === carrier)) {
        // One network for every plan (Devoted) or for these plans (Doctors DrMax/DrSelect) → a carrier hit is a plan hit.
        (carrierHitIsPlanHit(carrier, np.planId) ? col.in : col.inCarrier).push(who);
      }
      // One-network directory (Devoted; Doctors DrMax/DrSelect) finished and did not list
      // this NPI → Out. A failed or pending check stays ❔ unchecked (never assume Out).
      else if (carrier && carrierHitIsPlanHit(carrier, np.planId) && !PARTIAL_DIRECTORY_CARRIERS.includes(carrier) && directoryFinished(d, carrier)) col.out.push(who);
      // Partial-list directory (CarePlus) answered and did not list this doctor: checked, not confirmed — not unchecked.
      else if (carrier && PARTIAL_DIRECTORY_CARRIERS.includes(carrier) && directoryFinished(d, carrier)) { col.unknown.push(who); col.notConfirmed.push(who); }
      // UHC's directory is plan-level and complete: it finished, listed this doctor on no UHC plan and
      // answered "not listed" for UHC plans → ❌ Not in network (not listed), not "not confirmed".
      else if (carrier === 'UnitedHealthcare' && uhcUnlisted(d)) col.out.push(who);
      else col.unknown.push(who);
    }
    return col;
  });
}

// ─── Doctor/Drug Comparison Table Rules (services/comparisonRules.js) ───────

const R = require('./comparisonRules');
const DENTAL = require('./dentalDirectory');
const GROUPS = require('./medicalGroupRules');
const { restrictionsUnknown } = require('./drugNames');

// Pending-lookup labels that cover each carrier (providerNetwork `pending`).
const PENDING_FOR = {
  UnitedHealthcare: /uhc|united/i,
  Humana: /humana/i,
  Aetna: /aetna/i,
  Simply: /simply/i,
  'Doctors HealthCare': /doctors/i,
  Devoted: /devoted/i,
  'Florida Blue': /blue/i,
  HealthSun: /healthsun/i,
  Wellcare: /sunfire|wellcare/i,
  CarePlus: /careplus/i,
  Solis: /solis/i,
};
// No directory check exists for these. (Solis left 2026-10-06: its 2027 county PDF index is searched by name.)
const NO_LIVE_DIRECTORY = [];

/** Where the Solis cells came from: the 2027 county PDF index, by name (no NPIs in the PDF). */
function solisFlag(docs) {
  const listed = [];
  let unchecked = 0;
  for (const d of docs || []) {
    const net = (d.networks || []).find((x) => /solis/i.test(String(x.carrier)));
    if (net && net.inNetwork && (net.directoryMatches || []).length) {
      const m = net.directoryMatches[0];
      listed.push(`${titleCase(shortDoctor(d))} = ${m.name} (p. ${m.pages.join(', ')})`);
    } else if (!net || net.status !== 'checked') unchecked += 1;
  }
  const checked = (docs || []).length - unchecked;
  const found = listed.length ? ` Listed: ${listed.join('; ')}.` : checked ? ' None of the checked doctors is listed.' : '';
  return `⚠️ Solis: checked by name against the 2027 Solis county provider directory PDF (current as of Oct 1, 2026; the PDF has no NPIs).${found}${unchecked ? ` ${unchecked} not checked (no match run or county not covered) — verify in the Solis PDF.` : ''}`;
}

/** Where the CarePlus cells came from: the 2027 county PDF index (partial list), by name. */
// Carriers with no directory Max can search: tell her exactly where to check by hand.
const MANUAL_CHECK = [
  { re: /wellcare/i, label: 'Wellcare', note: 'no 2027 Wellcare directory is published yet — check wellcare.com/en/fap (pick the 2027 plan year) once it appears' },
  { re: /gold kidney|\bH1526\b/i, label: 'Gold Kidney', note: 'no PDF directory — search providerportal.goldkidney.com, or call Member Services (844) 294-6535 for a printed directory' },
];
function manualCheckNotes(cols) {
  const seen = new Set();
  const out = [];
  for (const c of cols || []) {
    const hay = `${c.carrier || ''} ${c.name || ''} ${c.planId || ''}`;
    for (const m of MANUAL_CHECK) {
      if (!seen.has(m.label) && m.re.test(hay)) { seen.add(m.label); out.push(`${m.label}: ${m.note}`); }
    }
  }
  return out.length ? `⚠️ Check by hand — ${out.join('; ')}.` : '';
}

function careplusFlag(docs) {
  const listed = [];
  let unchecked = 0;
  let missed = 0;
  for (const d of docs || []) {
    const net = (d.networks || []).find((x) => /careplus/i.test(String(x.carrier)));
    if (net && net.inNetwork && (net.directoryMatches || []).length) {
      const m = net.directoryMatches[0];
      listed.push(`${titleCase(shortDoctor(d))} = ${m.name} (p. ${m.pages.join(', ')})`);
    } else if (!net || net.status !== 'checked') unchecked += 1;
    else missed += 1;
  }
  const found = listed.length ? ` Listed: ${listed.join('; ')}.` : '';
  const miss = missed ? ` ${missed} not listed — the CarePlus PDF is a partial list, so that is "not confirmed", not Out; verify at CarePlusHealthPlans.com/FindCare.` : '';
  const unch = unchecked ? ` ${unchecked} not checked (no 2027 CarePlus directory loaded for this county yet).` : '';
  return `⚠️ CarePlus: checked by name against the 2027 CarePlus county provider directory PDF (updated Sep 17, 2026; no NPIs).${found}${miss}${unch}`;
}

/** The carrier's live directory answered for this doctor (not pending, not failed, identity confirmed). */
/** Solis is a local name index: it counts as checked only when the lookup says so. */
function solisChecked(d) {
  return (d.networks || []).some((x) => /solis/i.test(String(x.carrier)) && x.status === 'checked');
}
/** CarePlus is a local name index too (partial list): checked only when a county index answered. */
function careplusChecked(d) {
  return (d.networks || []).some((x) => /careplus/i.test(String(x.carrier)) && x.status === 'checked');
}

/** HealthSun's 2027 directory name index answered for this doctor's county. */
function healthsunChecked(d) {
  return (d.networks || []).some((x) => /healthsun/i.test(String(x.carrier)) && x.directoryStatus === 'checked');
}

/** UHC finished, the doctor is on no UHC plan, and UHC returned plan-level "not listed" answers. */
function uhcUnlisted(d) {
  if (!directoryFinished(d, 'UnitedHealthcare')) return false;
  const uhc = (x) => carrierKey(String(x || '')) === 'UnitedHealthcare';
  if ((d.carriersIn || []).some(uhc) || (d.inNetworkPlans || []).some(uhc)) return false;
  return (d.outOfNetworkPlans || []).some(uhc);
}

function directoryFinished(d, carrier) {
  if (!d || d.identityPending) return false;
  if (carrier === 'Solis' && !solisChecked(d)) return false;
  if (carrier === 'CarePlus' && !careplusChecked(d)) return false;
  if (!carrierCheckRan(d, carrier)) return false;
  if (d.status !== 'done' && d.status !== 'partial') return false;
  // The directory index answered even if the live FHIR call did not.
  if (carrier === 'HealthSun' && healthsunChecked(d)) return true;
  const re = PENDING_FOR[carrier];
  if (!re || NO_LIVE_DIRECTORY.includes(carrier)) return false;
  return ![...(d.pending || []), ...(d.failed || [])].some((p) => re.test(String(p)));
}

// Carriers whose network entry says whether a lookup actually ran (providerNetwork.structuredFor).
const RAN_CHECK_CARRIERS = { Aetna: /aetna/i, Simply: /simply/i, Wellcare: /wellcare/i };
/** Aetna / Simply / Wellcare: true only when this doctor's lookup for that carrier actually ran. */
function carrierCheckRan(d, carrier) {
  const re = RAN_CHECK_CARRIERS[carrier];
  if (!re) return true;
  const net = (d.networks || []).find((x) => re.test(String(x.carrier)));
  return Boolean(net && (net.status === 'checked' || net.status === 'in_network' || net.inNetwork));
}

/** Rule 9: "❔ unchecked" = never checked, "❔ not confirmed" = checked, no result. */
function unknownCell(d, carrier) {
  const status = d && d.status;
  // A match she has not confirmed is never counted In or Out (rule 10).
  if (d && d.identityPending) return R.NOT_CONFIRMED_CELL;
  if (status === 'timeout' || status === 'error') return R.UNCHECKED;
  if (status === 'not_found') return R.NOT_CONFIRMED_CELL;
  if (!carrier || NO_LIVE_DIRECTORY.includes(carrier)) return R.UNCHECKED;
  if (carrier === 'Solis' && !solisChecked(d)) return R.UNCHECKED;
  if (carrier === 'CarePlus' && !careplusChecked(d)) return R.UNCHECKED;
  // No lookup ran for this carrier (skipped, no directory, never started) → unchecked, not "not confirmed".
  if (!carrierCheckRan(d, carrier)) return R.UNCHECKED;
  const re = PENDING_FOR[carrier];
  if (re && [...(d.pending || []), ...(d.failed || [])].some((p) => re.test(String(p)))) return R.UNCHECKED;
  return R.NOT_CONFIRMED_CELL;
}




/**
 * Rule 10: is the NPI match the doctor she asked for?
 * 'last_name' — asked by last name only; 'mismatch' — the matched first name is a
 * different person ("Ian Del Conde" → Cesar A Conde, "Carlos Sosa" → Amanda C Sosa);
 * '' — fine (or nothing was matched).
 */
function identityIssue(d) {
  if (!d || !d.doctorName || !['done', 'partial'].includes(d.status)) return '';
  // Looked up by the NPI saved on her workup / that she confirmed: that IS the confirmed match — never ask again
  // (Gerry Cabrera, 2026-10-19: "Abilio Armando Coello (NPI 1720081037) is correct", then asked again two turns later).
  if (d.requestedNpi && d.npi && String(d.requestedNpi) === String(d.npi)) return '';
  if (lastNameOnly(d)) return 'last_name';
  const asked = plainWords(shortDoctor(d));
  const matched = plainWords(d.doctorName);
  if (asked.length >= 2 && !matched.includes(asked[0])) return 'mismatch';
  // She named a medical practice ("Natalie Regalado - Baptist Medical Group") and the name search found a chiropractor /
  // optometrist / podiatrist / dentist with the same name: not the doctor she means (Jackie Alexander, 2026-10-13).
  const credTail = (String(d.doctorName || '').trim().match(/\b(dc|od|dpm|dds|dmd)\.?$/i) || [])[1];
  const askedRaw = String(d.requestedName || '');
  if (credTail && / [-–—] /.test(askedRaw)
    && /\b(?:medical|hospital|institute|baptist|health|clinic|gastro|cardio\w*|surgeon|surgery|specialist|group|primary)\b/i.test(askedRaw)
    && !/\b(?:dent\w*|dds|dmd|chiro\w*|optom\w*|eye|vision|podiat\w*|ophthal\w*)\b/i.test(askedRaw)) return 'confirm';
  // A full middle word she gave ("Carlos SANTA Cruz") that the match does not carry — not as a
  // word, not as its initial — is a different person (Carlos A Cruz ≠ Carlos Santa-Cruz).
  const orgTest = require('./npiRegistry').looksLikeOrganization;
  const isOrg = d.isOrg || (typeof orgTest === 'function' ? orgTest(shortDoctor(d)) : /\b(associates|group|center|clinic|llc|inc|corp|surgery|medical|health)\b/i.test(shortDoctor(d)));
  if (asked.length >= 3 && !isOrg) {
    const raw = String(d.doctorName || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(ROLE_WORDS_RE, ' ').split(/[^a-z']+/).filter(Boolean);
    const initials = new Set(raw.filter((w) => w.length === 1));
    // "Armand" for "Armando": one letter off is her spelling of the same middle name, not another person.
    const near = (w) => matched.some((m) => m.length >= 4 && (m.startsWith(w) || w.startsWith(m)) && Math.abs(m.length - w.length) <= 1);
    const missing = asked.slice(1, -1).filter((w) => w.length >= 3 && !matched.includes(w) && !initials.has(w[0]) && !near(w));
    if (missing.length) return 'mismatch';
  }
  return '';
}


/** Rule 10: the doctor as matched — full name + specialty/NPI; unconfirmed matches flagged. */
function doctorLabel(d) {
  const asked = titleCase(shortDoctor(d));
  const issue = d && d.identityPending !== undefined ? d.identityPending : identityIssue(d);
  const flag = issue === 'wrong' ? ' ⚠️ wrong doctor — tell me who'
    : issue === 'mismatch' ? ' ⚠️ different name — confirm match' : issue ? ' ⚠️ confirm match' : '';
  const matched = d && d.doctorName && !['not_found', 'timeout', 'error'].includes(d.status) ? cleanName(d.doctorName) : '';
  if (!matched) return `${asked}${lastNameOnly(d) ? ' ⚠️ confirm match' : ''}`;
  const askedWords = plainWords(asked);
  const same = askedWords.length > 0 && askedWords.every((w) => plainWords(matched).includes(w)) && !lastNameOnly(d);
  const name = same ? matched : `${matched} (asked: ${asked})`;
  const spec = d.specialty ? ` · ${titleCase(d.specialty)}` : '';
  const npi = d.npi ? ` · NPI ${d.npi}` : '';
  return `${name}${spec}${npi}${flag}`;
}

function countsOf(p, n) {
  // A dentist is shown but is neither a medical In / Out nor a doctor still to check. Columns built by
  // namedPlanColumns keep dentists out of in/out/unknown (col.dental); `dentalOut` is the older shape.
  const dental = (p.dentalOut || []).length;
  n -= dental;
  const inN = p.in.length;
  const outN = p.out.length - dental;
  const star = (p.inCarrier || []).length;
  const notConfirmed = (p.notConfirmed || []).length;
  // `unchecked` is what the count row prints; `reallyUnchecked` (never looked up) decides if a plan can be ranked.
  return { inN, outN, star, unchecked: n - inN - outN, reallyUnchecked: n - inN - outN - notConfirmed };
}

/** Rule 6: "X in · Y out · Z unchecked" (✅ In* counts as unchecked at plan level). */
function countText(p, n, notConfirmedN = 0) {
  const c = countsOf(p, n);
  // Same words as the cells: a "❔ not confirmed" doctor is counted as not confirmed, never as unchecked.
  const nc = Math.max(0, Math.min(notConfirmedN, c.unchecked));
  const unchecked = c.unchecked - nc;
  const rest = [unchecked || !nc ? `${unchecked} unchecked` : '', nc ? `${nc} not confirmed` : ''].filter(Boolean).join(' · ');
  return `${c.inN} in · ${c.outN} not in network · ${rest}${c.star ? ` (${c.star} ✅ In*)` : ''}`;
}

/** Rule 6 count text, tallied from one column's rendered cells. ✅ In* counts as unchecked at plan level. */
function cellCountText(cells) {
  const inN = cells.filter((c) => c === CELL.in).length;
  const star = cells.filter((c) => c === CELL.inCarrier).length;
  const outN = cells.filter((c) => c === CELL.out).length;
  const nc = cells.filter((c) => c === R.NOT_CONFIRMED_CELL).length;
  const unchecked = cells.length - inN - outN - nc;
  const rest = [unchecked || !nc ? `${unchecked} unchecked` : '', nc ? `${nc} not confirmed` : ''].filter(Boolean).join(' · ');
  return `${inN} in · ${outN} not in network · ${rest}${star ? ` (${star} ✅ In*)` : ''}`;
}

/** A dentist's cell: the plan's dental network (services/dentalDirectory.js), never the medical directory. */
function dentalRowCell(d, p) {
  if (!d || d.identityPending || !['done', 'partial'].includes(d.status)) return unknownCell(d, p.carrier || carrierKey(p.name));
  return DENTAL.dentalCell(d.dental, p.planId, p.carrier || carrierKey(p.name) || '');
}

/** Doctors down the side, plans across the top. */
function gridTable(doctors, plans) {
  if (!plans.length) return '';
  const n = doctors.length;
  const head = `| Doctor | ${plans.map(shortPlanHeader).join(' | ')} |`;
  const sep = `|---|${plans.map(() => '---').join('|')}|`;
  const grid = doctors.map((d) => {
    const who = shortDoctor(d);
    if (isDentalProvider(d)) return plans.map((p) => dentalRowCell(d, p));
    return plans.map((p) => (
      p.in.includes(who) ? CELL.in
        : (p.inCarrier || []).includes(who) ? CELL.inCarrier
          : p.out.includes(who) ? CELL.out
            : unknownCell(d, p.carrier || carrierKey(p.name))
    ));
  });
  const rows = doctors.map((d, i) => `| ${doctorLabel(d)} | ${grid[i].join(' | ')} |`);
  // The count row is tallied from the cells drawn above — never from separate lists, so it always
  // matches what she sees (Maura, 2026-10-07: Aetna grid counts did not match the cells).
  // A dentist row is drawn but left out of the medical tally (Gerry Cabrera, 2026-10-19: Fraga ❌ counted as a miss).
  const medical = doctors.map((d) => !isDentalProvider(d));
  const total = `| **Doctors** | ${plans.map((p, k) => `**${cellCountText(grid.filter((r, i) => medical[i]).map((r) => r[k]))}**`).join(' | ')} |`;
  return [head, sep, ...rows, total].join('\n');
}

function doctorLine(d) {
  const name = shortDoctor(d);
  if (d.status === 'not_found') {
    const sug = (d.suggestions || []).map((x) => `${x.name}${x.specialty ? ` (${x.specialty}${x.city ? `, ${x.city}` : ''})` : ''}`);
    return `- ${name}: NOT CONFIRMED — no exact NPI match${sug.length ? `; closest real providers: ${sug.join('; ')} — ask which one (never ask for an NPI)` : '; no similar name — ask for the spelling or specialty/office (never ask for an NPI)'}`;
  }
  if (d.status === 'timeout' || d.status === 'error') return `- ${name}: NOT CONFIRMED — lookup did not finish`;
  const who = d.doctorName && d.doctorName !== name ? ` (${d.doctorName}${d.npi ? `, NPI ${d.npi}` : ''})` : (d.npi ? ` (NPI ${d.npi})` : '');
  const carriers = (d.carriersIn || []).length ? d.carriersIn.join(', ') : 'no in-network hit in finished checks';
  const pending = (d.pending || []).length ? ` · still pending: ${d.pending.join(', ')}` : '';
  const failedNote = (d.failed || []).length ? ` · check failed (not a miss): ${d.failed.join(', ')}` : '';
  const issue = d.identityPending !== undefined ? d.identityPending : identityIssue(d);
  const flag = issue === 'wrong' ? ' · ⚠️ agent says this is the wrong doctor — results not used; ask who it is'
    : issue === 'mismatch' ? ' · ⚠️ matched a different name — confirm before using these results'
    : issue ? ' · ⚠️ asked by last name only — confirm this is the right doctor' : '';
  return `- ${name}${who}: ${carriers}${pending}${failedNote}${flag}`;
}

function drugNameOf(r) {
  return String((r && (r.drugName || (r.drug && r.drug.name))) || '').trim();
}

function drugRowFor(r, planId) {
  const byId = (r && (r.byPlanId || (r.drug && r.drug.byPlanId))) || {};
  const key = Object.keys(byId).find((k) => k.toUpperCase().slice(0, 9) === String(planId).toUpperCase().slice(0, 9));
  return key ? byId[key] : null;
}

/** Rule 3 (3rd key): sum of exact verified copays; null when any drug is unpriced / unchecked. */
function drugCostFor(planId, drugs) {
  if (!drugs || !drugs.length) return null;
  let total = 0;
  for (const r of drugs) {
    const row = drugRowFor(r, planId);
    if (!row || !row.verified || row.coverage === 'not_covered') return null;
    // Cost differs by strength and none was asked: the lowest-cost covered strength breaks ties
    // (a note says to confirm the dose).
    const usd = Array.isArray(row.strengths) && row.strengths.length > 1
      ? lowestStrengthCost(row.strengths)
      : R.exactDollars(row.costShare);
    if (usd == null) return null;
    total += usd;
  }
  return total;
}

function lowestStrengthCost(strengths) {
  const costs = strengths.filter((v) => v.coverage === 'covered').map((v) => R.exactDollars(v.costShare)).filter((n) => n != null);
  return costs.length ? Math.min(...costs) : null;
}

/** "⚠️ tadalafil cost varies by strength — confirm dose" for every drug split by strength on a table plan. */
function strengthNotes(drugs, planIds) {
  const out = [];
  for (const r of drugs || []) {
    // Only when the tier or cost really differs by strength on a plan shown: every strength T1 $0 is just "T1 $0"
    // (Tony & Gerry Cabrera, 2026-10-19: "Glipizide cost varies by strength" under T1 $0 cells), and never once she
    // confirmed the dose ("Levothyroxine Sodium 0.2 mg").
    if (/\d\s*(?:mg|mcg|%|ml)\b/i.test(String(r.drugName || drugNameOf(r)))) continue;
    const differs = planIds.some((id) => {
      const row = drugRowFor(r, id);
      if (!row || !Array.isArray(row.strengths) || row.strengths.length < 2) return false;
      const covered = row.strengths.filter((v) => v && v.verified && v.coverage === 'covered' && v.tier);
      return new Set(covered.map((v) => `${v.tier}|${v.costShare || row.costShare || ''}`)).size > 1;
    });
    if (!differs) continue;
    const name = (r.nameCorrection && r.nameCorrection.to) || drugNameOf(r);
    out.push(`⚠️ ${name} cost varies by strength — confirm dose`);
  }
  return out;
}

function cmpKnown(a, b) {
  return a == null || b == null ? 0 : a - b;
}

function signatureOf(p) {
  const s = (xs) => [...(xs || [])].sort().join(',');
  return `${p.carrier}|in:${s(p.in)}|out:${s(p.out)}|star:${s(p.inCarrier)}`;
}

function sameNetworkDiff(a, b) {
  const ga = a.grid || {};
  const gb = b.grid || {};
  const parts = [];
  if (ga.premium && gb.premium && ga.premium !== gb.premium) parts.push(`premium ${ga.premium} vs ${gb.premium}`);
  if (ga.moop && gb.moop && ga.moop !== gb.moop) parts.push(`MOOP ${ga.moop} vs ${gb.moop}`);
  if (ga.type && gb.type && ga.type !== gb.type) parts.push(`${ga.type} vs ${gb.type}`);
  return parts.length ? parts.join('; ') : 'same premium, MOOP and plan type on the grid';
}

function gridRowFor(planId, county) {
  const key = String(planId || '').toUpperCase().slice(0, 9);
  const rows = R.gridPlansForCounty(county);
  return rows.find((g) => String(g.planId || g.id || '').toUpperCase().slice(0, 9) === key)
    || R.gridPlansForCounty('').find((g) => String(g.planId || g.id || '').toUpperCase().slice(0, 9) === key)
    || null;
}

// Marketing names she types in a plan ask ("add Humana Choice Giveback", "run DrMax-Dade and Humana Gold Plus too"):
// each grid plan's carrier + name with the sheet's working notes taken out ("COMMISSIONABLE 2027", "**NEW 2027"),
// matched after the ask verb, longest name first. A name two grid plans share is ambiguous: she is asked for the ID.
const PLAN_NAME_ASK_RE = /\b(?:check|re-?check|re-?run|run|search|look\s*(?:up|at)|verify|add|include|plus|show|compare|price|try|see|put)\b([^.;?!\n]*)/gi;
function cleanGridPlanName(g) {
  const pn = String(g.planName || '');
  const full = carrierKey(pn) ? pn : `${g.carrier || ''} ${pn}`;
  return full.replace(/\*+/g, ' ').replace(/\b(?:non[-\s]?)?commissionable\b/gi, ' ').replace(/\b(?:new\s+)?20\d\d\b/gi, ' ').replace(/\bnew\b\s*$/i, ' ')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function planNamesInAsk(text, county) {
  const segs = [...String(text || '').matchAll(PLAN_NAME_ASK_RE)].map((m) => m[1]);
  const out = { ids: [], ambiguous: [] };
  if (!segs.length) return out;
  const byName = new Map();
  for (const g of R.gridPlansForCounty(county || '')) {
    const nm = cleanGridPlanName(g);
    if (nm.split(' ').length < 2) continue;
    const id = String(g.planId || g.id).toUpperCase();
    if (!byName.has(nm)) byName.set(nm, []);
    if (!byName.get(nm).includes(id)) byName.get(nm).push(id);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  for (const seg of segs) {
    let hay = ` ${String(seg).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
    for (const nm of names) {
      if (!hay.includes(` ${nm} `)) continue;
      hay = hay.split(` ${nm} `).join(' | ');
      const ids = byName.get(nm);
      if (ids.length === 1) { if (!out.ids.includes(ids[0])) out.ids.push(ids[0]); } else if (!out.ambiguous.some((a) => a.name === nm)) out.ambiguous.push({ name: nm, ids });
    }
  }
  return out;
}

/** Grid plans she names by marketing name ("UHC MedicareMax FL-0028") in her county — longest name first. */
function gridPlansByName(text, county) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hay = ` ${norm(text)} `;
  const rows = R.gridPlansForCounty(county || '');
  const hits = [];
  for (const g of rows) {
    const name = norm(g.planName);
    const carrier = norm(g.carrier);
    const bare = carrier && name.startsWith(`${carrier} `) ? name.slice(carrier.length + 1) : name;
    // The distinctive part must carry a plan number ("FL-0028", "001") or be 3+ words — never just "Gold Plus".
    if (!/\d/.test(bare) && bare.split(' ').length < 3) continue;
    if (hay.includes(` ${name} `) || hay.includes(` ${bare} `)) hits.push({ id: String(g.planId || g.id).toUpperCase(), len: bare.length });
  }
  hits.sort((a, b) => b.len - a.len);
  return [...new Set(hits.map((h) => h.id))];
}

/** "the client's current plan (H1045-001) and the plan you asked to include (H5420-001)". */
function pinnedWhy(pinnedCols, ask) {
  const cur = ((String(ask || '').match(/^Her current plan:\s*([^\n]+)$/m) || [])[1] || '').toUpperCase();
  const isCur = (c) => cur.includes(c.planId.slice(0, 9)) || !/^Include plans:/m.test(String(ask || ''));
  const a = pinnedCols.filter(isCur).map((c) => c.planId);
  const b = pinnedCols.filter((c) => !isCur(c)).map((c) => c.planId);
  return [a.length ? `the client's current plan (${a.join(', ')})` : '', b.length ? `the plan${b.length > 1 ? 's' : ''} you asked to include (${b.join(', ')})` : ''].filter(Boolean).join(' and ');
}

function bump(map, reason) {
  if (reason) map.set(reason, (map.get(reason) || 0) + 1);
}

/**
 * Doctor/Drug Comparison Table Rules, end to end:
 * eligibility filter → county pool from the THEI grid → doctor results for every
 * eligible plan → rank (in ↓, out ↑, drug cost ↑, premium ↑) → >half unchecked to
 * "Could not verify" → same-network twins out of the top 3 → "Why these plans".
 *
 * opts.named: plan list to use as the columns (compare mode); default = plans
 * named in the ask. opts.drugs: lookup_formulary results already finished.
 */
function selectComparison(doctors, askText, opts = {}) {
  const ask0 = String(askText || '');
  // Rule 10: until she confirms a doctor match, its In/Out results do not count.
  const confirmedMatches = [...ask0.matchAll(/Doctor matches confirmed:\s*([^\n]+)/gi)]
    .flatMap((m) => m[1].split(/[,;]/)).map((x) => x.replace(/\.$/, '').trim()).filter(Boolean);
  const wrongMatches = [...ask0.matchAll(/Doctor matches wrong:\s*([^\n]+)/gi)]
    .flatMap((m) => m[1].split(/[,;]/)).map((x) => x.replace(/\.$/, '').trim()).filter(Boolean);
  const typedNpisText = ask0.split('\n').filter((l) => !/^Doctor NPIs/.test(l)).join('\n');
  const docs = (Array.isArray(doctors) ? doctors : []).map((d) => {
    const who = shortDoctor(d);
    // Her latest word wins: a wrong match is never counted, even if an older reply said yes.
    if (d.doctorName && wrongMatches.some((nm) => sameDoctorName(nm, who))) {
      return { ...d, identityPending: 'wrong', inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] };
    }
    const issue = identityIssue(d);
    // She typed this exact NPI ("use this for Theresa 1306218243"): that is the confirmation. Her cells
    // were hidden as "not confirmed" behind a "different name" flag she had already settled (Paula Harris, 2026-10-13).
    const typedNpi = d.npi && new RegExp(`\\b${String(d.npi).replace(/\D/g, '')}\\b`).test(typedNpisText);
    // "yes Zubair Ansari" / "Zubair Ansari is correct": her own words naming the matched doctor with a yes confirm it,
    // whatever wording Max's question used (Melmoth Alexander, 2026-10-13).
    const matchedWords = plainWords(d.doctorName || '');
    const saidYes = matchedWords.length >= 2 && ask0.split('\n').some((l) => {
      const lw = ` ${plainWords(l).join(' ')} `;
      return /\b(?:yes|yeah|yep|correct|right|confirm(?:ed)?|match|same)\b/i.test(l) && !/\b(?:no|not|wrong)\b/i.test(l)
        && lw.includes(` ${matchedWords[0]} `) && lw.includes(` ${matchedWords[matchedWords.length - 1]} `) && l.length < 120;
    });
    if (!issue || typedNpi || saidYes || confirmedMatches.some((nm) => sameDoctorName(nm, who))) return { ...d, identityPending: '' };
    return { ...d, identityPending: issue, inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] };
  }).map((d) => (d.identityPending ? d : GROUPS.applyGroupRuleToDoctor(d, ask0, (label) => carrierKey(label))));
  // Dentists are drawn in the grid but never counted ("No single plan has all the doctors", ranking, counts).
  const n = docs.filter((d) => !isDentalProvider(d)).length;
  // "Carriers requested: Doctors HealthCare, Solis, Devoted" (comparisonAskText) — newest wins.
  const carrierAsks = [...ask0.matchAll(/Carriers requested:\s*([^\n.]+)/gi)];
  const namedSetLine = (ask0.match(/^Named plan set: (.+)$/m) || [])[1];
  const carriers = carrierAsks.length && !/^Rank all eligible plans\.$/m.test(ask0) && !namedSetLine
    ? carrierAsks[carrierAsks.length - 1][1].split(',').map((c) => c.trim()).filter(Boolean)
    : [];
  const excludedAsks = [...ask0.matchAll(/Carriers excluded:\s*([^\n.]+)/gi)];
  const excludedSet = new Set(excludedAsks.length ? excludedAsks[excludedAsks.length - 1][1].split(',').map((c) => c.trim()).filter(Boolean) : []);
  const wantsOther = /^Wants another carrier\.$/m.test(ask0);
  const rankAll = /^Rank all eligible plans\.$/m.test(ask0);
  const topN = Math.max(1, Math.min(5, Number((ask0.match(/^Top (\d)\.$/m) || [])[1]) || 3));
  const drugs = (opts.drugs || []).filter(Boolean);
  const answered = Boolean(opts.answered);
  const ask = String(askText || '');
  const constraints = askConstraints(ask);
  const elig = R.eligibilityFromAsk(`${ask}\n${opts.eligibilityText || ''}`);
  if (constraints.noMedicaid) { elig.medicaid = 'none'; elig.levels = []; }
  const county = R.countyFromAsk(ask);
  const matrix = coverageMatrix(docs);
  // An excluded carrier ("drop UHC") never takes her current plan off; "remove uhc off the grid" does (Yahoska, 2026-10-17).
  const curAskIds = [...String((ask.match(/^Her current plan:\s*([^\n]+)$/m) || ['', ''])[1]).matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((m) => m[1].toUpperCase());
  const offGridCurrent = LW.currentPlanRemovedBy(ask.replace(/^Her current plan:[^\n]*$/gm, ''), curAskIds, (id) => R.carrierOfPlan(gridRowFor(id, county) || { name: '' }));
  const carrierExcludes = (id) => {
    const key = String(id).toUpperCase().slice(0, 9);
    if (curAskIds.includes(key) && !offGridCurrent.has(key)) return false;
    return excludedSet.size > 0 && excludedSet.has(R.carrierOfPlan(gridRowFor(id, county) || { name: '' }));
  };
  let named = Array.isArray(opts.named) ? opts.named : (carriers.length ? [] : namedPlansFromAsk(ask, constraints));
  if (!Array.isArray(opts.named) && namedSetLine) {
    named = namedSetLine.replace(/\.$/, '').split(';').map((x) => {
      const m = x.match(/^\s*(.*?)\s*\(([HR]\d{4}-\d{3}[A-Z]?)\)\s*$/i);
      return m ? { planId: m[2].toUpperCase(), name: m[1] || m[2].toUpperCase() } : null;
    }).filter(Boolean);
  }
  let pinFromAsk = [];
  if (!Array.isArray(opts.named) && !carriers.length && /Wants alternatives to the named plan\(s\)\./.test(ask) && named.length) {
    pinFromAsk = named.map((p) => p.planId);
    named = [];
  }
  // "Humana won't work, check another plan": the plans she named before are not the columns
  // any more — re-check the county's eligible plans of the other carriers, her current plan first.
  if (!Array.isArray(opts.named) && wantsOther) {
    const current = (ask.match(/^Her current plan:\s*([^\n]+)$/m) || [])[1] || '';
    const ids = pinFromAsk.length ? pinFromAsk : [...current.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
    pinFromAsk = ids.filter((id) => {
      const row = gridRowFor(id, county);
      if (curAskIds.includes(String(id).toUpperCase().slice(0, 9)) && !offGridCurrent.has(String(id).toUpperCase().slice(0, 9))) return true;
      return !excludedSet.has(R.carrierOfPlan(row || { name: (named.find((p) => p.planId.slice(0, 9) === id.slice(0, 9)) || {}).name || '' }));
    });
    named = [];
  }
  // County ranking ask: every eligible plan is ranked; the plans she said to include and her
  // current plan are pinned, then the top N by doctors in → fewest not in network → drug cost → premium.
  if (!Array.isArray(opts.named) && rankAll) {
    const ids = [];
    for (const lineRe of [/^Her current plan:\s*([^\n]+)$/m, /^Include plans:\s*([^\n]+)$/m]) {
      const line = (ask.match(lineRe) || [])[1] || '';
      for (const m of line.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)) if (!ids.includes(m[1].toUpperCase())) ids.push(m[1].toUpperCase());
    }
    pinFromAsk = ids.filter((id) => !carrierExcludes(id));
    named = [];
  }
  // Carrier ask ("show me Doctors HealthCare"): her current plan is still a column.
  if (!Array.isArray(opts.named) && !wantsOther && carriers.length && !pinFromAsk.length) {
    const current = (ask.match(/^Her current plan:\s*([^\n]+)$/m) || [])[1] || '';
    pinFromAsk = [...current.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
  }
  // Her current plan is a column in every table, not only in carrier / rank asks.
  if (!Array.isArray(opts.named) && !wantsOther && !pinFromAsk.length) {
    const current = (ask.match(/^Her current plan:\s*([^\n]+)$/m) || [])[1] || '';
    pinFromAsk = [...current.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
  }
  // A pinned plan she skipped / is terminating / whose carrier she excluded, or "without the current plan"
  // / "not that plan", is never pinned (it would lead the table anyway).
  const dropsCurrent = /\b(?:without|not|exclude|excluding|skip|drop|remove|no)\s+(?:her\s+|the\s+|my\s+|his\s+)?(?:current plan|that plan|this plan)\b/i.test(ask.replace(/^Her current plan:[^\n]*$/gm, ''));
  pinFromAsk = dropsCurrent ? [] : pinFromAsk.filter((id) => {
    const key = String(id).toUpperCase().slice(0, 9);
    if ([...constraints.skip].some((s) => s.slice(0, 9) === key)) return false;
    return !carrierExcludes(id);
  });
  // "only PPOs" with her current plan an HMO (or the other way round): it is left out, said in one line. Same type: it
  // stays first (Yahoska, 2026-10-19: the current HMO led every PPO-only table).
  const typeAskType = ((ask0.match(/^Plan-type ask: (HMO|PPO)s only\.$/m) || [])[1] || '').toLowerCase();
  const typeLeftOut = [];
  if (typeAskType && !Array.isArray(opts.named)) {
    pinFromAsk = pinFromAsk.filter((id) => {
      const row = gridRowFor(id, county);
      const net = R.networkType(row || { name: id });
      if (net === typeAskType || !curAskIds.includes(String(id).toUpperCase().slice(0, 9))) return true;
      const carrier = R.carrierOfPlan(row || { name: id });
      const short = carrier === 'UnitedHealthcare' ? 'UHC' : carrier;
      typeLeftOut.push(`Current plan (${[short, String(id).toUpperCase()].filter(Boolean).join(' ')}, ${net.toUpperCase()}) left out since you asked for ${typeAskType.toUpperCase()}s only.`);
      return false;
    });
  }
  // Looked-up names first ("Atorvastatin Calcium"), then anything listed but not looked up yet.
  const meds = [];
  for (const m of drugs.map(drugNameOf)) {
    const name = String(m || '').trim();
    if (name && !meds.some((x) => R.sameDrug(x, name))) meds.push(name);
  }
  for (const m of [...(opts.meds || []), ...R.medsFromAsk(ask)]) {
    const name = String(m || '').trim();
    // "rasuvostatin" is answered by the rosuvastatin lookup — not another med to check.
    if (name && !meds.some((x) => R.sameDrug(x, name)) && !drugs.some((r) => drugAnswers(r, name))) meds.push(name);
  }
  // Rule 3's drug-cost key only when something was priced: every lookup failing must not rank plans.
  const pricedDrugs = allDrugLookupsFailed(drugs) ? [] : drugs;

  const decorate = (cols) => cols.map((c) => {
    const grid = gridRowFor(c.planId, county);
    const bareId = /^[HR]\d{4}-\d{3}[A-Z]?$/i.test(String(c.name || '').trim());
    const gridName = grid ? String(grid.planName || '') : '';
    const name = grid && bareId && gridName ? (carrierKey(gridName) ? gridName : `${grid.carrier || ''} ${gridName}`.trim()) : c.name;
    const like = grid || { name: c.name };
    return { ...c, name, grid, snp: R.snpKind(like), premium: grid ? R.exactDollars(grid.premium) : null, drugCost: drugCostFor(c.planId, pricedDrugs) };
  });

  const out = {
    named: named.length > 0,
    carriers,
    doctors: docs,
    county,
    eligibility: elig,
    columns: [],
    ranked: [],
    couldNotVerify: [],
    couldNotVerifyCount: 0,
    sameNetwork: [],
    excluded: [],
    poolSize: 0,
    whyLine: '',
    header: '',
    flags: [],
    questions: [],
    meds,
    medsToCheck: { drugs: [], planIds: [] },
  };

  let csnpInPlay = false;
  let snpUnknownKinds = new Set();

  // "compare without the current plan": her plan is not a named column either.
  if (dropsCurrent && !Array.isArray(opts.named)) {
    const cur = new Set([...(((ask.match(/^Her current plan:\s*([^\n]+)$/m) || [])[1] || '').matchAll(/\b([HR]\d{4}-\d{3})/gi))].map((m) => m[1].toUpperCase()));
    named = named.filter((p) => !cur.has(String(p.planId).toUpperCase().slice(0, 9)));
  }
  if (named.length) {
    let cols = decorate(namedPlanColumns(named, matrix, docs));
    // A client grid never carries a pile of plans (5+ are cut to 3; up to 4 she typed herself stay): her CURRENT plan (if she has one) + the 1–2 best others
    // by doctors in network (Jackie Alexander, 2026-10-13: six columns, "no way I can send this to my client").
    // The rest are offered, not shown.
    let trimmed = 0;
    const curText = (ask.match(/^Her current plan:\s*([^\n]+)$/m) || [])[1] || '';
    const curIds = new Set([...curText.matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((m) => m[1].toUpperCase()));
    const isCur = (c) => curIds.has(String(c.planId || '').toUpperCase().slice(0, 9));
    // Her current plan persists across follow-up turns: a later turn whose plan set came from the previous
    // table's other columns still leads with it (Jacqueline Alexander, 2026-10-13: answering the doctor
    // questions dropped H5420-001). Not when she skipped it / it is terminating / its carrier is excluded.
    if (!dropsCurrent) {
      for (const id of curIds) {
        if (cols.some((c) => String(c.planId || '').toUpperCase().slice(0, 9) === id)) continue;
        if ([...constraints.skip].some((x) => x.slice(0, 9) === id)) continue;
        if (carrierExcludes(id) || offGridCurrent.has(id)) continue;
        const row = gridRowFor(id, county);
        const nm = row ? (carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim()) : id;
        cols = [...decorate(namedPlanColumns([{ planId: (curText.match(new RegExp(`${id}[A-Z]?`, 'i')) || [id])[0].toUpperCase(), name: nm || id }], matrix, docs)), ...cols];
      }
    }
    // Plans she just added to the grid ("run this search for H7617-107 and H7617-110") join the plans already on it:
    // nothing is cut to make room for them, and they are never the ones cut (Robert and Andrea, 2026-10-19: the
    // 5-plan set was cut back to 3 and her saved Humana Gold / DrMax columns vanished).
    const addedIds = new Set([...String((ask0.match(/^Plans she added:\s*([^\n]+)$/m) || ['', ''])[1]).matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((m) => m[1].toUpperCase()));
    const isAdded = (c) => addedIds.has(String(c.planId || '').toUpperCase().slice(0, 9));
    const cap = addedIds.size ? 6 : 4;
    if (cols.length > cap) {
      const score = (c) => ((c.in || []).length * 100) - ((c.out || []).length * 10) - ((c.unknown || []).length);
      const current = cols.filter(isCur).slice(0, 1);
      const pinned = [...current, ...cols.filter((c) => isAdded(c) && !current.includes(c))];
      const others = cols.filter((c) => !pinned.includes(c)).sort((a, b) => score(b) - score(a));
      const keep = new Set([...pinned, ...others.slice(0, Math.max(0, (addedIds.size ? cap : 3) - pinned.length))]);
      trimmed = cols.length - keep.size;
      cols = cols.filter((c) => keep.has(c));
    }
    // Her current plan is always the first column, like every other table.
    cols = [...cols.filter(isCur), ...cols.filter((c) => !isCur(c))];
    out.columns = cols;
    out.poolSize = cols.length;
    out.header = '**Doctors × top plans**';
    out.whyLine = trimmed
      ? `Why these plans: her current plan first, then the best ${cols.length - 1} of the other ${trimmed + cols.length - 1} in this case. ${trimmed} more available — say "add another".`
      : `Why these plans: the ${cols.length} plan${cols.length === 1 ? '' : 's'} you named — no plans added or swapped.`;
    // A plan or plan type she named is always a column — eligibility is confirmed at enrollment (one line).
    const snpNamed = [];
    for (const c of cols) {
      const e = R.planEligibility(c.grid || gridRowFor(c.planId, county) || { name: c.name }, elig);
      if (c.snp === 'csnp') csnpInPlay = true;
      if (e.status !== 'eligible') snpNamed.push(c.planId);
    }
    if (snpNamed.length) out.flags.push(`SNP eligibility (${snpNamed.join(', ')}) is confirmed at enrollment.`);
    if (n > 0 && cols.some((c) => c.carrier === 'Solis')) out.flags.push(solisFlag(docs));
    if (n > 0 && cols.some((c) => c.carrier === 'CarePlus')) out.flags.push(careplusFlag(docs));
  } else if (n > 0 || carriers.length) {
    const gridRows = R.gridPlansForCounty(county);
    const pool = gridRows.length
      ? gridRows.map((g) => {
        const planId = String(g.planId || g.id).toUpperCase();
        const row = matrix.find((m) => m.planId.slice(0, 9) === planId.slice(0, 9));
        // Carrier word first so carrierKey() finds it; header prefers the lookup's plan label.
        const gridName = String(g.planName || planId);
        return { planId, name: row ? row.name : (carrierKey(gridName) ? gridName : `${g.carrier || ''} ${gridName}`.trim()), grid: g };
      })
      : matrix.map((m) => ({ planId: m.planId, name: m.name, grid: null }));
    const excluded = new Map();
    const eligible = [];
    const carrierExcluded = new Map(); // carrier → Map(reason → count)
    for (const p of pool) {
      const key = p.planId.slice(0, 9);
      const planCarrier = R.carrierOfPlan(p.grid || { name: p.name });
      // She asked for specific carriers: other carriers are out of scope, not "excluded".
      if (carriers.length && !carriers.includes(planCarrier)) continue;
      // A carrier she ruled out ("Humana won't work") is out of scope too.
      if (excludedSet.has(planCarrier)) continue;
      // "run her drs on the C-SNPs": only C-SNPs are in scope (her other plans stay pinned).
      if (elig.csnpOnly && R.snpKind(p.grid || { name: p.name }) !== 'csnp') continue;
      if ([...constraints.skip].some((id) => id.slice(0, 9) === key)) { bump(excluded, 'plans you skipped / terminating'); continue; }
      const like = p.grid || { name: p.name };
      const net = R.networkType(like);
      if (constraints.onlyPpo && net !== 'ppo') { bump(excluded, 'HMOs — you said PPO only'); continue; }
      if (constraints.onlyHmo && net !== 'hmo') { bump(excluded, 'PPOs — HMO plans only unless you ask for PPO'); continue; }
      const kind = R.snpKind(like);
      if (kind === 'csnp') csnpInPlay = true;
      const e = R.planEligibility(like, elig);
      if (e.status !== 'eligible') {
        if (e.status === 'unknown') snpUnknownKinds.add(kind);
        bump(excluded, e.reason);
        if (carriers.length) {
          if (!carrierExcluded.has(planCarrier)) carrierExcluded.set(planCarrier, new Map());
          bump(carrierExcluded.get(planCarrier), e.reason);
        }
        continue;
      }
      eligible.push(p);
    }
    // Plans a lookup returned that are not on this county's grid are never candidates (rule 2) — say so.
    if (gridRows.length) {
      const poolKeys = new Set(pool.map((p) => p.planId.slice(0, 9)));
      matrix.filter((m) => !poolKeys.has(m.planId.slice(0, 9))).forEach(() => bump(excluded, `plans a lookup returned that are not on the THEI ${county || 'Miami-Dade/Broward'} grid`));
    }
    out.excluded = [...excluded.entries()].map(([reason, count]) => ({ reason, count }));
    out.poolSize = eligible.length;

    const cols = decorate(namedPlanColumns(eligible.map((p) => ({ planId: p.planId, name: p.name })), matrix, docs))
      .map((c) => {
        const k = countsOf(c, n);
        return { ...c, counts: k, verifiable: k.reallyUnchecked * 2 <= n };
      });
    const ranked = cols.filter((c) => c.verifiable).sort((a, b) => (
      b.counts.inN - a.counts.inN
      || a.counts.outN - b.counts.outN
      || cmpKnown(a.drugCost, b.drugCost)
      || cmpKnown(a.premium, b.premium)
      || a.planId.localeCompare(b.planId)
    ));
    out.ranked = ranked;
    const cnv = cols.filter((c) => !c.verifiable);
    out.couldNotVerifyCount = cnv.length;
    out.couldNotVerify = cnv
      .filter((c) => c.counts.inN + c.counts.star > 0)
      .sort((a, b) => (b.counts.inN + b.counts.star) - (a.counts.inN + a.counts.star) || a.planId.localeCompare(b.planId));

    if (carriers.length) {
      // She asked for these carriers: show them — the best eligible plan per carrier
      // (top 3 of one carrier when she named one). Never swapped for other carriers.
      const byCarrier = (c) => cols.filter((x) => R.carrierOfPlan(x.grid || { name: x.name }) === c).sort((a, b) => (
        b.counts.inN - a.counts.inN
        || b.counts.star - a.counts.star
        || a.counts.outN - b.counts.outN
        || cmpKnown(a.drugCost, b.drugCost)
        || cmpKnown(a.premium, b.premium)
        || a.planId.localeCompare(b.planId)
      ));
      const perCarrier = carriers.length === 1 ? 3 : 1;
      for (const c of carriers) {
        // HMO-tab (core) plans first, then the rest; each group keeps the usual ranking.
        let ranked_ = byCarrier(c);
        ranked_ = [...ranked_.filter(isHmoTab), ...ranked_.filter((x) => !isHmoTab(x))];
        const coreIds = corePlanIdsFor(c, county);
        const coreCols = ranked_.filter((x) => coreIds.includes(x.planId.slice(0, 9)));
        if (coreCols.length) {
          ranked_ = [...coreCols, ...ranked_.filter((x) => !coreCols.includes(x))];
          for (const coreCol of [...coreCols].reverse()) {
            if (!coreCol.verifiable) out.flags.unshift(`⚠️ ${shortPlanHeader(coreCol)}: ${c}'s core plan leads, but its doctors could not be confirmed (the directory returned no plan-level result) — check it in the carrier's Find Care / directory.`);
          }
        }
        // Every core plan of the carrier shows (Doctors HealthCare has two in Miami-Dade), then the best others up to the per-carrier count.
        const picks = ranked_.slice(0, Math.max(perCarrier, coreCols.length));
        out.columns.push(...picks);
        if (!picks.length) {
          const why = carrierExcluded.get(c);
          out.flags.push(`⚠️ ${c}: no eligible plan in ${county || 'Miami-Dade/Broward'}${why ? ` — ${[...why.entries()].map(([r, k]) => `${r} (${k})`).join('; ')}` : ' on the THEI grid'}.`);
        }
      }
      out.columns.filter((c) => !c.verifiable).forEach((c) => out.flags.push(`⚠️ ${shortPlanHeader(c)}: over half the doctors unchecked for this plan — shown because you asked for ${R.carrierOfPlan(c.grid || { name: c.name })}; verify in the carrier directory.`));
      if (carriers.includes('Solis')) out.flags.push(solisFlag(docs));
      if (carriers.includes('CarePlus')) out.flags.push(careplusFlag(docs));
      const where = county || 'Miami-Dade + Broward (no ZIP/county given)';
      const excludedText = out.excluded.length ? out.excluded.map((x) => `${x.reason} (${x.count})`).join('; ') : 'none';
      // "top 3 … from 2 eligible" claimed a top 3 that does not exist (Robin Forte, 2026-10-17): say what is there.
      const pool = out.poolSize;
      const picked = perCarrier === 1 ? 'best eligible plan per carrier'
        : pool <= perCarrier ? (pool === 1 ? `the only eligible ${carriers[0]} plan` : `all ${pool} eligible ${carriers[0]} plans`)
          : `top ${perCarrier} eligible ${carriers[0]} plans`;
      const fromPool = perCarrier !== 1 && pool <= perCarrier ? `in ${where}` : `from ${pool} eligible ${carriers.join(' / ')} plan${pool === 1 ? '' : 's'} in ${where}`;
      out.whyLine = `Why these plans: you asked for ${carriers.join(', ')} — ${picked} ${fromPool}. ${R.RANK_ORDER} Excluded: ${excludedText}.`;
      out.header = `**Doctors × ${carriers.join(', ')}**`;
      out.ranked = cols.filter((c) => out.columns.includes(c));
      out.couldNotVerify = [];
      out.couldNotVerifyCount = 0;
    }

    // Compare mode prices meds on a shortlist first; the table only draws from it (rule 8).
    const only = Array.isArray(opts.onlyPlanIds) ? new Set(opts.onlyPlanIds.map((id) => String(id).toUpperCase())) : null;
    // Her client's current plan(s) ("is there something better?"): always the first column(s), then the best of the county.
    const pinIds = [...(Array.isArray(opts.pinPlanIds) ? opts.pinPlanIds : []), ...pinFromAsk].map((id) => String(id).toUpperCase());
    const pinnedCols = [];
    if (pinIds.length) {
      for (const id of pinIds) {
        // Carrier ask + her current plan: the current plan leads, unless that carrier column already shows it.
        if (carriers.length && out.columns.some((c) => c.planId.slice(0, 9) === id.slice(0, 9))) continue;
        const found = cols.find((c) => c.planId.slice(0, 9) === id.slice(0, 9));
        // Name the pinned plan from the grid first: a bare ID has no carrier in it, and a column
        // with no carrier matches no doctor, so every cell came back unchecked (Yahoska, 2026-10-07).
        const pinRow = gridRowFor(id, county);
        const pinName = pinRow
          ? (carrierKey(String(pinRow.planName || '')) ? String(pinRow.planName) : `${pinRow.carrier || ''} ${pinRow.planName || ''}`.trim())
          : id;
        const col = found || decorate(namedPlanColumns([{ planId: id, name: pinName || id }], matrix, docs)).map((c) => {
          const k = countsOf(c, n);
          return { ...c, counts: k, verifiable: k.reallyUnchecked * 2 <= n };
        })[0];
        const e = R.planEligibility(col.grid || { name: col.name }, elig);
        if (e.status !== 'eligible') out.flags.push(`⚠️ ${shortPlanHeader(col)}: ${e.reason} — it is the client's current plan, so it stays; confirm eligibility before enrolling.`);
        if (!col.verifiable) out.flags.push(`⚠️ ${shortPlanHeader(col)}: over half the doctors unchecked — shown because it is the client's current plan; verify in the carrier directory.`);
        pinnedCols.push(col);
        if (carriers.length) out.columns.splice(pinnedCols.length - 1, 0, col); else out.columns.push(col);
      }
    }
    const isPinned = (c) => pinnedCols.some((p) => p.planId === c.planId);
    const maxCols = rankAll ? Math.min(6, pinnedCols.length + topN) : 3;
    // A plan-type ask in a county with 5 or fewer plans of that type (Miami-Dade: 4 regular PPOs): every one of them is
    // a column, ranked first, then the ones a directory could not confirm.
    const allOfType = Boolean(typeAskType) && !carriers.length && cols.filter((c) => !isPinned(c) && (!only || only.has(c.planId))).length <= topN;
    const fill = allOfType ? [...ranked, ...cols.filter((c) => !ranked.includes(c))] : ranked;
    for (const c of (carriers.length ? [] : fill)) {
      if (out.columns.length >= maxCols) break;
      if (isPinned(c)) continue;
      if (only && !only.has(c.planId)) continue;
      // A plan with no doctor In never fills a top-3 slot while another plan has one In.
      if (!allOfType && n > 0 && c.counts.inN + c.counts.star === 0 && ranked.some((r) => r.counts.inN + r.counts.star > 0)) continue;
      // A plan-type ask shows each plan as its own column: the three Humana Choice PPOs share a network, and folding them
      // into one column hid two of the four Dade PPOs she asked to see.
      const twin = c.carrier && !typeAskType ? out.columns.find((t) => signatureOf(t) === signatureOf(c)) : null;
      if (twin) out.sameNetwork.push({ plan: c, twin, diff: sameNetworkDiff(c, twin) });
      else out.columns.push(c);
    }

    // Rule: a comparison always shows at least 2 plans (she can't compare one). A plan set aside as a
    // same-network twin gets its own column when it is needed to reach 2; then any other ranked plan;
    // last, any eligible plan — flagged when its doctors are mostly unchecked.
    if (out.columns.length < 2) {
      const used = new Set(out.columns.map((c) => c.planId));
      const allowed = (c) => !used.has(c.planId) && (!only || only.has(c.planId));
      const take = (c) => { out.columns.push(c); used.add(c.planId); };
      for (const sn of [...out.sameNetwork]) {
        if (out.columns.length >= 2) break;
        if (allowed(sn.plan)) take(sn.plan);
      }
      out.sameNetwork = out.sameNetwork.filter((sn) => !used.has(sn.plan.planId));
      for (const c of ranked) { if (out.columns.length >= 2) break; if (allowed(c)) take(c); }
      const rest = cols.filter(allowed).sort((x, y) => (y.counts.inN + y.counts.star) - (x.counts.inN + x.counts.star) || x.counts.outN - y.counts.outN || x.planId.localeCompare(y.planId));
      for (const c of rest) {
        if (out.columns.length >= 2) break;
        take(c);
        if (!c.verifiable) out.flags.push(`⚠️ ${shortPlanHeader(c)}: over half the doctors unchecked — shown so the comparison has at least 2 plans; verify in the carrier directory.`);
      }
    }

    if (!carriers.length) {
    const where = gridRows.length
      ? (county || 'Miami-Dade + Broward (no ZIP/county given)')
      : `${county || 'the lookup results'} (THEI grid unavailable — only plans a doctor lookup returned)`;
    const excludedText = out.excluded.length ? out.excluded.map((x) => `${x.reason} (${x.count})`).join('; ') : 'none';
    const leftOut = excludedSet.size ? ` Left out: ${[...excludedSet].join(', ')} (you said it won't work).` : '';
    // One short line (Yahoska, 2026-10-13: "this is too long"): who is first, how many were checked,
    // and only the plan TYPES left out — the per-type counts and the ranking recipe are not for the agent's screen.
    const leftTypes = out.excluded.length ? [...new Set(out.excluded.map((x) => String(x.reason).split(/\s+[—-]\s+/)[0].trim()))].join(', ') : '';
    const leftTail = leftTypes ? ` Left out until confirmed: ${leftTypes}.` : '';
    out.whyLine = pinnedCols.length
      ? `Why these plans: ${pinnedWhy(pinnedCols, ask)} first, then the best of ${out.poolSize} checked in ${where}.${leftTail}${leftOut}`
      : `Why these plans: the best of ${out.poolSize} checked in ${where}.${leftTail}${leftOut}`;
    const majority = out.columns.some((c) => c.counts.inN * 2 > n);
    const anyIn = out.columns.some((c) => c.counts.inN + c.counts.star > 0);
    out.header = (n > 0 && !anyIn)
      ? '**Doctors × plans** (none confirmed in network)'
      : majority
      ? '**Doctors × top plans**'
      : '**Doctors × top plans**';
    }
  }

  for (const line of typeLeftOut) out.flags.push(line);
  // C-SNP plans in the table: the condition list is per plan — say so, never assume.
  if (elig.csnp === 'confirmed') {
    // One short line for all of them, in the notes bubble (Gerry Cabrera, 2026-10-19: repeated once per plan).
    const csnpIds = out.columns.filter((c) => c.snp === 'csnp').map((c) => c.planId);
    if (csnpIds.length && !out.flags.some((f) => /confirmed at enrollment/i.test(f))) out.flags.push(`C-SNP eligibility (${csnpIds.join(', ')}) is confirmed at enrollment.`);
  }

  // Rule 11 — meds can suggest a C-SNP condition; never assume it.
  if (csnpInPlay && elig.csnp !== 'confirmed') {
    for (const h of R.csnpHintsFromMeds(meds)) {
      out.flags.push(`⚠️ ${titleCase(h.drug)} (${h.why}) → possible ${h.condition}. ${R.POSSIBLE_CSNP}`);
    }
  }

  // Rule 8 — every listed med on every table plan before anything is asked.
  const tableIds = out.columns.map((c) => c.planId);
  if (tableIds.length && meds.length) {
    const missingDrugs = meds.filter((m) => {
      const r = drugs.find((x) => drugAnswers(x, m));
      return !r || tableIds.some((id) => !drugRowFor(r, id));
    });
    out.medsToCheck = { drugs: missingDrugs, planIds: tableIds };
  }

  // Doctor questions (no match / wrong / confirm) — asked on a named-plan grid too: with plans she named, the server
  // asked nothing and the model wrote "Are Sandman and Taub the providers below?" with no providers under it
  // (Robert and Andrea, 2026-10-19).
  // Doctor questions (no match / wrong / confirm) share ONE numbered slot so eligibility always fits.
  const doctorQs = [];
  const missing = docs.filter((d) => d.status === 'not_found');
  if (missing.length) {
    // Each candidate with what she needs to tell them apart: specialty, city, NPI (Robert and Andrea, 2026-10-19).
    const fmt = (x) => { const bits = [x.specialty, x.city, x.npi ? `NPI ${x.npi}` : ''].filter(Boolean); return `${x.name}${bits.length ? ` (${bits.join(', ')})` : ''}`; };
    // One short bullet per doctor, newest-first reading order kept; the parts the answer parser reads
    // ("No exact match", "\"Name\" — did you mean X (", "closest:") are unchanged.
    const per = missing.map((d) => {
      const sug = (d.suggestions || []).slice(0, 2);
      const asked = `"${titleCase(shortDoctor(d))}"`;
      if (sug[0] && sug[0].spelling) return `${asked} — did you mean ${fmt(sug[0])}? (looks like a spelling difference)`;
      return `${asked}${sug.length ? ` — closest: ${sug.map(fmt).join('; ')}` : ' — not found. Spelling, or specialty / office?'}`;
    });
    const anyTypo = missing.some((d) => d.suggestions && d.suggestions[0] && d.suggestions[0].spelling);
    const example = `${titleCase(shortDoctor(missing[0]))} = Dr. Full Name`;
    doctorQs.push(`No exact match for:\n${per.map((x) => `• ${x}`).join('\n')}\n${anyTypo ? 'Reply "yes" to use the spelling found, or' : 'Reply'} "${example}".`);
  }
  const wrong = docs.filter((d) => d.identityPending === 'wrong');
  if (wrong.length) {
    doctorQs.push(`Which doctor did you mean for ${wrong.map((d) => titleCase(shortDoctor(d))).join(', ')}? The match${wrong.length > 1 ? 'es' : ''} I found ${wrong.length > 1 ? 'were' : 'was'} the wrong person, so ${wrong.length > 1 ? 'they stay' : 'it stays'} ❔ not confirmed — give the full name, specialty or office (no NPI needed).`);
  }
  const toConfirm = docs.filter((d) => d.identityPending && d.identityPending !== 'wrong');
  if (toConfirm.length) {
    doctorQs.push(`Confirm the doctor match (their In/Out stays ❔ not confirmed until you do): ${toConfirm.map((d) => `${titleCase(shortDoctor(d))} → ${cleanName(d.doctorName)}${d.npi ? ` (NPI ${d.npi})` : ''}`).join('; ')}. Right doctor${toConfirm.length > 1 ? 's' : ''}? If not, tell me who (no NPI needed).`);
  }
  // Questions (max 3): eligibility first (rule 1), then identity (rule 10), then the rest.
  // Eligibility and identity are asked even after a reply — while they are open, SNP plans
  // stay out and unconfirmed doctors do not count, so they must never go quiet.
  // Named plans: the server writes this question itself, in the follow-up bubble, candidates and all (renderedAnswer).
  if (out.named && doctorQs.length) {
    out.questions = personalize([doctorQs.join(' Also: ')], ask);
    out.doctorQuestion = out.questions[0];
  }
  // Ranked / type-filtered tables ("top 5 PPOs", "only PPOs", "rank the HMOs"): the same server-written doctor-match
  // question, candidates and all, in the notes bubble — "only PPOs" showed Sandman and Taub as ❔ not confirmed with
  // no suggestions (Robert and Andrea, 2026-10-19). A doctor still unconfirmed counted for no plan: said in one line.
  if (!out.named && doctorQs.length) {
    out.doctorQuestion = personalize([doctorQs.join(' Also: ')], ask)[0];
    const pending = [...missing, ...wrong, ...toConfirm].map((d) => titleCase(shortDoctor(d)));
    if (pending.length && out.columns.length) {
      out.flags.push(`Ranking left out ${pending.join(', ').replace(/, ([^,]+)$/, ' and $1')} (not confirmed yet). Confirm ${pending.length > 1 ? 'them' : 'the doctor'} and I'll re-check every plan in the table and re-rank.`);
    }
  }
  if (!out.named) {
    const qs = [];
    const dualUnknown = snpUnknownKinds.has('dsnp') || snpUnknownKinds.has('qmb');
    if (dualUnknown && elig.medicaid === 'msp' && !elig.levels.length) {
      qs.push('Which MSP level does {client} have — QMB, SLMB, or QI? (D-SNP and QMB-only plans stay out until it is confirmed.)');
    } else if (dualUnknown && elig.medicaid === 'unknown') {
      qs.push('Does {client} have Medicaid or a Medicare Savings Program? — Yes, full Medicaid / Yes, MSP only (QMB, SLMB, QI) / No. (D-SNP and QMB-only plans stay out until confirmed.)');
    }
    if (snpUnknownKinds.has('csnp') && elig.csnp === 'unknown') {
      qs.push('Does {client} have a C-SNP qualifying chronic condition, confirmed by diagnosis? — Yes (which one) / No. (C-SNPs stay out until confirmed.)');
    }
    if (doctorQs.length) qs.push(doctorQs.join(' Also: '));
    const top = out.columns;
    if (!answered && !carriers.length && !ASKED.mustKeep.test(ask) && n > 2 && top.length && !top.some((p) => p.in.length === n)) {
      qs.push('No single plan has all the doctors. Which doctors are must-keep? (e.g. the PCP + cardiologist)');
    }
    if (!answered && !ASKED.network.test(ask) && top.some((p) => R.networkType(p.grid || { name: p.name }) === 'ppo') && top.some((p) => R.networkType(p.grid || { name: p.name }) === 'hmo')) {
      qs.push('HMO OK (referrals, in-network only), or do they need a PPO?');
    }
    if (!answered && !meds.length && !ASKED.rx.test(ask)) {
      qs.push('Any meds to check against the finalists? (names only)');
    }
    out.questions = personalize(qs.slice(0, 3), ask);
  }
  // County guard (Maura, 2026-10-07: Broward-only H1609-018 landed in a Miami-Dade client's grid):
  // a plan not offered in her county per the grid's county column is never added or suggested. A plan
  // she named herself (or her current plan) stays, with a one-line county warning.
  const countyIds = new Set(R.gridPlansForCounty(county).map((g) => String(g.planId || g.id).toUpperCase().slice(0, 9)));
  if (county && countyIds.size && !opts.skipCountyGuard) {
    const allRows = R.gridPlansForCounty('');
    const explicit = new Set([...named.map((p) => p.planId), ...pinFromAsk, ...(Array.isArray(opts.pinPlanIds) ? opts.pinPlanIds : []), ...(Array.isArray(opts.named) ? opts.named.map((p) => p.planId) : [])]
      .map((id) => String(id || '').toUpperCase().slice(0, 9)));
    const away = [];
    const unknown = [];
    const in2026 = (k) => R.gridPlansForCounty('', 2026).some((g) => String(g.planId || g.id).toUpperCase().slice(0, 9) === k);
    out.columns = out.columns.filter((c) => {
      const k = String(c.planId || '').toUpperCase().slice(0, 9);
      if (countyIds.has(k)) return true;
      if (!explicit.has(k)) return false;
      const other = allRows.find((g) => String(g.planId || g.id).toUpperCase().slice(0, 9) === k);
      // A plan ID she typed that is in neither year's plan data (a typo, or a plan the grid doesn't carry): no column of
      // ❔ cells — one plain line saying so (Robert and Andrea, 2026-10-19: a named plan is never silently dropped).
      if (!other && !in2026(k)) { unknown.push(k); return false; }
      away.push(other ? `${k} (${other.county} grid)` : `${k} (not on the 2027 grid)`);
      return true;
    });
    if (out.ranked) out.ranked = out.ranked.filter((c) => out.columns.includes(c) || countyIds.has(String(c.planId || '').toUpperCase().slice(0, 9)));
    if (away.length) out.flags.push(`⚠️ Not offered in ${county}: ${away.join(', ')}.`);
    if (unknown.length) out.flags.push(`⚠️ ${unknown.join(', ')} ${unknown.length > 1 ? "aren't" : "isn't"} in Max's plan data, so ${unknown.length > 1 ? "they're" : "it's"} not on the grid. Check the plan ID.`);
  }
  // Medical-group carrier rules win over a directory In (BHMG primary care — Yahoska, 2026-10-17).
  const cols = [...new Set([...(out.columns || []), ...(out.ranked || [])])];
  for (const line of GROUPS.applyGroupRulesToColumns(cols, docs, shortDoctor)) out.flags.push(line);
  return out;
}

function planLine(p, total) {
  const outs = p.out.length ? ` · Out: ${p.out.join(', ')}` : '';
  const unk = p.unknown.length ? ` · unchecked/not confirmed: ${p.unknown.join(', ')}` : '';
  return `- ${p.name} (${p.planId}) — ${countText(p, total)}${outs}${unk}`;
}

function extrasLines(sel) {
  const lines = [];
  if (sel.couldNotVerifyCount) {
    const names = sel.couldNotVerify.slice(0, 3).map((c) => `${shortPlanHeader(c)} (${countText(c, c.in.length + c.out.length + c.unknown.length + (c.inCarrier || []).length)})`);
    lines.push(`**Could not verify** (${sel.couldNotVerifyCount} eligible plan${sel.couldNotVerifyCount === 1 ? '' : 's'} with over half the doctors unchecked — not ranked)${names.length ? `: ${names.join('; ')}` : ''}`);
    const manual = manualCheckNotes(sel.couldNotVerify);
    if (manual) lines.push(manual);
  }
  return lines;
}

/**
 * Compact text for the model (tool result): carriers per doctor, the rule-built
 * table to copy as-is, and what to do next.
 */
function batchSummaryForModel(doctors, askText, { answered = false, drugs = [] } = {}) {
  const total = doctors.length;
  const sel = selectComparison(doctors, askText, { answered, drugs });
  const lines = [];
  lines.push('DOCTORS → carriers in network (finished checks):');
  sel.doctors.forEach((d) => lines.push(doctorLine(d)));
  lines.push('');
  lines.push('Carrier-only hits (Florida Blue, HealthSun, Devoted FHIR) are directory facts without a plan ID. Cigna/HealthSpring is left out on purpose: it has NO 2027 Medicare Advantage plans (pulled out) — never mention Cigna as a 2027 option.');
  if (sel.columns.length) {
    lines.push('');
    lines.push(sel.named
      ? 'DOCTOR × PLAN TABLE (the plans the agent named — use exactly these columns; copy it as-is):'
      : 'DOCTOR × PLAN TABLE (selected by the Doctor/Drug Comparison Table Rules — copy the header and the table as-is):');
    lines.push(sel.header);
    lines.push('');
    lines.push(gridTable(sel.doctors, sel.columns));
    lines.push(R.LEGEND + (sel.columns.some((p) => (p.inCarrier || []).length) ? ` · ${R.IN_STAR_LEGEND}` : ''));
    lines.push('Top plans by count:');
    sel.columns.forEach((p) => lines.push(planLine(p, total)));
    extrasLines(sel).forEach((l) => lines.push(l));
  } else if (sel.whyLine) {
    lines.push('');
    lines.push(`No eligible plan has a verifiable doctor result yet${sel.couldNotVerifyCount ? ` (${sel.couldNotVerifyCount} could not be verified)` : ''}. Do not invent a top 3.`);
    extrasLines(sel).forEach((l) => lines.push(l));
  }
  sel.flags.forEach((f) => lines.push(f));
  lines.push('');
  lines.push('ANSWER FORMAT (required for multi-doctor asks — Doctor/Drug Comparison Table Rules):');
  lines.push('1) Lead with the header and the DOCTOR × PLAN TABLE above, exactly as given (never write a "Why these plans" line or an Excluded list) (cells ✅ In / ❌ Out / ❔ unchecked / ❔ not confirmed — never a bare ❔; count row "X in · Y out · Z unchecked" — never "X/N"). Doctor names as matched in the table. Then "Could not verify" / ⚠️ flags if present. Never add a "Same network as above" list. Never re-rank or swap plans.');
  if (sel.medsToCheck.drugs.length) {
    lines.push(`2) MEDS ALREADY GIVEN — before answering, call lookup_formulary once per drug (${sel.medsToCheck.drugs.join(', ')}) with planIds [${sel.medsToCheck.planIds.join(', ')}] (every table plan). Then add the meds table (Drug | same plan columns | "T1 $0" cells; ❔ unchecked / ❔ not confirmed for unknowns). Never ask for meds that are already listed.`);
  } else if (sel.meds.length) {
    lines.push('2) Meds are already checked on every table plan — add the meds table (Drug | same plan columns | "T1 $0" cells). Never ask for meds again.');
  }
  if (sel.named && sel.doctorQuestion) {
    lines.push('3) The agent named the plans — compare exactly those. Do not add or swap plans and do not ask narrowing questions. The server already shows the doctor-match question with every candidate (name, specialty, city, NPI) under the table — do not ask about those doctors yourself.');
  } else if (sel.questions.filter((q) => q !== sel.doctorQuestion).length) {
    lines.push('3) Still missing — ask these (numbered, short), then STOP and wait. Do not list more plans and do not add SNP plans until eligibility is confirmed.');
    sel.questions.filter((q) => q !== sel.doctorQuestion).forEach((q, i) => lines.push(`   Q${i + 1}. ${q}`));
    if (sel.doctorQuestion) lines.push('   The server already shows the doctor-match question with every candidate (name, specialty, city, NPI) under the table — do not ask about those doctors yourself.');
  } else if (sel.doctorQuestion) {
    lines.push('3) The server already shows the doctor-match question with every candidate (name, specialty, city, NPI) under the table — do not ask about those doctors yourself.');
  } else if (sel.named) {
    lines.push('3) The agent named the plans — compare exactly those. Do not add or swap plans and do not ask narrowing questions.');
  } else if (answered) {
    lines.push('3) The agent already answered the narrowing questions — present the table above (2–3 plans) with every doctor In / Out / unchecked / not confirmed. No other plans.');
  }
  lines.push('4) No benefits snapshot or Sources line; max 2 notes, 2 questions.');
  return { text: lines.join('\n'), matrix: sel.ranked, questions: sel.questions, selection: sel };
}

// Short form so long (strength-split) cells don't wrap; explained in the legend when used.
const PA_QL_UNKNOWN = 'PA/QL ?';
const PA_QL_LEGEND = 'PA / QL shown only when the carrier source reports one';
// A cell the source gave no PA / ST / QL for carries no marker (Yahoska, 2026-10-13: "if the formulary or
// medicare.gov don't show it, don't add it"); the legend says restrictions appear only when reported.
const quietRestrictionMarks = (table) => String(table || '').replace(new RegExp(` · ${PA_QL_UNKNOWN.replace('?', '\\?')}`, 'g'), '');

/** The meds legend, plus the "PA/QL ?" line only when a cell in this table uses it. */
function medsLegendFor(table) {
  return String(table || '').includes(PA_QL_UNKNOWN) ? `${R.MEDS_LEGEND} · ${PA_QL_LEGEND}` : R.MEDS_LEGEND;
}

/**
 * No strength asked and the plan's strengths differ: every strength, grouped, never one picked.
 * "2.5/5 mg: T4 40% · PA (verify indication) ‖ 10/20 mg: T6 $0 · QL 8/30 · supplemental".
 * "‖" separates groups — a "|" would split the markdown table cell.
 */
function strengthSplitCell(row, result, opts = {}) {
  const ed = Boolean(result && result.edDrug);
  const describe = (v) => {
    if (v.coverage === 'not_covered') return '❌ not covered';
    // Priced but not answered for this plan: shown, so the list never looks complete when it isn't.
    if (!v.verified || !v.coverage) return '❔ not found';
    const cost = v.costShare ? ` ${v.costShare}` : ` · cost n/a${/pdf/i.test(String(v.source || '')) ? ' (PDF)' : ''}`;
    const bits = [`T${v.tier}${cost}`];
    if (v.pa) bits.push(ed && !v.indication ? 'PA (verify indication)' : 'PA');
    if (v.st) bits.push('ST');
    if (v.qlText) bits.push(v.qlText);
    else if (v.ql) bits.push('QL');
    if (v.bdPa) bits.push('B/D PA');
    if (v.hrm) bits.push('HRM (PA 65+)');
    if (v.excludedDrug) bits.push('supplemental');
    // Across strengths, "varies by product" is noise when the covered tier · cost is the same (Gerry Cabrera,
    // 2026-10-19: "0.1/0.175/0.2 mg: T1 $0 · varies by product ‖ 0.3 mg: T1 $0"). ED drugs keep it (PAH vs ED products).
    if (v.mixedProducts && (ed || opts.keepMixed)) bits.push('varies by product');
    // Per strength: the source that answered this strength decides whether PA/QL are known.
    if (restrictionsUnknown(v)) bits.push(PA_QL_UNKNOWN);
    return bits.join(' · ');
  };
  const groups = [];
  const sorted = [...row.strengths].sort((a, b) => parseFloat(a.strength) - parseFloat(b.strength));
  for (const v of sorted) {
    const text = describe(v);
    const key = `${text}|${v.indication || ''}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.strengths.push(v.strength);
    else groups.push({ key, text, indication: v.indication, strengths: [v.strength] });
  }
  const label = (g) => {
    const units = [...new Set(g.strengths.map((s) => s.split(' ')[1]))];
    const nums = g.strengths.map((s) => s.split(' ')[0]).join('/');
    return `${units.length === 1 ? `${nums} ${units[0]}` : g.strengths.join('/')}${g.indication ? ` (${g.indication})` : ''}`;
  };
  // Every strength reads the same: just tier · cost, no "100/300/600/800 mg:" list (Yahoska, 2026-10-17).
  if (groups.length === 1 && !groups[0].indication && !opts.keepLabel) return groups[0].text;
  return groups.map((g) => `${label(g)}: ${g.text}`).join(' ‖ ');
}

// Usual strengths (mg) per drug, for the one line shown when no strength was asked.
const USUAL_STRENGTH_MG = {
  atorvastatin: 40, gabapentin: 300, levothyroxine: 0.05, metoprolol: 50, pantoprazole: 40, telmisartan: 40,
  lisinopril: 10, amlodipine: 5, metformin: 500, losartan: 50, sertraline: 50, omeprazole: 20, simvastatin: 20,
  rosuvastatin: 10, hydrochlorothiazide: 25, carvedilol: 12.5, furosemide: 20, montelukast: 10, escitalopram: 10,
};
const strengthMg = (str) => {
  const m = String(str || '').match(/([\d.]+)\s*(mcg|mg)/i);
  return m ? (/mcg/i.test(m[2]) ? Number(m[1]) / 1000 : Number(m[1])) : NaN;
};

/**
 * No strength asked and the strengths differ: ONE line per drug — the usual strength when it has a verified
 * covered answer, else the verified covered strength most plans' strengths share. "Not covered" / "not found"
 * from a split is never printed as the answer (Jackie Alexander, 2026-10-13: Medicare.gov showed gabapentin
 * 300 mg T2 $0 and levothyroxine 50 mcg T1 $0 where Max printed "not found" / "not covered").
 */
function oneStrengthCell(row, result) {
  const covered = row.strengths.filter((v) => v && v.verified && v.tier && v.coverage !== 'not_covered');
  if (!covered.length) {
    // The plan-level answer says covered but no single strength was confirmed: say the tier, flag the strength
    // (Paula Harris, 2026-10-13: gabapentin printed "check Medicare.gov" where the plan answered T2).
    if (row.verified && row.coverage === 'covered' && row.tier) return `T${row.tier}${row.costShare ? ` ${row.costShare}` : ''} · strength not confirmed — confirm dose`;
    return '❔ check Medicare.gov (strength not confirmed)';
  }
  const name = String(row.drugName || row.name || row.query || '').toLowerCase();
  const key = Object.keys(USUAL_STRENGTH_MG).find((k) => name.includes(k));
  let pick = null;
  if (key) pick = covered.find((v) => Math.abs(strengthMg(v.strength) - USUAL_STRENGTH_MG[key]) < 1e-6) || null;
  if (!pick) pick = covered.slice().sort((a, b) => Math.abs(Math.log((strengthMg(a.strength) || 1) / ((key && USUAL_STRENGTH_MG[key]) || strengthMg(covered[Math.floor(covered.length / 2)].strength) || 1))) - Math.abs(Math.log((strengthMg(b.strength) || 1) / ((key && USUAL_STRENGTH_MG[key]) || strengthMg(covered[Math.floor(covered.length / 2)].strength) || 1))))[0];
  const cell = strengthSplitCell({ strengths: [pick] }, result, { keepLabel: true });
  // Every strength the plan answered sits on the same tier and cost, and none was answered "not covered": that IS the
  // answer, whatever dose she takes (Jacqueline Alexander, 2026-10-17: "idk why gabapentin is such a diff drug for max" —
  // 100/300/600/800 mg all T2 $0 on H5420-001 and T1 $0 on H4140-022/-023 while the row read "check Medicare.gov").
  // Strengths medicare.gov did not answer are not a difference (and never "doesn't exist").
  const noneNotCovered = !row.strengths.some((v) => v && v.verified && v.coverage === 'not_covered');
  const sameAll = covered.length >= 2 && noneNotCovered
    && covered.every((v) => strengthSplitCell({ strengths: [v] }, result, { keepLabel: true }).replace(/^[^:]+:\s*/, '') === cell.replace(/^[^:]+:\s*/, ''));
  // Just tier · cost: no "cost same across strengths" note (Yahoska, 2026-10-17 — replaces the #231 note).
  if (sameAll) return cell.replace(/^[^:]+:\s*/, '');
  // The usual strength was not among the answered ones: the strength shown is a different one — say so
  // (Jackie, 2026-10-13: atorvastatin 80 mg and levothyroxine 0.3 mg read as the answer for her dose).
  const isUsual = key && Math.abs(strengthMg(pick.strength) - USUAL_STRENGTH_MG[key]) < 1e-6;
  if (key && !isUsual) return `${cell} · usual strength not confirmed — check Medicare.gov`;
  const differ = covered.some((v) => `${v.tier}|${v.costShare}` !== `${pick.tier}|${pick.costShare}`);
  return differ ? `${cell} · other strengths differ — confirm dose` : cell;
}

const OTC_SUPPLEMENT_CELL = 'Not on this plan\'s formulary · OTC vitamin — see the plan\'s OTC allowance';

function drugCell(row, unsureNotCovered, result) {
  if (result && result.nameCheck) return '❓ check name';
  if (!row) return R.UNCHECKED;
  if (Array.isArray(row.strengths) && row.strengths.length > 1) {
    // Every strength answered and covered (different cost / QL): the split is real information, keep it.
    // A split with "not found" / "not covered" strengths in it is lookup noise: one usual-strength line instead.
    const allAnswered = row.strengths.every((v) => v && v.verified && v.tier && v.coverage !== 'not_covered');
    return allAnswered || (result && result.edDrug) ? strengthSplitCell(row, result) : oneStrengthCell(row, result);
  }
  // A tier with no cost-share on file says so — a bare "T2" read as $0 (Solis H0982-007, 2026-10-09).
  const cost = row.costShare ? ` ${row.costShare}` : ` · cost n/a${/pdf/i.test(String(row.source || '')) ? ' (PDF)' : ''}`;
  // Every covered cell carries a restriction status from its source: the flags it reported, or
  // "PA/QL ?" when it reports none at all (medicare.gov; a Sunfire / FHIR answer missing the fields).
  const unknown = restrictionsUnknown(row) ? ` · ${PA_QL_UNKNOWN}` : '';
  // Products that match the ask disagree (one covered, one not): say so, never let covered win silently.
  const mixed = row.mixedProducts ? ' · varies by product' : '';
  // The source's own restrictions ("PA · QL 8/30"), the same on ED-label cells as on any other.
  // "B/D PA" (Part B vs D review) and "HRM" (PA required at 65+) are restrictions too (HealthSun book).
  const flagList = [row.pa ? 'PA' : null, row.st ? 'ST' : null, row.qlText || (row.ql ? 'QL' : null),
    row.bdPa ? 'B/D PA' : null, row.hrm ? 'HRM (PA 65+)' : null].filter(Boolean);
  const flags = flagList.length ? ` · ${flagList.join(' · ')}` : '';
  // ED drugs: the per-plan label says what the coverage means (supplemental / BPH-PAH only / …).
  if (result && result.edDrug && row.edLabel) {
    if (!(row.verified && row.tier)) return row.edLabel;
    return `${row.edLabel} · T${row.tier}${cost}${flags}${mixed}${unknown}`;
  }
  if (row.verified && row.coverage === 'not_covered') return unsureNotCovered ? '⚠️ confirm' : '❌ not covered';
  if (row.verified && row.tier) return `T${row.tier}${cost}${flags}${mixed}${unknown}`;
  if (/form_not_found/.test(String(row.reason || ''))) return `${R.NOT_CONFIRMED_CELL} (form not found)`;
  return R.NOT_CONFIRMED_CELL;
}

/**
 * "80 mg: T1 $0" on some rows and "T1 $0" on others looked messy (Jackie Alexander, 2026-10-17): when every cell of a
 * row names the same single strength, the strength moves into the drug column ("Atorvastatin Calcium 80 mg") and the
 * cells read "T# $cost" like every other row. Different strengths per plan, or a split cell, stay as they are.
 */
const STRENGTH_PREFIX_RE = /^(\d[\d.,]*\s*(?:mg|mcg|g|ml|units?|iu)(?:\/[\d.,]*\s*(?:ml|mg|g|hr))?)\s*:\s*(.+)$/i;
function strengthInLabel(label, cells) {
  const parsed = cells.map((c) => String(c).match(STRENGTH_PREFIX_RE));
  const prefixed = parsed.filter(Boolean);
  if (!prefixed.length) return { label, cells };
  const strengths = new Set(prefixed.map((m) => m[1].toLowerCase().replace(/\s+/g, ' ')));
  if (strengths.size !== 1) return { label, cells };
  if (prefixed.some((m) => /\d\s*(?:mg|mcg|ml|g|iu)\s*:/i.test(m[2]))) return { label, cells };
  const out = cells.map((c, i) => (parsed[i] ? parsed[i][2].trim() : c));
  return { label: `${label} ${prefixed[0][1].replace(/\s+/g, ' ')}`, cells: out };
}

/** The drug column: the corrected name shown as a correction, an unclear name as a question. */
function drugLabel(r, name) {
  const nc = r && r.nameCheck;
  if (nc) return nc.suggestion ? `❓ '${nc.input}' — did you mean ${nc.suggestion}?` : `❓ '${nc.input}' — not a drug name RxNorm knows, check spelling`;
  if (r && r.nameCorrection) {
    const rest = name.toLowerCase().startsWith(r.nameCorrection.to.toLowerCase()) ? name.slice(r.nameCorrection.to.length).trim() : '';
    return `${r.nameCorrection.from} → ${r.nameCorrection.to}${rest ? ` ${rest}` : ''} (auto-corrected, verify)`;
  }
  // RxNorm was unreachable: priced as typed, spelling unchecked.
  if (r && r.nameUnverified) return `${titleCase(name)} (name not verified)`;
  return titleCase(name);
}

/** The listed med this lookup answers — by its looked-up name or the name the agent typed. */
function drugAnswers(r, med) {
  return R.sameDrug(drugNameOf(r), med) || Boolean(r && r.inputName && R.sameDrug(r.inputName, med));
}

/** True when meds were looked up and not one plan answered for any of them. */
function allDrugLookupsFailed(drugResults) {
  const list = (drugResults || []).filter(Boolean);
  // Answers live in lookups[] and/or byPlanId (tool-result / export shapes carry only byPlanId).
  const answered = (r) => [...(r.lookups || []), ...Object.values(r.byPlanId || (r.drug && r.drug.byPlanId) || {})].some((l) => l && l.verified);
  return list.length > 0 && !list.some(answered);
}

/** Drug rows under the same plan columns. `drugs` = lookup_formulary outputs; `knownMeds` = listed but not looked up yet. */
function medsTable(drugResults, plans, knownMeds = []) {
  if (!plans.length) return '';
  const rows = [];
  const seen = new Set();
  for (const r of drugResults || []) {
    const name = drugNameOf(r);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    // "rasuvostatin" was looked up as rosuvastatin: the typed name is answered, not an unchecked row.
    if (r.inputName) seen.add(String(r.inputName).toLowerCase());
    // A vitamin / supplement is OFTEN not on a formulary (OTC), but some plans do list it: a covered answer
    // always shows as-is; only a cell with no covered answer says "OTC vitamin" (Paula Harris, 2026-10-13).
    if (R.isOtcSupplement(r.inputName || name)) {
      const covered = (row) => Boolean(row && ((row.verified && row.tier) || (Array.isArray(row.strengths) && row.strengths.some((v) => v && v.verified && v.tier))));
      const cells = plans.map((p) => {
        const row = drugRowFor(r, p.planId);
        return covered(row) ? drugCell(row, Boolean(r.notCoveredNote), r) : OTC_SUPPLEMENT_CELL;
      });
      { const o = strengthInLabel(drugLabel(r, name), cells); rows.push(`| ${o.label} | ${o.cells.join(' | ')} |`); }
      continue;
    }
    const cells = plans.map((p) => drugCell(drugRowFor(r, p.planId), Boolean(r.notCoveredNote), r));
    // She asked for one drug and the lookup answered a combination product ("tramadol" -> "Tramadol-Acetaminophen"):
    // those tiers are not the drug she asked about (Melmoth Alexander, 2026-10-13).
    const lowName = name.toLowerCase();
    const asked = String(r.inputName || '').trim()
      || (knownMeds || []).map((m) => String(m || '').trim()).find((m) => m && !/[-\/+]/.test(m) && lowName.startsWith(m.toLowerCase()) && lowName.length > m.length) || '';
    if (asked && !/[-\/+]/.test(asked) && /^[A-Za-z]{4,}(?:\s+[A-Za-z]+)?\s*[-\/]\s*[A-Za-z]{4,}/.test(name)) {
      rows.push(`| ${titleCase(asked)} ⚠️ | ${plans.map(() => `❔ lookup matched ${name} — check ${titleCase(asked)} alone on Medicare.gov`).join(' | ')} |`);
      continue;
    }
    { const o = strengthInLabel(drugLabel(r, name), cells); rows.push(`| ${o.label} | ${o.cells.join(' | ')} |`); }
  }
  for (const m of knownMeds || []) {
    const name = String(m || '').trim();
    if (!name || [...seen].some((x) => R.sameDrug(x, name))) continue;
    seen.add(name.toLowerCase());
    rows.push(`| ${titleCase(name)} | ${plans.map(() => R.UNCHECKED).join(' | ')} |`);
  }
  if (!rows.length) return '';
  const head = `| Drug | ${plans.map(shortPlanHeader).join(' | ')} |`;
  const sep = `|---|${plans.map(() => '---').join('|')}|`;
  const table = [head, sep, ...rows].join('\n');
  // Every lookup failed: say so above the table — never just a legend under nothing.
  return allDrugLookupsFailed(drugResults) ? `${R.MEDS_FAILED_BANNER}\n\n${table}` : table;
}

/** Plain answer used when the model itself ran out of time. */
/**
 * The ONE fixed layout for every doctor/med network answer (1 plan or many, ranking or single
 * check): header, Doctor × Plan table with the counts row, legend, then the
 * Meds table. Built from tool data only, so the same lookup always renders the same cells — the
 * model never re-lays it out as bullets or flips a cell (Maura Soley, 2026-10-07).
 */
/**
 * "Search all Dade Core plans for Dr X": every regular (non-SNP) plan on the county grid, every carrier. A short list
 * of the plans where the doctor(s) are In, the rest counted by carrier — no grid of 40 columns, no narrowing questions.
 */
function coreAllAnswer(doctors, askText) {
  const county = R.countyFromAsk(askText) || 'Miami-Dade';
  const docs = (doctors || []).filter(Boolean);
  const rows = R.gridPlansForCounty(county).filter((g) => !R.snpKind(g));
  const plans = rows.map((g) => ({ planId: String(g.planId || g.id).toUpperCase().slice(0, 9), name: carrierKey(String(g.planName || '')) ? String(g.planName) : `${g.carrier || ''} ${g.planName || ''}`.trim(), grid: g }));
  const cols = namedPlanColumns(plans, coverageMatrix(docs), docs);
  const who = docs.map((d) => shortDoctor(d));
  const cellOf = (p, d, k) => (p.in.includes(who[k]) ? 'in' : (p.inCarrier || []).includes(who[k]) ? 'in' : p.out.includes(who[k]) ? 'out' : 'unknown');
  const label = (p) => `${String(p.name || '').replace(/\s*\*\*.*$/, '').trim()} · ${p.planId}`;
  const carrierOf = (p) => R.carrierOfPlan(p.grid || { name: p.name }) || carrierKey(p.name) || 'Other';
  const title = docs.length === 1 ? `**${titleCase(who[0])} × ${county} core plans**` : `**Doctors × ${county} core plans**`;
  const lines = [title, `${cols.length} regular plans, all carriers (no C-SNP / D-SNP / QMB).`, ''];
  const inList = [];
  const outBy = new Map();
  const unkBy = new Map();
  for (const p of cols) {
    const cells = docs.map((d, k) => cellOf(p, d, k));
    const nIn = cells.filter((c) => c === 'in').length;
    if (nIn) inList.push({ p, nIn });
    else {
      const bucket = cells.every((c) => c === 'out') ? outBy : unkBy;
      const c = carrierOf(p);
      bucket.set(c, (bucket.get(c) || 0) + 1);
    }
  }
  inList.sort((a, b) => b.nIn - a.nIn || a.p.planId.localeCompare(b.p.planId));
  lines.push(`✅ **In network (${inList.length})**`);
  if (inList.length) for (const { p, nIn } of inList) lines.push(`- ${label(p)}${docs.length > 1 ? ` — ${nIn}/${docs.length} in` : ''}`);
  else lines.push('- none confirmed');
  const sum = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} (${n})`).join(', ');
  const nOut = [...outBy.values()].reduce((a, b) => a + b, 0);
  const nUnk = [...unkBy.values()].reduce((a, b) => a + b, 0);
  if (nOut) lines.push('', `❌ Not listed (${nOut}): ${sum(outBy)}`);
  if (nUnk) lines.push('', `❔ Not confirmed (${nUnk}): ${sum(unkBy)} — never assume not in network`);
  return lines.join('\n');
}

function renderedAnswer(doctors, askText, { answered = false, drugs = [], medsUnreadable = false } = {}) {
  if (String(askText || '').includes(CORE_ALL_LINE)) {
    const list = coreAllAnswer(doctors, askText);
    const dup = duplicateQuestions(doctors);
    return dup.length ? `${list}\n\n${FOLLOW_UP_MARKER}\n${dup.join('\n')}` : list;
  }
  const sel = selectComparison(doctors, askText, { answered, drugs });
  const top = sel.columns;
  if (!top.length) return '';
  // The grid message is the title, the grid, its legend and the meds — nothing else. "Why these plans" (and its
  // Excluded list) is gone; notes, warnings and questions go in a SEPARATE message after the grid (Yahoska,
  // 2026-10-17: "TOO MUCH TEXT … questions underneath the grid, I'm not looking at that … 2 separate messages").
  const lines = [sel.header, '', gridTable(sel.doctors, top), '',
    R.LEGEND + (top.some((p) => (p.inCarrier || []).length) ? ` · ${R.IN_STAR_LEGEND}` : '')];
  const meds = medsTable(drugs, top, sel.meds);
  if (meds) lines.push('', '**Meds**', '', quietRestrictionMarks(meds), '', medsLegendFor(meds), ...strengthNotes(drugs, top.map((p) => p.planId)));
  // She typed drugs but no list could be read: say so, never drop the section silently.
  else if (medsUnreadable) lines.push('', '**Meds**', '', R.MEDS_UNREADABLE);
  const follow = [];
  // A checked plan with the same doctor results as a column (H1045-018 vs H1045-001) is named, not dropped.
  const twins = (sel.sameNetwork || []).slice(0, 4).map((x) => `${x.plan.planId} = same doctor results as ${x.twin.planId}`);
  if (twins.length) follow.push(`Also checked: ${twins.join('; ')}.`);
  for (const f of (sel.flags || []).filter((x) => /confirmed at enrollment|^⚠️ Not offered in |^⚠️ [^:\n]+: no eligible plan|in Max's plan data|left out since you asked for|^Ranking left out /.test(x))) follow.push(f);
  // A carrier name she typed that matches no carrier: said, never dropped silently.
  const notRecognized = ((String(askText || '').match(/^Carriers not recognized:\s*([^\n]+?)\.?$/gm) || []).pop() || '').replace(/^Carriers not recognized:\s*/, '').replace(/\.$/, '');
  for (const name of notRecognized.split(' | ').filter(Boolean)) follow.push(`⚠️ Couldn't match "${name}" to a carrier — not included. Tell me the carrier name and I'll add it.`);
  // A plan name two grid plans share ("Humana Choice Giveback" = H7617-110 and H7617-145): asked, never guessed.
  const unmatched = ((String(askText || '').match(/^Plan names not matched:\s*([^\n]+?)\.?$/gm) || []).pop() || '').replace(/^Plan names not matched:\s*/, '').replace(/\.$/, '');
  for (const x of unmatched.split(' | ').filter(Boolean)) {
    const m = x.match(/^(.*?)\s*\((.+)\)$/);
    follow.push(m ? `⚠️ "${m[1]}" could be ${m[2]}. Which plan ID should I add?` : `⚠️ Couldn't match "${x}" to one plan. Which plan ID should I add?`);
  }
  for (const q of duplicateQuestions(doctors)) follow.push(q);
  // Named plans + a doctor with no exact match: the question and its candidates come from the server, never a
  // model paraphrase ("Are Sandman and Taub the providers below?" with nothing below — Robert and Andrea, 2026-10-19).
  if (sel.doctorQuestion) follow.push(sel.doctorQuestion);
  const grid = lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  return follow.length ? `${grid}\n\n${FOLLOW_UP_MARKER}\n${follow.join('\n')}` : grid;
}

// "Why these plans" lines (and a bare "Excluded: …" line) never go out in a reply, whoever wrote them — the server
// tables dropped them in PR #232 but the model and the compare-job card still printed one (Robin Forte, 2026-10-17).
const WHY_LINE_RE = /^[ \t>*_-]*(?:\*\*)?\s*(?:why these plans|excluded)\s*(?:\*\*)?\s*:.*(?:\r?\n|$)/gim;
// Drug cells are tier · cost only: the "cost same across strengths" note never shows, even copied from an old saved
// result (Yahoska, 2026-10-17).
const SAME_STRENGTH_NOTE_RE = /\s*[·,;-]?\s*\(?cost (?:is )?(?:the )?same across (?:all )?strengths\)?/gi;
function stripStrengthSameNote(text) {
  return String(text || '').replace(SAME_STRENGTH_NOTE_RE, '');
}
function stripWhyThesePlans(text) {
  return stripStrengthSameNote(String(text || '').replace(WHY_LINE_RE, '')).replace(/\n{3,}/g, '\n\n');
}

// Everything after this marker in a reply goes out as its own chat message, after the grid message.
const FOLLOW_UP_MARKER = '<!-- max:follow-up -->';
/** Split a reply into the grid message and the follow-up message (notes / warnings / questions). */
function splitFollowUp(text) {
  const t = String(text || '');
  const at = t.indexOf(FOLLOW_UP_MARKER);
  if (at < 0) return { grid: t, followUp: '' };
  return { grid: t.slice(0, at).replace(/\s+$/, ''), followUp: t.slice(at + FOLLOW_UP_MARKER.length).replace(new RegExp(FOLLOW_UP_MARKER, 'g'), '').trim() };
}

/**
 * The model's notes must say what the grid shows (Gerry Cabrera, 2026-10-19: "checked 4 plans" over a 3-plan grid, a
 * CarePlus note after CarePlus was removed, "meds checked" when the lookup failed, a Devoted "carrier-level only —
 * confirm exact plan with Devoted" warning, one C-SNP line per plan, and Coello asked again after she confirmed him).
 * A note that does not fit the rendered grid is dropped; the server's own follow-up lines are kept as they are.
 */
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
function noteFitsGrid(line, rendered) {
  const t = String(line || '').trim();
  if (!t) return false;
  const { grid, followUp } = splitFollowUp(rendered);
  const gridIds = [...new Set([...grid.matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((m) => m[1].toUpperCase()))];
  // Devoted's directory answers for every Devoted plan: no carrier-level caveat. One server C-SNP line, never the model's.
  if (/carrier[-\s]level|confirm (?:the )?exact plan with/i.test(t)) return false;
  if (/\bc-?snp\b[^.\n]{0,60}\beligib|\beligib[^.\n]{0,60}\bconfirmed at enrollment/i.test(t)) return false;
  // A plan ID that is not a grid column.
  const ids = [...t.matchAll(/\b([HR]\d{4}-\d{3})/gi)].map((m) => m[1].toUpperCase());
  if (gridIds.length && ids.some((id) => !gridIds.includes(id))) return false;
  // "Checked 4 plans" over a grid of 3.
  const n = t.match(/\b(\d+|one|two|three|four|five|six|seven|eight)\s+(?:\w+\s+)?plans?\b/i);
  if (n && gridIds.length) { const k = /^\d+$/.test(n[1]) ? Number(n[1]) : NUM_WORDS[n[1].toLowerCase()]; if (k && k !== gridIds.length) return false; }
  // A carrier with no column (unless the note says it was taken out).
  // (A lookup that did not finish / a retry offer is about the check, not a column: kept.)
  if (gridIds.length && !/\b(?:remov|drop|took|taken|exclud|without|no longer|not included|retry|re-?try|didn'?t finish|did not finish|timed? out|still checking)/i.test(t)) {
    const gridCarriers = new Set(gridIds.map((id) => { const g = gridRowFor(id, ''); return g ? R.carrierOfPlan(g) : ''; }).filter(Boolean));
    const named = R.CARRIER_WORDS.filter(([, re]) => re.test(t)).map(([c]) => c);
    if (gridCarriers.size && named.some((c) => !gridCarriers.has(c))) return false;
  }
  // Meds claims when there is no meds table (or the lookup failed).
  const medsOk = /^\*\*Meds\*\*$/m.test(grid) && !grid.includes(R.MEDS_UNREADABLE) && /\|\s*T\d|\bTier\b|\$\d/.test(grid.slice(grid.indexOf('**Meds**')));
  if (!medsOk && /\b(?:meds?|medications?|drugs?|prescriptions?|formulary|tiers?|copays?)\b/i.test(t) && !/\?\s*$/.test(t)) return false;
  // Re-asking her to confirm a doctor the server did not flag.
  if (/\b(?:confirm|is (?:this|that) (?:the )?(?:right|correct)|correct (?:match|doctor|provider|npi)|right (?:doctor|provider|match))\b/i.test(t)
      && /\b(?:doctor|dr\.?|provider|npi|match|he|she)\b/i.test(t)) {
    const flagged = followUp.split('\n').filter((l) => /\?\s*$/.test(l)).join(' ').toLowerCase();
    const words = (t.match(/\b[A-Z][a-z]{3,}\b/g) || []).map((w) => w.toLowerCase()).filter((w) => !/^(?:confirm|please|does|this|that|correct|right|match|doctor|provider|should|want|would|could|also|same)$/.test(w));
    if (!words.some((w) => flagged.includes(w))) return false;
  }
  return true;
}

// "Question: Are Sandman and Taub the providers below?" with nothing below it (Robert and Andrea, 2026-10-19): a line that
// points at a list ("below", "the following", "listed here") is dropped unless list items follow it.
const POINTS_AT_LIST_RE = /\b(?:below|the following|listed (?:here|under)|these (?:providers|doctors|candidates|options)(?: here)?:)/i;
const LIST_ITEM_RE = /^\s*(?:[-•*]\s+|\d+[.)]\s+|\|)|\bNPI\s*\d{10}\b/;
function dropDanglingListLines(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (POINTS_AT_LIST_RE.test(l) && !LIST_ITEM_RE.test(l) && /\?|:\s*$|^\s*\**question/i.test(l)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j >= lines.length || !LIST_ITEM_RE.test(lines[j])) continue;
    }
    out.push(l);
  }
  return out.join('\n');
}
// The model's own doctor-match lines when the server already asks it (with the candidates).
const MODEL_DOCTOR_MATCH_RE = /no exact match|did you mean|closest(?: real)? (?:match|providers?)?:?|providers? below|(?:is|are) .{0,40}\bthe (?:right |same )?(?:providers?|doctors?)\b/i;

/**
 * Server-rendered table first, then at most a few short lines of the model's own notes. Any
 * table, legend or per-doctor bullet the model wrote is dropped — the rendered table is the answer.
 */
function enforceRenderedTable(replyText, rendered) {
  if (!rendered) return dropDanglingListLines(replyText);
  const serverAsksDoctors = /No exact match for:/.test(splitFollowUp(rendered).followUp || '');
  const reply = dropDanglingListLines(String(replyText || '').split('\n')
    .filter((l) => !(serverAsksDoctors && !rendered.includes(l.trim()) && (MODEL_DOCTOR_MATCH_RE.test(l) || /^\s*[•]/.test(l))))
    .join('\n'));
  if (reply.includes(rendered)) {
    // The model copied the table and wrote its notes under it: those notes are the follow-up message.
    const fit = (x) => x.split('\n').filter((l) => !l.trim() || noteFitsGrid(l, rendered)).join('\n').trim();
    const rest = fit(reply.slice(reply.indexOf(rendered) + rendered.length).trim());
    const before = fit(reply.slice(0, reply.indexOf(rendered)).trim());
    if (rendered.includes(FOLLOW_UP_MARKER)) return [before, rendered, rest].filter(Boolean).join('\n');
    return rest || before ? `${rendered}\n\n${FOLLOW_UP_MARKER}\n${[before, rest].filter(Boolean).join('\n')}` : rendered;
  }
  const rowNames = [...rendered.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1].trim())
    .filter((n) => !/^(Doctor|Drug|Med|\*\*Doctors\*\*|---)/i.test(n))
    .map((n) => n.replace(/\s*·\s*NPI\b.*$/i, '').replace(/\*|\(.*$/g, '').trim().split(/\s+/).pop().toLowerCase()).filter((w) => w.length >= 3);
  const statusWord = /\b(in[-\s]?network|not in network|out(?:\s+of\s+network)?|not confirmed|unchecked|not listed|in\*?|tier|covered)\b|✅|❌|❔/i;
  const serverMeds = /^\*\*Meds\*\*$/m.test(rendered);
  const notes = reply.split('\n').filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (/^\|/.test(t)) return false;
    if (/^(\*\*)?(Doctors ×|Doctors x|Why these plans|Meds\b|Doctor network|DOCTOR × PLAN)/i.test(t)) return false;
    if (/^(✅ In|T = tier)/.test(t)) return false;
    // The model's own meds heading ("**Medications (2027)**", "### Meds", "Medicamentos:") never rides
    // under the server table: its rows were dropped above, so it would stand alone over nothing
    // (Martin Wiesenthal, 2026-10-09).
    if (/^(?:#+\s*)?\**\s*(?:medications?|meds|medicamentos?|medicinas?)\b[^|?]{0,50}$/i.test(t)) return false;
    // Same for its legend lines when the server built no meds table to explain.
    if (!serverMeds && /^[❔✅❌]/u.test(t)) return false;
    if (/\?\s*$/.test(t)) return true;
    // The model's own per-doctor / per-plan restatement (bullets, "**Plan (ID):** …" lines, plan
    // headers) and any "fell back to saved results" story never ride under the server table.
    if (/saved (?:in\/out )?results|fell back|re-?ran (?:a|the) comparison|server (?:re-?ran|comparison)/i.test(t)) return false;
    const mentionsRow = rowNames.some((w) => t.toLowerCase().includes(w)) || /\b[HR]\d{4}-\d{3}/i.test(t);
    if (/^[-•*]|^\d+[.)]\s/.test(t) && (mentionsRow || statusWord.test(t))) return false;
    if (mentionsRow && (statusWord.test(t) || /^\**[^a-z]*\b[HR]\d{4}-\d{3}[^|]{0,60}:?\**:?$/i.test(t) || t.length <= 90)) return false;
    return true;
    // "Why these plans" / excluded lists are not repeated by the model either.
  }).filter((l) => !/^\**\s*(?:why these plans|excluded:)/i.test(l.trim())).filter((l) => noteFitsGrid(l, rendered)).slice(0, 4);
  if (!notes.length) return rendered;
  return rendered.includes(FOLLOW_UP_MARKER) ? `${rendered}\n${notes.join('\n')}` : `${rendered}\n\n${FOLLOW_UP_MARKER}\n${notes.join('\n')}`;
}

function fallbackAnswer(doctors, askText, { answered = false, drugs = [] } = {}) {
  const sel = selectComparison(doctors, askText, { answered, drugs });
  const top = sel.columns;
  const lines = [];
  if (top.length) {
    lines.push(sel.header);
    lines.push('');
    lines.push(gridTable(sel.doctors, top));
    lines.push('');
    const anyCarrier = top.some((p) => (p.inCarrier || []).length);
    lines.push(R.LEGEND + (anyCarrier ? ` · ${R.IN_STAR_LEGEND}` : ''));
    const extras = extrasLines(sel);
    if (extras.length) { lines.push(''); extras.forEach((l) => lines.push(l)); }
    const meds = medsTable(drugs, top, sel.meds);
    if (meds) {
      lines.push('');
      lines.push('**Meds**');
      lines.push('');
      lines.push(quietRestrictionMarks(meds));
      lines.push('');
      lines.push(medsLegendFor(meds));
      strengthNotes(drugs, top.map((p) => p.planId)).forEach((l) => lines.push(l));
      if (sel.medsToCheck.drugs.length) {
        lines.push(`Not checked yet on every plan: ${sel.medsToCheck.drugs.map(titleCase).join(', ')} — send the same ask again to finish the lookup.`);
      }
    }
  } else {
    lines.push('**Doctors — carriers in network**');
    doctors.forEach((d) => lines.push(doctorLine(d)));
    const extras = extrasLines(sel);
    if (extras.length) { lines.push(''); extras.forEach((l) => lines.push(l)); }
  }
  if (sel.flags.length) {
    lines.push('');
    sel.flags.forEach((f) => lines.push(f));
  }
  if (sel.questions.length) {
    lines.push('');
    lines.push('**To narrow to 2–3 plans:**');
    sel.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  }
  return lines.join('\n');
}

module.exports = {
  carrierOf,
  carrierKey,
  gridRowFor,
  currentPlanOf,
  workupFacts,
  strengthInLabel,
  sameDoctorName,
  looseSameDoctor,
  doctorRemovalClauses,
  removedByClauses,
  renderedAnswer,
  enforceRenderedTable,
  planNamesInAsk,
  dropDanglingListLines,
  noteFitsGrid,
  splitFollowUp,
  stripWhyThesePlans,
  stripStrengthSameNote,
  coreAllAnswer,
  CORE_ALL_RE,
  FOLLOW_UP_MARKER,
  corePlanIdsFor,
  manualCheckNotes,
  planIdOf,
  planTypeOf,
  coverageMatrix,
  askConstraints,
  planTypeIn,
  planTypeAsk,
  planTypeLine,
  planTypeLineFor,
  planTypeAskLines,
  textPlanTypeAsk,
  doctorMatchCandidates,
  candidatePicks,
  rankAskAt,
  narrowingAnswered,
  comparisonAskText,
  comparisonFollowUp,
  currentPlanIdsIn,
  excludedCarriers,
  substitutionsIn,
  numberedAnswers,
  selectComparison,
  batchSummaryForModel,
  gridTable,
  identityIssue,
  isDentalProvider,
  countsOf,
  medsTable,
  dedupeDoctorRows,
  duplicateQuestions,
  confirmedDuplicateRemovals,
  doctorCoreWords,
  strengthNotes,
  medsLegendFor,
  quietRestrictionMarks,
  namedPlansFromAsk,
  namedPlanColumns,
  fallbackAnswer,
  doctorLabel,
  countText,
};
