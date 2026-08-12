/**
 * Shared provider network lookup: NPI Registry → FHIR carriers → Sunfire.
 * Used by POST /provider-lookup and the lookup_provider_network chat tool.
 */

const fs = require('fs');
const path = require('path');
const {
  sunfireAuthorizationHeader,
  sunfireCookieHeader,
  hasSunfireCredentials,
} = require('./sunfireAuth');

const NPI_REGISTRY_BASE = 'https://npiregistry.cms.hhs.gov/api/';
const FETCH_TIMEOUT_MS = 12_000;
const SUNFIRE_BASE = 'https://www.sunfirematrix.com';

let SUNFIRE_PLAN_MAP = {};
try {
  const mapPath = path.join(__dirname, 'sunfire-id-map.json');
  SUNFIRE_PLAN_MAP = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  console.log(`[providerNetwork] Sunfire plan map loaded: ${Object.keys(SUNFIRE_PLAN_MAP).length} plans`);
} catch (err) {
  console.warn('[providerNetwork] Sunfire plan map not found:', err.message);
}

const CARRIERS = [
  {
    name: 'Florida Blue',
    shortName: 'FL Blue',
    key: 'flblue',
    fhirBase: 'https://apigw.bcbsfl.com/interop/interop-developer-portal/emr/api/v1/fhir',
    headers: { Accept: 'application/fhir+json' },
  },
  {
    name: 'Cigna',
    shortName: 'Cigna',
    key: 'cigna',
    fhirBase: 'https://fhir.cigna.com/ProviderDirectory/v1',
    headers: { Accept: 'application/fhir+json' },
  },
  {
    name: 'HealthSun',
    shortName: 'HealthSun',
    key: 'healthsun',
    fhirBase: 'https://api.aaneelconnect.com/cms/r4/providerdirectory',
    extraParams: 'payer-id=8d4e5e9ec9c64b1a9db68fbec4bd6f95',
    headers: { Accept: 'application/fhir+json' },
  },
  {
    name: 'Devoted Health',
    shortName: 'Devoted',
    key: 'devoted',
    fhirBase: 'https://fhir.devoted.com/r4',
    headers: { Accept: 'application/fhir+json' },
  },
];

const FL_MA_NETWORK_DISPLAY = {
  'BMP-2026': 'FL Blue – BlueMedicare PPO',
  'MAHMO-2026': 'FL Blue – BlueMedicare HMO',
  'NCA-2026': 'FL Blue – BlueMedicare Select PPO',
  'NWB-2026': 'FL Blue – BlueOptions PPO',
  'PPC-2026': 'FL Blue – BlueCross Health Plan PPO',
  FL305: 'Cigna – FL OAP Direct',
  FL710: 'Cigna – FL PPO Direct',
  FL171: 'Cigna – S. FL SureFit Local PCP Network',
  VF401: 'Cigna – FL HMO Connect (Baptist Physicians)',
  FL307: 'Cigna – S. FL LocalPlus Direct',
  FL193: 'Cigna – FL Connect (Baptist Physicians)',
  FL9CB: 'Cigna – FL OAP CSN',
};

const COUNTY_BY_ZIP = {
  '33196': '12086', '33186': '12086', '33176': '12086', '33183': '12086',
  '33015': '12086', '33012': '12086', '33145': '12086', '33126': '12086',
  '33010': '12086', '33054': '12086', '33166': '12086', '33174': '12086',
  '33136': '12086', '33125': '12086', '33130': '12086', '33135': '12086',
  '33142': '12086', '33147': '12086', '33150': '12086', '33161': '12086',
  '33168': '12086', '33169': '12086', '33172': '12086', '33175': '12086',
  '33178': '12086', '33182': '12086', '33184': '12086', '33185': '12086',
  '33193': '12086', '33194': '12086',
  '33004': '12011', '33009': '12011', '33019': '12011', '33021': '12011',
  '33060': '12011', '33064': '12011', '33312': '12011', '33317': '12011',
  '33328': '12011', '33334': '12011', '33020': '12011', '33023': '12011',
  '33024': '12011', '33025': '12011', '33026': '12011', '33027': '12011',
  '33028': '12011', '33029': '12011', '33301': '12011', '33304': '12011',
  '33305': '12011', '33306': '12011', '33308': '12011', '33309': '12011',
  '33311': '12011', '33313': '12011', '33314': '12011', '33315': '12011',
  '33316': '12011', '33319': '12011', '33321': '12011', '33322': '12011',
  '33323': '12011', '33324': '12011', '33325': '12011', '33326': '12011',
  '33327': '12011', '33330': '12011', '33331': '12011', '33332': '12011',
};

async function fetchJSON(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      console.warn(`[providerNetwork] HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[providerNetwork] ${label}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseName(fullName) {
  if (!fullName || typeof fullName !== 'string') return {};
  let cleaned = fullName
    .replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
    .replace(/,?\s+(MD|DO|NP|PA|RN|APRN|DDS|DMD|DPM|OD|DC|PharmD|PhD)\.?$/i, '')
    .trim();

  if (cleaned.includes(',')) {
    const commaIdx = cleaned.indexOf(',');
    const last = cleaned.slice(0, commaIdx).trim();
    const first = cleaned.slice(commaIdx + 1).trim().split(/\s+/)[0];
    return { firstName: first, lastName: last };
  }

  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { lastName: parts[0] };
  return { firstName: parts[0], lastName: parts[parts.length - 1], nameParts: parts };
}

function extractResourceId(reference) {
  if (!reference) return null;
  const parts = reference.split('/');
  const orgIdx = parts.lastIndexOf('Organization');
  if (orgIdx !== -1 && parts[orgIdx + 1]) return parts[orgIdx + 1];
  return parts[parts.length - 1];
}

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

function getLocationAddress(result) {
  const addrs = result.addresses || [];
  const loc = addrs.find(a => a.address_purpose === 'LOCATION') || addrs[0];
  return loc ? formatAddress(loc) : null;
}

function getSpecialty(result) {
  const taxs = result.taxonomies || [];
  return (taxs.find(t => t.primary === true) || taxs[0])?.desc || null;
}

function getDisplayName(result) {
  const b = result.basic || {};
  return [b.first_name, b.middle_name, b.last_name, b.credential]
    .filter(Boolean)
    .join(' ');
}

function getPhone(result) {
  const addrs = result.addresses || [];
  return addrs.find(a => a.telephone_number)?.telephone_number || null;
}

function countyForZip(zip) {
  const z = String(zip || '').slice(0, 14);
  return COUNTY_BY_ZIP[z] || '12086';
}

async function lookupNPIs({ firstName, lastName, state = 'FL', zip, limit = 5, nameParts }) {
  const attempts = [];
  if (lastName) attempts.push({ last: lastName, first: firstName || '' });
  if (nameParts && nameParts.length > 2) {
    attempts.push({ last: nameParts.slice(1).join(' '), first: nameParts[0] });
    attempts.push({ last: nameParts.slice(-2).join(' '), first: firstName || '' });
  }
  attempts.push({ last: lastName, first: '' });

  const seen = new Set();
  for (const attempt of attempts) {
    if (!attempt.last) continue;
    const key = `${attempt.last}|${attempt.first}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const buildUrl = (includeZip) => {
      const p = new URLSearchParams({
        version: '2.1',
        enumeration_type: 'NPI-1',
        state,
        limit: String(limit),
        last_name: attempt.last,
      });
      if (attempt.first) p.set('first_name', attempt.first);
      if (includeZip && zip) p.set('postal_code', zip);
      return `${NPI_REGISTRY_BASE}?${p}`;
    };

    let data = await fetchJSON(buildUrl(true));
    let results = data?.results || [];
    if (!results.length && zip) {
      data = await fetchJSON(buildUrl(false));
      results = data?.results || [];
    }
    if (results.length) return results;
  }
  return [];
}

function parseNetworkNames(bundle, carrierKey) {
  if (!bundle || bundle.resourceType !== 'Bundle') return [];

  const entries = bundle.entry || [];
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

    for (const ext of (r.extension || [])) {
      if (ext.url?.includes('network-reference') && ext.valueReference?.reference) {
        const id = extractResourceId(ext.valueReference.reference);
        if (id) networkIds.add(id);
      }
    }
    for (const net of (r.network || [])) {
      if (net.reference) {
        const id = extractResourceId(net.reference);
        if (id) networkIds.add(id);
      }
    }
    if (r.organization?.reference) {
      const id = extractResourceId(r.organization.reference);
      if (id) networkIds.add(id);
    }
  }

  const carrierShort = CARRIERS.find(c => c.key === carrierKey)?.shortName || carrierKey;
  return Array.from(networkIds).map(id => {
    if (FL_MA_NETWORK_DISPLAY[id]) return FL_MA_NETWORK_DISPLAY[id];
    if (orgNames[id]) return orgNames[id];
    return `${carrierShort} – ${id}`;
  });
}

async function queryCarrier(carrier, npi) {
  let url = `${carrier.fhirBase}/PractitionerRole`
    + `?practitioner.identifier=${encodeURIComponent(npi)}`
    + `&_include=PractitionerRole%3Anetwork`;
  if (carrier.extraParams) url += `&${carrier.extraParams}`;

  const bundle = await fetchJSON(url, { headers: carrier.headers });
  if (!bundle) {
    return { carrier: carrier.name, plans: [], error: 'request_failed' };
  }
  return { carrier: carrier.name, plans: parseNetworkNames(bundle, carrier.key), error: null };
}

async function querySunfire(npi, zip, county = '12086') {
  if (!hasSunfireCredentials()) {
    console.warn('[sunfire] Missing SUNFIRE_JWT or SUNFIRE_SFP — skipping');
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const res = await fetch(`${SUNFIRE_BASE}/v2/provider/list`, {
      method: 'POST',
      headers: {
        Authorization: sunfireAuthorizationHeader(),
        Cookie: sunfireCookieHeader(),
        'Content-Type': 'application/json',
        Origin: SUNFIRE_BASE,
        Referer: `${SUNFIRE_BASE}/app/agent/yourmedicare/`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      console.warn(`[sunfire] provider/list HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const plans = Array.isArray(data) ? data : (data.plans || []);
    const inNetwork = [];

    for (const plan of plans) {
      const covered = (plan.doctorInformation || []).some(di =>
        (di.locations || []).some(loc => loc.covered === 'Y')
      );
      if (!covered) continue;

      const id = String(plan.id);
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
    return inNetwork;
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    console.warn(`[sunfire] provider/list error: ${label}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full lookup used by both the HTTP route and chat tool.
 * @returns {{ providers: object[], meta: object, text: string, structured: object }}
 */
async function lookupProviderNetwork({ doctorName, zip = '33136', state = 'FL' }) {
  const { firstName, lastName, nameParts } = parseName(doctorName);
  if (!lastName) {
    return {
      providers: [],
      meta: { query: { doctorName, zip, state }, message: 'Could not parse last name', timestamp: new Date().toISOString() },
      text: `Could not parse a last name from "${doctorName}".`,
      structured: { doctorName, networks: [] },
    };
  }

  const npiResults = await lookupNPIs({ firstName, lastName, state, zip, nameParts });
  if (!npiResults.length) {
    const msg = `No NPI-1 providers found matching "${doctorName}" in ${state}`;
    return {
      providers: [],
      meta: { query: { doctorName, zip, state }, message: msg, timestamp: new Date().toISOString() },
      text: `${msg}. Try a different spelling.`,
      structured: { doctorName, networks: [] },
    };
  }

  const county = countyForZip(zip);
  const providers = [];

  for (const npiResult of npiResults) {
    const npi = npiResult.number;
    if (!npi) continue;

    const [fhirResults, sunfirePlans] = await Promise.all([
      Promise.all(CARRIERS.map(carrier => queryCarrier(carrier, npi))),
      querySunfire(npi, zip, county),
    ]);

    const inNetworkFor = [];
    const carriersWithErrors = [];
    const fhirCarrierHits = [];

    for (const result of fhirResults) {
      if (result.error) {
        carriersWithErrors.push(result.carrier);
      } else if (result.plans.length) {
        inNetworkFor.push(...result.plans);
        fhirCarrierHits.push(result.carrier);
      }
    }
    for (const plan of sunfirePlans) {
      if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
    }

    providers.push({
      name: getDisplayName(npiResult),
      npi,
      specialty: getSpecialty(npiResult),
      address: getLocationAddress(npiResult),
      phone: getPhone(npiResult),
      inNetworkFor,
      fhirCarrierHits,
      sunfirePlansCount: sunfirePlans.length,
      carriersChecked: [...CARRIERS.map(c => c.name), 'Sunfire'],
      carriersWithErrors: carriersWithErrors.length ? carriersWithErrors : undefined,
    });
  }

  let text = `Provider network results for "${doctorName}":\n\n`;
  for (const pr of providers) {
    text += `**${pr.name}** (NPI: ${pr.npi})\n`;
    text += `Specialty: ${pr.specialty || 'Unknown'}\n`;
    text += `Address: ${pr.address || 'n/a'}\n`;
    if (pr.inNetworkFor.length) {
      text += `In-network for:\n${pr.inNetworkFor.map(p => `- ${p}`).join('\n')}\n`;
    } else {
      text += `No in-network plans found in FL Blue, Cigna, HealthSun, Devoted, or Sunfire for this NPI.\n`;
      if (!hasSunfireCredentials()) {
        text += `Note: Sunfire credentials are not configured — UHC/Humana/WellCare/CarePlus may be missing.\n`;
      }
    }
    text += '\n';
  }

  const first = providers[0];
  const structured = first
    ? {
        doctorName: first.name,
        npi: first.npi,
        networks: [
          ...CARRIERS.map(c => ({
            carrier: c.name,
            inNetwork: (first.fhirCarrierHits || []).includes(c.name),
          })),
          {
            carrier: 'Sunfire (UHC/Humana/WellCare/CarePlus +)',
            inNetwork: (first.sunfirePlansCount || 0) > 0,
            plans: first.inNetworkFor.filter(p => !first.fhirCarrierHits?.some(c => p.startsWith(c) || p.includes(c))),
          },
        ],
        plans: first.inNetworkFor,
      }
    : { doctorName, networks: [] };

  return {
    providers,
    meta: {
      query: { doctorName, zip, state },
      npiResultCount: npiResults.length,
      carriersQueried: [...CARRIERS.map(c => c.name), 'Sunfire'],
      sunfirePlanMapSize: Object.keys(SUNFIRE_PLAN_MAP).length,
      sunfireConfigured: hasSunfireCredentials(),
      county,
      timestamp: new Date().toISOString(),
    },
    text: text.slice(0, 6000),
    structured,
  };
}

module.exports = {
  lookupProviderNetwork,
  CARRIERS,
  countyForZip,
  parseName,
};
