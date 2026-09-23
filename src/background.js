import { adaptGmailMessage } from "./gmailAdapter.js";
import { classifyMessages, aggregateByDomain } from "./aggregate.js";
import { parseMailtoUri } from "./headers.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const HEADER_NAMES = ["From", "Subject", "List-Unsubscribe", "List-Unsubscribe-Post", "Authentication-Results"];

// A side panel stays open across tab switches (unlike the ephemeral
// popup this replaced), so clicking the toolbar icon opens it instead
// of a popup — no "default_popup" is set in manifest.json anymore.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[MailCleaner] setPanelBehavior failed:", error));

// A scan/clean runs as a chain of short chunks woken by chrome.alarms, so
// the service worker restarting between chunks is NORMAL and happens
// routinely during any real run — it must NOT be treated as "it died".
//
// A previous version of this reconciler used "is a continueScan alarm
// currently scheduled" as its orphan signal. That was a real bug (caught
// in whole-branch review): a non-repeating alarm clears itself the
// instant it fires, so for the ENTIRE duration a chunk is executing,
// chrome.alarms.get() returns nothing — indistinguishable from "orphaned"
// to that check. Since this reconciler runs on every worker boot,
// including the boot an alarm firing itself causes, it raced the very
// chunk it was meant to protect and could wipe live progress mid-chunk.
//
// Fixed by making orphan detection time-based instead: scanState/
// executeState carry an `updatedAt` timestamp refreshed on every
// progress flush (at least every FLUSH_INTERVAL_MS during real work).
// Only treat a run as orphaned if it's been stale for multiple chunk
// cycles' worth of time — long enough that "just between chunks" is not
// a plausible explanation anymore.
const STALE_THRESHOLD_MS = 3 * 60 * 1000;

function isFresh(state) {
  return Boolean(state?.updatedAt) && Date.now() - state.updatedAt < STALE_THRESHOLD_MS;
}

// A scoped re-review of the first version of this reconciler caught two
// real bugs, both now fixed here:
//
// (1) It wrote {phase: "idle"} on a stale run, discarding the resumable
// payload (ids/nextIndex/results, or queue/counters/domains) that
// handleScanChunkFailure/handleExecuteChunkFailure had deliberately
// preserved for exactly this situation. A panel reopened 3+ minutes
// after a chunk failure would have the worker boot, see the run as
// stale, and delete tens of minutes of already-fetched progress that
// was sitting there waiting to be resumed. Fixed: only ever touch the
// progress flag here, never the state payload — state stays fully
// intact and resumable regardless of what this reconciler decides.
//
// (2) On a boot caused by a delayed alarm (machine slept, Chrome
// restarted — alarms persist and fire late), this reconciler and the
// onAlarm-triggered chunk processor both ran unordered against the same
// storage keys, an unserialized race on the exact keys this reconciler
// exists to protect. Fixed: both onAlarm handlers below now await this
// promise before their first storage read, so reconciliation always
// completes first — deterministic ordering instead of a race.
async function reconcileRunState(stateKey, progressKey, activePhase, interruptedMessage) {
  const stored = await chrome.storage.local.get([stateKey, progressKey]);
  const state = stored[stateKey];
  const progress = stored[progressKey];

  if (state?.phase === activePhase && !isFresh(state)) {
    await chrome.storage.local.set({ [progressKey]: { running: false, error: interruptedMessage } });
    if (stateKey === "scanState") clearBadge(); // the badge only ever reflects scan progress
  } else if (state?.phase !== activePhase && progress?.running) {
    // progress claims something is running but state doesn't back that up
    // at all — drift with no legitimate in-flight run behind it.
    await chrome.storage.local.set({ [progressKey]: { running: false } });
    if (stateKey === "scanState") clearBadge();
  }
}

// The panel's init() sends a PING before trusting any stored progress, so
// the worker boots (if it wasn't already running) and this reconciliation
// completes before the panel reads storage — otherwise a panel reopened
// while scanProgress.running is stuck stale (e.g. the worker died between
// chunks with nothing left to wake it) would show "Scanning..." forever
// without ever causing the worker to boot and clean that state up.
//
// Never rejects (caught internally) — an unhandled rejection here would
// leave every future PING hanging forever, since its handler only
// resolves after this promise settles.
const reconcileOnBoot = (async () => {
  await reconcileRunState("scanState", "scanProgress", "fetching", "Scan was interrupted and could not resume.");
  await reconcileRunState("executeState", "executeProgress", "running", "Clean was interrupted and could not resume.");
})().catch((error) => console.error("[MailCleaner] boot reconciliation failed:", error));

function setProgress(key, progress) {
  return chrome.storage.local.set({ [key]: progress });
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

function removeCachedAuthToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
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
// 429/403 rate limiting.
function isRetryableError(status, bodyText) {
  if (status === 429) return true;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  return status === 403 && /rateLimitExceeded|RATE_LIMIT_EXCEEDED/i.test(bodyText);
}

// Gmail's per-user quota is 6000 units/minute, and users.messages.get
// costs 20 units/call — a hard ceiling of ~300 calls/min (one every
// 200ms). Pace every Gmail API call through a shared minimum interval so
// we stay under quota proactively instead of relying on backoff to
// recover after the fact. 220ms leaves real (though tighter) headroom
// under that 200ms floor for messages.list's own cost and timing jitter,
// while running meaningfully faster than the original 300ms.
let nextAllowedRequestTime = 0;
function paceRequest() {
  const minIntervalMs = 220;
  const now = Date.now();
  const wait = Math.max(0, nextAllowedRequestTime - now);
  nextAllowedRequestTime = Math.max(now, nextAllowedRequestTime) + minIntervalMs;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

// Backoff is still needed as a safety net (other tabs/tools sharing the
// same quota, a burst right at a window boundary), just no longer the
// primary defense against exceeding it.
//
// Manifest V3 service workers can be torn down after ~30s with no active
// network activity, and setTimeout does NOT keep a service worker alive
// on its own. A single backoff wait needs to stay well under that
// danger zone, not just under it — capping at half the threshold (15s)
// was tried and confirmed insufficient by a real, unconfounded repro
// (the worker died mid-wait anyway). 5s leaves real margin.
async function gmailFetch(token, path, options = {}) {
  const maxRetries = 15;
  const maxDelay = 5000;
  let delay = 1000;
  let currentToken = token;
  let refreshedToken = false;

  for (let attempt = 0; ; attempt++) {
    await paceRequest();
    const resp = await fetch(`${GMAIL_API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${currentToken}`, ...options.headers },
    });
    if (resp.ok) return resp.json();

    // A cached token can be revoked (the user removes access in their
    // Google Account) or simply expire outside our control. Chrome keeps
    // handing back the same bad token forever unless explicitly evicted
    // — without this, every call fails with a raw, unrecoverable 401.
    // Try exactly one refresh; a 401 that survives a fresh token is a
    // real auth problem, not staleness.
    if (resp.status === 401 && !refreshedToken) {
      refreshedToken = true;
      await resp.text();
      await removeCachedAuthToken(currentToken);
      currentToken = await getToken();
      continue;
    }

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
  const [{ allowlist }, { allowlistOverflow }] = await Promise.all([
    chrome.storage.sync.get("allowlist"),
    chrome.storage.local.get("allowlistOverflow"),
  ]);
  return new Set([...(allowlist ?? []), ...(allowlistOverflow ?? [])]);
}

async function saveScanCache(aggregated, scannedAt) {
  await chrome.storage.local.set({
    scanCache: { aggregated, scannedAt },
  });
}

async function removeDomainsFromScanCache(domains) {
  const { scanCache } = await chrome.storage.local.get("scanCache");
  if (!scanCache) return;
  const aggregated = { ...scanCache.aggregated };
  let changed = false;
  for (const domain of domains) {
    if (domain in aggregated) {
      delete aggregated[domain];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ scanCache: { ...scanCache, aggregated } });
  }
}

// Manifest V3 service workers can be torn down after ~30s of no
// activity, and a scan over a large inbox can legitimately take tens of
// minutes — far too long to run inside one continuous invocation.
// chrome.alarms is the documented, durable way to run a long task in an
// MV3 worker: alarms persist independently of the worker's own lifetime,
// so each "continueScan" firing gets a fresh worker instance that reads
// where the last chunk left off (in chrome.storage.local) and picks up
// from there.
//
// Each chunk fetches a bounded-concurrency batch of messages at a time
// (paceRequest still gates real dispatch rate, but concurrency lets
// several requests' round-trip latency overlap instead of adding on top
// of the pacing floor) and flushes progress to storage periodically
// (not on every batch — with a large scan's results array running into
// several MB, writing the whole thing on every small batch is wasteful
// I/O for no benefit) so an interruption loses at most a few seconds of
// work, not a whole chunk.
const CHUNK_BUDGET_MS = 4 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5000;
const FETCH_CONCURRENCY = 5;
const ALARM_INTERVAL_MINUTES = 0.5; // 30s — Chrome's practical minimum for one-time alarms

async function startOrResumeScan() {
  let { scanState } = await chrome.storage.local.get("scanState");

  if (!scanState || scanState.phase !== "fetching") {
    console.log("[MailCleaner] scan starting, requesting token...");
    await setProgress("scanProgress", { running: true, done: 0, total: 0 });
    const token = await getToken();
    console.log("[MailCleaner] got token, listing inbox message ids...");
    const ids = await listInboxMessageIds(token);
    console.log(`[MailCleaner] found ${ids.length} inbox messages, fetching headers...`);
    scanState = { phase: "fetching", ids, nextIndex: 0, results: [], updatedAt: Date.now() };
    await chrome.storage.local.set({ scanState });
    await setProgress("scanProgress", { running: true, done: 0, total: ids.length });
  }

  await processScanChunk();
}

// A per-message fetch failure (e.g. the user deletes that exact message
// from Gmail's own UI mid-scan, or one message hits a transient error
// gmailFetch's own retries couldn't recover from) must not abort the
// whole chunk — the spec calls for isolating and logging single-message
// failures, not letting one bad message wedge a scan that's otherwise
// tens of minutes into real progress. Promise.allSettled isolates each
// batch member independently; a rejected one is skipped and logged.
async function processScanChunk() {
  const { scanState } = await chrome.storage.local.get("scanState");
  if (!scanState || scanState.phase !== "fetching") return;

  const token = await getToken();
  const { ids, results } = scanState;
  let { nextIndex } = scanState;
  const chunkStart = Date.now();
  let lastFlush = chunkStart;

  while (nextIndex < ids.length && Date.now() - chunkStart < CHUNK_BUDGET_MS) {
    const batchIds = ids.slice(nextIndex, nextIndex + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(batchIds.map((id) => fetchMessageHeaders(token, id)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        console.warn("[MailCleaner] skipping a message after fetch error:", outcome.reason?.message);
      }
    }
    nextIndex += batchIds.length;

    const now = Date.now();
    if (now - lastFlush >= FLUSH_INTERVAL_MS) {
      await chrome.storage.local.set({ scanState: { phase: "fetching", ids, nextIndex, results, updatedAt: now } });
      setBadgeProgress(nextIndex, ids.length);
      await setProgress("scanProgress", { running: true, done: nextIndex, total: ids.length });
      lastFlush = now;
    }
  }

  await chrome.storage.local.set({ scanState: { phase: "fetching", ids, nextIndex, results, updatedAt: Date.now() } });
  setBadgeProgress(nextIndex, ids.length);
  await setProgress("scanProgress", { running: true, done: nextIndex, total: ids.length });
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
  await setProgress("scanProgress", { running: false, done: total, total });
  clearBadge();
  console.log("[MailCleaner] scan complete and cached.");
}

// scanState.phase stays "fetching" (not reset) on a chunk-level failure
// (getToken/listInboxMessageIds throwing, or a storage write itself
// failing — individual message failures are isolated above and never
// reach here) so the next "Scan my inbox" click resumes at nextIndex
// instead of re-listing and re-fetching everything already done.
async function handleScanChunkFailure(error) {
  console.error("[MailCleaner] scan chunk failed:", error);
  chrome.action.setBadgeBackgroundColor({ color: "#d64545" });
  chrome.action.setBadgeText({ text: "err" });
  await setProgress("scanProgress", { running: false, error: error.message });
}

// A resume that blindly continued executeState.queue regardless of the
// domains actually being requested had a real path to trashing messages
// from a domain the user had just deselected: a failed clean leaves
// executeState.phase "running" (so it can resume) but re-enables the
// Clean button; if the user then unchecks a domain and clicks Clean
// again before that stale phase gets cleared, the OLD queue (built from
// the ORIGINAL selection) would keep running, ignoring the new one
// entirely. Only resume when the requested domains match what's already
// queued — any other selection starts fresh.
function sameDomainSelection(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((d) => b.includes(d));
}

async function startOrResumeExecute(domains) {
  let { executeState } = await chrome.storage.local.get("executeState");
  const canResume = executeState?.phase === "running" && sameDomainSelection(executeState.domains, domains);

  if (!canResume) {
    const { scanCache } = await chrome.storage.local.get("scanCache");
    if (!scanCache) throw new Error("No cached scan to execute against — run a scan first.");
    const queue = [];
    for (const domain of domains) {
      const entry = scanCache.aggregated[domain];
      if (!entry) continue;
      for (const message of entry.messages) queue.push({ domain, message });
    }
    executeState = {
      phase: "running",
      queue,
      nextIndex: 0,
      trashedCount: 0,
      unsubscribedCount: 0,
      failedDomains: [],
      domains,
      updatedAt: Date.now(),
    };
    await chrome.storage.local.set({ executeState });
    await setProgress("executeProgress", { running: true, done: 0, total: queue.length });
  }

  await processExecuteChunk();
}

// Mirrors processScanChunk exactly: bounded concurrency, periodic
// flush, per-message error isolation. Trashing/unsubscribing thousands
// of messages is the same long-running shape that was already proven
// fatal for scanning inside one continuous invocation — this used to be
// a single unchunked loop with no resumability at all.
async function processExecuteChunk() {
  const { executeState } = await chrome.storage.local.get("executeState");
  if (!executeState || executeState.phase !== "running") return;

  const token = await getToken();
  const { queue } = executeState;
  let { nextIndex, trashedCount, unsubscribedCount } = executeState;
  // A message that fails even after gmailFetch's own retries (e.g. a
  // sustained outage, not just an already-deleted message) must not be
  // silently reported as cleaned — track which domains had a failure so
  // finishExecute can leave them in the cache/review list instead of
  // telling the user everything succeeded while some messages actually
  // stayed in the inbox.
  const failedDomains = new Set(executeState.failedDomains || []);
  const chunkStart = Date.now();
  let lastFlush = chunkStart;

  while (nextIndex < queue.length && Date.now() - chunkStart < CHUNK_BUDGET_MS) {
    const batch = queue.slice(nextIndex, nextIndex + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async ({ message }) => {
        const result = await unsubscribeOne(token, message);
        await trashMessage(token, message.id);
        return result.succeeded;
      }),
    );
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        trashedCount += 1;
        if (outcome.value) unsubscribedCount += 1;
      } else {
        console.warn("[MailCleaner] skipping a message during clean after error:", outcome.reason?.message);
        failedDomains.add(batch[i].domain);
      }
    });
    nextIndex += batch.length;

    const now = Date.now();
    if (now - lastFlush >= FLUSH_INTERVAL_MS) {
      await chrome.storage.local.set({
        executeState: { ...executeState, nextIndex, trashedCount, unsubscribedCount, failedDomains: [...failedDomains], updatedAt: now },
      });
      await setProgress("executeProgress", { running: true, done: nextIndex, total: queue.length });
      lastFlush = now;
    }
  }

  const finalState = { ...executeState, nextIndex, trashedCount, unsubscribedCount, failedDomains: [...failedDomains], updatedAt: Date.now() };
  await chrome.storage.local.set({ executeState: finalState });
  await setProgress("executeProgress", { running: true, done: nextIndex, total: queue.length });

  if (nextIndex < queue.length) {
    chrome.alarms.create("continueExecute", { delayInMinutes: ALARM_INTERVAL_MINUTES });
  } else {
    await finishExecute(finalState);
  }
}

async function finishExecute(executeState) {
  const failedDomains = executeState.failedDomains || [];
  const cleanedDomains = executeState.domains.filter((d) => !failedDomains.includes(d));
  await removeDomainsFromScanCache(cleanedDomains);
  await chrome.storage.local.set({
    executeState: { phase: "idle" },
    executeResult: {
      trashedCount: executeState.trashedCount,
      unsubscribedCount: executeState.unsubscribedCount,
      domains: cleanedDomains,
      failedDomains,
      completedAt: Date.now(),
    },
  });
  await setProgress("executeProgress", { running: false, done: executeState.nextIndex, total: executeState.queue.length });
  console.log("[MailCleaner] clean complete.");
}

async function handleExecuteChunkFailure(error) {
  console.error("[MailCleaner] clean chunk failed:", error);
  await setProgress("executeProgress", { running: false, error: error.message });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "continueScan") {
    reconcileOnBoot.then(() => processScanChunk()).catch(handleScanChunkFailure);
  } else if (alarm.name === "continueExecute") {
    reconcileOnBoot.then(() => processExecuteChunk()).catch(handleExecuteChunkFailure);
  }
});

async function trustSender(domain) {
  const allowlist = await loadAllowlist();
  allowlist.add(domain);
  await saveAllowlist(allowlist);
  await removeDomainsFromScanCache([domain]);
}

// chrome.storage.sync caps each item at ~8KB (QUOTA_BYTES_PER_ITEM). A
// few hundred trusted domains is enough to exceed that on one combined
// "allowlist" item, which would otherwise make every trust past that
// point silently fail while the UI still shows it as successful. Keep
// as much as fits synced across devices, and hold the rest in
// chrome.storage.local (not synced, but still persists and still keeps
// trust working) rather than dropping it.
const SYNC_ITEM_SAFE_BYTES = 7000;

async function saveAllowlist(allowlist) {
  const all = [...allowlist];
  let synced = [];
  let overflow = [];
  for (const domain of all) {
    const candidate = [...synced, domain];
    if (JSON.stringify(candidate).length <= SYNC_ITEM_SAFE_BYTES) {
      synced = candidate;
    } else {
      overflow.push(domain);
    }
  }
  await chrome.storage.sync.set({ allowlist: synced });
  if (overflow.length > 0) {
    await chrome.storage.local.set({ allowlistOverflow: overflow });
  } else {
    await chrome.storage.local.remove("allowlistOverflow");
  }
}

function sanitizeHeaderValue(value) {
  return (value || "").replace(/[\r\n]/g, " ");
}

function buildUnsubscribeMimeMessage({ address, subject, body }) {
  const raw = [
    `To: ${sanitizeHeaderValue(address)}`,
    `Subject: ${sanitizeHeaderValue(subject) || "unsubscribe"}`,
    "",
    body || "Please unsubscribe me from this mailing list.",
  ].join("\r\n");
  const base64 = btoa(unescape(encodeURIComponent(raw)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function unsubscribeOne(token, message) {
  const { listUnsubscribe, oneClick } = message;
  if (listUnsubscribe.http) {
    try {
      // Third-party unsubscribe endpoints almost never send CORS
      // headers, so a normal fetch() would have its response blocked as
      // opaque and throw — even though the request itself (a simple,
      // non-preflighted GET/POST) genuinely reached the server. no-cors
      // avoids that false failure. RFC 8058 requires the one-click POST
      // to carry this exact body/content-type; without it, compliant
      // unsubscribe endpoints reject or ignore the request.
      //
      // The response is unreadable either way under no-cors, so
      // "succeeded" here means "the request was issued", not "confirmed
      // accepted" — and issuing it means we must NOT also fall through
      // to mailto below, or every HTTP unsubscribe would send a genuine
      // duplicate email on top of the request that already fired.
      await fetch(listUnsubscribe.http, {
        method: oneClick ? "POST" : "GET",
        mode: "no-cors",
        ...(oneClick
          ? { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }
          : {}),
      });
      return { attempted: true, succeeded: true };
    } catch {
      // The request itself never went out (bad URL, DNS, network) —
      // only now is falling through to mailto a genuine fallback rather
      // than a duplicate attempt.
    }
  }
  if (listUnsubscribe.mailto) {
    try {
      // The List-Unsubscribe mailto often carries ?subject=/?body= query
      // params carrying the actual subscriber token (RFC 2369) — e.g.
      // <mailto:unsub@example.com?subject=unsub-8f3a9c>. Naively using
      // the whole raw string (including the query) as the To: address
      // builds an invalid header and silently loses that token.
      const parsed = parseMailtoUri(listUnsubscribe.mailto);
      await gmailFetch(token, "/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: buildUnsubscribeMimeMessage(parsed) }),
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

// A scoped re-review caught a real concurrency hole: startOrResumeScan
// writes scanProgress.running = true well before it writes
// scanState.phase = "fetching" (getToken()/listInboxMessageIds() sit in
// between, which can take minutes on a large mailbox) — so the SCAN
// handler's AND-based "already running" check was false for that whole
// window, letting a second SCAN message (a double-click on the never-
// disabled rescan link, or a second side panel window) start a fully
// concurrent second scan chain. Two chunk loops racing to overwrite the
// same scanState silently drop half the fetched results.
//
// chrome.runtime.onMessage listener invocations run synchronously up to
// their first await, and all messages for one extension are delivered
// to the same single worker instance — so a plain in-memory flag, set
// synchronously before any storage read, is race-free here (unlike the
// storage-based check it backs up, which stays as defense in depth for
// the case this flag can't cover: a resume triggered by something other
// than this listener, e.g. the alarm path above).
let scanStarting = false;
let executeStarting = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    reconcileOnBoot.then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "SCAN") {
    if (scanStarting) {
      sendResponse({ ok: false, error: "A scan is already in progress." });
      return true;
    }
    scanStarting = true;
    chrome.storage.local.get(["scanState", "scanProgress"]).then(({ scanState, scanProgress }) => {
      if (scanState?.phase === "fetching" && scanProgress?.running) {
        scanStarting = false;
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
        })
        .finally(() => { scanStarting = false; });
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
    if (executeStarting) {
      sendResponse({ ok: false, error: "A clean is already in progress." });
      return true;
    }
    executeStarting = true;
    chrome.storage.local.get(["executeState", "executeProgress"]).then(({ executeState, executeProgress }) => {
      if (executeState?.phase === "running" && executeProgress?.running) {
        executeStarting = false;
        sendResponse({ ok: false, error: "A clean is already in progress." });
        return;
      }
      startOrResumeExecute(message.domains)
        .then(() => sendResponse({ ok: true, started: true }))
        .catch((error) => {
          handleExecuteChunkFailure(error);
          sendResponse({ ok: false, error: error.message });
        })
        .finally(() => { executeStarting = false; });
    });
    return true;
  }
});
