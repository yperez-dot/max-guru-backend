/**
 * THEI Sunfire /v2/provider/list — secondary Wellcare / CarePlus signal only.
 * Empty, truncated, or timed-out JSON must fail fast. Never hang /chat.
 * Empty Sunfire is never UHC or Humana out-of-network.
 */

const SUNFIRE_BASE = 'https://www.sunfirematrix.com';
const DEFAULT_TIMEOUT_MS = Number(process.env.SUNFIRE_PROVIDER_TIMEOUT_MS || 6000);
const CIRCUIT_MS = Number(process.env.SUNFIRE_CIRCUIT_MS || 45_000);

let circuitOpenUntil = 0;
let circuitReason = '';

function resetSunfireCircuit() {
  circuitOpenUntil = 0;
  circuitReason = '';
}

function sunfireCircuitBlocked() {
  return Date.now() < circuitOpenUntil;
}

function openSunfireCircuit(reason) {
  circuitOpenUntil = Date.now() + CIRCUIT_MS;
  circuitReason = String(reason || 'sunfire_error');
  console.warn(
    `[sunfire] circuit open ${CIRCUIT_MS}ms after ${circuitReason} — skip further provider/list calls`
  );
}

function parseSunfireResponseText(text) {
  const raw = text == null ? '' : String(text);
  if (!raw.trim()) {
    const err = new Error('empty_json');
    err.code = 'empty_json';
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error('truncated_json');
    err.code = 'truncated_json';
    err.cause = e;
    throw err;
  }
}

function retryableSunfireError(err) {
  if (!err) return false;
  if (err.code === 'empty_json' || err.code === 'truncated_json') return true;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || '');
  return /unexpected end of json|network|fetch|econnreset|socket/i.test(msg);
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postProviderListOnce({ body, timeoutMs, fetchImpl, jwt, sfp }) {
  const res = await fetchWithTimeout(
    `${SUNFIRE_BASE}/v2/provider/list`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        Cookie: `sfp-cookie=${sfp}`,
        Origin: SUNFIRE_BASE,
        Referer: `${SUNFIRE_BASE}/app/agent/yourmedicare/`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
    fetchImpl
  );
  if (!res.ok) {
    const err = new Error(`http_${res.status}`);
    err.code = `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return parseSunfireResponseText(text);
}

/**
 * POST Sunfire provider/list. Retry once on empty/truncated JSON or a short
 * network abort. After that, open a process-local circuit so Padron-length
 * doctor loops do not cascade.
 */
async function querySunfireProviderList({
  providers = [],
  zip,
  year,
  county = '12086',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  // Doctor-network path passes retry:false — Sunfire is secondary there, so an
  // empty/truncated body fails fast instead of spending a second timeout.
  retry = true,
} = {}) {
  const jwt = process.env.SUNFIRE_JWT || '';
  const sfp = process.env.SUNFIRE_SFP || '';
  if (!jwt || !sfp) {
    return {
      ok: false,
      status: 'skipped',
      error: 'missing_credentials',
      plans: [],
      data: null,
      retried: false,
    };
  }
  if (sunfireCircuitBlocked()) {
    return {
      ok: false,
      status: 'skipped',
      error: `circuit_open:${circuitReason || 'sunfire_error'}`,
      plans: [],
      data: null,
      retried: false,
    };
  }

  const body = {
    type: 'network',
    county,
    year,
    zip,
    providers,
    restrictedProviderCarrierId: '',
  };

  let retried = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await postProviderListOnce({
        body,
        timeoutMs,
        fetchImpl,
        jwt,
        sfp,
      });
      const plans = Array.isArray(data) ? data : (data && data.plans) || [];
      return {
        ok: true,
        status: 'ok',
        error: null,
        plans: Array.isArray(plans) ? plans : [],
        data,
        retried,
      };
    } catch (err) {
      lastErr = err;
      const code = err.code || err.message || 'sunfire_error';
      if (attempt === 0 && retry && retryableSunfireError(err)) {
        retried = true;
        console.warn(`[sunfire] provider/list ${code} — retrying once`);
        continue;
      }
      openSunfireCircuit(code);
      console.warn(`[sunfire] provider/list error: ${code}`);
      return {
        ok: false,
        status: 'failed',
        error: String(code),
        plans: [],
        data: null,
        retried,
      };
    }
  }
  openSunfireCircuit(lastErr && (lastErr.code || lastErr.message));
  return {
    ok: false,
    status: 'failed',
    error: String((lastErr && (lastErr.code || lastErr.message)) || 'sunfire_error'),
    plans: [],
    data: null,
    retried,
  };
}

function sunfirePlanLabel(plan, planMap = {}) {
  const id = String((plan && plan.id) || '');
  const mapEntry = planMap[id];
  if (mapEntry) {
    return mapEntry.planName
      ? `${mapEntry.planName} (${mapEntry.carrier})`
      : mapEntry.carrier || `Plan ${id}`;
  }
  return id ? `Plan ID ${id}` : null;
}

function inNetworkLabelsFromSunfirePlans(rawPlans, planMap = {}, { skipHumana, isHumanaLabel } = {}) {
  const labels = [];
  for (const plan of rawPlans || []) {
    const docs = plan.doctorInformation || [];
    const covered = docs.some(
      (doc) => doc.covered === 'Y' && (doc.locations || []).some((l) => l.covered === 'Y')
    );
    if (!covered) continue;
    const label = sunfirePlanLabel(plan, planMap);
    if (!label) continue;
    if (skipHumana && typeof isHumanaLabel === 'function' && isHumanaLabel(label)) continue;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

module.exports = {
  SUNFIRE_BASE,
  DEFAULT_TIMEOUT_MS,
  parseSunfireResponseText,
  querySunfireProviderList,
  inNetworkLabelsFromSunfirePlans,
  resetSunfireCircuit,
  sunfireCircuitBlocked,
  openSunfireCircuit,
  retryableSunfireError,
};
