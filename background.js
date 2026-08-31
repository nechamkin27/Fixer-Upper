console.log("Chrome internal redirect URI:", chrome.identity.getRedirectURL());

chrome.action.onClicked.addListener((tab) => {
  // sidePanel API is not available in all Chrome/Chromium builds or contexts.
  // Guard access and provide a fallback to open the panel page in a new tab.
  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    chrome.sidePanel.open({ tabId: tab.id });
  } else {
    // Fallback: open the panel HTML in a new tab so users can still access the UI
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
    } catch (e) {
      console.warn('Failed to open panel fallback:', e);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "auth") {
    getToken()
      .then(token => sendResponse({ token }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep message channel open
  }

  // support panel's 'getToken' helper name too
  if (msg.action === 'getToken') {
    getToken()
      .then(token => sendResponse({ token }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === 'startTopSenders') {
    startTopSendersJob()
      .then(result => sendResponse({ started: true, ...result }))
      .catch(err => {
        console.error('Top senders job failed to start:', err);
        sendResponse({ started: false, error: err.message });
      });
    return true;
  }

  if (msg.action === 'getStoredSenders') {
    // return last stored aggregated counts (non-blocking)
    chrome.storage.local.get(['senderCounts'], data => {
      sendResponse({ senderCounts: data.senderCounts || {} });
    });
    return true; // will call sendResponse asynchronously
  }

  if (msg.action === 'cancelTopSenders') {
    cancelTopSendersJob().then(() => sendResponse({ cancelled: true }));
    return true;
  }

  if (msg.action === 'getJobStatus') {
    chrome.storage.local.get(['topSendersJob'], data => {
      sendResponse({ running: !!(data.topSendersJob && data.topSendersJob.running) });
    });
    return true;
  }
});

// =======================================
// OAuth token handling
// =======================================
// Access tokens are cached in chrome.storage.session rather than a plain
// module-level variable. MV3 service workers get torn down after ~30s idle,
// which happens repeatedly during a long scan, so a `let` cache doesn't
// survive long enough to be useful. storage.session persists across worker
// restarts but is cleared when the browser closes, so tokens never touch disk.
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000;

function sessionGet(keys) {
  return new Promise(resolve => chrome.storage.session.get(keys, resolve));
}
function sessionSet(obj) {
  return new Promise(resolve => chrome.storage.session.set(obj, resolve));
}

function getToken(forceRefresh = false) {
  return (async () => {
    if (!forceRefresh) {
      const cached = await sessionGet(['authToken', 'authTokenExpiry']);
      if (cached.authToken && cached.authTokenExpiry && Date.now() < cached.authTokenExpiry) {
        return cached.authToken;
      }
    }

    return new Promise((resolve, reject) => {
      const redirectUri = chrome.identity.getRedirectURL();
      const clientId = "1048045525974-eoku0strjgc79fe71ah6pp12ak7lgv1m.apps.googleusercontent.com";
      const scope = "https://mail.google.com/";

      const authUrl =
        `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}` +
        `&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(scope)}&prompt=consent`;

      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, redirectUrl => {
        if (chrome.runtime.lastError || !redirectUrl) return reject(new Error("OAuth failed"));

        // Note: do not log redirectUrl — its fragment contains the raw access token.
        const params = new URLSearchParams(redirectUrl.split("#")[1]);
        const token = params.get("access_token");
        const expiresInSec = Number(params.get("expires_in")) || 3600;

        if (!token) return reject(new Error("No access token found"));

        const authTokenExpiry = Date.now() + expiresInSec * 1000 - TOKEN_SAFETY_MARGIN_MS;
        sessionSet({ authToken: token, authTokenExpiry }).then(() => resolve(token));
      });
    });
  })();
}

async function invalidateToken() {
  await sessionSet({ authToken: null, authTokenExpiry: 0 });
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Paces request *starts* to roughly maxPerSecond while still allowing several
// requests to be in flight concurrently (it only throttles when each new one
// is allowed to begin). Gmail enforces ~250 quota units/sec/user, and a
// metadata `get` costs 5 units, so the real ceiling is ~50/sec; staying
// under that avoids 429s, which used to cost far more wall-clock time in
// retry backoff than the throttling itself does.
function createRateGate(maxPerSecond) {
  const minIntervalMs = 1000 / maxPerSecond;
  let last = 0;
  return async function gate() {
    const now = Date.now();
    const wait = last + minIntervalMs - now;
    last = Math.max(now, last + minIntervalMs);
    if (wait > 0) await sleep(wait);
  };
}
const rateGate = createRateGate(40);

// Helper: fetch with retries and exponential backoff.
// `authFailFlag`, if provided, gets `.failed = true` set on 401/403 so the
// caller can distinguish "token expired mid-run" from "message is gone" and
// react (refresh + resume) instead of silently dropping results.
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 500, authFailFlag = null) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res.json();

      // For 404/410 skip immediately
      if (res.status === 404 || res.status === 410) return null;

      if (res.status === 401 || res.status === 403) {
        if (authFailFlag) authFailFlag.failed = true;
        return null;
      }

      if (res.status === 429) {
        if (attempt === retries) return null;
        const retryAfter = Number(res.headers.get('Retry-After'));
        const waitMs = retryAfter ? retryAfter * 1000 : backoff * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    } catch (err) {
      if (attempt === retries) {
        console.warn('fetchWithRetry failed for', url, err);
        return null; // give up on this item
      }
      // backoff then retry
      await sleep(backoff * Math.pow(2, attempt));
    }
  }
  return null;
}

// Persisted state helpers
function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// If the service worker is killed between chunks (or between an alarm
// firing) with no alarm left to wake it back up, `running: true` can be
// stuck in storage with nothing actually driving the job forward. Stamping
// every persisted state with `lastUpdated` lets us tell a genuinely active
// job apart from an abandoned one.
const STALE_JOB_MS = 3 * 60 * 1000; // generous: alarms can be clamped to ~1min
async function persistJobState(state) {
  state.lastUpdated = Date.now();
  await storageSet({ topSendersJob: state });
}

function normalizeSenderKey(fromHeaderValue) {
  const emailMatch = fromHeaderValue.match(/<(.+?)>/);
  const raw = emailMatch ? emailMatch[1] : fromHeaderValue;
  return raw.trim().toLowerCase();
}

// Start (or resume) the job. Only resets accumulated progress when there is
// nothing sensible to resume from — previously, cancelling or reopening the
// panel silently discarded however much scanning had already happened,
// forcing a full multi-hour rescan from message 1 every time.
async function startTopSendersJob() {
  const stateWrap = await storageGet(['topSendersJob']);
  const existing = stateWrap.topSendersJob;

  const isStale = existing && existing.running &&
    (Date.now() - (existing.lastUpdated || 0)) > STALE_JOB_MS;

  if (existing && existing.running && !isStale) {
    // A chunk is genuinely in flight (updated recently); don't stomp on it.
    return { alreadyRunning: true };
  }
  if (isStale) {
    console.warn('Previous top-senders job looked abandoned (no update in', STALE_JOB_MS, 'ms) — resuming it.');
  }

  const canResume = !!(existing && existing.nextPageToken);
  const next = {
    running: true,
    nextPageToken: canResume ? existing.nextPageToken : null,
    senderStats: canResume ? (existing.senderStats || {}) : {},
    totalProcessed: canResume ? (existing.totalProcessed || 0) : 0
  };

  await persistJobState(next);
  processTopSendersChunk().catch(err => console.error('Chunk failed', err));
  return { resumed: canResume };
}

// Cancel: pause the job without discarding progress so a later "start" can resume it.
async function cancelTopSendersJob() {
  const stateWrap = await storageGet(['topSendersJob']);
  const existing = stateWrap.topSendersJob || {};
  await persistJobState({ ...existing, running: false });
  try { chrome.alarms.clear('topSenders'); } catch (e) {}
}

// Schedule next chunk using chrome.alarms (service worker friendly).
// Note: Chrome clamps alarm delays to roughly a 1-minute floor for packed
// extensions (sub-minute delays are only honored reliably for unpacked,
// dev-mode extensions), so this delay is best-effort. The job still resumes
// correctly whenever the alarm actually fires, just possibly later than asked.
function scheduleNextChunk(delayMinutes = 0.05) {
  try {
    chrome.alarms.create('topSenders', { delayInMinutes: delayMinutes });
  } catch (e) {
    // ignore in environments without alarms
    setTimeout(() => processTopSendersChunk().catch(err => console.error(err)), 1000);
  }
}

// Process a chunk of list pages and persist progress; safe to invoke repeatedly.
async function processTopSendersChunk() {
  const stateWrap = await storageGet(['topSendersJob']);
  const state = stateWrap.topSendersJob || { running: false };
  if (!state.running) {
    console.log('Top senders job not running, exiting chunk');
    return;
  }

  let token;
  try {
    token = await getToken();
  } catch (err) {
    console.error('Auth failed, stopping job:', err);
    await persistJobState({ ...state, running: false });
    chrome.runtime.sendMessage({ action: 'authError', error: err.message }).catch(() => {});
    return;
  }

  // Tunable parameters for performance
  const pageSize = 500; // list page size (Gmail max ~500)

  // Process multiple list pages per invocation to avoid stopping after the first page (500 messages).
  // This keeps the worker making progress while still yielding between chunks. Adjust maxPagesPerRun
  // to balance runtime vs. service worker lifetime. If the worker is terminated, the job will resume
  // from the stored nextPageToken on the next alarm/run.
  const maxPagesPerRun = 6; // process up to ~6 * pageSize messages per invocation (tweakable)
  let pagesProcessed = 0;
  let requestsMade = 0;
  const processingStart = Date.now();

  // Loop over list pages (messages.list) until we've processed maxPagesPerRun or there are no more pages
  while (pagesProcessed < maxPagesPerRun) {
    // Re-check the running flag fresh from storage each iteration — `state`
    // is a local snapshot from the top of this function, so it never sees a
    // Cancel that happens mid-chunk. Without this, Cancel Scan could take up
    // to ~6 pages (~3000 messages) to actually stop.
    const freshWrap = await storageGet(['topSendersJob']);
    if (!freshWrap.topSendersJob || !freshWrap.topSendersJob.running) {
      console.log('Top senders job cancelled, stopping chunk.');
      return;
    }

    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', '-category:spam');
    url.searchParams.set('maxResults', String(pageSize));
    // limit fields returned by the list call to reduce payload and parsing
    url.searchParams.set('fields', 'messages(id),nextPageToken');
    if (state.nextPageToken) url.searchParams.set('pageToken', state.nextPageToken);

    const listRes = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '');
      console.error('Failed listing messages:', listRes.status, body);
      // schedule retry later
      scheduleNextChunk(0.5);
      return;
    }

    const data = await listRes.json();
    const messages = data.messages || [];
    const authFailFlag = { failed: false };

    // Gate request *starts* through the rate limiter but let them run
    // concurrently (rather than firing fixed-size bursts with a flat sleep
    // between them, which was tripping Gmail's per-second limit and eating
    // most of the runtime in retry backoff).
    const requests = messages.map(async m => {
      await rateGate();
      return fetchWithRetry(
        // request only the headers we need to minimize payload, and also request internalDate for accurate timestamps
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&fields=payload(headers(name,value)),internalDate`,
        { headers: { Authorization: `Bearer ${token}` } },
        3,
        300,
        authFailFlag
      );
    });
    requestsMade += requests.length;

    const details = await Promise.all(requests);

    if (authFailFlag.failed) {
      // Token expired/was revoked mid-run: drop the cache and persist what we
      // have so far instead of silently continuing to fetch with a dead token
      // (which previously meant the tail of a large mailbox just went missing
      // from the counts once the ~1hr token lifetime ran out).
      await invalidateToken();
      await persistJobState(state);
      scheduleNextChunk(0.1);
      return;
    }

    for (const d of details) {
      if (!d || !d.payload) continue;
      const header = d.payload.headers && d.payload.headers.find(h => h.name === 'From');
      if (!header || !header.value) continue;

      const key = normalizeSenderKey(header.value);

      // prefer internalDate from the message if available (ms since epoch)
      const ts = d.internalDate ? Number(d.internalDate) : Date.now();

      if (!state.senderStats) state.senderStats = {};
      if (!state.senderStats[key]) state.senderStats[key] = { count: 0, first: ts, last: ts };
      const stat = state.senderStats[key];
      stat.count += 1;
      if (ts < stat.first) stat.first = ts;
      if (ts > stat.last) stat.last = ts;
      state.totalProcessed = (state.totalProcessed || 0) + 1;
    }

    // finished processing this list page
    // update nextPageToken from listing response and persist progress
    state.nextPageToken = data.nextPageToken || null;
    await persistJobState(state);

    pagesProcessed += 1;

    // if there is another page and we haven't hit the per-run cap, continue the while loop
    if (!state.nextPageToken) break;
  }

  // estimate and log quota usage for the pages processed in this invocation
  const elapsedMs = Math.max(1, Date.now() - processingStart);
  const requestsPerMinute = +(requestsMade / (elapsedMs / 60000)).toFixed(2);
  console.log(`Estimated API requests per minute for this run: ${requestsPerMinute} (requests: ${requestsMade}, elapsedMs: ${elapsedMs}, pagesProcessed: ${pagesProcessed})`);

  // send incremental progress (top senders without per-email rate attached)
  const top = Object.entries(state.senderStats || {})
    .map(([email, s]) => ({ email, count: s.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  chrome.runtime.sendMessage({ action: 'progress', processed: state.totalProcessed || 0, top }).catch(() => {});

  if (state.nextPageToken) {
    // schedule next chunk soon (more pages remain)
    scheduleNextChunk(0.02); // ~1.2s, subject to Chrome's alarm floor
  } else {
    // build final structured results (no per-email rates). Persist only counts.
    const results = Object.entries(state.senderStats || {})
      .sort((a, b) => b[1].count - a[1].count)
      .map(([email, stat]) => ({ email, count: stat.count }));

    // persist final counts only
    const countsToPersist = {};
    for (const r of results) countsToPersist[r.email] = r.count;
    try { await storageSet({ senderCounts: countsToPersist }); } catch (e) { console.warn(e); }

    // mark job fully completed (nextPageToken is already null, so a future
    // "start" will begin a fresh scan rather than trying to resume nothing)
    await persistJobState({ ...state, running: false });

    const totalElapsedMs = Math.max(1, Date.now() - processingStart);
    const totalRequests = state.totalProcessed || 0;
    const overallRpm = +(totalRequests / (totalElapsedMs / 60000)).toFixed(2);
    console.log(`Estimated overall API requests per minute for job completion: ${overallRpm} (requests: ${totalRequests}, elapsedMs: ${totalElapsedMs})`);

    chrome.runtime.sendMessage({ action: 'displayFrequentSenders', frequentSenders: results }).catch(() => {});
  }
}

// Alarm listener to resume work when service worker restarts
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm && alarm.name === 'topSenders') {
      processTopSendersChunk().catch(err => console.error('Alarm chunk failed', err));
    }
  });
}
