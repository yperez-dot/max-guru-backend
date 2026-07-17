/**
 * routes/providerLookup.js
 *
 * POST /provider-lookup
 *
 * Given a doctor's name + Florida zip code, returns which Medicare Advantage
 * plans they are in-network for, querying three open FHIR provider directories.
 *
 * Carriers with open, no-auth FHIR endpoints (as of 2026-07-17 probe):
 *   1. Florida Blue (BCBS FL)  – BlueMedicare PPO/HMO plans
 *   2. Cigna                   – Florida MA plans
 *   3. Devoted Health (H1290)  – Florida HMO plans
 *
 * Aetna, Humana, UHC, and others require developer-portal registration.
 */

const { Router } = require('express');
const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const NPI_REGISTRY_BASE = 'https://npiregistry.cms.hhs.gov/api/';
const FETCH_TIMEOUT_MS  = 12_000;

/**
 * The three FHIR-open FL MA carriers.
 * All implement Da Vinci PDex Plan Net IG (FHIR R4).
 * Source: fhir-provider-directory-test-results.md (probe 2026-07-17)
 */
const CARRIERS = [
  {
    name:      'Florida Blue',
    shortName: 'FL Blue',
    key:       'flblue',
    fhirBase:  'https://apigw.bcbsfl.com/interop/interop-developer-portal/emr/api/v1/fhir',
    headers:   { Accept: 'application/fhir+json' },
  },
  {
    name:      'Cigna',
    shortName: 'Cigna',
    key:       'cigna',
    fhirBase:  'https://fhir.cigna.com/ProviderDirectory/v1',
    headers:   { Accept: 'application/fhir+json' },
  },
  {
    name:      'Devoted Health',
    shortName: 'Devoted',
    key:       'devoted',
    fhirBase:  'https://fhir.devoted.com/fhir',
    headers:   { Accept: 'application/fhir+json' },
  },
];

/**
 * Static map: known FL MA network code → friendly plan name.
 * These codes are returned as Organization IDs inside PractitionerRole bundles.
 * Sourced from FHIR endpoint probe on 2026-07-17 using test NPI 1306409339.
 *
 * If a code is missing, we fall back to resolving the Organization resource
 * inline (via _include) or label it "Carrier – <raw code>".
 */
const FL_MA_NETWORK_DISPLAY = {
  // Florida Blue – BlueMedicare (MA) networks
  'BMP-2026':   'FL Blue – BlueMedicare PPO',
  'MAHMO-2026': 'FL Blue – BlueMedicare HMO',
  'NCA-2026':   'FL Blue – BlueMedicare Select PPO',
  'NWB-2026':   'FL Blue – BlueOptions PPO',
  'PPC-2026':   'FL Blue – BlueCross Health Plan PPO',
  // Cigna – Florida networks (MA + commercial)
  'FL305':  'Cigna – FL OAP Direct',
  'FL710':  'Cigna – FL PPO Direct',
  'FL171':  'Cigna – S. FL SureFit Local PCP Network',
  'VF401':  'Cigna – FL HMO Connect (Baptist Physicians)',
  'FL307':  'Cigna – S. FL LocalPlus Direct',
  'FL193':  'Cigna – FL Connect (Baptist Physicians)',
  'FL9CB':  'Cigna – FL OAP CSN',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Fetch with timeout; returns parsed JSON or null on any error. */
async function fetchJSON(url, options = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      console.warn(`[providerLookup] HTTP ${res.status} – ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[providerLookup] ${label} – ${url}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a full name string into { firstName, lastName }.
 * Handles:
 *   "John Smith"         → first=John last=Smith
 *   "Smith, John"        → first=John last=Smith
 *   "John A. Smith MD"   → first=John last=Smith (credential stripped)
 */
function parseName(fullName) {
  if (!fullName || typeof fullName !== 'string') return {};
  // Strip trailing credentials (MD, DO, NP, PA, etc.)
  const cleaned = fullName.replace(/,?\s+(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD)\.?$/i, '').trim();

  // "Last, First [Middle]" format
  if (cleaned.includes(',')) {
    const commaIdx = cleaned.indexOf(',');
    const last  = cleaned.slice(0, commaIdx).trim();
    const first = cleaned.slice(commaIdx + 1).trim().split(/\s+/)[0];
    return { firstName: first, lastName: last };
  }

  // "First [Middle] Last" – take first and last tokens
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { lastName: parts[0] };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/** Extract the terminal ID segment from a FHIR reference string. */
function extractResourceId(reference) {
  if (!reference) return null;
  const parts = reference.split('/');
  // Handle absolute URL: find "Organization" position
  const orgIdx = parts.lastIndexOf('Organization');
  if (orgIdx !== -1 && parts[orgIdx + 1]) return parts[orgIdx + 1];
  return parts[parts.length - 1];
}

/** Format an NPI address object into a human-readable string. */
function formatAddress(addr) {
  if (!addr) return null;
  return [
    addr.address_1,
    addr.address_2,
    addr.city,
    addr.state,
    addr.postal_code?.slice(0, 5),
  ].filter(Boolean).join(', ');
}

/** Pull the best LOCATION address from an NPI result record. */
function getLocationAddress(result) {
  const addrs = result.addresses || [];
  const loc = addrs.find(a => a.address_purpose === 'LOCATION') || addrs[0];
  return loc ? formatAddress(loc) : null;
}

/** Pull the primary taxonomy description from an NPI result record. */
function getSpecialty(result) {
  const taxs = result.taxonomies || [];
  return (taxs.find(t => t.primary === true) || taxs[0])?.desc || null;
}

/** Build a full display name from an NPI result record. */
function getDisplayName(result) {
  const b = result.basic || {};
  return [b.first_name, b.middle_name, b.last_name, b.credential]
    .filter(Boolean)
    .join(' ');
}

/** Get phone from NPI result record. */
function getPhone(result) {
  const addrs = result.addresses || [];
  return addrs.find(a => a.telephone_number)?.telephone_number || null;
}

// ─── NPI Registry Query ───────────────────────────────────────────────────────

/**
 * Query the CMS NPI Registry for individual providers (NPI-1).
 * First attempt uses zip code; if that returns nothing, retries without zip
 * (some providers list a different address on record).
 */
async function lookupNPIs({ firstName, lastName, state = 'FL', zip, limit = 5 }) {
  const buildUrl = (includeZip) => {
    const p = new URLSearchParams({
      version:          '2.1',
      enumeration_type: 'NPI-1',
      state,
      limit:            String(limit),
    });
    if (firstName) p.set('first_name', firstName);
    if (lastName)  p.set('last_name', lastName);
    if (includeZip && zip) p.set('postal_code', zip);
    return `${NPI_REGISTRY_BASE}?${p}`;
  };

  // First pass: include zip
  let url  = buildUrl(true);
  let data = await fetchJSON(url);
  let results = data?.results || [];

  // Second pass: drop zip if no results
  if (!results.length && zip) {
    console.log('[providerLookup] No NPI results with zip — retrying without');
    url     = buildUrl(false);
    data    = await fetchJSON(url);
    results = data?.results || [];
  }

  return results;
}

// ─── FHIR Carrier Query ───────────────────────────────────────────────────────

/**
 * Parse network affiliations from a FHIR Bundle (PractitionerRole response).
 *
 * PDex Plan Net networks are referenced via one of:
 *   (a) extension[url*="network-reference"].valueReference.reference
 *   (b) PractitionerRole.network[].reference    (some implementations)
 *   (c) Inline Organization resources from _include=PractitionerRole:network
 *
 * Returns array of human-readable plan/network strings.
 */
function parseNetworkNames(bundle, carrierKey) {
  if (!bundle || bundle.resourceType !== 'Bundle') return [];

  const entries = bundle.entry || [];

  // Build id→name map from any Organization resources _include'd in the bundle
  const orgNames = {};
  for (const e of entries) {
    const r = e.resource || {};
    if (r.resourceType === 'Organization' && r.id) {
      orgNames[r.id] = r.name || r.id;
    }
  }

  const networkIds = new Set();

  for (const e of entries) {
    const r = e.resource || {};
    if (r.resourceType !== 'PractitionerRole') continue;

    // (a) PDex Plan Net extension
    for (const ext of (r.extension || [])) {
      if (ext.url?.includes('network-reference') && ext.valueReference?.reference) {
        const id = extractResourceId(ext.valueReference.reference);
        if (id) networkIds.add(id);
      }
    }

    // (b) Direct .network[] array
    for (const net of (r.network || [])) {
      if (net.reference) {
        const id = extractResourceId(net.reference);
        if (id) networkIds.add(id);
      }
    }

    // (c) .organization reference (fallback, catches some implementations)
    if (r.organization?.reference) {
      const id = extractResourceId(r.organization.reference);
      if (id) networkIds.add(id);
    }
  }

  const carrierShort = CARRIERS.find(c => c.key === carrierKey)?.shortName || carrierKey;

  return Array.from(networkIds).map(id => {
    if (FL_MA_NETWORK_DISPLAY[id])  return FL_MA_NETWORK_DISPLAY[id];  // static map
    if (orgNames[id])               return orgNames[id];                // inline org
    return `${carrierShort} – ${id}`;                                   // raw fallback
  });
}

/** Query a single carrier's FHIR endpoint for a given NPI. */
async function queryCarrier(carrier, npi) {
  // Request _include to get Organization names inline (avoids extra round-trips)
  const url = `${carrier.fhirBase}/PractitionerRole`
            + `?practitioner.identifier=${encodeURIComponent(npi)}`
            + `&_include=PractitionerRole%3Anetwork`;

  console.log(`[providerLookup] ${carrier.name} → ${url}`);

  const bundle = await fetchJSON(url, { headers: carrier.headers });
  if (!bundle) {
    return { carrier: carrier.name, plans: [], error: 'request_failed' };
  }

  const plans = parseNetworkNames(bundle, carrier.key);
  return { carrier: carrier.name, plans, error: null };
}

// ─── Route Handler ────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { doctorName, zip, state = 'FL' } = req.body || {};

  // ── Input validation ──
  if (!doctorName || typeof doctorName !== 'string') {
    return res.status(400).json({ error: 'doctorName (string) is required' });
  }
  if (!zip || typeof zip !== 'string') {
    return res.status(400).json({ error: 'zip (string) is required' });
  }

  const { firstName, lastName } = parseName(doctorName);
  if (!lastName) {
    return res.status(400).json({ error: 'Could not parse last name from doctorName' });
  }

  console.log(`[providerLookup] "${doctorName}" → first="${firstName}" last="${lastName}" zip=${zip} state=${state}`);

  // ── Step 1: CMS NPI Registry lookup ──
  let npiResults;
  try {
    npiResults = await lookupNPIs({ firstName, lastName, state, zip });
  } catch (err) {
    console.error('[providerLookup] NPI lookup threw:', err.message);
    return res.status(502).json({ error: 'NPI registry lookup failed', detail: err.message });
  }

  if (!npiResults.length) {
    return res.json({
      providers: [],
      meta: {
        query:     { doctorName, zip, state },
        message:   `No NPI-1 providers found matching "${doctorName}" in ${state}`,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // ── Step 2: Query all 3 carriers for each NPI (carriers run in parallel) ──
  const providers = [];

  for (const npiResult of npiResults) {
    const npi = npiResult.number;
    if (!npi) continue;

    const [flblueResult, cignaResult, devotedResult] = await Promise.all(
      CARRIERS.map(carrier => queryCarrier(carrier, npi))
    );

    const inNetworkFor    = [];
    const carriersWithErrors = [];

    for (const result of [flblueResult, cignaResult, devotedResult]) {
      if (result.error) {
        carriersWithErrors.push(result.carrier);
      } else if (result.plans.length) {
        inNetworkFor.push(...result.plans);
      }
    }

    providers.push({
      name:     getDisplayName(npiResult),
      npi,
      specialty: getSpecialty(npiResult),
      address:  getLocationAddress(npiResult),
      phone:    getPhone(npiResult),
      inNetworkFor,
      carriersChecked:    CARRIERS.map(c => c.name),
      carriersWithErrors: carriersWithErrors.length ? carriersWithErrors : undefined,
    });
  }

  return res.json({
    providers,
    meta: {
      query:           { doctorName, zip, state },
      npiResultCount:  npiResults.length,
      carriersQueried: CARRIERS.map(c => c.name),
      note: 'Only FL Blue, Cigna, and Devoted Health have open FHIR endpoints. '
          + 'Aetna, Humana, UHC, and others require developer-portal registration.',
      timestamp: new Date().toISOString(),
    },
  });
});

module.exports = router;
