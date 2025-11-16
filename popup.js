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

document.getElementById("topSendersBtn").addEventListener("click", async () => {
  const senderCounts = {};
  const resultEl = document.getElementById("topSendersResult");
  resultEl.textContent = "Scanning… hang tight 👀";

  const token = await getToken();
  if (!token) {
    resultEl.textContent = "Auth failed";
    return;
  }

  let nextPageToken = null;
  let totalProcessed = 0;

  try {
    do {
      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      url.searchParams.set("q", "-category:spam");
      url.searchParams.set("maxResults", "500");
      if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

      const listRes = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const listData = await listRes.json();
      const messages = listData.messages || [];

      // Get IDs cleanly
      const ids = messages.map(m => m.id);

      // Metadata, rate-safe, controlled batches
      const metadata = await fetchMetadataSafe(ids, token);

      for (const detail of metadata) {
        if (!detail || !detail.payload || !detail.payload.headers) continue;

        const header = detail.payload.headers.find(h => h.name === "From");
        if (!header) continue;

        const match = header.value.match(/<(.+?)>/);
        const email = match ? match[1] : header.value;

        senderCounts[email] = (senderCounts[email] || 0) + 1;
        totalProcessed++;
      }

      resultEl.textContent = `Processed ${totalProcessed} emails…`;

      nextPageToken = listData.nextPageToken;
    } while (nextPageToken);

    // Ranking
    const top = Object.entries(senderCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    let output = `Top 5 senders (from ${totalProcessed} emails):\n\n`;
    top.forEach(([email, count], i) => {
      output += `${i + 1}. ${email} — ${count}\n`;
    });

    resultEl.textContent = output;

  } catch (e) {
    console.error(e);
    resultEl.textContent = "Error during scan";
  }
});