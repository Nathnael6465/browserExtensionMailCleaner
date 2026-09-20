import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyMessage, KNOWN_BRAND_DOMAINS } from "../src/classify.js";

const noUnsub = { mailto: null, http: null };
const noAuth = { spf: null, dkim: null, dmarc: null };
const passAuth = { spf: "pass", dkim: "pass", dmarc: "pass" };

// --- .gov is inherently trusted, even with an empty allowlist ---

test(".gov domain passes with empty allowlist", () => {
  const result = classifyMessage(
    "notice@bentoncountyar.gov", noUnsub, noAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test(".gov lookalike domain is not treated as .gov", () => {
  const result = classifyMessage(
    "alerts@notreallygov.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["unverified_domain"]);
});

// --- auth failure — checked first, short-circuits ---

test("flags via auth failure even with suspicious local-part", () => {
  const result = classifyMessage(
    "rnk4wxc@t4r.plasticcars.com", noUnsub, noAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["auth_failed_or_missing"]);
});

test("flags message when authentication fails even with readable name", () => {
  const result = classifyMessage(
    "alerts@suspicious-domain.com", noUnsub,
    { spf: "fail", dkim: "fail", dmarc: "fail" }, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["auth_failed_or_missing"]);
});

// --- suspicious local-part, isolated with clean auth ---

test("flags machine-generated local-part with digits when auth is clean", () => {
  const result = classifyMessage(
    "rnk4wxc@t4r.plasticcars.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["suspicious_local_part"]);
});

test("flags pure-letter gibberish local-part via consonant run", () => {
  const result = classifyMessage(
    "michpjlhjrnpndjz@gtonfamilyattorney.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["suspicious_local_part"]);
});

// --- display name / subject padding-evasion ---

test("flags display name with dot padding both sides", () => {
  const result = classifyMessage(
    "promo@aarpdeals.example.com", noUnsub, passAuth, new Set(),
    "· · · · JoinAARP · · · ·",
    "25% off AARP membership for you"
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["padding_evasion"]);
});

test("flags subject with dot padding when display name is clean", () => {
  const result = classifyMessage(
    "alerts@prioritygold.example.com", noUnsub, passAuth, new Set(),
    "PriorityGoldAlerts",
    "· · · · Protect Your 401(k) With Gold & Silver · · · ·"
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["padding_evasion"]);
});

test("padding evasion short-circuits before list_unsubscribe", () => {
  const result = classifyMessage(
    "promo@aarpdeals.example.com",
    { mailto: null, http: "https://aarpdeals.example.com/unsub" },
    passAuth, new Set(),
    "· · · · JoinAARP · · · ·", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["padding_evasion"]);
});

test("does not flag apostrophe in display name", () => {
  const result = classifyMessage(
    "obrien@company.com", noUnsub, passAuth, new Set(["company.com"]),
    "O'Brien", "Re: Fwd: quarterly report"
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag comma and hyphen in display name and subject", () => {
  const result = classifyMessage(
    "jsmith@company.com", noUnsub, passAuth, new Set(["company.com"]),
    "Smith, John", "50% OFF - Ends Friday!"
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag ampersand in display name", () => {
  const result = classifyMessage(
    "hello@jj.example.com", noUnsub, passAuth, new Set(["jj.example.com"]),
    "Johnson & Johnson", "Invoice #1234"
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag trailing ellipsis as padding", () => {
  const result = classifyMessage(
    "hello@company.com", noUnsub, passAuth, new Set(["company.com"]),
    "Company Updates", "Wait for it..."
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

// --- List-Unsubscribe present ---

test("flags legit newsletter because of List-Unsubscribe header", () => {
  const result = classifyMessage(
    "newsletter@somebrand.com",
    { mailto: null, http: "https://somebrand.com/unsub" },
    passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["list_unsubscribe_present"]);
});

// --- suspicious TLD ---

test("flags suspicious TLD", () => {
  const result = classifyMessage(
    "info@somejunkbrand.info", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["suspicious_tld"]);
});

// --- default-deny fallback: unverified domain ---

test("flags unverified domain with otherwise clean signals", () => {
  const result = classifyMessage(
    "hello@totallyrandomcompany.com", noUnsub, passAuth, new Set(), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["unverified_domain"]);
});

test("does not flag domain in user allowlist", () => {
  const result = classifyMessage(
    "hello@knowncompany.com", noUnsub, passAuth, new Set(["knowncompany.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag subdomain of allowlisted root domain", () => {
  const result = classifyMessage(
    "noreply@alerts.chase.com", noUnsub, passAuth, new Set(["chase.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("does not flag sibling domain sharing a suffix", () => {
  const result = classifyMessage(
    "hello@notchase.com", noUnsub, passAuth, new Set(["chase.com"]), "", ""
  );
  assert.equal(result.flagged, true);
  assert.deepEqual(result.reasons, ["unverified_domain"]);
});

// --- built-in KNOWN_BRAND_DOMAINS ---

test("known brand domain passes even with empty user allowlist", () => {
  const verified = new Set([...new Set(), ...KNOWN_BRAND_DOMAINS]);
  const result = classifyMessage(
    "orders@amazon.com", noUnsub, passAuth, verified, "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

// --- allowlist overrides every other rule ---

test("allowlisted domain is never flagged", () => {
  const result = classifyMessage(
    "rnk4wxc@t4r.plasticcars.com", noUnsub, noAuth,
    new Set(["t4r.plasticcars.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});

test("allowlisted exact address is never flagged", () => {
  const result = classifyMessage(
    "newsletter@somebrand.com",
    { mailto: null, http: "https://somebrand.com/unsub" },
    passAuth, new Set(["newsletter@somebrand.com"]), "", ""
  );
  assert.equal(result.flagged, false);
  assert.deepEqual(result.reasons, []);
});
