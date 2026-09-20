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
  const token = await getToken();
  const ids = await listInboxMessageIds(token);
  const rawMessages = await fetchAllHeaders(token, ids);
  const allowlist = await loadAllowlist();
  const classified = classifyMessages(rawMessages, allowlist);
  const aggregated = aggregateByDomain(classified);
  const scannedAt = new Date().toISOString();
  await saveScanCache(aggregated, scannedAt);
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
    runScan()
      .then(({ aggregated, scannedAt }) => sendResponse({ ok: true, aggregated, scannedAt }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
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
