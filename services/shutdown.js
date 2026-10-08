// services/shutdown.js — graceful SIGTERM for Railway redeploys (AEP audit, 2026-10-08).
//
// Railway sends SIGTERM to the old deployment, waits drainingSeconds (railway.json), then SIGKILL.
// We used to die at once, mid-answer. Now:
//   1. stop taking NEW work: POST /chat, /chat/start, /compare/* answer 503 "Max is restarting".
//      Polls (GET /chat/jobs/:id, /compare/jobs/:id), /health and reads keep working.
//   2. wait for in-flight replies to finish — bounded (default 60 s, under drainingSeconds 75).
//   3. hand finished chat answers to the next process (chatJobs.persistJobs), close, exit.

const NEW_WORK_RE = /^\/(?:chat(?:\/start)?|compare(?:\/.*)?)\/?$/;

function createShutdown({
  getInFlight,
  onDrained = () => {},
  closeServer = (cb) => cb(),
  exit = (code) => process.exit(code),
  timeoutMs = Number(process.env.MAX_SHUTDOWN_TIMEOUT_MS || 60_000),
  pollMs = 500,
  log = console,
} = {}) {
  let draining = false;
  let done = null;

  /** Express middleware: reject new work while draining. */
  function rejectNewWork(req, res, next) {
    if (draining && req.method === 'POST' && NEW_WORK_RE.test(req.path || req.url || '')) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({
        error: 'Max is restarting for an update — send that again in about a minute.',
        code: 'restarting',
      });
    }
    return next();
  }

  function begin(signal = 'SIGTERM') {
    if (done) return done;
    draining = true;
    const started = Date.now();
    log.log(`[shutdown] ${signal}: no new chats/comparisons; waiting up to ${Math.round(timeoutMs / 1000)}s for ${getInFlight()} in-flight`);
    done = new Promise((resolve) => {
      const finish = (reason) => {
        let persisted = 0;
        try {
          persisted = onDrained() || 0;
        } catch (err) {
          log.error(`[shutdown] hand-off failed: ${err.message}`);
        }
        log.log(`[shutdown] ${reason} after ${Date.now() - started}ms; handed off ${persisted} answer(s); exiting`);
        closeServer(() => {
          resolve({ reason, persisted });
          exit(0);
        });
      };
      const tick = () => {
        const left = getInFlight();
        if (left <= 0) return finish('drained');
        if (Date.now() - started >= timeoutMs) return finish(`timed out with ${left} still running`);
        setTimeout(tick, pollMs); // ref'd on purpose: keep the process alive while draining
        return undefined;
      };
      tick();
    });
    return done;
  }

  return { rejectNewWork, begin, isDraining: () => draining };
}

/** Count of synchronous requests in flight (the old single-fetch POST /chat path). */
function createInFlightCounter() {
  let n = 0;
  function track(req, res, next) {
    n += 1;
    let closed = false;
    const end = () => { if (!closed) { closed = true; n -= 1; } };
    res.on('finish', end);
    res.on('close', end);
    next();
  }
  return { track, count: () => n };
}

module.exports = { createShutdown, createInFlightCounter, NEW_WORK_RE };
