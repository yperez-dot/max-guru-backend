/**
 * Phone-safe Max chat: enqueue a server job, poll for the reply, restore
 * the current thread after the tab is backgrounded or closed.
 * Browser (window.MaxChatJobs) + Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.MaxChatJobs = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STATE_KEY_PREFIX = "max_chat_thread_v1:";
  const REACH_SERVER_ERROR =
    "Couldn't reach Max. Check your connection and try again — if this keeps happening, Railway may be redeploying.";
  const POLL_MS = 1500;
  const MISSING_GRACE_MS = 12000;

  function newId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function stateKey(email) {
    const owner = String(email || "ungated").trim().toLowerCase() || "ungated";
    return STATE_KEY_PREFIX + owner;
  }

  function storage() {
    try {
      if (typeof localStorage !== "undefined") return localStorage;
    } catch (_) {}
    return null;
  }

  function stripImageParts(content) {
    if (typeof content === "string") {
      return content.trim().startsWith("data:image/") ? "[image]" : content;
    }
    if (!Array.isArray(content)) return content;
    const next = [];
    for (const part of content) {
      if (typeof part === "string") {
        next.push(part.trim().startsWith("data:image/") ? { type: "text", text: "[image]" } : part);
        continue;
      }
      if (part && part.type === "image_url") {
        next.push({ type: "text", text: "[image]" });
        continue;
      }
      next.push(part);
    }
    return next;
  }

  function messagesForStorage(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const copy = { ...m };
      if (copy.content != null) copy.content = stripImageParts(copy.content);
      if (copy.workup && typeof copy.workup === "object") {
        copy.workup = {
          id: copy.workup.id,
          clientName: copy.workup.clientName,
          plans: Array.isArray(copy.workup.plans)
            ? copy.workup.plans.map((p) => ({
                planId: p && p.planId,
                planName: p && p.planName,
                carrier: p && p.carrier,
              }))
            : [],
        };
      }
      return copy;
    });
  }

  function saveChatState(email, state, store) {
    const bag = store || storage();
    if (!bag) return false;
    try {
      const payload = {
        chatId: state && state.chatId,
        pendingJobId: (state && state.pendingJobId) || "",
        messages: messagesForStorage(state && state.messages),
        banners: (state && state.banners) || [],
        currentWorkupId: (state && state.currentWorkupId) || "",
        sessionToolResults: (state && state.sessionToolResults) || [],
        lastComparisonExport: state && state.lastComparisonExport ? state.lastComparisonExport : null,
        queued: state && state.queued ? { text: state.queued.text || "", images: [] } : null,
        updatedAt: new Date().toISOString(),
      };
      bag.setItem(stateKey(email), JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  function loadChatState(email, store) {
    const bag = store || storage();
    if (!bag) return null;
    try {
      const raw = bag.getItem(stateKey(email));
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  function clearChatState(email, store) {
    const bag = store || storage();
    if (!bag) return;
    try {
      bag.removeItem(stateKey(email));
    } catch (_) {}
  }

  function isAbortError(err) {
    if (!err) return false;
    const name = String(err.name || "");
    const message = String(err.message || "").toLowerCase();
    return name === "AbortError" || err.code === "ABORT_ERR" || message.includes("aborted") || message.includes("the user aborted");
  }

  function isReachabilityFailure(err, response) {
    if (response && response.ok) return false;
    if (isAbortError(err)) return false;
    if (err && (err.code === "access_required" || err.code === "invalid_image" || err.code === "chat_job_error")) {
      return false;
    }
    if (response) {
      const status = Number(response.status) || 0;
      if (status === 502 || status === 504) return true;
      return false;
    }
    if (!err) return true;
    const message = String(err.message || "").toLowerCase();
    return (
      err.name === "TypeError" ||
      message.includes("failed to fetch") ||
      message.includes("networkerror") ||
      message.includes("network request failed") ||
      message.includes("load failed")
    );
  }

  function reachServerError() {
    const err = new Error(REACH_SERVER_ERROR);
    err.code = "unreachable";
    return err;
  }

  function parseGuruPayload(response, data) {
    const body = data && typeof data === "object" ? data : {};
    if (response && response.status === 401) {
      if (body.code === "access_required") {
        const err = new Error("access_required");
        err.code = "access_required";
        throw err;
      }
      return {
        text: "Backend auth isn't configured in this deploy (missing MAX_API_KEY inject). Ask admin to set the Netlify snippet.",
        banners: [],
      };
    }
    if (response && response.status === 429) {
      return { text: body.error || "Max is rate-limited to protect spend — try again shortly.", banners: body.banners || [] };
    }
    if (response && response.status === 402 && body.code === "daily_budget_reached") {
      return {
        text: body.error || "Max reached today’s budget. Say “OK go over” to continue today.",
        banners: body.banners || [],
      };
    }
    if (response && response.status === 413) {
      return {
        text: body.error || "That image is too large. Use PNG, JPEG, or WebP under 4MB each.",
        banners: body.banners || [],
      };
    }
    if (response && response.status === 503) {
      return {
        text: body.error || "Max's Grok backend isn't configured yet (missing XAI_API_KEY on Railway).",
        banners: [],
      };
    }
    if (response && response.status === 400 && body.code === "invalid_image") {
      const err = new Error(body.error || "Images must be PNG, JPEG, or WebP under 4MB.");
      err.code = "invalid_image";
      throw err;
    }
    if (body.status === "error") {
      return {
        text: body.error || "I couldn't generate a response. Try again.",
        banners: Array.isArray(body.banners) ? body.banners : [],
        jobId: body.jobId,
      };
    }
    if (response && !response.ok && body.status !== "done" && body.status !== "pending") {
      return { text: body.error || "I couldn't generate a response. Try again.", banners: body.banners || [] };
    }
    const textBlock = body.content && body.content.find((b) => b.type === "text");
    return {
      text: textBlock
        ? textBlock.text
        : body.reply || "I couldn't generate a response. Try again.",
      banners: Array.isArray(body.banners) ? body.banners : [],
      toolResults: Array.isArray(body.toolResults) ? body.toolResults : [],
      jobId: body.jobId,
    };
  }

  function sleep(ms, sleeper) {
    const wait = sleeper || ((delay, resolve) => setTimeout(resolve, delay));
    return new Promise((resolve) => wait(ms, resolve));
  }

  function documentHidden(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    return Boolean(d && d.visibilityState && d.visibilityState !== "visible");
  }

  function waitUntilVisible(doc, win) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    const w = win || (typeof window !== "undefined" ? window : null);
    if (!d || d.visibilityState === "visible") return Promise.resolve();
    return new Promise((resolve) => {
      const onVis = () => {
        if (!d.visibilityState || d.visibilityState === "visible") {
          d.removeEventListener("visibilitychange", onVis);
          if (w) w.removeEventListener("pageshow", onVis);
          resolve();
        }
      };
      d.addEventListener("visibilitychange", onVis);
      if (w) w.addEventListener("pageshow", onVis);
    });
  }

  async function pollChatJob(options) {
    const {
      jobId,
      fetchJob,
      pollMs = POLL_MS,
      missingGraceMs = MISSING_GRACE_MS,
      now = () => Date.now(),
      sleeper,
      document: doc,
      window: win,
      isCancelled,
    } = options || {};
    if (!jobId) throw reachServerError();
    const started = now();
    let sawJob = false;
    let consecutiveNetwork = 0;
    while (!isCancelled || !isCancelled()) {
      if (documentHidden(doc)) await waitUntilVisible(doc, win);
      if (isCancelled && isCancelled()) {
        const err = new Error("cancelled");
        err.code = "cancelled";
        throw err;
      }
      let response;
      let data = {};
      try {
        response = await fetchJob(jobId);
        data = await response.json().catch(() => ({}));
        consecutiveNetwork = 0;
      } catch (err) {
        if (isAbortError(err)) {
          await waitUntilVisible(doc, win);
          continue;
        }
        consecutiveNetwork += 1;
        if (documentHidden(doc)) {
          await waitUntilVisible(doc, win);
          continue;
        }
        if (consecutiveNetwork >= 4 && isReachabilityFailure(err, null)) {
          throw reachServerError();
        }
        await sleep(pollMs, sleeper);
        continue;
      }
      if (response.status === 401 && data.code === "access_required") {
        const err = new Error("access_required");
        err.code = "access_required";
        throw err;
      }
      if (response.status === 404) {
        if (sawJob) throw reachServerError();
        if (now() - started < missingGraceMs) {
          await sleep(pollMs, sleeper);
          continue;
        }
        const err = new Error("chat_job_not_found");
        err.code = "chat_job_not_found";
        throw err;
      }
      sawJob = true;
      if (data.status === "pending" || data.status === "running") {
        await sleep(pollMs, sleeper);
        continue;
      }
      return parseGuruPayload(response, data);
    }
    const cancelled = new Error("cancelled");
    cancelled.code = "cancelled";
    throw cancelled;
  }

  return {
    STATE_KEY_PREFIX,
    REACH_SERVER_ERROR,
    POLL_MS,
    newId,
    stateKey,
    stripImageParts,
    messagesForStorage,
    saveChatState,
    loadChatState,
    clearChatState,
    isAbortError,
    isReachabilityFailure,
    reachServerError,
    parseGuruPayload,
    waitUntilVisible,
    pollChatJob,
  };
});
