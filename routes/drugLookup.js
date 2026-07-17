/**
 * routes/drugLookup.js
 * GET /drug-search?name=metformin
 * Searches Sunfire drug catalog by name prefix.
 * Returns matching drugs with id, name, ndc.
 */

const { Router } = require('express');
const router = Router();

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const SUNFIRE_JWT = process.env.SUNFIRE_JWT;

router.get('/', async (req, res) => {
  const { name } = req.query;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'name query param required (min 2 chars)' });
  }

  const prefix = encodeURIComponent(name.trim().toLowerCase());
  const url = `${SUNFIRE_BASE}/v2/drug/search/${prefix}/-1`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: SUNFIRE_JWT,
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
      drugs: drugs.map(d => ({
        id: d.id,
        name: d.name,
        ndc: d.ndc,
        genericId: d.genericId,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
