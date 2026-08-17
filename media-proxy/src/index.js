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
]);

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

  // Release assets do not need query parameters. Remove them to keep the cache key stable.
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

/** Dean Edwards / JW packer: eval(function(p,a,c,k,e,d){...}('p',a,c,'k0|k1'.split('|'))) */
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

/**
 * Extrae la mejor URL de stream limpia del HTML del embed (JWPlayer packer / sources).
 */
export function extractCleanStreamFromHtml(html) {
  if (!html || typeof html !== "string") return null;

  const bags = [html];
  const unpacked = unpackDeanEdwards(html);
  if (unpacked) bags.push(unpacked);

  // file:"https://...m3u8..."
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

  // dedupe
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
  // GitHub a veces responde mejor con un UA de navegador.
  headers.set(
    "User-Agent",
    request.headers.get("User-Agent")
      || "Mozilla/5.0 (compatible; ColevanaMediaProxy/1.0)",
  );
  return headers;
}

function buildResponseHeaders(upstreamResponse, request, env, upstreamUrl) {
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

  return jsonResponse(request, env, 200, {
    stream,
    embed: embedUrl.href,
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

  const headers = buildResponseHeaders(upstreamResponse, request, env, upstreamUrl);
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

  if (requestUrl.pathname === "/video") {
    return handleVideo(request, env, requestUrl);
  }

  return jsonResponse(request, env, 404, "not_found");
}

export default {
  fetch: handleRequest,
};