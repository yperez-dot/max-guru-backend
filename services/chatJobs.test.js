const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startChatJob, getChatJob, publicChatJob, sweep, _jobs } = require('./chatJobs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('chat jobs (answer survives a tab switch)', () => {
  it('runs the /chat handler in the background and keeps the answer for polling', async () => {
    const job = startChatJob(async (req, res) => { await sleep(30); res.status(200).json({ content: [{ type: 'text', text: `got ${req.body.q}` }] }); }, { q: 'hi' }, 'a@x.com');
    assert.equal(publicChatJob(getChatJob(job.id, 'a@x.com')).status, 'running');
    await sleep(80);
    const done = publicChatJob(getChatJob(job.id, 'a@x.com'));
    assert.equal(done.status, 'done');
    assert.equal(done.httpStatus, 200);
    assert.equal(done.body.content[0].text, 'got hi');
  });
  it('keeps error statuses (429, 402 …) exactly as /chat would have returned them', async () => {
    const job = startChatJob(async (req, res) => res.status(429).json({ error: 'slow down' }), {}, 'a@x.com');
    await sleep(10);
    const done = publicChatJob(getChatJob(job.id, 'a@x.com'));
    assert.equal(done.httpStatus, 429);
    assert.equal(done.body.error, 'slow down');
  });
  it('a crashing handler becomes a 500 message, and jobs are private to their owner', async () => {
    const job = startChatJob(async () => { throw new Error('boom'); }, {}, 'a@x.com');
    await sleep(10);
    assert.equal(publicChatJob(getChatJob(job.id, 'a@x.com')).httpStatus, 500);
    assert.equal(getChatJob(job.id, 'someone@else.com'), null);
  });
  it('expired jobs are swept', () => {
    const job = startChatJob(async (req, res) => res.json({}), {}, 'a@x.com');
    sweep(Date.now() + 3 * 60 * 60 * 1000);
    assert.equal(_jobs.has(job.id), false);
  });
});

// ─── Graceful redeploys (AEP audit, 2026-10-08) ───
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { persistJobs, loadPersistedJobs, runningCount, RESTARTED_BODY } = require('./chatJobs');
const { createShutdown, createInFlightCounter } = require('./shutdown');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-shutdown-'));
  return { file: path.join(dir, name), dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('restart hand-off of chat answers', () => {
  it('finished answers survive a restart; running ones become a clear "send it again"; owners stay private', async () => {
    _jobs.clear();
    const done = startChatJob(async (req, res) => res.status(200).json({ content: [{ type: 'text', text: 'Aetna In' }] }), {}, 'a@x.com');
    let release;
    const running = startChatJob(() => new Promise((r) => { release = r; }), {}, 'b@x.com');
    await sleep(10);
    assert.equal(runningCount(), 1);
    const { file, cleanup } = tmpFile('chat-jobs-handoff.json');
    try {
      assert.equal(persistJobs(file), 2);
      _jobs.clear(); // the old process is gone
      assert.equal(loadPersistedJobs(file), 2);
      assert.equal(fs.existsSync(file), false, 'hand-off file is consumed once');
      const a = publicChatJob(getChatJob(done.id, 'a@x.com'));
      assert.equal(a.status, 'done');
      assert.equal(a.body.content[0].text, 'Aetna In');
      const b = publicChatJob(getChatJob(running.id, 'b@x.com'));
      assert.equal(b.status, 'done');
      assert.equal(b.httpStatus, 503);
      assert.deepEqual(b.body, RESTARTED_BODY);
      assert.equal(getChatJob(done.id, 'b@x.com'), null);
      assert.equal(loadPersistedJobs(file), 0, 'missing file is fine');
    } finally {
      release && release();
      _jobs.clear();
      cleanup();
    }
  });

  it('expired jobs are not handed off', () => {
    _jobs.clear();
    _jobs.set('old', { id: 'old', owner: 'a@x.com', status: 'done', createdAt: Date.now() - 3 * 60 * 60 * 1000, httpStatus: 200, body: {} });
    const { file, cleanup } = tmpFile('h.json');
    try {
      assert.equal(persistJobs(file), 0);
    } finally {
      _jobs.clear();
      cleanup();
    }
  });
});

describe('graceful SIGTERM (shutdown.js)', () => {
  function fakeRes() {
    return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  }
  const run = (mw, method, p) => {
    let passed = false;
    const res = fakeRes();
    mw({ method, path: p }, res, () => { passed = true; });
    return { passed, res };
  };

  it('stops new chats/comparisons while draining, but polls, health and saves keep working', () => {
    const sd = createShutdown({ getInFlight: () => 1, exit: () => {}, timeoutMs: 50, pollMs: 5, log: { log() {}, error() {} } });
    assert.equal(run(sd.rejectNewWork, 'POST', '/chat/start').passed, true, 'not draining yet');
    sd.begin('SIGTERM');
    for (const p of ['/chat', '/chat/start', '/compare/jobs', '/compare/parse']) {
      const r = run(sd.rejectNewWork, 'POST', p);
      assert.equal(r.passed, false, p);
      assert.equal(r.res.statusCode, 503);
      assert.equal(r.res.body.code, 'restarting');
    }
    assert.equal(run(sd.rejectNewWork, 'GET', '/chat/jobs/abc').passed, true);
    assert.equal(run(sd.rejectNewWork, 'GET', '/compare/jobs/abc').passed, true);
    assert.equal(run(sd.rejectNewWork, 'GET', '/health').passed, true);
    assert.equal(run(sd.rejectNewWork, 'PUT', '/workups').passed, true);
  });

  it('waits for in-flight replies, then hands off and exits 0', async () => {
    let inFlight = 2;
    const calls = [];
    const sd = createShutdown({
      getInFlight: () => inFlight,
      onDrained: () => { calls.push('handoff'); return 3; },
      closeServer: (cb) => { calls.push('close'); cb(); },
      exit: (code) => calls.push(`exit ${code}`),
      timeoutMs: 2000,
      pollMs: 5,
      log: { log() {}, error() {} },
    });
    const p = sd.begin('SIGTERM');
    assert.strictEqual(sd.begin('SIGTERM'), p, 'a second signal does not start a second drain');
    await sleep(30);
    assert.deepEqual(calls, [], 'still waiting');
    inFlight = 0;
    const out = await p;
    assert.equal(out.reason, 'drained');
    assert.equal(out.persisted, 3);
    assert.deepEqual(calls, ['handoff', 'close', 'exit 0']);
  });

  it('is bounded: exits after the timeout even if a reply never finishes', async () => {
    const t0 = Date.now();
    const exits = [];
    const out = await createShutdown({ getInFlight: () => 1, exit: (c) => exits.push(c), timeoutMs: 60, pollMs: 5, log: { log() {}, error() {} } }).begin('SIGTERM');
    assert.match(out.reason, /timed out with 1 still running/);
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(exits, [0]);
  });

  it('counts synchronous /chat requests until they finish or the client goes away', () => {
    const c = createInFlightCounter();
    const handlers = {};
    const res = { on: (ev, fn) => { handlers[ev] = fn; } };
    c.track({}, res, () => {});
    assert.equal(c.count(), 1);
    handlers.finish();
    handlers.close();
    assert.equal(c.count(), 0, 'finish + close only decrement once');
  });
});

describe('server.js SIGTERM end-to-end', () => {
  it('boots, restores handed-off answers, and exits 0 on SIGTERM after writing the hand-off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-server-'));
    const handoff = path.join(dir, 'chat-jobs-handoff.json');
    fs.writeFileSync(handoff, JSON.stringify({ jobs: [{ id: 'job-from-old-process', owner: 'ungated', status: 'done', createdAt: Date.now(), httpStatus: 200, body: { content: [{ type: 'text', text: 'restored' }] } }] }));
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        MAX_API_KEY: 'test-key',
        MAX_WORKUPS_FILE: path.join(dir, 'max-workups.json'),
        MAX_USAGE_FILE: path.join(dir, 'max-usage.json'),
        SEP_REFRESH_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      const base = `http://127.0.0.1:${port}`;
      let up = false;
      for (let i = 0; i < 100 && !up; i += 1) {
        try { up = (await fetch(`${base}/health`)).ok; } catch (_) { await sleep(100); }
      }
      assert.ok(up, `server did not start:\n${logs}`);
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.draining, false);
      const job = await (await fetch(`${base}/chat/jobs/job-from-old-process`, { headers: { 'x-max-api-key': 'test-key' } })).json();
      assert.equal(job.job.status, 'done');
      assert.equal(job.job.body.content[0].text, 'restored');
      assert.equal(fs.existsSync(handoff), false);

      child.kill('SIGTERM');
      const { code } = await exited;
      assert.equal(code, 0, logs);
      assert.match(logs, /\[shutdown\] SIGTERM/);
      assert.match(logs, /drained after \d+ms; handed off 1 answer/);
      assert.ok(fs.existsSync(handoff), 'hand-off written for the next process');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
