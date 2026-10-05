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

function applyConstraints(matrix, c) {
  return matrix.filter((p) => {
    if (c.skip.has(p.planId) || [...c.skip].some((id) => p.planId.startsWith(id))) return false;
    if (c.noMedicaid && p.type === 'dsnp') return false;
    if (c.onlyPpo && p.type !== 'ppo') return false;
    if (c.onlyHmo && p.type !== 'hmo') return false;
    return true;
  });
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

/** The narrowing questions still open for this ask (max 3). */
function narrowingQuestions(askText, matrix, doctorCount, { answered = false } = {}) {
  if (answered) return [];
  const ask = String(askText || '');
  const top = matrix.slice(0, 10);
  const qs = [];
  if (!ASKED.medicaid.test(ask) && top.some((p) => p.type === 'dsnp')) {
    qs.push('Does {client} have Medicaid or a Medicare Savings Program (QMB/SLMB)? — Yes, full Medicaid / Yes, MSP only / No. (D-SNP plans only fit if Yes.)');
  }
  const allCovered = top.some((p) => p.in.length === doctorCount);
  if (!ASKED.mustKeep.test(ask) && !allCovered && doctorCount > 2) {
    qs.push('No single plan has all the doctors. Which doctors are must-keep? (e.g. the PCP + cardiologist)');
  }
  if (!ASKED.network.test(ask) && top.some((p) => p.type === 'ppo') && top.some((p) => p.type === 'hmo')) {
    qs.push('HMO OK (referrals, in-network only), or do they need a PPO?');
  }
  if (qs.length < 3 && !ASKED.rx.test(ask)) {
    qs.push('Any meds to check against the finalists? (names only)');
  }
  return qs.slice(0, 3);
}

function personalize(questions, askText) {
  // Use the client names when the ask has "X & Y Lastname"; otherwise "the client".
  const m = String(askText || '').match(/\b([A-Z][a-z]+)\s*(?:&|and|y)\s*([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
  const who = m ? `${m[1]} and ${m[2]}` : 'the client';
  return questions.map((q) => q.replace('Does {client} have', m ? `Do ${who} have` : 'Does the client have'));
}

function titleCase(t) {
  const s = String(t || '').trim();
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : s;
}

function shortPlanHeader(p) {
  const name = String(p.name || '')
    .replace(/Medicare Advantage/gi, 'MA')
    .replace(/\((?:Regional )?(HMO-POS|HMO|PPO)(?: D-SNP)?\)/i, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return `${name} · ${p.planId}`;
}

const CELL = { in: '✅ In', out: '❌ Out', unknown: '❔' };

/** Doctors down the side, plans across the top. */
/**
 * Plans the agent named in her latest ask ("Compare Humana Gold Plus H1036-065C,
 * Aetna Medicare Select H1609-018 …"). Named plans are the columns — Max never
 * swaps in its own top 3 when she asked for specific plans.
 */
function namedPlansFromAsk(askText, constraints) {
  const lines = String(askText || '').split('\n').filter((l) => /[HR]\d{4}-\d{3}/i.test(l));
  const last = lines[lines.length - 1] || '';
  const out = [];
  const seen = new Set();
  const re = /(?:^|[,;:.]|\bcompare\b|\band\b|\bvs\.?\b|\bshow(?: me| m)?\b)\s*([^,;:.\n]{0,60}?)\s*\(?\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi;
  let m;
  while ((m = re.exec(last)) !== null) {
    const id = m[2].toUpperCase();
    const key = id.slice(0, 9);
    if (seen.has(key)) continue;
    if (constraints && [...constraints.skip].some((x) => x.slice(0, 9) === key)) continue;
    // "Current plan H5420-014 terminating" is context, not a column.
    const after = last.slice(m.index + m[0].length, m.index + m[0].length + 25);
    if (/terminat|ending/i.test(after) || /current plan\s*$/i.test(m[1])) continue;
    seen.add(key);
    const name = String(m[1] || '').replace(/^\s*(compare|vs\.?|and|show(?: me| m)?)\s+/i, '').replace(/\*+/g, '').replace(/\b(new 2027|plan)\b/gi, '').trim();
    out.push({ planId: id, name: name || id });
  }
  return out;
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
      else if (carrier && (d.carriersIn || []).some((c) => carrierKey(c) === carrier || c === carrier)) col.inCarrier.push(who);
      else col.unknown.push(who);
    }
    return col;
  });
}

function gridTable(doctors, plans) {
  if (!plans.length) return '';
  const head = `| Doctor | ${plans.map(shortPlanHeader).join(' | ')} |`;
  const sep = `|---|${plans.map(() => '---').join('|')}|`;
  const rows = doctors.map((d) => {
    const name = titleCase(shortDoctor(d));
    if (d.status === 'not_found' || d.status === 'timeout' || d.status === 'error') {
      return `| ${name} | ${plans.map(() => '❔ not confirmed').join(' | ')} |`;
    }
    const cells = plans.map((p) => (
      p.in.includes(shortDoctor(d)) ? CELL.in
        : (p.inCarrier || []).includes(shortDoctor(d)) ? '✅ In*'
          : p.out.includes(shortDoctor(d)) ? CELL.out : CELL.unknown
    ));
    return `| ${name} | ${cells.join(' | ')} |`;
  });
  const total = `| **Doctors in** | ${plans.map((p) => `**${p.in.length + (p.inCarrier || []).length}/${doctors.length}**`).join(' | ')} |`;
  return [head, sep, ...rows, total].join('\n');
}

function doctorLine(d) {
  const name = shortDoctor(d);
  if (d.status === 'not_found') return `- ${name}: NOT CONFIRMED — no NPI match`;
  if (d.status === 'timeout' || d.status === 'error') return `- ${name}: NOT CONFIRMED — lookup did not finish`;
  const who = d.doctorName && d.doctorName !== name ? ` (${d.doctorName}${d.npi ? `, NPI ${d.npi}` : ''})` : (d.npi ? ` (NPI ${d.npi})` : '');
  const carriers = (d.carriersIn || []).length ? d.carriersIn.join(', ') : 'no in-network hit in finished checks';
  const pending = (d.pending || []).length ? ` · still pending: ${d.pending.join(', ')}` : '';
  return `- ${name}${who}: ${carriers}${pending}`;
}

function planLine(p, total) {
  const out = p.out.length ? ` · Out: ${p.out.join(', ')}` : '';
  const unk = p.unknown.length ? ` · not confirmed: ${p.unknown.join(', ')}` : '';
  return `- ${p.name} (${p.planId}) — ${p.in.length}/${total} doctors in${out}${unk}`;
}

/**
 * Compact text for the model (tool result) — carriers per doctor, top plans by
 * coverage per plan type, and the questions to ask before narrowing.
 */
function batchSummaryForModel(doctors, askText, { answered = false } = {}) {
  const total = doctors.length;
  const constraints = askConstraints(askText);
  const matrix = applyConstraints(coverageMatrix(doctors), constraints);
  const byType = (type) => matrix.filter((p) => p.type === type).slice(0, 4);
  const lines = [];
  lines.push('DOCTORS → carriers in network (finished checks):');
  doctors.forEach((d) => lines.push(doctorLine(d)));
  lines.push('');
  lines.push(`PLAN COVERAGE — doctors in network per 2027 plan (objective count, not a ranking; top per type, ${matrix.length} plans total):`);
  for (const [type, title] of [['hmo', 'HMO / HMO-POS'], ['ppo', 'PPO'], ['dsnp', 'D-SNP (needs Medicaid/MSP)']]) {
    const rows = byType(type);
    if (!rows.length) continue;
    lines.push(`${title}:`);
    rows.forEach((p) => lines.push(planLine(p, total)));
  }
  const applied = [];
  if (constraints.noMedicaid) applied.push('no Medicaid → D-SNPs removed');
  if (constraints.skip.size) applied.push(`skipped ${[...constraints.skip].join(', ')}`);
  if (constraints.onlyPpo) applied.push('PPO only');
  if (constraints.onlyHmo) applied.push('HMO only');
  if (applied.length) lines.push(`Already applied from the agent's ask: ${applied.join('; ')}. Never suggest a removed plan.`);
  lines.push('Carrier-only hits (Florida Blue, HealthSun, Devoted FHIR) are directory facts without a plan ID — not counted per plan. Cigna/HealthSpring is left out on purpose: it has NO 2027 Medicare Advantage plans (pulled out) — never mention Cigna as a 2027 option.');
  const named = namedPlansFromAsk(askText, constraints);
  const qs = named.length ? [] : personalize(narrowingQuestions(askText, matrix, total, { answered }), askText);
  lines.push('');
  const top = named.length ? namedPlanColumns(named, matrix, doctors) : matrix.slice(0, 3);
  if (top.length) {
    lines.push('');
    lines.push(named.length
      ? 'DOCTOR × PLAN TABLE (the plans the agent named — use exactly these columns; copy it as-is). ✅ In* = in the carrier\'s network, plan-level not confirmed:'
      : 'DOCTOR × PLAN TABLE (top 3 after the agent\'s constraints — copy it as-is into the answer):');
    lines.push(gridTable(doctors, top));
  }
  lines.push('');
  lines.push('ANSWER FORMAT (required for multi-doctor asks):');
  lines.push('1) Lead with the DOCTOR × PLAN TABLE above (markdown table; ✅ In / ❌ Out / ❔ not confirmed). No NPIs, no official NPPES names, no carrier lists, no per-doctor plan dumps. If meds were looked up, add a second table: Drug | same plan columns | "T1 $0" style cells.');
  if (qs.length) {
    lines.push('2) The info below is still missing, so ask these questions (numbered, short) and show at most 3 candidate plans with "N/total doctors in" — then STOP and wait for the answers. Do not list more plans.');
    qs.forEach((q, i) => lines.push(`   Q${i + 1}. ${q}`));
  } else if (named.length) {
    lines.push('2) The agent named the plans — compare exactly those (doctors table, then meds table). Do not add or swap plans and do not ask narrowing questions.');
  } else {
    lines.push('2) The agent already answered the narrowing questions — suggest exactly 2–3 plans that fit those answers, each with In / Out / NOT CONFIRMED for every doctor. No other plans.');
  }
  return { text: lines.join('\n'), matrix, questions: qs };
}

function drugCell(row, unsureNotCovered) {
  if (!row) return '❔';
  if (row.verified && row.coverage === 'not_covered') return unsureNotCovered ? '⚠️ confirm' : '❌ not covered';
  if (row.verified && row.tier) return `T${row.tier}${row.costShare ? ` ${row.costShare}` : ''}${row.pa ? ' · PA' : ''}`;
  return '❔';
}

/** Drug rows under the same plan columns. `drugs` = lookup_formulary structured outputs. */
function medsTable(drugResults, plans) {
  if (!drugResults.length || !plans.length) return '';
  const head = `| Drug | ${plans.map(shortPlanHeader).join(' | ')} |`;
  const sep = `|---|${plans.map(() => '---').join('|')}|`;
  const rows = [];
  const seen = new Set();
  for (const r of drugResults) {
    const name = String(r.drugName || (r.drug && r.drug.name) || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const byId = r.byPlanId || (r.drug && r.drug.byPlanId) || {};
    const cells = plans.map((p) => {
      const key = Object.keys(byId).find((k) => k.toUpperCase().slice(0, 9) === p.planId.slice(0, 9));
      return drugCell(key ? byId[key] : null, Boolean(r.notCoveredNote));
    });
    rows.push(`| ${titleCase(name)} | ${cells.join(' | ')} |`);
  }
  return rows.length ? [head, sep, ...rows].join('\n') : '';
}

/** Plain answer used when the model itself ran out of time. */
function fallbackAnswer(doctors, askText, { answered = false, drugs = [] } = {}) {
  const total = doctors.length;
  const constraints = askConstraints(askText);
  const matrix = applyConstraints(coverageMatrix(doctors), constraints);
  const named = namedPlansFromAsk(askText, constraints);
  const top = named.length ? namedPlanColumns(named, matrix, doctors) : matrix.slice(0, 3);
  const lines = [];
  if (top.length) {
    lines.push(named.length
      ? '**Doctors × your plans**'
      : '**Doctors × top plans** (most of these doctors in network — a count, not a recommendation)');
    lines.push('');
    lines.push(gridTable(doctors, top));
    lines.push('');
    const anyCarrier = top.some((p) => (p.inCarrier || []).length);
    lines.push('✅ In · ❌ Out · ❔ not confirmed (never assume Out)' + (anyCarrier ? ' · ✅ In* = in the carrier network; confirm this specific plan in the carrier directory' : ''));
    const meds = medsTable(drugs, top);
    if (meds) {
      lines.push('');
      lines.push('**Meds**');
      lines.push('');
      lines.push(meds);
      lines.push('');
      lines.push('T = tier · ⚠️ confirm = read not covered, check the exact product in Sunfire · ❔ not checked / not confirmed');
    }
  } else {
    lines.push('**Doctors — carriers in network**');
    doctors.forEach((d) => lines.push(doctorLine(d)));
  }
  const qs = named.length ? [] : personalize(narrowingQuestions(askText, matrix, total, { answered }), askText);
  if (qs.length) {
    lines.push('');
    lines.push('**To narrow to 2–3 plans:**');
    qs.forEach((q, n) => lines.push(`${n + 1}. ${q}`));
  }
  return lines.join('\n');
}

module.exports = {
  planIdOf,
  planTypeOf,
  coverageMatrix,
  askConstraints,
  narrowingQuestions,
  narrowingAnswered,
  batchSummaryForModel,
  gridTable,
  medsTable,
  namedPlansFromAsk,
  fallbackAnswer,
};
