console.log("Chrome internal redirect URI:", chrome.identity.getRedirectURL());
let cachedToken = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "auth") {
    getToken()
      .then(token => sendResponse({ token }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep message channel open
  }

  // support popup's 'getToken' helper name too
  if (msg.action === 'getToken') {
    getToken()
      .then(token => sendResponse({ token }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === 'startTopSenders') {
    // start the long-running fetch in the background
    startTopSendersJob().catch(err => console.error('Top senders job failed:', err));
    sendResponse({ started: true });
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
});

function getToken() {
  if (cachedToken) {
    console.log("Using cached token");
    return Promise.resolve(cachedToken);
  }

  return new Promise((resolve, reject) => {
    const redirectUri = chrome.identity.getRedirectURL();
    const clientId = "1048045525974-eoku0strjgc79fe71ah6pp12ak7lgv1m.apps.googleusercontent.com";
    const scope = "https://mail.google.com/";

    console.log("Using client ID:", chrome.runtime.getManifest().oauth2.client_id);
    const authUrl =
      `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}` +
      `&response_type=token&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scope)}&prompt=consent`;

    console.log("Launching auth flow with URL:", authUrl);
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, redirectUrl => {
      console.log("Auth flow completed with redirect URL:", redirectUrl);

      if (chrome.runtime.lastError || !redirectUrl) return reject(new Error("OAuth failed"));

      const params = new URLSearchParams(redirectUrl.split("#")[1]);
      const token = params.get("access_token");

      if (!token) return reject(new Error("No access token found"));
      console.log("Extracted access token:", token);

      cachedToken = token; // cache for session
      resolve(token);
    });
  });
}

// Helper: sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: fetch with retries and exponential backoff
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res.json();

      // For 404/410 skip immediately
      if (res.status === 404 || res.status === 410) return null;

      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    } catch (err) {
      if (attempt === retries) {
        console.warn('fetchWithRetry failed for', url, err);
        return null; // give up on this item
      }

      // on 401/403/invalid token try to fail hard (don't retry infinitely)
      if (err.status === 401 || err.status === 403) {
        console.error('Authorization error while fetching:', url, err);
        return null;
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

// Start handler: initialize persisted job state and kick off first chunk
async function startTopSendersJob() {
  // initialize state
  const initial = {
    topSendersJob: {
      running: true,
      nextPageToken: null,
      senderCounts: {},
      totalProcessed: 0
    }
  };
  await storageSet(initial);
  // run first chunk immediately
  processTopSendersChunk().catch(err => console.error('Chunk failed', err));
}

// Cancel handler: stop job and clear alarm
async function cancelTopSendersJob() {
  await storageSet({ topSendersJob: { running: false } });
  try { chrome.alarms.clear('topSenders'); } catch (e) {}
}

// Schedule next chunk using chrome.alarms (service worker friendly)
function scheduleNextChunk(delayMinutes = 0.05) {
  try {
    chrome.alarms.create('topSenders', { delayInMinutes: delayMinutes });
  } catch (e) {
    // ignore in environments without alarms
    setTimeout(() => processTopSendersChunk().catch(err => console.error(err)), 1000);
  }
}

// Process a single page worth of messages and persist progress; safe to be invoked repeatedly
async function processTopSendersChunk() {
  const stateWrap = await storageGet(['topSendersJob']);
  const state = stateWrap.topSendersJob || { running: false };
  if (!state.running) {
    console.log('Top senders job not running, exiting chunk');
    return;
  }

  const token = await getToken();
  if (!token) throw new Error('No auth token');

  // Tunable parameters for performance
  const pageSize = 500; // list page size (Gmail max ~500)
  const chunkSize = 60; // increased concurrent metadata requests per chunk (was 25)
  const interChunkDelay = 50; // ms delay between chunks (was 150)

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
    // schedule retry
    scheduleNextChunk(0.5);
    return;
  }

  const data = await listRes.json();
  const messages = data.messages || [];

  // process messages in chunks within this page
  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    const promises = chunk.map(m =>
      fetchWithRetry(
        // request only the headers we need to minimize payload
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&fields=payload(headers(name,value))`,
        { headers: { Authorization: `Bearer ${token}` } },
        3,
        300
      )
    );

    const details = await Promise.all(promises);

    for (const d of details) {
      if (!d || !d.payload) continue;
      const header = d.payload.headers && d.payload.headers.find(h => h.name === 'From');
      if (!header || !header.value) continue;

      const emailMatch = header.value.match(/<(.+?)>/);
      const key = (emailMatch ? emailMatch[1] : header.value).trim();
      state.senderCounts[key] = (state.senderCounts[key] || 0) + 1;
      state.totalProcessed = (state.totalProcessed || 0) + 1;
    }

    // gentle rate limiting between internal chunks
    await sleep(interChunkDelay);
  }

  // update nextPageToken and persist
  state.nextPageToken = data.nextPageToken || null;
  await storageSet({ topSendersJob: state });

  // send incremental progress
  const top = Object.entries(state.senderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([email, count]) => ({ email, count }));
  chrome.runtime.sendMessage({ action: 'progress', processed: state.totalProcessed || 0, top });

  if (state.nextPageToken) {
    // schedule next chunk soon
    scheduleNextChunk(0.02); // ~1.2s
  } else {
    // finished
    const finalSorted = Object.entries(state.senderCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([email, count]) => `${email} (${count})`);

    // persist final results under senderCounts
    try { await storageSet({ senderCounts: state.senderCounts }); } catch (e) { console.warn(e); }

    // clear job state
    await storageSet({ topSendersJob: { running: false } });

    chrome.runtime.sendMessage({ action: 'displayFrequentSenders', frequentSenders: finalSorted });
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