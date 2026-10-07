// services/providerNetwork.js — lookup_provider_network engine.
//
// Padron-style asks (8 doctors + ZIP in one send) used to run every doctor,
// every NPI and Sunfire one after another, so /chat hit its deadline before
// half the doctors finished. This module:
//   - runs all doctors in a batch at once, and all NPIs of a doctor at once
//   - runs FHIR / Doctors / Aetna / Simply / UHC / Humana / Sunfire side by side
//   - bounds everything by an absolute deadline and returns a partial result
//     (finished carriers + "NOT CONFIRMED" for the rest) instead of hanging
//   - caches finished doctors for 30 min, and lets a lookup that was cut off
//     keep running in the background so "send the same ask again" is instant.
// A failed or timed-out check is never out-of-network.

const { queryDoctorsHcp, PLAN_LABEL: DOCTORS_PLAN_LABEL } = require('./doctorsHcp');
const { queryAetnaPublic, CARRIER_LABEL: AETNA_PLAN_LABEL } = require('./aetnaPublicSearch');
const { querySimplyFindcare, CARRIER_LABEL: SIMPLY_PLAN_LABEL } = require('./simplyFindcare');
const {
  queryUhcGuest,
  CARRIER_LABEL: UHC_PLAN_LABEL,
  PLAN_YEAR: UHC_PLAN_YEAR,
  formatUhcAgentNote,
} = require('./uhcGuestSearch');
const {
  queryHumanaFindcare,
  CARRIER_LABEL: HUMANA_PLAN_LABEL,
  isHumanaLabel,
  formatHumanaAgentNote,
} = require('./humanaFindcare');
const solisDirectory = require('./solisDirectory');
const { formatSolisNote } = solisDirectory;
const SOLIS_COUNTY = solisDirectory.COUNTY_LABEL || {};
const SOLIS_LABEL = 'Solis Health Plans';
const careplusDirectory = require('./careplusDirectory');
const CAREPLUS_LABEL = 'CarePlus';
const CAREPLUS_COUNTY = careplusDirectory.COUNTY_LABEL;
const CAREPLUS_UNAVAILABLE = { status: 'unavailable', inNetwork: false, matches: [], partialList: true };
function careplusFor(rec, zip, planYear) {
  if (Number(planYear) === 2026) return CAREPLUS_UNAVAILABLE;
  try {
    return careplusDirectory.careplusCheck({ firstName: rec.firstName, middleName: rec.middleName, lastName: rec.lastName, zip });
  } catch (_) {
    return CAREPLUS_UNAVAILABLE;
  }
}
const SOLIS_UNAVAILABLE = { status: 'unavailable', inNetwork: false, matches: [] };
function solisFor(rec, zip, planYear) {
  if (Number(planYear) === 2026 || typeof solisDirectory.solisCheck !== 'function') return SOLIS_UNAVAILABLE;
  try {
    return solisDirectory.solisCheck({ firstName: rec.firstName, middleName: rec.middleName, lastName: rec.lastName, zip });
  } catch (_) {
    return SOLIS_UNAVAILABLE;
  }
}
const { resolveNpiRecords, displayName, allLocationAddresses, cleanDoctorQuery, suggestSimilarProviders } = require('./npiRegistry');
const { conversationAskText } = require('./planYear');
const { batchSummaryForModel, narrowingAnswered, comparisonAskText, selectComparison } = require('./doctorPlanNarrow');
const { medsFromAsk } = require('./comparisonRules');
// Time held back from the doctor checks so listed meds still get priced in the same chat turn.
const MEDS_RESERVE_MS = Number(process.env.MAX_CHAT_MEDS_RESERVE_MS || 20_000);
const {
  querySunfireProviderList,
  inNetworkLabelsFromSunfirePlans,
} = require('./sunfireProvider');

let SUNFIRE_PLAN_MAP = {};
try {
  SUNFIRE_PLAN_MAP = require('./sunfire-id-map.json');
} catch (_) {
  SUNFIRE_PLAN_MAP = {};
}

const { devotedNetworkRefs, devotedPlanVerdicts, devotedPlanNetwork } = require('./devotedNetworks');

const FHIR_CARRIERS = [
  { name: 'Florida Blue', key: 'flblue', base: 'https://apigw.bcbsfl.com/interop/interop-developer-portal/emr/api/v1/fhir' },
  { name: 'Cigna', key: 'cigna', base: 'https://fhir.cigna.com/ProviderDirectory/v1' },
  { name: 'HealthSun', key: 'healthsun', base: 'https://api.aaneelconnect.com/cms/r4/providerdirectory', extra: 'payer-id=8d4e5e9ec9c64b1a9db68fbec4bd6f95' },
  { name: 'Devoted Health', key: 'devoted', base: 'https://fhir.devoted.com/fhir' },
];

const SINGLE_NPI_CAP = Number(process.env.MAX_PROVIDER_NPI_CAP || 3);
const BATCH_NPI_CAP = Number(process.env.MAX_PROVIDER_BATCH_NPI_CAP || 2);
const BATCH_MAX_DOCTORS = Number(process.env.MAX_PROVIDER_BATCH_MAX || 12);
const CARRIER_CONCURRENCY = Number(process.env.MAX_PROVIDER_CARRIER_CONCURRENCY || 8);
const SUNFIRE_TIMEOUT_MS = Number(process.env.MAX_SUNFIRE_PROVIDER_DOCTOR_TIMEOUT_MS || 6000);
const CACHE_TTL_MS = Number(process.env.MAX_PROVIDER_CACHE_MS || 30 * 60 * 1000);
const DEFAULT_BUDGET_MS = 60_000;

const NOT_CONFIRMED = 'NOT CONFIRMED';
// Log every directory answer (status + hit count) — set MAX_DIRECTORY_DEBUG=1 on Railway.
const DIRECTORY_DEBUG = /^(1|true|yes)$/i.test(String(process.env.MAX_DIRECTORY_DEBUG || ''));

function sunfireEnabled() {
  return String(process.env.MAX_SUNFIRE_PROVIDER_LOOKUP || 'on').toLowerCase() !== 'off';
}

// ─── small helpers ──────────────────────────────────────────────────────────

/** Simple per-key concurrency limiter so 8 doctors × 2 NPIs don't open 16 Humana searches at once. */
function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    // Lowest priority number first (each doctor's best NPI = 0), FIFO within a priority.
    let pick = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[pick].priority) pick = i;
    const { fn, resolve, reject } = queue.splice(pick, 1)[0];
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn, priority = 0) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject, priority: Number(priority) || 0 });
    next();
  });
}

const limiters = {};
// Doctors HealthCare rejects bursts (HTTP 404) — keep its calls to a trickle.
const PER_CARRIER_CONCURRENCY = { doctors: Number(process.env.MAX_DOCTORS_HCP_CONCURRENCY || 2) };
function limited(key, fn, priority = 0) {
  if (!limiters[key]) limiters[key] = createLimiter(Math.max(1, PER_CARRIER_CONCURRENCY[key] || CARRIER_CONCURRENCY));
  return limiters[key](fn, priority);
}

/** Resolve with `promise`, or with `onTimeout()` once `deadlineAt` passes. The promise keeps running. */
function raceDeadline(promise, deadlineAt, onTimeout) {
  const ms = Math.max(0, deadlineAt - Date.now());
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeNpi(value) {
  const m = String(value || '').match(/\b(\d{10})\b/);
  return m ? m[1] : '';
}

// ─── cache ──────────────────────────────────────────────────────────────────

const cache = new Map();

function cacheKey({ doctorName, npi, zip, year, planId }) {
  // "HOWARD BUSH M.D." and "Howard Bush Cardio" share one entry.
  const who = normalizeNpi(npi) || normalizeNpi(doctorName) || cleanDoctorQuery(doctorName).toLowerCase();
  return [who, String(zip || ''), String(year || ''), String(planId || '').toUpperCase()].join('|');
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > 500) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function clearProviderCache() {
  cache.clear();
}

// ─── per-NPI carrier fan-out ────────────────────────────────────────────────

/**
 * FHIR directory check for one NPI. Returns { hits, failed }: a carrier that
 * answered 200 with zero entries is a real miss; a carrier that errored or timed
 * out is `failed` (shown ❔ unchecked, never Out).
 */
async function fhirCheck(npi) {
  const hits = [];
  const failed = [];
  // Devoted: which networks the doctor's roles link to (null = check failed / not run).
  let devotedNetworks = null;
  await Promise.all(FHIR_CARRIERS.map(async (carrier) => {
    try {
      const devoted = carrier.key === 'devoted';
      let url = carrier.extra
        ? `${carrier.base}/PractitionerRole?practitioner.identifier=${npi}&${carrier.extra}`
        : `${carrier.base}/PractitionerRole?practitioner.identifier=${npi}`;
      // Devoted lists one role per network × location (50+ for a busy doctor): page through so
      // every network is seen — a plan counts as In only when its own network is linked.
      if (devoted) url += '&_count=100';
      const r = await fetch(url, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) {
        console.warn(`[fhir] ${carrier.key} HTTP ${r.status} npi=${npi}`);
        failed.push(carrier.name);
        return;
      }
      const fd = await r.json();
      const n = Math.max(Number(fd.total) || 0, (fd.entry || []).length);
      if (DIRECTORY_DEBUG) console.log(`[fhir] ${carrier.key} 200 entries=${n} npi=${npi}`);
      if (n > 0) hits.push(carrier.name);
      if (devoted) {
        const refs = new Set(devotedNetworkRefs(fd));
        let next = ((fd.link || []).find((l) => l && l.relation === 'next') || {}).url;
        let pages = 1;
        let complete = true;
        while (next && pages < 5) {
          pages += 1;
          try {
            const rr = await fetch(next, { headers: { Accept: 'application/fhir+json' }, signal: AbortSignal.timeout(8000) });
            if (!rr.ok) { complete = false; break; }
            const page = await rr.json();
            devotedNetworkRefs(page).forEach((x) => refs.add(x));
            next = ((page.link || []).find((l) => l && l.relation === 'next') || {}).url;
          } catch (_) {
            complete = false;
            break;
          }
        }
        if (next) complete = false;
        // A partial read could miss the C-SNP role — then no plan-level Out, only what was seen as In.
        devotedNetworks = { refs: [...refs], complete };
      }
    } catch (err) {
      console.warn(`[fhir] ${carrier.key} ${err.name === 'TimeoutError' || err.name === 'AbortError' ? 'Timeout' : err.message} npi=${npi}`);
      failed.push(carrier.name);
    }
  }));
  const order = FHIR_CARRIERS.map((c) => c.name);
  return { hits: order.filter((n) => hits.includes(n)), failed: order.filter((n) => failed.includes(n)), devotedNetworks };
}

async function fhirHits(npi) {
  return (await fhirCheck(npi)).hits;
}

function npiRecordInfo(p) {
  const pName = displayName(p) || [p.basic?.first_name, p.basic?.middle_name, p.basic?.last_name].filter(Boolean).join(' ');
  const spec = (p.taxonomies || []).find((t) => t.primary)?.desc || 'Unknown';
  const locs = allLocationAddresses(p);
  const addr = locs[0] || {};
  const address = locs.length
    ? locs.map((a) => `${a.address_1 || ''}, ${a.city || ''}, FL ${String(a.postal_code || '').slice(0, 5)}`.trim()).join(' | ')
    : `${addr.address_1 || ''}, ${addr.city || ''}, FL ${addr.postal_code || ''}`.trim();
  return {
    name: pName,
    npi: p.number,
    specialty: spec,
    address,
    lastName: p.basic?.last_name || p.basic?.organization_name || '',
    firstName: p.basic?.first_name || '',
    middleName: p.basic?.middle_name || '',
  };
}

/**
 * Starts every carrier check for one NPI. Returns a live `state` object whose
 * fields fill in as each carrier answers, plus `done` (all settled).
 */
function startNpiChecks(rec, { zip, planYear, guestPlanIds, rank = 0 }) {
  const state = {
    ...rec,
    // Solis: name match against the 2027 county directory index (local file, instant).
    solisResult: solisFor(rec, zip, planYear),
    careplusResult: careplusFor(rec, zip, planYear),
    fhir: undefined,
    fhirFailed: [],
    doctorsResult: undefined,
    aetnaResult: undefined,
    simplyResult: undefined,
    uhcResult: undefined,
    humanaResult: undefined,
  };
  const npi = rec.npi;
  const track = (field, promise, fallback) => promise
    .then((v) => { state[field] = v; }, () => { state[field] = fallback; });
  const done = Promise.all([
    limited('fhir', () => fhirCheck(npi), rank).then(
      (v) => { state.fhirFailed = v.failed; state.fhir = v.hits; state.devotedNetworks = v.devotedNetworks || null; },
      () => { state.fhirFailed = FHIR_CARRIERS.map((c) => c.name); state.fhir = []; },
    ),
    track('doctorsResult', limited('doctors', () => queryDoctorsHcp(npi), rank), { inNetwork: false, error: 'request_failed' }),
    track('aetnaResult', limited('aetna', () => queryAetnaPublic(npi, { zip, lastName: rec.lastName, year: planYear }), rank), { inNetwork: false, plans: [], error: 'request_failed' }),
    track('simplyResult', limited('simply', () => querySimplyFindcare(npi, { zip, lastName: rec.lastName }), rank), { inNetwork: false, plans: [], error: 'request_failed' }),
    track('uhcResult', limited('uhc', () => queryUhcGuest(npi, { zip, year: planYear, planIds: guestPlanIds }), rank), { inNetwork: false, plans: [], outOfNetworkPlans: [], error: 'request_failed', year: String(planYear) }),
    track('humanaResult', limited('humana', () => queryHumanaFindcare(npi, { zip, year: planYear, planIds: guestPlanIds }), rank), { inNetwork: false, plans: [], outOfNetworkPlans: [], error: 'request_failed', year: String(planYear) }),
  ]);
  return { state, done };
}

const TIMED_OUT = { inNetwork: false, plans: [], outOfNetworkPlans: [], error: 'timeout' };

/**
 * Devoted plan verdicts from a finished FHIR read. Out is only claimed when every
 * page was read; a partial read keeps just the Ins it saw.
 */
function devotedVerdictsFor(state, planYear) {
  const dn = state && state.devotedNetworks;
  if (!dn || (state.fhirFailed || []).includes('Devoted Health')) return null;
  const v = devotedPlanVerdicts(dn.refs || [], planYear);
  if (!v) return null;
  return dn.complete === false ? { inPlans: v.inPlans, outPlans: [] } : v;
}

/** Snapshot a (possibly unfinished) NPI state into the classic providerResults shape. */
function summarizeNpi(state, planYear) {
  const inNetworkFor = [...(state.fhir || [])];
  const pending = [];
  const pick = (field, label) => {
    const v = state[field];
    if (v === undefined) {
      pending.push(label);
      return { ...TIMED_OUT, year: String(planYear) };
    }
    return v;
  };
  if (state.fhir === undefined) pending.push('FHIR (FL Blue / Cigna / HealthSun / Devoted)');
  const doctorsResult = pick('doctorsResult', 'Doctors HealthCare Plans');
  const aetnaResult = pick('aetnaResult', 'Aetna guest search');
  const simplyResult = pick('simplyResult', 'Simply Find Care');
  const uhcResult = pick('uhcResult', 'UHC guest Find a Doctor');
  const humanaResult = pick('humanaResult', 'Humana Find Care');

  if (doctorsResult.inNetwork && !inNetworkFor.includes(DOCTORS_PLAN_LABEL)) inNetworkFor.push(DOCTORS_PLAN_LABEL);
  const solisResult = state.solisResult || SOLIS_UNAVAILABLE;
  if (solisResult.inNetwork && !inNetworkFor.includes(SOLIS_LABEL)) inNetworkFor.push(SOLIS_LABEL);
  const careplusResult = state.careplusResult || CAREPLUS_UNAVAILABLE;
  if (careplusResult.inNetwork && !inNetworkFor.includes(CAREPLUS_LABEL)) inNetworkFor.push(CAREPLUS_LABEL);
  for (const [res, fallbackLabel] of [[aetnaResult, AETNA_PLAN_LABEL], [simplyResult, SIMPLY_PLAN_LABEL]]) {
    if (!res.error && res.inNetwork) {
      for (const plan of res.plans || []) if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
      if (!(res.plans || []).length && !inNetworkFor.includes(fallbackLabel)) inNetworkFor.push(fallbackLabel);
    }
  }
  for (const res of [uhcResult, humanaResult]) {
    if (!res.error && res.inNetwork) {
      for (const plan of res.plans || []) if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);
    }
  }
  // Devoted plan-level: In only on plans whose network the doctor is linked to.
  const devoted = devotedVerdictsFor(state, planYear);
  if (devoted) for (const plan of devoted.inPlans) if (!inNetworkFor.includes(plan)) inNetworkFor.push(plan);

  const lookupErrors = [];
  // FHIR carriers that errored are failed checks (❔ unchecked), not misses.
  for (const name of state.fhirFailed || []) lookupErrors.push(`${name} (FHIR)`);
  if (doctorsResult.error) lookupErrors.push('Doctors HealthCare Plans');
  if (aetnaResult.error) lookupErrors.push('Aetna guest search');
  // Simply has no core plan in Miami-Dade/Broward (only a D-SNP), so a failed Simply check is not worth
  // surfacing as an "unchecked" carrier (Yahoska, 2026-10-07). The result still rides along for D-SNP asks.
  if (uhcResult.error) lookupErrors.push('UHC guest Find a Doctor');
  if (humanaResult.error) lookupErrors.push('Humana Find Care');
  const checkedGuest = ['FL Blue', 'Cigna', 'HealthSun', 'Devoted', 'Doctors'];
  if (!aetnaResult.error) checkedGuest.push('Aetna guest search');
  if (!simplyResult.error) checkedGuest.push('Simply Find Care');
  checkedGuest.push('UHC guest Find a Doctor');
  checkedGuest.push('Humana Find Care');

  return {
    name: state.name,
    npi: state.npi,
    specialty: state.specialty,
    address: state.address,
    inNetworkFor,
    lookupErrors,
    checkedGuest,
    pending,
    aetnaResult,
    uhcResult,
    humanaResult,
    solisResult,
    careplusResult,
    devotedResult: devoted,
  };
}

// ─── one doctor ─────────────────────────────────────────────────────────────

function formatDoctorText({ doctorName, zip, planYear, providerResults, sunfire, timedOut }) {
  let out = `Provider network results for "${doctorName}":\n\n`;
  for (const pr of providerResults) {
    out += `**${pr.name}** (NPI: ${pr.npi})\n`;
    out += `Specialty: ${pr.specialty}\n`;
    out += `Address: ${pr.address}\n`;
    const allNetworks = [...pr.inNetworkFor];
    const missList = (pr.checkedGuest || []).join(', ');
    out += allNetworks.length
      ? `In-network for: ${allNetworks.join(', ')}\n`
      : `Not found in ${missList} (a miss on FHIR/Doctors/Aetna/Simply is not a UHC or Humana answer).\n`;
    if (pr.devotedResult && pr.devotedResult.outPlans.length) {
      const idOf = (l) => (String(l).match(/\((H\d{4}-\d{3})\)\s*$/) || [])[1] || l;
      const nets = (labels) => [...new Set(labels.map((l) => devotedPlanNetwork(idOf(l))).filter(Boolean))];
      const inNets = nets(pr.devotedResult.inPlans);
      out += `Devoted ${planYear} by plan network (each plan has ONE network; C-SNP plans use FL HMO C-SNP): `
        + `${inNets.length ? `linked to ${inNets.join(', ')}; ` : 'not linked to any FL Devoted network; '}`
        + `NOT linked to ${nets(pr.devotedResult.outPlans).join(', ')} → Out on ${pr.devotedResult.outPlans.map(idOf).join(', ')}.\n`;
    }
    if (pr.uhcResult && pr.uhcResult.error !== 'timeout') out += `${formatUhcAgentNote(pr.uhcResult)}\n`;
    if (pr.humanaResult && pr.humanaResult.error !== 'timeout') out += `${formatHumanaAgentNote(pr.humanaResult)}\n`;
    if (sunfire.labels.length > 0) {
      out += `Sunfire also listed (${sunfire.labels.length}; secondary, year ${planYear}):\n${sunfire.labels.map((p) => `  - ${p}`).join('\n')}\n`;
    } else if (sunfire.error === 'skipped') {
      out += 'Sunfire skipped for this doctor check (secondary only). Wellcare / CarePlus: check the carrier site.\n';
    } else if (sunfire.error) {
      out += `Sunfire provider lookup failed (${sunfire.error}) — empty/truncated Sunfire is not UHC or Humana out-of-network. Wellcare / CarePlus: check the carrier site.\n`;
    } else {
      out += process.env.SUNFIRE_SFP
        ? `Sunfire did not confirm additional plans for ${planYear}. Empty Sunfire is not UHC or Humana out-of-network.\n`
        : 'Sunfire session unavailable (secondary only). UHC uses public guest Find a Doctor. Humana uses public Find Care. Wellcare / CarePlus still need Sunfire or the carrier site.\n';
    }
    if (pr.pending && pr.pending.length) {
      out += `${NOT_CONFIRMED} (still running at the chat wait): ${pr.pending.join(', ')} — not out-of-network.\n`;
    }
    const realErrors = (pr.lookupErrors || []).filter((label) => !(pr.pending || []).includes(label));
    if (realErrors.length) {
      out += `Could not complete: ${realErrors.join(', ')} — that is not the same as out-of-network. Hand the agent the guest URL.\n`;
    }
    const sr = pr.solisResult;
    if (sr && sr.inNetwork) {
      out += `Solis 2027 directory: LISTED as ${sr.matches.map((m) => `${m.name} (${SOLIS_COUNTY[m.county] || m.county} PDF p. ${m.pages.join(', ')})`).join('; ')} — name match (the PDF has no NPIs).\n`;
    } else if (sr && sr.status === 'checked') {
      out += `Solis 2027 directory (${String(sr.county).split('+').map((k) => SOLIS_COUNTY[k] || k).join(' + ')}, current as of ${sr.asOf || 'Oct 2026'}): NOT listed — Out for Solis plans.\n`;
    } else {
      out += `${formatSolisNote(zip, planYear)}\n`;
    }
    const cr = pr.careplusResult;
    if (cr && cr.inNetwork) {
      out += `CarePlus 2027 directory: LISTED as ${cr.matches.map((m) => `${m.name} (${CAREPLUS_COUNTY[m.county] || m.county} PDF p. ${m.pages.join(', ')})`).join('; ')} — name match (the PDF has no NPIs).\n`;
    } else if (cr && cr.status === 'checked') {
      out += `CarePlus 2027 directory (${CAREPLUS_COUNTY[cr.county] || cr.county}, updated ${cr.asOf || 'Sep 2026'}): not listed — but the PDF is a PARTIAL list, so this is NOT Out. Confirm at CarePlusHealthPlans.com/FindCare.\n`;
    } else {
      out += 'CarePlus: no 2027 directory index for this county yet — check CarePlusHealthPlans.com/FindCare.\n';
    }
    out += '\n';
  }
  if (timedOut) {
    out += 'Some checks were still running when the chat wait hit — they keep running and are saved, so asking again returns them without starting over.\n';
  }
  out += 'Note: Cigna/HealthSpring directory hits are not a 2027 Miami-Dade or Broward MA enrollment option. HealthSpring has no 2027 MA plans in those counties — Cigna/HealthSpring pulled out of Medicare Advantage for 2027, so never offer it as a 2027 option.\n';
  return out.slice(0, 7000);
}

function structuredFor(doctorName, providerResults, { status, sunfireLabels = [] }) {
  const firstProvider = providerResults[0];
  if (!firstProvider) return { doctorName, networks: [], status };
  const inNetworkPlans = [...new Set([...firstProvider.inNetworkFor, ...sunfireLabels])];
  const outOfNetworkPlans = [
    ...(firstProvider.aetnaResult?.error ? [] : (firstProvider.aetnaResult?.outOfNetworkPlans || [])),
    ...(firstProvider.uhcResult?.error ? [] : (firstProvider.uhcResult?.outOfNetworkPlans || [])),
    ...(firstProvider.humanaResult?.error ? [] : (firstProvider.humanaResult?.outOfNetworkPlans || [])),
    ...((firstProvider.devotedResult && firstProvider.devotedResult.outPlans) || []),
  ];
  const guestEntry = (label, res) => ({
    carrier: label,
    inNetwork: Boolean(res?.inNetwork),
    status: res?.error ? 'failed' : (res?.inNetwork ? 'in_network' : 'checked'),
    plans: res?.plans || [],
    outOfNetworkPlans: res?.outOfNetworkPlans || [],
    year: res?.year || UHC_PLAN_YEAR,
  });
  const out = {
    doctorName: firstProvider.name,
    requestedName: doctorName,
    npi: firstProvider.npi,
    status,
    pending: firstProvider.pending || [],
    // Carrier checks that ran but failed (HTTP error) — shown as ❔ unchecked, never a miss.
    failed: (firstProvider.lookupErrors || []).filter((l) => !(firstProvider.pending || []).includes(l)),
    inNetworkPlans,
    outOfNetworkPlans,
    networks: [
      ...FHIR_CARRIERS.map((c) => ({
        carrier: c.name,
        inNetwork: firstProvider.inNetworkFor.includes(c.name),
        status: (firstProvider.lookupErrors || []).includes(`${c.name} (FHIR)`) ? 'failed'
          : (firstProvider.pending || []).some((p) => /^FHIR/.test(p)) ? 'pending' : 'checked',
        // Devoted: plan-level In/Out by network (C-SNP plans have their own network).
        ...(c.key === 'devoted' && firstProvider.devotedResult
          ? { plans: firstProvider.devotedResult.inPlans, outOfNetworkPlans: firstProvider.devotedResult.outPlans }
          : {}),
      })),
      {
        carrier: SOLIS_LABEL,
        inNetwork: firstProvider.inNetworkFor.includes(SOLIS_LABEL),
        status: firstProvider.solisResult && (firstProvider.solisResult.status === 'checked' || firstProvider.solisResult.inNetwork) ? 'checked' : 'failed',
        directoryMatches: (firstProvider.solisResult && firstProvider.solisResult.matches) || [],
      },
      {
        carrier: CAREPLUS_LABEL,
        inNetwork: firstProvider.inNetworkFor.includes(CAREPLUS_LABEL),
        status: firstProvider.careplusResult && (firstProvider.careplusResult.status === 'checked' || firstProvider.careplusResult.inNetwork) ? 'checked' : 'failed',
        partialList: true,
        directoryMatches: (firstProvider.careplusResult && firstProvider.careplusResult.matches) || [],
      },
      { carrier: DOCTORS_PLAN_LABEL, inNetwork: firstProvider.inNetworkFor.includes(DOCTORS_PLAN_LABEL), status: (firstProvider.lookupErrors || []).includes('Doctors HealthCare Plans') ? 'failed' : 'checked' },
      { carrier: AETNA_PLAN_LABEL, inNetwork: firstProvider.inNetworkFor.some((p) => /aetna/i.test(p)) },
      { carrier: SIMPLY_PLAN_LABEL, inNetwork: firstProvider.inNetworkFor.some((p) => /simply/i.test(p)) },
      guestEntry(UHC_PLAN_LABEL, firstProvider.uhcResult),
      guestEntry(HUMANA_PLAN_LABEL, firstProvider.humanaResult),
    ],
  };
  const carriersIn = out.networks.filter((n) => n.inNetwork).map((n) => n.carrier);
  for (const label of sunfireLabels) {
    const carrier = (String(label).match(/\(([^()]+)\)\s*$/) || [])[1];
    if (carrier && !carriersIn.includes(carrier)) carriersIn.push(carrier);
  }
  // Cigna/HealthSpring has no 2027 MA plans (pulled out) — a Cigna directory hit is not a 2027 option.
  const year = Number(firstProvider.uhcResult?.year || firstProvider.humanaResult?.year || UHC_PLAN_YEAR);
  out.carriersIn = year >= 2027 ? carriersIn.filter((c) => !/cigna|healthspring/i.test(c)) : carriersIn;
  if (year >= 2027 && out.carriersIn.length !== carriersIn.length) out.cignaDirectoryOnly = true;
  return out;
}

function notFoundResult(doctorName, suggestions = []) {
  const close = suggestions.length
    ? ` Closest real providers: ${suggestions.map((x, i) => `${i + 1}) ${x.name}${x.specialty ? ` — ${x.specialty}` : ''}${x.city ? `, ${x.city}` : ''}`).join('; ')}. Ask the agent which one it is (she answers with the name). Never ask her to look up an NPI.`
    : ' No similar name either — ask the agent to check the spelling or give the specialty / office name. Never ask her to look up an NPI.';
  return {
    status: 'not_found',
    doctorName,
    text: `No providers found matching "${doctorName}" in Florida (NPI-1 person or NPI-2 clinic).${close} If this is a clinic/group/DBA, call search_clinic_or_provider. Do not invent In/Out from a clinic insurances-accepted webpage.`,
    structured: { doctorName, networks: [], status: 'not_found', suggestions },
  };
}

function pendingResult(doctorName, why) {
  return {
    status: 'timeout',
    doctorName,
    text: `Provider network results for "${doctorName}": ${NOT_CONFIRMED} — ${why}. A lookup that did not finish is not out-of-network. It keeps running and is saved, so asking again picks it up.`,
    structured: { doctorName, requestedName: doctorName, networks: [], status: 'timeout' },
  };
}

/**
 * Look up one doctor. Resolves by `deadlineAt` at the latest — with whatever
 * finished — and lets the unfinished work continue into the cache.
 */
/** Sunfire county FIPS for the client's ZIP (was hardcoded Miami-Dade, so Broward clients were searched in the wrong county). */
function sunfireCountyForZip(zip) {
  try {
    if (require('./comparisonRules').countyForZip(zip) === 'Broward') return '12011';
  } catch (_) { /* default below */ }
  return '12086';
}

/**
 * "Ashwin Mehta: H1045-005 IN" (a saved-workup line pasted whole into a lookup) → "Ashwin Mehta".
 * The status after the name is a saved result, never part of the name.
 */
function stripSavedStatus(raw) {
  return String(raw || '')
    .replace(/^[\s\-•*]+/, '')
    .replace(/\s*\[saved[^\]]*\]\s*$/i, '')
    .replace(/\s*[:\-–—]\s*[HR]\d{4}-\d{3}[A-Z]?\b.*$/i, '')
    .replace(/\s+\b(?:in|out|in\*|not confirmed)\b\s*$/i, '')
    .trim();
}

async function lookupDoctor(input, { deadlineAt, npiCap = SINGLE_NPI_CAP, useCache = true } = {}) {
  const doctorName = stripSavedStatus(input.doctorName || input.name || input.npi || '');
  const zip = String(input.zip || '33136');
  const planYear = Number(input.year) || Number(UHC_PLAN_YEAR);
  const guestPlanIds = input.planId ? [String(input.planId)] : [];
  const key = cacheKey({ doctorName, npi: input.npi, zip, year: planYear, planId: input.planId });
  const until = Number(deadlineAt) > 0 ? Number(deadlineAt) : Date.now() + DEFAULT_BUDGET_MS;

  if (useCache) {
    const hit = cacheGet(key);
    if (hit) {
      if (hit.value) return { ...hit.value, cached: true };
      if (hit.inflight) {
        // An earlier (cut-off) attempt is still running — wait for it within this budget.
        return raceDeadline(hit.inflight, until, () => pendingResult(doctorName, 'carrier directories still answering from the previous attempt'));
      }
    }
  }

  const live = { npiStates: [], sunfire: { labels: [], error: null }, phase: 'npi' };
  let finishedAll = false;

  const full = (async () => {
    const records = await resolveNpiRecords({
      doctorName,
      zip,
      state: input.state || 'FL',
      npi: input.npi,
      limit: 5,
    });
    if (!records.length) {
      // Offer the closest real doctors instead of asking the agent for an NPI.
      const suggestions = await suggestSimilarProviders({ doctorName, zip, state: input.state || 'FL' }).catch(() => []);
      return notFoundResult(doctorName, suggestions);
    }
    const picked = records.slice(0, Math.max(1, npiCap)).map(npiRecordInfo);
    live.phase = 'carriers';
    const runs = picked.map((rec, rank) => startNpiChecks(rec, { zip, planYear, guestPlanIds, rank }));
    live.npiStates = runs.map((r) => r.state);

    const sunfirePromise = (async () => {
      if (!sunfireEnabled()) {
        live.sunfire = { labels: [], error: 'skipped' };
        return;
      }
      const sf = await querySunfireProviderList({
        providers: picked.map((pr) => ({ id: pr.npi, name: pr.name, firstName: pr.name.split(' ')[0], radius: 25, primaryDoctor: true })),
        zip,
        year: planYear,
        county: sunfireCountyForZip(zip),
        timeoutMs: Math.max(1000, Math.min(SUNFIRE_TIMEOUT_MS, until - Date.now())),
        retry: false,
      });
      await Promise.all(runs.map((r) => r.done));
      if (sf.ok) {
        const humanaGuestOk = live.npiStates.some((s) => (
          s.humanaResult?.checks?.some((c) => c.status === 'in_network' || c.status === 'out_of_network')
        ));
        live.sunfire = {
          labels: inNetworkLabelsFromSunfirePlans(sf.plans, SUNFIRE_PLAN_MAP, { skipHumana: humanaGuestOk, isHumanaLabel }),
          error: null,
        };
      } else if (sf.error && sf.error !== 'missing_credentials') {
        live.sunfire = { labels: [], error: sf.error };
      }
    })().catch((e) => {
      live.sunfire = { labels: [], error: e.message || 'sunfire_error' };
    });

    await Promise.all([...runs.map((r) => r.done), sunfirePromise]);
    finishedAll = true;
    return buildDoctorResult(doctorName, zip, planYear, live, { timedOut: false });
  })();

  const settled = full.then((result) => {
    if (useCache && result && result.status !== 'timeout') {
      cacheSet(key, { value: result });
      // Alias by NPI and by the official NPPES name, so a reopened workup that
      // lists "HOWARD BUSH M.D." or passes npi= hits the same finished lookup.
      const s0 = result.structured || {};
      if (result.status === 'done') {
        for (const alias of [{ npi: s0.npi }, { doctorName: s0.doctorName }]) {
          if (!alias.npi && !alias.doctorName) continue;
          const k = cacheKey({ ...alias, zip, year: planYear, planId: input.planId });
          if (k !== key) cacheSet(k, { value: result });
        }
      }
    }
    return result;
  }, (err) => {
    cache.delete(key);
    return { status: 'error', doctorName, text: `Provider lookup error: ${err.message}`, structured: { doctorName, networks: [], status: 'error' } };
  });
  if (useCache) cacheSet(key, { inflight: settled });

  return raceDeadline(settled, until, () => {
    if (finishedAll) return null; // race lost by a hair — settled wins below
    if (live.phase === 'npi' || !live.npiStates.length) {
      return pendingResult(doctorName, 'NPI registry lookup did not finish');
    }
    return buildDoctorResult(doctorName, zip, planYear, live, { timedOut: true });
  }).then((r) => r || settled);
}

function buildDoctorResult(doctorName, zip, planYear, live, { timedOut }) {
  const providerResults = live.npiStates.map((s) => summarizeNpi(s, planYear));
  const anyPending = providerResults.some((pr) => pr.pending.length);
  const status = timedOut && anyPending ? 'partial' : 'done';
  return {
    status,
    doctorName,
    text: formatDoctorText({ doctorName, zip, planYear, providerResults, sunfire: live.sunfire, timedOut: status === 'partial' }),
    structured: structuredFor(doctorName, providerResults, { status, sunfireLabels: live.sunfire.labels || [] }),
  };
}

// ─── batch ──────────────────────────────────────────────────────────────────

function normalizeDoctorList(toolInput) {
  const list = [];
  const seen = new Set();
  const add = (d) => {
    if (!d) return;
    const entry = typeof d === 'string' ? { doctorName: d } : { ...d };
    entry.doctorName = String(entry.doctorName || entry.name || entry.npi || '').trim();
    if (!entry.doctorName && !entry.npi) return;
    const k = (normalizeNpi(entry.npi) || entry.doctorName).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    list.push(entry);
  };
  (Array.isArray(toolInput.doctors) ? toolInput.doctors : []).forEach(add);
  if (toolInput.doctorName || toolInput.npi) add({ doctorName: toolInput.doctorName, npi: toolInput.npi, planId: toolInput.planId });
  return list.slice(0, BATCH_MAX_DOCTORS);
}

/**
 * Run lookup_provider_network for one or many doctors in parallel.
 * Returns { text, structured, expand } — `expand` holds one structured entry per
 * doctor so the UI export sees each doctor like a separate tool call.
 */
async function lookupProviderNetwork(toolInput = {}, context = {}) {
  const doctors = normalizeDoctorList(toolInput);
  const deadlineAt = Number(context.deadlineAt) > 0
    ? Number(context.deadlineAt)
    : Date.now() + (Number(context.remainingMs) > 0 ? Math.max(3000, Number(context.remainingMs) - 5000) : DEFAULT_BUDGET_MS);
  if (!doctors.length) {
    return 'lookup_provider_network needs doctorName, npi, or doctors[]. Nothing was looked up.';
  }
  const common = { zip: toolInput.zip, state: toolInput.state, year: toolInput.year, planId: toolInput.planId };
  const npiCap = doctors.length > 1 ? BATCH_NPI_CAP : SINGLE_NPI_CAP;
  const askText = doctors.length > 1 ? comparisonAskText(context.messages || [], conversationAskText(context.messages || [])) : '';
  // Rule 8: meds she already listed are priced here, in the same turn — not left for a
  // later model round that the chat wait never reaches.
  const meds = doctors.length > 1 ? medsFromAsk(askText) : [];
  if (doctors.length > 1) {
    const carriersLine = (askText.match(/Carriers requested:[^\n]*/g) || []).pop();
    console.log(`[comparison] ${doctors.length} doctors · ${meds.length} meds · ${carriersLine || 'no carrier ask'}`);
  }
  const doctorDeadline = meds.length && deadlineAt - Date.now() > MEDS_RESERVE_MS + 15_000 ? deadlineAt - MEDS_RESERVE_MS : deadlineAt;
  const results = await Promise.all(doctors.map((d) => lookupDoctor(
    { ...common, ...d, planId: d.planId || common.planId },
    { deadlineAt: doctorDeadline, npiCap }
  )));

  if (doctors.length === 1) {
    const r = results[0];
    return { text: r.text, structured: r.structured, status: r.status };
  }

  const done = results.filter((r) => r.status === 'done').length;
  const doctorsStructured = results.map((r) => ({ ...r.structured, requestedName: r.doctorName, status: r.status }));
  const answered = narrowingAnswered(context.messages);
  let drugs = [];
  if (meds.length) {
    const planIds = selectComparison(doctorsStructured, askText, { answered }).columns.map((c) => c.planId);
    if (planIds.length) {
      const { lookupFormularyCached } = require('./compareJobs'); // lazy: compareJobs requires this file
      const year = Number(common.year) || Number(UHC_PLAN_YEAR) || 2027;
      drugs = (await Promise.all(meds.map((drugName) => raceDeadline(
        lookupFormularyCached({ drugName, planIds, year }).catch(() => null),
        deadlineAt,
        () => null,
      )))).filter(Boolean);
    }
  }
  const summary = batchSummaryForModel(doctorsStructured, askText, { answered, drugs });
  // Per-doctor notes only where something failed or is pending — no full plan dumps.
  const notes = results
    .filter((r) => r.status !== 'done' || /Could not complete|NOT CONFIRMED/.test(r.text))
    .map((r) => {
      const keep = r.text.split('\n').filter((l) => /^\*\*|NPI|Could not complete|NOT CONFIRMED|No providers found/.test(l));
      return `${r.doctorName}:\n${keep.join('\n')}`.slice(0, 600);
    });
  const header = `Doctor network batch — ${results.length} doctors, ZIP ${common.zip || '33136'}, year ${Number(common.year) || UHC_PLAN_YEAR}. Finished: ${done}/${results.length}.` +
    (done < results.length ? ` Anything marked ${NOT_CONFIRMED} did not finish (or no NPI match) — never report it as out-of-network.` : '');
  return {
    text: [header, '', summary.text, notes.length ? `\nNOTES:\n${notes.join('\n')}` : ''].join('\n').slice(0, 12000),
    structured: { doctors: doctorsStructured, finished: done, total: results.length, questions: summary.questions },
    expand: doctorsStructured,
    // Priced meds ride along as their own tool results (fallback tables + Excel/PDF export read them).
    extraToolResults: drugs.map((r) => {
      const { toExportDrug, toExportDrugs } = require('./formularyLookup');
      return { tool: 'lookup_formulary', output: { ...r, drug: toExportDrug(r), drugs: toExportDrugs(r) } };
    }),
    status: done === results.length ? 'done' : 'partial',
  };
}

module.exports = {
  stripSavedStatus,
  lookupProviderNetwork,
  fhirCheck,
  FHIR_CARRIERS,
  lookupDoctor,
  normalizeDoctorList,
  clearProviderCache,
  raceDeadline,
  createLimiter,
  NOT_CONFIRMED,
};
