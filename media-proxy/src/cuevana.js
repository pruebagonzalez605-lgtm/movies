// Proveedor Cuevana (cuevana3w.pro).
//
// La pagina de cada pelicula/episodio lista sus servidores en atributos
// data-server. Los de audio latino van "cifrados" con un XOR de clave fija
// (la misma que usa su propio reproductor) y apuntan a hosts tipo XFS
// (morencius, filemoon, vibuxer...), que el reproductor monta en un iframe.
//
// El titulo se busca en el buscador del sitio y se confirma comparando el
// poster de cada resultado con las imagenes de TMDB del mismo id, para no
// reproducir otra serie/pelicula con nombre parecido.

const SITE = "https://cuevana3w.pro";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
// Clave publica de TMDB que ya usa el frontend (src/scripts/services/tmdb.js).
const PUBLIC_TMDB_KEY = "58dc4e2bb092932970cdd7af79434942";
const TOKEN_KEY = "a45f04ce-2394-47c3-b718-0ecd97ce51d6";
const TOKEN_SERVERS = {
  1: "https://morencius.com/v/",
  2: "https://filemoon.sx/e/",
  3: "https://vibuxer.com/e/",
  4: "https://dood.li/e/",
};

export function cuevanaRequest(params) {
  const tmdb = Number(params.get("tmdb"));
  const type = params.get("type");
  if (!Number.isSafeInteger(tmdb) || tmdb <= 0) throw Error("invalid_tmdb");
  if (type === "movie") return { tmdb, type };
  const season = Number(params.get("season"));
  const episode = Number(params.get("episode"));
  if (type !== "tv" || !Number.isSafeInteger(season) || season <= 0
    || !Number.isSafeInteger(episode) || episode <= 0) throw Error("invalid_episode");
  return { tmdb, type, season, episode };
}

export function decodeCuevanaServer(dataServer) {
  let url;
  try { url = new URL(dataServer.replace(/&amp;/g, "&")); } catch { return null; }
  const token = url.searchParams.get("token");
  const encoded = url.searchParams.get("v");
  let target = null;
  try {
    if (token && TOKEN_SERVERS[token[0]]) {
      const raw = atob(token.slice(1));
      let id = "";
      for (let i = 0; i < raw.length; i += 1) {
        id += String.fromCharCode(raw.charCodeAt(i) ^ TOKEN_KEY.charCodeAt(i % TOKEN_KEY.length));
      }
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
      target = TOKEN_SERVERS[token[0]] + id;
    } else if (encoded) {
      target = atob(encoded);
    }
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Servidores de la pagina, agrupados por pestaña de idioma en orden. */
export function parseCuevanaServers(html) {
  const servers = [];
  const tabs = html.split(/<li class="tab-video-item">/).slice(1);
  for (const tab of tabs) {
    const label = (tab.match(/<div class="tab-item-name">\s*([^<]+?)\s*</)?.[1] || "").trim();
    const language = /latino/i.test(label) ? "latino" : /castellano|español|espanol/i.test(label) ? "es" : "sub";
    for (const match of tab.matchAll(/data-server="([^"]+)"><span>\s*([^<]*?)\s*<\/span>/g)) {
      const url = decodeCuevanaServer(match[1]);
      if (url) servers.push({ url, name: match[2] || "Cuevana", language });
    }
  }
  return servers;
}

function imageFile(path) {
  return String(path || "").split("/").pop();
}

async function tmdbInfo(req, apiKey, fetcher) {
  const kind = req.type === "movie" ? "movie" : "tv";
  const base = `https://api.themoviedb.org/3/${kind}/${req.tmdb}`;
  const get = async (url) => {
    const res = await fetcher(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw Error(`tmdb_${res.status}`);
    return res.json();
  };
  const [es, images] = await Promise.all([
    get(`${base}?api_key=${apiKey}&language=es-ES`),
    get(`${base}/images?api_key=${apiKey}`).catch(() => ({})),
  ]);
  const files = new Set([es.poster_path, es.backdrop_path,
    ...(images.posters || []).map((p) => p.file_path),
    ...(images.backdrops || []).map((p) => p.file_path)].filter(Boolean).map(imageFile));
  const titles = [...new Set([es.title, es.name, es.original_title, es.original_name].filter(Boolean))];
  return { titles, files };
}

async function readPage(url, fetcher, referer = `${SITE}/`) {
  const res = await fetcher(url, {
    redirect: "follow",
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "es-ES,es;q=0.9", Referer: referer },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw Error(`cuevana_${res.status}`);
  return res.text();
}

/** Busca el slug del sitio cuyo poster coincide con una imagen de TMDB. */
export function pickCuevanaSlug(searchHtml, section, files) {
  const pattern = new RegExp(`href="?${SITE.replace(/\./g, "\\.")}/${section}/([a-z0-9-]+)"?[^>]*>[\\s\\S]{0,400}?<img src=([^\\s>]+)`, "g");
  for (const match of searchHtml.matchAll(pattern)) {
    if (files.has(imageFile(match[2].replace(/"/g, "")))) return match[1];
  }
  return null;
}

export async function discoverCuevana(req, { apiKey = PUBLIC_TMDB_KEY, fetcher = fetch } = {}) {
  const section = req.type === "movie" ? "pelicula" : "serie";
  const { titles, files } = await tmdbInfo(req, apiKey, fetcher);

  let slug = null;
  for (const title of titles) {
    const html = await readPage(`${SITE}/explorar?s=${encodeURIComponent(title)}`, fetcher).catch(() => "");
    slug = pickCuevanaSlug(html, section, files);
    if (slug) break;
  }
  if (!slug) return { success: true, directStreams: [], embeds: [], reason: "title_not_found" };

  const pageUrl = req.type === "movie"
    ? `${SITE}/pelicula/${slug}`
    : `${SITE}/serie/${slug}/episodio-${req.season}x${req.episode}`;
  const servers = parseCuevanaServers(await readPage(pageUrl, fetcher));

  // Latino primero; dentro de cada idioma, en el orden del sitio.
  // No se extrae el m3u8: el CDN de estos servidores bloquea las IPs de
  // Cloudflare y el enlace queda firmado para quien lo pidio, asi que el
  // reproductor usa el iframe del servidor (ver getProviderSandbox).
  const order = { latino: 0, es: 1, sub: 2 };
  servers.sort((a, b) => order[a.language] - order[b.language]);

  return {
    success: true,
    page: pageUrl,
    directStreams: [],
    embeds: servers.map(({ url, name, language }) => ({ url, name, language })),
  };
}
