// services/recheckJobs.js — background re-check of the cells a chat turn ran out of time on.
//
// A doctor or med lookup that misses the chat deadline keeps running (lookupDoctor caches its finished result; the
// formulary promise keeps going). Instead of a ❔ that looks final, the cell reads "⏱ timed out" and this job waits for
// the unfinished lookups, re-renders the same table and hands it to the page, which posts it as an update — no re-paste
// (Yahoska, 2026-10-20: "alert us that it ran out of time, or give it more time").

const crypto = require('crypto');

const RECHECK_MAX_MS = Number(process.env.MAX_RECHECK_MAX_MS || 180_000);
const TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

/** run() resolves to { rendered, toolResults, stillTimedOut }; the job is 'done' either way (an error is a result). */
function startRecheck(run, { maxMs = RECHECK_MAX_MS } = {}) {
  const job = { id: crypto.randomUUID(), status: 'running', createdAt: Date.now(), result: null };
  jobs.set(job.id, job);
  const deadlineAt = Date.now() + maxMs;
  Promise.resolve()
    .then(() => run({ deadlineAt }))
    .then((result) => { job.result = result || null; })
    .catch((err) => { job.result = { error: (err && err.message) || 'recheck_failed' }; })
    .finally(() => { job.status = 'done'; job.finishedAt = Date.now(); });
  return job;
}

function getRecheck(id) {
  return jobs.get(String(id || '')) || null;
}

function publicRecheck(job) {
  return job.status === 'done'
    ? { id: job.id, status: 'done', result: job.result }
    : { id: job.id, status: 'running', elapsedMs: Date.now() - job.createdAt };
}

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) if (now - job.createdAt > TTL_MS) jobs.delete(id);
}
const timer = setInterval(sweep, 5 * 60 * 1000);
if (timer.unref) timer.unref();

module.exports = { startRecheck, getRecheck, publicRecheck, RECHECK_MAX_MS, _jobs: jobs };
