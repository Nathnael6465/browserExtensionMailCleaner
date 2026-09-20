# Browser Extension Mail Cleaner

A Chrome extension that scans a Gmail inbox via the Gmail API and flags
messages from senders whose domain isn't explicitly trusted — the same
default-deny classification model as the `yahooMailCleaner` CLI
(a separate project), ported to run entirely client-side in the
browser using the user's own Gmail OAuth login instead of IMAP.

No server, no stored credentials — every network call goes directly
from your browser to Google's Gmail API.

See `docs/superpowers/specs/2026-09-19-v1-design.md` for the full design.

## Development setup

Requires Node.js 18+.

```
npm test
```

## Loading the extension locally

1. Go to `chrome://extensions`, enable "Developer mode" (top right).
2. Click "Load unpacked", select this directory.
3. See the spec's OAuth setup section for connecting a Google Cloud
   project before the extension can authenticate.

## OAuth setup (one-time, per developer)

The Google Cloud OAuth client ID is tied to your specific extension ID,
which Chrome assigns when you load the extension unpacked — so you
need your own Google Cloud project, not a shared one. See Task 5 in
`docs/superpowers/plans/2026-09-19-v1-implementation.md` for exact
steps. Keep "Publishing status" on **Testing** — add your own Gmail
test account under "Test users" — no Google verification review is
needed for personal use.
