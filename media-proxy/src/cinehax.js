const LEGACY_ORIGIN = "https://play.cinehax.com";
const SITE_ORIGIN = "https://cinehax.com";

const CURRENT_EMBED_HOSTS = new Map([
  ["api.moviemaster.lat", "MovieMaster"],
  ["unlimplay.com", "UnlimPlay"],
  ["videoapi.la", "VideoAPI"],
  ["tukiplay.com", "TukiPlay"],
  ["facilitoplay.com", "FacilitoPlay"],
]);

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

async function discoverLegacyCinehax(path, fetcher) {
  const deadline = AbortSignal.timeout(12000);
  const read = async (url, options = {}, json = false) => {
    const response = await fetcher(url, { ...options, redirect: "manual", signal: deadline });
    if (!response.ok) throw Error(`provider_${response.status}`);
    return json ? response.json() : response.text();
  };
  const html = await read(LEGACY_ORIGIN + path);
  const langs = JSON.parse(html.match(/var LANGS\s*=\s*([^\r\n]+);/)?.[1] || "{}");
  const tokenBlock = html.match(/var TOKEN\s*=\s*\{([\s\S]*?)\};/)?.[1] || "";
  const field = name => tokenBlock.match(new RegExp(name + ":\\s*[\"']([^\"']+)"))?.[1];
  const token = field("token"), validtime = field("validtime");
  const directStreams = [], embeds = [];
  const servers = ["latino", "es", "sub"].flatMap(language =>
    (langs[language]?.servers || []).map(server => ({ ...server, language }))).slice(0, 4);
  await Promise.all(servers.map(async server => {
    try {
      const result = server.play ? { codigo: 200, url: server.play }
        : token && validtime ? await read(LEGACY_ORIGIN + "/edge-data", {
          method: "POST", body: new URLSearchParams({ streaming: server.link, token, validtime }),
        }, true) : null;
      if (result?.codigo !== 200) return;
      const embed = publicUrl(result.url);
      server.embed = embed;
      const streams = [result.stream_url, result.cdn_url];
      if (embed?.startsWith(LEGACY_ORIGIN + "/clean-player/embed/")) {
        const cleanHtml = await read(embed);
        const configText = cleanHtml.match(/data-config="([^\"]+)"/)?.[1];
        if (configText) {
          const config = JSON.parse(configText.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
          streams.push(config.src);
        }
      }
      server.streams = streams.map(publicUrl).filter(url => url && /\.(m3u8|mp4)(?:[?#]|$)/i.test(url));
    } catch { /* Un servidor no disponible no descarta los demás. */ }
  }));
  for (const server of servers) {
    directStreams.push(...(server.streams || []));
    if (server.embed) embeds.push({ url: server.embed, name: `${server.server || "Cinehax"} (${server.language === "latino" ? "Español Latino" : server.language === "es" ? "Español" : "Subtitulado"})` });
  }
  return { success: true, directStreams: [...new Set(directStreams)], embeds };
}

function currentSitePath(legacyPath) {
  const movie = legacyPath.match(/^\/embed\/movie\/(\d+)\/?$/);
  if (movie) return `/pelicula/${movie[1]}/`;
  const episode = legacyPath.match(/^\/embed\/tv\/(\d+)\/(\d+)\/(\d+)\/?$/);
  if (episode) return `/serie/${episode[1]}/temporada-${episode[2]}/episodio-${episode[3]}/`;
  throw Error("invalid_cinehax_path");
}

function parseCurrentEmbeds(html) {
  const embeds = [];
  const seen = new Set();
  for (const match of html.matchAll(/<button\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bdata-st\s*=\s*["']ok["']/i.test(tag)) continue;
    const raw = tag.match(/\bdata-url\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!raw) continue;

    let url;
    try {
      url = new URL(raw.replace(/&amp;/g, "&"));
    } catch { continue; }
    const name = CURRENT_EMBED_HOSTS.get(url.hostname.toLowerCase());
    if (!name || url.protocol !== "https:" || url.port || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    embeds.push({ url: url.href, name, resolveClean: true });
  }
  return embeds;
}

async function discoverCurrentCinehax(path, fetcher) {
  const pageUrl = SITE_ORIGIN + currentSitePath(path);
  const response = await fetcher(pageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      Referer: `${SITE_ORIGIN}/`,
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error(`cinehax_page_${response.status}`);
  const html = await response.text();
  return { success: true, directStreams: [], embeds: parseCurrentEmbeds(html) };
}

// Usa la API antigua mientras responda; si el proveedor la retiró, consulta
// su página pública actual, que publica los servidores activos en data-url.
export async function discoverCinehax(path, fetcher = fetch) {
  try {
    const legacy = await discoverLegacyCinehax(path, fetcher);
    if (legacy.directStreams.length || legacy.embeds.length) return legacy;
  } catch { /* La API vieja ya no está disponible: probar la página actual. */ }
  return discoverCurrentCinehax(path, fetcher);
}
