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
const fs     = require('fs');
const path   = require('path');
const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const NPI_REGISTRY_BASE = 'https://npiregistry.cms.hhs.gov/api/';
const FETCH_TIMEOUT_MS  = 12_000;
const SUNFIRE_BASE      = 'https://www.sunfirematrix.com';

// ─── Sunfire Plan Map (internal ID → plan name / carrier) ────────────────────
// Built 2026-07-23 by intercepting Sunfire's own plan-list API (303 plans).
let SUNFIRE_PLAN_MAP = {};
try {
  const mapPath = path.join(__dirname, '../services/sunfire-id-map.json');
  SUNFIRE_PLAN_MAP = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  console.log(`[providerLookup] Sunfire plan map loaded: ${Object.keys(SUNFIRE_PLAN_MAP).length} plans`);
} catch (err) {
  console.warn('[providerLookup] Sunfire plan map not found — Sunfire lookups will return raw IDs:', err.message);
}

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
    name:      'HealthSun',
    shortName: 'HealthSun',
    key:       'healthsun',
    fhirBase:  'https://api.aaneelconnect.com/cms/r4/providerdirectory',
    extraParams: 'payer-id=8d4e5e9ec9c64b1a9db68fbec4bd6f95',
    headers:   { Accept: 'application/fhir+json' },
  },
  {
    name:      'Devoted Health',
    shortName: 'Devoted',
    key:       'devoted',
    fhirBase:  'https://fhir.devoted.com/r4',
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

  // ── Step 2: Query FHIR carriers + Sunfire for each NPI (all in parallel) ──
  const providers = [];

  // Derive county FIPS from zip (default Miami-Dade 12086; expand later)
  const COUNTY_BY_ZIP = { /* key zips → FIPS */
    '33196': '12086', '33186': '12086', '33176': '12086', '33183': '12086',
    '33015': '12086', '33012': '12086', '33145': '12086', '33126': '12086',
    '33010': '12086', '33054': '12086', '33166': '12086', '33174': '12086',
    // Broward
    '33004': '12011', '33009': '12011', '33019': '12011', '33021': '12011',
    '33060': '12011', '33064': '12011', '33312': '12011', '33317': '12011',
    '33328': '12011', '33334': '12011',
  };
  const county = COUNTY_BY_ZIP[zip] || '12086';

  for (const npiResult of npiResults) {
    const npi = npiResult.number;
    if (!npi) continue;

    // Run FHIR carriers + Sunfire in parallel
    const [flblueResult, cignaResult, devotedResult, sunfirePlans] = await Promise.all([
      ...CARRIERS.map(carrier => queryCarrier(carrier, npi)),
      querySunfire(npi, zip, county),
    ]);

    const inNetworkFor    = [];
    const carriersWithErrors = [];

    for (const result of [flblueResult, cignaResult, devotedResult]) {
      if (result.error) {
        carriersWithErrors.push(result.carrier);
      } else if (result.plans.length) {
        inNetworkFor.push(...result.plans);
      }
    }

    // Merge Sunfire results (deduplicate against FHIR results)
    for (const plan of sunfirePlans) {
      if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
    }

    providers.push({
      name:      getDisplayName(npiResult),
      npi,
      specialty: getSpecialty(npiResult),
      address:   getLocationAddress(npiResult),
      phone:     getPhone(npiResult),
      inNetworkFor,
      sunfirePlansCount:  sunfirePlans.length,
      carriersChecked:    [...CARRIERS.map(c => c.name), 'Sunfire (UHC, Humana, WellCare, CarePlus, HealthSun + more)'],
      carriersWithErrors: carriersWithErrors.length ? carriersWithErrors : undefined,
    });
  }

  return res.json({
    providers,
    meta: {
      query:           { doctorName, zip, state },
      npiResultCount:  npiResults.length,
      carriersQueried: [...CARRIERS.map(c => c.name), 'Sunfire'],
      sunfirePlanMapSize: Object.keys(SUNFIRE_PLAN_MAP).length,
      note: 'FHIR: FL Blue, Cigna, Devoted, HealthSun. Sunfire: UHC, Humana, WellCare, CarePlus, HealthSun + all FL MA carriers.',
      timestamp: new Date().toISOString(),
    },
  });
});

// ─── Sunfire Provider Lookup ─────────────────────────────────────────────────

/**
 * Query Sunfire /v2/provider/list for a given NPI.
 * Returns array of plan name strings the doctor is in-network for.
 * Requires SUNFIRE_JWT and SUNFIRE_SFP env vars (auto-refreshed weekly via cron).
 */
async function querySunfire(npi, zip, county = '12086') {
  const jwt = process.env.SUNFIRE_JWT;
  const sfp = process.env.SUNFIRE_SFP;

  if (!jwt || !sfp) {
    console.warn('[sunfire] Missing SUNFIRE_JWT or SUNFIRE_SFP — skipping Sunfire lookup');
    return [];
  }

  const body = {
    type: 'network',
    county,
    providers: [{
      id: npi,
      name: npi,
      firstName: '',
      radius: 15,
      address: { state: 'FL', zip },
      locations: [{ npi, selected: true }],
      primaryDoctor: true,
    }],
    restrictedProviderCarrierId: '',
    year: 2026,
    zip,
  };

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const res = await fetch(`${SUNFIRE_BASE}/v2/provider/list`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Cookie':        `sfp-cookie=${sfp}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      console.warn(`[sunfire] provider/list HTTP ${res.status}`);
      return [];
    }

    const data  = await res.json();
    const plans = Array.isArray(data) ? data : (data.plans || []);

    const inNetwork = [];
    for (const plan of plans) {
      const covered = (plan.doctorInformation || []).some(di =>
        (di.locations || []).some(loc => loc.covered === 'Y')
      );
      if (!covered) continue;

      const id      = String(plan.id);
      const mapEntry = SUNFIRE_PLAN_MAP[id];
      if (mapEntry) {
        const label = mapEntry.planName
          ? `${mapEntry.planName} — ${mapEntry.carrier}`.trim()
          : mapEntry.carrier || `Sunfire plan ${id}`;
        inNetwork.push(label);
      } else {
        inNetwork.push(`Plan ID ${id}`);
      }
    }

    console.log(`[sunfire] NPI ${npi}: ${inNetwork.length} in-network plans`);
    return inNetwork;
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[sunfire] provider/list error: ${label}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = router;
