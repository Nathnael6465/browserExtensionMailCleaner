const digestView = document.getElementById("digestView");
const reviewView = document.getElementById("reviewView");

const countEl = document.getElementById("count");
const subtextEl = document.getElementById("subtext");
const badgeEl = document.getElementById("badge");
const lastScannedEl = document.getElementById("lastScanned");
const scanButton = document.getElementById("scanButton");

const backButton = document.getElementById("backButton");
const listEl = document.getElementById("list");
const confirmButton = document.getElementById("confirmButton");
const statusEl = document.getElementById("status");

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
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
}

async function loadCached() {
  const cached = await sendMessage({ type: "GET_CACHED_SCAN" });
  if (cached) renderDigest(cached.aggregated, cached.scannedAt);
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
}

async function init() {
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
});

function showDigest() {
  reviewView.classList.add("hidden");
  digestView.classList.remove("hidden");
}

function showReview() {
  digestView.classList.add("hidden");
  reviewView.classList.remove("hidden");
}

scanButton.addEventListener("click", async () => {
  const hasCached = countEl.textContent !== "—" && countEl.textContent !== "0" && !scanButton.disabled;
  if (hasCached) {
    showReview();
    loadReview();
    return;
  }
  // Immediate feedback before the first storage.onChanged write lands;
  // chrome.storage.onChanged above is what keeps this in sync from
  // here on, including after the panel is closed and reopened.
  scanButton.disabled = true;
  scanButton.textContent = "Scanning...";
  const result = await sendMessage({ type: "SCAN" });
  if (result.ok) {
    scanButton.disabled = false;
    renderDigest(result.aggregated, result.scannedAt);
  } else if (result.error !== "A scan is already in progress.") {
    scanButton.disabled = false;
    subtextEl.textContent = `Scan failed: ${result.error}`;
    scanButton.textContent = "Scan my inbox";
  }
});

backButton.addEventListener("click", showDigest);

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
    await sendMessage({ type: "TRUST_SENDER", domain });
    row.remove();
  });

  row.append(checkbox, info, trustButton);
  return row;
}

async function loadReview() {
  listEl.textContent = "";
  statusEl.textContent = "";
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
      listEl.querySelector(`.row[data-domain="${CSS.escape(domain)}"]`)?.remove();
    }
  } else {
    statusEl.textContent = `Failed: ${result.error}`;
  }
});

init();
