/**
 * GET /drug-search?name=metformin
 * Searches Sunfire drug catalog by name prefix.
 */

const { Router } = require('express');
const { sunfireAuthorizationHeader } = require('../services/sunfireAuth');

const router = Router();
const SUNFIRE_BASE = 'https://www.sunfirematrix.com';

router.get('/', async (req, res) => {
  const { name } = req.query;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'name query param required (min 2 chars)' });
  }

  const auth = sunfireAuthorizationHeader();
  if (!auth) {
    return res.status(503).json({ error: 'Sunfire credentials not configured' });
  }

  const prefix = encodeURIComponent(name.trim().toLowerCase().slice(0, 40));
  const url = `${SUNFIRE_BASE}/v2/drug/search/${prefix}/-1`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Sunfire drug search failed' });
    }

    const data = await response.json();
    const drugs = data.drugs || [];

    res.json({
      query: name.trim(),
      count: drugs.length,
      drugs: drugs.slice(0, 50).map(d => ({
        id: d.id,
        name: d.name,
        ndc: d.ndc,
        genericId: d.genericId,
      })),
    });
  } catch (err) {
    console.error('[drugLookup] failed:', err.message);
    res.status(500).json({ error: 'Drug search failed' });
  }
});

module.exports = router;
