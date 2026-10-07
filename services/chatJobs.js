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

module.exports = { startChatJob, getChatJob, publicChatJob, sweep, _jobs: jobs };
