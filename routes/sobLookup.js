/**
 * GET /sob-lookup?planId=H1036-054C&benefits=hearing_aids,skilled_nursing,dme
 * Optional: sobUrl=  planIds=  query=
 *
 * Grid green cells first, then that plan's Summary of Benefits PDF.
 * Never invents dollars. Unverified if the SOB cannot be read.
 */
const { Router } = require('express');
const { lookupSobBenefits, formatSobLookupText, toExportSobBenefits } = require('../services/sobLookup');

const router = Router();

router.get('/', async (req, res) => {
  const planIds = []
    .concat(req.query.planId || [])
    .concat(req.query.planIds ? String(req.query.planIds).split(',') : [])
    .map((id) => String(id).trim())
    .filter(Boolean);
  const benefits = req.query.benefits ? String(req.query.benefits).split(',') : [];
  if (!planIds.length && !req.query.sobUrl) {
    return res.status(400).json({ error: 'planId or sobUrl required' });
  }
  try {
    const result = await lookupSobBenefits({
      planIds,
      sobUrl: req.query.sobUrl,
      benefits,
      query: req.query.query,
      year: req.query.year ? Number(req.query.year) : 2027,
    });
    res.json({
      year: result.year,
      text: formatSobLookupText(result),
      sobBenefits: toExportSobBenefits(result),
      lookups: result.lookups,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
