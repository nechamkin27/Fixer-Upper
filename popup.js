// =======================================
// Helper: Get OAuth token from background
// =======================================
async function getToken() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "getToken" }, token => {
      if (chrome.runtime.lastError) {
        console.error("Token retrieval error:", chrome.runtime.lastError);
        reject("Token error");
      } else if (!token) {
        reject("No token");
      } else {
        resolve(token);
      }
    });
  });
}


const statusDiv = document.getElementById("status");

document.getElementById("delete").onclick = async () => {
  const sender = document.getElementById("sender").value.trim();
  if (!sender) {
    statusDiv.textContent = "Enter a sender email";
    statusDiv.style.color = "red";
    return;
  }

  statusDiv.textContent = "Fetching emails...";
  statusDiv.style.color = "black";

  try {
    // Get fresh token from background
    const response = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: "auth" }, resolve)
    );
    if (response.error) throw new Error(response.error);
    const token = response.token;

    // Fetch all messages from sender with pagination
    let allMessages = [];
    let nextPageToken = null;

    do {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      url.searchParams.set("q", `from:${sender} -category:spam`);
      if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await resp.json();

      if (data.error) throw new Error(JSON.stringify(data.error));

      allMessages = allMessages.concat(data.messages || []);
      nextPageToken = data.nextPageToken;

      statusDiv.textContent = `Fetched ${allMessages.length} emails...`;
    } while (nextPageToken);

    if (allMessages.length === 0) {
      statusDiv.textContent = `No emails found from ${sender}`;
      statusDiv.style.color = "green";
      return;
    }

    // Delete messages in batches of max 1000
    const batchSize = 1000;
    for (let i = 0; i < allMessages.length; i += batchSize) {
      const batch = allMessages.slice(i, i + batchSize).map(m => m.id);

      const deleteResp = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchDelete",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ids: batch }),
        }
      );

      const result = await deleteResp.json().catch(() => ({}));
      if (deleteResp.ok) {
        statusDiv.textContent = `Deleted ${Math.min(i + batch.length, allMessages.length)} of ${allMessages.length} emails...`;
      } else {
        console.error("Batch delete error:", result);
        statusDiv.textContent = `Error deleting batch at emails ${i + 1}-${i + batch.length}`;
      }
    }

    statusDiv.textContent = `Deleted all ${allMessages.length} emails from ${sender}`;
    statusDiv.style.color = "green";

  } catch (err) {
    console.error(err);
    statusDiv.textContent = "Error: " + err.message;
    statusDiv.style.color = "red";
  }
};

async function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function fetchMetadataSafe(ids, token, batchSize = 10) {
  const results = [];

  for (let i = 0; i < ids.length; i += batchSize) {
    const slice = ids.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      slice.map(id =>
        fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From`,
          {
            headers: { Authorization: `Bearer ${token}` }
          }
        )
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null)
      )
    );

    results.push(...batchResults);

    // Friendly little ball-saving delay
    await sleep(120);
  }

  return results;
}

// =======================================
// ACCURATE + RATE-SAFE TOP SENDERS
// =======================================
document.getElementById("topSendersBtn").addEventListener("click", () => {
  const out = document.getElementById("topSendersResult");
  out.textContent = "Starting background scan…";
  document.getElementById("topSendersBtn").disabled = true;

  chrome.runtime.sendMessage({ action: "startTopSenders" }, resp => {
    if (chrome.runtime.lastError) {
      out.textContent = "Failed to start background scan.";
      console.error(chrome.runtime.lastError);
      document.getElementById("topSendersBtn").disabled = false;
      return;
    }

    if (resp && resp.started) {
      out.textContent = "Background scan started — will update progress here.";
    } else {
      out.textContent = "Background did not acknowledge start.";
      document.getElementById("topSendersBtn").disabled = false;
    }
  });
});

// Listen for progress and final results from the background service worker
chrome.runtime.onMessage.addListener((request) => {
  const out = document.getElementById("topSendersResult");
  const btn = document.getElementById("topSendersBtn");

  if (request.action === "progress") {
    const lines = [`Processed ${request.processed} emails…`, "", "Top (partial):"];
    request.top.forEach((t, i) => lines.push(`${i + 1}. ${t.email} — ${t.count}`));
    out.textContent = lines.join("\n");
  }

  if (request.action === "displayFrequentSenders") {
    out.textContent = `Final results (top ${Math.min(50, request.frequentSenders.length)}):\n\n` + request.frequentSenders.slice(0, 50).join("\n");
    if (btn) btn.disabled = false;
  }
});

// Ensure popup shows cached results on open and allow cancelling the background job
document.addEventListener('DOMContentLoaded', () => {
  const out = document.getElementById('topSendersResult');

  // Request any stored aggregated sender counts from background
  chrome.runtime.sendMessage({ action: 'getStoredSenders' }, resp => {
    if (chrome.runtime.lastError) {
      console.warn('Could not retrieve stored senders:', chrome.runtime.lastError);
      return;
    }

    const counts = (resp && resp.senderCounts) || {};
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      out.textContent = out.textContent || 'No cached results.';
    } else {
      out.textContent = `Cached results (top ${Math.min(50, entries.length)}):\n\n` +
        entries.slice(0, 50).map((e, i) => `${i + 1}. ${e[0]} — ${e[1]}`).join('\n');
    }
  });

  // Cancel button handler
  const cancelBtn = document.getElementById('cancelTopSendersBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'cancelTopSenders' }, resp => {
        if (chrome.runtime.lastError) {
          out.textContent = 'Failed to request cancel.';
          console.error(chrome.runtime.lastError);
          return;
        }
        out.textContent = 'Cancel requested.';
        // re-enable start button
        const startBtn = document.getElementById('topSendersBtn');
        if (startBtn) startBtn.disabled = false;
      });
    });
  }
});