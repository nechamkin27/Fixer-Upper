# Gmail Bulk Delete

Finds which senders are filling up your inbox and lets you permanently
delete everything from a sender in one shot.

## Loading the extension

This isn't published to the Chrome Web Store — you load it unpacked:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Whenever you edit the code, click the reload icon on the extension's
   card in `chrome://extensions` to pick up the changes

## Where the UI lives

Clicking the toolbar icon opens a **side panel** docked to the right edge
of the current browser window — not a popup, not a new window. (If your
Chrome build doesn't support side panels, it falls back to opening
`panel.html` in a new tab instead.)

The panel has two independent tools:

- **Delete Emails** — type a sender's email address, click delete. Fast,
  because it just asks Gmail to search `from:<address>` and batch-deletes
  the matching message IDs directly.
- **Find Top Senders** — scans your whole inbox to rank senders by message
  count, so you can find out who's actually filling up your inbox before
  deciding what to delete. Each row in the results has its own **Delete**
  button.

## First run: the consent screen

The first time either tool needs to talk to Gmail, a small Google window
pops up asking you to sign in and grant access (scope:
`https://mail.google.com/` — full mailbox access, required because
permanent deletion needs more than the read/modify scope). Approve it and
the window closes on its own.

After that, the access token is cached in `chrome.storage.session` for the
rest of the browser session — so subsequent scans and deletes **won't**
prompt you again until either the token naturally expires (~1 hour) or you
fully close the browser. Not seeing a prompt on a later run is expected,
not a bug — it means a valid cached token was found.

## How "Find Top Senders" actually works

Gmail's API has no endpoint that returns "count of messages per sender," so
the scan has to read the `From` header of every message individually. That
inherently takes a while for a large mailbox — this extension can't get
around that, only avoid making it worse. What it does:

- Lists message IDs in pages of 500, then fetches metadata for each one
  in the background, paced to stay under Gmail's per-second rate limit.
- Runs as a **background job** in the extension's service worker, so it
  keeps going even if you close the side panel. Progress is saved after
  every page (500 messages), so:
  - Closing the panel and reopening it just reconnects to the running scan.
  - Clicking **Cancel Scan** pauses it — progress up to that point is kept.
  - Clicking **Find Top Senders** again **resumes** from where it left off
    rather than starting over, unless the previous scan already finished
    (nothing left to resume), in which case it starts a fresh one.
  - If the browser closes mid-scan, the browser keeps whatever pages had
    completed; click **Find Top Senders** again next time to pick up from
    there.
- Results are shown live as they come in (top 20 so far), then finalized
  (top 50) when the whole mailbox has been scanned.

## Deleting from a scan result

Every row in the results list has its own **Delete** button. Clicking it
asks for confirmation, then runs the exact same delete flow as the manual
"Delete Emails" box — no need to copy/paste the address.

**This deletion is permanent** — it uses Gmail's `batchDelete`, which
skips Trash entirely. There's no recovery once it's done, which is why
every delete action (manual and per-row) asks for confirmation first.

## Troubleshooting

- **Nothing happens when I click "Find Top Senders" — no prompt, no
  progress.** Open `chrome://extensions`, find this extension, click
  "service worker" (or "Inspect views: service worker") to open its
  console, and look for a `Previous top-senders job looked abandoned`
  warning or any errors. A job can get stuck showing "already running" if
  the browser or service worker was killed mid-scan; clicking the button
  again will auto-recover it after a few minutes, or you can clear it
  manually from that console:
  ```js
  chrome.storage.local.remove('topSendersJob')
  ```
- **A scan seems to have stalled for a long time.** Check the service
  worker console for `Estimated API requests per minute` log lines — if
  they stop appearing, the worker may have been killed with no alarm
  pending. Clicking "Find Top Senders" again will resume it.
- **Want to force a completely fresh scan** instead of resuming: clear the
  saved job first with the console command above, then click "Find Top
  Senders".
