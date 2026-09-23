const digestView = document.getElementById("digestView");
const reviewView = document.getElementById("reviewView");

const countEl = document.getElementById("count");
const subtextEl = document.getElementById("subtext");
const badgeEl = document.getElementById("badge");
const lastScannedEl = document.getElementById("lastScanned");
const scanButton = document.getElementById("scanButton");
const rescanButton = document.getElementById("rescanButton");

const backButton = document.getElementById("backButton");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");
const listEl = document.getElementById("list");
const confirmButton = document.getElementById("confirmButton");
const statusEl = document.getElementById("status");

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      // If the service worker died mid-response (or was never there to
      // receive the message), chrome.runtime.lastError is set and
      // response is undefined — resolving undefined silently let
      // callers crash on `result.ok` instead of showing an error.
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function estimateReclaimableMb(aggregated) {
  const totalMessages = Object.values(aggregated).reduce((sum, d) => sum + d.count, 0);
  // Rough estimate: ~50 KB/message average, matching typical marketing
  // email sizes — good enough for a directional badge, not a precise figure.
  return Math.round((totalMessages * 50) / 1024);
}

function renderDigest(aggregated, scannedAt) {
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
  // Once a scan has completed, the main button permanently becomes
  // "Review & clean" (see scanButton's click handler below) — without
  // this, there was no way to ever trigger another scan again short of
  // clearing extension storage by hand.
  rescanButton.style.display = "inline-block";
}

async function loadCached() {
  const cached = await sendMessage({ type: "GET_CACHED_SCAN" });
  // sendMessage() resolves an {ok:false, error} sentinel (not undefined)
  // when the worker died mid-response, which is truthy — checking
  // `cached.aggregated` specifically (rather than just `cached`) avoids
  // treating that sentinel as a real cache and crashing on
  // Object.values(undefined).
  if (cached?.aggregated) renderDigest(cached.aggregated, cached.scannedAt);
}

// The panel can be closed and reopened at any point during a scan that
// runs for many minutes — the scan itself keeps running in the
// background regardless, so a freshly opened panel needs to be able
// to show "how far along is it" rather than just the blank default
// state, and an already-open panel needs to keep updating live.
function showScanningState(done, total) {
  scanButton.disabled = true;
  scanButton.textContent = "Scanning...";
  countEl.textContent = total > 0 ? `${done} / ${total}` : "…";
  subtextEl.textContent = "scanning your inbox...";
  badgeEl.style.display = "none";
  lastScannedEl.textContent = "";
  rescanButton.style.display = "none";
}

async function init() {
  // Booting the worker here (if it isn't already running) guarantees its
  // startup reconciliation has finished before any stored progress below
  // is trusted — without this, a panel reopened after the worker died
  // between chunks with nothing left to wake it could read a stale
  // "running: true" and show "Scanning..." forever with no way to clear it.
  await sendMessage({ type: "PING" });

  const { scanProgress } = await chrome.storage.local.get("scanProgress");
  if (scanProgress?.running) {
    showScanningState(scanProgress.done, scanProgress.total);
  } else {
    await loadCached();
    if (scanProgress?.error) {
      subtextEl.textContent = `Scan failed: ${scanProgress.error}`;
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.scanProgress) {
    const progress = changes.scanProgress.newValue;
    if (progress?.running) {
      showScanningState(progress.done, progress.total);
    } else if (progress?.error) {
      scanButton.disabled = false;
      scanButton.textContent = "Scan my inbox";
      countEl.textContent = "—";
      subtextEl.textContent = `Scan failed: ${progress.error}`;
    }
  }

  if (changes.scanCache) {
    const cache = changes.scanCache.newValue;
    if (cache) {
      scanButton.disabled = false;
      renderDigest(cache.aggregated, cache.scannedAt);
    }
  }

  if (changes.executeProgress) {
    const progress = changes.executeProgress.newValue;
    if (progress?.running) {
      confirmButton.disabled = true;
      statusEl.textContent = progress.total > 0 ? `Cleaning... ${progress.done}/${progress.total}` : "Cleaning...";
    } else if (progress?.error) {
      confirmButton.disabled = false;
      statusEl.textContent = `Failed: ${progress.error}`;
    }
  }

  if (changes.executeResult) {
    const result = changes.executeResult.newValue;
    if (result) {
      confirmButton.disabled = false;
      const failedNote = result.failedDomains?.length
        ? ` ${result.failedDomains.length} sender(s) had errors and are still listed to retry.`
        : "";
      statusEl.textContent = `Done — ${result.trashedCount} messages moved to Trash, ${result.unsubscribedCount} unsubscribed.${failedNote}`;
      // Domains that failed stay in scanCache (see finishExecute) and
      // must stay visible in the review list too — only remove rows for
      // domains that were actually fully cleaned.
      for (const domain of result.domains) {
        listEl.querySelector(`.row[data-domain="${CSS.escape(domain)}"]`)?.remove();
      }
      updateSelectAllState();
    }
  }
});

function showDigest() {
  reviewView.classList.add("hidden");
  digestView.classList.remove("hidden");
}

function showReview() {
  digestView.classList.add("hidden");
  reviewView.classList.remove("hidden");
}

// Immediate feedback before the first storage.onChanged write lands;
// chrome.storage.onChanged above is what keeps this in sync from here
// on, including after the panel is closed and reopened. A scan now
// runs as a chain of alarm-triggered chunks, so this response only
// confirms the FIRST chunk started, not that the whole scan finished
// — the final digest arrives later via the scanCache storage.onChanged
// handler above, same as a reopened panel.
async function triggerScan() {
  scanButton.disabled = true;
  scanButton.textContent = "Scanning...";
  const result = await sendMessage({ type: "SCAN" });
  if (!result.ok && result.error !== "A scan is already in progress.") {
    scanButton.disabled = false;
    subtextEl.textContent = `Scan failed: ${result.error}`;
    scanButton.textContent = "Scan my inbox";
  }
}

scanButton.addEventListener("click", () => {
  const hasCached = countEl.textContent !== "—" && countEl.textContent !== "0" && !scanButton.disabled;
  if (hasCached) {
    showReview();
    loadReview();
    return;
  }
  triggerScan();
});

rescanButton.addEventListener("click", triggerScan);

backButton.addEventListener("click", showDigest);

function updateSelectAllState() {
  const checkboxes = [...listEl.querySelectorAll(".row input[type=checkbox]")];
  const checkedCount = checkboxes.filter((c) => c.checked).length;
  selectAllCheckbox.checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
  selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

selectAllCheckbox.addEventListener("change", () => {
  for (const checkbox of listEl.querySelectorAll(".row input[type=checkbox]")) {
    checkbox.checked = selectAllCheckbox.checked;
  }
  selectAllCheckbox.indeterminate = false;
});

function renderRow(domain, entry) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.domain = domain;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = true;
  checkbox.style.marginRight = "10px";
  checkbox.addEventListener("change", updateSelectAllState);

  const info = document.createElement("div");
  info.className = "info";

  const domainEl = document.createElement("div");
  domainEl.className = "domain";
  domainEl.textContent = domain;

  const metaEl = document.createElement("div");
  metaEl.className = "meta";
  metaEl.textContent = `${entry.count} messages · ${entry.reasons.join(", ")}`;

  info.append(domainEl, metaEl);

  const trustButton = document.createElement("button");
  trustButton.className = "trust";
  trustButton.textContent = "Trust";
  trustButton.addEventListener("click", async () => {
    const result = await sendMessage({ type: "TRUST_SENDER", domain });
    if (result.ok) {
      row.remove();
      updateSelectAllState();
    } else {
      statusEl.textContent = `Failed to trust ${domain}: ${result.error}`;
    }
  });

  row.append(checkbox, info, trustButton);
  return row;
}

async function loadReview() {
  listEl.textContent = "";
  statusEl.textContent = "";
  const cached = await sendMessage({ type: "GET_CACHED_SCAN" });
  if (!cached?.aggregated) {
    listEl.textContent = "No scan results yet.";
    return;
  }
  for (const [domain, entry] of Object.entries(cached.aggregated)) {
    listEl.appendChild(renderRow(domain, entry));
  }
  selectAllCheckbox.checked = true;
  selectAllCheckbox.indeterminate = false;

  // A clean can run for a long time on a large selection and, like a
  // scan, keeps going in the background if the panel is closed — reflect
  // that immediately if the review view is (re)opened mid-clean instead
  // of showing a blank "Clean selected" as if nothing were happening.
  const { executeProgress } = await chrome.storage.local.get("executeProgress");
  if (executeProgress?.running) {
    confirmButton.disabled = true;
    statusEl.textContent = executeProgress.total > 0 ? `Cleaning... ${executeProgress.done}/${executeProgress.total}` : "Cleaning...";
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
  // A clean now runs as a chain of alarm-triggered chunks, same as a
  // scan — this only confirms the first chunk started. The final counts
  // and row removal arrive via the executeProgress/executeResult
  // storage.onChanged handlers above.
  const result = await sendMessage({ type: "EXECUTE", domains: checkedDomains });
  if (!result.ok && result.error !== "A clean is already in progress.") {
    confirmButton.disabled = false;
    statusEl.textContent = `Failed: ${result.error}`;
  }
});

init();
