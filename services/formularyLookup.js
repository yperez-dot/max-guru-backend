/**
 * Plan-year formulary lookup (drug × contract-PBP).
 *
 * Daisy / paste / archive "Tier X" labels are discarded on entry. This module
 * never copies, quotes, or returns claimedTier. Lookup is the only source.
 *
 * Sources, in order:
 *   1. Sunfire /v2/drug/* when SUNFIRE_JWT is set (catalog + plan-scoped probes)
 *   2. Humana public FHIR MedicationKnowledge for Humana CMS IDs (H1036 / H7617)
 *      only when the PlanID extension matches this contract-PBP AND year
 *   3. Medicare.gov Plan Compare (autocomplete → RxNorm NDC → drugs/cost)
 *   4. Carrier consumer documents when the plan is not on Sunfire / missing
 *      on medicare.gov — Doctors 2027 formulary PDF first (H4140). See
 *      services/consumerFormulary.js. Never invent a tier.
 *
 * Cost-share after a verified tier comes from THEI Hub/grid knowledge
 * (2027 green cells in max-knowledge/carriers/*-plans-florida-2027.md),
 * not from the client's paste and not from Yahoska's finished-comp archive.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getKnowledgeByKey } = require('../knowledge/loader');
const { lookupConsumerFormulary } = require('./consumerFormulary');
const { doctorsPbpAliases, isDoctorsCms } = require('./doctorsFormularyPdf');

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const HUMANA_FHIR = 'https://fhir.humana.com/api/MedicationKnowledge';
const MEDICARE_GOV_BASE = 'https://www.medicare.gov/api/v1/data/plan-compare';
const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const MPF_FE_VER = '2.69.0';
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
    return { ok: res.ok, status: res.status, json, text, error: res.error };
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

const BAD_FORM_RE = /\b(inject(?:ion|able)?|intravenous|\biv\b|vial|kit|powder for|for solution|irrigation|topical|ophthalmic|otic|nasal|patch|suppositor)/i;

function catalogScore(drug, query) {
  const name = String(drug.name || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();
  if (!name) return -100;
  let score = 0;
  if (name === q) score += 100;
  const base = q.split(/\s+/)[0];
  if (base && name.startsWith(base)) score += 10;
  if (/\btab(let)?s?\b|oral tablet/.test(name)) score += 4;
  if (/\bcap(sule)?s?\b/.test(name)) score += 1;
  if (BAD_FORM_RE.test(name) && !BAD_FORM_RE.test(q)) score -= 20;
  for (const n of q.match(/\d+(?:\.\d+)?/g) || []) if (name.includes(n)) score += 3;
  return score;
}

/** Catalog products for a query, best match first (oral tablet over injection, matching strength). */
function rankCatalogMatches(drugs, query) {
  return (drugs || [])
    .map((d, i) => ({ d, i, s: catalogScore(d, query) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.d);
}

function pickCatalogMatch(drugs, query) {
  if (!drugs || !drugs.length) return null;
  return rankCatalogMatches(drugs, query)[0];
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
    const res = await fetchJson(url, { headers }, fetchImpl, 8_000);
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

function medicareGovHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://www.medicare.gov',
    Referer: 'https://www.medicare.gov/plan-compare/',
    'fe-ver': MPF_FE_VER,
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
}

/**
 * Akamai 403s Node/undici and Node https POSTs to drugs/cost.
 * curl and Python urllib (stdlib) succeed. Railway Node images often lack
 * curl, and a missing binary used to resolve as status 0 → medicare_gov_http_0.
 * Try curl, then python3 urllib. Do not fall back to Node TLS.
 * Tests inject fetchImpl and never hit this path unless they call it directly.
 */
const PYTHON_URLLIB = `
import json, sys, urllib.error, urllib.request
req = json.load(sys.stdin)
headers = {str(k): str(v) for k, v in (req.get("headers") or {}).items() if v is not None}
data = req.get("body")
body = data.encode("utf-8") if data else None
r = urllib.request.Request(req["url"], data=body, headers=headers, method=req.get("method") or "GET")
try:
    with urllib.request.urlopen(r, timeout=float(req.get("timeout") or 20)) as resp:
        print(json.dumps({"status": int(resp.status), "text": resp.read().decode("utf-8", "replace")}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": int(e.code), "text": e.read().decode("utf-8", "replace")}))
except Exception as e:
    print(json.dumps({"status": 0, "text": "", "error": str(e)}))
`;

function fetchLike(status, text, error) {
  return {
    ok: status >= 200 && status < 300,
    status,
    error: error || undefined,
    text: async () => text,
  };
}

function spawnOnce(bin, args, { stdin = null, timeoutMs = 22_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      const missing = err && (err.code === 'ENOENT' || /ENOENT/.test(err.message || ''));
      done({ ok: false, status: 0, text: '', error: missing ? `${bin}_missing` : err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      done({ ok: true, status: 0, text: out, error: null });
    });
    try {
      if (stdin != null) child.stdin.write(stdin);
      child.stdin.end();
    } catch (_) {
      /* ignore — ENOENT already handled on error */
    }
  });
}

function curlBin() {
  return process.env.MEDICARE_GOV_CURL || 'curl';
}

function pythonBins() {
  if (process.env.MEDICARE_GOV_PYTHON) return [process.env.MEDICARE_GOV_PYTHON];
  return ['python3', 'python'];
}

async function curlFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = options.headers || {};
  const args = ['-sS', '-X', method, '--max-time', '20', '-w', '\n__HTTPSTATUS__:%{http_code}'];
  Object.entries(headers).forEach(([key, value]) => {
    if (value != null) args.push('-H', `${key}: ${value}`);
  });
  if (options.body) args.push('--data-binary', String(options.body));
  args.push(String(url));
  const spawned = await spawnOnce(curlBin(), args);
  if (spawned.error) return fetchLike(0, '', spawned.error);
  const match = spawned.text.match(/\n__HTTPSTATUS__:(\d+)\s*$/);
  const status = match ? Number(match[1]) : 0;
  const text = match ? spawned.text.slice(0, match.index) : spawned.text;
  return fetchLike(status, text, status ? undefined : 'curl_no_status');
}

async function pythonUrllibFetch(url, options = {}) {
  const payload = JSON.stringify({
    url: String(url),
    method: String(options.method || 'GET').toUpperCase(),
    headers: options.headers || {},
    body: options.body != null ? String(options.body) : '',
    timeout: 20,
  });
  let last = fetchLike(0, '', 'python_missing');
  for (const bin of pythonBins()) {
    const spawned = await spawnOnce(bin, ['-c', PYTHON_URLLIB], { stdin: payload });
    if (spawned.error) {
      last = fetchLike(0, '', spawned.error);
      continue;
    }
    try {
      const parsed = JSON.parse(String(spawned.text || '').trim() || '{}');
      const status = Number(parsed.status) || 0;
      last = fetchLike(status, parsed.text || '', parsed.error);
      if (status > 0 || last.ok) return last;
      if (parsed.error && !/_missing$/.test(String(parsed.error))) return last;
    } catch (err) {
      last = fetchLike(0, '', err.message || 'python_bad_output');
    }
  }
  return last;
}

async function medicareGovFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'POST') return fetch(url, options);
  const curl = await curlFetch(url, options);
  if (curl.ok) return curl;
  const py = await pythonUrllibFetch(url, options);
  if (py.ok || py.status > 0) return py;
  if (curl.status > 0) return curl;
  return fetchLike(0, '', 'medicare_gov_transport_unavailable');
}

function cmsContractParts(planId) {
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  const [contractId, pbp] = parsed.base.split('-');
  return { contractId, planId: pbp, segmentId: '0' };
}

function relatedRxnormConcepts(payload) {
  const groups = payload?.relatedGroup?.conceptGroup || [];
  const out = [];
  for (const group of groups) {
    for (const c of group.conceptProperties || []) {
      out.push({
        rxcui: String(c.rxcui || ''),
        name: c.name || '',
        tty: group.tty || c.tty || '',
      });
    }
  }
  return out.filter((c) => c.rxcui);
}

function scoreRelatedConcept(concept, query) {
  const name = String(concept.name || '').toLowerCase();
  const q = String(query || '').toLowerCase().trim();
  let score = 0;
  if (/oral tablet/.test(name)) score += 20;
  if (/oral/.test(name)) score += 5;
  if (/(amlodipine|ezetimibe|caduet|vytorin)/.test(name) && !/(amlodipine|ezetimibe)/.test(q)) {
    score -= 40;
  }
  if (q && name.includes(q)) score += 10;
  if (q && new RegExp(`${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+ mg oral tablet`).test(name)) {
    score += 25;
  }
  if (concept.tty === 'SCD' && /generic|statin|pril|sartan|olol/.test(q)) score += 5;
  if (concept.tty === 'SBD' && /trintellix|lipitor|eliquis|jardiance|ozempic/.test(q)) score += 8;
  return score;
}

function rankNdcs(ndcs) {
  return [...ndcs].sort((a, b) => {
    const score = (n) => {
      const s = String(n);
      if (/30$/.test(s)) return 3;
      if (/90$/.test(s)) return 2;
      if (/07$/.test(s)) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
}

function normalizeNdc(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `0${digits}`;
  if (digits.length === 11) return digits;
  return digits || null;
}

async function autocompleteMedicareGov(name, fetchImpl = fetch) {
  if (!name) return { drugs: [], error: 'medicare_gov_no_name', status: 0 };
  const res = await fetchJson(
    `${MEDICARE_GOV_BASE}/drugs/autocomplete?name=${encodeURIComponent(String(name).trim())}`,
    { headers: medicareGovHeaders() },
    fetchImpl
  );
  if (!res.ok) {
    return { drugs: [], error: res.error || `medicare_gov_autocomplete_http_${res.status}`, status: res.status };
  }
  const list = res.json?.drugs || [];
  return { drugs: Array.isArray(list) ? list : [], error: null, status: res.status };
}

async function ndcsForRxcui(rxcui, fetchImpl = fetch) {
  if (!rxcui) return [];
  const res = await fetchJson(
    `${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`,
    { headers: { Accept: 'application/json' } },
    fetchImpl
  );
  const list = res.json?.ndcGroup?.ndcList?.ndc || [];
  return Array.isArray(list) ? list.map((n) => normalizeNdc(n)).filter(Boolean) : [];
}

async function resolveMedicareGovNdcs({ drugName, ndc }, fetchImpl = fetch) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const n = normalizeNdc(value);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  if (ndc) push(ndc);

  const auto = await autocompleteMedicareGov(drugName || '', fetchImpl);
  const match = pickCatalogMatch(
    (auto.drugs || []).map((d) => ({ name: d.name, rxcui: d.rxcui, id: d.rxcui })),
    drugName
  );
  const rxcui = match?.rxcui || auto.drugs?.[0]?.rxcui || null;
  const resolvedName = match?.name || auto.drugs?.[0]?.name || drugName;

  if (rxcui) {
    const rel = await fetchJson(
      `${RXNORM_BASE}/rxcui/${encodeURIComponent(rxcui)}/related.json?tty=SCD+SBD`,
      { headers: { Accept: 'application/json' } },
      fetchImpl
    );
    const concepts = relatedRxnormConcepts(rel.json)
      .map((c) => ({ ...c, score: scoreRelatedConcept(c, drugName || resolvedName) }))
      .sort((a, b) => b.score - a.score);
    const toTry = [{ rxcui: String(rxcui), name: resolvedName, score: 0 }, ...concepts].slice(0, 8);
    for (const concept of toTry) {
      const ndcs = rankNdcs(await ndcsForRxcui(concept.rxcui, fetchImpl)).slice(0, 3);
      ndcs.forEach(push);
      if (out.length >= 8) break;
    }
  }

  return {
    ndcs: out.slice(0, 8),
    rxcui: rxcui ? String(rxcui) : null,
    name: resolvedName || drugName,
    error: out.length ? null : auto.error || 'medicare_gov_no_ndc',
  };
}

function extractMedicareGovCost(payload, planId, year) {
  const parts = cmsContractParts(planId);
  if (!parts) return { miss: 'bad_plan_id' };
  const y = String(year);
  const plans = payload?.plans || [];
  const row = plans.find((p) => {
    const pl = p.plan || p;
    return (
      String(pl.contract_id || '').toUpperCase() === parts.contractId &&
      String(pl.plan_id || '') === parts.planId &&
      String(pl.contract_year || '') === y
    );
  });
  if (!row) return { miss: 'plan_mismatch' };
  const blob = JSON.stringify(row.restrictions || []);
  const pa = /prior\s*auth/i.test(blob) ? true : null;
  const st = /step\s*ther/i.test(blob) ? true : null;
  const ql = /quantity/i.test(blob) ? true : null;
  for (const cost of row.costs || []) {
    for (const dc of cost.drug_costs || []) {
      const reason = String(dc.coverage_reason || '').toUpperCase();
      const tier = parseTierNumber(dc.tier);
      if (dc.covered === false || reason === 'NOT_COVERED' || reason === 'NON_FORMULARY') {
        return { coverage: 'not_covered', tier: null, pa, st, ql, ndc: dc.ndc || null };
      }
      if (tier) {
        return { coverage: 'covered', tier, pa, st, ql, ndc: dc.ndc || null };
      }
    }
  }
  return { miss: 'empty_costs' };
}

async function lookupMedicareGov({ drugName, ndc, planId, year }, fetchImpl = medicareGovFetch) {
  const y = Number(year) || PLAN_YEAR;
  const parts = cmsContractParts(planId);
  if (!parts) return { verified: false, reason: 'medicare_gov_bad_plan_id', source: 'medicare_gov' };

  const resolved = await resolveMedicareGovNdcs({ drugName, ndc }, fetchImpl);
  if (!resolved.ndcs.length) {
    return {
      verified: false,
      reason: resolved.error || 'medicare_gov_no_ndc',
      source: 'medicare_gov',
    };
  }

  let lastError = null;
  for (const useNdc of resolved.ndcs.slice(0, 5)) {
    const res = await fetchJson(
      `${MEDICARE_GOV_BASE}/drugs/cost`,
      {
        method: 'POST',
        headers: medicareGovHeaders(),
        body: JSON.stringify({
          npis: [],
          prescriptions: [{ ndc: useNdc, quantity: '30', frequency: 'FREQUENCY_30_DAYS' }],
          lis: 'LIS_NO_HELP',
          full_year: false,
          retailOnly: false,
          plans: [
            {
              contract_id: parts.contractId,
              plan_id: parts.planId,
              segment_id: parts.segmentId,
              contract_year: String(y),
            },
          ],
        }),
      },
      fetchImpl,
      15_000
    );
    if (!res.ok || !res.json) {
      lastError = res.error || `medicare_gov_http_${res.status}`;
      continue;
    }
    const hit = extractMedicareGovCost(res.json, planId, y);
    if (hit.coverage === 'not_covered') {
      return {
        verified: true,
        coverage: 'not_covered',
        tier: null,
        pa: hit.pa,
        st: hit.st,
        ql: hit.ql,
        source: 'medicare_gov',
        ndc: hit.ndc || useNdc,
        rxcui: resolved.rxcui,
        drugName: resolved.name || drugName,
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
        source: 'medicare_gov',
        ndc: hit.ndc || useNdc,
        rxcui: resolved.rxcui,
        drugName: resolved.name || drugName,
      };
    }
    lastError = hit.miss ? `medicare_gov_${hit.miss}` : 'medicare_gov_no_tier';
  }

  return { verified: false, reason: lastError || 'medicare_gov_no_tier', source: 'medicare_gov' };
}

function costSharePlanCandidates(planId, year) {
  const parsed = parseCmsId(planId);
  if (!parsed) return [];
  const out = [parsed.full, parsed.base];
  if (Number(year) === 2027 && isDoctorsCms(planId)) {
    for (const alias of doctorsPbpAliases(parsed.base, year)) out.push(alias);
  }
  return [...new Set(out.map((id) => String(id).toUpperCase()))];
}

function costShareFromKnowledge(planId, year, tier) {
  if (!tier || Number(year) !== 2027) return null;
  const parsed = parseCmsId(planId);
  if (!parsed) return null;
  const candidates = costSharePlanCandidates(planId, year);
  for (const key of KB_2027_KEYS) {
    const doc = getKnowledgeByKey(key);
    if (!doc) continue;
    const sections = doc.split(/^## /m);
    const hits = sections.filter((s) => {
      const upper = s.toUpperCase();
      return candidates.some((id) => upper.includes(id)) && /\|\s*Tier\s*1\s*\|/i.test(s);
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

/** Known brand → generic names only. Never attach a tier here. */
const BRAND_TO_GENERIC = {
  lipitor: 'Atorvastatin',
  benicar: 'Olmesartan',
  crestor: 'Rosuvastatin',
  zocor: 'Simvastatin',
  pravachol: 'Pravastatin',
  nexium: 'Esomeprazole',
  prilosec: 'Omeprazole',
  protonix: 'Pantoprazole',
  plavix: 'Clopidogrel',
  norvasc: 'Amlodipine',
  cozaar: 'Losartan',
  diovan: 'Valsartan',
};

function brandKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function knownGenericFor(drugName) {
  const key = brandKey(drugName);
  if (!key) return null;
  if (BRAND_TO_GENERIC[key]) return BRAND_TO_GENERIC[key];
  const stripped = key.replace(/generic$/, '');
  return BRAND_TO_GENERIC[stripped] || null;
}

function brandVerifiedNotCovered(lookups) {
  return (lookups || []).some((row) => row && row.verified && row.coverage === 'not_covered');
}

function starBrandName(name) {
  const s = String(name || '').replace(/\*+$/, '').trim();
  return s ? `${s}*` : name;
}

/**
 * Look up one drug against one or more plans.
 * claimedTier is accepted for API compatibility and discarded immediately.
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
    skipGenericFollowup = false,
  } = {},
  fetchImpl = fetch
) {
  const y = Number(year) || PLAN_YEAR;
  void claimedTier;
  const ids = [...(planId ? [planId] : []), ...(Array.isArray(planIds) ? planIds : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const uniqueIds = [];
  for (const id of ids) {
    if (!uniqueIds.some((u) => cmsIdsMatch(u, id))) uniqueIds.push(id);
  }

  const catalog = await searchSunfireCatalog(drugName || ndc, fetchImpl);
  const ranked = rankCatalogMatches(catalog.drugs, drugName || ndc);
  let match = ranked[0] || null;
  let resolvedName = match?.name || drugName || ndc || 'Unknown drug';
  let resolvedNdc = ndc || match?.ndc || null;

  let byPlanId = {};
  let lookups = [];

  if (!uniqueIds.length) {
    return {
      drugName: resolvedName,
      ndc: resolvedNdc,
      year: y,
      claimedTier: null,
      claimedTierDiscarded: true,
      catalog: catalog.drugs.slice(0, 10),
      catalogError: catalog.error,
      lookups: [],
      byPlanId,
      verifiedAny: false,
    };
  }

  async function lookupPlans(match, resolvedName, resolvedNdc) {
    const byPlanId = {};
    const lookups = [];
    for (const id of uniqueIds) {
      const planObj = (plans || []).find((p) => cmsIdsMatch(p.planId || p.id, id));
      let hit = null;
      const reasons = [];

      const sunfire = await lookupSunfireCoverage(
        { drug: match || { name: resolvedName, ndc: resolvedNdc }, planId: id, year: y },
        fetchImpl
      );
      if (sunfire.verified) hit = sunfire;
      else if (sunfire.reason && sunfire.reason !== 'sunfire_creds_missing') reasons.push(sunfire.reason);

      if (!hit || !hit.verified) {
        const fhir = await lookupHumanaFhir(
          { drugName: resolvedName, ndc: resolvedNdc, planId: id, year: y },
          fetchImpl
        );
        if (fhir.verified) hit = fhir;
        else if (fhir.reason && fhir.reason !== 'not_humana') reasons.push(fhir.reason);
      }

      if (!hit || !hit.verified) {
        const medicareFetch = fetchImpl === fetch ? medicareGovFetch : fetchImpl;
        const mpf = await lookupMedicareGov(
          { drugName: resolvedName, ndc: resolvedNdc, planId: id, year: y },
          medicareFetch
        );
        if (mpf.verified) hit = mpf;
        else if (mpf.reason) reasons.push(mpf.reason);
      }

      if (!hit || !hit.verified) {
        const consumer = await lookupConsumerFormulary(
          { drugName: resolvedName, ndc: resolvedNdc, planId: id, year: y },
          fetchImpl
        );
        if (consumer.verified) hit = consumer;
        else if (consumer.reason && consumer.reason !== 'not_doctors' && consumer.reason !== 'no_consumer_source') {
          reasons.push(consumer.reason);
        }
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
          formularyPlanId: hit.formularyPlanId || null,
        };
        byPlanId[displayId] = row;
        lookups.push(row);
      } else {
        const row = {
          ...emptyPlanResult(id, y, reasons.join('|') || (hit && hit.reason) || catalog.error || 'unverified'),
          note: hit && hit.note ? hit.note : undefined,
        };
        byPlanId[displayId] = row;
        lookups.push(row);
      }
    }
    return { byPlanId, lookups };
  }

  ({ byPlanId, lookups } = await lookupPlans(match, resolvedName, resolvedNdc));

  // One odd catalog product (injection, capsule, different strength) can read
  // "not covered" everywhere for a drug every formulary carries (levothyroxine,
  // HCTZ). Before saying not covered, retry the next best products.
  let retriedProduct = null;
  let notCoveredNote = null;
  const allNotCovered = (rows) => rows.length > 0 && rows.every((r) => r.verified && r.coverage === 'not_covered');
  if (!ndc && allNotCovered(lookups) && !knownGenericFor(drugName)) {
    const base = String(drugName || '').toLowerCase().split(/\s+/)[0];
    const alternates = ranked
      .slice(1)
      .filter((d) => String(d.name || '').toLowerCase().startsWith(base) && d.name !== match?.name)
      .slice(0, 2);
    for (const alt of alternates) {
      const tryRun = await lookupPlans(alt, alt.name, alt.ndc || null);
      if (tryRun.lookups.some((r) => r.verified && r.coverage !== 'not_covered')) {
        retriedProduct = { from: resolvedName, to: alt.name };
        match = alt;
        resolvedName = alt.name;
        resolvedNdc = alt.ndc || null;
        ({ byPlanId, lookups } = tryRun);
        break;
      }
    }
    if (!retriedProduct) {
      notCoveredNote = `"${resolvedName}" read not covered on every plan, including ${alternates.length} other catalog product(s). Confirm the exact product/strength in Sunfire before telling the client — most formularies cover the common generic.`;
    }
  }

  const result = {
    drugName: resolvedName,
    ndc: resolvedNdc,
    year: y,
    claimedTier: null,
    claimedTierDiscarded: true,
    catalog: catalog.drugs.slice(0, 10),
    catalogError: catalog.error,
    lookups,
    byPlanId,
    verifiedAny: lookups.some((l) => l.verified),
    suggestedGeneric: null,
    genericFollowup: null,
    retriedProduct,
    notCoveredNote,
  };

  const genericName = knownGenericFor(drugName) || knownGenericFor(resolvedName);
  if (!skipGenericFollowup && genericName && brandVerifiedNotCovered(lookups)) {
    const generic = await lookupFormulary(
      {
        drugName: genericName,
        planIds: uniqueIds,
        year: y,
        plans,
        skipGenericFollowup: true,
      },
      fetchImpl
    );
    result.suggestedGeneric = genericName;
    result.genericFollowup = generic;
  }

  return result;
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
  if (result.retriedProduct) {
    lines.push(`Note: the first catalog product (${result.retriedProduct.from}) read not covered; re-checked as ${result.retriedProduct.to}. Quote this result.`);
  }
  if (result.notCoveredNote) {
    lines.push(`UNVERIFIED NOT-COVERED: ${result.notCoveredNote} Tell the agent to confirm — do NOT state "not covered" as fact.`);
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
      lines.push(`${row.planId}: verified not covered (${row.source}).`);
    } else {
      lines.push(`${row.planId}: UNVERIFIED${row.reason ? ` (${row.reason})` : ''}.`);
      if (row.note) lines.push(`  ${row.note}`);
    }
    lines.push(formatPlanLookupLine(result.drugName, row));
  }

  if (result.suggestedGeneric) {
    lines.push('');
    lines.push(
      `Suggested generic for ${starBrandName(result.drugName)}: ${result.suggestedGeneric}. Do not wait for the agent to type the generic. Show the brand as not covered with the asterisk note. Quote a generic tier only from the live follow-up — never invent a tier.`
    );
    if (result.genericFollowup) {
      lines.push(formatFormularyText(result.genericFollowup));
    } else {
      lines.push(
        `${result.suggestedGeneric}: UNVERIFIED (no live generic follow-up). Do not invent a tier.`
      );
    }
  }
  return lines.join('\n');
}

function toExportDrug(result) {
  if (!result) return null;
  const generic = knownGenericFor(result.drugName);
  const notCovered = brandVerifiedNotCovered(result.lookups);
  return {
    name: generic && notCovered ? starBrandName(result.drugName) : result.drugName,
    ndc: result.ndc || '',
    byPlanId: result.byPlanId,
    brandNotCovered: Boolean(generic && notCovered),
    suggestedGeneric: result.suggestedGeneric || null,
  };
}

function toExportDrugs(result) {
  if (!result) return [];
  const brand = toExportDrug(result);
  const out = brand ? [brand] : [];
  if (result.suggestedGeneric) {
    const g = result.genericFollowup;
    out.push({
      name: `${result.suggestedGeneric} (generic)`,
      ndc: (g && g.ndc) || '',
      genericOf: String(result.drugName || '').replace(/\*+$/, ''),
      byPlanId: (g && g.byPlanId) || {},
    });
  }
  return out;
}

module.exports = {
  PLAN_YEAR,
  SUNFIRE_BASE,
  HUMANA_FHIR,
  MEDICARE_GOV_BASE,
  RXNORM_BASE,
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
  cmsContractParts,
  scoreRelatedConcept,
  rankNdcs,
  extractMedicareGovCost,
  costShareFromKnowledge,
  costShareFromPlanObject,
  lookupFormulary,
  lookupSunfireCoverage,
  lookupHumanaFhir,
  lookupMedicareGov,
  lookupConsumerFormulary,
  costSharePlanCandidates,
  medicareGovFetch,
  curlFetch,
  pythonUrllibFetch,
  searchSunfireCatalog,
  formatFormularyText,
  formatPlanLookupLine,
  toExportDrug,
  toExportDrugs,
  knownGenericFor,
  BRAND_TO_GENERIC,
  hasSunfireCreds,
};
