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
      listEl.querySelector(`.row[data-domain="${CSS.escape(domain)}"]`)?.remove();
    }
  } else {
    statusEl.textContent = `Failed: ${result.error}`;
  }
});

load();
