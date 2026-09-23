# Mail Cleaner

A Chrome extension that scans your Gmail inbox and flags mail from
senders you haven't explicitly trusted — a default-deny classifier,
not a keyword/spam-content filter. It runs entirely client-side: no
server, no stored credentials, no third party ever sees your mail.
Every network call goes straight from your browser to Google's Gmail
API using your own OAuth login.

This is the same classification approach as the `yahooMailCleaner` CLI
(a separate project), ported to run in the browser against Gmail
instead of IMAP.

## Features

- **Scan** your inbox and get a digest: how many messages, across how
  many senders, are from domains you haven't trusted.
- **Review** flagged senders one by one (or select all at once), with
  the reason each was flagged — no `List-Unsubscribe` header, failed
  sender authentication, a suspicious-looking address, or simply a
  domain never seen before.
- **Trust** a sender with one click — it's remembered (synced via your
  Google account, `chrome.storage.sync`) and excluded from every scan
  after that.
- **Clean** selected senders in one action: messages move to Gmail's
  Trash (never permanently deleted — fully recoverable) and an
  unsubscribe request fires automatically where possible (RFC 8058
  one-click, plain HTTP, or `mailto:`).
- Scans of large inboxes (thousands of messages) run reliably in the
  background via `chrome.alarms`-driven chunking, resuming
  automatically if interrupted — you can close the side panel and come
  back later to see live progress.

## Installing (unpacked, for now)

Not yet published to the Chrome Web Store.

1. Go to `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked**, select this directory.
3. Click the extension's toolbar icon to open the side panel, then
   **Scan my inbox**. The first scan will prompt you to sign in and
   grant Gmail access.

### OAuth setup (one-time, per developer)

The Google Cloud OAuth client ID is tied to the specific extension ID
Chrome assigns when you load it unpacked, so each developer needs
their own Google Cloud project — see Task 5 in
`docs/superpowers/plans/2026-09-19-v1-implementation.md` for exact
steps. Keep the consent screen's "Publishing status" on **Testing**
and add your Gmail account under "Test users" — no Google verification
review is needed for personal/invited use.

## How it works

- `src/background.js` — the service worker: OAuth, Gmail API calls,
  classification, and executing cleanup actions.
- `sidepanel.html` / `src/sidepanel.js` — the UI: scan digest, review
  list, trust/clean actions.
- `src/headers.js`, `src/classify.js`, `src/aggregate.js`,
  `src/gmailAdapter.js` — pure functions (no Chrome APIs, fully unit
  tested): parsing headers, the default-deny classification rules, and
  aggregating results by domain.

See `docs/superpowers/specs/2026-09-19-v1-design.md` for the full
design and `docs/superpowers/plans/2026-09-19-v1-implementation.md`
for how it was built.

## Development

Requires Node.js 18+.

```
npm test
```

Tests cover every pure function (header parsing, classification,
aggregation, the Gmail API response adapter) with `node --test` — no
network or browser required. `background.js`/`sidepanel.js` themselves
are exercised by hand against a real Gmail account (see the plan's
Task 10 for the verification checklist), not by the automated suite.
