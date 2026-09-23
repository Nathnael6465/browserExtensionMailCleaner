export function extractHeaderValue(gmailHeaders, headerName) {
  const found = gmailHeaders.find((h) => h.name.toLowerCase() === headerName.toLowerCase());
  return found ? found.value : null;
}

export function adaptGmailMessage(gmailMessage) {
  const headers = gmailMessage.payload?.headers ?? [];
  return {
    id: gmailMessage.id,
    from: extractHeaderValue(headers, "From") ?? "",
    subject: extractHeaderValue(headers, "Subject") ?? "",
    listUnsubscribe: extractHeaderValue(headers, "List-Unsubscribe"),
    listUnsubscribePost: extractHeaderValue(headers, "List-Unsubscribe-Post"),
    authenticationResults: extractHeaderValue(headers, "Authentication-Results"),
  };
}
