import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAddress, extractDisplayName, classifyMessages, aggregateByDomain } from "../src/aggregate.js";

test("extractAddress pulls bare address out of 'Name <addr>' format", () => {
  assert.equal(extractAddress("Some Sender <hello@example.com>"), "hello@example.com");
});

test("extractAddress handles a bare address with no display name", () => {
  assert.equal(extractAddress("hello@example.com"), "hello@example.com");
});

test("extractDisplayName pulls the name out of 'Name <addr>' format", () => {
  assert.equal(extractDisplayName('"Some Sender" <hello@example.com>'), "Some Sender");
});

test("extractDisplayName returns empty string for a bare address", () => {
  assert.equal(extractDisplayName("hello@example.com"), "");
});

test("classifyMessages flags an unverified domain and aggregates by domain", () => {
  const rawMessages = [
    { id: "1", from: "Someone <hello@totallyrandomcompany.com>", subject: "Hi", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
    { id: "2", from: "trusted@knowncompany.com", subject: "Order confirmed", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
  ];
  const classified = classifyMessages(rawMessages, new Set(["knowncompany.com"]));

  assert.equal(classified.length, 2);
  assert.equal(classified[0].flagged, true);
  assert.deepEqual(classified[0].reasons, ["unverified_domain"]);
  assert.equal(classified[0].domain, "totallyrandomcompany.com");
  assert.equal(classified[1].flagged, false);

  const aggregated = aggregateByDomain(classified);
  assert.deepEqual(Object.keys(aggregated), ["totallyrandomcompany.com"]);
  assert.equal(aggregated["totallyrandomcompany.com"].count, 1);
  assert.deepEqual(aggregated["totallyrandomcompany.com"].reasons, ["unverified_domain"]);
  assert.equal(aggregated["totallyrandomcompany.com"].messages[0].id, "1");
});

test("classifyMessages merges KNOWN_BRAND_DOMAINS automatically", () => {
  const rawMessages = [
    { id: "1", from: "orders@amazon.com", subject: "Your order", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
  ];
  const classified = classifyMessages(rawMessages, new Set());
  assert.equal(classified[0].flagged, false);
});

test("aggregateByDomain excludes non-flagged messages entirely", () => {
  const rawMessages = [
    { id: "1", from: "trusted@knowncompany.com", subject: "Hi", listUnsubscribe: null, listUnsubscribePost: null, authenticationResults: "spf=pass dkim=pass dmarc=pass" },
  ];
  const classified = classifyMessages(rawMessages, new Set(["knowncompany.com"]));
  const aggregated = aggregateByDomain(classified);
  assert.deepEqual(aggregated, {});
});
