/**
 * GET /formulary-lookup?name=trintellix&planId=H1036-054C&year=2027
 * Optional: planIds=H1036-054C,H1036-305  ndc=  claimedTier=
 *
 * Live formulary tier (Sunfire / Humana FHIR). Client-stated claimedTier is ignored.
 */
const { Router } = require('express');
const { lookupFormulary, formatFormularyText, toExportDrug } = require('../services/formularyLookup');

const router = Router();

router.get('/', async (req, res) => {
  const name = String(req.query.name || req.query.drugName || '').trim();
  if (name.length < 2) {
    return res.status(400).json({ error: 'name query param required (min 2 chars)' });
  }
  const planIds = []
    .concat(req.query.planId || [])
    .concat(req.query.planIds ? String(req.query.planIds).split(',') : [])
    .map((id) => String(id).trim())
    .filter(Boolean);
  try {
    const result = await lookupFormulary({
      drugName: name,
      ndc: req.query.ndc,
      planIds,
      year: req.query.year ? Number(req.query.year) : 2027,
      claimedTier: req.query.claimedTier,
    });
    res.json({
      query: name,
      year: result.year,
      claimedTierIgnored: result.claimedTier,
      text: formatFormularyText(result),
      drug: toExportDrug(result),
      lookups: result.lookups,
      catalog: result.catalog,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
