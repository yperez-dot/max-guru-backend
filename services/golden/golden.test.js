// Golden scenarios from real Max chats: one file per client case in services/golden/scenarios/.
// Add one from a pasted chat: node scripts/golden-from-chat.js chat.txt > services/golden/scenarios/<name>.json
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runScenario, layoutProblems, ID } = require('./harness');
const D = require('../drugNames');

const DIR = path.join(__dirname, 'scenarios');
const SCENARIOS = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

const ids = (list) => list.map((p) => ID(p.planId || p));
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function checkList(actual, exp, what, key = (x) => x) {
  if (!exp) return;
  const a = actual.map(key);
  if (exp.exact) assert.deepEqual(a, exp.exact.map(key), `${what}: exact`);
  for (const x of exp.include || []) assert.ok(a.includes(key(x)), `${what}: missing ${x} in [${a.join(', ')}]`);
  for (const x of exp.exclude || []) assert.ok(!a.includes(key(x)), `${what}: ${x} should not be in [${a.join(', ')}]`);
}

/** Stub fetch for RxNorm: { "<url fragment>": <json> } — anything else answers empty. */
function rxnormFetch(stub) {
  return async (url) => {
    const u = decodeURIComponent(String(url)).replace(/\+/g, ' ').toLowerCase();
    const key = Object.keys(stub || {}).find((k) => u.includes(k.toLowerCase()));
    const body = key ? stub[key] : {};
    return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
  };
}

describe('golden scenarios', () => {
  for (const sc of SCENARIOS) {
    describe(`${sc.name} (${sc.file})`, () => {
      let run;
      before(async () => { if (sc.messages && sc.messages.length) run = await runScenario(sc); });
      const e = sc.expect || {};
      if (sc.messages && sc.messages.length) {
        it('plans', () => {
          if (e.plans) checkList(ids(run.sets.plans), Array.isArray(e.plans) ? { exact: e.plans } : e.plans, 'plan set', ID);
          if (e.firstGridPlan) assert.equal(ID((run.job.result.planIds || [])[0]), ID(e.firstGridPlan), 'current plan first');
          for (const c of e.carriersInGrid || []) assert.ok((run.job.result.planIds || []).some((id) => id.startsWith(c)), `carrier ${c} in grid: ${run.job.result.planIds}`);
          if (e.gridPlans) checkList(ids(run.job.result.planIds || []), Array.isArray(e.gridPlans) ? { exact: e.gridPlans } : e.gridPlans, 'grid columns', ID);
        });
        it('doctors', () => {
          if (e.doctors) checkList(run.sets.doctors, Array.isArray(e.doctors) ? { exact: e.doctors } : e.doctors, 'doctor set', norm);
          for (const [doc, cells] of Object.entries(e.cells || {})) {
            const row = String(run.job.result.doctorTable || '').split('\n').find((l) => norm(l).includes(norm(doc)));
            assert.ok(row, `grid row for ${doc}`);
            const head = String(run.job.result.doctorTable).split('\n').find((l) => /^\|\s*Doctor/.test(l)).split('|').map((x) => x.trim());
            const cols = row.split('|').map((x) => x.trim());
            for (const [pid, want] of Object.entries(cells)) {
              const at = head.findIndex((h) => h.toUpperCase().includes(ID(pid)));
              assert.ok(at > 0, `${pid} column`);
              assert.match(cols[at], new RegExp(want, 'i'), `${doc} on ${pid}`);
            }
          }
        });
        it('follow-up bubble', () => {
          const W = require('../../artifacts/client-workups.js');
          const fu = W.compareFollowUpLines(run.job.result);
          const text = [...(fu.questions || []), ...(fu.notes || [])].join('\n');
          for (const re of e.followUpIncludes || []) assert.match(text, new RegExp(re, 'i'), 'follow-up bubble');
          if (e.gridRows !== undefined) {
            const rows = String(run.job.result.doctorTable || '').split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*(Doctor|---|\*\*)/.test(l) && !/^\|-/.test(l));
            assert.equal(rows.length, e.gridRows, `doctor rows:\n${rows.join('\n')}`);
          }
        });
        it('meds', () => {
          if (e.meds) checkList(run.sets.meds, Array.isArray(e.meds) ? { exact: e.meds } : e.meds, 'med set', norm);
          for (const [med, want] of Object.entries(e.medCells || {})) {
            const row = String(run.job.result.medsTable || '').split('\n').find((l) => norm(l).includes(norm(med)));
            assert.ok(row, `meds row for ${med}`);
            assert.match(row, new RegExp(want, 'i'), `${med} cells`);
          }
        });
        if (e.doctorCount !== undefined || e.medsExcludeWords) {
          it('doctor count / no person or practice in meds', () => {
            if (e.doctorCount !== undefined) assert.equal(run.sets.doctors.length, e.doctorCount, `doctors: ${run.sets.doctors.join('; ')}`);
            for (const w of e.medsExcludeWords || []) {
              assert.ok(!run.sets.meds.some((m) => norm(m).includes(norm(w))), `"${w}" is not a med: [${run.sets.meds.join(', ')}]`);
              assert.ok(!String(run.job.result.medsTable || '').toLowerCase().includes(norm(w)), `"${w}" is not a drug row`);
            }
          });
        }
        if (e.followUpExcludes) {
          it('follow-up bubble: nothing about plans outside the set / equal-cost strengths', () => {
            const W = require('../../artifacts/client-workups.js');
            const fu = W.compareFollowUpLines(run.job.result);
            const text = [...(fu.questions || []), ...(fu.notes || []), run.job.result.medsTable || '', run.chat.followUp || '', run.chat.grid || ''].join('\n');
            for (const x of e.followUpExcludes) assert.ok(!text.toLowerCase().includes(x.toLowerCase()), `"${x}" should not appear:\n${text}`);
          });
        }
        if (e.clientName) {
          it('client name', () => {
            // The newest message never renames the client (a doctor mapping / dose answer is not a name).
            const { parseCompareAsk } = require('../compareJobs');
            const last = sc.messages[sc.messages.length - 1];
            const parsed = parseCompareAsk(last).clientName;
            if (sc.workup) assert.ok(!parsed || parsed === e.clientName, `"${last}" read as client "${parsed}"`);
            else assert.equal(parsed, e.clientName);
          });
        }
        if (e.exportMeds || e.exportPlans || e.exportDoctors) {
          it('Excel/PDF export matches the table', () => {
            const exp = require('../../artifacts/comparison-export.js');
            const N = require('../doctorPlanNarrow');
            const r = run.job.result;
            const plans = r.planIds.map((id) => { const g = N.gridRowFor(id, 'Miami-Dade') || {}; return { planId: id, carrier: g.carrier, planName: g.planName, county: 'Miami-Dade' }; });
            const model = exp.buildComparisonModel({ plans, drugs: (r.drugs || []).flatMap((d) => d.export || []), toolResults: r.toolResults, clientName: e.clientName || '', currentPlanIds: run.sets.currentPlan || [], keepPlanOrder: true });
            if (e.clientName) assert.equal(model.aoa[0][0], e.clientName, 'export title is the client');
            const head = model.aoa.find((row) => row.some((c) => /\b[HR]\d{4}-\d{3}/.test(String(c))));
            assert.deepEqual(head.slice(1).map((c) => ID((String(c).match(/[HR]\d{4}-\d{3}[A-Z]?/) || [''])[0])), ids(r.planIds), 'export columns = grid columns');
            // Doctor cells in the sheet = the chat grid's words (dentists: the dental-network cells).
            // Two ways the page builds the sheet: from the chat grid it shows, and from the lookups alone.
            const viaTable = exp.buildComparisonModel({ ...exp.buildExportPayload(plans, r.doctorTable, { chatTable: exp.latestChatTable([{ role: 'assistant', content: r.doctorTable }]), planSetFixed: true, toolResults: r.toolResults, drugs: [] }), keepPlanOrder: true });
            const viaLookups = exp.buildComparisonModel({ ...exp.buildExportPayload(plans, '', { planSetFixed: true, toolResults: r.toolResults, drugs: [] }), keepPlanOrder: true });
            for (const [doc, cells] of Object.entries(e.exportDoctors || {})) {
              for (const [how, m] of [['chat table', viaTable], ['lookups', viaLookups]]) {
                const mh = m.aoa.find((row) => row.some((c) => /\b[HR]\d{4}-\d{3}/.test(String(c)))) || [];
                const mIds = mh.map((c) => ID((String(c).match(/[HR]\d{4}-\d{3}[A-Z]?/) || [''])[0]));
                const row = m.aoa.find((x) => norm(x[0]).includes(norm(doc)));
                assert.ok(row, `export (${how}) doctor row "${doc}" in [${m.aoa.map((x) => x[0]).join(' | ')}]`);
                for (const [pid, want] of Object.entries(cells)) {
                  const at = mIds.indexOf(ID(pid));
                  assert.ok(at > 0, `${pid} export column`);
                  assert.match(String(row[at]), new RegExp(want, 'i'), `${doc} export (${how}) cell on ${pid}`);
                }
              }
            }
            for (const [med, want] of Object.entries(e.exportMeds || {})) {
              const row = model.aoa.find((x) => norm(x[0]) === norm(med));
              assert.ok(row, `export row "${med}" in [${model.aoa.map((x) => x[0]).join(' | ')}]`);
              for (const c of row.slice(1)) {
                const [tier, cost] = [want.match(/T(\d)/)[1], want.split(' ')[1].replace(/[$.]/g, (x) => `\\${x}`)];
                assert.match(String(c), new RegExp(`^(?:T|Tier )${tier}\\s*·?\\s*${cost}$`), `${med} export cell "${c}"`);
                assert.doesNotMatch(String(c), /varies|‖|strength/i);
              }
            }
          });
        }
        if (e.layout !== false) {
          it('layout rules', () => assert.deepEqual(layoutProblems(run), []));
        }
      }
      for (const d of sc.doctorNames || []) {
        it(`doctor name: ${d.name}`, () => {
          const DN = require('../../artifacts/doctor-name.js');
          if (d.export !== undefined) assert.equal(DN.formatDoctorExportName(d.name, d.org ? { organization: true } : null), d.export);
          if (d.query !== undefined) assert.equal(DN.cleanDoctorQuery(d.name), d.query);
          if (d.org !== undefined) assert.equal(DN.isOrganizationName(d.name), d.org);
          for (const v of d.surnameVariants || []) assert.ok(DN.surnameVariants(DN.parseName(DN.cleanDoctorQuery(d.name)).lastName).includes(v), `variant ${v}`);
          for (const same of d.sameAs || []) assert.ok(DN.sameNameIgnoringSpacing(d.name, same) || DN.sameDoctorName(d.name, same), `same as ${same}`);
        });
      }
      for (const m of sc.medNames || []) {
        it(`med name: ${m.typed}`, async () => {
          D._medNameCache.clear();
          D._nameCache.clear();
          const res = await D.normalizeMedName(m.typed, rxnormFetch(sc.rxnorm));
          assert.equal(res.display, m.display);
          if (m.rxcui !== undefined) assert.equal(res.rxcui, m.rxcui);
          if (m.fallbacks) for (const f of m.fallbacks) assert.ok(res.fallbacks.includes(f), `fallback ${f}`);
          if (m.nameStatus) {
            const nc = await D.resolveDrugName(res.query, rxnormFetch(sc.rxnorm));
            assert.equal(nc.status, m.nameStatus);
          }
        });
      }
    });
  }
});
