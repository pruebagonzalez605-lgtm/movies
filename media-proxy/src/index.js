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

const STREAM_AD_HINT =
  /preroll|midroll|postroll|aviator|\bad\b|ads?[._/-]|advert|publicidad|promo|vast|ima|betwinner|anuncio/i;

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

async function handleResolveStream(request, env, requestUrl) {
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

  let html;
  try {
    const upstream = await fetch(embedUrl.href, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        Referer: `https://${embedUrl.hostname}/`,
      },
    });
    if (!upstream.ok) {
      return jsonResponse(request, env, 502, `embed_fetch_failed_${upstream.status}`);
    }
    html = await upstream.text();
  } catch {
    return jsonResponse(request, env, 502, "embed_fetch_unavailable");
  }

  const stream = extractCleanStreamFromHtml(html);
  if (!stream) {
    return jsonResponse(request, env, 404, "stream_not_found");
  }

  // Devolvemos también la URL ya proxificada para que el cliente no pegue al CDN directo.
  const proxyBase = new URL(request.url).origin;
  const proxied = `${proxyBase}/proxy-hls?url=${encodeURIComponent(stream)}&embed=${encodeURIComponent(embedUrl.href)}`;

  return jsonResponse(request, env, 200, {
    stream,
    proxied,
    embed: embedUrl.href,
  });
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

  // Embed opcional: visita previa para cookies / contexto de hotlink
  let embedReferer = "https://vimeos.net/";
  let embedOrigin = "https://vimeos.net";
  let cookieHeader = "";
  const embedParam = requestUrl.searchParams.get("embed");
  if (embedParam) {
    try {
      const embedUrl = validateEmbedUrl(embedParam);
      embedReferer = embedUrl.href;
      embedOrigin = embedUrl.origin;
      const embedRes = await fetch(embedUrl.href, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
      });
      // Workers: getSetCookie() si existe
      const setCookies = typeof embedRes.headers.getSetCookie === "function"
        ? embedRes.headers.getSetCookie()
        : [];
      if (setCookies.length) {
        cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
      } else {
        const sc = embedRes.headers.get("set-cookie");
        if (sc) cookieHeader = sc.split(",").map((p) => p.split(";")[0].trim()).join("; ");
      }
      // consumir body para no colgar
      try { await embedRes.arrayBuffer(); } catch (_) {}
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

  const headers = buildUpstreamHeaders(request);
  headers.set("Referer", embedReferer);
  // Algunos CDN 403 si Origin no es el esperado; otros 403 si viene.
  // Probamos con Origin del embed.
  headers.set("Origin", embedOrigin);
  headers.set(
    "Accept",
    upstreamUrl.pathname.includes(".m3u8")
      ? "application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8"
      : "*/*",
  );
  if (cookieHeader) headers.set("Cookie", cookieHeader);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl.href, {
      method: request.method,
      headers,
      redirect: "follow",
    });
  } catch {
    return jsonResponse(request, env, 502, "hls_upstream_unavailable");
  }

  // Si 403, reintentar sin Origin y con mirrors de host/path
  if (upstreamResponse.status === 403) {
    const altUrls = [];
    try {
      const headers2 = buildUpstreamHeaders(request);
      headers2.set("Referer", embedReferer);
      headers2.set(
        "Accept",
        upstreamUrl.pathname.includes(".m3u8")
          ? "application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8"
          : "*/*",
      );
      if (cookieHeader) headers2.set("Cookie", cookieHeader);

      const srv = upstreamUrl.searchParams.get("srv");
      if (srv) {
        const a = new URL(upstreamUrl.href);
        a.hostname = `${srv}.vimeos.net`;
        altUrls.push(a.href);
      }
      // urlset → _h / _n
      const um = upstreamUrl.pathname.match(/^(.*\/)([A-Za-z0-9]+)_,([^/]+),\.(urlset)\/master\.m3u8$/i);
      if (um) {
        const root = um[1];
        const code = um[2];
        for (const q of um[3].split(",").filter(Boolean).slice(0, 2)) {
          const a = new URL(upstreamUrl.href);
          a.pathname = `${root}${code}_${q}/master.m3u8`;
          altUrls.push(a.href);
          if (srv) {
            const b = new URL(a.href);
            b.hostname = `${srv}.vimeos.net`;
            altUrls.push(b.href);
          }
        }
      }

      const tryUrls = [upstreamUrl.href, ...altUrls];
      for (const tryUrl of tryUrls) {
        upstreamResponse = await fetch(tryUrl, {
          method: request.method,
          headers: headers2,
          redirect: "follow",
        });
        if (upstreamResponse.ok) {
          upstreamUrl = new URL(tryUrl);
          break;
        }
      }
    } catch {
      return jsonResponse(request, env, 502, "hls_upstream_unavailable");
    }
  }

  const proxyBase = new URL(request.url).origin;
  const contentType = (upstreamResponse.headers.get("Content-Type") || "").toLowerCase();
  const isPlaylist =
    upstreamUrl.pathname.includes(".m3u8")
    || contentType.includes("mpegurl")
    || contentType.includes("m3u8");

  if (isPlaylist && request.method === "GET" && upstreamResponse.ok) {
    const textBody = await upstreamResponse.text();
    // Reescribir conservando embed en las URLs hijas
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
  outHeaders.set("Cache-Control", "public, max-age=60");

  return new Response(request.method === "HEAD" ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
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
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request),
      redirect: "follow",
    });
  } catch {
    return jsonResponse(request, env, 502, "upstream_unavailable");
  }

  const headers = buildVideoResponseHeaders(upstreamResponse, request, env, upstreamUrl);
  return new Response(request.method === "HEAD" ? null : upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

export async function handleRequest(request, env = {}) {
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === "/health") {
    return new Response("ok", {
      status: 200,
      headers: { ...corsHeaders(request, env), "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (requestUrl.pathname === "/resolve-stream") {
    return handleResolveStream(request, env, requestUrl);
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
