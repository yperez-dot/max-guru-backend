// Regression: persist the full requested doctor / med / named-plan lists; a full
// new request that matches a saved name is processed as that ask; a doctor check
// cannot sit at 0/N forever. Synthetic names only — Maya Ortega, Dr. Mara Quinn,
// Dr. Leon Hart. No real client, doctor, or NPI.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkupStore, withRecoveredDoctors, requestedFactsFromQuery } = require('./workups');
const C = require('./compareJobs');
const N = require('./doctorPlanNarrow');
const LW = require('./loadedWorkup');
const CW = require('../artifacts/client-workups.js');

const OWNER = 'agent@example.com';
const PERSON = 'Maya Ortega';
const ZIP = '33322';
const DOCS = ['Mara Quinn', 'Leon Hart'];
const MEDS = ['atorvastatin', 'fluticasone', 'folic acid', 'gemtesa', 'hydroxychloroquine', 'meclizine'];
const ASK = `${PERSON}, ${ZIP}, Dr. Mara Quinn, Dr. Leon Hart, meds: ${MEDS.join(', ')}. She is currently on HealthSun VitalCare (HMO C-SNP) (H5431-21-0). Looking for another giveback option.`;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-workups-preserve-'));
  return { store: new WorkupStore({ filePath: path.join(dir, 'w.json') }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('parse: H5431-21-0 and giveback intent', () => {
  it('H5431-21-0 normalizes to H5431-021 and is the current plan', () => {
    assert.match(C.normalizePlanIds(ASK), /H5431-021/);
    const f = C.parseCompareAsk(ASK);
    assert.equal(f.clientName, PERSON);
    assert.equal(f.zip, ZIP);
    assert.deepEqual(f.doctors.map((d) => d.name), DOCS);
    assert.equal(f.meds.length, 6);
    assert.ok(f.plans.includes('H5431-021'), f.plans.join(','));
    assert.ok(f.currentPlans.includes('H5431-021'), String(f.currentPlans));
    assert.equal(f.wantsAlternatives, true);
  });

  it('isFullClientRequest sees a labeled or unlabeled full paste', () => {
    assert.equal(CW.isFullClientRequest(ASK), true);
    assert.equal(CW.isFullClientRequest(`${PERSON}\nZIP ${ZIP}\nDoctors: Dr. Mara Quinn, Dr. Leon Hart\nMeds: atorvastatin\nPlans: H5431-021`), true);
    assert.equal(CW.isFullClientRequest('check H5431-021'), false);
  });
});

describe('save path never drops the requested doctors', () => {
  it('create with empty doctors still persists N from the original request', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [], doctors: [], medications: [], originalQuery: ASK,
    });
    assert.equal(first.doctors.length, 2, 'server seeds doctors from the query');
    assert.deepEqual(first.doctors.map((d) => d.name), DOCS);
    assert.equal(first.medications.length, 6);
    assert.ok(first.plans.some((p) => p.planId === 'H5431-021'));
    assert.deepEqual(first.currentPlanIds, ['H5431-021']);
    const loaded = withRecoveredDoctors(first);
    assert.ok(!loaded.recoveredDoctors, 'add-back must not fire once the list is persisted');
    assert.ok(!loaded.recoveredDoctorsFlag);
  });

  it('plan-only, meds-only, and a narrowed replaceDoctors check leave N doctors', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [{ planId: 'H5431-021' }],
      doctors: DOCS.map((name) => ({ name, byPlanId: {} })),
      medications: MEDS.map((name) => ({ name, byPlanId: {} })),
      originalQuery: ASK, currentPlanIds: ['H5431-021'],
    });
    assert.equal(first.doctors.length, 2);

    const planOnly = store.upsert(OWNER, {
      id: first.id, clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H1036-305' }, { planId: 'H5431-021' }],
      doctors: [], medications: [],
    });
    assert.equal(planOnly.doctors.length, 2);
    assert.equal(planOnly.medications.length, 6);
    assert.ok(planOnly.plans.some((p) => p.planId === 'H5431-021'), 'named current plan stays');
    assert.ok(planOnly.plans.some((p) => p.planId === 'H1036-305'));

    const medsOnly = store.upsert(OWNER, {
      id: first.id, clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H1036-305' }],
      doctors: [], medications: [{ name: 'atorvastatin', byPlanId: { 'H1036-305': { verified: true, tier: 1, coverage: 'covered' } } }],
    });
    assert.equal(medsOnly.doctors.length, 2);
    assert.equal(medsOnly.medications.length, 6);

    const narrowed = store.upsert(OWNER, {
      id: first.id, clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H1036-305' }],
      doctors: [{ name: 'Mara Quinn', byPlanId: { 'H1036-305': 'in' } }],
      replaceDoctors: true,
    });
    assert.equal(narrowed.doctors.length, 2, 'replaceDoctors without a new latestQuery must not drop the rest');
    assert.ok(narrowed.doctors.some((d) => d.name === 'Leon Hart'));
    assert.equal(narrowed.doctors.find((d) => d.name === 'Mara Quinn').byPlanId['H1036-305'], 'IN');
  });

  it('a full new request on a matching saved name merges current plan + keep doctors', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [], doctors: [], medications: [], originalQuery: `${PERSON}, ${ZIP}, Dr. Mara Quinn, Dr. Leon Hart, meds: atorvastatin`,
    });
    assert.equal(first.doctors.length, 2);
    const again = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [], doctors: [], medications: [], latestQuery: ASK,
    });
    assert.equal(again.id, first.id, 'same client name updates the saved workup');
    assert.equal(again.doctors.length, 2);
    assert.deepEqual(again.currentPlanIds, ['H5431-021']);
    assert.ok(again.plans.some((p) => p.planId === 'H5431-021'));
    assert.equal(again.medications.length, 6);
    const facts = requestedFactsFromQuery(ASK);
    assert.equal(facts.wantsAlternatives, true);
    assert.deepEqual(facts.currentPlans, ['H5431-021']);
  });

  it('explicit remove is the only way a saved doctor is dropped', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [{ planId: 'H5431-021' }],
      doctors: DOCS.map((name) => ({ name, byPlanId: {} })),
      medications: MEDS.map((name) => ({ name, byPlanId: {} })),
      originalQuery: ASK,
    });
    const dropped = store.upsert(OWNER, {
      id: first.id, clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H5431-021' }],
      doctors: [{ name: 'Mara Quinn', byPlanId: {} }],
      latestQuery: 'remove Dr. Leon Hart',
    });
    assert.deepEqual(dropped.doctors.map((d) => d.name), ['Mara Quinn']);
  });

  it('add-back still fires as a safety net and is flagged', () => {
    const w = withRecoveredDoctors({
      originalQuery: ASK, zip: ZIP, doctors: [], history: [],
    });
    assert.deepEqual(w.recoveredDoctors, DOCS);
    assert.equal(w.recoveredDoctorsFlag, true);
    assert.match(CW.recoveredDoctorsNote(w), /Added back Mara Quinn, Leon Hart from the original request/);
  });
});

describe('loaded-workup follow-up uses the new ask', () => {
  it('resolveWorkupSets pins H5431-021 and shops giveback alternatives', () => {
    const ctx = CW.compactWorkupContext({
      clientName: PERSON, zip: ZIP, county: 'Broward',
      currentPlanIds: ['H5431-021'],
      plans: [{ planId: 'H5431-021', planName: 'HealthSun VitalCare', carrier: 'HealthSun' }],
      doctors: DOCS.map((name) => ({ name, byPlanId: {} })),
      medications: MEDS.map((name) => ({ name, byPlanId: {} })),
    });
    const msgs = [{ role: 'user', content: ctx }, { role: 'user', content: ASK }];
    const sets = LW.resolveWorkupSets(msgs);
    assert.ok(sets.doctors.length >= 2, String(sets.doctors));
    assert.ok(sets.currentPlan.includes('H5431-021'), String(sets.currentPlan));
    assert.match(sets.askText, /H5431-021|giveback|alternatives|current plan/i);
    const sel = N.selectComparison(
      DOCS.map((name) => ({ requestedName: name, doctorName: name, status: 'done', networks: [], inNetworkPlans: [], outOfNetworkPlans: [] })),
      sets.askText,
      { meds: MEDS }
    );
    assert.ok(sel.columns.some((c) => String(c.planId).slice(0, 9) === 'H5431-021') || /current plan/i.test(sets.askText));
  });
});

describe('doctor check finishes or times out — never hangs at 0/N', () => {
  it('a lookup that never answers marks timeout and completes the job', async () => {
    const hang = () => new Promise((resolve) => {
      const t = setTimeout(() => resolve({ status: 'timeout', doctorName: 'x', structured: { doctorName: 'x', networks: [] } }), 30_000);
      if (t && typeof t.unref === 'function') t.unref();
    });
    const job = {
      status: 'queued',
      input: C.normalizeInput({ zip: ZIP, doctors: [{ name: 'Mara Quinn' }, { name: 'Leon Hart' }], meds: [] }),
      progress: { doctors: { done: 0, total: 2 }, meds: { done: 0, total: 0 } },
      result: {},
    };
    const t0 = Date.now();
    await C.runJob(job, { lookupOneDoctor: hang, lookupRx: async () => ({ lookups: [] }), lookupTimeoutMs: 40 });
    assert.ok(Date.now() - t0 < 2000, 'must not hang');
    assert.equal(job.progress.doctors.done, 2);
    assert.ok(job.status === 'done' || job.status === 'error', job.status);
    if (job.status === 'done') {
      assert.equal(job.result.doctors.length, 2);
      assert.ok(job.result.doctors.every((d) => d.status === 'timeout' || d.status === 'error'));
    }
  });
});

describe('intake answers survive save and reload', () => {
  it('C-SNP yes on the workup includes county C-SNPs and never says not confirmed', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [{ planId: 'H5431-021' }],
      doctors: DOCS.map((name) => ({ name, byPlanId: {} })),
      medications: MEDS.map((name) => ({ name, byPlanId: {} })),
      originalQuery: ASK,
      eligibility: { medicaid: 'none', csnp: 'confirmed', conditions: ['diabetes'] },
    });
    assert.equal(first.eligibility.csnp, 'confirmed');
    assert.equal(first.eligibility.medicaid, 'none');
    const thin = store.upsert(OWNER, {
      id: first.id, clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H5431-021' }], doctors: [], medications: [],
    });
    assert.equal(thin.eligibility.csnp, 'confirmed', 'a thin re-save must not wipe intake');
    assert.equal(thin.eligibility.medicaid, 'none');

    const ctx = CW.compactWorkupContext(thin);
    assert.match(ctx, /C-SNP qualifying condition confirmed/);
    assert.match(ctx, /No Medicaid/);
    const ask = N.comparisonAskText([
      { role: 'user', content: ctx },
      { role: 'user', content: 'Looking for another giveback option.' },
    ]);
    assert.match(ask, /C-SNP qualifying condition confirmed/);
    const elig = require('./comparisonRules').eligibilityFromAsk(ask);
    assert.equal(elig.csnp, 'confirmed');
    const sel = N.selectComparison(
      DOCS.map((name) => ({
        requestedName: name, doctorName: name, status: 'done',
        networks: [], inNetworkPlans: ['HealthSun VitalCare (H5431-021)'], outOfNetworkPlans: [],
      })),
      ask,
      { meds: MEDS }
    );
    const ids = sel.columns.map((c) => String(c.planId).slice(0, 9));
    assert.ok(ids.includes('H5431-021'), ids.join(','));
    const R = require('./comparisonRules');
    const csnpIn = [sel.columns, sel.ranked || []].flat().filter((c) => R.snpKind(N.gridRowFor(c.planId, 'Broward') || c) === 'csnp');
    assert.ok(csnpIn.length >= 1, 'confirmed C-SNP yes must keep county C-SNPs: ' + ids.join(','));
    assert.doesNotMatch(String(sel.whyLine || ''), /C-SNPs — qualifying condition not confirmed|Left out until confirmed:[^\n]*C-SNP/i);
    assert.equal((sel.flags || []).some((f) => /qualifying condition not confirmed/i.test(f)), false);
    assert.equal((sel.questions || []).some((q) => /C-SNP qualifying chronic condition/i.test(q)), false);
  });
});

describe('quantity limits stay hidden until the agent asks', () => {
  const row = { verified: true, coverage: 'covered', tier: 1, costShare: '$0', pa: true, ql: true, qlText: 'QL 30/30', hrm: true, restrictionsKnown: true };
  const plans = [{ planId: 'H5431-021', name: 'HealthSun VitalCare' }];
  const drugs = [{ drugName: 'meclizine', byPlanId: { 'H5431-021': row }, lookups: [row] }];

  it('chat cells hide QL by default, offer a chip, and show QL after she accepts', () => {
    const hidden = N.medsTable(drugs, plans);
    assert.match(hidden, /T1 \$0 · PA · HRM \(PA 65\+\)/);
    assert.doesNotMatch(hidden, /QL 30\/30| · QL(?:\s|$)/);
    assert.doesNotMatch(N.medsLegendFor(hidden), /QL = quantity limit/);
    assert.equal(N.medsHaveQuantityLimits(drugs, plans), true);

    const shown = N.medsTable(drugs, plans, { showQl: true });
    assert.match(shown, /QL 30\/30/);
    assert.match(shown, /PA/);
    assert.match(shown, /HRM \(PA 65\+\)/);
    assert.match(N.medsLegendFor(shown, { showQl: true }), /QL = quantity limit/);

    const docs = DOCS.map((name) => ({
      requestedName: name, doctorName: name, status: 'done',
      networks: [], inNetworkPlans: ['HealthSun VitalCare (H5431-021)'], outOfNetworkPlans: [],
    }));
    const text = N.renderedAnswer(docs, 'ZIP 33322. Meds: meclizine. Compare H5431-021.', { drugs });
    assert.match(text, /Show quantity limits\?/);
    assert.doesNotMatch(text.split('**Meds**')[1] || '', /QL 30\/30/);
    const accepted = N.renderedAnswer(docs, 'ZIP 33322. Meds: meclizine. Compare H5431-021.\nShow quantity limits.', { drugs });
    assert.match(accepted, /QL 30\/30/);
    assert.doesNotMatch(accepted, /Show quantity limits\?/);
  });

  it('the choice persists on the workup and the export matches', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP, plans: [{ planId: 'H5431-021' }],
      doctors: DOCS.map((name) => ({ name, byPlanId: {} })),
      medications: [{ name: 'meclizine', byPlanId: { 'H5431-021': row } }],
    });
    assert.equal(first.showQl, false);
    const after = store.upsert(OWNER, {
      id: first.id, clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H5431-021' }],
      showQl: true,
    });
    assert.equal(after.showQl, true);
    const ctx = CW.compactWorkupContext(after);
    assert.match(ctx, /Show quantity limits/);
    const exp = require('../artifacts/comparison-export.js');
    const hidden = exp.formatDrugCell(row, { planId: 'H5431-021' });
    const visible = exp.formatDrugCell(row, { planId: 'H5431-021' }, { showQl: true });
    assert.match(hidden, /PA/);
    assert.match(hidden, /HRM \(PA 65\+\)/);
    assert.doesNotMatch(hidden, /\bQL\b/);
    assert.match(visible, /QL 30\/30/);
    assert.equal(exp.stripQuantityLimits('Tier 1 · $0 · PA · QL 30/30 · HRM (PA 65+)'), 'Tier 1 · $0 · PA · HRM (PA 65+)');
  });
});

const SPOUSE = 'Jordan Hale';
const SPOUSE_ASK = `${SPOUSE}, ${ZIP}. Currently on HealthSun VitalCare (HMO C-SNP) (H5431-21-0). Compare his plan with Humana Gold Plus Diabetes & Heart\nH1036-121\nand Solis Wellness Giveback\nH0982-030.`;
const SPOUSE_WRAP = `${SPOUSE}, ${ZIP}. Currently on HealthSun VitalCare (HMO C-SNP) (H5431-21-0). Compare his plan with Humana Gold Plus Diabetes & Heart H1036-\n121 and Solis Wellness Giveback H0982-\n030.`;

describe('named exact plans lock; a spouse never inherits the other client set', () => {
  it('line-broken IDs join and the set is only current + named', () => {
    assert.match(N.normalizeTypedPlanIds(SPOUSE_WRAP), /H1036-121/);
    assert.match(N.normalizeTypedPlanIds(SPOUSE_WRAP), /H0982-030/);
    const f = C.parseCompareAsk(SPOUSE_WRAP);
    assert.ok(f.plans.includes('H5431-021') && f.plans.includes('H1036-121') && f.plans.includes('H0982-030'), f.plans.join(','));
    assert.equal(f.plans.some((id) => id.slice(0, 9) === 'H1036-065' || id.slice(0, 9) === 'H1036-305'), false);
    const ask = N.comparisonAskText([
      { role: 'user', content: CW.compactWorkupContext({ clientName: PERSON, zip: ZIP, currentPlanIds: ['H5431-021'], plans: [{ planId: 'H5431-021' }, { planId: 'H1036-065C' }, { planId: 'H1036-305' }] }) },
      { role: 'user', content: SPOUSE_ASK },
    ]);
    const setLine = (ask.match(/^Named plan set:.*$/m) || [])[0] || '';
    assert.match(setLine, /H5431-021/);
    assert.match(setLine, /H1036-121/);
    assert.match(setLine, /H0982-030/);
    assert.doesNotMatch(setLine, /H1036-065C|H1036-305/);
    const named = N.namedPlansFromAsk(ask, N.askConstraints(ask)).map((p) => p.planId.slice(0, 9));
    assert.deepEqual(named.sort(), ['H0982-030', 'H1036-121', 'H5431-021']);
  });

  it('a new client / spouse upsert does not keep the prior client plan set', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    store.upsert(OWNER, {
      clientName: PERSON, zip: ZIP,
      plans: [{ planId: 'H5431-021' }, { planId: 'H1036-065C' }, { planId: 'H1036-305' }],
      currentPlanIds: ['H5431-021'], originalQuery: ASK,
    });
    const spouse = store.upsert(OWNER, {
      clientName: SPOUSE, zip: ZIP,
      plans: [{ planId: 'H5431-021' }, { planId: 'H1036-065C' }, { planId: 'H1036-305' }],
      doctors: [{ name: 'Mara Quinn', byPlanId: {} }],
      medications: [{ name: 'clotrimazole/betamethasone dipropionate LOT DIPROP', byPlanId: {} }],
      latestQuery: SPOUSE_ASK, originalQuery: SPOUSE_ASK,
    });
    assert.equal(spouse.clientName, SPOUSE);
    const ids = spouse.plans.map((p) => p.planId.slice(0, 9)).sort();
    assert.deepEqual(ids, ['H0982-030', 'H1036-121', 'H5431-021']);
    assert.equal(CW.sameClientLead(PERSON, SPOUSE), false);
    assert.equal(CW.sameClientLead(PERSON, PERSON), true);
  });
});

describe('C-SNP warning only labels the current plan', () => {
  const docs = DOCS.map((name) => ({
    requestedName: name, doctorName: name, status: 'done',
    networks: [], inNetworkPlans: ['HealthSun VitalCare (H5431-021)'], outOfNetworkPlans: [],
  }));
  it('named alternatives are not "the client\'s current plan"', () => {
    const ask = 'ZIP 33322. Her current plan: H5431-021.\nNamed plan set: HealthSun VitalCare (H5431-021); Humana Gold Plus Diabetes & Heart (H1036-121); Solis Wellness Giveback (H0982-030).';
    const sel = N.selectComparison(docs, ask, { meds: [] });
    const flags = (sel.flags || []).join('\n');
    const currentHits = (flags.match(/it is the client's current plan, so it stays/g) || []).length;
    assert.ok(currentHits <= 1, flags);
    if (/H1036-121/.test(flags) && /qualifying condition not confirmed/i.test(flags)) {
      assert.match(flags, /shown because you asked to compare this plan/);
    }
    assert.doesNotMatch(flags, /H1036-121[^\n]*it is the client's current plan, so it stays/);
    assert.doesNotMatch(flags, /H0982-030[^\n]*it is the client's current plan, so it stays/);
  });
  it('C-SNP intake yes prints no warning', () => {
    const ask = 'ZIP 33322. Her current plan: H5431-021.\nC-SNP qualifying condition confirmed: diabetes.\nNamed plan set: HealthSun VitalCare (H5431-021); Humana Gold Plus Diabetes & Heart (H1036-121); Solis Wellness Giveback (H0982-030).';
    const sel = N.selectComparison(docs, ask, { meds: [] });
    const flags = (sel.flags || []).join('\n');
    assert.doesNotMatch(flags, /it is the client's current plan, so it stays/);
    assert.doesNotMatch(flags, /qualifying condition not confirmed/);
  });
});

describe('slash-combo meds keep every ingredient and the typed form', () => {
  const D = require('./drugNames');
  it('LOT is lotion; both ingredients stay; never suggest plain betamethasone', async () => {
    const raw = 'clotrimazole/betamethasone dipropionate LOT DIPROP';
    assert.equal(D.requestedForm(raw), 'lotion');
    const parts = D.medNameParts(raw);
    assert.ok(parts.ingredients.some((i) => /clotrimazole/.test(i)), String(parts.ingredients));
    assert.ok(parts.ingredients.some((i) => /betamethasone/.test(i)), String(parts.ingredients));
    const display = D.localMedDisplay(raw);
    assert.match(display, /clotrimazole/i);
    assert.match(display, /betamethasone/i);
    assert.match(display, /lotion/i);
    assert.doesNotMatch(display, /cream/i);
    const fetchImpl = async (url) => {
      if (/rxcui\.json/.test(url)) {
        return { ok: true, async text() { return JSON.stringify({ idGroup: { rxnormId: ['308182'] } }); } };
      }
      return { ok: true, async text() { return '{}'; } };
    };
    const r = await D.resolveDrugName(raw, fetchImpl);
    assert.notEqual(r.status, 'ambiguous');
    assert.equal(r.suggestion || null, null);
    assert.match(String(r.name || r.query), /clotrimazole/i);
    assert.match(String(r.name || r.query), /betamethasone/i);
  });
});

describe('remove/add applies to every listed plan ID', () => {
  it('Remove H1036-065C and H1036-305 drops both', () => {
    const plans = [
      { planId: 'H5431-021', name: 'HealthSun VitalCare' },
      { planId: 'H1036-065C', name: 'Humana Gold Plus' },
      { planId: 'H1036-305', name: 'Humana Gold Plus Giveback' },
      { planId: 'H1036-121', name: 'Humana Gold Plus Diabetes & Heart' },
    ];
    const rm = LW.planRemovals('Remove H1036-065C and H1036-305', plans, ['H5431-021']);
    assert.deepEqual([...rm.remove].map((id) => id.slice(0, 9)).sort(), ['H1036-065', 'H1036-305']);
    const left = LW.removePlansNamedIn(plans, 'Remove H1036-065C and H1036-305', ['H5431-021']).map((p) => p.planId.slice(0, 9)).sort();
    assert.deepEqual(left, ['H1036-121', 'H5431-021']);
    const comma = LW.planRemovals('Remove H1036-065C, H1036-305', plans, ['H5431-021']);
    assert.deepEqual([...comma.remove].map((id) => id.slice(0, 9)).sort(), ['H1036-065', 'H1036-305']);
  });
});

describe('UI wires persist + pending ask + visible timeout', () => {
  const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
  it('create saves doctors/meds/plans from the paste, not an empty workup', () => {
    assert.match(html, /doctors: doctorRows, medications: medRows/);
    assert.match(html, /pendingAsk: rawText/);
    assert.match(html, /isFullClientRequest/);
    assert.match(html, /pendingAsk: content/);
  });
  it('a stuck 0\/N card errors visibly', () => {
    assert.match(html, /Doctor check timed out — send the request again/);
    assert.match(html, /lookup that never answered/);
  });
  it('quantity-limit chip and workup persist are wired', () => {
    assert.match(html, /data-testid="show-quantity-limits"/);
    assert.match(html, /Show quantity limits\?/);
    assert.match(html, /built\.showQl/);
    assert.match(html, /eligibility: f\.eligibility/);
  });
  it('name-match requires the same client; a spouse paste detaches', () => {
    assert.match(html, /sameClientLead/);
    assert.match(html, /never inherits that plan set/);
  });
});
