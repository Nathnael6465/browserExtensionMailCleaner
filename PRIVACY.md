# Mail Cleaner — Privacy Policy

_Last updated: September 23, 2026_

Mail Cleaner is a Chrome extension that scans your Gmail inbox and helps
you review and clean up mail from senders you haven't trusted. This
policy explains what data it accesses, how it's used, and what is (and
isn't) shared with anyone else.

## What data Mail Cleaner accesses

Using your own Google sign-in (OAuth), Mail Cleaner requests permission
to:

- **Read your Gmail messages** (`gmail.modify` scope) — to scan message
  headers (sender, subject, unsubscribe links, authentication results)
  for classification, and to move messages you select to Trash.
- **Send email on your behalf** (`gmail.send` scope) — only to send an
  unsubscribe request, and only for a message you've explicitly
  selected to clean, and only when that message's own
  `List-Unsubscribe` header specifies an email address to unsubscribe
  via (rather than a web link).

Mail Cleaner never reads, stores, or transmits the **body** of your
emails — only header fields relevant to classification (sender,
subject, unsubscribe headers, authentication results).

## Where your data goes

**Nowhere except Google's own Gmail API and, when you choose to clean a
sender, that sender's own unsubscribe link or address.** Mail Cleaner
has no server of its own. All scanning, classification, and review
happens entirely inside your browser. No email content, message
metadata, or account information is ever sent to the developer or to
any third party analytics/tracking service.

When you clean a sender whose unsubscribe method is a web link (rather
than an email address), Mail Cleaner sends a request directly to that
link — the same as if you'd clicked "unsubscribe" yourself. That
request goes to the sender's own server, not to us.

## What's stored, and where

- **Scan results** (which senders were flagged, and why) are cached
  locally in your browser (`chrome.storage.local`) so you don't need to
  re-scan every time you open the extension. This cache never leaves
  your device.
- **Senders you've trusted** are stored via Chrome's built-in sync
  storage (`chrome.storage.sync`), which Google syncs across your own
  signed-in Chrome browsers the same way bookmarks or saved passwords
  sync — this is Google's own sync mechanism tied to your Google
  account, not a service Mail Cleaner operates.

Uninstalling the extension removes its locally cached data. Removing
synced trusted-sender data can be done by clearing the extension's
data from `chrome://settings/syncSetup` or by uninstalling the
extension from all your synced devices.

## What Mail Cleaner does not do

- No ads, no analytics, no tracking pixels, no third-party SDKs.
- No data is sold, rented, or shared for advertising purposes.
- No account, email, or usage data is transmitted to the developer.
- No action (unsubscribe, trash) is ever taken without you explicitly
  selecting it and clicking a confirm action.

## Changes to this policy

If this policy changes, the updated version will be posted at this
same location with a new "Last updated" date.

## Contact

Questions about this policy or the extension's data handling can be
filed at: https://github.com/Nathnael6465/browserExtensionMailCleaner/issues
