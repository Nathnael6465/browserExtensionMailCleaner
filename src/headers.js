const MAILTO_RE = /<mailto:([^>]+)>/;
const HTTP_RE = /<(https?:\/\/[^>]+)>/;
const AUTH_RESULT_RE = /\b(spf|dkim|dmarc)=([a-zA-Z]+)/g;
const ENCODED_WORD_RE = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

export function parseListUnsubscribe(header) {
  const result = { mailto: null, http: null };
  if (!header) return result;

  const mailtoMatch = MAILTO_RE.exec(header);
  if (mailtoMatch) result.mailto = mailtoMatch[1];

  const httpMatch = HTTP_RE.exec(header);
  if (httpMatch) result.http = httpMatch[1];

  return result;
}

// A List-Unsubscribe mailto often carries RFC 2369 ?subject=/?body=
// query parameters holding the actual subscriber token, e.g.
// <mailto:unsub@example.com?subject=unsub-8f3a9c>. The raw mailto string
// (as captured by MAILTO_RE) includes that whole query string, which is
// not a valid email address on its own — splitting it out here keeps
// that responsibility as a pure, tested function rather than baking it
// into whatever builds the actual outgoing message.
export function parseMailtoUri(mailto) {
  if (!mailto) return { address: "", subject: null, body: null };
  const [address, query] = mailto.split("?", 2);
  const result = { address, subject: null, body: null };
  if (query) {
    const params = new URLSearchParams(query);
    if (params.has("subject")) result.subject = params.get("subject");
    if (params.has("body")) result.body = params.get("body");
  }
  return result;
}

export function hasOneClickUnsubscribe(header) {
  if (!header) return false;
  return header.includes("List-Unsubscribe=One-Click");
}

export function parseAuthenticationResults(header) {
  const result = { spf: null, dkim: null, dmarc: null };
  if (!header) return result;

  for (const match of header.matchAll(AUTH_RESULT_RE)) {
    const [, mechanism, value] = match;
    result[mechanism.toLowerCase()] = value.toLowerCase();
  }

  return result;
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function quotedPrintableToBytes(text) {
  // In RFC 2047 Q-encoding, "_" represents a space (unlike body Q-encoding).
  const normalized = text.replace(/_/g, " ");
  const bytes = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === "=" && i + 2 < normalized.length) {
      const hex = normalized.slice(i + 1, i + 3);
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i));
    }
  }
  return new Uint8Array(bytes);
}

function decodeEncodedWord(charset, encoding, text) {
  const bytes = encoding.toLowerCase() === "b" ? base64ToBytes(text) : quotedPrintableToBytes(text);
  const decoder = new TextDecoder(charset, { fatal: false });
  return decoder.decode(bytes);
}

export function decodeMimeWords(value) {
  if (!value) return "";

  let result = "";
  let lastIndex = 0;
  ENCODED_WORD_RE.lastIndex = 0;
  let match;
  while ((match = ENCODED_WORD_RE.exec(value)) !== null) {
    result += value.slice(lastIndex, match.index);
    const [, charset, encoding, text] = match;
    try {
      result += decodeEncodedWord(charset, encoding, text);
    } catch {
      // Malformed encoded-word — never throw on a bad header, fall back
      // to the raw matched text untouched.
      result += match[0];
    }
    lastIndex = ENCODED_WORD_RE.lastIndex;
  }
  result += value.slice(lastIndex);
  return result;
}
