/**
 * Per-agent client workups (structured facts only — never chat transcripts).
 * File-backed JSON, same durability pattern as data/max-usage.json.
 * Set MAX_WORKUPS_FILE to a Railway volume path so desktop and phone share the list.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_PER_OWNER = 50;
// Backups (AEP audit, 2026-10-08): a rolling copy after a save (at most one per throttle
// window) plus one copy per America/New_York day, both kept BACKUP_KEEP_DAYS.
const DEFAULT_BACKUP_THROTTLE_MS = 15 * 60 * 1000;
const DEFAULT_BACKUP_KEEP_DAYS = 14;
const BACKUP_PREFIX = 'max-workups.';
const ROLLING_RE = /^max-workups\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.json$/;
const DAILY_RE = /^max-workups\.daily-(\d{4}-\d{2}-\d{2})\.json$/;
const MAX_CLIENT_NAME = 80;
const MAX_CONTACTS = 200;
const MAX_ZIP = 10;
const MAX_COUNTY = 40;
const MAX_TERMINATING = 90;
const MAX_NEEDS = 8;
const MAX_NEED_LEN = 120;
const MAX_PLANS = 6;
const MAX_COMPARE_RESULT_CHARS = 60000;
const MAX_DOCTORS = 20;
const MAX_MEDS = 30;
const MAX_HISTORY = 10;

// Words that are never a medication ("Cheryl Diaz PCP" once saved "PCP" as a med — Maura, 2026-10-07).
const NON_MED_RE = /^(?:pcp|primary(?:\s+care)?|cardiolog\w*|dermatolog\w*|neurolog\w*|ophthalmolog\w*|gyn\w*|ob\/?gyn|specialist|doctors?|drs?\.?|both|none|n\/a|na|no|yes|meds?|medications?|unknown)$/i;

const NETWORK_BUCKETS = new Set(['IN', 'OUT', 'NOT CONFIRMED', 'NEED MORE INFO']);

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function normalizeOwnerEmail(email) {
  const s = String(email || '').trim().toLowerCase();
  return s || '';
}

function normalizeNetworkBucket(raw) {
  if (raw === true) return 'IN';
  if (raw === false) return 'OUT';
  const s = String(raw || '').trim();
  if (!s) return '';
  const upper = s.toUpperCase();
  if (NETWORK_BUCKETS.has(upper)) return upper;
  if (/need\s*more\s*info/i.test(s)) return 'NEED MORE INFO';
  if (/not\s*confirmed/i.test(s)) return 'NOT CONFIRMED';
  if (/\bnot\s+(?:in[-\s]?network|listed)\b/i.test(s)) return 'OUT';
  if (/^(in[-\s]?network|inn|in|true|yes)$/i.test(s) || /\bin[-\s]?network\b/i.test(s)) return 'IN';
  if (/^(out(?:\s+of)?[-\s]?network|oon|out|false|no)$/i.test(s) || /\bout(?:\s+of)?[-\s]?network\b/i.test(s)) {
    return 'OUT';
  }
  return '';
}

function slimPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const planId = clip(plan.planId || plan.id || '', 40);
  if (!planId) return null;
  return {
    planId,
    id: clip(plan.id || plan.planId || '', 40),
    planName: clip(plan.planName || '', 120),
    carrier: clip(plan.carrier || '', 80),
    county: clip(plan.county || '', MAX_COUNTY),
  };
}

function slimDoctors(doctors, plans) {
  if (!Array.isArray(doctors)) return [];
  const planIds = (plans || []).map((p) => p.planId).filter(Boolean);
  const out = [];
  for (const d of doctors) {
    if (!d || typeof d !== 'object') continue;
    const name = clip(d.name || d.doctor || '', 80);
    if (!name) continue;
    const byPlanId = {};
    const map = d.byPlanId || d.statusByPlanId || {};
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      Object.keys(map).forEach((id) => {
        const bucket = normalizeNetworkBucket(map[id]);
        if (bucket) byPlanId[clip(id, 40)] = bucket;
      });
    }
    if (Array.isArray(d.statuses) && planIds.length) {
      d.statuses.forEach((status, i) => {
        const bucket = normalizeNetworkBucket(status);
        if (bucket && planIds[i]) byPlanId[planIds[i]] = bucket;
      });
    }
    const npi = /^\d{10}$/.test(String(d.npi || '').trim()) ? String(d.npi).trim() : '';
    const role = clip(d.role || d.specialty || '', 40);
    const row = { name, byPlanId };
    if (npi) row.npi = npi;
    if (role) row.role = role;
    out.push(row);
    if (out.length >= MAX_DOCTORS) break;
  }
  return out;
}

function slimMedications(drugs) {
  if (!Array.isArray(drugs)) return [];
  const out = [];
  for (const d of drugs) {
    if (!d || typeof d !== 'object') continue;
    const name = clip(d.name || d.drug || d.drugName || '', 48);
    if (!name || NON_MED_RE.test(name)) continue;
    const map = d.byPlanId || d.statusByPlanId || {};
    const byPlanId = {};
    Object.keys(map || {}).forEach((id) => {
      const incoming = map[id] || {};
      if (!incoming.verified) return;
      const tier = Number(incoming.tier);
      const coverage = incoming.coverage === 'not_covered' ? 'not_covered' : incoming.coverage || null;
      if (!(tier >= 1 && tier <= 6) && coverage !== 'not_covered') return;
      byPlanId[clip(id, 40)] = {
        verified: true,
        tier: tier >= 1 && tier <= 6 ? tier : null,
        coverage,
        costShare: incoming.costShare ? clip(incoming.costShare, 40) : null,
        pa: incoming.pa === true ? true : incoming.pa === false ? false : null,
        st: incoming.st === true ? true : incoming.st === false ? false : null,
        source: incoming.source ? clip(incoming.source, 40) : null,
      };
    });
    // Every med she listed is kept, verified tier or not — an unverified med used to be
    // dropped, so a re-save lost 5 of Enrique Soley's 6 meds (2026-10-07).
    const row = { name, byPlanId };
    const dose = clip(d.dose || d.strength || '', 40);
    if (dose) row.dose = dose;
    out.push(row);
    if (out.length >= MAX_MEDS) break;
  }
  return out;
}

function slimNeeds(needs) {
  const raw = Array.isArray(needs) ? needs : String(needs || '').split(/\n|;/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = clip(item, MAX_NEED_LEN);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_NEEDS) break;
  }
  return out;
}

/** Queue comparison result (doctor/med tables, questions) kept so the workup reopens with it. */
function slimCompareResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const text = JSON.stringify(raw);
    if (text.length > MAX_COMPARE_RESULT_CHARS) return null;
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeWorkupInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const plans = (Array.isArray(src.plans) ? src.plans : []).map(slimPlan).filter(Boolean).slice(0, MAX_PLANS);
  const planIds = plans.map((p) => p.planId);
  const clientName = clip(src.clientName || src.name || '', MAX_CLIENT_NAME);
  return {
    id: src.id && /^[a-zA-Z0-9_-]{8,80}$/.test(String(src.id)) ? String(src.id) : '',
    clientName,
    zip: clip(src.zip || src.postalCode || '', MAX_ZIP),
    county: clip(src.county || '', MAX_COUNTY),
    contacts: clip(src.contacts || src.contact || '', MAX_CONTACTS),
    plans,
    planIds,
    doctors: slimDoctors(src.doctors, plans),
    medications: slimMedications(src.medications || src.drugs),
    needs: slimNeeds(src.needs),
    terminatingPlan: clip(src.terminatingPlan || '', MAX_TERMINATING),
    currentPlanIds: [...new Set((Array.isArray(src.currentPlanIds) ? src.currentPlanIds : [])
      .map((x) => String(x || '').toUpperCase().trim())
      .filter((x) => /^[HR]\d{4}-\d{3}[A-Z]?$/.test(x)))].slice(0, 3),
    compareResult: slimCompareResult(src.compareResult),
  };
}

function nameKey(name) {
  return String(name || '').toLowerCase()
    .replace(/\bdr\.?\s+/g, '')
    .replace(/,?\s+\b(md|do|np|pa|aprn|dpm|od|dds|dmd)\b\.?/g, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function medKey(name) {
  const first = String(name || '').toLowerCase().replace(/[^a-z0-9\s/-]/g, ' ').trim().split(/[\s/-]+/)[0] || '';
  return first;
}

/** Same doctor: same NPI, or same name once "Dr." / credentials are dropped. */
function sameDoctorRow(a, b) {
  if (a.npi && b.npi) return a.npi === b.npi;
  return nameKey(a.name) === nameKey(b.name);
}

/** Never drop a saved doctor: incoming results win per plan, older plans' results stay. */
function mergeDoctors(existing, incoming) {
  const out = (existing || []).map((d) => ({ ...d, byPlanId: { ...(d.byPlanId || {}) } }));
  for (const d of incoming || []) {
    const hit = out.find((x) => sameDoctorRow(x, d));
    if (!hit) { out.push({ ...d, byPlanId: { ...(d.byPlanId || {}) } }); continue; }
    Object.assign(hit.byPlanId, d.byPlanId || {});
    if (d.npi && !hit.npi) hit.npi = d.npi;
    if (d.role && !hit.role) hit.role = d.role;
    // The longer spelling is usually the fuller name ("Dr. Cheryl L Case-Diaz" over "Cheryl Diaz").
    if (String(d.name).length > String(hit.name).length && nameKey(d.name) !== nameKey(hit.name)) hit.name = d.name;
  }
  return out.slice(0, MAX_DOCTORS);
}

/** Never drop a saved med: same drug (first word) merges, verified tiers per plan win. */
function mergeMedications(existing, incoming) {
  const out = (existing || []).filter((m) => !NON_MED_RE.test(String(m.name || ''))).map((m) => ({ ...m, byPlanId: { ...(m.byPlanId || {}) } }));
  for (const m of incoming || []) {
    const hit = out.find((x) => medKey(x.name) && medKey(x.name) === medKey(m.name));
    if (!hit) { out.push({ ...m, byPlanId: { ...(m.byPlanId || {}) } }); continue; }
    Object.assign(hit.byPlanId, m.byPlanId || {});
    if (m.dose && !hit.dose) hit.dose = m.dose;
  }
  return out.slice(0, MAX_MEDS);
}

function compareResultWeight(cr) {
  if (!cr || typeof cr !== 'object') return 0;
  const docs = Array.isArray(cr.doctors) ? cr.doctors.length : Number(cr.doctorCount) || 0;
  const drugs = Array.isArray(cr.drugs) ? cr.drugs.filter((d) => d && !NON_MED_RE.test(String(d.drugName || d.name || ''))).length : 0;
  return docs * 10 + drugs;
}

/** Two different people? ("Enrique Soley" saved onto "Maura …"'s id.) First names must agree. */
function differentClient(a, b) {
  const first = (n) => String(n || '').toLowerCase().replace(/[^a-z\s&]/g, ' ').trim().split(/\s+/).filter((w) => w && !['mr', 'mrs', 'ms', 'and', '&', 'the'].includes(w));
  const x = first(a);
  const y = first(b);
  if (!x.length || !y.length) return false;
  // "Maura Soley" vs "Enrique Soley": same surname, different client. A one-word name ("Muskat")
  // is compared by any shared word.
  if (x.length >= 2 && y.length >= 2) {
    const firsts = (n) => String(n || '').toLowerCase().split(/\s*(?:&|\band\b|\by\b)\s*/).map((part) => first(part)[0]).filter(Boolean);
    const fx = firsts(a);
    const fy = firsts(b);
    return !fx.some((w) => fy.includes(w));
  }
  return !x.some((w) => y.includes(w));
}

/** "Cheryl Case" saved as the client name was really doctor Cheryl L Case-Diaz — fixable, not a different client. */
function nameIsADoctor(name, doctors) {
  const words = nameKey(name).split(/[\s-]+/).filter((w) => w.length > 1);
  if (words.length < 2) return false;
  return (doctors || []).some((d) => {
    const dw = nameKey(d.name).split(/[\s-]+/);
    return words.every((w) => dw.includes(w));
  });
}

function historyEntry(w) {
  if (!w) return null;
  const cr = w.compareResult && typeof w.compareResult === 'object' ? { ...w.compareResult } : null;
  if (cr) delete cr.toolResults; // biggest part, rebuilt by a re-run
  return {
    savedAt: w.updatedAt || null,
    clientName: w.clientName || '',
    zip: w.zip || '',
    county: w.county || '',
    plans: w.plans || [],
    planIds: w.planIds || [],
    doctors: w.doctors || [],
    medications: w.medications || [],
    needs: w.needs || [],
    compareResult: cr,
  };
}

function toSummary(workup) {
  return {
    id: workup.id,
    clientName: workup.clientName || '',
    zip: workup.zip || '',
    county: workup.county || '',
    planIds: workup.planIds || [],
    planLabels: (workup.plans || []).map((p) => {
      const name = [p.carrier, p.planName].filter(Boolean).join(' ').trim() || p.planId;
      return `${name} (${p.planId})`;
    }),
    updatedAt: workup.updatedAt,
  };
}

function defaultState() {
  return { updatedAt: new Date().toISOString(), users: {} };
}

class WorkupStore {
  constructor(options = {}) {
    this.filePath =
      options.filePath || process.env.MAX_WORKUPS_FILE || path.join(process.cwd(), 'data', 'max-workups.json');
    this.maxPerOwner = Number(options.maxPerOwner || process.env.MAX_WORKUPS_PER_OWNER || DEFAULT_MAX_PER_OWNER);
    this.now = options.now || (() => new Date());
    this.backupDir =
      options.backupDir || process.env.MAX_WORKUPS_BACKUP_DIR || path.join(path.dirname(this.filePath), 'backups');
    this.backupThrottleMs = Number(
      options.backupThrottleMs ?? process.env.MAX_WORKUPS_BACKUP_THROTTLE_MS ?? DEFAULT_BACKUP_THROTTLE_MS
    );
    this.backupKeepDays = Number(
      options.backupKeepDays ?? process.env.MAX_WORKUPS_BACKUP_KEEP_DAYS ?? DEFAULT_BACKUP_KEEP_DAYS
    );
    this.backupsEnabled = options.backups !== false && process.env.MAX_WORKUPS_BACKUPS !== 'off';
    this.loadError = null;
    this.lastWarning = '';
    this._queue = Promise.resolve();
    this.state = this.readState();
  }

  withLock(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  /**
   * A missing file is a fresh store. A file that EXISTS but cannot be read or parsed is
   * never treated as empty: the next save would overwrite every agent's workups with just
   * the one being saved. Mark the store unusable instead (assertUsable throws 503).
   */
  readState() {
    let text;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return defaultState();
      return this.failLoad(`cannot be read (${err && err.code ? err.code : err && err.message})`);
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return this.failLoad(`is not valid JSON (${err.message}; ${Buffer.byteLength(text)} bytes)`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.users !== 'object' || !raw.users || Array.isArray(raw.users)) {
      return this.failLoad('does not have the expected { users: {...} } shape');
    }
    return raw;
  }

  failLoad(reason) {
    this.loadError = `Workups file ${this.filePath} exists but ${reason}`;
    console.error(`[workups] FATAL: ${this.loadError} — refusing reads and saves so nothing is overwritten. Restore it from ${this.backupDir}.`);
    return defaultState();
  }

  /** Throw (503) when the file on disk could not be loaded — never read or write a fake empty store. */
  assertUsable() {
    if (!this.loadError) return;
    const err = new Error(
      'Saved workups could not be read, so Max is not saving (that would overwrite them). Nothing was lost — tell Yahoska so the file can be restored.'
    );
    err.status = 503;
    err.code = 'workups_unreadable';
    err.detail = this.loadError;
    throw err;
  }

  writeState() {
    this.assertUsable();
    this.state.updatedAt = this.now().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
    this.backup();
  }

  /** Copies of the file just written. A backup failure is logged and never fails the save. */
  backup() {
    if (!this.backupsEnabled) return { rolling: null, daily: null };
    const made = { rolling: null, daily: null };
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const now = this.now();
      const names = fs.readdirSync(this.backupDir);
      const newestRolling = names
        .map((n) => (n.match(ROLLING_RE) || [])[1])
        .filter(Boolean)
        .map(stampToMs)
        .reduce((a, b) => Math.max(a, b), 0);
      if (!newestRolling || now.getTime() - newestRolling >= this.backupThrottleMs) {
        const name = `${BACKUP_PREFIX}${msToStamp(now.getTime())}.json`;
        fs.copyFileSync(this.filePath, path.join(this.backupDir, name));
        made.rolling = name;
      }
      const dailyName = `${BACKUP_PREFIX}daily-${etDay(now)}.json`;
      if (!names.includes(dailyName)) {
        fs.copyFileSync(this.filePath, path.join(this.backupDir, dailyName));
        made.daily = dailyName;
      }
      this.pruneBackups(now);
    } catch (err) {
      console.error(`[workups] backup failed (save itself succeeded): ${err.message}`);
    }
    return made;
  }

  pruneBackups(now = this.now()) {
    const cutoff = now.getTime() - this.backupKeepDays * 24 * 60 * 60 * 1000;
    const removed = [];
    for (const name of fs.readdirSync(this.backupDir)) {
      const rolling = name.match(ROLLING_RE);
      const daily = name.match(DAILY_RE);
      let ts = 0;
      if (rolling) ts = stampToMs(rolling[1]);
      else if (daily) ts = Date.parse(`${daily[1]}T23:59:59Z`);
      else continue; // never touch files we did not make
      if (ts && ts < cutoff) {
        fs.rmSync(path.join(this.backupDir, name), { force: true });
        removed.push(name);
      }
    }
    return removed;
  }

  ownerList(email) {
    this.assertUsable();
    const owner = normalizeOwnerEmail(email);
    if (!owner) return [];
    const list = this.state.users[owner];
    return Array.isArray(list) ? list : [];
  }

  list(email) {
    return this.ownerList(email)
      .slice()
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map(toSummary);
  }

  get(email, id) {
    return this.ownerList(email).find((w) => w.id === id) || null;
  }

  upsert(email, input) {
    const owner = normalizeOwnerEmail(email);
    if (!owner) {
      const err = new Error('owner required');
      err.status = 401;
      err.code = 'access_required';
      throw err;
    }
    const body = normalizeWorkupInput(input);
    if (!body.clientName && body.plans.length < 2) {
      const err = new Error('Need a client name or 2+ plans to save a workup');
      err.status = 400;
      throw err;
    }
    const nowIso = this.now().toISOString();
    let list = this.ownerList(owner).slice();
    let existing = null;
    if (body.id) existing = list.find((w) => w.id === body.id) || null;
    // Another client's facts saved onto this id (the chat still pointed at the workup opened
    // before): save them as their own workup, never over this one (Maura / Enrique Soley, 2026-10-07).
    if (existing && body.clientName && differentClient(existing.clientName, body.clientName)
      && !nameIsADoctor(existing.clientName, [...(existing.doctors || []), ...body.doctors])) {
      existing = null;
      body.id = '';
    }
    if (!existing && !body.id && body.clientName) {
      existing = list.find((w) => String(w.clientName || '').toLowerCase() === body.clientName.toLowerCase()) || null;
    }
    const id = (existing && existing.id) || body.id || newId();
    // A name the agent typed with Rename wins over names re-extracted from the chat.
    const nameLocked = Boolean(existing && existing.nameLocked && existing.clientName);
    const prev = existing || {};
    // Saves MERGE: a thin re-save (a chat that only mentioned one plan or one drug) never
    // drops saved doctors, meds, plans, ZIP or a fuller comparison result.
    const keepCompare = body.compareResult && prev.compareResult && compareResultWeight(body.compareResult) < compareResultWeight(prev.compareResult);
    const workup = {
      id,
      ownerEmail: owner,
      clientName: nameLocked ? prev.clientName : (body.clientName || prev.clientName || ''),
      nameLocked,
      zip: body.zip || prev.zip || '',
      county: body.county || prev.county || '',
      contacts: body.contacts || prev.contacts || '',
      plans: body.plans.length ? body.plans : (prev.plans || []),
      planIds: body.plans.length ? body.planIds : (prev.planIds || []),
      doctors: mergeDoctors(prev.doctors, body.doctors),
      medications: mergeMedications(prev.medications, body.medications),
      needs: slimNeeds([...(prev.needs || []), ...body.needs]),
      terminatingPlan: body.terminatingPlan || prev.terminatingPlan || '',
      currentPlanIds: body.currentPlanIds.length ? body.currentPlanIds : (prev.currentPlanIds || []),
      // Keep an earlier saved result when a re-save has none, or a thinner one.
      compareResult: keepCompare ? prev.compareResult : (body.compareResult || prev.compareResult || null),
      // Every earlier version, newest first, so a bad save can be undone.
      history: existing ? [historyEntry(existing), ...(existing.history || [])].filter(Boolean).slice(0, MAX_HISTORY) : [],
      createdAt: prev.createdAt || nowIso,
      updatedAt: nowIso,
    };
    list = list.filter((w) => w.id !== id);
    list.unshift(workup);
    this.lastWarning = '';
    if (list.length > this.maxPerOwner) {
      // Oldest (by save time) go first. Say so instead of dropping silently.
      const dropped = list.slice(this.maxPerOwner);
      list = list.slice(0, this.maxPerOwner);
      const names = dropped.map((w) => w.clientName || w.id).join(', ');
      this.lastWarning = `Saved. You are at the ${this.maxPerOwner}-workup limit, so the oldest (${names}) was removed. It is still in the daily backup.`;
      console.warn(`[workups] ${owner} hit the ${this.maxPerOwner}-workup cap; dropped ${dropped.length}: ${dropped.map((w) => w.id).join(', ')}`);
    }
    this.state.users[owner] = list;
    this.writeState();
    return workup;
  }

  /** Rename only — every other field stays as saved. */
  rename(email, id, name) {
    const owner = normalizeOwnerEmail(email);
    const clientName = clip(name || '', MAX_CLIENT_NAME);
    if (!clientName) {
      const err = new Error('Name cannot be empty');
      err.status = 400;
      throw err;
    }
    const list = this.ownerList(owner);
    const existing = list.find((w) => w.id === id);
    if (!existing) return null;
    const workup = { ...existing, clientName, nameLocked: true, updatedAt: this.now().toISOString() };
    this.state.users[owner] = [workup, ...list.filter((w) => w.id !== id)];
    this.writeState();
    return workup;
  }

  delete(email, id) {
    const owner = normalizeOwnerEmail(email);
    const list = this.ownerList(owner);
    const next = list.filter((w) => w.id !== id);
    if (next.length === list.length) return false;
    this.state.users[owner] = next;
    this.writeState();
    return true;
  }
}

function msToStamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function stampToMs(stamp) {
  const iso = String(stamp).replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function etDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function createWorkupStore(options) {
  return new WorkupStore(options);
}

module.exports = {
  WorkupStore,
  createWorkupStore,
  normalizeWorkupInput,
  normalizeNetworkBucket,
  mergeDoctors,
  mergeMedications,
  differentClient,
  slimMedications,
  toSummary,
  DEFAULT_MAX_PER_OWNER,
};
