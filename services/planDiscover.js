// services/planDiscover.js — out-of-area plan shortlist (Sunfire + medicare.gov Plan Compare).
// Does NOT invent benefit dollars. Does NOT rank/recommend a "best" plan (TPMO).
// THEI grid coverage is Miami-Dade / Broward — this helps agents explore other FL counties.

const fs = require('fs');
const path = require('path');

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const PLAN_CAP = 40;

/** Florida county name (normalized) → FIPS. Includes required + other common FL counties. */
const FL_COUNTY_FIPS = {
  alachua: '12001',
  baker: '12003',
  bay: '12005',
  bradford: '12007',
  brevard: '12009',
  broward: '12011',
  calhoun: '12013',
  charlotte: '12015',
  citrus: '12017',
  clay: '12019',
  collier: '12021',
  columbia: '12023',
  desoto: '12027',
  'de soto': '12027',
  dixie: '12029',
  duval: '12031',
  escambia: '12033',
  flagler: '12035',
  franklin: '12037',
  gadsden: '12039',
  gilchrist: '12041',
  glades: '12043',
  gulf: '12045',
  hamilton: '12047',
  hardee: '12049',
  hendry: '12051',
  hernando: '12053',
  highlands: '12055',
  hillsborough: '12057',
  holmes: '12059',
  'indian river': '12061',
  jackson: '12063',
  jefferson: '12065',
  lafayette: '12067',
  lake: '12069',
  lee: '12071',
  leon: '12073',
  levy: '12075',
  liberty: '12077',
  madison: '12079',
  manatee: '12081',
  marion: '12083',
  martin: '12085',
  'miami-dade': '12086',
  'miami dade': '12086',
  miamidade: '12086',
  dade: '12086',
  monroe: '12087',
  nassau: '12089',
  okaloosa: '12091',
  okeechobee: '12093',
  orange: '12095',
  osceola: '12097',
  'palm beach': '12099',
  palmbeach: '12099',
  pasco: '12101',
  pinellas: '12103',
  polk: '12105',
  putnam: '12107',
  'st. johns': '12109',
  'st johns': '12109',
  'saint johns': '12109',
  'st. lucie': '12111',
  'st lucie': '12111',
  'saint lucie': '12111',
  'santa rosa': '12113',
  santarosa: '12113',
  sarasota: '12115',
  seminole: '12117',
  sumter: '12119',
  suwannee: '12121',
  taylor: '12123',
  union: '12125',
  volusia: '12127',
  wakulla: '12129',
  walton: '12131',
  washington: '12133',
};

/** Key ZIP → FIPS (subset used when county name is omitted). */
const ZIP_TO_FIPS = {
  // Miami-Dade
  '33196': '12086', '33186': '12086', '33176': '12086', '33183': '12086',
  '33015': '12086', '33012': '12086', '33145': '12086', '33126': '12086',
  '33010': '12086', '33054': '12086', '33166': '12086', '33174': '12086',
  '33136': '12086', '33125': '12086', '33133': '12086', '33139': '12086',
  // Broward
  '33004': '12011', '33009': '12011', '33019': '12011', '33021': '12011',
  '33060': '12011', '33064': '12011', '33312': '12011', '33317': '12011',
  '33328': '12011', '33334': '12011',
  // Alachua (Gainesville area)
  '32601': '12001', '32605': '12001', '32606': '12001', '32607': '12001',
  '32608': '12001', '32609': '12001', '32641': '12001', '32653': '12001',
  // Orange (Orlando)
  '32801': '12095', '32803': '12095', '32806': '12095', '32819': '12095',
  '32822': '12095', '32835': '12095',
  // Hillsborough (Tampa)
  '33602': '12057', '33606': '12057', '33609': '12057', '33612': '12057',
  '33617': '12057', '33629': '12057',
  // Palm Beach
  '33401': '12099', '33405': '12099', '33407': '12099', '33409': '12099',
  '33411': '12099', '33414': '12099', '33415': '12099', '33417': '12099',
  '33418': '12099', '33433': '12099', '33435': '12099', '33436': '12099',
  '33458': '12099', '33460': '12099', '33461': '12099', '33462': '12099',
  '33467': '12099', '33470': '12099', '33477': '12099', '33480': '12099',
  '33483': '12099', '33484': '12099',
};

let SUNFIRE_PLAN_MAP = {};
try {
  SUNFIRE_PLAN_MAP = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'sunfire-id-map.json'), 'utf8')
  );
} catch (err) {
  console.warn('[planDiscover] sunfire-id-map.json not loaded:', err.message);
}

function normalizeCountyName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/county$/i, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveCountyFips({ zip, county }) {
  const normalized = normalizeCountyName(county);
  if (normalized && FL_COUNTY_FIPS[normalized]) {
    return { fips: FL_COUNTY_FIPS[normalized], countyLabel: county.trim(), via: 'county' };
  }
  // fuzzy: strip punctuation
  const compact = normalized.replace(/\./g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (compact && FL_COUNTY_FIPS[compact]) {
    return { fips: FL_COUNTY_FIPS[compact], countyLabel: county.trim(), via: 'county' };
  }
  if (zip && ZIP_TO_FIPS[zip]) {
    const fips = ZIP_TO_FIPS[zip];
    const label = Object.entries(FL_COUNTY_FIPS).find(([, v]) => v === fips)?.[0] || county || '';
    return { fips, countyLabel: label ? titleCase(label) : (county || ''), via: 'zip' };
  }
  return { fips: null, countyLabel: county || '', via: null };
}

function titleCase(s) {
  return String(s)
    .split(' ')
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function buildPlanCompareUrl(year) {
  const y = Number(year) || new Date().getFullYear();
  return `https://www.medicare.gov/plan-compare/?lang=en&year=${y}`;
}

function sunfireHeaders(jwt, sfp) {
  return {
    Authorization: `Bearer ${jwt}`,
    Cookie: `sfp-cookie=${sfp}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: SUNFIRE_BASE,
    Referer: `${SUNFIRE_BASE}/app/agent/yourmedicare/`,
  };
}

/**
 * Map a raw Sunfire plan object (or id) through sunfire-id-map.json.
 */
function mapPlan(raw) {
  const sunfireId = String(
    raw?.id ?? raw?.planId ?? raw?.sunfireId ?? raw?.plan_id ?? raw ?? ''
  ).trim();
  if (!sunfireId) return null;

  const entry = SUNFIRE_PLAN_MAP[sunfireId];
  const carrier =
    entry?.carrier ||
    raw?.carrier ||
    raw?.carrierName ||
    raw?.organizationName ||
    null;
  const planName =
    entry?.planName ||
    raw?.planName ||
    raw?.name ||
    raw?.plan_name ||
    null;
  const planId =
    entry?.hRaw ||
    raw?.hRaw ||
    raw?.contractId ||
    raw?.cmsPlanId ||
    raw?.medicarePlanId ||
    null;

  return {
    carrier: carrier || 'Unknown carrier',
    planName: planName || `Sunfire plan ${sunfireId}`,
    planId: planId || null,
    sunfireId,
  };
}

function extractPlanArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.plans)) return data.plans;
  if (Array.isArray(data.planList)) return data.planList;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  if (data.plans && typeof data.plans === 'object') return Object.values(data.plans);
  return [];
}

/**
 * Attempt Sunfire plan-list style endpoints historically referenced when building
 * sunfire-id-map.json ("intercepting Sunfire's own plan-list API").
 * Tries POST /v2/plan/list first, then a few reasonable fallbacks.
 */
async function querySunfirePlans({ zip, countyFips, year, planType }) {
  const jwt = process.env.SUNFIRE_JWT;
  const sfp = process.env.SUNFIRE_SFP;
  const errors = [];
  const attempted = [];

  if (!jwt || !sfp) {
    return {
      plans: [],
      source: null,
      attempted,
      errors: ['SUNFIRE_JWT / SUNFIRE_SFP not set — skipping Sunfire plan list'],
    };
  }

  const y = Number(year) || 2026;
  const bodyBase = {
    county: countyFips,
    year: y,
    zip: String(zip),
    state: 'FL',
  };
  if (planType) bodyBase.planType = planType;

  const attempts = [
    {
      label: 'POST /v2/plan/list',
      method: 'POST',
      url: `${SUNFIRE_BASE}/v2/plan/list`,
      body: { ...bodyBase, type: 'plan' },
    },
    {
      label: 'POST /v2/plan/list (minimal)',
      method: 'POST',
      url: `${SUNFIRE_BASE}/v2/plan/list`,
      body: bodyBase,
    },
    {
      label: 'GET /v2/plan/list',
      method: 'GET',
      url: `${SUNFIRE_BASE}/v2/plan/list?county=${encodeURIComponent(countyFips)}&zip=${encodeURIComponent(zip)}&year=${y}&state=FL`,
      body: null,
    },
    {
      label: 'POST /v2/plans/list',
      method: 'POST',
      url: `${SUNFIRE_BASE}/v2/plans/list`,
      body: bodyBase,
    },
  ];

  for (const attempt of attempts) {
    attempted.push(attempt.label);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const opts = {
        method: attempt.method,
        headers: sunfireHeaders(jwt, sfp),
        signal: ctrl.signal,
      };
      if (attempt.body) opts.body = JSON.stringify(attempt.body);

      const res = await fetch(attempt.url, opts);
      if (!res.ok) {
        errors.push(`${attempt.label}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const rawPlans = extractPlanArray(data);
      if (!rawPlans.length) {
        errors.push(`${attempt.label}: empty plan list`);
        continue;
      }

      const mapped = [];
      const seen = new Set();
      for (const raw of rawPlans) {
        const m = mapPlan(raw);
        if (!m) continue;
        const key = m.sunfireId || `${m.carrier}|${m.planName}|${m.planId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mapped.push(m);
        if (mapped.length >= PLAN_CAP) break;
      }

      if (mapped.length) {
        return { plans: mapped, source: `sunfire:${attempt.label}`, attempted, errors };
      }
      errors.push(`${attempt.label}: could not map plans`);
    } catch (err) {
      const label = err.name === 'AbortError' ? 'timeout' : err.message;
      errors.push(`${attempt.label}: ${label}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { plans: [], source: null, attempted, errors };
}

/**
 * Discover candidate MA plans for a ZIP/county.
 * Always returns a medicare.gov Plan Compare starter URL.
 * Never ranks plans; never invents benefit dollars.
 *
 * @param {{ zip: string, county?: string, year?: number|string, planType?: string, referenceSummary?: string }} opts
 */
async function discoverPlansForArea({ zip, county, year, planType, referenceSummary } = {}) {
  const errors = [];
  const z = String(zip || '').trim();
  if (!/^\d{5}$/.test(z)) {
    return {
      ok: false,
      zip: z || null,
      county: county || null,
      countyFips: null,
      year: Number(year) || 2026,
      planCompareUrl: buildPlanCompareUrl(year || 2026),
      source: null,
      plans: [],
      note: 'zip must be a 5-digit US ZIP. Enter that ZIP on medicare.gov Plan Compare.',
      errors: ['invalid zip'],
      referenceSummary: referenceSummary || undefined,
    };
  }

  const y = Number(year) || 2026;
  const planCompareUrl = buildPlanCompareUrl(y);
  const { fips, countyLabel } = resolveCountyFips({ zip: z, county });

  if (!fips) {
    errors.push('Could not resolve Florida county FIPS from county name or ZIP; Plan Compare URL still provided.');
  }

  let plans = [];
  let source = 'plan-compare-only';
  let sunfireAttempted = [];

  if (fips) {
    const sf = await querySunfirePlans({
      zip: z,
      countyFips: fips,
      year: y,
      planType,
    });
    sunfireAttempted = sf.attempted || [];
    if (sf.errors?.length) errors.push(...sf.errors);
    if (sf.plans.length) {
      plans = sf.plans;
      source = sf.source || 'sunfire';
    }
  }

  const notes = [];
  notes.push(
    `Open Plan Compare and enter ZIP ${z} (deep-link ZIP params are unreliable): ${planCompareUrl}`
  );
  if (!plans.length) {
    notes.push(
      'No Sunfire plan list returned for this area (missing credentials, endpoint mismatch, or empty response). Use the Sunfire broker portal and/or medicare.gov Plan Compare to list candidates. Do not invent premiums, MOOP, or dental from memory.'
    );
  } else {
    notes.push(
      `Shortlist capped at ${PLAN_CAP}. Candidate list only — do not rank a "best" plan (TPMO). Agent verifies benefits in Sunfire / SOB / Plan Compare. THEI benefit grid does not cover this county.`
    );
  }
  if (referenceSummary) {
    notes.push(
      'referenceSummary echoed for LLM matching against returned candidates only — never invent plans not in this list.'
    );
  }

  return {
    ok: true,
    zip: z,
    county: countyLabel || county || null,
    countyFips: fips,
    year: y,
    planCompareUrl,
    source,
    plans,
    note: notes.join(' '),
    errors: errors.length ? errors : undefined,
    sunfireAttempted: sunfireAttempted.length ? sunfireAttempted : undefined,
    referenceSummary: referenceSummary || undefined,
  };
}

module.exports = {
  discoverPlansForArea,
  FL_COUNTY_FIPS,
  ZIP_TO_FIPS,
  buildPlanCompareUrl,
  resolveCountyFips,
};
