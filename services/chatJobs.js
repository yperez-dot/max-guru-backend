/**
 * Durable chat jobs so a dropped phone tab does not cancel Max.
 * In-flight turns stay in memory (images included). Completed replies are
 * file-backed so Yahoska can poll after she backgrounds or closes the tab.
 * Set MAX_CHAT_JOBS_FILE to the same Railway volume as usage / workups.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_PER_OWNER = 40;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function normalizeOwnerEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function sanitizeRequestId(raw) {
  const id = String(raw || '').trim();
  return REQUEST_ID_RE.test(id) ? id : '';
}

function defaultState() {
  return { updatedAt: new Date().toISOString(), users: {} };
}

function publicJob(job) {
  if (!job) return null;
  const out = {
    ok: true,
    jobId: job.id,
    status: job.status,
    chatId: job.chatId || '',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.status === 'done' && job.result && typeof job.result === 'object') {
    Object.assign(out, job.result);
    out.status = 'done';
    out.jobId = job.id;
  }
  if (job.status === 'error') {
    out.error = job.error || 'Having trouble right now — try again in a moment.';
    if (job.code) out.code = job.code;
    if (job.httpStatus) out.httpStatus = job.httpStatus;
    if (Array.isArray(job.banners)) out.banners = job.banners;
  }
  return out;
}

class ChatJobStore {
  constructor(options = {}) {
    this.filePath =
      options.filePath || process.env.MAX_CHAT_JOBS_FILE || path.join(process.cwd(), 'data', 'max-chat-jobs.json');
    this.maxPerOwner = Number(options.maxPerOwner || process.env.MAX_CHAT_JOBS_PER_OWNER || DEFAULT_MAX_PER_OWNER);
    this.ttlMs = Number(options.ttlMs || process.env.MAX_CHAT_JOBS_TTL_MS || DEFAULT_TTL_MS);
    this.now = options.now || (() => new Date());
    this._queue = Promise.resolve();
    this._waiters = new Map();
    this._running = new Map();
    this.state = this.readState();
    this.purgeExpired();
  }

  withLock(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || typeof raw.users !== 'object' || !raw.users) {
        return defaultState();
      }
      return raw;
    } catch (_) {
      return defaultState();
    }
  }

  writeState() {
    this.state.updatedAt = this.now().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  ownerMap(email) {
    const owner = normalizeOwnerEmail(email);
    if (!owner) return null;
    if (!this.state.users[owner] || typeof this.state.users[owner] !== 'object') {
      this.state.users[owner] = {};
    }
    return this.state.users[owner];
  }

  purgeExpired() {
    const cutoff = this.now().getTime() - this.ttlMs;
    let changed = false;
    for (const owner of Object.keys(this.state.users || {})) {
      const map = this.state.users[owner];
      if (!map || typeof map !== 'object') continue;
      for (const id of Object.keys(map)) {
        const job = map[id];
        const ts = Date.parse(job && (job.updatedAt || job.createdAt)) || 0;
        if (ts && ts < cutoff && job.status !== 'pending') {
          delete map[id];
          changed = true;
        }
      }
    }
    if (changed) this.writeState();
  }

  capOwner(email) {
    const map = this.ownerMap(email);
    if (!map) return;
    const jobs = Object.values(map).sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    );
    if (jobs.length <= this.maxPerOwner) return;
    const keep = new Set(
      jobs.filter((j) => j.status === 'pending').map((j) => j.id).concat(
        jobs.filter((j) => j.status !== 'pending').slice(0, this.maxPerOwner).map((j) => j.id)
      )
    );
    for (const id of Object.keys(map)) {
      if (!keep.has(id)) delete map[id];
    }
  }

  get(email, id) {
    const owner = normalizeOwnerEmail(email);
    const jobId = String(id || '').trim();
    if (!owner || !jobId) return null;
    const live = this._running.get(`${owner}:${jobId}`);
    if (live) return live;
    const map = this.state.users[owner];
    if (!map || typeof map !== 'object') return null;
    return map[jobId] || null;
  }

  create(email, input = {}) {
    const owner = normalizeOwnerEmail(email);
    if (!owner) {
      const err = new Error('owner required');
      err.status = 401;
      err.code = 'access_required';
      throw err;
    }
    const requested = sanitizeRequestId(input.id || input.requestId);
    const existing = requested ? this.get(owner, requested) : null;
    if (existing) return { job: existing, created: false };

    const nowIso = this.now().toISOString();
    const job = {
      id: requested || newId(),
      ownerEmail: owner,
      chatId: String(input.chatId || '').slice(0, 80),
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
      result: null,
      error: null,
    };
    const map = this.ownerMap(owner);
    map[job.id] = {
      id: job.id,
      ownerEmail: owner,
      chatId: job.chatId,
      status: 'pending',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this._running.set(`${owner}:${job.id}`, job);
    this.capOwner(owner);
    this.writeState();
    return { job, created: true };
  }

  _finish(job, patch) {
    const owner = job.ownerEmail;
    Object.assign(job, patch, { updatedAt: this.now().toISOString() });
    const map = this.ownerMap(owner);
    const stored = {
      id: job.id,
      ownerEmail: owner,
      chatId: job.chatId || '',
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
    if (job.status === 'done') stored.result = job.result;
    if (job.status === 'error') {
      stored.error = job.error;
      stored.code = job.code || null;
      stored.httpStatus = job.httpStatus || 500;
      if (Array.isArray(job.banners)) stored.banners = job.banners;
    }
    map[job.id] = stored;
    this._running.delete(`${owner}:${job.id}`);
    this.capOwner(owner);
    this.writeState();
    const waiters = this._waiters.get(job.id) || [];
    this._waiters.delete(job.id);
    waiters.forEach((resolve) => resolve(job));
    return job;
  }

  complete(email, id, result) {
    const job = this.get(email, id);
    if (!job) return null;
    const body = result && typeof result === 'object' ? { ...result } : { content: [] };
    delete body.usageCalls;
    return this._finish(job, { status: 'done', result: body, error: null });
  }

  fail(email, id, err) {
    const job = this.get(email, id);
    if (!job) return null;
    const message =
      (err && err.message) ||
      (typeof err === 'string' ? err : null) ||
      'Having trouble right now — try again in a moment.';
    return this._finish(job, {
      status: 'error',
      error: String(message),
      code: (err && err.code) || null,
      httpStatus: (err && err.status) || 500,
      banners: (err && err.banners) || undefined,
      result: null,
    });
  }

  wait(email, id, timeoutMs = 10 * 60 * 1000) {
    const job = this.get(email, id);
    if (!job) return Promise.resolve(null);
    if (job.status === 'done' || job.status === 'error') return Promise.resolve(job);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this._waiters.get(job.id) || [];
        this._waiters.set(
          job.id,
          list.filter((fn) => fn !== onDone)
        );
        resolve(this.get(email, id));
      }, timeoutMs);
      const onDone = (finished) => {
        clearTimeout(timer);
        resolve(finished);
      };
      const list = this._waiters.get(job.id) || [];
      list.push(onDone);
      this._waiters.set(job.id, list);
    });
  }
}

function createChatJobStore(options) {
  return new ChatJobStore(options);
}

module.exports = {
  ChatJobStore,
  createChatJobStore,
  publicJob,
  sanitizeRequestId,
  newId,
  DEFAULT_MAX_PER_OWNER,
  DEFAULT_TTL_MS,
};
