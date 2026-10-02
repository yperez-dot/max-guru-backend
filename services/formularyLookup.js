/**
 * Plan-year formulary lookup (drug × contract-PBP).
 *
 * Client-stated "Tier X" (Daisy sheet, archive comps, last year's screenshot)
 * is a claim only. This module never copies claimedTier into a verified result.
 *
 * Sources, in order:
 *   1. Sunfire /v2/drug/* when SUNFIRE_JWT is set (catalog + plan-scoped probes)
 *   2. Humana public FHIR MedicationKnowledge for Humana CMS IDs (H1036 / H7617)
 *
 * Cost-share after a verified tier comes from THEI Hub/grid knowledge
 * (2027 green cells in max-knowledge/carriers/*-plans-florida-2027.md),
 * not from the client's paste and not from Yahoska's finished-comp archive.
 */

const fs = require('fs');
const path = require('path');
const { getKnowledgeByKey } = require('../knowledge/loader');

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const HUMANA_FHIR = 'https://fhir.humana.com/api/MedicationKnowledge';
const PLAN_YEAR = 2027;
const FETCH_TIMEOUT_MS = 12_000;
const PUBLIC_HUMANA_DRUG_LIST = 'https://www.humana.com/pharmacy/medicare-drug-list';

const KB_2027_KEYS = [
  'carriers/humana-plans-florida-2027',
  'carriers/devoted-plans-florida-2027',
  'carriers/uhc-plans-florida-2027',
  'carriers/careplus-plans-florida-2027',
  'carriers/aetna-plans-florida-2027',
  'carriers/doctors-plans-florida-2027',
  'carriers/healthsun-plans-florida-2027',
];

let SUNFIRE_PLAN_MAP = {};
try {
  SUNFIRE_PLAN_MAP = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'sunfire-id-map.json'), 'utf8')
  );
} catch (_) {
  SUNFIRE_PLAN_MAP = {};
}

function sunfireHeaders() {
  const jwt = process.env.SUNFIRE_JWT || '';
  const sfp = process.env.SUNFIRE_SFP || '';
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: SUNFIRE_BASE,
    Referer: `${SUNFIRE_BASE}/app/agent/yourmedicare/`,
    'User-Agent': 'Max-Medicare-Guru/1.0',
  };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  if (sfp) headers.Cookie = `sfp-cookie=${sfp}`;
  return headers;
}

function hasSunfireCreds() {
  return Boolean(process.env.SUNFIRE_JWT);
}

async function fetchJson(url, options = {}, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    const label = err.name === 'AbortError' ? 'Timeout' : err.message;
    return { ok: false, status: 0, json: null, text: '', error: label };
  } finally {
    clearTimeout(timer);
  }
}

function parseCmsId(value) {
  const m = String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .match(/^(H\d{4}|R\d{4})-(\d{3})([A-Z])?/);
  if (!m) return null;
  const base = `${m[1]}-${m[2]}`;
  return { base, letter: m[3] || '', full: m[3] ? `${base}${m[3]}` : base };
}

function cmsIdsMatch(a, b) {
  const pa = parseCmsId(a);
  const pb = parseCmsId(b);
  return Boolean(pa && pb && pa.base === pb.base);
}

function displayPlanId(value) {
  return parseCmsId(value)?.full || String(value || '').replace(/\s+/g, '').toUpperCase();
}

function parseTierNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && raw >= 1 && raw <= 6) return raw;
  const m = String(raw).match(/(?:tier\s*)?([1-6])\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 6 ? n : null;
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

function pickBool(obj, keys) {
  const v = pickFirst(obj, keys);
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

function walkObjects(node, acc = [], depth = 0) {
  if (!node || depth > 6) return acc;
  if (Array.isArray(node)) {
    node.slice(0, 40).forEach((item) => walkObjects(item, acc, depth + 1));
    return acc;
  }
  if (typeof node === 'object') {
    acc.push(node);
    Object.values(node).forEach((v) => {
      if (v && typeof v === 'object') walkObjects(v, acc, depth + 1);
    });
  }
  return acc;
}

function coverageFromObject(obj) {
  const tier = parseTierNumber(
    pickFirst(obj, [
      'tier',
      'drugTier',
      'formularyTier',
      'tierLevel',
      'tier_level',
      'Tier',
      'tierId',
      'drug_tier',
      'tierLevelValue',
      'formulary_tier',
    ])
  );
  const pa = pickBool(obj, [
    'priorAuth',
    'priorAuthorization',
    'pa',
    'PA',
    'prior_auth',
    'priorAuthorizationRequired',
    'prior_authorization',
  ]);
  const st = pickBool(obj, [
    'stepTherapy',
    'step_therapy',
    'st',
    'ST',
    'stepTherapyRequired',
    'step_therapy_required',
  ]);
  const ql = pickBool(obj, ['quantityLimit', 'quantity_limit', 'ql', 'QL', 'quantityLimitYn']);
  const coveredRaw = pickFirst(obj, ['covered', 'coverage', 'status', 'onFormulary', 'formularyStatus']);
  let coverage = null;
  if (coveredRaw !== undefined) {
    const s = String(coveredRaw).toLowerCase();
    if (s === 'true' || s === 'covered' || s === 'on-formulary' || s === 'onformulary') coverage = 'covered';
    else if (s === 'false' || s === 'not covered' || s === 'non-formulary' || s === 'notcovered') {
      coverage = 'not_covered';
    }
  }
  if (tier && !coverage) coverage = 'covered';
  return { tier, pa, st, ql, coverage };
}

function firstCoverageHit(payload) {
  for (const obj of walkObjects(payload)) {
    const hit = coverageFromObject(obj);
    if (hit.tier || hit.coverage === 'not_covered') return { ...hit, raw: obj };
  }
  return null;
}

function sunfireIdForPlan(planId, map = SUNFIRE_PLAN_MAP) {
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  const entries = Object.entries(map || {});
  const fullHit = entries.find(([, e]) => String(e.planName || '').toUpperCase().includes(parsed.full));
  if (fullHit) return fullHit[0];
  const baseHits = entries.filter(([, e]) => String(e.planName || '').toUpperCase().includes(parsed.base));
  if (baseHits.length === 1) return baseHits[0][0];
  return baseHits[0] ? baseHits[0][0] : null;
}

function catalogDrugs(payload) {
  const data = payload || {};
  const list = data.drugs || data.results || data.data || (Array.isArray(data) ? data : []);
  if (!Array.isArray(list)) return [];
  return list
    .map((d) => ({
      id: d.id || d.drugId || d.sunfireId || null,
      name: d.name || d.drugName || d.label || '',
      ndc: d.ndc || d.NDC || d.ndc11 || null,
      genericId: d.genericId || d.generic_id || null,
    }))
    .filter((d) => d.name || d.ndc);
}

function pickCatalogMatch(drugs, query) {
  if (!drugs.length) return null;
  const q = String(query || '').toLowerCase().trim();
  const exact = drugs.find((d) => String(d.name || '').toLowerCase() === q);
  if (exact) return exact;
  const starts = drugs.find((d) => String(d.name || '').toLowerCase().startsWith(q));
  return starts || drugs[0];
}

async function searchSunfireCatalog(name, fetchImpl = fetch) {
  if (!hasSunfireCreds() || !name) {
    return { drugs: [], error: hasSunfireCreds() ? null : 'sunfire_creds_missing', status: 0 };
  }
  const prefix = encodeURIComponent(String(name).toLowerCase().slice(0, 20));
  const res = await fetchJson(
    `${SUNFIRE_BASE}/v2/drug/search/${prefix}/-1`,
    { headers: sunfireHeaders() },
    fetchImpl
  );
  if (!res.ok) {
    return { drugs: [], error: res.error || `sunfire_search_http_${res.status}`, status: res.status };
  }
  return { drugs: catalogDrugs(res.json), error: null, status: res.status };
}

async function lookupSunfireCoverage({ drug, planId, year, sunfirePlanId }, fetchImpl = fetch) {
  if (!hasSunfireCreds()) {
    return { verified: false, reason: 'sunfire_creds_missing', attempted: [] };
  }
  const y = Number(year) || PLAN_YEAR;
  const sfId = sunfirePlanId || sunfireIdForPlan(planId);
  const prefix = encodeURIComponent(String(drug?.name || '').toLowerCase().slice(0, 20));
  const drugId = drug?.id;
  const attempted = [];

  const attempts = [
    sfId && prefix
      ? { label: `GET /v2/drug/search/${prefix}/${sfId}`, method: 'GET', url: `${SUNFIRE_BASE}/v2/drug/search/${prefix}/${sfId}` }
      : null,
    sfId && prefix
      ? {
          label: `GET /v2/drug/search/${prefix}/${sfId}/${y}`,
          method: 'GET',
          url: `${SUNFIRE_BASE}/v2/drug/search/${prefix}/${sfId}/${y}`,
        }
      : null,
    drugId ? { label: `GET /v2/drug/${drugId}`, method: 'GET', url: `${SUNFIRE_BASE}/v2/drug/${drugId}` } : null,
    drugId && sfId
      ? { label: `GET /v2/drug/${drugId}/${sfId}`, method: 'GET', url: `${SUNFIRE_BASE}/v2/drug/${drugId}/${sfId}` }
      : null,
    drugId && sfId
      ? {
          label: 'POST /v2/drug/coverage',
          method: 'POST',
          url: `${SUNFIRE_BASE}/v2/drug/coverage`,
          body: { drugId, planId: sfId, year: y },
        }
      : null,
    drugId && sfId
      ? {
          label: 'POST /v2/drug/list',
          method: 'POST',
          url: `${SUNFIRE_BASE}/v2/drug/list`,
          body: { planId: sfId, year: y, drugId, drugs: [drugId] },
        }
      : null,
    drugId && sfId
      ? {
          label: `GET /v2/plan/${sfId}/drug/${drugId}`,
          method: 'GET',
          url: `${SUNFIRE_BASE}/v2/plan/${sfId}/drug/${drugId}?year=${y}`,
        }
      : null,
  ].filter(Boolean);

  for (const attempt of attempts) {
    attempted.push(attempt.label);
    const opts = { method: attempt.method, headers: sunfireHeaders() };
    if (attempt.body) opts.body = JSON.stringify(attempt.body);
    const res = await fetchJson(attempt.url, opts, fetchImpl);
    if (!res.ok || !res.json) continue;
    const hit = firstCoverageHit(res.json);
    if (!hit) continue;
    if (hit.coverage === 'not_covered') {
      return {
        verified: true,
        coverage: 'not_covered',
        tier: null,
        pa: hit.pa,
        st: hit.st,
        ql: hit.ql,
        source: `sunfire:${attempt.label}`,
        sunfirePlanId: sfId || null,
        attempted,
      };
    }
    if (hit.tier) {
      return {
        verified: true,
        coverage: 'covered',
        tier: hit.tier,
        pa: hit.pa,
        st: hit.st,
        ql: hit.ql,
        source: `sunfire:${attempt.label}`,
        sunfirePlanId: sfId || null,
        attempted,
      };
    }
  }

  return { verified: false, reason: 'sunfire_no_tier', sunfirePlanId: sfId || null, attempted };
}

function fhirExtension(resource, fragment) {
  const list = resource?.extension || [];
  return list.find((ex) => String(ex.url || '').toLowerCase().includes(String(fragment).toLowerCase()));
}

function fhirTier(resource) {
  const ext = fhirExtension(resource, 'drugtierid');
  const coding = ext?.valueCodeableConcept?.coding?.[0];
  return parseTierNumber(coding?.code || coding?.display || ext?.valueString);
}

function fhirPlanId(resource) {
  const ext = fhirExtension(resource, 'planid');
  return ext?.valueString || ext?.valueCode || null;
}

function fhirBool(resource, fragment) {
  const ext = fhirExtension(resource, fragment);
  if (!ext) return null;
  if (typeof ext.valueBoolean === 'boolean') return ext.valueBoolean;
  return pickBool(ext, ['valueBoolean', 'valueString']);
}

function fhirName(resource) {
  return (
    resource?.code?.text ||
    resource?.code?.coding?.find((c) => c.display)?.display ||
    resource?.synonym?.[0] ||
    ''
  );
}

function fhirNdc(resource) {
  const coding = resource?.code?.coding || [];
  const ndc = coding.find((c) => /ndc/i.test(c.system || '') || /^\d{10,11}$/.test(c.code || ''));
  return ndc?.code || null;
}

function humanaPlanYearMatch(planExt, planId, year) {
  if (!planExt) return false;
  const parsed = parseCmsId(planId);
  if (!parsed) return false;
  const token = String(planExt).toUpperCase().replace(/\s+/g, '');
  const y = String(year || PLAN_YEAR);
  const hasPlan = token.includes(parsed.base.replace('-', '')) || token.includes(parsed.base);
  const hasYear = token.includes(y);
  return hasPlan && hasYear;
}

function isHumanaCms(planId) {
  const parsed = parseCmsId(planId);
  return Boolean(parsed && /^(H1036|H7617|H7284)$/.test(parsed.base.slice(0, 5)));
}

async function lookupHumanaFhir({ drugName, ndc, planId, year }, fetchImpl = fetch) {
  if (!isHumanaCms(planId)) {
    return { verified: false, reason: 'not_humana' };
  }
  const y = Number(year) || PLAN_YEAR;
  const headers = {
    Accept: 'application/fhir+json, application/json',
    'User-Agent': 'Mozilla/5.0 (compatible; Max-Medicare-Guru/1.0)',
  };
  const queries = [];
  if (ndc) queries.push(`${HUMANA_FHIR}?code=${encodeURIComponent(String(ndc).replace(/-/g, ''))}`);
  if (ndc && String(ndc).includes('-')) queries.push(`${HUMANA_FHIR}?code=${encodeURIComponent(ndc)}`);
  if (drugName) queries.push(`${HUMANA_FHIR}?name=${encodeURIComponent(drugName)}`);

  let lastError = null;
  for (const url of queries) {
    const res = await fetchJson(url, { headers }, fetchImpl, 15_000);
    if (!res.ok) {
      lastError = res.error || `humana_fhir_http_${res.status}`;
      continue;
    }
    const entries = res.json?.entry || [];
    const matched = [];
    for (const entry of entries) {
      const resource = entry.resource;
      if (!resource || resource.resourceType !== 'MedicationKnowledge') continue;
      const planExt = fhirPlanId(resource);
      if (!humanaPlanYearMatch(planExt, planId, y)) continue;
      const tier = fhirTier(resource);
      const pa = fhirBool(resource, 'priorauthorization');
      const st = fhirBool(resource, 'steptherapy');
      const ql = fhirBool(resource, 'quantitylimit');
      matched.push({
        tier,
        pa,
        st,
        ql,
        planExt,
        name: fhirName(resource),
        ndc: fhirNdc(resource),
      });
    }
    const withTier = matched.find((m) => m.tier);
    if (withTier) {
      return {
        verified: true,
        coverage: 'covered',
        tier: withTier.tier,
        pa: withTier.pa,
        st: withTier.st,
        ql: withTier.ql,
        source: 'humana_fhir',
        fhirPlanId: withTier.planExt,
        drugName: withTier.name || drugName,
        ndc: withTier.ndc || ndc || null,
      };
    }
    if (matched.length) {
      return {
        verified: false,
        reason: 'humana_fhir_no_tier',
        source: 'humana_fhir',
      };
    }
    if (entries.length) {
      return {
        verified: false,
        reason: 'humana_fhir_no_pbp_year_match',
        source: 'humana_fhir',
        note: 'Humana FHIR returned formulary rows but none matched this contract-PBP + year. Not verified for this plan.',
      };
    }
  }

  return { verified: false, reason: lastError || 'humana_fhir_empty' };
}

function costShareFromKnowledge(planId, year, tier) {
  if (!tier || Number(year) !== 2027) return null;
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  for (const key of KB_2027_KEYS) {
    const doc = getKnowledgeByKey(key);
    if (!doc) continue;
    const sections = doc.split(/^## /m);
    const hits = sections.filter((s) => {
      const upper = s.toUpperCase();
      return (
        (upper.includes(parsed.full) || upper.includes(parsed.base)) &&
        /\|\s*Tier\s*1\s*\|/i.test(s)
      );
    });
    const re = new RegExp(`\\|\\s*Tier\\s*${tier}\\s*\\|\\s*([^|]+)\\|`, 'i');
    for (const hit of hits) {
      const m = hit.match(re);
      if (!m) continue;
      const value = m[1].trim();
      if (!value) continue;
      return { value, source: 'kb_2027', knowledgeKey: key };
    }
  }
  return null;
}

function costShareFromPlanObject(plan, tier) {
  if (!plan || !tier) return null;
  const key = `tier${tier}`;
  const raw = plan[key];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') {
    if (raw > 0 && raw < 1) return { value: `${Math.round(raw * 1000) / 10}%`, source: 'plan_data' };
    return { value: `$${raw}`, source: 'plan_data' };
  }
  return { value: String(raw).trim(), source: 'plan_data' };
}

function emptyPlanResult(planId, year, reason) {
  return {
    planId: displayPlanId(planId),
    year: Number(year) || PLAN_YEAR,
    verified: false,
    tier: null,
    coverage: null,
    pa: null,
    st: null,
    ql: null,
    costShare: null,
    costShareSource: null,
    source: null,
    reason: reason || 'unverified',
  };
}

/**
 * Look up one drug against one or more plans.
 * claimedTier is recorded and discarded for verification.
 */
async function lookupFormulary(
  {
    drugName = '',
    ndc = '',
    planId = '',
    planIds = [],
    year = PLAN_YEAR,
    claimedTier = null,
    plans = [],
  } = {},
  fetchImpl = fetch
) {
  const y = Number(year) || PLAN_YEAR;
  const claimed = parseTierNumber(claimedTier);
  const ids = [...(planId ? [planId] : []), ...(Array.isArray(planIds) ? planIds : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const uniqueIds = [];
  for (const id of ids) {
    if (!uniqueIds.some((u) => cmsIdsMatch(u, id))) uniqueIds.push(id);
  }

  const catalog = await searchSunfireCatalog(drugName || ndc, fetchImpl);
  const match = pickCatalogMatch(catalog.drugs, drugName || ndc);
  const resolvedName = match?.name || drugName || ndc || 'Unknown drug';
  const resolvedNdc = ndc || match?.ndc || null;

  const byPlanId = {};
  const lookups = [];

  if (!uniqueIds.length) {
    return {
      drugName: resolvedName,
      ndc: resolvedNdc,
      year: y,
      claimedTier: claimed,
      claimedTierIgnored: true,
      catalog: catalog.drugs.slice(0, 10),
      catalogError: catalog.error,
      lookups: [],
      byPlanId,
      verifiedAny: false,
    };
  }

  for (const id of uniqueIds) {
    const planObj = (plans || []).find((p) => cmsIdsMatch(p.planId || p.id, id));
    let hit = null;

    const sunfire = await lookupSunfireCoverage(
      { drug: match || { name: resolvedName, ndc: resolvedNdc }, planId: id, year: y },
      fetchImpl
    );
    if (sunfire.verified) hit = sunfire;

    if (!hit || !hit.verified) {
      const fhir = await lookupHumanaFhir(
        { drugName: resolvedName, ndc: resolvedNdc, planId: id, year: y },
        fetchImpl
      );
      if (fhir.verified) hit = fhir;
      else if (!hit) hit = fhir;
    }

    const displayId = displayPlanId(id);
    if (hit && hit.verified) {
      const share =
        costShareFromKnowledge(id, y, hit.tier) ||
        (y === 2026 ? costShareFromPlanObject(planObj, hit.tier) : null);
      const row = {
        planId: displayId,
        year: y,
        verified: true,
        tier: hit.tier || null,
        coverage: hit.coverage || (hit.tier ? 'covered' : null),
        pa: hit.pa,
        st: hit.st,
        ql: hit.ql,
        costShare: share ? share.value : null,
        costShareSource: share ? share.source : null,
        source: hit.source,
        reason: null,
        claimedTierIgnored: claimed,
      };
      byPlanId[displayId] = row;
      lookups.push(row);
    } else {
      const row = {
        ...emptyPlanResult(id, y, (hit && hit.reason) || catalog.error || 'unverified'),
        claimedTierIgnored: claimed,
        note: hit && hit.note ? hit.note : undefined,
      };
      byPlanId[displayId] = row;
      lookups.push(row);
    }
  }

  return {
    drugName: resolvedName,
    ndc: resolvedNdc,
    year: y,
    claimedTier: claimed,
    claimedTierIgnored: true,
    catalog: catalog.drugs.slice(0, 10),
    catalogError: catalog.error,
    lookups,
    byPlanId,
    verifiedAny: lookups.some((l) => l.verified),
  };
}

function flagLine(label, value) {
  if (value === true) return label;
  if (value === false) return `no ${label}`;
  return null;
}

function formatPlanLookupLine(drugName, row) {
  if (row.verified && row.coverage === 'not_covered') {
    return `FORMULARY_LOOKUP year=${row.year} drug=${drugName.replace(/\s+/g, '_')} plan=${row.planId} verified_tier=none coverage=not_covered source=${row.source || 'unknown'}`;
  }
  if (row.verified && row.tier) {
    const extra = [
      row.costShare ? `cost_share=${String(row.costShare).replace(/\s+/g, '')}` : null,
      row.pa === true ? 'pa=yes' : row.pa === false ? 'pa=no' : null,
      row.st === true ? 'st=yes' : row.st === false ? 'st=no' : null,
      row.source ? `source=${row.source}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    return `FORMULARY_LOOKUP year=${row.year} drug=${drugName.replace(/\s+/g, '_')} plan=${row.planId} verified_tier=${row.tier} ${extra}`.trim();
  }
  return `FORMULARY_LOOKUP year=${row.year} drug=${drugName.replace(/\s+/g, '_')} plan=${row.planId} verified=no reason=${row.reason || 'unverified'}`;
}

function formatFormularyText(result) {
  if (!result) return 'Formulary lookup failed.';
  const lines = [];
  lines.push(`${result.drugName}${result.ndc ? ` (NDC ${result.ndc})` : ''} — plan year ${result.year}`);
  if (result.claimedTier) {
    lines.push(
      `Client-stated Tier ${result.claimedTier} is a claim only and was NOT used as the verified tier.`
    );
  }
  if (!result.lookups.length) {
    lines.push('No plan IDs were passed. Catalog only — tiers are unverified until lookup_formulary is called with a contract-PBP.');
    if (result.catalog && result.catalog.length) {
      lines.push(
        `Catalog matches: ${result.catalog
          .slice(0, 5)
          .map((d) => `${d.name}${d.ndc ? ` NDC ${d.ndc}` : ''}`)
          .join('; ')}`
      );
    }
    if (result.catalogError) lines.push(`Catalog: ${result.catalogError}`);
    return lines.join('\n');
  }

  for (const row of result.lookups) {
    if (row.verified && row.tier) {
      const flags = [flagLine('PA', row.pa), flagLine('ST', row.st), flagLine('QL', row.ql)]
        .filter(Boolean)
        .join(', ');
      const cost =
        row.costShare && row.costShareSource === 'kb_2027'
          ? `${row.costShare} (2027 THEI grid T${row.tier})`
          : row.costShare
            ? `${row.costShare} (${row.costShareSource})`
            : 'cost-share not on file in THEI 2027 grid/KB';
      lines.push(
        `${row.planId}: verified Tier ${row.tier} · ${cost}${flags ? ` · ${flags}` : ''} · source ${row.source}`
      );
    } else if (row.verified && row.coverage === 'not_covered') {
      lines.push(`${row.planId}: verified not covered (${row.source}). Do not quote a client-stated tier.`);
    } else {
      lines.push(
        `${row.planId}: UNVERIFIED${row.reason ? ` (${row.reason})` : ''}. Do not copy a client-stated / Daisy tier as fact.`
      );
      if (row.note) lines.push(`  ${row.note}`);
    }
    lines.push(formatPlanLookupLine(result.drugName, row));
  }
  return lines.join('\n');
}

function toExportDrug(result) {
  if (!result) return null;
  return {
    name: result.drugName,
    ndc: result.ndc || '',
    claimedTier: result.claimedTier,
    byPlanId: result.byPlanId,
  };
}

module.exports = {
  PLAN_YEAR,
  SUNFIRE_BASE,
  HUMANA_FHIR,
  PUBLIC_HUMANA_DRUG_LIST,
  KB_2027_KEYS,
  parseCmsId,
  cmsIdsMatch,
  displayPlanId,
  parseTierNumber,
  coverageFromObject,
  firstCoverageHit,
  sunfireIdForPlan,
  catalogDrugs,
  pickCatalogMatch,
  humanaPlanYearMatch,
  isHumanaCms,
  costShareFromKnowledge,
  costShareFromPlanObject,
  lookupFormulary,
  lookupSunfireCoverage,
  lookupHumanaFhir,
  searchSunfireCatalog,
  formatFormularyText,
  formatPlanLookupLine,
  toExportDrug,
  hasSunfireCreds,
};
