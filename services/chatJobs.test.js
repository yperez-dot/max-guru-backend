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
