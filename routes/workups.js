/**
 * Client workups API — structured comparison state per unlock email.
 * GET    /workups
 * GET    /workups/:id
 * PUT    /workups
 * PUT    /workups/:id
 * DELETE /workups/:id
 */
const { Router } = require('express');
const { createWorkupStore } = require('../services/workups');

function createWorkupsRouter(store) {
  const router = Router();
  const getStore = () => store || createWorkupStore();

  function ownerOf(req) {
    return req.accessEmail || '';
  }

  router.get('/', (req, res) => {
    const email = ownerOf(req);
    if (!email) return res.status(401).json({ error: 'Access locked', code: 'access_required' });
    return res.json({ ok: true, workups: getStore().list(email) });
  });

  router.get('/:id', (req, res) => {
    const email = ownerOf(req);
    if (!email) return res.status(401).json({ error: 'Access locked', code: 'access_required' });
    const workup = getStore().get(email, req.params.id);
    if (!workup) return res.status(404).json({ error: 'Workup not found' });
    return res.json({ ok: true, workup });
  });

  function upsert(req, res) {
    const email = ownerOf(req);
    if (!email) return res.status(401).json({ error: 'Access locked', code: 'access_required' });
    const body = { ...(req.body && typeof req.body === 'object' ? req.body : {}) };
    delete body.ownerEmail;
    delete body.messages;
    delete body.history;
    delete body.transcript;
    delete body.conversation;
    if (req.params && req.params.id) body.id = req.params.id;
    const planCount = Array.isArray(body.plans) ? body.plans.length : 0;
    if (!String(body.clientName || '').trim() && planCount < 2) {
      return res.status(400).json({ error: 'Need a client name or 2+ plans to save a workup' });
    }
    try {
      const workup = getStore().upsert(email, body);
      return res.json({ ok: true, workup });
    } catch (err) {
      const status = err.status && Number.isInteger(err.status) ? err.status : 400;
      return res.status(status).json({ error: err.message || 'Could not save workup', code: err.code });
    }
  }

  router.put('/', upsert);
  router.put('/:id', upsert);
  router.post('/', upsert);

  router.delete('/:id', (req, res) => {
    const email = ownerOf(req);
    if (!email) return res.status(401).json({ error: 'Access locked', code: 'access_required' });
    const ok = getStore().delete(email, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Workup not found' });
    return res.json({ ok: true, deleted: req.params.id });
  });

  return router;
}

module.exports = createWorkupsRouter();
module.exports.createWorkupsRouter = createWorkupsRouter;
