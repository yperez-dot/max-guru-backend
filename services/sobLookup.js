/**
 * Live Summary of Benefits fallback for benefits that are not on the
 * 2027 THEI comparison grid (green cells).
 *
 * Grid first. Then that plan's sobUrl PDF. Never invent dollars.
 * Never fill from 2026 or training memory. If the SOB cannot be read,
 * return unverified.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PLAN_YEAR = 2027;
const FETCH_TIMEOUT_MS = 40_000;
const EXTRACT_TIMEOUT_MS = 45_000;
const TEXT_CAP = 40_000;

const BENEFIT_KEYS = {
  hearing_aids: 'hearingAids',
  skilled_nursing: 'skilledNursing',
  snf: 'skilledNursing',
  dme: 'dmeHospitalBed',
  hospital_bed: 'dmeHospitalBed',
};

const BROWSER_HEADERS = {
  Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

const PYTHON_GET_BYTES = `
import json, sys, urllib.error, urllib.request
req = json.load(sys.stdin)
headers = {str(k): str(v) for k, v in (req.get("headers") or {}).items() if v is not None}
r = urllib.request.Request(req["url"], headers=headers, method="GET")
out = req["out"]
try:
    with urllib.request.urlopen(r, timeout=float(req.get("timeout") or 40)) as resp:
        data = resp.read()
        open(out, "wb").write(data)
        print(json.dumps({"status": int(resp.status), "bytes": len(data)}))
except urllib.error.HTTPError as e:
    body = e.read()
    open(out, "wb").write(body)
    print(json.dumps({"status": int(e.code), "bytes": len(body)}))
except Exception as e:
    print(json.dumps({"status": 0, "bytes": 0, "error": str(e)}))
`;

const PYTHON_PYPDF = `
import json, sys
path = sys.argv[1]
try:
    from pypdf import PdfReader
except Exception:
    print(json.dumps({"ok": False, "error": "pypdf_missing"}))
    raise SystemExit(0)
try:
    reader = PdfReader(path)
    parts = []
    for page in reader.pages:
        t = page.extract_text() or ""
        if t:
            parts.append(t)
    print(json.dumps({"ok": True, "text": "\\n".join(parts)}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`;

const textCache = new Map();
let wiredPlansCache = null;

function loadWiredPlans() {
  if (wiredPlansCache) return wiredPlansCache;
  try {
    const html = fs.readFileSync(
      path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'),
      'utf8'
    );
    const m = html.match(
      /<script id="plan-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/
    );
    wiredPlansCache = m ? JSON.parse(m[1]) : [];
  } catch (_) {
    wiredPlansCache = [];
  }
  return wiredPlansCache;
}

function normalizePlanId(id) {
  return String(id || '')
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/-000$/i, '');
}

function idsMatch(a, b) {
  const x = normalizePlanId(a);
  const y = normalizePlanId(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const soft = (s) => s.replace(/([0-9])[A-Z]$/, '$1');
  return soft(x) === soft(y);
}

function findWiredPlan(planId) {
  const id = normalizePlanId(planId);
  if (!id) return null;
  return loadWiredPlans().find((p) => idsMatch(p.planId || p.id, id)) || null;
}

function mergeWiredPlan(plan, year) {
  const y = Number(year) || PLAN_YEAR;
  if (y !== PLAN_YEAR) return plan;
  const id = plan && (plan.planId || plan.id);
  const wired = findWiredPlan(id);
  if (!wired) return plan;
  return {
    ...wired,
    ...plan,
    planId: String(id || wired.planId || wired.id || '').trim(),
    sobUrl: String((plan && plan.sobUrl) || wired.sobUrl || '').trim(),
    hearing: (plan && plan.hearing) || wired.hearing,
  };
}

function usableGridValue(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^(not listed|n\/a|na|pending|pending sob|yellow|tbd|none|null)$/i.test(s)) return null;
  return s;
}

function normalizeBenefitList(benefits, query) {
  const out = new Set();
  const add = (raw) => {
    const key = String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_');
    if (/hearing/.test(key)) out.add('hearingAids');
    if (/snf|skilled|nursing/.test(key)) out.add('skilledNursing');
    if (/dme|hospital|bed|durable/.test(key)) out.add('dmeHospitalBed');
  };
  (Array.isArray(benefits) ? benefits : benefits ? [benefits] : []).forEach(add);
  if (query) add(query);
  if (!out.size) {
    out.add('hearingAids');
    out.add('skilledNursing');
    out.add('dmeHospitalBed');
  }
  return [...out];
}

function collapseWs(s) {
  return String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanSnippet(raw, max = 180) {
  const s = collapseWs(raw)
    .replace(/\s*\n\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[·\s,;:]+|[·\s,;:]+$/g, '')
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
}

function hasMoneyOrCoverage(s) {
  return /\$[\d,]+|\d+\s*%|\bcovered\b|\bnot covered\b|\bno copay\b|\b\$0\b/i.test(s || '');
}

function windowAround(text, re, after = 420, before = 40) {
  const src = String(text || '');
  const m = src.match(re);
  if (!m || m.index == null) return '';
  return src.slice(Math.max(0, m.index - before), Math.min(src.length, m.index + after));
}

function extractMoneyAfter(blob, dayRe) {
  const m = String(blob || '').match(dayRe);
  if (!m) return null;
  const tail = blob.slice(m.index, Math.min(blob.length, m.index + 160));
  const money = tail.match(
    /\$[\d,]+(?:\.\d{2})?(?:\s*(?:copay|coinsurance|per day|\/day))?|\d+\s*%(?:\s*coinsurance)?|no copay|\$0(?:\s*copay)?/i
  );
  if (!money) return null;
  return cleanSnippet(`${m[0]}: ${money[0]}`.replace(/\s+/g, ' '), 80);
}

function parseSkilledNursing(text) {
  const blob = collapseWs(text);
  if (!/skilled nursing|\bSNF\b/i.test(blob)) {
    return { days1to20: null, days21to100: null };
  }
  const win = collapseWs(
    windowAround(text, /skilled nursing facility|\bSNF\b|skilled nursing/i, 700, 20)
  );
  const days1to20 =
    extractMoneyAfter(win, /days?\s*1\s*(?:-|–|—|through|to)\s*20/i) ||
    extractMoneyAfter(win, /\$[\d,]+(?:\.\d{2})?[^.]{0,40}days?\s*1\s*(?:-|–|through|to)\s*20/i);
  const days21to100 =
    extractMoneyAfter(win, /days?\s*21\s*(?:-|–|—|through|to)\s*100/i) ||
    extractMoneyAfter(win, /\$[\d,]+(?:\.\d{2})?[^.]{0,40}days?\s*21\s*(?:-|–|through|to)\s*100/i);
  return { days1to20, days21to100 };
}

function parseHearingAids(text) {
  const win = collapseWs(windowAround(text, /hearing\s+aids?/i, 480, 10));
  if (!win || !hasMoneyOrCoverage(win)) return null;
  const sentence = win.match(/hearing\s+aids?[^.]{0,160}(?:\$[\d,]+|\d+\s*%|no copay|covered|not covered)[^.]{0,80}/i);
  return cleanSnippet(sentence ? sentence[0] : win, 160);
}

function parseDmeHospitalBed(text) {
  const win = collapseWs(
    windowAround(text, /durable medical equipment|\bDME\b|hospital[-\s]?grade bed|hospital bed/i, 480, 10)
  );
  if (!win || !hasMoneyOrCoverage(win)) return null;
  const sentence = win.match(
    /(?:durable medical equipment|\bDME\b|hospital[-\s]?grade bed|hospital bed)[^.]{0,160}(?:\$[\d,]+|\d+\s*%|covered|not covered|no copay)[^.]{0,80}/i
  );
  return cleanSnippet(sentence ? sentence[0] : win, 160);
}

function parseSobBenefits(text) {
  const snf = parseSkilledNursing(text);
  return {
    hearingAids: parseHearingAids(text),
    snfDays1to20: snf.days1to20,
    snfDays21to100: snf.days21to100,
    dmeHospitalBed: parseDmeHospitalBed(text),
  };
}

function driveDirectUrl(url) {
  const m = String(url || '').match(/\/file\/d\/([^/]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return String(url || '');
}

function isPdfMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString('utf8') === '%PDF';
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
    if (child.stdout) child.stdout.on('data', (chunk) => { out += chunk; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      const missing = err && (err.code === 'ENOENT' || /ENOENT/.test(err.message || ''));
      done({ ok: false, status: 0, text: '', error: missing ? `${bin}_missing` : err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, status: code || 0, text: out, error: code ? `${bin}_exit_${code}` : null });
    });
    try {
      if (stdin != null) child.stdin.write(stdin);
      child.stdin.end();
    } catch (_) { /* ignore */ }
  });
}

function tmpPath(suffix) {
  return path.join(
    os.tmpdir(),
    `max-sob-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}${suffix}`
  );
}

function curlBin() {
  return process.env.SOB_CURL || process.env.MEDICARE_GOV_CURL || 'curl';
}

function pythonBins() {
  if (process.env.SOB_PYTHON || process.env.MEDICARE_GOV_PYTHON) {
    return [process.env.SOB_PYTHON || process.env.MEDICARE_GOV_PYTHON];
  }
  return ['python3', 'python'];
}

async function curlFetchPdfFile(url, dest) {
  const args = [
    '-sS', '-L', '--max-time', '40', '-o', dest, '-w', '%{http_code}',
    '-A', BROWSER_HEADERS['User-Agent'],
  ];
  Object.entries(BROWSER_HEADERS).forEach(([key, value]) => {
    if (key === 'User-Agent') return;
    args.push('-H', `${key}: ${value}`);
  });
  args.push(String(url));
  const spawned = await spawnOnce(curlBin(), args, { timeoutMs: FETCH_TIMEOUT_MS + 2_000 });
  if (spawned.error) return { ok: false, status: 0, error: spawned.error, buf: Buffer.alloc(0) };
  const status = Number(String(spawned.text || '').trim()) || 0;
  let buf = Buffer.alloc(0);
  try { buf = fs.readFileSync(dest); } catch (_) { buf = Buffer.alloc(0); }
  return { ok: status >= 200 && status < 300 && isPdfMagic(buf), status, buf, error: status ? undefined : 'curl_no_status' };
}

async function pythonFetchPdfFile(url, dest) {
  const payload = JSON.stringify({ url: String(url), headers: BROWSER_HEADERS, timeout: 40, out: dest });
  let last = { ok: false, status: 0, buf: Buffer.alloc(0), error: 'python_missing' };
  for (const bin of pythonBins()) {
    const spawned = await spawnOnce(bin, ['-c', PYTHON_GET_BYTES], {
      stdin: payload,
      timeoutMs: FETCH_TIMEOUT_MS + 2_000,
    });
    if (spawned.error) {
      last = { ok: false, status: 0, buf: Buffer.alloc(0), error: spawned.error };
      continue;
    }
    try {
      const parsed = JSON.parse(String(spawned.text || '').trim() || '{}');
      const status = Number(parsed.status) || 0;
      let buf = Buffer.alloc(0);
      try { buf = fs.readFileSync(dest); } catch (_) { buf = Buffer.alloc(0); }
      last = { ok: status >= 200 && status < 300 && isPdfMagic(buf), status, buf, error: parsed.error };
      if (last.ok || status > 0) return last;
    } catch (err) {
      last = { ok: false, status: 0, buf: Buffer.alloc(0), error: err.message || 'python_bad_output' };
    }
  }
  return last;
}

async function extractPdfText(buf) {
  const dest = tmpPath('.pdf');
  try {
    fs.writeFileSync(dest, buf);
    const pdftotext = await spawnOnce(process.env.SOB_PDFTOTEXT || 'pdftotext', ['-layout', dest, '-'], {
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    if (pdftotext.ok && pdftotext.text && pdftotext.text.length > 80) {
      return { ok: true, text: pdftotext.text.slice(0, TEXT_CAP), error: null };
    }
    for (const bin of pythonBins()) {
      const spawned = await spawnOnce(bin, ['-c', PYTHON_PYPDF, dest], { timeoutMs: EXTRACT_TIMEOUT_MS });
      if (spawned.error) continue;
      try {
        const parsed = JSON.parse(String(spawned.text || '').trim() || '{}');
        if (parsed.ok && parsed.text && String(parsed.text).length > 80) {
          return { ok: true, text: String(parsed.text).slice(0, TEXT_CAP), error: null };
        }
      } catch (_) { /* ignore */ }
    }
    return { ok: false, text: '', error: pdftotext.error || 'sob_extract_failed' };
  } finally {
    try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
  }
}

async function fetchSobText(url, fetchImpl) {
  const resolved = driveDirectUrl(url);
  if (!resolved) return { ok: false, text: '', error: 'no_sob_url', sourceUrl: '' };
  if (textCache.has(resolved)) return textCache.get(resolved);

  if (typeof fetchImpl === 'function') {
    try {
      const res = await fetchImpl(resolved, { method: 'GET', headers: BROWSER_HEADERS });
      if (res && typeof res.text === 'function' && !res.arrayBuffer) {
        const text = await res.text();
        const out = { ok: Boolean(text && text.length > 40), text: String(text || '').slice(0, TEXT_CAP), error: text ? null : 'empty_text', sourceUrl: resolved };
        textCache.set(resolved, out);
        return out;
      }
      let buf = Buffer.alloc(0);
      if (res && typeof res.arrayBuffer === 'function') {
        buf = Buffer.from(await res.arrayBuffer());
      } else if (res && res.buf) {
        buf = res.buf;
      }
      if (isPdfMagic(buf)) {
        const extracted = await extractPdfText(buf);
        const out = { ...extracted, sourceUrl: resolved };
        textCache.set(resolved, out);
        return out;
      }
      const text = buf.toString('utf8');
      const out = { ok: text.length > 40 && !/^\s*</.test(text), text: text.slice(0, TEXT_CAP), error: 'not_pdf', sourceUrl: resolved };
      textCache.set(resolved, out);
      return out;
    } catch (err) {
      return { ok: false, text: '', error: err.message || 'fetch_failed', sourceUrl: resolved };
    }
  }

  const dest = tmpPath('.pdf');
  try {
    const curl = await curlFetchPdfFile(resolved, dest);
    const hit = curl.ok ? curl : await pythonFetchPdfFile(resolved, dest);
    if (!hit.ok || !isPdfMagic(hit.buf)) {
      const out = { ok: false, text: '', error: hit.error || `sob_http_${hit.status || 0}`, sourceUrl: resolved };
      textCache.set(resolved, out);
      return out;
    }
    const extracted = await extractPdfText(hit.buf);
    const out = { ...extracted, sourceUrl: resolved };
    textCache.set(resolved, out);
    return out;
  } finally {
    try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
  }
}

function requestedFieldKeys(wanted) {
  const keys = [];
  if (wanted.includes('hearingAids')) keys.push('hearingAids');
  if (wanted.includes('skilledNursing')) keys.push('snfDays1to20', 'snfDays21to100');
  if (wanted.includes('dmeHospitalBed')) keys.push('dmeHospitalBed');
  return keys;
}

function pickRequested(parsed, wanted) {
  const row = {};
  requestedFieldKeys(wanted).forEach((key) => {
    row[key] = parsed[key] || null;
  });
  return row;
}

function gridFallback(plan, wanted) {
  const out = {};
  if (wanted.includes('hearingAids')) {
    const hearing = usableGridValue(plan && plan.hearing);
    if (hearing && /aid/i.test(hearing)) out.hearingAids = { value: hearing, source: 'grid_2027' };
  }
  return out;
}

/**
 * Look up asked benefits for one or more plans. Grid green cells first,
 * then that plan's SOB. Never invent.
 */
async function lookupSobBenefits(
  {
    planId = '',
    planIds = [],
    sobUrl = '',
    plans = [],
    benefits = [],
    query = '',
    year = PLAN_YEAR,
    sobText = '',
    sobTextByPlanId = {},
  } = {},
  fetchImpl
) {
  const y = Number(year) || PLAN_YEAR;
  const wanted = normalizeBenefitList(benefits, query);
  const ids = [...(planId ? [planId] : []), ...(Array.isArray(planIds) ? planIds : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const planList = (Array.isArray(plans) ? plans.slice() : []).map((p) => mergeWiredPlan(p, y));
  if (ids.length && !planList.length && sobUrl) {
    planList.push(mergeWiredPlan({ planId: ids[0], sobUrl }, y));
  }
  ids.forEach((id) => {
    if (!planList.some((p) => idsMatch(p.planId || p.id, id))) {
      planList.push(mergeWiredPlan({ planId: id, sobUrl: ids.length === 1 ? sobUrl : '' }, y));
    }
  });
  if (!planList.length && sobUrl) planList.push({ planId: 'unknown', sobUrl });

  const byPlanId = {};
  const lookups = [];

  for (const plan of planList) {
    const id = String(plan.planId || plan.id || '').trim() || 'unknown';
    const url = String(plan.sobUrl || sobUrl || '').trim();
    const fromGrid = gridFallback(plan, wanted);
    let parsed = {
      hearingAids: null,
      snfDays1to20: null,
      snfDays21to100: null,
      dmeHospitalBed: null,
    };
    let sourceUrl = url || null;
    let readError = null;
    let sobRead = false;

    const injected = sobTextByPlanId[id] || sobText;
    if (injected) {
      parsed = parseSobBenefits(injected);
      sobRead = true;
      sourceUrl = sourceUrl || 'injected';
    } else if (url) {
      const fetched = await fetchSobText(url, fetchImpl);
      sourceUrl = fetched.sourceUrl || url;
      if (fetched.ok && fetched.text) {
        parsed = parseSobBenefits(fetched.text);
        sobRead = true;
      } else {
        readError = fetched.error || 'sob_unreadable';
      }
    } else {
      readError = 'no_sob_url';
    }

    const fromSob = pickRequested(parsed, wanted);
    const fields = {};
    const keys = requestedFieldKeys(wanted);
    keys.forEach((key) => {
      if (fromGrid[key]) {
        fields[key] = { value: fromGrid[key].value, source: fromGrid[key].source, verified: true };
      } else if (fromSob[key]) {
        fields[key] = { value: fromSob[key], source: 'sob', verified: true };
      } else if (sobRead) {
        fields[key] = { value: null, source: 'sob', verified: false, reason: 'not_in_sob' };
      } else {
        fields[key] = { value: null, source: null, verified: false, reason: readError || 'unverified' };
      }
    });

    const row = {
      planId: id,
      year: y,
      sobUrl: url || null,
      sourceUrl,
      sobRead,
      reason: readError,
      fields,
    };
    byPlanId[id] = row;
    lookups.push(row);
  }

  return {
    year: y,
    benefits: wanted,
    lookups,
    byPlanId,
    verifiedAny: lookups.some((row) => Object.values(row.fields).some((f) => f.verified && f.value)),
  };
}

function formatSobLookupText(result) {
  if (!result) return 'SOB lookup failed.';
  const lines = [`SOB_LOOKUP year=${result.year} benefits=${(result.benefits || []).join(',')}`];
  for (const row of result.lookups || []) {
    lines.push(`${row.planId}: ${row.sobRead ? 'SOB read' : 'SOB unread'}${row.reason ? ` (${row.reason})` : ''}${row.sobUrl ? ` [SoB](${row.sobUrl})` : ''}`);
    Object.entries(row.fields || {}).forEach(([key, field]) => {
      if (field.verified && field.value) {
        lines.push(`  ${key}: ${field.value} (source ${field.source})`);
      } else {
        lines.push(`  ${key}: UNVERIFIED${field.reason ? ` (${field.reason})` : ''}. Do not invent a dollar amount.`);
      }
    });
  }
  return lines.join('\n');
}

function toExportSobBenefits(result) {
  const out = {};
  (result && result.lookups ? result.lookups : []).forEach((row) => {
    const fields = {};
    Object.entries(row.fields || {}).forEach(([key, field]) => {
      if (field && field.verified && field.value) {
        fields[key] = { value: field.value, source: field.source || 'sob' };
      }
    });
    if (Object.keys(fields).length) out[row.planId] = fields;
  });
  return out;
}

function resetSobCache() {
  textCache.clear();
  wiredPlansCache = null;
}

module.exports = {
  PLAN_YEAR,
  BENEFIT_KEYS,
  usableGridValue,
  normalizeBenefitList,
  requestedFieldKeys,
  parseSobBenefits,
  parseHearingAids,
  parseSkilledNursing,
  parseDmeHospitalBed,
  lookupSobBenefits,
  formatSobLookupText,
  toExportSobBenefits,
  fetchSobText,
  driveDirectUrl,
  findWiredPlan,
  resetSobCache,
};
