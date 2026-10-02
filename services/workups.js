/**
 * Per-agent client workups (structured facts only — never chat transcripts).
 * File-backed JSON, same durability pattern as data/max-usage.json.
 * Set MAX_WORKUPS_FILE to a Railway volume path so desktop and phone share the list.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_MAX_PER_OWNER = 50;
const MAX_CLIENT_NAME = 80;
const MAX_CONTACTS = 200;
const MAX_ZIP = 10;
const MAX_COUNTY = 40;
const MAX_TERMINATING = 90;
const MAX_NEEDS = 8;
const MAX_NEED_LEN = 120;
const MAX_PLANS = 6;
const MAX_DOCTORS = 20;
const MAX_MEDS = 30;

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
    if (!Object.keys(byPlanId).length) continue;
    out.push({ name, byPlanId });
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
    if (!name) continue;
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
    if (!Object.keys(byPlanId).length) continue;
    out.push({ name, byPlanId });
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

  readState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || typeof raw.users !== 'object' || !raw.users) {
        return defaultState();
      }
      return raw;
    } catch (_) {
      return defaultState();
    }
  }

  writeState() {
    this.state.updatedAt = this.now().toISOString();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  ownerList(email) {
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
    let body = normalizeWorkupInput(input);
    const nowIso = this.now().toISOString();
    let list = this.ownerList(owner).slice();
    let existing = null;
    if (body.id) existing = list.find((w) => w.id === body.id) || null;
    if (!existing && !body.id && body.clientName) {
      existing = list.find((w) => String(w.clientName || '').toLowerCase() === body.clientName.toLowerCase()) || null;
    }
    if (existing) {
      const plans = body.plans.length ? body.plans : existing.plans || [];
      body = {
        ...body,
        clientName: body.clientName || existing.clientName || '',
        zip: body.zip || existing.zip || '',
        county: body.county || existing.county || '',
        contacts: body.contacts || existing.contacts || '',
        plans,
        planIds: plans.map((p) => p.planId),
        doctors: body.doctors.length ? body.doctors : existing.doctors || [],
        medications: body.medications.length ? body.medications : existing.medications || [],
        needs: body.needs.length ? body.needs : existing.needs || [],
        terminatingPlan: body.terminatingPlan || existing.terminatingPlan || '',
      };
    }
    if (!body.clientName && body.plans.length < 2) {
      const err = new Error('Need a client name or 2+ plans to save a workup');
      err.status = 400;
      throw err;
    }
    const id = (existing && existing.id) || body.id || newId();
    const workup = {
      id,
      ownerEmail: owner,
      clientName: body.clientName,
      zip: body.zip,
      county: body.county,
      contacts: body.contacts,
      plans: body.plans,
      planIds: body.planIds,
      doctors: body.doctors,
      medications: body.medications,
      needs: body.needs,
      terminatingPlan: body.terminatingPlan,
      createdAt: (existing && existing.createdAt) || nowIso,
      updatedAt: nowIso,
    };
    list = list.filter((w) => w.id !== id);
    list.unshift(workup);
    if (list.length > this.maxPerOwner) list = list.slice(0, this.maxPerOwner);
    this.state.users[owner] = list;
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

function createWorkupStore(options) {
  return new WorkupStore(options);
}

module.exports = {
  WorkupStore,
  createWorkupStore,
  normalizeWorkupInput,
  normalizeNetworkBucket,
  slimMedications,
  toSummary,
  DEFAULT_MAX_PER_OWNER,
};
