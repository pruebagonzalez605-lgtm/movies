const RELEASE_PATH_MARKER = "/releases/download/";
const FORWARDED_REQUEST_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
];

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigin = env.ALLOWED_SITE_ORIGIN || "https://colevana.com";
  const origin = requestOrigin === allowedOrigin ? allowedOrigin : allowedOrigin;
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

function jsonResponse(request, env, status, message) {
  return new Response(JSON.stringify({ error: message }), {
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

  // Release assets do not need query parameters. Removing them prevents a
  // caller from changing the canonical upstream request.
  url.search = "";
  return url;
}

function buildUpstreamHeaders(request) {
  const headers = new Headers({
    Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1",
    "Accept-Encoding": "identity",
  });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function buildResponseHeaders(upstreamResponse, request, env, upstreamUrl) {
  const headers = new Headers(upstreamResponse.headers);
  const filename = decodeURIComponent(upstreamUrl.pathname.split("/").pop() || "video.mp4")
    .replace(/["\r\n]/g, "");

  headers.set("Content-Type", "video/mp4");
  headers.set("Content-Disposition", `inline; filename="${filename}"`);
  headers.set("Accept-Ranges", upstreamResponse.headers.get("Accept-Ranges") || "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.delete("Set-Cookie");

  for (const [name, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(name, value);
  }
  return headers;
}

export async function handleRequest(request, env = {}) {
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === "/health") {
    return new Response("ok", {
      status: 200,
      headers: { ...corsHeaders(request, env), "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (requestUrl.pathname !== "/video") {
    return jsonResponse(request, env, 404, "not_found");
  }

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

export default {
  fetch: handleRequest,
};
