// services/doctorPlanNarrow.js — turn a multi-doctor network check into a short
// answer: one line per doctor, a doctor × plan coverage count, and the 2–3
// narrowing questions Max still needs before naming 2–3 plans.
//
// Counts are objective ("6 of 8 doctors in network"), not a ranking (TPMO).
// A plan only counts as Out for a doctor when that carrier's guest directory
// (UHC / Humana) finished and listed the plan as out-of-network. Everything
// else that is not In is "not confirmed".

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
function askConstraints(askText) {
  const t = String(askText || '');
  const noMedicaid = /\b(no|not on|without|sin|doesn'?t have|don'?t have)\s+(medicaid|msp|dual|qmb|slmb)\b|\bnot dual\b|\bmedicaid:?\s*no\b/i.test(t);
  const hasMedicaid = !noMedicaid && /\b(full medicaid|has medicaid|have medicaid|dual eligible|full dual|qmb|slmb|\bmsp only)\b/i.test(t);
  const skip = new Set();
  for (const m of t.matchAll(/\b(?:skip|exclude|not|no|drop|remove|without)\s+([HR]\d{4}-\d{3}[A-Z]?)/gi)) skip.add(m[1].toUpperCase());
  for (const m of t.matchAll(/([HR]\d{4}-\d{3}[A-Z]?)[^.\n]{0,40}?\b(terminating|ending|going away|non-?commissionable)/gi)) skip.add(m[1].toUpperCase());
  const onlyPpo = /\b(need|needs|must be|only)\s+(a\s+)?ppo\b/i.test(t);
  const onlyHmo = /\b(only|must be)\s+(an\s+)?hmo\b/i.test(t);
  return { noMedicaid, hasMedicaid, skip, onlyPpo, onlyHmo };
}

/** Plan rows: who is In / Out / not confirmed, sorted by In count. */
function coverageMatrix(doctors) {
  const ok = (doctors || []).filter((d) => d && (d.status === 'done' || d.status === 'partial'));
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
  for (const m of t.matchAll(/(?:^|\n|\s)(?:Q)?([1-9])[.)]\s+([^\n]*?)(?=(?:\s(?:Q)?[1-9][.)]\s)|\n|$)/g)) qs[Number(m[1])] = m[2];
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
  for (const part of String(text || '').split(/[;\n]|,(?=\s*[A-Za-z][^,]*?(?:=|→|->|\bis\b))/)) {
    const m = part.match(/^\s*(?:\d+[.)]\s*)?(?:dr\.?\s*)?([A-Za-z][A-Za-z .'-]{1,40}?)\s*(?:=|→|->|\bis actually\b|\bis really\b|\bshould be\b|\bmeans\b|\bis\b)\s*(?:dr\.?\s*)?([A-Za-z][A-Za-z .'-]{2,60}?)\s*[.!]?\s*$/i);
    if (!m) continue;
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
      subs.push([asked[0], a.replace(/^\s*(?:it'?s|its|is|=)\s*/i, '').replace(/^dr\.?\s*/i, '').replace(/[.]+$/, '').trim()]);
    }
    return subs.map(([from, to]) => `Doctor substitution: ${from} => ${to}.`);
  }
  if (/must-keep/i.test(q)) return [`Must-keep doctors: ${a}.`];
  if (/HMO OK|PPO/i.test(q)) return [/ppo/i.test(a) && !/hmo ok|either/i.test(a) ? 'Needs a PPO.' : `Network: ${a} (HMO ok).`];
  if (/meds/i.test(q)) return NO_RE.test(a) ? ['No meds.'] : [`Meds: ${a}`];
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
  // Newest user message that asks for carriers or names plan IDs decides the columns.
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const t = messageText(m);
    const carriers = R.carriersRequested(t);
    if (carriers.length) { lines.push(`Carriers requested: ${carriers.join(', ')}.`); break; }
    if (/\b[HR]\d{4}-\d{3}[A-Z]?\b/i.test(t) && /\b(compare|show|add|instead|vs)\b/i.test(t)) break;
  }
  return lines.join('\n');
}

/**
 * Is the newest agent message a comparison follow-up the server must re-run?
 * Yes when it asks for carriers by name or answers Max's numbered narrowing
 * questions, and an earlier message listed 2+ doctors. Returns
 * { reason, doctors, zip } or null.
 */
function comparisonFollowUp(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const lastUserAt = msgs.map((m) => m && m.role).lastIndexOf('user');
  if (lastUserAt < 0) return null;
  const latest = messageText(msgs[lastUserAt]);
  const reasons = [];
  const carriers = R.carriersRequested(latest);
  if (carriers.length) reasons.push(`carriers asked: ${carriers.join(', ')}`);
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
    if (!/\b(?:doctors?|drs?|providers?)\s*:/i.test(t)) continue;
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
    if (!reasons.length) return null;
    for (const [from, to] of subs) names = names.map((nm) => (sameDoctorName(nm, from) ? to : nm));
    const zip = f.zip || (msgs.slice(0, lastUserAt + 1).map(messageText).join(' ').match(/\b(3\d{4})\b/) || [])[1] || '';
    return { reason: reasons.join(' + '), doctors: [...new Set(names)], zip };
  }
  return null;
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

function titleCase(t) {
  const s = String(t || '').trim();
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : s;
}

function shortPlanHeader(p) {
  const name = String(p.name || '')
    // Aetna names already carry the ID ("Aetna Medicare Select HMO - H1609-018") — don't print it twice.
    .replace(new RegExp(`\\s*[-–·(]?\\s*${String(p.planId || '').slice(0, 9)}[A-Z]?\\)?\\s*$`, 'i'), '')
    .replace(/Medicare Advantage/gi, 'MA')
    .replace(/\((?:Regional )?(HMO-POS|HMO|PPO)(?: D-SNP)?\)/i, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return !name || name.toUpperCase() === p.planId.toUpperCase() ? p.planId : `${name} · ${p.planId}`;
}

const CELL = { in: '✅ In', inCarrier: '✅ In*', out: '❌ Out' };

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
    if (/terminat|ending/i.test(after) || /current plan\s*$/i.test(m[1])) continue;
    seen.add(key);
    const name = String(m[1] || '')
      .replace(/^.*\b(compare|vs\.?|and|show(?: me| m)?|add|include|plus|instead of|lets|let's)\s+/i, '')
      .replace(/\*+/g, '').replace(/\b(new 2027|plan|instead)\b/gi, '').replace(/[·•]+\s*$/, '').trim();
    out.push({ planId: id, name: name || id });
  }
  return out;
}

const REMOVE_RE = /\b(?:remove|drop|take out|delete|no more|get rid of|without)\s+(?:the\s+)?([^,.;\n]+?)(?=\s+(?:from|and|,)|[,.;\n]|$)/gi;

/**
 * Plans the agent asked to compare, following her edits across the thread:
 * "Compare Humana H1036-065C, Aetna H1609-018, Devoted H1290-073" then
 * "remove devoted, add UHC H1045-005 instead" → Humana, Aetna, UHC.
 * Named plans are the columns — Max never swaps in its own top 3.
 */
function namedPlansFromAsk(askText, constraints) {
  let current = [];
  for (const line of String(askText || '').split('\n')) {
    if (!line.trim()) continue;
    // Removals first ("remove devoted", "drop H1290-073").
    let r;
    REMOVE_RE.lastIndex = 0;
    while ((r = REMOVE_RE.exec(line)) !== null) {
      const target = r[1].trim().toLowerCase();
      if (!target) continue;
      current = current.filter((p) => {
        const hay = `${p.name} ${p.planId} ${carrierOf(p.name)}`.toLowerCase();
        return !(hay.includes(target) || target.includes(p.planId.toLowerCase()) || (carrierOf(target) && carrierOf(target) === carrierOf(p.name)));
      });
    }
    const found = plansInLine(line, constraints);
    if (!found.length) continue;
    const isEdit = /\b(add|also|include|plus|instead|swap|replace|in place of)\b/i.test(line) || REMOVE_RE.test(line);
    REMOVE_RE.lastIndex = 0;
    if (isEdit && current.length) {
      for (const f of found) if (!current.some((p) => p.planId.slice(0, 9) === f.planId.slice(0, 9))) current.push(f);
    } else {
      current = found;
    }
  }
  return current;
}

// Carriers whose Florida MA plans all share one provider network.
const SINGLE_NETWORK_CARRIERS = ['Devoted'];
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
function namedPlanColumns(named, matrix, doctors) {
  return named.map((np) => {
    const row = matrix.find((p) => p.planId.slice(0, 9) === np.planId.slice(0, 9));
    const carrier = carrierKey(np.name) || (row && row.carrier) || '';
    const col = { planId: np.planId, name: row ? row.name : np.name, carrier, type: row ? row.type : planTypeOf(np.name), in: [], inCarrier: [], out: [], unknown: [] };
    for (const d of doctors) {
      const who = shortDoctor(d);
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
      else if (carrier && carrierHitIsPlanHit(carrier, np.planId) && directoryFinished(d, carrier)) col.out.push(who);
      else col.unknown.push(who);
    }
    return col;
  });
}

// ─── Doctor/Drug Comparison Table Rules (services/comparisonRules.js) ───────

const R = require('./comparisonRules');

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
  CarePlus: /sunfire|careplus/i,
};
// No live directory check exists for these (Solis = county PDF only).
const NO_LIVE_DIRECTORY = ['Solis'];

/** The carrier's live directory answered for this doctor (not pending, not failed, identity confirmed). */
function directoryFinished(d, carrier) {
  if (!d || d.identityPending) return false;
  if (d.status !== 'done' && d.status !== 'partial') return false;
  const re = PENDING_FOR[carrier];
  if (!re || NO_LIVE_DIRECTORY.includes(carrier)) return false;
  return ![...(d.pending || []), ...(d.failed || [])].some((p) => re.test(String(p)));
}

/** Rule 9: "❔ unchecked" = never checked, "❔ not confirmed" = checked, no result. */
function unknownCell(d, carrier) {
  const status = d && d.status;
  // A match she has not confirmed is never counted In or Out (rule 10).
  if (d && d.identityPending) return R.NOT_CONFIRMED_CELL;
  if (status === 'timeout' || status === 'error') return R.UNCHECKED;
  if (status === 'not_found') return R.NOT_CONFIRMED_CELL;
  if (!carrier || NO_LIVE_DIRECTORY.includes(carrier)) return R.UNCHECKED;
  const re = PENDING_FOR[carrier];
  if (re && [...(d.pending || []), ...(d.failed || [])].some((p) => re.test(String(p)))) return R.UNCHECKED;
  return R.NOT_CONFIRMED_CELL;
}

function cleanName(n) {
  return titleCase(String(n || ''))
    .replace(/,?\s*\b(m\.?\s?d|d\.?\s?o|md|do|pa-?c|aprn|arnp|np|dpm|od|phd|facc|facp|facs)\b\.?/gi, '')
    .replace(/[\s,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ROLE_WORDS_RE = /\b(dr|md|m\.d|do|d\.o|pcp|primary|cardio\w*|neuro\w*|gyn\w*|obgyn|ortho\w*|derm\w*|uro\w*|gastro\w*|onc\w*|endo\w*|rheum\w*|pulm\w*|nephro\w*|podiat\w*|ophth\w*|optom\w*|ent|psych\w*|specialist|doctor)\b\.?/gi;

function plainWords(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(ROLE_WORDS_RE, ' ').split(/[^a-z']+/).filter((w) => w.length > 1);
}

/**
 * Rule 10: is the NPI match the doctor she asked for?
 * 'last_name' — asked by last name only; 'mismatch' — the matched first name is a
 * different person ("Ian Del Conde" → Cesar A Conde, "Carlos Sosa" → Amanda C Sosa);
 * '' — fine (or nothing was matched).
 */
function identityIssue(d) {
  if (!d || !d.doctorName || !['done', 'partial'].includes(d.status)) return '';
  if (lastNameOnly(d)) return 'last_name';
  const asked = plainWords(shortDoctor(d));
  const matched = plainWords(d.doctorName);
  if (asked.length >= 2 && !matched.includes(asked[0])) return 'mismatch';
  return '';
}

function sameDoctorName(a, b) {
  const x = plainWords(a).join(' ');
  const y = plainWords(b).join(' ');
  return Boolean(x) && (x === y || x.includes(y) || y.includes(x));
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
  const inN = p.in.length;
  const outN = p.out.length;
  const star = (p.inCarrier || []).length;
  return { inN, outN, star, unchecked: n - inN - outN };
}

/** Rule 6: "X in · Y out · Z unchecked" (✅ In* counts as unchecked at plan level). */
function countText(p, n) {
  const c = countsOf(p, n);
  return `${c.inN} in · ${c.outN} out · ${c.unchecked} unchecked${c.star ? ` (${c.star} ✅ In*)` : ''}`;
}

/** Doctors down the side, plans across the top. */
function gridTable(doctors, plans) {
  if (!plans.length) return '';
  const n = doctors.length;
  const head = `| Doctor | ${plans.map(shortPlanHeader).join(' | ')} |`;
  const sep = `|---|${plans.map(() => '---').join('|')}|`;
  const rows = doctors.map((d) => {
    const who = shortDoctor(d);
    const cells = plans.map((p) => (
      p.in.includes(who) ? CELL.in
        : (p.inCarrier || []).includes(who) ? CELL.inCarrier
          : p.out.includes(who) ? CELL.out
            : unknownCell(d, p.carrier || carrierKey(p.name))
    ));
    return `| ${doctorLabel(d)} | ${cells.join(' | ')} |`;
  });
  const total = `| **Doctors** | ${plans.map((p) => `**${countText(p, n)}**`).join(' | ')} |`;
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
    const usd = R.exactDollars(row.costShare);
    if (usd == null) return null;
    total += usd;
  }
  return total;
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
  const docs = (Array.isArray(doctors) ? doctors : []).map((d) => {
    const who = shortDoctor(d);
    // Her latest word wins: a wrong match is never counted, even if an older reply said yes.
    if (d.doctorName && wrongMatches.some((nm) => sameDoctorName(nm, who))) {
      return { ...d, identityPending: 'wrong', inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] };
    }
    const issue = identityIssue(d);
    if (!issue || confirmedMatches.some((nm) => sameDoctorName(nm, who))) return { ...d, identityPending: '' };
    return { ...d, identityPending: issue, inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] };
  });
  const n = docs.length;
  // "Carriers requested: Doctors HealthCare, Solis, Devoted" (comparisonAskText) — newest wins.
  const carrierAsks = [...ask0.matchAll(/Carriers requested:\s*([^\n.]+)/gi)];
  const carriers = carrierAsks.length
    ? carrierAsks[carrierAsks.length - 1][1].split(',').map((c) => c.trim()).filter(Boolean)
    : [];
  const drugs = (opts.drugs || []).filter(Boolean);
  const answered = Boolean(opts.answered);
  const ask = String(askText || '');
  const constraints = askConstraints(ask);
  const elig = R.eligibilityFromAsk(`${ask}\n${opts.eligibilityText || ''}`);
  if (constraints.noMedicaid) { elig.medicaid = 'none'; elig.levels = []; }
  const county = R.countyFromAsk(ask);
  const matrix = coverageMatrix(docs);
  const named = Array.isArray(opts.named) ? opts.named : (carriers.length ? [] : namedPlansFromAsk(ask, constraints));
  // Looked-up names first ("Atorvastatin Calcium"), then anything listed but not looked up yet.
  const meds = [];
  for (const m of [...drugs.map(drugNameOf), ...(opts.meds || []), ...R.medsFromAsk(ask)]) {
    const name = String(m || '').trim();
    if (name && !meds.some((x) => R.sameDrug(x, name))) meds.push(name);
  }

  const decorate = (cols) => cols.map((c) => {
    const grid = gridRowFor(c.planId, county);
    const bareId = /^[HR]\d{4}-\d{3}[A-Z]?$/i.test(String(c.name || '').trim());
    const gridName = grid ? String(grid.planName || '') : '';
    const name = grid && bareId && gridName ? (carrierKey(gridName) ? gridName : `${grid.carrier || ''} ${gridName}`.trim()) : c.name;
    const like = grid || { name: c.name };
    return { ...c, name, grid, snp: R.snpKind(like), premium: grid ? R.exactDollars(grid.premium) : null, drugCost: drugCostFor(c.planId, drugs) };
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

  if (named.length) {
    const cols = decorate(namedPlanColumns(named, matrix, docs));
    out.columns = cols;
    out.poolSize = cols.length;
    out.header = '**Doctors × your plans**';
    out.whyLine = `Why these plans: the ${cols.length} plan${cols.length === 1 ? '' : 's'} you named — no plans added or swapped.`;
    for (const c of cols) {
      const e = R.planEligibility(c.grid || { name: c.name }, elig);
      if (c.snp === 'csnp') csnpInPlay = true;
      if (e.status !== 'eligible') out.flags.push(`⚠️ ${shortPlanHeader(c)}: ${e.reason} — you named it, so it stays; confirm eligibility before enrolling.`);
    }
    if (n > 0 && cols.some((c) => c.carrier === 'Solis')) out.flags.push('⚠️ Solis has no live directory check (county PDF only) — Solis doctor cells stay ❔ unchecked until verified in the Solis provider PDF.');
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
      if ([...constraints.skip].some((id) => id.slice(0, 9) === key)) { bump(excluded, 'plans you skipped / terminating'); continue; }
      const like = p.grid || { name: p.name };
      const net = R.networkType(like);
      if (constraints.onlyPpo && net !== 'ppo') { bump(excluded, 'HMOs — you said PPO only'); continue; }
      if (constraints.onlyHmo && net !== 'hmo') { bump(excluded, 'PPOs — you said HMO only'); continue; }
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
        return { ...c, counts: k, verifiable: k.unchecked * 2 <= n };
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
        const picks = byCarrier(c).slice(0, perCarrier);
        out.columns.push(...picks);
        if (!picks.length) {
          const why = carrierExcluded.get(c);
          out.flags.push(`⚠️ ${c}: no eligible plan in ${county || 'Miami-Dade/Broward'}${why ? ` — ${[...why.entries()].map(([r, k]) => `${r} (${k})`).join('; ')}` : ' on the THEI grid'}.`);
        }
      }
      out.columns.filter((c) => !c.verifiable).forEach((c) => out.flags.push(`⚠️ ${shortPlanHeader(c)}: over half the doctors unchecked for this plan — shown because you asked for ${R.carrierOfPlan(c.grid || { name: c.name })}; verify in the carrier directory.`));
      if (carriers.includes('Solis')) out.flags.push('⚠️ Solis has no live directory check (county PDF only) — Solis doctor cells stay ❔ unchecked until verified in the Solis provider PDF.');
      const where = county || 'Miami-Dade + Broward (no ZIP/county given)';
      const excludedText = out.excluded.length ? out.excluded.map((x) => `${x.reason} (${x.count})`).join('; ') : 'none';
      out.whyLine = `Why these plans: you asked for ${carriers.join(', ')} — ${perCarrier === 1 ? 'best eligible plan per carrier' : `top ${perCarrier} eligible ${carriers[0]} plans`} from ${out.poolSize} eligible ${carriers.join(' / ')} plans in ${where}. ${R.RANK_ORDER} Excluded: ${excludedText}.`;
      out.header = `**Doctors × ${carriers.join(', ')}** (the carriers you asked for — a count, not a recommendation)`;
      out.ranked = cols.filter((c) => out.columns.includes(c));
      out.couldNotVerify = [];
      out.couldNotVerifyCount = 0;
    }

    // Compare mode prices meds on a shortlist first; the table only draws from it (rule 8).
    const only = Array.isArray(opts.onlyPlanIds) ? new Set(opts.onlyPlanIds.map((id) => String(id).toUpperCase())) : null;
    for (const c of (carriers.length ? [] : ranked)) {
      if (out.columns.length >= 3) break;
      if (only && !only.has(c.planId)) continue;
      // A plan with no doctor In never fills a top-3 slot while another plan has one In.
      if (n > 0 && c.counts.inN + c.counts.star === 0 && ranked.some((r) => r.counts.inN + r.counts.star > 0)) continue;
      const twin = c.carrier ? out.columns.find((t) => signatureOf(t) === signatureOf(c)) : null;
      if (twin) out.sameNetwork.push({ plan: c, twin, diff: sameNetworkDiff(c, twin) });
      else out.columns.push(c);
    }

    if (!carriers.length) {
    const where = gridRows.length
      ? (county || 'Miami-Dade + Broward (no ZIP/county given)')
      : `${county || 'the lookup results'} (THEI grid unavailable — only plans a doctor lookup returned)`;
    const excludedText = out.excluded.length ? out.excluded.map((x) => `${x.reason} (${x.count})`).join('; ') : 'none';
    out.whyLine = `Why these plans: ${out.poolSize} eligible plans checked in ${where}. ${R.RANK_ORDER} Excluded: ${excludedText}.`;
    const majority = out.columns.some((c) => c.counts.inN * 2 > n);
    out.header = majority
      ? '**Doctors × top plans** (most of these doctors in network — a count, not a recommendation)'
      : '**Doctors × top plans** (best confirmed match shown first — a count, not a recommendation)';
    }
  }

  // C-SNP plans in the table: the condition list is per plan — say so, never assume.
  if (elig.csnp === 'confirmed') {
    out.columns.filter((c) => c.snp === 'csnp').forEach((c) => out.flags.push(`⚠️ ${shortPlanHeader(c)} is a C-SNP — confirm the client's diagnosis is on this plan's qualifying-condition list before enrolling.`));
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
      const r = drugs.find((x) => R.sameDrug(drugNameOf(x), m));
      return !r || tableIds.some((id) => !drugRowFor(r, id));
    });
    out.medsToCheck = { drugs: missingDrugs, planIds: tableIds };
  }

  // Questions (max 3): eligibility first (rule 1), then identity (rule 10), then the rest.
  // Eligibility and identity are asked even after a reply — while they are open, SNP plans
  // stay out and unconfirmed doctors do not count, so they must never go quiet.
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
    // Doctor questions (no match / wrong / confirm) share ONE numbered slot so eligibility always fits.
    const doctorQs = [];
    const missing = docs.filter((d) => d.status === 'not_found');
    if (missing.length) {
      const fmt = (x) => `${x.name}${x.specialty ? ` (${x.specialty}${x.city ? `, ${x.city}` : ''})` : ''}`;
      const per = missing.map((d) => {
        const sug = (d.suggestions || []).slice(0, 3);
        const asked = `"${titleCase(shortDoctor(d))}"`;
        // Likely typo ("Mortyko" → Morytko): ask about that one doctor first.
        if (sug[0] && sug[0].spelling) {
          const others = sug.slice(1).map(fmt);
          return `${asked} — did you mean ${fmt(sug[0])}? (looks like a spelling difference)${others.length ? ` Other close names: ${others.join('; ')}` : ''}`;
        }
        return `${asked}${sug.length ? ` — closest: ${sug.map(fmt).join('; ')}` : ' — no similar name on file (check the spelling, or give the specialty / office)'}`;
      });
      const anyTypo = missing.some((d) => d.suggestions && d.suggestions[0] && d.suggestions[0].spelling);
      const example = `${titleCase(shortDoctor(missing[0]))} = Dr. Full Name`;
      doctorQs.push(`No exact match for: ${per.join(' · ')}. ${anyTypo ? 'Reply "yes" to use the spelling I found, or give the right name' : 'Which doctor is it? Reply'} like "${example}". No NPI needed.`);
    }
    const wrong = docs.filter((d) => d.identityPending === 'wrong');
    if (wrong.length) {
      doctorQs.push(`Which doctor did you mean for ${wrong.map((d) => titleCase(shortDoctor(d))).join(', ')}? The match${wrong.length > 1 ? 'es' : ''} I found ${wrong.length > 1 ? 'were' : 'was'} the wrong person, so ${wrong.length > 1 ? 'they stay' : 'it stays'} ❔ not confirmed — give the full name, specialty or office (no NPI needed).`);
    }
    const toConfirm = docs.filter((d) => d.identityPending && d.identityPending !== 'wrong');
    if (toConfirm.length) {
      doctorQs.push(`Confirm the doctor match (their In/Out stays ❔ not confirmed until you do): ${toConfirm.map((d) => `${titleCase(shortDoctor(d))} → ${cleanName(d.doctorName)}${d.npi ? ` (NPI ${d.npi})` : ''}`).join('; ')}. Right doctor${toConfirm.length > 1 ? 's' : ''}? If not, tell me who (no NPI needed).`);
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
  }
  if (sel.sameNetwork.length) {
    lines.push('**Same network as above**');
    sel.sameNetwork.forEach((s) => lines.push(`- ${shortPlanHeader(s.plan)} — same doctor results as ${shortPlanHeader(s.twin)}; differs: ${s.diff}`));
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
      : 'DOCTOR × PLAN TABLE (selected by the Doctor/Drug Comparison Table Rules — copy the header, the "Why these plans" line and the table as-is):');
    lines.push(sel.header);
    lines.push(sel.whyLine);
    lines.push('');
    lines.push(gridTable(sel.doctors, sel.columns));
    lines.push(R.LEGEND + (sel.columns.some((p) => (p.inCarrier || []).length) ? ` · ${R.IN_STAR_LEGEND}` : ''));
    lines.push('Top plans by count:');
    sel.columns.forEach((p) => lines.push(planLine(p, total)));
    extrasLines(sel).forEach((l) => lines.push(l));
  } else if (sel.whyLine) {
    lines.push('');
    lines.push(sel.whyLine);
    lines.push(`No eligible plan has a verifiable doctor result yet${sel.couldNotVerifyCount ? ` (${sel.couldNotVerifyCount} could not be verified)` : ''}. Do not invent a top 3.`);
    extrasLines(sel).forEach((l) => lines.push(l));
  }
  sel.flags.forEach((f) => lines.push(f));
  lines.push('');
  lines.push('ANSWER FORMAT (required for multi-doctor asks — Doctor/Drug Comparison Table Rules):');
  lines.push('1) Lead with the header, the "Why these plans" line and the DOCTOR × PLAN TABLE above, exactly as given (cells ✅ In / ❌ Out / ❔ unchecked / ❔ not confirmed — never a bare ❔; count row "X in · Y out · Z unchecked" — never "X/N"). Doctor names as matched in the table. Then "Could not verify" / "Same network as above" / ⚠️ flags if present. Never re-rank or swap plans.');
  if (sel.medsToCheck.drugs.length) {
    lines.push(`2) MEDS ALREADY GIVEN — before answering, call lookup_formulary once per drug (${sel.medsToCheck.drugs.join(', ')}) with planIds [${sel.medsToCheck.planIds.join(', ')}] (every table plan). Then add the meds table (Drug | same plan columns | "T1 $0" cells; ❔ unchecked / ❔ not confirmed for unknowns). Never ask for meds that are already listed.`);
  } else if (sel.meds.length) {
    lines.push('2) Meds are already checked on every table plan — add the meds table (Drug | same plan columns | "T1 $0" cells). Never ask for meds again.');
  }
  if (sel.questions.length) {
    lines.push('3) Still missing — ask these (numbered, short), then STOP and wait. Do not list more plans and do not add SNP plans until eligibility is confirmed.');
    sel.questions.forEach((q, i) => lines.push(`   Q${i + 1}. ${q}`));
  } else if (sel.named) {
    lines.push('3) The agent named the plans — compare exactly those. Do not add or swap plans and do not ask narrowing questions.');
  } else if (answered) {
    lines.push('3) The agent already answered the narrowing questions — present the table above (2–3 plans) with every doctor In / Out / unchecked / not confirmed. No other plans.');
  }
  return { text: lines.join('\n'), matrix: sel.ranked, questions: sel.questions, selection: sel };
}

function drugCell(row, unsureNotCovered) {
  if (!row) return R.UNCHECKED;
  if (row.verified && row.coverage === 'not_covered') return unsureNotCovered ? '⚠️ confirm' : '❌ not covered';
  if (row.verified && row.tier) return `T${row.tier}${row.costShare ? ` ${row.costShare}` : ''}${row.pa ? ' · PA' : ''}`;
  return R.NOT_CONFIRMED_CELL;
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
    const cells = plans.map((p) => drugCell(drugRowFor(r, p.planId), Boolean(r.notCoveredNote)));
    rows.push(`| ${titleCase(name)} | ${cells.join(' | ')} |`);
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
  return [head, sep, ...rows].join('\n');
}

/** Plain answer used when the model itself ran out of time. */
function fallbackAnswer(doctors, askText, { answered = false, drugs = [] } = {}) {
  const sel = selectComparison(doctors, askText, { answered, drugs });
  const top = sel.columns;
  const lines = [];
  if (top.length) {
    lines.push(sel.header);
    lines.push(sel.whyLine);
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
      lines.push(meds);
      lines.push('');
      lines.push(R.MEDS_LEGEND);
      if (sel.medsToCheck.drugs.length) {
        lines.push(`Not checked yet on every plan: ${sel.medsToCheck.drugs.map(titleCase).join(', ')} — send the same ask again to finish the lookup.`);
      }
    }
  } else {
    if (sel.whyLine) lines.push(sel.whyLine, '');
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
  planIdOf,
  planTypeOf,
  coverageMatrix,
  askConstraints,
  narrowingAnswered,
  comparisonAskText,
  comparisonFollowUp,
  substitutionsIn,
  numberedAnswers,
  selectComparison,
  batchSummaryForModel,
  gridTable,
  medsTable,
  namedPlansFromAsk,
  namedPlanColumns,
  fallbackAnswer,
  doctorLabel,
  countText,
};
