/**
 * Doctors HealthCare Plans (H4140) consumer formulary — 2027 PDF.
 *
 * Public source (not the interactive search widget, not the member portal):
 *   https://www.doctorshcp.com/wp-content/uploads/2027_FORMULARY.pdf
 *   landing: https://www.doctorshcp.com/2027druglist/
 *   ST criteria (not fetched; row already flags ST): ST_2027.pdf
 *
 * WordPress/CDN 404s Node/undici (same class of bot wall as medicare.gov).
 * Fetch with curl → Python urllib, write bytes to a temp file, then
 * pdftotext -layout (poppler). Do not invent tiers.
 *
 * 2027 PBP remap (https://www.doctorshcp.com/2027-plan-changes/):
 *   H4140-001 DrMax        → H4140-022 DrMax-Dade     (001 ends 2026-12-31)
 *   H4140-012 DrSelect     → H4140-023 DrSelect-SFL
 *   H4140-004 DrExtraCare  → H4140-024 DrExtraCare-SFL
 *   H4140-016 DrSelect-CFL → H4140-025 DrSelect-CFL
 *   H4140-018 DrTotalCare  → H4140-026 DrExtraCare-CFL
 *
 * The PDF is one shared drug list (tier + PA/ST/QL). Cost-share after a
 * verified tier still comes from THEI 2027 Hub/grid KB.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SOURCE_PDF = 'doctors_formulary_pdf';
const SOURCE_CONSUMER = 'doctors_consumer';
const CONTRACT = 'H4140';
const PLAN_YEAR = 2027;

const DOCTORS_2027_FORMULARY_PDF = 'https://www.doctorshcp.com/wp-content/uploads/2027_FORMULARY.pdf';
const DOCTORS_2027_DRUGLIST_PAGE = 'https://www.doctorshcp.com/2027druglist/';
const DOCTORS_2027_ST_CRITERIA_PDF = 'https://www.doctorshcp.com/wp-content/uploads/ST_2027.pdf';

/** Old 2026 PBPs → 2027 successors. Lookups accept both sides. */
const PBP_REMAP_2027 = {
  'H4140-001': 'H4140-022',
  'H4140-012': 'H4140-023',
  'H4140-004': 'H4140-024',
  'H4140-016': 'H4140-025',
  'H4140-018': 'H4140-026',
};

const REVERSE_REMAP_2027 = Object.fromEntries(
  Object.entries(PBP_REMAP_2027).map(([from, to]) => [to, from])
);

const FETCH_TIMEOUT_MS = 45_000;
const EXTRACT_TIMEOUT_MS = 60_000;

const BROWSER_HEADERS = {
  Accept: 'application/pdf,application/octet-stream,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: DOCTORS_2027_DRUGLIST_PAGE,
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
    with urllib.request.urlopen(r, timeout=float(req.get("timeout") or 45)) as resp:
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
from pathlib import Path
path = sys.argv[1]
try:
    from pypdf import PdfReader
except Exception as e:
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

let _cache = null;
let _inflight = null;

function resetDoctorsFormularyCache() {
  _cache = null;
  _inflight = null;
}

function doctorsContract(planId) {
  const m = String(planId || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .match(/^(H4140)-(\d{3})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function isDoctorsCms(planId) {
  return Boolean(doctorsContract(planId));
}

function matchesPlan(planId, year) {
  return isDoctorsCms(planId) && Number(year || PLAN_YEAR) === PLAN_YEAR;
}

function remapDoctorsPbp(planId, year = PLAN_YEAR) {
  const base = doctorsContract(planId);
  if (!base) return null;
  if (Number(year) !== PLAN_YEAR) return base;
  return PBP_REMAP_2027[base] || base;
}

function doctorsPbpAliases(planId, year = PLAN_YEAR) {
  const base = doctorsContract(planId);
  if (!base) return [];
  const out = [base];
  if (Number(year) !== PLAN_YEAR) return out;
  const mapped = PBP_REMAP_2027[base];
  const prior = REVERSE_REMAP_2027[base];
  if (mapped) out.push(mapped);
  if (prior) out.push(prior);
  return [...new Set(out)];
}

function curlBin() {
  return process.env.DOCTORS_FORMULARY_CURL || process.env.MEDICARE_GOV_CURL || 'curl';
}

function pythonBins() {
  if (process.env.DOCTORS_FORMULARY_PYTHON || process.env.MEDICARE_GOV_PYTHON) {
    return [process.env.DOCTORS_FORMULARY_PYTHON || process.env.MEDICARE_GOV_PYTHON];
  }
  return ['python3', 'python'];
}

function pdftotextBin() {
  return process.env.DOCTORS_PDFTOTEXT || 'pdftotext';
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
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, status: code || 0, text: out, error: code ? `${bin}_exit_${code}` : null });
    });
    try {
      if (stdin != null) child.stdin.write(stdin);
      child.stdin.end();
    } catch (_) {
      /* ignore */
    }
  });
}

function tmpPath(suffix) {
  return path.join(os.tmpdir(), `max-doctors-formulary-${process.pid}-${Date.now()}${suffix}`);
}

function isPdfMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString('utf8') === '%PDF';
}

function looksLikeFormularyText(text) {
  const s = String(text || '');
  return (
    s.length > 80 &&
    /Drug Name\/Nombre del Medicamento|TRINTELLIX|ELIQUIS|Requirements\/Limits/i.test(s) &&
    !/^\s*</.test(s)
  );
}

async function fetchImplBytes(url, fetchImpl, timeoutMs = FETCH_TIMEOUT_MS) {
  if (!fetchImpl) return null;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: BROWSER_HEADERS, signal: ctrl?.signal });
    if (!res) return { ok: false, status: 0, buf: Buffer.alloc(0), error: 'empty_response' };
    let buf = Buffer.alloc(0);
    if (typeof res.arrayBuffer === 'function') {
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (_) {
        buf = Buffer.alloc(0);
      }
    }
    if (!buf.length && typeof res.text === 'function') {
      buf = Buffer.from(await res.text(), 'utf8');
    }
    return { ok: Boolean(res.ok), status: Number(res.status) || 0, buf, error: res.error };
  } catch (err) {
    const label = err && err.name === 'AbortError' ? 'Timeout' : err.message;
    return { ok: false, status: 0, buf: Buffer.alloc(0), error: label };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function curlFetchPdfFile(url, dest) {
  const args = [
    '-sS',
    '-L',
    '--max-time',
    '45',
    '-o',
    dest,
    '-w',
    '%{http_code}',
    '-A',
    BROWSER_HEADERS['User-Agent'],
  ];
  Object.entries(BROWSER_HEADERS).forEach(([key, value]) => {
    if (key === 'User-Agent') return;
    if (value != null) args.push('-H', `${key}: ${value}`);
  });
  args.push(String(url));
  const spawned = await spawnOnce(curlBin(), args, { timeoutMs: FETCH_TIMEOUT_MS + 2_000 });
  if (spawned.error) return { ok: false, status: 0, error: spawned.error };
  const status = Number(String(spawned.text || '').trim()) || 0;
  let buf = Buffer.alloc(0);
  try {
    buf = fs.readFileSync(dest);
  } catch (_) {
    buf = Buffer.alloc(0);
  }
  return { ok: status >= 200 && status < 300 && isPdfMagic(buf), status, buf, error: status ? undefined : 'curl_no_status' };
}

async function pythonFetchPdfFile(url, dest) {
  const payload = JSON.stringify({
    url: String(url),
    headers: BROWSER_HEADERS,
    timeout: 45,
    out: dest,
  });
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
      try {
        buf = fs.readFileSync(dest);
      } catch (_) {
        buf = Buffer.alloc(0);
      }
      last = {
        ok: status >= 200 && status < 300 && (isPdfMagic(buf) || looksLikeFormularyText(buf.toString('utf8'))),
        status,
        buf,
        error: parsed.error,
      };
      if (last.ok || status > 0) return last;
    } catch (err) {
      last = { ok: false, status: 0, buf: Buffer.alloc(0), error: err.message || 'python_bad_output' };
    }
  }
  return last;
}

/**
 * Resilient GET: injected fetch (tests / already-extracted text) is exclusive
 * so unit tests never hit the live CDN. Live path is curl → Python urllib.
 * Node/undici 404s this WordPress PDF — do not use it as the live transport.
 */
async function fetchDoctorsFormularyBytes(url, fetchImpl) {
  if (fetchImpl && fetchImpl !== fetch) {
    return fetchImplBytes(url, fetchImpl);
  }

  const dest = tmpPath('.pdf');
  try {
    const curl = await curlFetchPdfFile(url, dest);
    if (curl.ok) return curl;
    const py = await pythonFetchPdfFile(url, dest);
    if (py.ok || (py.status >= 200 && py.status < 300 && py.buf.length)) return py;
    if (curl.status > 0) return curl;
    return py.status > 0 ? py : { ok: false, status: 0, buf: Buffer.alloc(0), error: 'doctors_formulary_transport_unavailable' };
  } finally {
    try {
      fs.unlinkSync(dest);
    } catch (_) {
      /* ignore */
    }
  }
}

async function extractWithPdftotext(pdfPath) {
  const spawned = await spawnOnce(pdftotextBin(), ['-layout', pdfPath, '-'], { timeoutMs: EXTRACT_TIMEOUT_MS });
  if (spawned.error) return { ok: false, text: '', error: spawned.error };
  if (!spawned.text || spawned.text.length < 200) {
    return { ok: false, text: spawned.text || '', error: spawned.error || 'pdftotext_empty' };
  }
  return { ok: true, text: spawned.text, error: null };
}

async function extractWithPypdf(pdfPath) {
  let last = { ok: false, text: '', error: 'python_missing' };
  for (const bin of pythonBins()) {
    const spawned = await spawnOnce(bin, ['-c', PYTHON_PYPDF, pdfPath], { timeoutMs: EXTRACT_TIMEOUT_MS });
    if (spawned.error) {
      last = { ok: false, text: '', error: spawned.error };
      continue;
    }
    try {
      const parsed = JSON.parse(String(spawned.text || '').trim() || '{}');
      if (parsed.ok && parsed.text) return { ok: true, text: parsed.text, error: null };
      last = { ok: false, text: '', error: parsed.error || 'pypdf_empty' };
    } catch (err) {
      last = { ok: false, text: '', error: err.message || 'pypdf_bad_output' };
    }
  }
  return last;
}

async function extractPdfText(buf) {
  if (looksLikeFormularyText(buf.toString('utf8')) && !isPdfMagic(buf)) {
    return { ok: true, text: buf.toString('utf8'), error: null };
  }
  if (!isPdfMagic(buf)) {
    return { ok: false, text: '', error: 'not_pdf' };
  }
  const dest = tmpPath('.pdf');
  fs.writeFileSync(dest, buf);
  try {
    const layout = await extractWithPdftotext(dest);
    if (layout.ok) return layout;
    const py = await extractWithPypdf(dest);
    if (py.ok) return py;
    return layout.error && !/_missing$/.test(layout.error) ? layout : py;
  } finally {
    try {
      fs.unlinkSync(dest);
    } catch (_) {
      /* ignore */
    }
  }
}

function flagsFromLimits(limits) {
  const s = String(limits || '');
  return {
    pa: /\bPA\b/i.test(s),
    st: /\bST\b/i.test(s),
    ql: /\bQL\b/i.test(s),
  };
}

function normalizeDrugName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/®/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinName(left, right) {
  return [left, right].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function looksLikeStrengthWrap(line) {
  const s = String(line || '').trim();
  if (!s) return false;
  return /^(?:\d+(?:\.\d+)?\s*(?:mg|mcg|ml|hr|hours?|%|units?)\b|[0-9.,\s/%-]+)$/i.test(s);
}

function looksLikeFlagWrap(line) {
  const s = String(line || '').trim();
  return /^(days?|starts?|only|vs\.?|d\/|new starts)\b/i.test(s);
}

function isBoilerplate(line) {
  return /drug name\/nombre|tier\/nivel de|requirements\/limits|requisitos\/l[ií]mites|you can find information|puede encontrar informaci|9\/0?1\/2026|ec-\s*enhanced|nds-\s*non|pa-\s*prior|ql-\s*quantity|st-\s*step|100 ds-|h4140_druglist|dhcpformulary/i.test(
    line
  );
}

function isCategoryHeader(line) {
  const s = String(line || '').trim();
  if (s.length < 8 || /\d/.test(s)) return false;
  return /^[A-Za-z][A-Za-z /&,'()-]+\/[A-Za-záéíóúñüÁÉÍÓÚÑÜ /&,'()-]+$/.test(s);
}

function isIndexLine(line) {
  return /\.{3,}/.test(line) || /^\s*I-\d+\s*$/i.test(line);
}

function splitNameTierLimits(line) {
  const raw = String(line || '').replace(/\s+$/, '');
  if (!raw.trim()) return null;
  const layout = raw.match(/^(.{6,}?)\s{2,}([1-6])(?:\s+(.*))?$/);
  if (layout && /[A-Za-z]/.test(layout[1]) && !/^\d+$/.test(layout[1].trim())) {
    return { name: layout[1].trim(), tier: Number(layout[2]), limits: (layout[3] || '').trim() };
  }
  const flowed = raw
    .trim()
    .match(/^(.{6,}?)\s+([1-6])(?:\s+((?:PA|ST|QL|NDS|EC|100\s*DS).*))?$/i);
  if (flowed && /[A-Za-z]/.test(flowed[1]) && flowed[1].trim().length >= 6) {
    return { name: flowed[1].trim(), tier: Number(flowed[2]), limits: (flowed[3] || '').trim() };
  }
  return null;
}

function drugListSection(text) {
  const s = String(text || '');
  const start = s.search(/Drug Name\/Nombre del Medicamento/i);
  const body = start >= 0 ? s.slice(start) : s;
  const idx = body.search(/\n\s*I-1\b|\nINDEX\b/i);
  return idx > 200 ? body.slice(0, idx) : body;
}

function parseDoctorsFormularyText(text) {
  const rows = [];
  let pendingName = '';
  const body = drugListSection(text);
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isIndexLine(trimmed) || isBoilerplate(trimmed) || isCategoryHeader(trimmed)) continue;
    if (/^\d{1,3}$/.test(trimmed)) continue;

    const split = splitNameTierLimits(line);
    if (split) {
      const name = joinName(pendingName, split.name);
      pendingName = '';
      rows.push({
        name,
        tier: split.tier,
        limits: split.limits,
        ...flagsFromLimits(split.limits),
      });
      continue;
    }

    const flowedTier = trimmed.match(/^([1-6])(?:\s+(.*))?$/);
    if (flowedTier && pendingName && !looksLikeStrengthWrap(trimmed)) {
      const limits = (flowedTier[2] || '').trim();
      rows.push({
        name: pendingName,
        tier: Number(flowedTier[1]),
        limits,
        ...flagsFromLimits(limits),
      });
      pendingName = '';
      continue;
    }

    if (rows.length && looksLikeStrengthWrap(trimmed)) {
      rows[rows.length - 1].name = joinName(rows[rows.length - 1].name, trimmed);
      continue;
    }
    if (rows.length && looksLikeFlagWrap(trimmed)) {
      rows[rows.length - 1].limits = joinName(rows[rows.length - 1].limits, trimmed);
      Object.assign(rows[rows.length - 1], flagsFromLimits(rows[rows.length - 1].limits));
      continue;
    }

    pendingName = joinName(pendingName, trimmed);
  }
  return rows.filter((r) => r.name && r.tier >= 1 && r.tier <= 6 && r.name.length >= 3);
}

function scoreDrugRow(row, query) {
  const n = normalizeDrugName(row.name);
  const q = normalizeDrugName(query);
  if (!n || !q) return -1;
  if (n === q) return 100;
  if (n.startsWith(`${q} `)) return 90;
  const first = n.split(' ')[0];
  if (first === q) return 85;
  if (n.includes(` ${q} `) || n.includes(`${q} `) || n.endsWith(` ${q}`)) return 70;
  if (n.includes(q) && q.length >= 5) return 55;
  const qTokens = q.split(' ').filter((t) => t.length > 3);
  if (qTokens.length && qTokens.every((t) => n.includes(t))) return 40;
  return -1;
}

function matchDrugRow(rows, query) {
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = scoreDrugRow(row, query);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 40 ? best : null;
}

async function loadDoctorsFormularyIndex(fetchImpl, year = PLAN_YEAR) {
  if (Number(year) !== PLAN_YEAR) {
    return { ok: false, rows: [], error: 'doctors_formulary_year_unsupported' };
  }
  if (_cache && _cache.year === Number(year) && _cache.rows && _cache.rows.length) {
    return _cache;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const fetched = await fetchDoctorsFormularyBytes(DOCTORS_2027_FORMULARY_PDF, fetchImpl);
    if (!fetched || !fetched.buf || !fetched.buf.length) {
      return { ok: false, rows: [], error: fetched?.error || 'doctors_formulary_http_0', year: Number(year) };
    }
    if (!fetched.ok && !isPdfMagic(fetched.buf) && !looksLikeFormularyText(fetched.buf.toString('utf8'))) {
      return {
        ok: false,
        rows: [],
        error: fetched.error || `doctors_formulary_http_${fetched.status}`,
        year: Number(year),
      };
    }
    const extracted = await extractPdfText(fetched.buf);
    if (!extracted.ok || !extracted.text) {
      return { ok: false, rows: [], error: extracted.error || 'doctors_formulary_extract_failed', year: Number(year) };
    }
    const rows = parseDoctorsFormularyText(extracted.text);
    if (!rows.length) {
      return { ok: false, rows: [], error: 'doctors_formulary_parse_empty', year: Number(year) };
    }
    _cache = { ok: true, rows, error: null, year: Number(year), text: extracted.text };
    return _cache;
  })().finally(() => {
    _inflight = null;
  });

  return _inflight;
}

async function lookupDoctorsFormulary(
  { drugName = '', ndc = '', planId = '', year = PLAN_YEAR } = {},
  fetchImpl = fetch
) {
  void ndc;
  if (!matchesPlan(planId, year)) {
    return { verified: false, reason: 'not_doctors' };
  }
  const y = Number(year) || PLAN_YEAR;
  const mapped = remapDoctorsPbp(planId, y);
  const index = await loadDoctorsFormularyIndex(fetchImpl, y);
  if (!index.ok) {
    return { verified: false, reason: index.error || 'doctors_formulary_unavailable', source: SOURCE_PDF };
  }
  const row = matchDrugRow(index.rows, drugName);
  if (!row) {
    return {
      verified: false,
      reason: 'doctors_formulary_no_row',
      source: SOURCE_PDF,
      formularyPlanId: mapped,
      note: 'Parsed the 2027 Doctors formulary PDF but did not find a row for this drug. Not inventing a tier.',
    };
  }
  return {
    verified: true,
    coverage: 'covered',
    tier: row.tier,
    pa: row.pa,
    st: row.st,
    ql: row.ql,
    source: SOURCE_PDF,
    formularyPlanId: mapped,
    drugName: row.name,
    limits: row.limits || '',
  };
}

module.exports = {
  SOURCE_PDF,
  SOURCE_CONSUMER,
  CONTRACT,
  PLAN_YEAR,
  DOCTORS_2027_FORMULARY_PDF,
  DOCTORS_2027_DRUGLIST_PAGE,
  DOCTORS_2027_ST_CRITERIA_PDF,
  PBP_REMAP_2027,
  isDoctorsCms,
  matchesPlan,
  remapDoctorsPbp,
  doctorsPbpAliases,
  doctorsContract,
  parseDoctorsFormularyText,
  matchDrugRow,
  flagsFromLimits,
  normalizeDrugName,
  lookupDoctorsFormulary,
  loadDoctorsFormularyIndex,
  resetDoctorsFormularyCache,
  fetchDoctorsFormularyBytes,
  extractPdfText,
};
