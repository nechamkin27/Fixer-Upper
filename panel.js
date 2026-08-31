const statusDiv = document.getElementById("status");
const senderInput = document.getElementById("sender");
const deleteBtn = document.getElementById("delete");
const topSendersBtn = document.getElementById("topSendersBtn");
const cancelBtn = document.getElementById("cancelTopSendersBtn");
const resultsContainer = document.getElementById("topSendersResult");

// Cancel only makes sense while a scan is actually running; its real state
// gets set once we hear back from getJobStatus / progress / completion.
cancelBtn.disabled = true;

async function getAuthToken() {
  const response = await new Promise(resolve =>
    chrome.runtime.sendMessage({ action: "auth" }, resolve)
  );
  if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
  if (!response || response.error) throw new Error((response && response.error) || "Auth failed");
  return response.token;
}

// Permanently deletes every message from `sender` (batchDelete bypasses
// Trash entirely, so this is irreversible — callers must confirm with the
// user before calling this).
async function deleteEmailsFromSender(sender, statusEl) {
  statusEl.textContent = "Fetching emails...";
  statusEl.style.color = "black";

  try {
    const token = await getAuthToken();

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

      statusEl.textContent = `Fetched ${allMessages.length} emails...`;
    } while (nextPageToken);

    if (allMessages.length === 0) {
      statusEl.textContent = `No emails found from ${sender}`;
      statusEl.style.color = "green";
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
        statusEl.textContent = `Deleted ${Math.min(i + batch.length, allMessages.length)} of ${allMessages.length} emails...`;
      } else {
        console.error("Batch delete error:", result);
        statusEl.textContent = `Error deleting batch at emails ${i + 1}-${i + batch.length}`;
      }
    }

    statusEl.textContent = `Deleted all ${allMessages.length} emails from ${sender}`;
    statusEl.style.color = "green";

  } catch (err) {
    console.error(err);
    statusEl.textContent = "Error: " + err.message;
    statusEl.style.color = "red";
  }
}

deleteBtn.onclick = async () => {
  const sender = senderInput.value.trim();
  if (!sender) {
    statusDiv.textContent = "Enter a sender email";
    statusDiv.style.color = "red";
    return;
  }
  if (!confirm(`Permanently delete all emails from ${sender}? This cannot be undone.`)) return;
  await deleteEmailsFromSender(sender, statusDiv);
};

// =======================================
// Top senders scan + results rendering
// =======================================

// Renders a list of {email, count} entries. Each row has its own Delete
// button (runs immediately, independently — multiple rows can already run
// concurrently since nothing blocks between `await`s). There's also a
// checkbox per row plus a "Delete Selected" button so several senders can
// be queued with a single confirmation and run concurrently via
// Promise.all, instead of dismissing one modal dialog per sender.
function renderSenderList(entries, heading) {
  resultsContainer.innerHTML = "";

  const h = document.createElement("div");
  h.textContent = heading;
  h.style.marginBottom = "8px";
  resultsContainer.appendChild(h);

  const bulkDeleteBtn = document.createElement("button");
  bulkDeleteBtn.textContent = "Delete Selected";
  bulkDeleteBtn.disabled = true;
  bulkDeleteBtn.style.marginBottom = "8px";
  resultsContainer.appendChild(bulkDeleteBtn);

  const list = document.createElement("ol");
  list.style.paddingLeft = "20px";
  list.style.margin = "0";

  const rows = [];

  function updateBulkButton() {
    bulkDeleteBtn.disabled = !rows.some(r => r.checkbox.checked && !r.checkbox.disabled);
  }

  entries.forEach(({ email, count }) => {
    const li = document.createElement("li");
    li.style.marginBottom = "4px";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.style.marginRight = "6px";
    checkbox.addEventListener("change", updateBulkButton);
    li.appendChild(checkbox);

    const label = document.createElement("span");
    label.textContent = `${email} — ${count} `;
    li.appendChild(label);

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.style.marginLeft = "6px";

    const rowStatus = document.createElement("span");
    rowStatus.style.marginLeft = "8px";
    rowStatus.style.fontSize = "0.9em";

    delBtn.onclick = async () => {
      if (!confirm(`Permanently delete all ${count} emails from ${email}? This cannot be undone.`)) return;
      delBtn.disabled = true;
      checkbox.disabled = true;
      updateBulkButton();
      await deleteEmailsFromSender(email, rowStatus);
      delBtn.disabled = false;
      checkbox.disabled = false;
      updateBulkButton();
    };

    li.appendChild(delBtn);
    li.appendChild(rowStatus);
    list.appendChild(li);

    rows.push({ email, count, checkbox, delBtn, statusEl: rowStatus });
  });

  resultsContainer.appendChild(list);

  bulkDeleteBtn.onclick = async () => {
    const selected = rows.filter(r => r.checkbox.checked && !r.checkbox.disabled);
    if (selected.length === 0) return;

    const totalEmails = selected.reduce((sum, r) => sum + r.count, 0);
    const names = selected.map(r => r.email).join("\n");
    const ok = confirm(
      `Permanently delete all emails from ${selected.length} sender(s) (${totalEmails} emails total)?\n\n${names}\n\nThis cannot be undone.`
    );
    if (!ok) return;

    selected.forEach(r => { r.delBtn.disabled = true; r.checkbox.disabled = true; });
    updateBulkButton();

    // Run all selected senders' delete flows concurrently rather than
    // one-at-a-time — each is independent (own list + batchDelete calls).
    await Promise.all(selected.map(r => deleteEmailsFromSender(r.email, r.statusEl)));

    selected.forEach(r => { r.delBtn.disabled = false; r.checkbox.disabled = false; r.checkbox.checked = false; });
    updateBulkButton();
  };
}

topSendersBtn.addEventListener("click", () => {
  resultsContainer.textContent = "Starting background scan…";
  topSendersBtn.disabled = true;

  chrome.runtime.sendMessage({ action: "startTopSenders" }, resp => {
    if (chrome.runtime.lastError) {
      resultsContainer.textContent = "Failed to start background scan.";
      console.error(chrome.runtime.lastError);
      topSendersBtn.disabled = false;
      return;
    }

    if (resp && resp.alreadyRunning) {
      resultsContainer.textContent = "A scan is already running — will update progress here.";
      cancelBtn.disabled = false;
    } else if (resp && resp.started) {
      resultsContainer.textContent = resp.resumed
        ? "Resuming previous scan — will update progress here."
        : "Background scan started — will update progress here.";
      cancelBtn.disabled = false;
    } else {
      resultsContainer.textContent = "Background did not acknowledge start: " + ((resp && resp.error) || "unknown error");
      topSendersBtn.disabled = false;
    }
  });
});

// Listen for progress and final results from the background service worker
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "progress") {
    renderSenderList(request.top, `Processed ${request.processed} emails so far (top ${request.top.length}):`);
    cancelBtn.disabled = false;
  }

  if (request.action === "displayFrequentSenders") {
    const items = (request.frequentSenders || []).slice(0, 50);
    renderSenderList(items, `Scan complete — top ${items.length} senders:`);
    topSendersBtn.disabled = false;
    cancelBtn.disabled = true;
  }

  if (request.action === "authError") {
    resultsContainer.textContent = "Authentication failed, scan stopped: " + request.error;
    topSendersBtn.disabled = false;
    cancelBtn.disabled = true;
  }
});

// Ensure panel shows cached results on open and allow cancelling the background job
document.addEventListener('DOMContentLoaded', () => {
  // Request any stored aggregated sender counts from background
  chrome.runtime.sendMessage({ action: 'getStoredSenders' }, resp => {
    if (chrome.runtime.lastError) {
      console.warn('Could not retrieve stored senders:', chrome.runtime.lastError);
      return;
    }

    const counts = (resp && resp.senderCounts) || {};
    const entries = Object.entries(counts)
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

    if (entries.length === 0) {
      resultsContainer.textContent = 'No cached results yet.';
    } else {
      renderSenderList(entries, `Cached results (top ${entries.length}):`);
    }
  });

  // Reflect whether a scan is actually running (e.g. panel was closed and
  // reopened mid-scan) rather than defaulting Cancel Scan to enabled/disabled.
  chrome.runtime.sendMessage({ action: 'getJobStatus' }, resp => {
    if (chrome.runtime.lastError) return;
    const running = !!(resp && resp.running);
    cancelBtn.disabled = !running;
    topSendersBtn.disabled = running;
  });

  // Cancel button handler
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'cancelTopSenders' }, resp => {
        if (chrome.runtime.lastError) {
          resultsContainer.textContent = 'Failed to request cancel.';
          console.error(chrome.runtime.lastError);
          return;
        }
        resultsContainer.textContent = 'Scan paused — progress is saved, click "Find Top Senders" to resume.';
        topSendersBtn.disabled = false;
        cancelBtn.disabled = true;
      });
    });
  }
});
