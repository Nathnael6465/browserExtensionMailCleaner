# Browser Extension Mail Cleaner v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension that scans a user's Gmail inbox via the Gmail API, classifies messages using the same default-deny domain-trust model as the `yahooMailCleaner` CLI, and lets the user review and bulk-unsubscribe/trash flagged senders — with no server, no stored credentials, and OAuth consent handled entirely by Google.

**Architecture:** Three extension surfaces (background service worker, popup, review tab) share a set of pure, unit-tested JS modules (`classify.js`, `headers.js`, `aggregate.js`) ported directly from the CLI's Python logic. The background worker is the only piece that talks to the Gmail API (via `fetch()`, OAuth token from `chrome.identity`) and to `chrome.storage`; the popup and review tab only render cached state and send messages to the background worker.

**Tech Stack:** Vanilla JavaScript (ES modules), Chrome Extension Manifest V3, Gmail API v1, Node's built-in `node:test` + `node:assert` for unit tests (no test framework dependency), no build step, no bundler.

**Spec:** `/Users/nathnael/Documents/Projects/browserExtensionMailCleaner/docs/superpowers/specs/2026-09-19-v1-design.md`

## Global Constraints

- No credentials of any kind are ever stored by the extension (spec NFR1) — only OAuth tokens issued by Google via `chrome.identity`.
- No server/backend for any v1 functionality (spec NFR2) — every network call the extension makes goes directly from the user's browser to `gmail.googleapis.com`.
- "Delete" always means Gmail's Trash endpoint, never permanent deletion (spec NFR3).
- `classify.js`/`headers.js`/`aggregate.js` must be pure functions with zero `chrome.*` or network calls, so they run identically under `node:test` and inside the extension (spec FR4, NFR4).
- OAuth consent screen stays in Google Cloud Console "Testing" publishing status for all of v1 (spec NFR5) — no public verification review.
- Gmail only — no IMAP, no Yahoo, no other provider (spec NFR6).

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `src/` (empty directory, populated by later tasks)
- Create: `test/` (empty directory, populated by later tasks)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm test` as the standard way every later task runs its tests; ES module resolution (`"type": "module"`) that every later `src/`/`test/` file relies on.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "browser-extension-mail-cleaner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Chrome extension: scans Gmail via the Gmail API and flags untrusted senders using a default-deny domain-trust classifier.",
  "scripts": {
    "test": "node --test test/"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 3: Create `README.md`**

```markdown
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
```

- [ ] **Step 4: Create empty `src/` and `test/` directories**

```bash
mkdir -p src test
```

- [ ] **Step 5: Verify `npm test` runs cleanly with zero test files**

Run: `npm test`
Expected: exits 0 (Node's test runner reports "0 tests" or similar — no error, since no test files exist yet).

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore README.md
git commit -m "Scaffold project: package.json, gitignore, README"
```

---

### Task 2: `headers.js` — header parsing, ported from `headers.py`

**Files:**
- Create: `src/headers.js`
- Test: `test/headers.test.js`

**Interfaces:**
- Consumes: nothing (pure module, no dependencies on other project files).
- Produces (used by Task 4's `aggregate.js` and Task 6's Gmail adapter):
  - `parseListUnsubscribe(header: string|null): {mailto: string|null, http: string|null}`
  - `hasOneClickUnsubscribe(header: string|null): boolean`
  - `parseAuthenticationResults(header: string|null): {spf: string|null, dkim: string|null, dmarc: string|null}`
  - `decodeMimeWords(value: string|null): string`

**Porting note:** the CLI's `decode_mime_words` has a bug-fix branch for Python's `email` module labeling raw undeclared 8-bit header bytes as `"unknown-8bit"` — that's specific to parsing a raw IMAP byte stream with Python's `email.message_from_bytes`. The Gmail API returns header values as already-materialized JSON strings, never raw bytes, so that specific failure mode doesn't exist here. This port instead handles RFC 2047 encoded-words (`=?charset?B?...?=` / `=?charset?Q?...?=`) directly using the browser/Node-native `TextDecoder`, and falls back to returning text unchanged on any decode failure — same "never throw on a malformed header" spirit as the original fix, adapted to what's actually possible in this data path.

- [ ] **Step 1: Write the failing test file**

Create `test/headers.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseListUnsubscribe,
  hasOneClickUnsubscribe,
  parseAuthenticationResults,
  decodeMimeWords,
} from "../src/headers.js";

// --- parseListUnsubscribe ---

test("parses mailto and https together", () => {
  const header = "<mailto:unsub@example.com>, <https://example.com/unsubscribe?id=123>";
  const result = parseListUnsubscribe(header);
  assert.equal(result.mailto, "unsub@example.com");
  assert.equal(result.http, "https://example.com/unsubscribe?id=123");
});

test("parses https only", () => {
  const header = "<https://example.com/unsubscribe?id=123>";
  const result = parseListUnsubscribe(header);
  assert.equal(result.http, "https://example.com/unsubscribe?id=123");
  assert.equal(result.mailto, null);
});

test("parses mailto only", () => {
  const header = "<mailto:unsub@example.com>";
  const result = parseListUnsubscribe(header);
  assert.equal(result.mailto, "unsub@example.com");
  assert.equal(result.http, null);
});

test("missing List-Unsubscribe header returns no links", () => {
  const result = parseListUnsubscribe(null);
  assert.equal(result.mailto, null);
  assert.equal(result.http, null);
});

// --- hasOneClickUnsubscribe (RFC 8058) ---

test("one-click flag present", () => {
  assert.equal(hasOneClickUnsubscribe("List-Unsubscribe=One-Click"), true);
});

test("one-click flag missing header", () => {
  assert.equal(hasOneClickUnsubscribe(null), false);
});

test("one-click flag wrong value", () => {
  assert.equal(hasOneClickUnsubscribe("something-else"), false);
});

// --- parseAuthenticationResults ---

test("parses all pass", () => {
  const header =
    "mta1234.mail.yahoo.com; " +
    "dkim=pass header.i=@example.com; " +
    "spf=pass smtp.mailfrom=example.com; " +
    "dmarc=pass header.from=example.com";
  const result = parseAuthenticationResults(header);
  assert.equal(result.spf, "pass");
  assert.equal(result.dkim, "pass");
  assert.equal(result.dmarc, "pass");
});

test("parses mixed results", () => {
  const header = "mta.mail.yahoo.com; dkim=fail; spf=softfail smtp.mailfrom=example.com; dmarc=none";
  const result = parseAuthenticationResults(header);
  assert.equal(result.spf, "softfail");
  assert.equal(result.dkim, "fail");
  assert.equal(result.dmarc, "none");
});

test("missing Authentication-Results header", () => {
  const result = parseAuthenticationResults(null);
  assert.equal(result.spf, null);
  assert.equal(result.dkim, null);
  assert.equal(result.dmarc, null);
});

// --- decodeMimeWords ---

test("decodes utf-8 base64 encoded header", () => {
  // Real padding character (U+00B7) followed by "JoinAARP", base64
  // encoded exactly as the equivalent Python fixture used.
  const header = "=?utf-8?b?wrcgwrcgwrcgSm9pbkFBUlA=?=";
  assert.equal(decodeMimeWords(header), "· · · JoinAARP");
});

test("decodes utf-8 quoted-printable encoded header", () => {
  const header = "=?utf-8?q?Protect_Your_401=28k=29?=";
  assert.equal(decodeMimeWords(header), "Protect Your 401(k)");
});

test("returns plain ASCII header unchanged", () => {
  assert.equal(decodeMimeWords("Weekly Digest"), "Weekly Digest");
});

test("returns empty string for missing header", () => {
  assert.equal(decodeMimeWords(null), "");
  assert.equal(decodeMimeWords(""), "");
});

test("malformed encoded-word marker does not throw, falls back to raw text", () => {
  const header = "=?utf-8?b?not-valid-base64!!!?=";
  assert.doesNotThrow(() => decodeMimeWords(header));
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test`
Expected: FAIL — `src/headers.js` does not exist yet (module not found error).

- [ ] **Step 3: Write `src/headers.js`**

```javascript
const MAILTO_RE = /<mailto:([^>]+)>/;
const HTTP_RE = /<(https?:\/\/[^>]+)>/;
const AUTH_RESULT_RE = /\b(spf|dkim|dmarc)=([a-zA-Z]+)/g;
const ENCODED_WORD_RE = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

export function parseListUnsubscribe(header) {
  const result = { mailto: null, http: null };
  if (!header) return result;

  const mailtoMatch = MAILTO_RE.exec(header);
  if (mailtoMatch) result.mailto = mailtoMatch[1];

  const httpMatch = HTTP_RE.exec(header);
  if (httpMatch) result.http = httpMatch[1];

  return result;
}

export function hasOneClickUnsubscribe(header) {
  if (!header) return false;
  return header.includes("List-Unsubscribe=One-Click");
}

export function parseAuthenticationResults(header) {
  const result = { spf: null, dkim: null, dmarc: null };
  if (!header) return result;

  for (const match of header.matchAll(AUTH_RESULT_RE)) {
    const [, mechanism, value] = match;
    result[mechanism.toLowerCase()] = value.toLowerCase();
  }

  return result;
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function quotedPrintableToBytes(text) {
  // In RFC 2047 Q-encoding, "_" represents a space (unlike body Q-encoding).
  const normalized = text.replace(/_/g, " ");
  const bytes = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === "=" && i + 2 < normalized.length) {
      const hex = normalized.slice(i + 1, i + 3);
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i));
    }
  }
  return new Uint8Array(bytes);
}

function decodeEncodedWord(charset, encoding, text) {
  const bytes = encoding.toLowerCase() === "b" ? base64ToBytes(text) : quotedPrintableToBytes(text);
  const decoder = new TextDecoder(charset, { fatal: false });
  return decoder.decode(bytes);
}

export function decodeMimeWords(value) {
  if (!value) return "";

  let result = "";
  let lastIndex = 0;
  ENCODED_WORD_RE.lastIndex = 0;
  let match;
  while ((match = ENCODED_WORD_RE.exec(value)) !== null) {
    result += value.slice(lastIndex, match.index);
    const [, charset, encoding, text] = match;
    try {
      result += decodeEncodedWord(charset, encoding, text);
    } catch {
      // Malformed encoded-word — never throw on a bad header, fall back
      // to the raw matched text untouched.
      result += match[0];
    }
    lastIndex = ENCODED_WORD_RE.lastIndex;
  }
  result += value.slice(lastIndex);
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all 15 tests in `test/headers.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add src/headers.js test/headers.test.js
git commit -m "Add headers.js: port List-Unsubscribe/auth-results parsing and RFC 2047 decoding"
```

---

### Task 3: `classify.js` — the default-deny classifier, ported from `classify.py`

**Files:**
- Create: `src/classify.js`
- Test: `test/classify.test.js`

**Interfaces:**
- Consumes: nothing directly (pure module — callers pass in already-parsed values; does not import `headers.js`).
- Produces (used by Task 4's `aggregate.js`):
  - `KNOWN_BRAND_DOMAINS: Set<string>`
  - `classifyMessage(sender, listUnsubscribe, authResults, allowlist, displayName, subject): {flagged: boolean, reasons: string[]}`
  - `isVerifiedDomain(domain: string, verified: Set<string>): boolean`

- [ ] **Step 1: Write the failing test file**

Create `test/classify.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, KNOWN_BRAND_DOMAINS } from "../src/classify.js";

const noUnsub = { mailto: null, http: null };
const noAuth = { spf: null, dkim: null, dmarc: null };
const passAuth = { spf: "pass", dkim: "pass", dmarc: "pass" };

// --- .gov is inherently trusted, even with an empty allowlist ---

test(".gov domain passes with empty allowlist", () => {
  const result = classifyMessage(
    "notice@bentoncountyar.gov", noUnsub, noAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test(".gov lookalike domain is not treated as .gov", () => {
  const result = classifyMessage(
    "alerts@notreallygov.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["unverified_domain"]);
});

// --- auth failure — checked first, short-circuits ---

test("flags via auth failure even with suspicious local-part", () => {
  const result = classifyMessage(
    "rnk4wxc@t4r.plasticcars.com", noUnsub, noAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["auth_failed_or_missing"]);
});

test("flags message when authentication fails even with readable name", () => {
  const result = classifyMessage(
    "alerts@suspicious-domain.com", noUnsub,
    { spf: "fail", dkim: "fail", dmarc: "fail" }, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["auth_failed_or_missing"]);
});

// --- suspicious local-part, isolated with clean auth ---

test("flags machine-generated local-part with digits when auth is clean", () => {
  const result = classifyMessage(
    "rnk4wxc@t4r.plasticcars.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["suspicious_local_part"]);
});

test("flags pure-letter gibberish local-part via consonant run", () => {
  const result = classifyMessage(
    "michpjlhjrnpndjz@gtonfamilyattorney.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["suspicious_local_part"]);
});

// --- display name / subject padding-evasion ---

test("flags display name with dot padding both sides", () => {
  const result = classifyMessage(
    "promo@aarpdeals.example.com", noUnsub, passAuth, new Set(),
    "· · · · JoinAARP · · · ·",
    "25% off AARP membership for you"
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["padding_evasion"]);
});

test("flags subject with dot padding when display name is clean", () => {
  const result = classifyMessage(
    "alerts@prioritygold.example.com", noUnsub, passAuth, new Set(),
    "PriorityGoldAlerts",
    "· · · · Protect Your 401(k) With Gold & Silver · · · ·"
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["padding_evasion"]);
});

test("padding evasion short-circuits before list_unsubscribe", () => {
  const result = classifyMessage(
    "promo@aarpdeals.example.com",
    { mailto: null, http: "https://aarpdeals.example.com/unsub" },
    passAuth, new Set(),
    "· · · · JoinAARP · · · ·", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["padding_evasion"]);
});

test("does not flag apostrophe in display name", () => {
  const result = classifyMessage(
    "obrien@company.com", noUnsub, passAuth, new Set(["company.com"]),
    "O'Brien", "Re: Fwd: quarterly report"
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag comma and hyphen in display name and subject", () => {
  const result = classifyMessage(
    "jsmith@company.com", noUnsub, passAuth, new Set(["company.com"]),
    "Smith, John", "50% OFF - Ends Friday!"
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag ampersand in display name", () => {
  const result = classifyMessage(
    "hello@jj.example.com", noUnsub, passAuth, new Set(["jj.example.com"]),
    "Johnson & Johnson", "Invoice #1234"
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag trailing ellipsis as padding", () => {
  const result = classifyMessage(
    "hello@company.com", noUnsub, passAuth, new Set(["company.com"]),
    "Company Updates", "Wait for it..."
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

// --- List-Unsubscribe present ---

test("flags legit newsletter because of List-Unsubscribe header", () => {
  const result = classifyMessage(
    "newsletter@somebrand.com",
    { mailto: null, http: "https://somebrand.com/unsub" },
    passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["list_unsubscribe_present"]);
});

// --- suspicious TLD ---

test("flags suspicious TLD", () => {
  const result = classifyMessage(
    "info@somejunkbrand.info", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["suspicious_tld"]);
});

// --- default-deny fallback: unverified domain ---

test("flags unverified domain with otherwise clean signals", () => {
  const result = classifyMessage(
    "hello@totallyrandomcompany.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["unverified_domain"]);
});

test("does not flag domain in user allowlist", () => {
  const result = classifyMessage(
    "hello@knowncompany.com", noUnsub, passAuth, new Set(["knowncompany.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag subdomain of allowlisted root domain", () => {
  const result = classifyMessage(
    "noreply@alerts.chase.com", noUnsub, passAuth, new Set(["chase.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag sibling domain sharing a suffix", () => {
  const result = classifyMessage(
    "hello@notchase.com", noUnsub, passAuth, new Set(["chase.com"]), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["unverified_domain"]);
});

// --- built-in KNOWN_BRAND_DOMAINS ---

test("known brand domain passes even with empty user allowlist", () => {
  const verified = new Set([...new Set(), ...KNOWN_BRAND_DOMAINS]);
  const result = classifyMessage(
    "orders@amazon.com", noUnsub, passAuth, verified, "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

// --- allowlist overrides every other rule ---

test("allowlisted domain is never flagged", () => {
  const result = classifyMessage(
    "rnk4wxc@t4r.plasticcars.com", noUnsub, noAuth,
    new Set(["t4r.plasticcars.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("allowlisted exact address is never flagged", () => {
  const result = classifyMessage(
    "newsletter@somebrand.com",
    { mailto: null, http: "https://somebrand.com/unsub" },
    passAuth, new Set(["newsletter@somebrand.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test`
Expected: FAIL — `src/classify.js` does not exist yet.

- [ ] **Step 3: Write `src/classify.js`**

```javascript
const SUSPICIOUS_TLDS = new Set(["info", "xyz", "top", "click", "buzz", "work"]);
const SYMBOL_TOKEN_RE = /^([^\w\s])\1*$/;

// Starter set of major, unambiguously-real brand root domains — merged
// into the caller-supplied allowlist (see aggregate.js) so users get
// broad legitimate coverage without hand-typing every known company.
// Matched suffix-aware via isVerifiedDomain, so a subdomain like
// "alerts.chase.com" is covered by the "chase.com" entry automatically.
export const KNOWN_BRAND_DOMAINS = new Set([
  // retail / marketplaces
  "amazon.com", "walmart.com", "target.com", "costco.com", "samsclub.com",
  "bestbuy.com", "homedepot.com", "lowes.com", "ikea.com", "etsy.com",
  "ebay.com", "wayfair.com", "kohls.com", "macys.com", "nordstrom.com",
  "gap.com", "oldnavy.com", "nike.com", "adidas.com", "cvs.com",
  "walgreens.com", "staples.com", "officedepot.com",
  // banks / finance / insurance
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com",
  "capitalone.com", "americanexpress.com", "discover.com", "usbank.com",
  "ally.com", "fidelity.com", "vanguard.com", "schwab.com", "paypal.com",
  "venmo.com", "amfam.com", "statefarm.com", "geico.com", "progressive.com",
  "allstate.com", "intuit.com", "turbotax.com", "creditkarma.com",
  "experian.com", "equifax.com", "transunion.com",
  // tech / services
  "google.com", "gmail.com", "microsoft.com", "apple.com", "icloud.com",
  "yahoo.com", "spotify.com", "netflix.com", "hulu.com", "disneyplus.com",
  "openai.com", "chatgpt.com", "adobe.com", "dropbox.com", "zoom.us",
  "slack.com", "linkedin.com", "facebook.com", "instagram.com",
  "twitter.com", "x.com", "reddit.com", "pinterest.com", "tiktok.com",
  "uber.com", "lyft.com", "doordash.com", "grubhub.com", "instacart.com",
  "airbnb.com", "steampowered.com", "xbox.com", "playstation.com",
  "nintendo.com", "github.com", "stackoverflow.com", "indeed.com",
  "glassdoor.com",
  // travel
  "delta.com", "united.com", "aa.com", "southwest.com", "expedia.com",
  "booking.com", "hotels.com", "marriott.com", "hilton.com",
  "choicehotels.com", "choiceprivileges.com", "alaskaair.com",
  // telecom / utilities
  "verizon.com", "att.com", "t-mobile.com", "comcast.com", "xfinity.com",
  "spectrum.com", "cox.com",
  // shipping / delivery
  "ups.com", "fedex.com", "usps.com", "dhl.com",
  // health
  "mychart.com", "cvshealth.com", "unitedhealthgroup.com", "anthem.com",
  "aetna.com", "cigna.com", "kaiserpermanente.org",
]);

/**
 * Layered sieve, coarsest net first: check nets in order and stop at the
 * first match (one reason per message). Default-deny: a message that
 * clears every specific net is flagged as "unverified_domain" unless its
 * domain (or exact address) is in `allowlist`. `allowlist` is expected to
 * already include KNOWN_BRAND_DOMAINS (merged once per scan by the
 * caller — see aggregate.js) plus the user's own curated entries.
 */
export function classifyMessage(sender, listUnsubscribe, authResults, allowlist, displayName, subject) {
  const domain = sender.split("@").pop();
  const localPart = sender.split("@")[0];

  if (domain === "gov" || domain.endsWith(".gov")) {
    return { flagged: false, reasons: [] };
  }

  if (allowlist.has(sender) || isVerifiedDomain(domain, allowlist)) {
    return { flagged: false, reasons: [] };
  }

  if (authFailedOrMissing(authResults)) {
    return { flagged: true, reasons: ["auth_failed_or_missing"] };
  }

  if (isSuspiciousLocalPart(localPart)) {
    return { flagged: true, reasons: ["suspicious_local_part"] };
  }

  if (hasPaddingEvasion(displayName) || hasPaddingEvasion(subject)) {
    return { flagged: true, reasons: ["padding_evasion"] };
  }

  if (listUnsubscribe.mailto || listUnsubscribe.http) {
    return { flagged: true, reasons: ["list_unsubscribe_present"] };
  }

  if (isSuspiciousTld(domain)) {
    return { flagged: true, reasons: ["suspicious_tld"] };
  }

  return { flagged: true, reasons: ["unverified_domain"] };
}

function* domainSuffixes(domain) {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length; i++) {
    yield labels.slice(i).join(".");
  }
}

export function isVerifiedDomain(domain, verified) {
  for (const suffix of domainSuffixes(domain)) {
    if (verified.has(suffix)) return true;
  }
  return false;
}

function authFailedOrMissing(authResults) {
  return !["spf", "dkim", "dmarc"].some((k) => authResults[k] === "pass");
}

function isSuspiciousLocalPart(localPart) {
  return hasLowVowelRatioWithDigits(localPart) || hasLongConsonantRun(localPart);
}

function hasLowVowelRatioWithDigits(localPart) {
  const letters = [...localPart].filter((c) => /[a-zA-Z]/.test(c));
  const digits = [...localPart].filter((c) => /[0-9]/.test(c));
  if (localPart.length < 5 || localPart.length > 20) return false;
  if (letters.length === 0 || digits.length === 0) return false;
  const vowels = letters.filter((c) => "aeiou".includes(c.toLowerCase())).length;
  return vowels / letters.length < 0.2;
}

function hasLongConsonantRun(localPart, threshold = 5) {
  let run = 0;
  let best = 0;
  for (const c of localPart.toLowerCase()) {
    if (/[a-z]/.test(c) && !"aeiou".includes(c)) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best >= threshold;
}

function isSuspiciousTld(domain) {
  const tld = domain.includes(".") ? domain.split(".").pop().toLowerCase() : domain.toLowerCase();
  return SUSPICIOUS_TLDS.has(tld);
}

function isSymbolToken(token) {
  return SYMBOL_TOKEN_RE.test(token);
}

function hasPaddingEvasion(text, minRun = 3) {
  if (!text || !text.trim()) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < minRun) return false;

  let leadingRun = 0;
  for (const tok of tokens) {
    if (isSymbolToken(tok)) leadingRun += 1;
    else break;
  }
  if (leadingRun >= minRun) return true;

  let trailingRun = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isSymbolToken(tokens[i])) trailingRun += 1;
    else break;
  }
  return trailingRun >= minRun;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all 22 tests in `test/classify.test.js` green, plus the 15 from Task 2 (37 total).

- [ ] **Step 5: Commit**

```bash
git add src/classify.js test/classify.test.js
git commit -m "Add classify.js: port the default-deny domain-trust classifier"
```

---

### Task 4: `aggregate.js` — message classification orchestration + domain aggregation, ported from `report.py`

**Files:**
- Create: `src/aggregate.js`
- Test: `test/aggregate.test.js`

**Interfaces:**
- Consumes:
  - From `src/headers.js` (Task 2): `parseListUnsubscribe`, `hasOneClickUnsubscribe`, `parseAuthenticationResults`, `decodeMimeWords`.
  - From `src/classify.js` (Task 3): `classifyMessage`, `KNOWN_BRAND_DOMAINS`.
- Produces (used by Task 7's `background.js`):
  - `extractAddress(fromHeader: string): string`
  - `extractDisplayName(fromHeader: string): string`
  - `classifyMessages(rawMessages: Array<{id, from, subject, listUnsubscribe, listUnsubscribePost, authenticationResults}>, allowlist: Set<string>): Array<ClassifiedMessage>`
  - `aggregateByDomain(classified: Array<ClassifiedMessage>): Record<string, {count: number, reasons: string[], messages: Array}>`
  - Input shape note: `rawMessages` items use `id` (Gmail's message ID) instead of the CLI's IMAP `uid` — this is the field Task 6's Gmail-response adapter produces.

- [ ] **Step 1: Write the failing test file**

Create `test/aggregate.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAddress, extractDisplayName, classifyMessages, aggregateByDomain } from "../src/aggregate.js";

test("extractAddress pulls bare address out of 'Name <addr>' format", () => {
  assert.equal(extractAddress("Some Sender <hello@example.com>"), "hello@example.com");
});

test("extractAddress handles a bare address with no display name", () => {
  assert.equal(extractAddress("hello@example.com"), "hello@example.com");
});

test("extractDisplayName pulls the name out of 'Name <addr>' format", () => {
  assert.equal(extractDisplayName('"Some Sender" <hello@example.com>'), "Some Sender");
});

test("extractDisplayName returns empty string for a bare address", () => {
  assert.equal(extractDisplayName("hello@example.com"), "");
});

test("classifyMessages flags an unverified domain and aggregates by domain", () => {
  const rawMessages = [
    { id: "1", from: "Someone <hello@totallyrandomcompany.com>", subject: "Hi", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
    { id: "2", from: "trusted@knowncompany.com", subject: "Order confirmed", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
  ];
  const classified = classifyMessages(rawMessages, new Set(["knowncompany.com"]));

  assert.equal(classified.length, 2);
  assert.equal(classified[0].flagged, true);
  assert.deepEqual(classified[0].reasons, ["unverified_domain"]);
  assert.equal(classified[0].domain, "totallyrandomcompany.com");
  assert.equal(classified[1].flagged, false);

  const aggregated = aggregateByDomain(classified);
  assert.deepEqual(Object.keys(aggregated), ["totallyrandomcompany.com"]);
  assert.equal(aggregated["totallyrandomcompany.com"].count, 1);
  assert.deepEqual(aggregated["totallyrandomcompany.com"].reasons, ["unverified_domain"]);
  assert.equal(aggregated["totallyrandomcompany.com"].messages[0].id, "1");
});

test("classifyMessages merges KNOWN_BRAND_DOMAINS automatically", () => {
  const rawMessages = [
    { id: "1", from: "orders@amazon.com", subject: "Your order", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
  ];
  const classified = classifyMessages(rawMessages, new Set());
  assert.equal(classified[0].flagged, false);
});

test("aggregateByDomain excludes non-flagged messages entirely", () => {
  const rawMessages = [
    { id: "1", from: "trusted@knowncompany.com", subject: "Hi", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
  ];
  const classified = classifyMessages(rawMessages, new Set(["knowncompany.com"]));
  const aggregated = aggregateByDomain(classified);
  assert.deepEqual(aggregated, {});
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test`
Expected: FAIL — `src/aggregate.js` does not exist yet.

- [ ] **Step 3: Write `src/aggregate.js`**

```javascript
import { parseListUnsubscribe, hasOneClickUnsubscribe, parseAuthenticationResults, decodeMimeWords } from "./headers.js";
import { classifyMessage, KNOWN_BRAND_DOMAINS } from "./classify.js";

export function extractAddress(fromHeader) {
  if (fromHeader.includes("<") && fromHeader.includes(">")) {
    return fromHeader.split("<")[1].split(">")[0].trim().toLowerCase();
  }
  return fromHeader.trim().toLowerCase();
}

export function extractDisplayName(fromHeader) {
  const decoded = decodeMimeWords(fromHeader);
  if (decoded.includes("<") && decoded.includes(">")) {
    return decoded.split("<")[0].trim().replace(/^"|"$/g, "");
  }
  return "";
}

export function classifyMessages(rawMessages, allowlist) {
  const verified = new Set([...allowlist, ...KNOWN_BRAND_DOMAINS]);
  const results = [];

  for (const raw of rawMessages) {
    const sender = extractAddress(raw.from || "");
    const displayName = extractDisplayName(raw.from || "");
    const subject = decodeMimeWords(raw.subject || "");
    const listUnsubscribe = parseListUnsubscribe(raw.listUnsubscribe);
    const oneClick = hasOneClickUnsubscribe(raw.listUnsubscribePost);
    const authResults = parseAuthenticationResults(raw.authenticationResults);
    const verdict = classifyMessage(sender, listUnsubscribe, authResults, verified, displayName, subject);

    results.push({
      id: raw.id,
      sender,
      domain: sender.includes("@") ? sender.split("@").pop() : sender,
      displayName,
      subject,
      flagged: verdict.flagged,
      reasons: verdict.reasons,
      listUnsubscribe,
      oneClick,
    });
  }

  return results;
}

export function aggregateByDomain(classified) {
  const domains = {};

  for (const item of classified) {
    if (!item.flagged) continue;
    if (!domains[item.domain]) {
      domains[item.domain] = { count: 0, reasons: new Set(), messages: [] };
    }
    const entry = domains[item.domain];
    entry.count += 1;
    for (const r of item.reasons) entry.reasons.add(r);
    entry.messages.push({
      id: item.id,
      sender: item.sender,
      reasons: item.reasons,
      listUnsubscribe: item.listUnsubscribe,
      oneClick: item.oneClick,
    });
  }

  const aggregated = {};
  for (const [domain, d] of Object.entries(domains)) {
    aggregated[domain] = {
      count: d.count,
      reasons: [...d.reasons].sort(),
      messages: d.messages,
    };
  }
  return aggregated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests across `test/headers.test.js`, `test/classify.test.js`, and `test/aggregate.test.js` green.

- [ ] **Step 5: Commit**

```bash
git add src/aggregate.js test/aggregate.test.js
git commit -m "Add aggregate.js: port message classification orchestration and domain aggregation"
```

---

### Task 5: Extension shell — `manifest.json` + Google Cloud OAuth setup

**Files:**
- Create: `manifest.json`
- Create: `src/background.js` (minimal stub for this task — full implementation in Task 7)
- Modify: `README.md` (add the OAuth setup steps)

**Interfaces:**
- Consumes: nothing yet (Task 7 fills in the real background worker logic).
- Produces: a loadable, valid Manifest V3 extension with an assigned extension ID, and a configured Google Cloud OAuth client — both required before Task 6/7's Gmail API calls can be tested.

This task is mostly manual (Google Cloud Console is a UI you interact with directly, not something scriptable) — the steps below are exact, not placeholders.

- [ ] **Step 1: Write a minimal `manifest.json` without the OAuth block yet**

```json
{
  "manifest_version": 3,
  "name": "Mail Cleaner",
  "version": "0.1.0",
  "description": "Flags and cleans up untrusted senders in your Gmail inbox.",
  "permissions": ["identity", "storage"],
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

- [ ] **Step 2: Write a minimal `src/background.js` stub so the manifest is loadable**

```javascript
console.log("Mail Cleaner background service worker loaded.");
```

- [ ] **Step 3: Load the extension unpacked and note its assigned ID**

Go to `chrome://extensions`, enable "Developer mode" (top-right toggle),
click "Load unpacked", select this project's root directory. Chrome
assigns a 32-character extension ID (shown under the extension's name,
e.g. `abcdefghijklmnopqrstuvwxyzabcdef`). Copy it — it's needed in the
next step.

- [ ] **Step 4: Create a Google Cloud project and OAuth client**

1. Go to `console.cloud.google.com`, create a new project (any name,
   e.g. "Mail Cleaner Extension").
2. In the left sidebar: "APIs & Services" → "Library" — search for
   "Gmail API" and click "Enable".
3. "APIs & Services" → "OAuth consent screen": choose "External" user
   type, fill in the required app name/support email fields, add the
   scopes `https://www.googleapis.com/auth/gmail.readonly`,
   `https://www.googleapis.com/auth/gmail.modify`, and
   `https://www.googleapis.com/auth/gmail.send`. Leave "Publishing
   status" as **Testing** (per spec NFR5 — no verification review).
   Under "Test users", add the Gmail address(es) you'll test with (up
   to 100).
4. "APIs & Services" → "Credentials" → "Create Credentials" → "OAuth
   client ID" → Application type: **Chrome Extension**. Paste the
   extension ID from Step 3 into the "Item ID" field. Create it, then
   copy the generated Client ID (ends in `.apps.googleusercontent.com`).

- [ ] **Step 5: Add the OAuth block to `manifest.json`**

Replace the file with the client ID from Step 4 filled in:

```json
{
  "manifest_version": 3,
  "name": "Mail Cleaner",
  "version": "0.1.0",
  "description": "Flags and cleans up untrusted senders in your Gmail inbox.",
  "permissions": ["identity", "storage"],
  "oauth2": {
    "client_id": "PASTE_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com",
    "scopes": [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send"
    ]
  },
  "background": {
    "service_worker": "src/background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

- [ ] **Step 6: Reload the extension and verify no manifest errors**

In `chrome://extensions`, click the reload icon on the extension's
card. Expected: no red error banner on the card; clicking "service
worker" under "Inspect views" opens DevTools and shows the "Mail
Cleaner background service worker loaded." console log.

- [ ] **Step 7: Update `README.md` with the OAuth setup steps**

Append a new section to `README.md`:

```markdown
## OAuth setup (one-time, per developer)

The Google Cloud OAuth client ID is tied to your specific extension ID,
which Chrome assigns when you load the extension unpacked — so you
need your own Google Cloud project, not a shared one. See Task 5 in
`docs/superpowers/plans/2026-09-19-v1-implementation.md` for exact
steps. Keep "Publishing status" on **Testing** — add your own Gmail
test account under "Test users" — no Google verification review is
needed for personal use.
```

- [ ] **Step 8: Commit**

```bash
git add manifest.json src/background.js README.md
git commit -m "Add extension manifest and OAuth setup instructions"
```

**Note:** `manifest.json` now contains a real OAuth client ID, which is
not a secret in the same sense as an API key (it's meant to be visible
in distributed extension code — Google's chrome-extension OAuth flow is
designed around this, unlike a typical server-side client secret), so
committing it to git is fine and expected for a Chrome extension.

---

### Task 6: `gmailAdapter.js` — pure Gmail-response-to-headers adapter

**Files:**
- Create: `src/gmailAdapter.js`
- Test: `test/gmailAdapter.test.js`

**Interfaces:**
- Consumes: nothing (pure module — no `fetch()`, no `chrome.*`).
- Produces (used by Task 7's `background.js`):
  - `extractHeaderValue(gmailHeaders: Array<{name, value}>, headerName: string): string|null`
  - `adaptGmailMessage(gmailMessage: {id, payload: {headers}}): {id, from, subject, listUnsubscribe, listUnsubscribePost, authenticationResults}` — produces exactly the shape `aggregate.js`'s `classifyMessages` (Task 4) expects.

This isolates the one piece of "translate Gmail's response shape into
our internal shape" that's actually pure and testable, separate from
the real network calls (which live in Task 7 and are verified
manually, per the spec's testing strategy).

- [ ] **Step 1: Write the failing test file**

Create `test/gmailAdapter.test.js`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHeaderValue, adaptGmailMessage } from "../src/gmailAdapter.js";

const sampleGmailMessage = {
  id: "18d4f2a1b2c3d4e5",
  payload: {
    headers: [
      { name: "From", value: "Some Sender <hello@example.com>" },
      { name: "Subject", value: "Weekly Digest" },
      { name: "List-Unsubscribe", value: "<https://example.com/unsub>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      { name: "Authentication-Results", value: "spf=pass dkim=pass dmarc=pass" },
    ],
  },
};

test("extractHeaderValue finds a header case-insensitively", () => {
  assert.equal(extractHeaderValue(sampleGmailMessage.payload.headers, "from"), "Some Sender <hello@example.com>");
  assert.equal(extractHeaderValue(sampleGmailMessage.payload.headers, "Subject"), "Weekly Digest");
});

test("extractHeaderValue returns null for a missing header", () => {
  assert.equal(extractHeaderValue(sampleGmailMessage.payload.headers, "X-Nonexistent"), null);
});

test("adaptGmailMessage produces the shape aggregate.js expects", () => {
  const adapted = adaptGmailMessage(sampleGmailMessage);
  assert.equal(adapted.id, "18d4f2a1b2c3d4e5");
  assert.equal(adapted.from, "Some Sender <hello@example.com>");
  assert.equal(adapted.subject, "Weekly Digest");
  assert.equal(adapted.listUnsubscribe, "<https://example.com/unsub>");
  assert.equal(adapted.listUnsubscribePost, "List-Unsubscribe=One-Click");
  assert.equal(adapted.authenticationResults, "spf=pass dkim=pass dmarc=pass");
});

test("adaptGmailMessage handles a message with no headers array gracefully", () => {
  const adapted = adaptGmailMessage({ id: "empty", payload: { headers: [] } });
  assert.equal(adapted.id, "empty");
  assert.equal(adapted.from, "");
  assert.equal(adapted.subject, "");
  assert.equal(adapted.listUnsubscribe, null);
  assert.equal(adapted.listUnsubscribePost, null);
  assert.equal(adapted.authenticationResults, null);
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test`
Expected: FAIL — `src/gmailAdapter.js` does not exist yet.

- [ ] **Step 3: Write `src/gmailAdapter.js`**

```javascript
export function extractHeaderValue(gmailHeaders, headerName) {
  const found = gmailHeaders.find((h) => h.name.toLowerCase() === headerName.toLowerCase());
  return found ? found.value : null;
}

export function adaptGmailMessage(gmailMessage) {
  const headers = gmailMessage.payload?.headers ?? [];
  return {
    id: gmailMessage.id,
    from: extractHeaderValue(headers, "From") ?? "",
    subject: extractHeaderValue(headers, "Subject") ?? "",
    listUnsubscribe: extractHeaderValue(headers, "List-Unsubscribe"),
    listUnsubscribePost: extractHeaderValue(headers, "List-Unsubscribe-Post"),
    authenticationResults: extractHeaderValue(headers, "Authentication-Results"),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests across every `test/*.test.js` file green.

- [ ] **Step 5: Commit**

```bash
git add src/gmailAdapter.js test/gmailAdapter.test.js
git commit -m "Add gmailAdapter.js: pure Gmail API response -> internal header shape adapter"
```

---

### Task 7: `background.js` — OAuth, Gmail API calls, scan/execute orchestration

**Files:**
- Modify: `src/background.js` (replace Task 5's stub with the real implementation)

**Interfaces:**
- Consumes:
  - From `src/gmailAdapter.js` (Task 6): `adaptGmailMessage`.
  - From `src/aggregate.js` (Task 4): `classifyMessages`, `aggregateByDomain`.
  - `chrome.identity.getAuthToken`, `chrome.storage.local`, `chrome.storage.sync`, `chrome.runtime.onMessage`.
- Produces (used by Task 8's popup and Task 9's review page, via `chrome.runtime.sendMessage`):
  - Message type `"SCAN"` → response `{ok: true, aggregated, scannedAt}` or `{ok: false, error}`.
  - Message type `"GET_CACHED_SCAN"` → response `{aggregated, scannedAt} | null`.
  - Message type `"TRUST_SENDER"` (payload `{domain}`) → adds to the `chrome.storage.sync` allowlist, response `{ok: true}`.
  - Message type `"EXECUTE"` (payload `{domains: string[]}`) → unsubscribes + trashes every message under the given domains from the cached scan, response `{ok: true, trashedCount, unsubscribedCount}` or `{ok: false, error}`.

This task is not unit tested (spec's testing strategy: Gmail-API-calling
code is exercised manually against a real account), so there's no
test-first step here — instead, each step ends with a concrete manual
check.

- [ ] **Step 1: Write the OAuth token helper**

Replace `src/background.js` with:

```javascript
import { adaptGmailMessage } from "./gmailAdapter.js";
import { classifyMessages, aggregateByDomain } from "./aggregate.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADER_NAMES = ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "Authentication-Results"];

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No token returned"));
        return;
      }
      resolve(token);
    });
  });
}

async function getToken() {
  try {
    return await getAuthToken(false);
  } catch {
    return await getAuthToken(true);
  }
}
```

Manual check: nothing runnable yet — this is a foundation for the next
steps. Skip to Step 2 before checking anything in the browser.

- [ ] **Step 2: Write the message-list and header-fetch functions**

Append to `src/background.js`:

```javascript
async function gmailFetch(token, path, options = {}) {
  const resp = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  if (!resp.ok) {
    throw new Error(`Gmail API error ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

async function listInboxMessageIds(token) {
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ maxResults: "500", labelIds: "INBOX" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmailFetch(token, `/messages?${params.toString()}`);
    for (const m of data.messages ?? []) ids.push(m.id);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

async function fetchMessageHeaders(token, id) {
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of HEADER_NAMES) params.append("metadataHeaders", h);
  const message = await gmailFetch(token, `/messages/${id}?${params.toString()}`);
  return adaptGmailMessage(message);
}

// Bounded concurrency — fetch several messages' headers in parallel
// without overwhelming the Gmail API's per-second quota.
async function fetchAllHeaders(token, ids, concurrency = 10) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < ids.length) {
      const i = index++;
      results[i] = await fetchMessageHeaders(token, ids[i]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
```

Manual check: still nothing runnable end-to-end — continue to Step 3.

- [ ] **Step 3: Write the scan orchestration + storage helpers, wire up the SCAN message handler**

Append to `src/background.js`:

```javascript
async function loadAllowlist() {
  const { allowlist } = await chrome.storage.sync.get("allowlist");
  return new Set(allowlist ?? []);
}

async function saveScanCache(aggregated) {
  await chrome.storage.local.set({
    scanCache: { aggregated, scannedAt: new Date().toISOString() },
  });
}

async function runScan() {
  const token = await getToken();
  const ids = await listInboxMessageIds(token);
  const rawMessages = await fetchAllHeaders(token, ids);
  const allowlist = await loadAllowlist();
  const classified = classifyMessages(rawMessages, allowlist);
  const aggregated = aggregateByDomain(classified);
  await saveScanCache(aggregated);
  return aggregated;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCAN") {
    runScan()
      .then((aggregated) => sendResponse({ ok: true, aggregated }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "GET_CACHED_SCAN") {
    chrome.storage.local.get("scanCache").then(({ scanCache }) => sendResponse(scanCache ?? null));
    return true;
  }
});
```

- [ ] **Step 4: Reload the extension and manually verify a real scan**

In `chrome://extensions`, reload the extension. Open the service
worker's DevTools console (via "Inspect views: service worker"), then
run this directly in that console to trigger a scan and see the OAuth
consent prompt:

```javascript
chrome.runtime.sendMessage({ type: "SCAN" }, console.log);
```

Expected: a Google OAuth consent popup appears (first time only —
confirms Task 5's OAuth client is wired correctly), then after
granting access, the console logs `{ok: true, aggregated: {...}}` with
real flagged domains from your test Gmail account.

- [ ] **Step 5: Write the TRUST_SENDER and EXECUTE message handlers**

Append to `src/background.js`:

```javascript
async function trustSender(domain) {
  const allowlist = await loadAllowlist();
  allowlist.add(domain);
  await chrome.storage.sync.set({ allowlist: [...allowlist] });
}

function buildUnsubscribeMimeMessage(toAddress) {
  const raw = [`To: ${toAddress}`, "Subject: unsubscribe", "", "Please unsubscribe me from this mailing list."].join("\r\n");
  const base64 = btoa(unescape(encodeURIComponent(raw)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function unsubscribeOne(token, message) {
  const { listUnsubscribe, oneClick } = message;
  if (listUnsubscribe.http) {
    try {
      const resp = await fetch(listUnsubscribe.http, { method: oneClick ? "POST" : "GET" });
      return { attempted: true, succeeded: resp.ok };
    } catch {
      // fall through to mailto if available
    }
  }
  if (listUnsubscribe.mailto) {
    try {
      await gmailFetch(token, "/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: buildUnsubscribeMimeMessage(listUnsubscribe.mailto) }),
      });
      return { attempted: true, succeeded: true };
    } catch {
      return { attempted: true, succeeded: false };
    }
  }
  return { attempted: false, succeeded: false };
}

async function trashMessage(token, id) {
  await gmailFetch(token, `/messages/${id}/trash`, { method: "POST" });
}

async function executeDomains(domains) {
  const token = await getToken();
  const { scanCache } = await chrome.storage.local.get("scanCache");
  if (!scanCache) throw new Error("No cached scan to execute against — run a scan first.");

  let trashedCount = 0;
  let unsubscribedCount = 0;

  for (const domain of domains) {
    const entry = scanCache.aggregated[domain];
    if (!entry) continue;
    for (const message of entry.messages) {
      const result = await unsubscribeOne(token, message);
      if (result.succeeded) unsubscribedCount += 1;
      await trashMessage(token, message.id);
      trashedCount += 1;
    }
  }

  return { trashedCount, unsubscribedCount };
}
```

- [ ] **Step 6: Wire TRUST_SENDER and EXECUTE into the message listener**

Modify the `chrome.runtime.onMessage.addListener` block from Step 3 to
add two more branches before the closing `});`:

```javascript
  if (message.type === "TRUST_SENDER") {
    trustSender(message.domain)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "EXECUTE") {
    executeDomains(message.domains)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
```

- [ ] **Step 7: Reload and manually verify TRUST_SENDER and EXECUTE**

In the service worker's DevTools console:

```javascript
chrome.runtime.sendMessage({ type: "TRUST_SENDER", domain: "example.com" }, console.log);
```

Expected: `{ok: true}`; confirm via
`chrome.storage.sync.get("allowlist", console.log)` that `"example.com"`
is now in the array.

For EXECUTE, pick a real flagged domain from your test account's scan
results (one you're comfortable actually cleaning up) and run:

```javascript
chrome.runtime.sendMessage({ type: "EXECUTE", domains: ["some-flagged-domain.com"] }, console.log);
```

Expected: `{ok: true, trashedCount, unsubscribedCount}`; confirm in the
real Gmail web UI that those messages are now in Trash, not the inbox,
and not permanently deleted.

- [ ] **Step 8: Commit**

```bash
git add src/background.js
git commit -m "Implement background.js: OAuth, Gmail API scan/execute orchestration"
```

---

### Task 8: `popup.html` / `popup.js` — the digest card UI

**Files:**
- Create: `popup.html`
- Create: `src/popup.js`

**Interfaces:**
- Consumes: sends `{type: "GET_CACHED_SCAN"}` and `{type: "SCAN"}` messages to `background.js` (Task 7).
- Produces: nothing consumed by later tasks — this is a leaf UI.

This renders the count-led digest card validated in the visual mockup
session earlier in the design process (junk count large, storage-
reclaimable badge underneath, one primary action button).

- [ ] **Step 1: Write `popup.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { width: 320px; font-family: system-ui, sans-serif; background: #111; color: #eee; margin: 0; padding: 20px; text-align: center; }
    .account { font-size: 12px; color: #999; margin-bottom: 4px; }
    .count { font-size: 36px; font-weight: 700; margin: 14px 0 4px; }
    .subtext { font-size: 12px; color: #999; margin-bottom: 14px; }
    .badge { display: inline-block; background: #1a1a1a; border-radius: 20px; padding: 6px 14px; font-size: 12px; color: #ccc; margin-bottom: 18px; }
    button { width: 100%; padding: 12px; font-size: 14px; border: none; border-radius: 6px; background: #4f7cff; color: white; cursor: pointer; }
    button:disabled { background: #333; cursor: default; }
    .footer { font-size: 11px; color: #999; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="account" id="account">Mail Cleaner</div>
  <div class="count" id="count">—</div>
  <div class="subtext" id="subtext">No scan yet</div>
  <div class="badge" id="badge" style="display:none"></div>
  <button id="scanButton">Scan my inbox</button>
  <div class="footer" id="lastScanned"></div>
  <script type="module" src="src/popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/popup.js`**

```javascript
const countEl = document.getElementById("count");
const subtextEl = document.getElementById("subtext");
const badgeEl = document.getElementById("badge");
const lastScannedEl = document.getElementById("lastScanned");
const scanButton = document.getElementById("scanButton");

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function estimateReclaimableMb(aggregated) {
  const totalMessages = Object.values(aggregated).reduce((sum, d) => sum + d.count, 0);
  // Rough estimate: ~50 KB/message average, matching typical marketing
  // email sizes — good enough for a directional badge, not a precise figure.
  return Math.round((totalMessages * 50) / 1024);
}

function render(aggregated, scannedAt) {
  const totalMessages = Object.values(aggregated).reduce((sum, d) => sum + d.count, 0);
  const senderCount = Object.keys(aggregated).length;

  countEl.textContent = totalMessages;
  subtextEl.textContent = `junk emails found across ${senderCount} senders`;

  if (totalMessages > 0) {
    badgeEl.style.display = "inline-block";
    badgeEl.textContent = `≈ ${estimateReclaimableMb(aggregated)} MB reclaimable`;
  } else {
    badgeEl.style.display = "none";
  }

  lastScannedEl.textContent = scannedAt ? `Last scanned ${new Date(scannedAt).toLocaleString()}` : "";
  scanButton.textContent = totalMessages > 0 ? "Review & clean" : "Scan my inbox";
}

async function loadCached() {
  const cached = await sendMessage({ type: "GET_CACHED_SCAN" });
  if (cached) render(cached.aggregated, cached.scannedAt);
}

scanButton.addEventListener("click", async () => {
  const hasCached = countEl.textContent !== "—" && countEl.textContent !== "0";
  if (hasCached) {
    chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
    return;
  }
  scanButton.disabled = true;
  scanButton.textContent = "Scanning...";
  const result = await sendMessage({ type: "SCAN" });
  scanButton.disabled = false;
  if (result.ok) {
    render(result.aggregated, new Date().toISOString());
  } else {
    subtextEl.textContent = `Scan failed: ${result.error}`;
  }
});

loadCached();
```

- [ ] **Step 3: Reload the extension and manually verify the popup**

In `chrome://extensions`, reload the extension, then click its toolbar
icon. Expected: the digest card renders (per the approved mockup —
count-led, storage badge underneath); clicking "Scan my inbox" triggers
a real scan (may prompt OAuth consent again if the token expired) and
updates the count; clicking again once a count exists opens
`review.html` in a new tab (blank/404 is expected until Task 9).

- [ ] **Step 4: Commit**

```bash
git add popup.html src/popup.js
git commit -m "Add popup.html/popup.js: digest card UI"
```

---

### Task 9: `review.html` / `review.js` — per-domain checklist, confirm + trust actions

**Files:**
- Create: `review.html`
- Create: `src/review.js`
- Modify: `manifest.json` (add `review.html` as a web-accessible resource is not required since it's opened via `chrome.tabs.create` with `chrome.runtime.getURL`, which works for any extension-bundled page by default — no manifest change needed; this step intentionally does not modify `manifest.json`, noted here so it isn't mistaken for a missed step)

**Interfaces:**
- Consumes: sends `{type: "GET_CACHED_SCAN"}`, `{type: "TRUST_SENDER", domain}`, and `{type: "EXECUTE", domains}` messages to `background.js` (Task 7).
- Produces: nothing consumed by later tasks — this is a leaf UI.

- [ ] **Step 1: Write `review.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: system-ui, sans-serif; background: #111; color: #eee; max-width: 640px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 18px; }
    .row { display: flex; align-items: center; padding: 10px 0; border-bottom: 1px solid #333; }
    .row .info { flex: 1; }
    .domain { font-size: 14px; font-weight: 600; }
    .meta { font-size: 12px; color: #999; }
    .trust { font-size: 12px; color: #4f7cff; cursor: pointer; background: none; border: none; }
    .confirm-bar { position: sticky; bottom: 0; background: #111; padding: 16px 0; }
    button.primary { padding: 12px 20px; font-size: 14px; border: none; border-radius: 6px; background: #4f7cff; color: white; cursor: pointer; }
    button.primary:disabled { background: #333; }
    #status { font-size: 13px; color: #999; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>Review flagged senders</h1>
  <div id="list"></div>
  <div class="confirm-bar">
    <button class="primary" id="confirmButton">Clean selected</button>
    <div id="status"></div>
  </div>
  <script type="module" src="src/review.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/review.js`**

```javascript
const listEl = document.getElementById("list");
const confirmButton = document.getElementById("confirmButton");
const statusEl = document.getElementById("status");

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function renderRow(domain, entry) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.domain = domain;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.style.marginRight = "10px";

  const info = document.createElement("div");
  info.className = "info";
  info.innerHTML = `<div class="domain">${domain}</div><div class="meta">${entry.count} messages · ${entry.reasons.join(", ")}</div>`;

  const trustButton = document.createElement("button");
  trustButton.className = "trust";
  trustButton.textContent = "Trust";
  trustButton.addEventListener("click", async () => {
    await sendMessage({ type: "TRUST_SENDER", domain });
    row.remove();
  });

  row.append(checkbox, info, trustButton);
  return row;
}

async function load() {
  const cached = await sendMessage({ type: "GET_CACHED_SCAN" });
  if (!cached) {
    listEl.textContent = "No scan results yet.";
    return;
  }
  for (const [domain, entry] of Object.entries(cached.aggregated)) {
    listEl.appendChild(renderRow(domain, entry));
  }
}

confirmButton.addEventListener("click", async () => {
  const checkedDomains = [...listEl.querySelectorAll(".row")]
    .filter((row) => row.querySelector("input[type=checkbox]").checked)
    .map((row) => row.dataset.domain);

  if (checkedDomains.length === 0) {
    statusEl.textContent = "Nothing selected.";
    return;
  }

  confirmButton.disabled = true;
  statusEl.textContent = "Cleaning...";
  const result = await sendMessage({ type: "EXECUTE", domains: checkedDomains });
  confirmButton.disabled = false;

  if (result.ok) {
    statusEl.textContent = `Done — ${result.trashedCount} messages moved to Trash, ${result.unsubscribedCount} unsubscribed.`;
    for (const domain of checkedDomains) {
      document.querySelector(`.row[data-domain="${domain}"]`)?.remove();
    }
  } else {
    statusEl.textContent = `Failed: ${result.error}`;
  }
});

load();
```

- [ ] **Step 3: Reload the extension and manually verify the review flow end to end**

Reload in `chrome://extensions`, open the popup, scan (or use a cached
scan), open the review tab. Expected: every flagged domain from the
scan appears as a row with a checkbox (checked by default), count, and
reasons; clicking "Trust" on a row removes it from the list
immediately; unchecking a row and clicking "Clean selected" only acts
on the still-checked rows; after confirming, the status line reports
real trashed/unsubscribed counts and those rows disappear.

- [ ] **Step 4: Commit**

```bash
git add review.html src/review.js
git commit -m "Add review.html/review.js: per-domain checklist with trust and execute actions"
```

---

### Task 10: End-to-end verification against the spec

**Files:** none created or modified — this task verifies the spec's
"Verification" section directly against the finished extension.

**Interfaces:** none — this is a manual QA pass, not new code.

- [ ] **Step 1: Run the full automated test suite one more time**

Run: `npm test`
Expected: PASS — every test across `test/headers.test.js`,
`test/classify.test.js`, `test/aggregate.test.js`,
`test/gmailAdapter.test.js` green (this is the CI-equivalent gate; no
extension-runtime code is covered here, by design).

- [ ] **Step 2: Verify OAuth works without triggering Google's verification review**

Confirm the Google Cloud OAuth consent screen (from Task 5) is still
in "Testing" publishing status, and that only test-user Gmail accounts
can complete the consent flow — this confirms spec NFR5 is satisfied
(no public app review needed for personal/invited use).

- [ ] **Step 3: Verify the popup digest matches a manual count from the review page**

Open the review page, manually sum the `count` shown per row, and
confirm it matches the popup's headline number exactly.

- [ ] **Step 4: Verify "Trust this sender" persists across a fresh scan**

Trust a domain from the review page, then trigger a brand-new scan
(popup → "Scan my inbox" again). Confirm that domain no longer appears
anywhere in the new scan's flagged results — proving the
`chrome.storage.sync` allowlist write from Task 7 actually feeds back
into classification on the next scan, not just the current session.

- [ ] **Step 5: Verify a full review-to-execute cycle is safe and reversible**

Pick a small, real flagged domain, confirm the clean action, then in
Gmail's own web UI check its Trash folder — confirm the messages are
there (not permanently gone), and confirm the inbox no longer shows
them. This matches spec NFR3 directly.

- [ ] **Step 6: Verify unsubscribe attempts actually fire**

For a domain whose messages carry a `List-Unsubscribe` header, check
the service worker's DevTools console during execute (no explicit
logging was added in Task 7 — if you want to confirm requests are
firing, temporarily add `console.log` inside `unsubscribeOne` before
this check, then remove it afterward) or check the sending domain's
own confirmation email/page if one exists.

- [ ] **Step 7: Commit any final fixes found during verification**

If any of the above steps surfaced a real bug, fix it, re-run
`npm test`, and commit with a message describing what was wrong and
why — following the same fix-verify-commit discipline as every prior
task, not a bundled "final fixes" catch-all commit.
