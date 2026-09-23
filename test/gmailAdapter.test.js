import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHeaderValue, adaptGmailMessage } from "../src/gmailAdapter.js";

const sampleGmailMessage = {
  id: "18d4f2a1b2c3d4e5",
  payload: {
    headers: [
      { name: "From", value: "Some Sender <hello@example.com>" },
      { name: "Subject", value: "Weekly Digest" },
      { name: "List-Unsubscribe", value: "<https://example.com/unsub>" },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
      { name: "Authentication-Results", value: "spf=pass dkim=pass dmarc=pass" },
    ],
  },
};

test("extractHeaderValue finds a header case-insensitively", () => {
  assert.equal(extractHeaderValue(sampleGmailMessage.payload.headers, "from"), "Some Sender <hello@example.com>");
  assert.equal(extractHeaderValue(sampleGmailMessage.payload.headers, "Subject"), "Weekly Digest");
});

test("extractHeaderValue returns null for a missing header", () => {
  assert.equal(extractHeaderValue(sampleGmailMessage.payload.headers, "X-Nonexistent"), null);
});

test("adaptGmailMessage produces the shape aggregate.js expects", () => {
  const adapted = adaptGmailMessage(sampleGmailMessage);
  assert.equal(adapted.id, "18d4f2a1b2c3d4e5");
  assert.equal(adapted.from, "Some Sender <hello@example.com>");
  assert.equal(adapted.subject, "Weekly Digest");
  assert.equal(adapted.listUnsubscribe, "<https://example.com/unsub>");
  assert.equal(adapted.listUnsubscribePost, "List-Unsubscribe=One-Click");
  assert.equal(adapted.authenticationResults, "spf=pass dkim=pass dmarc=pass");
});

test("adaptGmailMessage handles a message with no headers array gracefully", () => {
  const adapted = adaptGmailMessage({ id: "empty", payload: { headers: [] } });
  assert.equal(adapted.id, "empty");
  assert.equal(adapted.from, "");
  assert.equal(adapted.subject, "");
  assert.equal(adapted.listUnsubscribe, null);
  assert.equal(adapted.listUnsubscribePost, null);
  assert.equal(adapted.authenticationResults, null);
});
