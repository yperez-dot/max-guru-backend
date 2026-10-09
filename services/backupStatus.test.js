const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createBackupStatus, computeBackupStatus } = require('./backupStatus');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backup-status-'));
}

function store(n, email = 'agent@example.com') {
  const list = [];
  for (let i = 0; i < n; i += 1) list.push({ id: `id-${i}`, ownerEmail: email, clientName: `Client ${i}` });
  return JSON.stringify({ updatedAt: '2026-10-08T00:00:00.000Z', users: { [email]: list } });
}

function snapshotDir(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) {
      out[name] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + fs.statSync(p).mtimeMs;
    }
  }
  return out;
}

test('no backups dir yet: dirExists false, count 0, live count reported', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  fs.writeFileSync(live, store(3));
  const s = computeBackupStatus({ filePath: live });
  assert.equal(s.dirExists, false);
  assert.equal(s.count, 0);
  assert.equal(s.newestAt, null);
  assert.equal(s.newestDailyAt, null);
  assert.equal(s.newestLoadsOk, null);
  assert.equal(s.workupCount, 3);
  assert.equal(s.liveLoadOk, true);
  assert.equal(s.error, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false, 'must not create the backups dir');
});

test('rolling + daily backups: counts, newest times, newest loads with the WorkupStore loader', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  fs.writeFileSync(live, store(14));
  fs.writeFileSync(path.join(bdir, 'max-workups.2026-10-07T10-00-00Z.json'), store(13));
  fs.writeFileSync(path.join(bdir, 'max-workups.2026-10-08T18-44-16Z.json'), store(14));
  const daily = path.join(bdir, 'max-workups.daily-2026-10-08.json');
  fs.writeFileSync(daily, store(14));
  const dailyTime = new Date('2026-10-08T18:44:16.000Z');
  fs.utimesSync(daily, dailyTime, dailyTime);
  fs.writeFileSync(path.join(bdir, 'notes.txt'), 'not a backup');
  const s = computeBackupStatus({ filePath: live });
  assert.equal(s.dirExists, true);
  assert.equal(s.count, 3, 'only files matching the backup patterns count');
  assert.equal(s.newestAt, '2026-10-08T18:44:16.000Z');
  assert.equal(s.newestDailyAt, '2026-10-08T18:44:16.000Z');
  assert.equal(s.newestLoadsOk, true);
  assert.equal(s.workupCount, 14);
  assert.equal(s.liveLoadOk, true);
  assert.equal(s.error, undefined);
});

test('corrupt newest backup: newestLoadsOk false with a short error code, no FATAL log', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  fs.writeFileSync(live, store(2));
  fs.writeFileSync(path.join(bdir, 'max-workups.2026-10-01T00-00-00Z.json'), store(2));
  fs.writeFileSync(path.join(bdir, 'max-workups.2026-10-08T00-00-00Z.json'), '{"users": {tr');
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  let s;
  try {
    s = computeBackupStatus({ filePath: live });
  } finally {
    console.error = orig;
  }
  assert.equal(s.newestLoadsOk, false);
  assert.equal(s.liveLoadOk, true);
  assert.equal(s.error, 'newest_backup_unreadable');
  assert.equal(logged.filter((l) => /FATAL/.test(l)).length, 0);
});

test('corrupt live file: liveLoadOk false, workupCount null, never throws', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  fs.writeFileSync(live, '');
  const s = computeBackupStatus({ filePath: live });
  assert.equal(s.liveLoadOk, false);
  assert.equal(s.workupCount, null);
  assert.equal(s.error, 'live_unreadable');
  assert.equal(fs.readFileSync(live, 'utf8'), '', 'live file untouched');
});

test('backups path is a file (ENOTDIR): reports a short code, never throws', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  fs.writeFileSync(live, store(1));
  fs.writeFileSync(path.join(dir, 'backups'), 'oops');
  const s = createBackupStatus({ filePath: live }).get();
  assert.equal(s.error, 'ENOTDIR');
  assert.equal(s.workupCount, 1);
});

test('read-only: live file and backups are byte-for-byte and mtime unchanged, no new files', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  fs.writeFileSync(live, store(5));
  fs.writeFileSync(path.join(bdir, 'max-workups.2026-10-08T00-00-00Z.json'), store(5));
  fs.writeFileSync(path.join(bdir, 'max-workups.daily-2026-09-01.json'), store(4)); // older than 14 days: must not be pruned
  const before = { root: snapshotDir(dir), backups: snapshotDir(bdir) };
  computeBackupStatus({ filePath: live });
  createBackupStatus({ filePath: live, ttlMs: 0 }).get();
  assert.deepEqual({ root: snapshotDir(dir), backups: snapshotDir(bdir) }, before);
});

test('caches for the TTL, then recomputes; output has no names, ids or emails', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'max-workups.json');
  fs.writeFileSync(live, store(2, 'secret.agent@example.com'));
  let t = 1_000_000;
  const status = createBackupStatus({ filePath: live, ttlMs: 300_000, now: () => t });
  assert.equal(status.get().workupCount, 2);
  fs.writeFileSync(live, store(7, 'secret.agent@example.com'));
  t += 299_000;
  assert.equal(status.get().workupCount, 2, 'still cached');
  t += 2_000;
  const fresh = status.get();
  assert.equal(fresh.workupCount, 7);
  const text = JSON.stringify(fresh);
  assert.doesNotMatch(text, /secret\.agent|Client \d|id-\d/);
  assert.deepEqual(
    Object.keys(fresh).sort(),
    ['checkedAt', 'count', 'dirExists', 'liveLoadOk', 'newestAt', 'newestDailyAt', 'newestLoadsOk', 'workupCount'].sort()
  );
});
