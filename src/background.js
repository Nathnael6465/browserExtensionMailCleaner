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

// Scans now run as a chain of short chunks woken by chrome.alarms
// (see runScan-related functions below), so the service worker
// restarting between chunks is NORMAL and happens every ~30s during
// any real scan — it must NOT be treated as "the scan died". Only
// reset progress when a scan is truly orphaned: scanState still says
// "fetching" but no "continueScan" alarm is scheduled to resume it
// (e.g. the extension was reloaded mid-scan, which does clear alarms).
(async () => {
  const [{ scanState }, alarm] = await Promise.all([
    chrome.storage.local.get("scanState"),
    chrome.alarms.get("continueScan"),
  ]);
  if (scanState?.phase === "fetching" && !alarm) {
    await chrome.storage.local.set({
      scanState: { phase: "idle" },
      scanProgress: { running: false, error: "Scan was interrupted and could not resume." },
    });
    clearBadge();
  }
})();

function setScanProgress(progress) {
  return chrome.storage.local.set({ scanProgress: progress });
}

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

// Gmail's own API guidance calls for exponential-backoff retry on 5xx
// responses (transient backend errors, not just quota) in addition to
// 429/403 rate limiting — a bare 500 "Unknown Error" is common on a
// large scan and previously wasn't retried at all, so it aborted the
// whole scan instead of recovering like a rate limit does.
function isRetryableError(status, bodyText) {
  if (status === 429) return true;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
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
//
// Manifest V3 service workers can be torn down after ~30s with no
// active network activity, and setTimeout does NOT keep a service
// worker alive on its own (this is documented Chrome behavior, not a
// guess) — a single backoff wait anywhere near that long risks the
// whole scan silently dying mid-wait with no error. This bit for real
// near the tail of a large scan: with only a few concurrent workers
// left and no other requests in flight to keep the worker "warm", a
// stray 60s wait got the worker killed and the scan just stopped,
// frozen, with nothing logged. Keep every individual wait well under
// that danger zone; more, shorter retries make up the difference.
async function gmailFetch(token, path, options = {}) {
  const maxRetries = 12;
  const maxDelay = 15000;
  let delay = 1000;
  for (let attempt = 0; ; attempt++) {
    await paceRequest();
    const resp = await fetch(`${GMAIL_API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if (resp.ok) return resp.json();

    const bodyText = await resp.text();
    if (!isRetryableError(resp.status, bodyText) || attempt >= maxRetries) {
      throw new Error(`Gmail API error ${resp.status}: ${bodyText}`);
    }
    const jittered = Math.round(delay * (0.5 + Math.random()));
    console.log(`[MailCleaner] retryable error ${resp.status}, retrying in ${jittered}ms (attempt ${attempt + 1}/${maxRetries})`);
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

async function loadAllowlist() {
  const { allowlist } = await chrome.storage.sync.get("allowlist");
  return new Set(allowlist ?? []);
}

async function saveScanCache(aggregated, scannedAt) {
  await chrome.storage.local.set({
    scanCache: { aggregated, scannedAt },
  });
}

// Manifest V3 service workers can be torn down after ~30s of no
// activity, and a scan over a large inbox can legitimately take
// 20-40+ minutes — far too long to run inside one continuous
// invocation regardless of how tightly individual waits are capped
// (tried and confirmed insufficient: capping gmailFetch's backoff
// delay still let the worker die near the tail of a real scan).
// chrome.alarms is the documented, durable way to run a long task in
// an MV3 worker: alarms persist independently of the worker's own
// lifetime, so each "continueScan" firing gets a fresh worker
// instance that reads where the last chunk left off (in
// chrome.storage.local) and picks up from there. A chunk processes
// for a fixed wall-clock budget, well under the alarm interval, then
// yields by scheduling the next alarm — so the worker is never asked
// to stay alive longer than one short chunk at a time.
const CHUNK_BUDGET_MS = 15000;
const ALARM_INTERVAL_MINUTES = 0.5; // 30s — Chrome's practical minimum for one-time alarms

async function startOrResumeScan() {
  let { scanState } = await chrome.storage.local.get("scanState");

  if (!scanState || scanState.phase !== "fetching") {
    console.log("[MailCleaner] scan starting, requesting token...");
    await setScanProgress({ running: true, done: 0, total: 0 });
    const token = await getToken();
    console.log("[MailCleaner] got token, listing inbox message ids...");
    const ids = await listInboxMessageIds(token);
    console.log(`[MailCleaner] found ${ids.length} inbox messages, fetching headers...`);
    scanState = { phase: "fetching", ids, nextIndex: 0, results: [] };
    await chrome.storage.local.set({ scanState });
    await setScanProgress({ running: true, done: 0, total: ids.length });
  }

  await processScanChunk();
}

async function processScanChunk() {
  const { scanState } = await chrome.storage.local.get("scanState");
  if (!scanState || scanState.phase !== "fetching") return;

  const token = await getToken();
  const { ids, results } = scanState;
  let { nextIndex } = scanState;
  const chunkStart = Date.now();

  while (nextIndex < ids.length && Date.now() - chunkStart < CHUNK_BUDGET_MS) {
    results.push(await fetchMessageHeaders(token, ids[nextIndex]));
    nextIndex += 1;
  }

  await chrome.storage.local.set({ scanState: { phase: "fetching", ids, nextIndex, results } });
  setBadgeProgress(nextIndex, ids.length);
  await setScanProgress({ running: true, done: nextIndex, total: ids.length });
  console.log(`[MailCleaner] fetched headers for ${nextIndex}/${ids.length} messages`);

  if (nextIndex < ids.length) {
    chrome.alarms.create("continueScan", { delayInMinutes: ALARM_INTERVAL_MINUTES });
  } else {
    await finishScan(results, ids.length);
  }
}

async function finishScan(rawMessages, total) {
  const allowlist = await loadAllowlist();
  const classified = classifyMessages(rawMessages, allowlist);
  const aggregated = aggregateByDomain(classified);
  const scannedAt = new Date().toISOString();
  await saveScanCache(aggregated, scannedAt);
  await chrome.storage.local.set({ scanState: { phase: "idle" } });
  await setScanProgress({ running: false, done: total, total });
  clearBadge();
  console.log("[MailCleaner] scan complete and cached.");
}

// A chunk failure after gmailFetch's own retries are exhausted (e.g. a
// persistent 500) used to reset scanState to idle unconditionally,
// which threw away every message already fetched and forced a full
// restart from message 0 on a scan that can take tens of minutes.
// Once ids/nextIndex/results exist in scanState (phase "fetching"),
// keep them — no further alarm fires, so the scan is now orphaned
// exactly like a reload-mid-scan, and the next "Scan" click's
// startOrResumeScan() picks up at the same nextIndex instead of
// re-listing and re-fetching everything.
async function handleScanChunkFailure(error) {
  console.error("[MailCleaner] scan chunk failed:", error);
  chrome.action.setBadgeBackgroundColor({ color: "#d64545" });
  chrome.action.setBadgeText({ text: "err" });
  const { scanState } = await chrome.storage.local.get("scanState");
  await setScanProgress({ running: false, error: error.message, resumable: scanState?.phase === "fetching" });
  if (scanState?.phase !== "fetching") {
    await chrome.storage.local.set({ scanState: { phase: "idle" } });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "continueScan") return;
  processScanChunk().catch(handleScanChunkFailure);
});

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
    // A scan now spans many separate alarm-triggered worker
    // invocations, so "already running" has to be checked against
    // persisted state, not an in-memory flag — the flag would reset
    // to false every time the worker restarts between chunks, which
    // happens by design roughly every 30s during a real scan.
    Promise.all([chrome.storage.local.get("scanState"), chrome.alarms.get("continueScan")]).then(
      ([{ scanState }, alarm]) => {
        if (scanState?.phase === "fetching" && alarm) {
          sendResponse({ ok: false, error: "A scan is already in progress." });
          return;
        }
        chrome.action.setBadgeBackgroundColor({ color: "#4f7cff" });
        chrome.action.setBadgeText({ text: "..." });
        startOrResumeScan()
          .then(() => sendResponse({ ok: true, started: true }))
          .catch((error) => {
            handleScanChunkFailure(error);
            sendResponse({ ok: false, error: error.message });
          });
      },
    );
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
