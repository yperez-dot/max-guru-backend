// services/chatJobs.js — run a /chat turn in the background so the answer survives a tab switch.
//
// The browser used to hold ONE long fetch open until the answer came back. Switch tabs (or let the
// phone sleep) and that fetch could be frozen or dropped — the answer was lost and Max looked like
// he never got the instructions. Now: POST /chat/start returns a job id at once; the page polls
// GET /chat/jobs/:id (short requests) and picks the answer up whenever it comes back.

const crypto = require('crypto');

const TTL_MS = 2 * 60 * 60 * 1000;
const jobs = new Map();

/** A res-like object that captures status + JSON instead of sending it. */
function captureRes(job) {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) {
      job.status = 'done';
      job.httpStatus = this.statusCode;
      job.body = body;
      job.finishedAt = Date.now();
      return this;
    },
  };
}

/** handler(req, res) is the same function that serves POST /chat. */
function startChatJob(handler, body, owner) {
  const job = { id: crypto.randomUUID(), owner: owner || '', status: 'running', createdAt: Date.now(), httpStatus: 0, body: null };
  jobs.set(job.id, job);
  Promise.resolve()
    .then(() => handler({ body }, captureRes(job)))
    .catch((err) => {
      console.error('chat job error:', err && err.message);
      job.status = 'done';
      job.httpStatus = 500;
      job.body = { error: 'Having trouble right now — try again in a moment.' };
      job.finishedAt = Date.now();
    });
  return job;
}

function getChatJob(id, owner) {
  const job = jobs.get(String(id || ''));
  if (!job || job.owner !== (owner || '')) return null;
  return job;
}

function publicChatJob(job) {
  return job.status === 'done'
    ? { id: job.id, status: 'done', httpStatus: job.httpStatus, body: job.body }
    : { id: job.id, status: 'running', elapsedMs: Date.now() - job.createdAt };
}

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) if (now - job.createdAt > TTL_MS) jobs.delete(id);
}
const timer = setInterval(sweep, 10 * 60 * 1000);
if (timer.unref) timer.unref();

/** Jobs still waiting on the model (a deploy's SIGTERM waits for these). */
function runningCount() {
  let n = 0;
  for (const job of jobs.values()) if (job.status === 'running') n += 1;
  return n;
}

// ─── Restart hand-off (AEP audit, 2026-10-08) ───
// Jobs live in memory, so a Railway redeploy used to answer every poll with 404 "That reply
// is gone". On SIGTERM the server waits for running jobs, then writes the finished answers to
// the volume; the next process loads them once, so the page's next poll still gets its answer.
const RESTARTED_BODY = {
  error: 'Max restarted for an update before this answer finished — send the same ask again.',
  code: 'restarted',
};

/** Write unexpired jobs to file. Jobs still running are saved as a clear "send it again" answer. */
function persistJobs(file, { now = Date.now(), fsImpl = require('fs') } = {}) {
  const path = require('path');
  const out = [];
  for (const job of jobs.values()) {
    if (now - job.createdAt > TTL_MS) continue;
    out.push(job.status === 'done'
      ? { id: job.id, owner: job.owner, status: 'done', createdAt: job.createdAt, finishedAt: job.finishedAt || now, httpStatus: job.httpStatus, body: job.body }
      : { id: job.id, owner: job.owner, status: 'done', createdAt: job.createdAt, finishedAt: now, httpStatus: 503, body: RESTARTED_BODY });
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: out }), 'utf8');
  fsImpl.renameSync(tmp, file);
  return out.length;
}

/** Load (once) and delete the hand-off file written by the previous process. */
function loadPersistedJobs(file, { now = Date.now(), fsImpl = require('fs') } = {}) {
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error(`[chatJobs] could not read restart hand-off ${file}: ${err.message}`);
    return 0;
  }
  let loaded = 0;
  for (const job of Array.isArray(raw && raw.jobs) ? raw.jobs : []) {
    if (!job || typeof job.id !== 'string' || jobs.has(job.id)) continue;
    if (!(now - Number(job.createdAt) <= TTL_MS)) continue;
    jobs.set(job.id, { ...job, status: 'done' });
    loaded += 1;
  }
  try { fsImpl.rmSync(file, { force: true }); } catch (_) { /* best effort */ }
  return loaded;
}

module.exports = { startChatJob, getChatJob, publicChatJob, sweep, runningCount, persistJobs, loadPersistedJobs, RESTARTED_BODY, _jobs: jobs };
