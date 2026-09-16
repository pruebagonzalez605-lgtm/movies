const RELEASE_PATH_MARKER = "/releases/download/";
const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
];

/** Dominios de embeds de los que se puede extraer un m3u8 limpio. */
const EMBED_HOSTS = new Set([
  "vimeos.net",
  "www.vimeos.net",
  "goodstream.one",
  "www.goodstream.one",
  "hlswish.com",
  "www.hlswish.com",
  "vimeus.com",
  "www.vimeus.com",
]);

/**
 * CDNs de video permitidos para /proxy-hls (anti open-proxy).
 * Incluye hosts vistos en embeds Vimeos / GoodStream / HLSWish.
 */
function isAllowedHlsHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;

  // Dominios base y cualquier subdominio (s12.vimeos.net, p2.vimeos.zip, etc.)
  const baseDomains = [
    "vimeos.net",
    "vimeos.zip",
    "goodstream.one",
    "hlswish.com",
    "vimeus.com",
    "lamovie.link",
    "ggpick.com",
  ];
  for (const d of baseDomains) {
    if (h === d || h.endsWith("." + d)) return true;
  }

  // Patrones frecuentes de CDN de estos hosts
  if (/^s\d+\./.test(h) && h.includes("vimeos")) return true;
  if (/^p\d+\./.test(h) && h.includes("vimeos")) return true;
  if (h.includes("vimeos") || h.includes("goodstream") || h.includes("hlswish")) return true;

  return false;
}

/**
 * CDNs que bloquean IPs de datacenter (Cloudflare Workers).
 * Ante el primer 403 no tiene sentido reintentar headers/mirrors ni self-heal:
 * el navegador del usuario (IP residencial) sí puede, el Worker no.
 */
function isCdnIpBlockedHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (!h) return false;
  return (
    h.includes("vimeos") ||
    h.includes("goodstream") ||
    h.includes("hlswish")
  );
}

const STREAM_AD_HINT =
  /preroll|midroll|postroll|aviator|\bad\b|ads?[._/-]|advert|publicidad|promo|vast|ima|betwinner|anuncio/i;

/**
 * fetch() con limite de tiempo para la fase de conexion/cabeceras.
 *
 * El limite solo cubre "hasta que llegan las cabeceras": fetch() en Workers
 * resuelve la promesa apenas el upstream responde el status/headers, antes
 * de leer el body, asi que el timer se cancela ahi y NO corta streams
 * largos (el video o el m3u8 siguen bajando despues sin limite). Antes,
 * cualquier upstream que se colgara (GitHub, un CDN de un embed muerto)
 * dejaba la request del worker esperando indefinidamente, y con eso la
 * pantalla de "Cargando..." del reproductor tambien quedaba trabada sin
 * que el cliente pudiera saber que reintentar.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const configuredOrigins = env.ALLOWED_SITE_ORIGIN || "https://colevana.com";
  const allowedOrigins = configuredOrigins.split(",").map((value) => value.trim()).filter(Boolean);
  const origin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified",
    "Access-Control-Max-Age": "86400",
    "Cross-Origin-Resource-Policy": "cross-origin",
    Vary: "Origin",
  };
}

function jsonResponse(request, env, status, body) {
  const payload = typeof body === "string" ? { error: body } : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function validateUpstream(rawUrl, env) {
  if (!rawUrl) throw new Error("missing_url");

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_url");
  }

  if (url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.port
    || url.username
    || url.password
    || url.hash) {
    throw new Error("forbidden_url");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = env.ALLOWED_GITHUB_OWNER || "pruebagonzalez605-lgtm";
  const repo = env.ALLOWED_GITHUB_REPO || "movies";
  const isReleaseAsset = segments.length >= 6
    && segments[0].toLowerCase() === owner.toLowerCase()
    && segments[1].toLowerCase() === repo.toLowerCase()
    && segments[2] === "releases"
    && segments[3] === "download"
    && url.pathname.includes(RELEASE_PATH_MARKER);

  if (!isReleaseAsset) throw new Error("forbidden_url");

  url.search = "";
  url.hash = "";
  return url;
}

export function validateEmbedUrl(rawUrl) {
  if (!rawUrl) throw new Error("missing_embed_url");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_embed_url");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new Error("forbidden_embed_url");
  }
  if (!EMBED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("forbidden_embed_host");
  }
  return url;
}

export function validateHlsUpstream(rawUrl) {
  if (!rawUrl) throw new Error("missing_hls_url");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid_hls_url");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new Error("forbidden_hls_url");
  }
  if (!isAllowedHlsHost(url.hostname)) {
    throw new Error("forbidden_hls_host");
  }
  return url;
}

/** Dean Edwards / JW packer */
function unpackDeanEdwards(html) {
  const re = /eval\(function\(p,a,c,k,e,d\)\{while\(c--\)if\(k\[c\]\)p=p\.replace\(new RegExp\('\\\\b'\+c\.toString\(a\)\+'\\\\b','g'\),k\[c\]\);return p\}\('((?:\\'|[^'])*)',(\d+),(\d+),'((?:\\'|[^'])*)'\.split\('\|'\)\)\)/;
  const m = html.match(re);
  if (!m) return null;

  let p = m[1].replace(/\\'/g, "'");
  const a = Number(m[2]);
  const cTotal = Number(m[3]);
  const k = m[4].split("|");

  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function toBase(n, base) {
    if (n === 0) return "0";
    let out = "";
    let x = n;
    while (x > 0) {
      out = digits[x % base] + out;
      x = Math.floor(x / base);
    }
    return out;
  }

  for (let i = cTotal - 1; i >= 0; i -= 1) {
    if (k[i]) {
      const token = toBase(i, a);
      p = p.replace(new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), k[i]);
    }
  }
  return p;
}

function collectM3u8Candidates(text) {
  if (!text) return [];
  const candidates = [];
  const re = /https:\/\/[a-z0-9.-]+\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    let url = match[0]
      .replace(/\\u0026/g, "&")
      .replace(/\\u002f/gi, "/")
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/[,;]+$/, "");
    if (STREAM_AD_HINT.test(url)) continue;
    candidates.push(url);
  }
  return candidates;
}

export function extractCleanStreamFromHtml(html) {
  if (!html || typeof html !== "string") return null;

  const bags = [html];
  const unpacked = unpackDeanEdwards(html);
  if (unpacked) bags.push(unpacked);

  for (const bag of bags) {
    const fileRe = /file\s*:\s*"([^"]+\.m3u8[^"]*)"/gi;
    let fm;
    while ((fm = fileRe.exec(bag)) !== null) {
      bags.push(fm[1]);
    }
  }

  const candidates = [];
  for (const bag of bags) {
    candidates.push(...collectM3u8Candidates(bag));
  }

  const seen = new Set();
  const unique = [];
  for (const u of candidates) {
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }

  if (!unique.length) return null;

  unique.sort((a, b) => {
    const score = (u) =>
      (/master\.m3u8/i.test(u) ? 4 : 0)
      + (/urlset/i.test(u) ? 2 : 0)
      + (/\.m3u8/i.test(u) ? 1 : 0);
    return score(b) - score(a);
  });

  return unique[0];
}

function sanitizeFilename(value) {
  if (!value) return "";
  return String(value)
    .replace(/["\r\n]/g, "")
    .replace(/[\\/]/g, "-")
    .slice(0, 200);
}

function buildUpstreamHeaders(request) {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    "User-Agent",
    request.headers.get("User-Agent")
      || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  return headers;
}

function buildVideoResponseHeaders(upstreamResponse, request, env, upstreamUrl) {
  const headers = new Headers(upstreamResponse.headers);
  const requestUrl = new URL(request.url);
  const wantsDownload = requestUrl.searchParams.get("download") === "1";
  const requestedFilename = sanitizeFilename(requestUrl.searchParams.get("filename"));
  const fallbackFilename = decodeURIComponent(upstreamUrl.pathname.split("/").pop() || "video.mp4")
    .replace(/["\r\n]/g, "");
  const filename = requestedFilename || fallbackFilename;

  headers.set("Content-Type", "video/mp4");
  headers.set("Content-Disposition", `${wantsDownload ? "attachment" : "inline"}; filename="${filename}"`);
  headers.set("Accept-Ranges", upstreamResponse.headers.get("Accept-Ranges") || "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Set-Cookie");

  for (const [name, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(name, value);
  }
  return headers;
}

/**
 * Quita del manifiesto HLS los tramos de publicidad insertados del lado del
 * servidor (SSAI / SCTE-35), ademas del filtro que ya existia en
 * extractCleanStreamFromHtml (que solo decidia QUE m3u8 elegir dentro del
 * HTML del embed, pero no tocaba el contenido del m3u8 ya elegido).
 *
 * Es muy comun que un manifiesto "limpio" en apariencia tenga, en medio del
 * contenido real, un bloque de 2-4 segmentos de otro CDN (el anuncio) entre
 * dos marcas de discontinuidad. Antes esos segmentos pasaban de largo hasta
 * el reproductor.
 *
 * Estrategia (conservadora: ante la duda, se deja el segmento):
 *   1. Todo lo delimitado por #EXT-X-CUE-OUT ... #EXT-X-CUE-IN, o por un
 *      #EXT-X-DATERANGE cuyo CLASS mencione publicidad, se descarta entero:
 *      es la señal explicita del proveedor de "esto es un corte".
 *   2. Cualquier segmento individual cuya URL matchee STREAM_AD_HINT se
 *      descarta igual, para los proveedores que no marcan el corte.
 */
export function stripAdSegmentsFromPlaylist(manifestText, baseUrl) {
  const AD_DATERANGE_CLASS = /CLASS="[^"]*ad[^"]*"/i;
  const lines = manifestText.split("\n");
  const out = [];
  let removedCount = 0;
  let inAdBreak = false;
  let pendingExtinf = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^#EXT-X-CUE-OUT/i.test(trimmed)
      || (/^#EXT-X-DATERANGE/i.test(trimmed) && AD_DATERANGE_CLASS.test(trimmed))) {
      inAdBreak = true;
      pendingExtinf = null;
      continue;
    }
    if (/^#EXT-X-CUE-IN/i.test(trimmed)) {
      inAdBreak = false;
      continue;
    }
    if (inAdBreak) {
      if (trimmed && !trimmed.startsWith("#")) removedCount += 1;
      continue;
    }

    if (/^#EXTINF/i.test(trimmed)) {
      pendingExtinf = line;
      continue;
    }

    if (trimmed && !trimmed.startsWith("#")) {
      let target = trimmed;
      try {
        target = new URL(trimmed, baseUrl).href;
      } catch {
        // URL relativa rara; se evalua tal cual vino.
      }
      if (STREAM_AD_HINT.test(target)) {
        removedCount += 1;
        pendingExtinf = null;
        continue;
      }
      if (pendingExtinf) out.push(pendingExtinf);
      pendingExtinf = null;
      out.push(line);
      continue;
    }

    out.push(line);
  }

  return { text: out.join("\n"), removedCount };
}

/** Reescribe URLs absolutas/relativas de un manifiesto HLS para pasar por /proxy-hls */
function rewriteM3u8(manifestText, manifestUrl, proxyBase) {
  const base = new URL(manifestUrl);
  return manifestText.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      // URI="..." en EXT-X-MEDIA / KEY / etc.
      return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
        try {
          const abs = new URL(uri, base).href;
          return `URI="${proxyBase}/proxy-hls?url=${encodeURIComponent(abs)}"`;
        } catch {
          return `URI="${uri}"`;
        }
      });
    }
    try {
      const abs = new URL(trimmed, base).href;
      return `${proxyBase}/proxy-hls?url=${encodeURIComponent(abs)}`;
    } catch {
      return line;
    }
  }).join("\n");
}

async function handleResolveStream(request, env, requestUrl, ctx) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (request.method !== "GET") {
    return jsonResponse(request, env, 405, "method_not_allowed");
  }

  let embedUrl;
  try {
    embedUrl = validateEmbedUrl(requestUrl.searchParams.get("url"));
  } catch (error) {
    return jsonResponse(request, env, 400, error.message);
  }

  // Cachea el resultado (5 min) por URL de embed: resolverlo implica bajar
  // el HTML entero de la pagina del proveedor y correrle una regex encima,
  // que es la parte mas lenta de todo el arranque del reproductor. Si dos
  // personas (o la misma, al reintentar) piden el mismo embed poco despues,
  // la segunda vez responde de una y el "Cargando..." dura una fraccion.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = cache ? new Request(requestUrl.toString(), { method: "GET" }) : null;
  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  let html;
  try {
    const upstream = await fetchWithTimeout(embedUrl.href, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        Referer: `https://${embedUrl.hostname}/`,
      },
    }, 7000);
    if (!upstream.ok) {
      return jsonResponse(request, env, 502, `embed_fetch_failed_${upstream.status}`);
    }
    html = await upstream.text();
  } catch (error) {
    const reason = error?.name === "AbortError" ? "embed_fetch_timeout" : "embed_fetch_unavailable";
    return jsonResponse(request, env, 502, reason);
  }

  const stream = extractCleanStreamFromHtml(html);
  if (!stream) {
    return jsonResponse(request, env, 404, "stream_not_found");
  }

  // Devolvemos también la URL ya proxificada para que el cliente no pegue al CDN directo.
  const proxyBase = new URL(request.url).origin;
  const proxied = `${proxyBase}/proxy-hls?url=${encodeURIComponent(stream)}&embed=${encodeURIComponent(embedUrl.href)}`;

  const response = jsonResponse(request, env, 200, {
    stream,
    proxied,
    embed: embedUrl.href,
  });

  if (cache && cacheKey) {
    const toCache = response.clone();
    toCache.headers.set("Cache-Control", "public, max-age=300");
    const putPromise = cache.put(cacheKey, toCache);
    if (ctx?.waitUntil) ctx.waitUntil(putPromise);
    else await putPromise.catch(() => {});
  }

  return response;
}

/**
 * Variantes de una misma URL de m3u8 que suelen resolver al mismo contenido
 * (mismo host con "srv=" distinto, o las variantes de calidad "_h"/"_n" del
 * patron ".../CODE_,n,h,.urlset/master.m3u8"). Se prueban todas antes de
 * darse por vencido: cual anda depende del CDN especifico y cambia de un
 * link firmado a otro.
 */
function buildMirrorCandidates(url) {
  const candidates = [url.href];
  try {
    const srv = url.searchParams.get("srv");
    if (srv) {
      const a = new URL(url.href);
      a.hostname = `${srv}.vimeos.net`;
      candidates.push(a.href);
    }
    const um = url.pathname.match(
      /^(.*\/)([A-Za-z0-9]+)_,([^/]+),\.(urlset)\/master\.m3u8$/i,
    );
    if (um) {
      const [, root, code, quals] = um;
      for (const q of quals.split(",").filter(Boolean).slice(0, 2)) {
        const a = new URL(url.href);
        a.pathname = `${root}${code}_${q}/master.m3u8`;
        candidates.push(a.href);
        if (srv) {
          const b = new URL(a.href);
          b.hostname = `${srv}.vimeos.net`;
          candidates.push(b.href);
        }
      }
    }
  } catch (_) {
    // Si el patron no matchea, se prueba solo la URL tal cual vino.
  }
  return candidates;
}

/**
 * Prueba cada combinacion de headers contra cada URL candidata, en orden,
 * hasta que una responda ok. Devuelve la respuesta y la URL que funciono, o
 * null si ninguna sirvio (se queda con el ultimo intento "no 404" para
 * poder reportar el motivo real, tipico un 403 del CDN).
 *
 * Si el CDN es de la familia vimeos/goodstream/hlswish y responde 403,
 * corta de inmediato: esos hosts bloquean IPs de datacenter y más
 * intentos solo alargan el "Cargando..." del player.
 */
async function attemptPlaylistFetch(candidateUrls, headerBuilders, method, timeoutMs = 7000) {
  let best = null;
  for (const buildHeaders of headerBuilders) {
    const headers = buildHeaders();
    for (const tryUrl of candidateUrls) {
      try {
        const res = await fetchWithTimeout(tryUrl, { method, headers, redirect: "follow" }, timeoutMs);
        if (res.ok) return { response: res, usedUrl: tryUrl };

        if (!best || res.status !== 404) best = { response: res, usedUrl: tryUrl };

        // Primer 403 de CDN anti-datacenter → definitivo, no seguir
        if (res.status === 403) {
          try {
            if (isCdnIpBlockedHost(new URL(tryUrl).hostname)) {
              console.log(
                "[proxy-hls] still 403 (cdn blocks datacenter IP)",
                tryUrl,
              );
              return best;
            }
          } catch (_) {
            // URL malformada rara; seguir con el resto de candidatos
          }
        }
      } catch (_) {
        // Timeout u otro error de red: se sigue con el siguiente candidato.
      }
    }
  }
  return best;
}

async function handleProxyHls(request, env, requestUrl) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(request, env, 405, "method_not_allowed");
  }

  let upstreamUrl;
  try {
    upstreamUrl = validateHlsUpstream(requestUrl.searchParams.get("url"));
  } catch (error) {
    return jsonResponse(request, env, 400, error.message);
  }

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  let embedReferer = "https://vimeos.net/";
  let embedOrigin = "https://vimeos.net";
  let cookieHeader = "";
  const embedParam = requestUrl.searchParams.get("embed");

  if (embedParam) {
    try {
      const embedUrl = validateEmbedUrl(embedParam);
      embedReferer = embedUrl.href;
      embedOrigin = embedUrl.origin;

      // 1ª visita al embed (cookies de sesión)
      const embedRes = await fetchWithTimeout(embedUrl.href, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Upgrade-Insecure-Requests": "1",
        },
      }, 6000);

      const setCookies =
        typeof embedRes.headers.getSetCookie === "function"
          ? embedRes.headers.getSetCookie()
          : [];
      if (setCookies.length) {
        cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
      } else {
        const sc = embedRes.headers.get("set-cookie");
        if (sc) {
          cookieHeader = sc
            .split(/,(?=[^;]+?=)/)
            .map((p) => p.split(";")[0].trim())
            .filter(Boolean)
            .join("; ");
        }
      }
      try {
        await embedRes.arrayBuffer();
      } catch (_) {}
    } catch (_) {
      // seguir sin cookies
    }
  } else {
    const host = upstreamUrl.hostname.toLowerCase();
    if (host.includes("goodstream")) {
      embedReferer = "https://goodstream.one/";
      embedOrigin = "https://goodstream.one";
    } else if (host.includes("hlswish")) {
      embedReferer = "https://hlswish.com/";
      embedOrigin = "https://hlswish.com";
    }
  }

  const isM3u8 = upstreamUrl.pathname.includes(".m3u8");

  // Varias combinaciones de headers (orden: más “navegador real” primero)
  const headerAttempts = [
    // A) Navegador completo con Origin + cookies
    () => {
      const h = new Headers();
      h.set("User-Agent", UA);
      h.set("Accept", isM3u8
        ? "application/vnd.apple.mpegurl,application/x-mpegURL,application/octet-stream,*/*;q=0.8"
        : "*/*");
      h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
      h.set("Referer", embedReferer);
      h.set("Origin", embedOrigin);
      h.set("Sec-Fetch-Dest", isM3u8 ? "empty" : "video");
      h.set("Sec-Fetch-Mode", "cors");
      h.set("Sec-Fetch-Site", "cross-site");
      if (cookieHeader) h.set("Cookie", cookieHeader);
      return h;
    },
    // B) Sin Origin (algunos CDN 403 si viene Origin)
    () => {
      const h = new Headers();
      h.set("User-Agent", UA);
      h.set("Accept", isM3u8
        ? "application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8"
        : "*/*");
      h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
      h.set("Referer", embedReferer);
      if (cookieHeader) h.set("Cookie", cookieHeader);
      return h;
    },
    // C) Solo Referer del origen (sin path del embed)
    () => {
      const h = new Headers();
      h.set("User-Agent", UA);
      h.set("Accept", "*/*");
      h.set("Referer", embedOrigin + "/");
      if (cookieHeader) h.set("Cookie", cookieHeader);
      return h;
    },
    // D) Mínimo (último recurso)
    () => {
      const h = new Headers();
      h.set("User-Agent", UA);
      h.set("Accept", "*/*");
      h.set("Referer", embedReferer);
      return h;
    },
  ];

  // Mirrors de URL (host + variantes _h / _n)
  const candidateUrls = buildMirrorCandidates(upstreamUrl);

  let upstreamResponse = null;
  let usedUrl = upstreamUrl.href;

  const firstAttempt = await attemptPlaylistFetch(candidateUrls, headerAttempts, request.method);
  if (firstAttempt) {
    upstreamResponse = firstAttempt.response;
    usedUrl = firstAttempt.usedUrl;
  }

  // --- "Self-heal": la URL fallo en TODOS los mirrors ---
  // Estas URLs de m3u8 vienen firmadas (parametros tipo s=/e=/v= en la
  // query) y todo indica que la firma queda atada al momento/IP de la
  // resolucion original (la que hizo handleResolveStream). Si esa
  // resolucion y esta llamada a /proxy-hls terminan corriendo en distintos
  // nodos de Cloudflare (algo normal: cada request puede caer en un edge
  // distinto), la firma deja de ser valida y el CDN devuelve 403 SIEMPRE,
  // sin importar cuantos mirrors o combinaciones de headers se prueben.
  //
  // La solucion es volver a resolver el embed DESDE ACA (misma invocacion,
  // mismo request saliente) para conseguir una firma nueva atada a este
  // mismo contexto, y probarla antes de rendirse.
  //
  // EXCEPCION: si el 403 viene de un CDN que bloquea IPs de datacenter
  // (vimeos / goodstream / hlswish), el self-heal no puede ayudar: la
  // firma nueva también saldrá del mismo Worker y el CDN la rechazará
  // igual. En ese caso devolvemos 403 de inmediato para que el player
  // caiga al iframe sin más demora.
  const isIpBlocked403 =
    upstreamResponse?.status === 403 &&
    isCdnIpBlockedHost(upstreamUrl.hostname);

  const needsSelfHeal =
    !isIpBlocked403 &&
    (!upstreamResponse || !upstreamResponse.ok);

  if (needsSelfHeal && embedParam && isM3u8) {
    try {
      const embedUrl = validateEmbedUrl(embedParam);
      const freshHtml = await fetchWithTimeout(embedUrl.href, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          Referer: embedUrl.href,
        },
      }, 6000).then((res) => (res.ok ? res.text() : null));

      const freshStream = freshHtml ? extractCleanStreamFromHtml(freshHtml) : null;
      if (freshStream) {
        const freshUrl = validateHlsUpstream(freshStream);
        const freshCandidates = buildMirrorCandidates(freshUrl);
        // Solo los dos primeros juegos de headers (los mas propensos a
        // funcionar): esto ya es un segundo intento completo, no vale la
        // pena repetir los 4 x N combinaciones de nuevo.
        const healed = await attemptPlaylistFetch(freshCandidates, headerAttempts.slice(0, 2), request.method);
        if (healed?.response?.ok) {
          console.log("[proxy-hls] self-heal ok, firma renovada para", embedUrl.href);
          upstreamResponse = healed.response;
          usedUrl = healed.usedUrl;
        } else if (!upstreamResponse && healed) {
          upstreamResponse = healed.response;
          usedUrl = healed.usedUrl;
        }
      }
    } catch (err) {
      console.log("[proxy-hls] self-heal fallo:", err?.message || err);
    }
  }

  if (!upstreamResponse) {
    return jsonResponse(request, env, 502, "hls_upstream_unavailable");
  }

  upstreamUrl = new URL(usedUrl);

  // Si sigue en 403, devolver error claro (el player caerá al iframe)
  if (upstreamResponse.status === 403) {
    const reason = isCdnIpBlockedHost(upstreamUrl.hostname)
      ? "cdn blocks datacenter IP"
      : "forbidden";
    console.log("[proxy-hls] still 403", `(${reason})`, usedUrl, "cookies=", Boolean(cookieHeader));
    return jsonResponse(request, env, 403, "hls_forbidden_by_cdn");
  }

  if (!upstreamResponse.ok) {
    return jsonResponse(
      request,
      env,
      502,
      `hls_upstream_${upstreamResponse.status}`,
    );
  }

  const proxyBase = new URL(request.url).origin;
  const contentType = (upstreamResponse.headers.get("Content-Type") || "").toLowerCase();
  const isPlaylist =
    upstreamUrl.pathname.includes(".m3u8")
    || contentType.includes("mpegurl")
    || contentType.includes("m3u8");

  if (isPlaylist && request.method === "GET") {
    const rawBody = await upstreamResponse.text();

    // Primero se sacan los tramos de publicidad del manifiesto original
    // (las URLs ahi todavia son las reales del CDN, que es lo que
    // STREAM_AD_HINT sabe reconocer); recien despues se reescriben las
    // URLs restantes para que pasen por este mismo proxy.
    const { text: textBody, removedCount } = stripAdSegmentsFromPlaylist(rawBody, upstreamUrl);
    if (removedCount > 0) {
      console.log(`[proxy-hls] ${removedCount} segmento(s) publicitario(s) removido(s) de`, usedUrl);
    }

    const embedQ = embedParam ? `&embed=${encodeURIComponent(embedParam)}` : "";
    const rewritten = textBody.split("\n").map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gi, (_, uri) => {
          try {
            const abs = new URL(uri, upstreamUrl).href;
            return `URI="${proxyBase}/proxy-hls?url=${encodeURIComponent(abs)}${embedQ}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }
      try {
        const abs = new URL(trimmed, upstreamUrl).href;
        return `${proxyBase}/proxy-hls?url=${encodeURIComponent(abs)}${embedQ}`;
      } catch {
        return line;
      }
    }).join("\n");

    const outHeaders = new Headers();
    for (const [name, value] of Object.entries(corsHeaders(request, env))) {
      outHeaders.set(name, value);
    }
    outHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    outHeaders.set("Cache-Control", "no-store");
    outHeaders.set("X-Content-Type-Options", "nosniff");
    return new Response(rewritten, { status: 200, headers: outHeaders });
  }

  const outHeaders = new Headers(upstreamResponse.headers);
  outHeaders.delete("Set-Cookie");
  for (const [name, value] of Object.entries(corsHeaders(request, env))) {
    outHeaders.set(name, value);
  }
  if (!outHeaders.has("Content-Type")) {
    outHeaders.set("Content-Type", "application/octet-stream");
  }
  outHeaders.set("Cache-Control", "no-store");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: outHeaders,
  });
}

async function handleVideo(request, env, requestUrl) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse(request, env, 405, "method_not_allowed");
  }

  let upstreamUrl;
  try {
    upstreamUrl = validateUpstream(requestUrl.searchParams.get("url"), env);
  } catch (error) {
    return jsonResponse(request, env, 400, error.message);
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchWithTimeout(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      redirect: "follow",
    }, 15000);
  } catch (error) {
    const reason = error?.name === "AbortError" ? "upstream_timeout" : "upstream_unavailable";
    return jsonResponse(request, env, 502, reason);
  }

  const headers = buildVideoResponseHeaders(upstreamResponse, request, env, upstreamUrl);
  return new Response(request.method === "HEAD" ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export async function handleRequest(request, env = {}, ctx) {
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === "/health") {
    return new Response("ok", {
      status: 200,
      headers: { ...corsHeaders(request, env), "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (requestUrl.pathname === "/resolve-stream") {
    return handleResolveStream(request, env, requestUrl, ctx);
  }

  if (requestUrl.pathname === "/proxy-hls") {
    return handleProxyHls(request, env, requestUrl);
  }

  if (requestUrl.pathname === "/video") {
    return handleVideo(request, env, requestUrl);
  }

  return jsonResponse(request, env, 404, "not_found");
}

export default {
  fetch: handleRequest,
};
