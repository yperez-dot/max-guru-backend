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
  const matrix = coverageMatrix(doctors);
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
  lines.push('Carrier-only hits (Florida Blue, HealthSun, Devoted FHIR) are directory facts without a plan ID — not counted per plan. Cigna/HealthSpring is left out on purpose: it has NO 2027 Medicare Advantage plans (pulled out) — never mention Cigna as a 2027 option.');
  const qs = personalize(narrowingQuestions(askText, matrix, total, { answered }), askText);
  lines.push('');
  lines.push('ANSWER FORMAT (required for multi-doctor asks):');
  lines.push('1) One line per doctor: name → carriers in network (carrier names only — NEVER list every plan ID per doctor).');
  if (qs.length) {
    lines.push('2) The info below is still missing, so ask these questions (numbered, short) and show at most 3 candidate plans with "N/total doctors in" — then STOP and wait for the answers. Do not list more plans.');
    qs.forEach((q, i) => lines.push(`   Q${i + 1}. ${q}`));
  } else {
    lines.push('2) The agent already answered the narrowing questions — suggest exactly 2–3 plans that fit those answers, each with In / Out / NOT CONFIRMED for every doctor. No other plans.');
  }
  return { text: lines.join('\n'), matrix, questions: qs };
}

/** Plain answer used when the model itself ran out of time. */
function fallbackAnswer(doctors, askText, { answered = false } = {}) {
  const total = doctors.length;
  const matrix = coverageMatrix(doctors);
  const lines = ['**Doctors — carriers in network**'];
  doctors.forEach((d) => lines.push(doctorLine(d)));
  const candidates = [];
  for (const type of ['hmo', 'ppo', 'dsnp']) {
    const best = matrix.find((p) => p.type === type);
    if (best) candidates.push(best);
  }
  if (candidates.length) {
    lines.push('');
    lines.push('**Candidates — most of these doctors in network** (count, not a recommendation)');
    candidates
      .sort((a, b) => b.in.length - a.in.length)
      .slice(0, 3)
      .forEach((p) => lines.push(planLine(p, total)));
  }
  const qs = personalize(narrowingQuestions(askText, matrix, total, { answered }), askText);
  if (qs.length) {
    lines.push('');
    lines.push('**To narrow to 2–3 plans:**');
    qs.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  }
  return lines.join('\n');
}

module.exports = {
  planIdOf,
  planTypeOf,
  coverageMatrix,
  narrowingQuestions,
  narrowingAnswered,
  batchSummaryForModel,
  fallbackAnswer,
};
