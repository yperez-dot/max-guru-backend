/**
 * POST /provider-lookup
 * Body: { doctorName, zip, state? }
 */

const { Router } = require('express');
const { lookupProviderNetwork } = require('../services/providerNetwork');

const router = Router();

router.post('/', async (req, res) => {
  const { doctorName, zip, state = 'FL' } = req.body || {};

  if (!doctorName || typeof doctorName !== 'string') {
    return res.status(400).json({ error: 'doctorName (string) is required' });
  }
  if (!zip || typeof zip !== 'string') {
    return res.status(400).json({ error: 'zip (string) is required' });
  }

  try {
    const result = await lookupProviderNetwork({ doctorName, zip, state });
    return res.json({
      providers: result.providers,
      meta: result.meta,
    });
  } catch (err) {
    console.error('[providerLookup] failed:', err.message);
    return res.status(502).json({ error: 'Provider lookup failed' });
  }
});

module.exports = router;
