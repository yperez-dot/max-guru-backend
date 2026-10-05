/**
 * Client Comparison mode — no chat model in the loop.
 * POST /compare/parse  { text }            → fields parsed from the agent's ask
 * POST /compare/jobs   { clientName, zip, doctors[], meds[], plans[], … } → { job }
 * GET  /compare/jobs/:id                    → { job } (poll for progress / result)
 */
const { Router } = require('express');
const { parseCompareAsk, createJob, getJob, publicJob } = require('../services/compareJobs');

function createCompareRouter(deps) {
  const router = Router();

  router.post('/parse', (req, res) => {
    const text = String((req.body && req.body.text) || '');
    if (!text.trim()) return res.status(400).json({ error: 'Paste the client ask first.' });
    return res.json({ ok: true, fields: parseCompareAsk(text) });
  });

  router.post('/jobs', (req, res) => {
    try {
      const job = createJob(req.body, req.accessEmail || '', deps);
      return res.status(202).json({ ok: true, job: publicJob(job) });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message || 'Could not start the comparison.' });
    }
  });

  router.get('/jobs/:id', (req, res) => {
    const job = getJob(req.params.id, req.accessEmail || '');
    if (!job) return res.status(404).json({ error: 'Comparison not found (it may have expired — run it again).' });
    return res.json({ ok: true, job: publicJob(job) });
  });

  return router;
}

module.exports = createCompareRouter();
module.exports.createCompareRouter = createCompareRouter;
