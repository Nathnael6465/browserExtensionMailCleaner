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
