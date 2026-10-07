// MyMemory acepta hasta 500 bytes UTF-8 por consulta, no 500 caracteres.
export function splitTranslationText(text, maxBytes = 500) {
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = "";
  for (const token of text.trim().split(/(\s+)/)) {
    if (encoder.encode(chunk + token).length <= maxBytes) {
      chunk += token;
      continue;
    }
    if (chunk.trim()) chunks.push(chunk.trim());
    chunk = "";
    for (const char of token) {
      if (encoder.encode(chunk + char).length > maxBytes) {
        if (chunk.trim()) chunks.push(chunk.trim());
        chunk = "";
      }
      chunk += char;
    }
  }
  if (chunk.trim()) chunks.push(chunk.trim());
  return chunks;
}

export const cleanEpisodeText = (text) => typeof text === "string"
  ? text.replace(/\s+/g, " ").trim() : "";

export function differsFromEnglish(text, english) {
  const value = cleanEpisodeText(text);
  return Boolean(value) && (!cleanEpisodeText(english)
    || value.toLocaleLowerCase() !== cleanEpisodeText(english).toLocaleLowerCase());
}

export function createRequestQueue(limit = 3) {
  let active = 0;
  const pending = [];
  const drain = () => {
    while (active < limit && pending.length) {
      const { task, resolve, reject } = pending.shift();
      active++;
      Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; drain(); });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    drain();
  });
}
