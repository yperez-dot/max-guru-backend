/**
 * Read-only workup backup status for the public /health endpoint.
 *
 * Reports only counts, timestamps and booleans: never client names, ids or emails.
 * Never writes to the live workups file or to the backups directory, never throws,
 * and caches the result (default 5 min) so /health stays fast.
 */
const fs = require('fs');
const path = require('path');
const { WorkupStore, ROLLING_RE, DAILY_RE, stampToMs } = require('./workups');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function defaultFilePath() {
  return process.env.MAX_WORKUPS_FILE || path.join(process.cwd(), 'data', 'max-workups.json');
}

function shortCode(err, fallback) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : fallback;
}

/** Load a workups file the same way the server does, without writing or logging. */
function probeFile(filePath) {
  const store = new WorkupStore({ filePath, backups: false, silent: true });
  if (store.loadError) return { ok: false, count: null };
  const users = store.state && store.state.users ? store.state.users : {};
  let count = 0;
  for (const list of Object.values(users)) if (Array.isArray(list)) count += list.length;
  return { ok: true, count };
}

function computeBackupStatus({ filePath, backupDir } = {}) {
  const live = filePath || defaultFilePath();
  const dir = backupDir || process.env.MAX_WORKUPS_BACKUP_DIR || path.join(path.dirname(live), 'backups');
  const out = {
    dirExists: false,
    count: 0,
    newestAt: null,
    newestDailyAt: null,
    newestLoadsOk: null,
    workupCount: null,
    liveLoadOk: null,
  };
  const errors = [];

  try {
    if (!fs.existsSync(live)) {
      out.liveLoadOk = false;
      out.workupCount = 0;
      errors.push('live_missing');
    } else {
      const probe = probeFile(live);
      out.liveLoadOk = probe.ok;
      out.workupCount = probe.count;
      if (!probe.ok) errors.push('live_unreadable');
    }
  } catch (err) {
    out.liveLoadOk = false;
    errors.push(shortCode(err, 'live_check_failed'));
  }

  try {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') names = null;
      else throw err;
    }
    if (names) {
      out.dirExists = true;
      const backups = [];
      for (const name of names) {
        const rolling = name.match(ROLLING_RE);
        const daily = name.match(DAILY_RE);
        if (!rolling && !daily) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        } catch (_) {
          continue; // pruned between readdir and stat
        }
        const at = rolling ? stampToMs(rolling[1]) || mtimeMs : mtimeMs;
        backups.push({ name, daily: Boolean(daily), at });
      }
      out.count = backups.length;
      if (backups.length) {
        backups.sort((a, b) => b.at - a.at);
        out.newestAt = new Date(backups[0].at).toISOString();
        const newestDaily = backups.find((b) => b.daily);
        out.newestDailyAt = newestDaily ? new Date(newestDaily.at).toISOString() : null;
        out.newestLoadsOk = probeFile(path.join(dir, backups[0].name)).ok;
        if (!out.newestLoadsOk) errors.push('newest_backup_unreadable');
      }
    }
  } catch (err) {
    errors.push(shortCode(err, 'backup_check_failed'));
  }

  if (errors.length) out.error = errors.join(',');
  return out;
}

function createBackupStatus({ filePath, backupDir, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  let cachedAt = 0;
  return {
    get() {
      try {
        const t = now();
        if (!cached || t - cachedAt >= ttlMs) {
          cached = computeBackupStatus({ filePath, backupDir });
          cachedAt = t;
        }
        return { ...cached, checkedAt: new Date(cachedAt).toISOString() };
      } catch (err) {
        return { error: shortCode(err, 'status_failed') };
      }
    },
  };
}

module.exports = { createBackupStatus, computeBackupStatus, DEFAULT_TTL_MS };
