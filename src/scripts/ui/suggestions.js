export function formatSuggestion(message, username) {
  return {
    message: String(message || "").trim(),
    username: String(username || "").trim(),
  };
}
