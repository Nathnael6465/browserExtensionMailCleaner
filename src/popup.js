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
