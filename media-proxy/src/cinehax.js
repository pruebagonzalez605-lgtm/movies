const ORIGIN = "https://play.cinehax.com";

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || !/[a-z]/i.test(url.hostname) || !url.hostname.includes(".")
      || /(^|\.)(localhost|local|internal)$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function cinehaxPath(params) {
  const id = Number(params.get("tmdb"));
  const type = params.get("type");
  if (!Number.isSafeInteger(id) || id <= 0) throw Error("invalid_tmdb");
  if (type === "movie") return `/embed/movie/${id}`;
  const season = Number(params.get("season"));
  const episode = Number(params.get("episode"));
  if (type !== "tv" || !params.has("season") || !params.has("episode")
    || !Number.isSafeInteger(season) || season < 0
    || !Number.isSafeInteger(episode) || episode <= 0) throw Error("invalid_episode");
  return `/embed/tv/${id}/${season}/${episode}`;
}

// Only the provider's public page/API are used. Verification walls remain in
// the original embed; they are never fetched or solved by this resolver.
export async function discoverCinehax(path, fetcher = fetch) {
  const deadline = AbortSignal.timeout(12000);
  const read = async (url, options = {}, json = false) => {
    const response = await fetcher(url, { ...options, redirect: "manual", signal: deadline });
    if (!response.ok) throw Error(`provider_${response.status}`);
    return json ? response.json() : response.text();
  };
  const html = await read(ORIGIN + path);
  const langs = JSON.parse(html.match(/var LANGS\s*=\s*([^\r\n]+);/)?.[1] || "{}");
  const tokenBlock = html.match(/var TOKEN\s*=\s*\{([\s\S]*?)\};/)?.[1] || "";
  const field = name => tokenBlock.match(new RegExp(name + ":\\s*[\"']([^\"']+)"))?.[1];
  const token = field("token"), validtime = field("validtime");
  const directStreams = [], embeds = [];
  // Keep requests bounded and prefer Spanish audio. Never cache signed links.
  const servers = ["latino", "es", "sub"].flatMap(language =>
    (langs[language]?.servers || []).map(server => ({ ...server, language }))).slice(0, 4);
  await Promise.all(servers.map(async server => {
    try {
      const result = server.play ? { codigo: 200, url: server.play }
        : token && validtime ? await read(ORIGIN + "/edge-data", {
          method: "POST", body: new URLSearchParams({ streaming: server.link, token, validtime }),
        }, true) : null;
      if (result?.codigo !== 200) return;
      const embed = publicUrl(result.url);
      server.embed = embed;
      const streams = [result.stream_url, result.cdn_url];
      if (embed?.startsWith(ORIGIN + "/clean-player/embed/")) {
        const cleanHtml = await read(embed);
        const configText = cleanHtml.match(/data-config="([^"]+)"/)?.[1];
        if (configText) {
          const config = JSON.parse(configText.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
          streams.push(config.src);
        }
      }
      server.streams = streams.map(publicUrl).filter(url => url && /\.(m3u8|mp4)(?:[?#]|$)/i.test(url));
    } catch { /* An unavailable server must not discard other results. */ }
  }));
  for (const server of servers) {
    directStreams.push(...(server.streams || []));
    if (server.embed) embeds.push({ url: server.embed, name: `${server.server || "Cinehax"} (${server.language === "latino" ? "Español Latino" : server.language === "es" ? "Español" : "Subtitulado"})` });
  }
  return { success: true, directStreams: [...new Set(directStreams)], embeds };
}
