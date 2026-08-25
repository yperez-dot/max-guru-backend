/**
 * Refresh Max SEP knowledge from the live Agent Medicare Hub tracker app.
 * Writes max-knowledge/hub/{seps.json,sep-tracker.md,seps-by-state/*} and reloads the KB cache.
 */
const fs = require('fs');
const path = require('path');
const { loadKnowledge } = require('../knowledge/loader');

const HUB_DIR = path.join(__dirname, '../max-knowledge/hub');
const STATE_DIR = path.join(HUB_DIR, 'seps-by-state');
const UA = 'Mozilla/5.0 (compatible; THEI-Max-SEP-refresh/1.0)';

const SOURCES = [
  'https://www.agentmedicarehub.com/sep-tracker-app.html',
  'https://raw.githubusercontent.com/yperez-dot/agent-medicare-hub/main/pages/sep-tracker-app.html',
];

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

let _status = {
  enabled: true,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastSourceUrl: null,
  lastCounts: null,
  intervalMs: null,
};

function getStatus() {
  return { ..._status };
}

function todayISO(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function parseMdy(token) {
  if (!token) return null;
  let t = String(token).trim().replace(/[\u2013\u2014]/g, '-');
  if (!t || /year-?round|ongoing|n\/?a/i.test(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (m) {
    const mi = MONTHS[m[1].toLowerCase()];
    if (mi == null) return null;
    const dt = new Date(Date.UTC(Number(m[3]), mi, Number(m[2])));
    return dt.toISOString().slice(0, 10);
  }
  const m2 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) {
    const dt = new Date(Date.UTC(Number(m2[3]), Number(m2[1]) - 1, Number(m2[2])));
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

function splitWindow(window) {
  if (!window) return [null, null];
  const w = String(window).replace(/[\u2013\u2014]/g, '–');
  if (/year-?round/i.test(w)) {
    const left = w.split(/\s*[–-]\s*/)[0].trim();
    return [parseMdy(left), null];
  }
  const parts = w.split(/\s*[–-]\s*/);
  if (parts.length === 1) return [parseMdy(parts[0]), null];
  return [parseMdy(parts[0]), parseMdy(parts[1])];
}

function countiesList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  if (['ALL', 'ALL COUNTIES', 'STATEWIDE'].includes(s.toUpperCase())) return ['STATEWIDE'];
  return s
    .split(/,|\band\b/i)
    .map((p) => p.replace(/\s+/g, ' ').replace(/\s+counties$/i, '').trim().replace(/[.;]+$/, ''))
    .filter(Boolean);
}

function normalizeStatus(s) {
  s = String(s || '').trim().toLowerCase();
  if (['active', 'ended', 'expiring', 'yearround'].includes(s)) return s;
  if (s.includes('end')) return 'ended';
  if (s.includes('expir')) return 'expiring';
  if (s.includes('year')) return 'yearround';
  return s || 'active';
}

function convertItem(raw, today) {
  let [sepEff, sepTerm] = splitWindow(raw.sepWindow || '');
  if (raw.sepEnd) sepTerm = String(raw.sepEnd).slice(0, 10);
  const [incEff, incTerm] = splitWindow(raw.incidentWindow || '');
  const status = normalizeStatus(raw.status);
  let daysUntil = null;
  let daysSince = null;
  if (sepTerm) {
    const end = new Date(`${sepTerm}T00:00:00Z`);
    if (!Number.isNaN(end.getTime())) {
      const delta = Math.round((end - today) / 86400000);
      if (delta >= 0) daysUntil = delta;
      else daysSince = Math.abs(delta);
    }
  }
  const countiesRaw = raw.counties;
  const decls = raw.declarations || [];
  const declNum = Array.isArray(decls) ? decls.map(String).join(', ') : String(decls || '');
  return {
    id: raw.id,
    raw_status: raw.status,
    status,
    entity: 'Hub tracker',
    state: raw.state,
    state_raw: raw.state,
    lookback: null,
    declaration_name: String(raw.name || '').replace(/\n\n/g, ' — '),
    declaration_number: declNum || null,
    disaster_type_raw: raw.type,
    disaster_types: String(raw.type || '').split(/[;\n]+/).map((t) => t.trim()).filter(Boolean),
    declaration_type: null,
    counties: countiesList(countiesRaw),
    counties_raw: typeof countiesRaw === 'string' ? countiesRaw : countiesList(countiesRaw).join(', '),
    declaration_date: null,
    incident_effective: incEff,
    incident_termination: incTerm,
    sep_effective: sepEff,
    sep_termination: sepTerm,
    days_until_expiry: daysUntil,
    days_since_expiry: daysSince,
    sep_window_raw: raw.sepWindow,
    incident_window_raw: raw.incidentWindow,
    sort_rank: raw.sortRank,
  };
}

async function fetchHtml() {
  let lastErr = '';
  for (const url of SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = `${url}: HTTP ${res.status}`;
        continue;
      }
      const text = await res.text();
      if (!text.includes('var DATA=')) {
        lastErr = `${url}: no DATA blob`;
        continue;
      }
      return { html: text, url };
    } catch (e) {
      lastErr = `${url}: ${e.message}`;
    }
  }
  throw new Error(`Failed to fetch SEP tracker: ${lastErr}`);
}

function extractData(html) {
  let m = html.match(/var DATA=(\[[\s\S]*?\]);\s*\n/);
  if (!m) m = html.match(/var DATA=(\[[\s\S]*?\]);/);
  if (!m) throw new Error('Could not find var DATA=[...] in tracker HTML');
  return JSON.parse(m[1]);
}

function jsonField(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function writeMarkdown(seps) {
  const order = { active: 0, expiring: 1, yearround: 2, ended: 3 };
  const lines = [
    '# SEP Tracker Reference (Agent Medicare Hub)',
    '',
    `Snapshot: generated_at=${seps.generated_at} last_imported=${seps.last_imported} last_updated=${seps.last_updated}`,
    `Counts: ${JSON.stringify(seps.counts)}`,
    `Source: ${seps.source}`,
    `Live UI: ${seps.live_url}`,
    '',
    'Use for Special Enrollment Period questions. Cite SEP id/name, counties, and windows.',
    'Prefer state files under hub/seps-by-state/XX for focused answers.',
    'For the interactive tracker, agents can open Agent Medicare Hub → SEP Tracker.',
    '',
  ];
  const items = [...seps.items].sort(
    (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
      || String(a.state || '').localeCompare(String(b.state || ''))
      || String(a.id || '').localeCompare(String(b.id || '')),
  );
  for (const it of items) {
    const header = [it.id, it.declaration_name].filter(Boolean).join(' — ');
    lines.push(`## ${header || 'SEP entry'}`);
    for (const [k, v] of Object.entries(it)) {
      const rendered = jsonField(v);
      if (rendered == null) continue;
      lines.push(`- **${k}**: ${rendered}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(HUB_DIR, 'sep-tracker.md'), lines.join('\n'), 'utf8');
}

function writeByState(seps) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (f.endsWith('.md')) fs.unlinkSync(path.join(STATE_DIR, f));
  }
  const by = {};
  for (const it of seps.items) {
    const st = String(it.state || 'XX').toUpperCase();
    (by[st] ||= []).push(it);
  }
  const order = { active: 0, expiring: 1, yearround: 2, ended: 3 };
  const fields = [
    'status', 'raw_status', 'entity', 'declaration_name', 'disaster_types', 'disaster_type_raw',
    'counties', 'counties_raw', 'sep_effective', 'sep_termination', 'sep_window_raw',
    'incident_effective', 'incident_termination', 'incident_window_raw', 'days_until_expiry',
    'declaration_number', 'lookback', 'declaration_type',
  ];
  for (const st of Object.keys(by).sort()) {
    const items = by[st].sort(
      (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
        || String(a.id || '').localeCompare(String(b.id || '')),
    );
    const lines = [
      `# SEP Tracker — ${st}`,
      '',
      `${items.length} entries from Agent Medicare Hub SEP snapshot (${seps.last_updated}).`,
      `Source: ${seps.source}`,
      '',
    ];
    for (const it of items) {
      lines.push(`## ${it.id} — ${it.declaration_name}`);
      for (const k of fields) {
        const rendered = jsonField(it[k]);
        if (rendered == null) continue;
        lines.push(`- **${k}**: ${rendered}`);
      }
      lines.push('');
    }
    fs.writeFileSync(path.join(STATE_DIR, `${st}.md`), lines.join('\n'), 'utf8');
  }
}

async function refreshSepTracker({ reason = 'manual' } = {}) {
  _status.lastAttemptAt = new Date().toISOString();
  _status.lastError = null;
  try {
    const { html, url } = await fetchHtml();
    const rawItems = extractData(html);
    if (!Array.isArray(rawItems) || rawItems.length < 50) {
      throw new Error(`Unexpected DATA size: ${rawItems && rawItems.length}`);
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const items = rawItems.map((r) => convertItem(r, today));
    const counts = {
      total: items.length,
      active: items.filter((i) => i.status === 'active').length,
      expiring: items.filter((i) => i.status === 'expiring').length,
      ended: items.filter((i) => i.status === 'ended').length,
      yearround: items.filter((i) => i.status === 'yearround').length,
      fl_active: items.filter((i) => i.state === 'FL' && (i.status === 'active' || i.status === 'expiring')).length,
    };
    const seps = {
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      today: todayISO(),
      last_imported: todayISO(),
      last_updated: todayISO(),
      source: `Agent Medicare Hub live sep-tracker-app.html (runtime refresh: ${reason})`,
      source_url: url,
      live_url: 'https://www.agentmedicarehub.com/sep-tracker',
      counts,
      items,
    };
    fs.mkdirSync(HUB_DIR, { recursive: true });
    fs.writeFileSync(path.join(HUB_DIR, 'seps.json'), JSON.stringify(seps, null, 2), 'utf8');
    writeMarkdown(seps);
    writeByState(seps);
    loadKnowledge({ force: true });
    _status.lastSuccessAt = new Date().toISOString();
    _status.lastSourceUrl = url;
    _status.lastCounts = counts;
    console.log(`[SEP refresh] ok reason=${reason} total=${counts.total} fl_active=${counts.fl_active} from=${url}`);
    return { ok: true, counts, sourceUrl: url };
  } catch (err) {
    _status.lastError = err.message;
    console.error(`[SEP refresh] failed reason=${reason}:`, err.message);
    return { ok: false, error: err.message };
  }
}

function startSepRefreshScheduler() {
  const disabled = /^(0|false|off|no)$/i.test(String(process.env.SEP_REFRESH_ENABLED || 'true'));
  if (disabled) {
    _status.enabled = false;
    console.log('[SEP refresh] disabled via SEP_REFRESH_ENABLED');
    return;
  }
  _status.enabled = true;
  const hours = Math.max(1, Number(process.env.SEP_REFRESH_HOURS || 24));
  const intervalMs = hours * 60 * 60 * 1000;
  _status.intervalMs = intervalMs;

  // Startup: don't block listen(); refresh shortly after boot.
  const startupDelayMs = Number(process.env.SEP_REFRESH_STARTUP_DELAY_MS || 5000);
  setTimeout(() => {
    refreshSepTracker({ reason: 'startup' });
  }, startupDelayMs);

  setInterval(() => {
    refreshSepTracker({ reason: 'interval' });
  }, intervalMs).unref?.();

  console.log(`[SEP refresh] scheduled every ${hours}h (startup in ${startupDelayMs}ms)`);
}

module.exports = {
  refreshSepTracker,
  startSepRefreshScheduler,
  getStatus,
};
