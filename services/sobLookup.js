/**
 * Live Summary of Benefits / Evidence of Coverage fallback for benefits
 * that are not on the THEI comparison grid (green cells).
 *
 * Grid first. Then that plan's sobUrl PDF for the asked year. Then that
 * same year's eocUrl if the SOB does not have the asked benefit.
 * Explicit 2026-only asks use #plan-data-2026 URLs and must not open a
 * 2027 EOC. Unspecified / 2027 / both years use 2027 #plan-data.
 * Never invent dollars. Never quote the other year's document.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  DEFAULT_PLAN_YEAR,
  resolveDocumentYear,
  resolveDocumentUrl,
} = require('./planYear');

const PLAN_YEAR = DEFAULT_PLAN_YEAR;
const FETCH_TIMEOUT_MS = 40_000;
const EXTRACT_TIMEOUT_MS = 45_000;
// Full Doctors 2027 booklet is ~69k of pdftotext -layout. Cap must
// include printed page 17 (DME / CPAP) — that block starts after 40k.
const TEXT_CAP = 100_000;

const BENEFIT_KEYS = {
  hearing_aids: 'hearingAids',
  skilled_nursing: 'skilledNursing',
  snf: 'skilledNursing',
  dme: 'dme',
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
const wiredPlansCache = { 2026: null, 2027: null };

function planDataScriptId(year) {
  return Number(year) === 2026 ? 'plan-data-2026' : 'plan-data';
}

function loadWiredPlans(year) {
  const y = Number(year) === 2026 ? 2026 : PLAN_YEAR;
  if (wiredPlansCache[y]) return wiredPlansCache[y];
  try {
    const html = fs.readFileSync(
      path.join(__dirname, '../artifacts/max-demo-FINAL-v7.html'),
      'utf8'
    );
    const id = planDataScriptId(y);
    const m = html.match(
      new RegExp(`<script id="${id}" type="application/json">\\s*([\\s\\S]*?)\\s*</script>`)
    );
    wiredPlansCache[y] = m ? JSON.parse(m[1]) : [];
  } catch (_) {
    wiredPlansCache[y] = [];
  }
  return wiredPlansCache[y];
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

function findWiredPlan(planId, year) {
  const id = normalizePlanId(planId);
  if (!id) return null;
  const y = Number(year) === 2026 ? 2026 : PLAN_YEAR;
  return loadWiredPlans(y).find((p) => idsMatch(p.planId || p.id, id)) || null;
}

function mergeWiredPlan(plan, year) {
  const y = Number(year) === 2026 ? 2026 : PLAN_YEAR;
  const id = plan && (plan.planId || plan.id);
  const wired = findWiredPlan(id, y);
  const passedSob = String((plan && plan.sobUrl) || '').trim();
  const passedEoc = String((plan && plan.eocUrl) || '').trim();
  const wiredSob = String((wired && wired.sobUrl) || '').trim();
  const wiredEoc = String((wired && wired.eocUrl) || '').trim();
  const base = wired ? { ...wired, ...(plan || {}) } : { ...(plan || {}) };
  return {
    ...base,
    planId: String(id || (wired && (wired.planId || wired.id)) || '').trim(),
    year: y,
    sobUrl: resolveDocumentUrl(passedSob, wiredSob, y),
    eocUrl: resolveDocumentUrl(passedEoc, wiredEoc, y) || null,
    hearing: (plan && plan.hearing) || (wired && wired.hearing) || null,
  };
}

function usableGridValue(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/^(not listed|n\/a|na|pending|pending sob|yellow|tbd|none|null)$/i.test(s)) return null;
  return s;
}

function toSnakeBenefit(raw) {
  return String(raw || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function slugToFieldKey(slug) {
  return String(slug || '').replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function normalizeBenefitList(benefits, query) {
  const out = [];
  const seen = new Set();
  const addMapped = (key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };
  const add = (raw) => {
    const key = toSnakeBenefit(raw);
    if (!key) return;
    const mapped = [];
    if (/hearing_aid/.test(key) || key === 'hearing_aids' || key === 'hearingaids') {
      mapped.push('hearingAids');
    }
    if (/snf|skilled_nursing/.test(key)) mapped.push('skilledNursing');
    if ((/\bdme\b|durable_medical/.test(key)) && !/hospital/.test(key)) {
      mapped.push('dme');
    }
    if (/hospital_grade_bed|hospital_bed/.test(key)) {
      mapped.push('dmeHospitalBed');
    }
    if (/chemo|infusion_therapy/.test(key)) mapped.push('chemotherapy');
    if (/home_health/.test(key)) mapped.push('homeHealth');
    if (/dialysis/.test(key)) mapped.push('dialysis');
    if (/physical_therapy/.test(key)) mapped.push('physicalTherapy');
    if (/worldwide_emergency|foreign_travel/.test(key)) mapped.push('worldwideEmergency');
    if (/post_discharge_meals|healthy_meals/.test(key)) mapped.push('postDischargeMeals');
    if (!mapped.length) mapped.push(slugToFieldKey(key));
    mapped.forEach(addMapped);
  };
  (Array.isArray(benefits) ? benefits : benefits ? [benefits] : []).forEach(add);
  if (query) add(query);
  return out;
}

function collapseWs(s) {
  return String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanSnippet(raw, max = 180) {
  const s = collapseWs(String(raw || '').replace(/[•●▪]/g, '·'))
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

function windowAroundAll(text, re, after = 420, before = 40) {
  const src = String(text || '');
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const r = new RegExp(re.source, flags);
  const out = [];
  let m;
  while ((m = r.exec(src))) {
    if (m.index == null) break;
    out.push(src.slice(Math.max(0, m.index - before), Math.min(src.length, m.index + after)));
    if (m[0] === '') r.lastIndex += 1;
  }
  return out;
}

function isDoctorsDualColumn(text) {
  return /DrMax-Dade/i.test(text || '') && /DrSelect-SFL/i.test(text || '');
}

function isDoctorsColumnHeaderLine(line) {
  const src = String(line || '');
  const i = src.search(/DrSelect-SFL/i);
  if (i < 24) return false;
  // Real pdftotext -layout headers have a wide gap before DrSelect-SFL.
  // Collapsed "DrMax-Dade (HMO) DrSelect-SFL (HMO)" blobs do not.
  return /^\s+$/.test(src.slice(Math.max(0, i - 8), i));
}

function doctorsSelectColumnX(text) {
  const xs = [];
  String(text || '')
    .split(/\n/)
    .forEach((line) => {
      if (!isDoctorsColumnHeaderLine(line)) return;
      xs.push(line.search(/DrSelect-SFL/i));
    });
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  const mid = xs[Math.floor(xs.length / 2)];
  const clustered = xs.filter((x) => Math.abs(x - mid) <= 18);
  if (!clustered.length) return null;
  return clustered[Math.floor(clustered.length / 2)];
}

function contentSplitX(page) {
  const xs = [];
  String(page || '')
    .split(/\n/)
    .forEach((line) => {
      const hits = [];
      const re = /\$[\d,]+|\d+\s*%/g;
      let m;
      while ((m = re.exec(line))) {
        if (m.index >= 16) hits.push(m.index);
      }
      // "0% - 20%" in one column is ~4 chars apart. True two-column
      // money sits 20+ columns apart ($75 left / $60 right, 0% / 0%).
      if (hits.length >= 2) {
        const right = hits.find((x) => x - hits[0] >= 20);
        if (right != null) xs.push(right);
      }
    });
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  return xs[0];
}

function pageSplitX(page, fallbackX) {
  return doctorsSelectColumnX(page) ?? contentSplitX(page) ?? fallbackX;
}

function slicePageColumn(page, wantRight, fallbackX) {
  const splitX = pageSplitX(page, fallbackX);
  if (splitX == null) return page;
  return page
    .split(/\n/)
    .map((line) => {
      if (line.length < splitX) return line;
      return wantRight ? line.slice(splitX) : line.slice(0, splitX);
    })
    .join('\n');
}

function sliceDoctorsColumn(text, planHint) {
  const src = String(text || '');
  if (!isDoctorsDualColumn(src)) return src;
  const hint = String(planHint || '');
  const wantRight = /H4140-023/i.test(hint);
  const wantLeft = /H4140-022/i.test(hint);
  if (!wantRight && !wantLeft) return src;
  const fallbackX = doctorsSelectColumnX(src);
  return src
    .split(/\f/)
    .map((page) => slicePageColumn(page, wantRight, fallbackX))
    .join('\n');
}

function extractMoneyAfter(blob, dayRe) {
  const m = String(blob || '').match(dayRe);
  if (!m) return null;
  // "$0 copay per day: days 1-20" puts the money BEFORE the label. Taking the money after
  // the label would grab the next band's amount (swapping $0 and $221), so give up instead.
  const before = String(blob).slice(Math.max(0, m.index - 60), m.index);
  const moneyBefore = before.match(/(\$[\d,]+(?:\.\d{2})?\s*(?:copay|coinsurance)?\s*(?:per\s+day|\/\s*day)\s*(?:for|:|-|–)?\s*)$/i);
  if (moneyBefore) {
    // Label-after layout ("Days 1-20 $0 copay per day  Days 21-100 ...") has a day label
    // right before that money; it belongs to the previous band, so reading after is fine.
    const lead = before.slice(0, before.length - moneyBefore[1].length);
    if (!/days?\s*\d+\s*(?:-|–|—|through|to)\s*\d+\s*:?\s*$/i.test(lead)) return null;
  }
  let tail = blob.slice(m.index, Math.min(blob.length, m.index + 160));
  // Stop at the next "days N" label so one band can never take the next band's amount.
  const next = tail.slice(m[0].length).search(/days?\s*\d+\s*(?:-|–|—|through|to)\s*\d+/i);
  if (next >= 0) tail = tail.slice(0, m[0].length + next);
  const money = tail.match(
    /\$[\d,]+(?:\.\d{2})?(?:\s*(?:copay|coinsurance|per day|\/day))?|\d+\s*%(?:\s*coinsurance)?|no copay|\$0(?:\s*copay)?/i
  );
  if (!money) return null;
  return cleanSnippet(`${m[0]}: ${money[0]}`.replace(/\s+/g, ' '), 80);
}

function collectSnfBandAmounts(win, startDay, endDay) {
  const src = String(win || '');
  const amounts = [];
  const range = `days?\\s*${startDay}(?!\\d)\\s*(?:-|–|—|through|to)\\s*${endDay}(?!\\d)`;
  // Require "copay per day for days N" so "$0 copay Days 21" (prior band) cannot
  // steal the next range. Matches the Doctors 2027 booklet and collapsed dual text.
  const patterns = [
    new RegExp(
      `(\\$[\\d,]+(?:\\.\\d{2})?)\\s+copay\\s+per\\s+day(?:\\s+for|\\s*:|\\s*[-–])\\s*${range}`,
      'ig'
    ),
  ];
  patterns.forEach((re) => {
    let m;
    const r = new RegExp(re.source, 'ig');
    while ((m = r.exec(src))) {
      const money = m[1];
      if (money && !amounts.includes(money)) amounts.push(money);
    }
  });
  return amounts;
}

function pickDualColumnAmount(amounts, planHint, fullText) {
  if (!amounts.length) return null;
  const dual = /DrMax-Dade/i.test(fullText || '') && /DrSelect-SFL/i.test(fullText || '');
  if (dual && amounts.length > 1 && /H4140-023|DrSelect/i.test(String(planHint || ''))) {
    return amounts[amounts.length - 1];
  }
  return amounts[0];
}

function parseSkilledNursing(text, planHint) {
  const scoped = sliceDoctorsColumn(text, planHint);
  const blob = collapseWs(scoped);
  if (!/skilled nursing|\bSNF\b/i.test(blob)) {
    return { days1to20: null, days21to100: null };
  }
  const windows = windowAroundAll(
    scoped,
    /skilled nursing facility|\bSNF\b|skilled nursing/i,
    900,
    500
  ).map((w) => collapseWs(w));
  const win =
    windows.find((w) =>
      /days?\s*1\s*(?:-|–|—|through|to)\s*20/i.test(w) ||
      /days?\s*21\s*(?:-|–|—|through|to)\s*100/i.test(w)
    ) ||
    windows[0] ||
    blob;
  const dualDoctors = isDoctorsDualColumn(blob) || isDoctorsDualColumn(text);
  // The "$X copay per day for days N" sentence shape was built for the Doctors booklet.
  // On other carriers' PDFs it can match a different line, so only use it for Doctors.
  const doctorsPlan = dualDoctors || /^H4140-/i.test(String(planHint || ''));
  // Other carriers: use the same "$X copay per day for days N" shape only when it is
  // unambiguous (exactly one amount for that band). Two different amounts = Unverified.
  let ambiguous1 = false;
  let ambiguous21 = false;
  let band1 = collectSnfBandAmounts(win, 1, 20);
  let band21 = collectSnfBandAmounts(win, 21, 100);
  if (!doctorsPlan) {
    if (band1.length > 1) { ambiguous1 = true; band1 = []; }
    if (band21.length > 1) { ambiguous21 = true; band21 = []; }
  }
  const picked1 = pickDualColumnAmount(band1, planHint, dualDoctors ? text : scoped);
  const picked21 = pickDualColumnAmount(band21, planHint, dualDoctors ? text : scoped);
  let days1to20 = picked1
    ? cleanSnippet(`Days 1-20: ${picked1}`, 80)
    : ambiguous1 ? null : extractMoneyAfter(win, /days?\s*1\s*(?:-|–|—|through|to)\s*20/i) ||
      extractMoneyAfter(win, /\$[\d,]+(?:\.\d{2})?[^.]{0,40}days?\s*1\s*(?:-|–|through|to)\s*20/i) ||
      extractMoneyAfter(win, /days?\s*1\s*(?:-|–|—|through|to)\s*\$[\d,]+(?:\.\d{2})?\s*copay\s*20/i);
  let days21to100 = picked21
    ? cleanSnippet(`Days 21-100: ${picked21}`, 80)
    : ambiguous21 ? null : extractMoneyAfter(win, /days?\s*21\s*(?:-|–|—|through|to)\s*100/i) ||
      extractMoneyAfter(win, /\$[\d,]+(?:\.\d{2})?[^.]{0,40}days?\s*21\s*(?:-|–|through|to)\s*100/i) ||
      extractMoneyAfter(win, /days?\s*21\s*(?:-|–|—|through|to)\s*\$[\d,]+(?:\.\d{2})?\s*copay\s*100/i);
  return { days1to20, days21to100 };
}

function parseHearingAids(text) {
  const win = collapseWs(windowAround(text, /hearing\s+aids?/i, 480, 10));
  if (!win || !hasMoneyOrCoverage(win)) return null;
  const sentence = win.match(/hearing\s+aids?[^.]{0,160}(?:\$[\d,]+|\d+\s*%|no copay|covered|not covered)[^.]{0,80}/i);
  return cleanSnippet(sentence ? sentence[0] : win, 160);
}

function namesHospitalBed(text) {
  return /hospital[-\s]?grade bed|hospital bed/i.test(text || '');
}

function extractDrSelectDme(text) {
  const win = collapseWs(
    [
      windowAround(text, /durable medical equipment|\bDME\b/i, 900, 700),
      windowAround(text, /CPAP/i, 500, 240),
    ].join('\n')
  );
  const src = win || collapseWs(text);
  if (!/0%\s*coinsurance/i.test(src) || !/20%\s*coinsurance/i.test(src)) return null;
  if (!/CPAP/i.test(src) || !/powered wheelchair/i.test(src)) return null;
  return cleanSnippet(
    '0% (CPAP, most equipment) · 20% (powered wheelchairs, powered mattress systems, other electric devices)',
    240
  );
}

function parseDme(text, planHint) {
  const scoped = sliceDoctorsColumn(text, planHint);
  const blob = collapseWs(scoped);
  if (/H4140-023|H4140-022/i.test(String(planHint || ''))) {
    // Printed page 17 is the same in both columns. Prefer the sliced
    // column; fall back to the full booklet so a tight slice cannot drop 0%/20%.
    const quoted = extractDrSelectDme(scoped) || extractDrSelectDme(text);
    if (quoted) return quoted;
    if (/H4140-023/i.test(String(planHint || ''))) return null;
  }
  const win = collapseWs(windowAround(scoped, /durable medical equipment|\bDME\b/i, 480, 400));
  if (!win || !hasMoneyOrCoverage(win)) return null;
  if (namesHospitalBed(win) && !/CPAP|powered wheelchair|all other medical equipment/i.test(win)) {
    return null;
  }
  const sentence = win.match(
    /(?:durable medical equipment|\bDME\b)[^.]{0,160}(?:\$[\d,]+|\d+\s*%|covered|not covered|no copay)[^.]{0,80}/i
  );
  return cleanSnippet(sentence ? sentence[0] : win, 160);
}

function parseHospitalBed(text, planHint) {
  const scoped = sliceDoctorsColumn(text, planHint);
  if (!namesHospitalBed(scoped)) return null;
  const win = collapseWs(windowAround(scoped, /hospital[-\s]?grade bed|hospital bed/i, 480, 40));
  if (!win || !hasMoneyOrCoverage(win)) return null;
  const sentence = win.match(
    /(?:hospital[-\s]?grade bed|hospital bed)[^.]{0,160}(?:\$[\d,]+|\d+\s*%|covered|not covered|no copay)[^.]{0,80}/i
  );
  return cleanSnippet(sentence ? sentence[0] : win, 160);
}

function parseDmeHospitalBed(text, planHint) {
  const bed = parseHospitalBed(text, planHint);
  if (bed) return bed;
  if (/H4140-023/i.test(String(planHint || ''))) return null;
  return parseDme(text, planHint);
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikePdfFragment(s) {
  if (/[•]|\u2026$|\.\.\.$/.test(s)) return true;
  if (/^[a-z]/.test(s) && !/^(no|yes|up to|not|covered|included|days?)\b/.test(s)) return true;
  if (/\be\.g\.,|\(e\.g\./i.test(s)) return true;
  if ((s.match(/ · /g) || []).length >= 3) return true;
  return false;
}

const GENERIC_PHRASES = {
  chemotherapy: ['chemotherapy', 'chemo', 'infusion therapy'],
  homeHealth: ['home health'],
  dialysis: ['dialysis'],
  physicalTherapy: ['physical therapy'],
  worldwideEmergency: ['worldwide emergency', 'emergency care worldwide', 'foreign travel'],
  postDischargeMeals: ['post-discharge meals', 'post discharge meals', 'healthy meals'],
};

function phrasesFromFieldKey(key) {
  const titled = String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
  return titled ? [titled] : [];
}

function parseGenericBenefit(text, phrases) {
  const list = Array.isArray(phrases) ? phrases : [phrases];
  for (const phrase of list) {
    if (!phrase) continue;
    let re;
    try {
      re = new RegExp(escapeRe(phrase), 'i');
    } catch (_) {
      continue;
    }
    const win = collapseWs(windowAround(text, re, 480, 10));
    if (!win || !hasMoneyOrCoverage(win)) continue;
    const sentence = win.match(
      new RegExp(
        escapeRe(phrase) + '[^.]{0,160}(?:\\$[\\d,]+|\\d+\\s*%|no copay|covered|not covered)[^.]{0,80}',
        'i'
      )
    );
    const snippet = cleanSnippet(sentence ? sentence[0] : win, 160);
    if (snippet && hasMoneyOrCoverage(snippet) && !looksLikePdfFragment(snippet)) return snippet;
  }
  return null;
}

function parseSobBenefits(text, extraKeys, planHint) {
  const scoped = sliceDoctorsColumn(text, planHint);
  const snf = parseSkilledNursing(scoped, planHint);
  const out = {
    hearingAids: parseHearingAids(scoped),
    snfDays1to20: snf.days1to20,
    snfDays21to100: snf.days21to100,
    dme: parseDme(scoped, planHint),
    dmeHospitalBed: parseHospitalBed(scoped, planHint),
  };
  (extraKeys || []).forEach((key) => {
    if (out[key] !== undefined) return;
    out[key] = parseGenericBenefit(scoped, GENERIC_PHRASES[key] || phrasesFromFieldKey(key));
  });
  return out;
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
  const add = (key) => {
    if (key && keys.indexOf(key) < 0) keys.push(key);
  };
  (wanted || []).forEach((w) => {
    if (w === 'hearingAids') add('hearingAids');
    else if (w === 'skilledNursing') {
      add('snfDays1to20');
      add('snfDays21to100');
    } else if (w === 'dme') add('dme');
    else if (w === 'dmeHospitalBed') add('dmeHospitalBed');
    else add(w);
  });
  return keys;
}

function pickRequested(parsed, wanted) {
  const row = {};
  requestedFieldKeys(wanted).forEach((key) => {
    row[key] = parsed[key] || null;
  });
  return row;
}

function gridFallback(plan, wanted, year) {
  const out = {};
  const y = Number(year) === 2026 ? 2026 : PLAN_YEAR;
  if (wanted.includes('hearingAids')) {
    const hearing = usableGridValue(plan && plan.hearing);
    if (hearing && /aid/i.test(hearing)) out.hearingAids = { value: hearing, source: `grid_${y}` };
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
    eocUrl = '',
    plans = [],
    benefits = [],
    query = '',
    year,
    askText = '',
    systemText = '',
    sobText = '',
    sobTextByPlanId = {},
    eocText = '',
    eocTextByPlanId = {},
  } = {},
  fetchImpl
) {
  const y = resolveDocumentYear({ year, askText, systemText, plans });
  const wanted = normalizeBenefitList(benefits, query);
  const ids = [...(planId ? [planId] : []), ...(Array.isArray(planIds) ? planIds : [])]
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const planList = (Array.isArray(plans) ? plans.slice() : []).map((p) => mergeWiredPlan(p, y));
  if (ids.length && !planList.length && sobUrl) {
    planList.push(mergeWiredPlan({ planId: ids[0], sobUrl, eocUrl }, y));
  }
  ids.forEach((id) => {
    if (!planList.some((p) => idsMatch(p.planId || p.id, id))) {
      planList.push(mergeWiredPlan({
        planId: id,
        sobUrl: ids.length === 1 ? sobUrl : '',
        eocUrl: ids.length === 1 ? eocUrl : '',
      }, y));
    }
  });
  if (!planList.length && sobUrl) {
    planList.push(mergeWiredPlan({ planId: 'unknown', sobUrl, eocUrl }, y));
  }

  const byPlanId = {};
  const lookups = [];

  for (const plan of planList) {
    const id = String(plan.planId || plan.id || '').trim() || 'unknown';
    const url = String(plan.sobUrl || '').trim();
    const planEocUrl = String(plan.eocUrl || '').trim();
    const fromGrid = gridFallback(plan, wanted, y);
    const keys = requestedFieldKeys(wanted);
    const gridCoversAll = keys.length > 0 && keys.every((key) => fromGrid[key] && fromGrid[key].value);
    let parsed = {
      hearingAids: null,
      snfDays1to20: null,
      snfDays21to100: null,
      dme: null,
      dmeHospitalBed: null,
    };
    let sourceUrl = url || null;
    let readError = null;
    let sobRead = false;

    const injected = sobTextByPlanId[id] || sobText;
    if (injected) {
      parsed = parseSobBenefits(injected, keys, id);
      sobRead = true;
      sourceUrl = sourceUrl || 'injected';
    } else if (url && !gridCoversAll) {
      const fetched = await fetchSobText(url, fetchImpl);
      sourceUrl = fetched.sourceUrl || url;
      if (fetched.ok && fetched.text) {
        parsed = parseSobBenefits(fetched.text, keys, id);
        sobRead = true;
      } else {
        readError = fetched.error || 'sob_unreadable';
      }
    } else if (!url) {
      readError = 'no_sob_url';
    }

    const fromSob = pickRequested(parsed, wanted);
    const missing = keys.filter((key) => !fromGrid[key] && !fromSob[key]);
    let fromEoc = {};
    let eocRead = false;
    let eocError = null;
    const injectedEoc = eocTextByPlanId[id] || eocText;
    const callerPassedEoc = Boolean(eocUrl || eocText || eocTextByPlanId[id]);
    if (missing.length) {
      if (injectedEoc) {
        fromEoc = pickRequested(parseSobBenefits(injectedEoc, missing, id), wanted);
        eocRead = true;
      } else if (planEocUrl && (!injected || callerPassedEoc)) {
        const fetched = await fetchSobText(planEocUrl, fetchImpl);
        if (fetched.ok && fetched.text) {
          fromEoc = pickRequested(parseSobBenefits(fetched.text, missing, id), wanted);
          eocRead = true;
        } else {
          eocError = fetched.error || 'eoc_unreadable';
        }
      }
    }
    const fields = {};
    keys.forEach((key) => {
      if (fromGrid[key]) {
        fields[key] = { value: fromGrid[key].value, source: fromGrid[key].source, verified: true };
      } else if (fromSob[key]) {
        fields[key] = { value: fromSob[key], source: 'sob', verified: true };
      } else if (fromEoc[key]) {
        fields[key] = { value: fromEoc[key], source: 'eoc', verified: true };
      } else if (sobRead && eocRead) {
        fields[key] = { value: null, source: 'eoc', verified: false, reason: 'not_in_sob_or_eoc' };
      } else if (sobRead) {
        fields[key] = { value: null, source: 'sob', verified: false, reason: eocError || 'not_in_sob' };
      } else {
        fields[key] = { value: null, source: null, verified: false, reason: readError || 'unverified' };
      }
    });

    const row = {
      planId: id,
      year: y,
      sobUrl: url || null,
      eocUrl: planEocUrl || null,
      sourceUrl,
      sobRead,
      eocRead,
      reason: readError || eocError,
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
    lines.push(`${row.planId}: ${row.sobRead ? 'SOB read' : 'SOB unread'}${row.reason ? ` (${row.reason})` : ''}${row.sobUrl ? ` [SoB](${row.sobUrl})` : ''}${row.eocUrl ? ` [EOC](${row.eocUrl})` : ''}`);
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

const EXPORT_SOB_FIELD_KEYS = ['snfDays1to20', 'snfDays21to100', 'dmeHospitalBed'];
const EXPORT_SOB_BENEFITS = ['skilled_nursing', 'dme'];
const CMS_PLAN_ID_RE = /\b[HR]\d{3,4}[\s-]?\d{2,4}[A-Z]?(?:\s*\/\s*-?\d{2,4})?\b/gi;
const ASKED_EXPORT_SOB_RE =
  /\b(snf|skilled nursing|hospital[-\s]?grade bed|hospital bed|\bdme\b|durable medical)\b/i;

function askedOffGridFromText(text) {
  try {
    const exp = require('../artifacts/comparison-export');
    if (exp && typeof exp.askedOffGridBenefits === 'function') {
      return exp.askedOffGridBenefits(text);
    }
  } catch (_) {
    /* fall through */
  }
  const asked = ASKED_EXPORT_SOB_RE.test(String(text || ''));
  return {
    asked,
    benefits: asked ? EXPORT_SOB_BENEFITS.slice() : [],
    fieldKeys: asked ? EXPORT_SOB_FIELD_KEYS.slice() : [],
    query: asked ? 'SNF days 1-20, SNF days 21-100, hospital-grade bed / DME' : '',
  };
}

function messagePlainText(messages) {
  return (messages || [])
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
          .filter(Boolean)
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

function citedPlanIdsFromText(text) {
  const re = new RegExp(CMS_PLAN_ID_RE.source, 'gi');
  const seen = new Set();
  const out = [];
  (String(text || '').match(re) || []).forEach((raw) => {
    const id = normalizePlanId(raw).split('/')[0];
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  });
  return out;
}

function rowHasExportSobFields(row, fieldKeys) {
  if (!row || typeof row !== 'object') return false;
  const fields = row.fields && typeof row.fields === 'object' ? row.fields : row;
  const keys = fieldKeys && fieldKeys.length ? fieldKeys : EXPORT_SOB_FIELD_KEYS;
  return keys.some((key) => Object.prototype.hasOwnProperty.call(fields, key));
}

function planIdsCoveredBySobToolResults(toolResults, fieldKeys) {
  const ids = new Set();
  (toolResults || []).forEach((tr) => {
    if (!tr || tr.tool !== 'lookup_sob_benefit') return;
    const out = tr.output || {};
    (out.lookups || []).forEach((row) => {
      if (row && row.planId && rowHasExportSobFields(row, fieldKeys)) ids.add(normalizePlanId(row.planId));
    });
    [out.sobBenefits, out.byPlanId].forEach((map) => {
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach((id) => {
        if (rowHasExportSobFields(map[id], fieldKeys)) ids.add(normalizePlanId(id));
      });
    });
  });
  return ids;
}

function uniquePlanIdsNeedingExportSob(messages, toolResults, fieldKeys) {
  const text = messagePlainText(messages);
  const asked = askedOffGridFromText(text);
  const keys = fieldKeys && fieldKeys.length ? fieldKeys : asked.fieldKeys.length ? asked.fieldKeys : EXPORT_SOB_FIELD_KEYS;
  const planIds = citedPlanIdsFromText(text);
  const covered = planIdsCoveredBySobToolResults(toolResults, keys);
  return planIds.filter((id) => !covered.has(normalizePlanId(id)) && !covered.has(id));
}

// Only when the agent asked for an off-grid benefit — never on every compare.
function shouldAutoLookupComparisonSob(messages, toolResults) {
  const text = messagePlainText(messages);
  const asked = askedOffGridFromText(text);
  if (!asked.asked) return false;
  const planIds = citedPlanIdsFromText(text);
  if (!planIds.length) return false;
  return uniquePlanIdsNeedingExportSob(messages, toolResults, asked.fieldKeys).length > 0;
}

function resetSobCache() {
  textCache.clear();
  wiredPlansCache[2026] = null;
  wiredPlansCache[2027] = null;
}

module.exports = {
  PLAN_YEAR,
  BENEFIT_KEYS,
  usableGridValue,
  normalizeBenefitList,
  requestedFieldKeys,
  parseSobBenefits,
  parseGenericBenefit,
  parseHearingAids,
  parseSkilledNursing,
  parseDme,
  parseHospitalBed,
  parseDmeHospitalBed,
  lookupSobBenefits,
  askedOffGridFromText,
  formatSobLookupText,
  toExportSobBenefits,
  fetchSobText,
  driveDirectUrl,
  findWiredPlan,
  loadWiredPlans,
  mergeWiredPlan,
  resetSobCache,
  sliceDoctorsColumn,
  EXPORT_SOB_FIELD_KEYS,
  EXPORT_SOB_BENEFITS,
  ASKED_EXPORT_SOB_RE,
  messagePlainText,
  citedPlanIdsFromText,
  planIdsCoveredBySobToolResults,
  uniquePlanIdsNeedingExportSob,
  shouldAutoLookupComparisonSob,
};
