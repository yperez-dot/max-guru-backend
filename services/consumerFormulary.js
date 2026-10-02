/**
 * Pluggable carrier-consumer formulary sources.
 *
 * Used after Sunfire, Humana FHIR (Humana CMS IDs only), and medicare.gov
 * Plan Compare have failed. These are public consumer documents — never a
 * member portal, never an undocumented JS widget, never Daisy/paste labels.
 *
 * Source interface (add a module + push onto CONSUMER_SOURCES):
 *   {
 *     id: string,                    // e.g. 'doctors'
 *     source: string,                // label on verified rows, e.g. 'doctors_formulary_pdf'
 *     matchesPlan(planId, year): boolean
 *     lookup({ drugName, ndc, planId, year }, fetchImpl): Promise<Hit>
 *   }
 *
 * Hit (same shape the live chain already understands):
 *   verified: boolean
 *   coverage: 'covered' | 'not_covered' | null
 *   tier: 1-6 | null
 *   pa / st / ql: boolean | null
 *   source: string
 *   reason?: string                 // when unverified
 *   formularyPlanId?: string        // mapped 2027 PBP when remapped
 *   note?: string
 *
 * Never invent a tier. If the public document does not yield a parsed row,
 * return verified:false.
 *
 * Implemented: Doctors HealthCare Plans (H4140) 2027 formulary PDF.
 *
 * TODO: UHC / CarePlus / Solis / Wellcare / Florida Blue — no trusted public
 * 2027 formulary PDF URL is on file in repo knowledge (carrier-lookup-urls
 * still points at 2026 guides or member portals). Add a source here when a
 * consumer PDF is confirmed. Do not scrape myAARPMedicare / MyCarePlus /
 * interactive search widgets.
 */

const doctors = require('./doctorsFormularyPdf');

const CONSUMER_SOURCES = [
  {
    id: 'doctors',
    source: doctors.SOURCE_PDF,
    matchesPlan: doctors.matchesPlan,
    lookup: doctors.lookupDoctorsFormulary,
  },
];

async function lookupConsumerFormulary(
  { drugName = '', ndc = '', planId = '', year } = {},
  fetchImpl = fetch
) {
  for (const src of CONSUMER_SOURCES) {
    if (!src.matchesPlan(planId, year)) continue;
    const hit = await src.lookup({ drugName, ndc, planId, year }, fetchImpl);
    if (hit) return hit;
  }
  return { verified: false, reason: 'no_consumer_source' };
}

module.exports = {
  CONSUMER_SOURCES,
  lookupConsumerFormulary,
};
