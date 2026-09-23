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
