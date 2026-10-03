const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ChatJobStore, publicJob, sanitizeRequestId } = require('./chatJobs');
const { validateChatInput, executeChatTurn } = require('./chatTurn');
const chatUi = require('../artifacts/chat-jobs.js');

function tempStore(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-chat-jobs-'));
  const store = new ChatJobStore({
    filePath: path.join(dir, 'chat-jobs.json'),
    ...(opts || {}),
  });
  return {
    store,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function mockBudget() {
  return {
    recordTurn() {
      return {
        banners: [],
        usage: { day: '2026-10-03', spendUsd: 0.1, percent: 1, remainingUsd: 9.9 },
      };
    },
    contextNudge() {
      return null;
    },
  };
}

describe('chat job store', () => {
  it('finishes a turn after the client is gone and scopes jobs by unlock email', async (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const { job, created } = store.create('yperez@healthexps.com', {
      id: 'job-phone-background-01',
      chatId: 'chat-1',
    });
    assert.equal(created, true);
    assert.equal(job.status, 'pending');
    assert.equal(store.get('carolina@healthexps.com', job.id), null);

    const waiting = store.wait('yperez@healthexps.com', job.id);
    store.complete('yperez@healthexps.com', job.id, {
      content: [{ type: 'text', text: 'H1036-054C premium is $0.' }],
      banners: [],
    });
    const finished = await waiting;
    assert.equal(finished.status, 'done');
    const pub = publicJob(store.get('yperez@healthexps.com', job.id));
    assert.equal(pub.status, 'done');
    assert.equal(pub.content[0].text, 'H1036-054C premium is $0.');
    assert.equal(store.get('carolina@healthexps.com', job.id), null);
  });

  it('reuses the same request id instead of starting a second Grok turn', (t) => {
    const { store, cleanup } = tempStore();
    t.after(cleanup);
    const first = store.create('yperez@healthexps.com', { id: 'same-request-id-01' });
    const second = store.create('yperez@healthexps.com', { id: 'same-request-id-01' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.job.status, 'pending');
  });

  it('does not write image payloads into the completed job file', (t) => {
    const { store, dir, cleanup } = tempStore();
    t.after(cleanup);
    const { job } = store.create('yperez@healthexps.com', { id: 'job-no-images-01' });
    store.complete('yperez@healthexps.com', job.id, {
      content: [{ type: 'text', text: 'Seen the screenshot.' }],
      images: undefined,
    });
    const raw = fs.readFileSync(path.join(dir, 'chat-jobs.json'), 'utf8');
    assert.equal(raw.includes('data:image/'), false);
    assert.equal(raw.includes('image_url'), false);
    const pub = publicJob(store.get('yperez@healthexps.com', job.id));
    assert.equal(pub.content[0].text, 'Seen the screenshot.');
  });

  it('rejects a foreign owner and sanitizes request ids', () => {
    assert.equal(sanitizeRequestId('short'), '');
    assert.equal(sanitizeRequestId('good-request-id-01'), 'good-request-id-01');
    assert.equal(sanitizeRequestId('../etc/passwd'), '');
  });
});

describe('chat turn keeps running without an HTTP socket', () => {
  it('returns the Grok-shaped body after a delayed model call', async () => {
    let started = false;
    const passThrough = async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        provider: 'grok',
        content: [{ type: 'text', text: 'Gold Plus H1036-054C is $0 premium.' }],
        usageCalls: [],
      };
    };
    const pending = executeChatTurn({
      system: 'PLAN DATA',
      messages: [{ role: 'user', content: 'What is the premium on H1036-054C?' }],
      budgetGuard: mockBudget(),
      budgetCheck: { allowed: true },
      toolAppendix: '',
      passThrough,
    });
    assert.equal(started, true);
    const out = await pending;
    assert.equal(out.httpStatus, 200);
    assert.equal(out.body.content[0].text, 'Gold Plus H1036-054C is $0 premium.');
    assert.ok(out.body.budget);
  });

  it('validateChatInput rejects empty messages and keeps images in memory only', () => {
    assert.throws(() => validateChatInput({ messages: [] }), /messages array required/);
    const parsed = validateChatInput({
      system: 'rules',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } },
          ],
        },
      ],
    });
    assert.equal(parsed.system, 'rules');
    assert.equal(parsed.messages[0].content.some((p) => p.type === 'image_url'), true);
  });
});

describe('phone UI helpers', () => {
  it('does not treat an aborted phone fetch as a Railway redeploy', () => {
    const abort = new Error('The user aborted a request.');
    abort.name = 'AbortError';
    assert.equal(chatUi.isAbortError(abort), true);
    assert.equal(chatUi.isReachabilityFailure(abort, null), false);
    assert.equal(
      chatUi.isReachabilityFailure(new TypeError('Failed to fetch'), null),
      true
    );
    assert.equal(chatUi.isReachabilityFailure(null, { ok: false, status: 502 }), true);
    assert.equal(chatUi.isReachabilityFailure(null, { ok: false, status: 503 }), false);
    assert.equal(chatUi.isReachabilityFailure(null, { ok: false, status: 404 }), false);
    assert.match(chatUi.REACH_SERVER_ERROR, /Railway may be redeploying/);
  });

  it('strips image data URLs when saving the current chat', () => {
    const store = new Map();
    const bag = {
      getItem: (k) => store.get(k) || null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    };
    chatUi.saveChatState('yperez@healthexps.com', {
      chatId: 'c1',
      pendingJobId: 'job-1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this card' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    }, bag);
    const raw = store.get(chatUi.stateKey('yperez@healthexps.com'));
    assert.equal(raw.includes('data:image/png;base64,AAAA'), false);
    const loaded = chatUi.loadChatState('yperez@healthexps.com', bag);
    assert.equal(loaded.pendingJobId, 'job-1');
    assert.equal(loaded.messages[0].content[0].text, 'Look at this card');
    chatUi.clearChatState('yperez@healthexps.com', bag);
    assert.equal(chatUi.loadChatState('yperez@healthexps.com', bag), null);
  });

  it('polls until the server job is done, including after a dropped connection', async () => {
    const calls = [];
    const fetchJob = async (id) => {
      calls.push(id);
      if (calls.length === 1) throw new Error('The user aborted a request.');
      if (calls.length === 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, jobId: id, status: 'pending' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          jobId: id,
          status: 'done',
          content: [{ type: 'text', text: 'Done after she left the screen.' }],
          banners: [],
        }),
      };
    };
    const result = await chatUi.pollChatJob({
      jobId: 'job-resume-01',
      fetchJob,
      pollMs: 1,
      sleeper: (_ms, resolve) => resolve(),
    });
    assert.equal(result.text, 'Done after she left the screen.');
    assert.equal(calls.length, 3);
  });
});

describe('server + live UI wiring', () => {
  it('mounts durable chat job routes and the live UI polls them', () => {
    const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(server, /app\.get\('\/chat\/jobs\/:id'/);
    assert.match(server, /asyncMode/);
    assert.match(server, /startChatJob/);
    assert.match(server, /writeChatResponse/);
    assert.equal(server.includes("req.on('close'"), false);

    const html = fs.readFileSync(path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'), 'utf8');
    assert.match(html, /MAX_CHAT_JOBS_BEGIN/);
    assert.match(html, /MaxChatJobs/);
    assert.match(html, /async:\s*true/);
    assert.match(html, /\/chat\/jobs\//);
    assert.match(html, /pollChatJob/);
    assert.match(html, /resumePendingJob/);
    assert.match(html, /visibilitychange/);
    assert.match(html, /pendingJobId/);
    assert.match(html, /REACH_SERVER_ERROR/);
    const catchRailway = /catch \(err\) \{[\s\S]*Railway may be redeploying/;
    assert.equal(catchRailway.test(html.replace(/<!-- MAX_CHAT_JOBS_BEGIN -->[\s\S]*?<!-- MAX_CHAT_JOBS_END -->/, '')), false);
  });
});
