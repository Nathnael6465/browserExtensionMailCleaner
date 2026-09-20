import { adaptGmailMessage } from "./gmailAdapter.js";
import { classifyMessages, aggregateByDomain } from "./aggregate.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADER_NAMES = ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "Authentication-Results"];

// A side panel stays open across tab switches (unlike the ephemeral
// popup this replaced), so clicking the toolbar icon opens it instead
// of a popup — no "default_popup" is set in manifest.json anymore.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[MailCleaner] setPanelBehavior failed:", error));

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

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Silent token request timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function getToken() {
  try {
    // chrome.identity.getAuthToken({interactive: false}) can hang
    // indefinitely (never call back at all) instead of rejecting when no
    // silent grant is available — bound it so a stuck silent check always
    // falls through to the interactive flow rather than hanging the scan.
    return await withTimeout(getAuthToken(false), 5000);
  } catch {
    return await getAuthToken(true);
  }
}

function isRateLimitError(status, bodyText) {
  if (status === 429) return true;
  return status === 403 && /rateLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(bodyText);
}

// Gmail's per-user quota is 6000 units/minute, and users.messages.get
// costs 20 units/call — a sustainable rate of ~300 calls/min (5/sec).
// Firing the bounded-concurrency worker pool (10 workers) as fast as
// possible blows through that budget in well under a second, so every
// request ends up rate-limited rather than an occasional burst. Pace
// every Gmail API call (list and get both draw from the same
// per-user budget) through a shared minimum interval so we stay
// under quota proactively instead of relying on backoff to recover
// after the fact. 300ms ≈ 3.3 req/sec, comfortably under the ~5/sec
// ceiling to leave headroom for messages.list's own cost.
let nextAllowedRequestTime = 0;
function paceRequest() {
  const minIntervalMs = 300;
  const now = Date.now();
  const wait = Math.max(0, nextAllowedRequestTime - now);
  nextAllowedRequestTime = Math.max(now, nextAllowedRequestTime) + minIntervalMs;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

// Backoff is still needed as a safety net (other tabs/tools sharing
// the same quota, a burst right at a window boundary), just no longer
// the primary defense against exceeding it.
async function gmailFetch(token, path, options = {}) {
  const maxRetries = 8;
  const maxDelay = 60000;
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    await paceRequest();
    const resp = await fetch(`${GMAIL_API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if (resp.ok) return resp.json();

    const bodyText = await resp.text();
    if (!isRateLimitError(resp.status, bodyText) || attempt >= maxRetries) {
      throw new Error(`Gmail API error ${resp.status}: ${bodyText}`);
    }
    const jittered = Math.round(delay * (0.5 + Math.random()));
    console.log(`[MailCleaner] rate limited, retrying in ${jittered}ms (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((resolve) => setTimeout(resolve, jittered));
    delay = Math.min(delay * 2, maxDelay);
  }
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

// The popup closes the instant it loses focus (standard, unavoidable
// Chrome behavior for every extension popup), so it can't show live
// progress on its own for a scan that runs for tens of minutes. The
// toolbar badge is the one UI surface Chrome keeps visible regardless
// of whether the popup is open — use it to show how far along a scan
// is. Badge text is only ~4 characters wide before Chrome starts
// clipping it, so large counts get abbreviated (e.g. 9411 -> "9.4k").
function formatBadgeCount(n) {
  if (n < 1000) return String(n);
  return `${Math.floor(n / 100) / 10}k`;
}

function setBadgeProgress(done, total) {
  chrome.action.setBadgeBackgroundColor({ color: "#4f7cff" });
  chrome.action.setBadgeText({ text: `${formatBadgeCount(done)}/${formatBadgeCount(total)}` });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

// Bounded concurrency — fetch several messages' headers in parallel
// without overwhelming the Gmail API's per-second quota.
async function fetchAllHeaders(token, ids, concurrency = 10) {
  const results = [];
  let index = 0;
  let done = 0;
  async function worker() {
    while (index < ids.length) {
      const i = index++;
      results[i] = await fetchMessageHeaders(token, ids[i]);
      done += 1;
      if (done % 20 === 0 || done === ids.length) {
        setBadgeProgress(done, ids.length);
      }
      if (done % 200 === 0 || done === ids.length) {
        console.log(`[MailCleaner] fetched headers for ${done}/${ids.length} messages`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function loadAllowlist() {
  const { allowlist } = await chrome.storage.sync.get("allowlist");
  return new Set(allowlist ?? []);
}

async function saveScanCache(aggregated, scannedAt) {
  await chrome.storage.local.set({
    scanCache: { aggregated, scannedAt },
  });
}

async function runScan() {
  console.log("[MailCleaner] scan starting, requesting token...");
  const token = await getToken();
  console.log("[MailCleaner] got token, listing inbox message ids...");
  const ids = await listInboxMessageIds(token);
  console.log(`[MailCleaner] found ${ids.length} inbox messages, fetching headers...`);
  const rawMessages = await fetchAllHeaders(token, ids);
  const allowlist = await loadAllowlist();
  const classified = classifyMessages(rawMessages, allowlist);
  const aggregated = aggregateByDomain(classified);
  const scannedAt = new Date().toISOString();
  await saveScanCache(aggregated, scannedAt);
  console.log("[MailCleaner] scan complete and cached.");
  return { aggregated, scannedAt };
}

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SCAN") {
    chrome.action.setBadgeBackgroundColor({ color: "#4f7cff" });
    chrome.action.setBadgeText({ text: "..." });
    runScan()
      .then(({ aggregated, scannedAt }) => {
        clearBadge();
        sendResponse({ ok: true, aggregated, scannedAt });
      })
      .catch((error) => {
        console.error("[MailCleaner] scan failed:", error);
        chrome.action.setBadgeBackgroundColor({ color: "#d64545" });
        chrome.action.setBadgeText({ text: "err" });
        sendResponse({ ok: false, error: error.message });
      });
    return true; // keep the message channel open for the async response
  }

  if (message.type === "GET_CACHED_SCAN") {
    chrome.storage.local.get("scanCache").then(({ scanCache }) => sendResponse(scanCache ?? null));
    return true;
  }

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
});
