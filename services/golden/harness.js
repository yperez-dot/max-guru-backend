// services/golden/harness.js — run one golden scenario end to end, with no network.
//
// A scenario (services/golden/scenarios/*.json) is a real Max chat reduced to:
//   workup        the saved workup she loaded (null for a fresh chat)
//   messages      her messages, in order (Max's replies in between are stubbed as "table")
//   doctorResults stubbed carrier lookups: { "<doctor as Max will search it>": { npi, in: [planIds], out: [planIds] } }
//   drugResults   stubbed formulary answers: { "<med>": { "<planId>": { tier, cost, pa, ql, st } | "not_covered" } }
//   medNames      med-name normalizer checks: [{ typed, display }] with "rxnorm" stub answers
//   expect        plans / doctors / meds (exact, include, exclude) + grid cells + layout (on by default)
//
// The same code the live chat and the compare job run: client-workups.messagesForApi → loadedWorkup.resolveWorkupSets
// → compareJobs.runJob (stubbed lookups) → doctorPlanNarrow.renderedAnswer.
const W = require('../../artifacts/client-workups.js');
const LW = require('../loadedWorkup');
const N = require('../doctorPlanNarrow');
const R = require('../comparisonRules');
const { normalizeInput, runJob } = require('../compareJobs');

const ID = (x) => String(x || '').toUpperCase().slice(0, 9);

/** Saved workup + her messages → the messages the server receives. */
function scenarioMessages(sc) {
  const turns = [];
  for (const [k, text] of (sc.messages || []).entries()) {
    if (k > 0) turns.push({ role: 'assistant', content: (sc.replies && sc.replies[k - 1]) || 'table' });
    turns.push({ role: 'user', content: text });
  }
  return W.messagesForApi(turns, sc.workup || null);
}

function planLabel(planId) {
  const row = N.gridRowFor(planId, '');
  if (!row) return planId;
  const nm = N.carrierKey(String(row.planName || '')) ? String(row.planName) : `${row.carrier || ''} ${row.planName || ''}`.trim();
  return `${nm} (${String(row.planId || row.id || planId).toUpperCase()})`;
}

function stubDoctorLookup(sc) {
  const table = sc.doctorResults || {};
  const find = (name) => {
    if (table[name]) return table[name];
    const key = Object.keys(table).find((k) => N.sameDoctorName(k, name) || require('../../artifacts/doctor-name.js').sameNameIgnoringSpacing(k, name));
    return key ? table[key] : null;
  };
  return async ({ doctorName, npi }) => {
    const hit = find(doctorName);
    if (!hit) return { status: 'not_found', structured: { doctorName, networks: [], inNetworkPlans: [], outOfNetworkPlans: [], carriersIn: [] } };
    return {
      status: 'done',
      structured: {
        doctorName: hit.matched || doctorName,
        npi: hit.npi || npi || '',
        isOrg: Boolean(hit.org),
        pending: [], failed: [], networks: [], carriersIn: [],
        inNetworkPlans: (hit.in || []).map(planLabel),
        outOfNetworkPlans: (hit.out || []).map(planLabel),
      },
    };
  };
}

function stubRx(sc) {
  const table = sc.drugResults || {};
  return async ({ drugName, planIds }) => {
    const key = Object.keys(table).find((k) => k.toLowerCase() === String(drugName).toLowerCase())
      || Object.keys(table).find((k) => String(drugName).toLowerCase().startsWith(k.toLowerCase().split(/\s+/)[0]));
    const byPlan = (key && table[key]) || {};
    const byPlanId = {};
    for (const id of planIds) {
      const a = Object.entries(byPlan).find(([k]) => ID(k) === ID(id));
      const v = a ? a[1] : null;
      byPlanId[id] = v === 'not_covered'
        ? { planId: id, verified: true, coverage: 'not_covered', source: 'medicare_gov', restrictionsKnown: true }
        : v
          ? { planId: id, verified: true, coverage: 'covered', tier: v.tier, costShare: v.cost || null, pa: Boolean(v.pa), st: Boolean(v.st), ql: Boolean(v.ql), qlText: v.ql || null, source: 'sunfire', restrictionsKnown: true }
          : { planId: id, verified: false, coverage: null, reason: 'not_stubbed' };
    }
    return { drugName, byPlanId, lookups: Object.values(byPlanId) };
  };
}

/** Everything a scenario produces: sets, compare-job result, chat render. */
async function runScenario(sc) {
  const msgs = scenarioMessages(sc);
  const sets = LW.resolveWorkupSets(msgs);
  const npis = { ...(sets.npis || {}) };
  for (const d of (sc.workup && sc.workup.doctors) || []) if (d.npi && sets.doctors.includes(d.name)) npis[d.name] = d.npi;
  const zip = (sc.workup && sc.workup.zip) || (sets.askText.match(/\b(3[234]\d{3})\b/) || [])[1] || '';
  const input = normalizeInput({
    clientName: (sc.workup && sc.workup.clientName) || '',
    zip,
    doctors: sets.doctors.map((name) => ({ name, npi: npis[name] })),
    meds: sets.meds,
    plans: sets.plans.map((p) => p.planId),
    planNames: Object.fromEntries(sets.plans.map((p) => [p.planId, p.name])),
  });
  const job = { input, status: 'queued', progress: { doctors: { done: 0, total: input.doctors.length }, meds: { done: 0, total: input.meds.length } }, result: {} };
  await runJob(job, { lookupOneDoctor: stubDoctorLookup(sc), lookupRx: stubRx(sc) });
  // Chat path: the same lookups rendered as a chat reply.
  const docs = (job.result.doctors || []);
  const rendered = N.renderedAnswer(docs, sets.askText, { drugs: (job.result.toolResults || []).filter((t) => t.tool === 'lookup_formulary').map((t) => t.output) });
  const chat = N.splitFollowUp(N.stripWhyThesePlans(rendered));
  return { msgs, sets, job, chat };
}

// ─── layout invariants (Yahoska's rules) ──────────────────────────────────────────────────────────────────────
const FORBIDDEN_RE = [
  [/why these plans/i, '"Why these plans" text'],
  [/^\s*\**excluded\**\s*:/im, '"Excluded:" line'],
  [/cost same across strengths/i, '"cost same across strengths" note'],
];
function gridHeaderIds(table) {
  const head = String(table || '').split('\n').find((l) => /^\|\s*Doctor\s*\|/.test(l)) || '';
  return [...head.matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
}
/** Problems with how the result would be laid out; [] when it follows every rule. */
function layoutProblems(run) {
  const out = [];
  const r = run.job.result || {};
  const gridBubble = [r.header, r.doctorTable, r.medsTable, r.legend, r.medsLegend].filter(Boolean).join('\n');
  const fu = W.compareFollowUpLines(r);
  const followBubble = [...(fu.questions || []), ...(fu.notes || [])].join('\n');
  for (const [re, what] of FORBIDDEN_RE) {
    if (re.test(gridBubble) || re.test(followBubble)) out.push(`compare card shows ${what}`);
    if (re.test(run.chat.grid) || re.test(run.chat.followUp)) out.push(`chat reply shows ${what}`);
  }
  // The grid bubble has no questions: those go in the follow-up bubble after it.
  const qLine = (t) => String(t || '').split('\n').find((l) => /❓|\?\s*$/.test(l) && !/^\|/.test(l.trim()) && !/^T = tier|legend/i.test(l));
  if (qLine(gridBubble)) out.push(`compare grid bubble holds a question: ${qLine(gridBubble)}`);
  const chatGridQ = String(run.chat.grid || '').split('\n').find((l) => /❓\s*(?!check|unchecked|not confirmed)|\?\s*$/.test(l) && !/^\|/.test(l.trim()) && !/legend|T = tier/i.test(l));
  if (chatGridQ) out.push(`chat grid bubble holds a question: ${chatGridQ}`);
  // The card's "Plans:" line is exactly the grid's columns.
  const headerIds = [...W.comparePlansLine(r).matchAll(/\b([HR]\d{4}-\d{3}[A-Z]?)\b/gi)].map((m) => m[1].toUpperCase());
  const gridIds = gridHeaderIds(r.doctorTable);
  if (gridIds.length && headerIds.join(',') !== gridIds.join(',')) out.push(`Plans line (${headerIds.join(', ')}) ≠ grid columns (${gridIds.join(', ')})`);
  return out;
}

module.exports = { scenarioMessages, runScenario, layoutProblems, gridHeaderIds, planLabel, stubDoctorLookup, stubRx, ID };
