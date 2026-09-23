import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseListUnsubscribe,
  hasOneClickUnsubscribe,
  parseAuthenticationResults,
  decodeMimeWords,
  parseMailtoUri,
} from "../src/headers.js";

// --- parseListUnsubscribe ---

test("parses mailto and https together", () => {
  const header = "<mailto:unsub@example.com>, <https://example.com/unsubscribe?id=123>";
  const result = parseListUnsubscribe(header);
  assert.equal(result.mailto, "unsub@example.com");
  assert.equal(result.http, "https://example.com/unsubscribe?id=123");
});

test("parses https only", () => {
  const header = "<https://example.com/unsubscribe?id=123>";
  const result = parseListUnsubscribe(header);
  assert.equal(result.http, "https://example.com/unsubscribe?id=123");
  assert.equal(result.mailto, null);
});

test("parses mailto only", () => {
  const header = "<mailto:unsub@example.com>";
  const result = parseListUnsubscribe(header);
  assert.equal(result.mailto, "unsub@example.com");
  assert.equal(result.http, null);
});

test("missing List-Unsubscribe header returns no links", () => {
  const result = parseListUnsubscribe(null);
  assert.equal(result.mailto, null);
  assert.equal(result.http, null);
});

// --- hasOneClickUnsubscribe (RFC 8058) ---

test("one-click flag present", () => {
  assert.equal(hasOneClickUnsubscribe("List-Unsubscribe=One-Click"), true);
});

test("one-click flag missing header", () => {
  assert.equal(hasOneClickUnsubscribe(null), false);
});

test("one-click flag wrong value", () => {
  assert.equal(hasOneClickUnsubscribe("something-else"), false);
});

// --- parseAuthenticationResults ---

test("parses all pass", () => {
  const header =
    "mta1234.mail.yahoo.com; " +
    "dkim=pass header.i=@example.com; " +
    "spf=pass smtp.mailfrom=example.com; " +
    "dmarc=pass header.from=example.com";
  const result = parseAuthenticationResults(header);
  assert.equal(result.spf, "pass");
  assert.equal(result.dkim, "pass");
  assert.equal(result.dmarc, "pass");
});

test("parses mixed results", () => {
  const header = "mta.mail.yahoo.com; dkim=fail; spf=softfail smtp.mailfrom=example.com; dmarc=none";
  const result = parseAuthenticationResults(header);
  assert.equal(result.spf, "softfail");
  assert.equal(result.dkim, "fail");
  assert.equal(result.dmarc, "none");
});

test("missing Authentication-Results header", () => {
  const result = parseAuthenticationResults(null);
  assert.equal(result.spf, null);
  assert.equal(result.dkim, null);
  assert.equal(result.dmarc, null);
});

// --- decodeMimeWords ---

test("decodes utf-8 base64 encoded header", () => {
  // Real padding character (U+00B7) followed by "JoinAARP", base64
  // encoded exactly as the equivalent Python fixture used.
  const header = "=?utf-8?b?wrcgwrcgwrcgSm9pbkFBUlA=?=";
  assert.equal(decodeMimeWords(header), "· · · JoinAARP");
});

test("decodes utf-8 quoted-printable encoded header", () => {
  const header = "=?utf-8?q?Protect_Your_401=28k=29?=";
  assert.equal(decodeMimeWords(header), "Protect Your 401(k)");
});

test("returns plain ASCII header unchanged", () => {
  assert.equal(decodeMimeWords("Weekly Digest"), "Weekly Digest");
});

test("returns empty string for missing header", () => {
  assert.equal(decodeMimeWords(null), "");
  assert.equal(decodeMimeWords(""), "");
});

test("malformed encoded-word marker does not throw, falls back to raw text", () => {
  const header = "=?utf-8?b?not-valid-base64!!!?=";
  assert.doesNotThrow(() => decodeMimeWords(header));
});

// --- parseMailtoUri ---

test("plain mailto address with no query params", () => {
  const result = parseMailtoUri("unsub@example.com");
  assert.equal(result.address, "unsub@example.com");
  assert.equal(result.subject, null);
  assert.equal(result.body, null);
});

test("mailto with a subject query param carrying the subscriber token", () => {
  const result = parseMailtoUri("unsub@example.com?subject=unsub-8f3a9c");
  assert.equal(result.address, "unsub@example.com");
  assert.equal(result.subject, "unsub-8f3a9c");
  assert.equal(result.body, null);
});

test("mailto with both subject and body query params", () => {
  const result = parseMailtoUri("unsub@example.com?subject=leave&body=please+remove+me");
  assert.equal(result.address, "unsub@example.com");
  assert.equal(result.subject, "leave");
  assert.equal(result.body, "please remove me");
});

test("empty mailto returns an empty address", () => {
  const result = parseMailtoUri("");
  assert.equal(result.address, "");
  assert.equal(result.subject, null);
  assert.equal(result.body, null);
});
