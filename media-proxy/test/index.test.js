import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, validateUpstream, stripAdSegmentsFromPlaylist } from "../src/index.js";

const env = {
  ALLOWED_GITHUB_OWNER: "pruebagonzalez605-lgtm",
  ALLOWED_GITHUB_REPO: "movies",
  ALLOWED_SITE_ORIGIN: "https://colevana.com",
};

test("accepts only configured GitHub Release assets", () => {
  const url = validateUpstream(
    "https://github.com/pruebagonzalez605-lgtm/movies/releases/download/1.2/MJU.mp4",
    env,
  );
  assert.equal(url.hostname, "github.com");
  assert.throws(() => validateUpstream("https://example.com/video.mp4", env), /forbidden_url/);
  assert.throws(
    () => validateUpstream("https://github.com/another/repo/releases/download/v1/video.mp4", env),
    /forbidden_url/,
  );
});

test("forwards Range and rewrites media headers without buffering", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  let receivedRequest;
  globalThis.fetch = async (url, options) => {
    receivedRequest = { url: url.href, options };
    return new Response(new Uint8Array([1, 2]), {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=MJU.mp4",
        "Content-Range": "bytes 0-1/100",
        "Content-Length": "2",
        "Accept-Ranges": "bytes",
      },
    });
  };

  const upstream = "https://github.com/pruebagonzalez605-lgtm/movies/releases/download/1.2/MJU.mp4";
  const request = new Request(`https://proxy.example/video?url=${encodeURIComponent(upstream)}`, {
    headers: { Range: "bytes=0-1", Origin: "https://colevana.com" },
  });
  const response = await handleRequest(request, env);

  assert.equal(receivedRequest.options.headers.get("Range"), "bytes=0-1");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Type"), "video/mp4");
  assert.match(response.headers.get("Content-Disposition"), /^inline;/);
  assert.equal(response.headers.get("Content-Range"), "bytes 0-1/100");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://colevana.com");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2]);
});

test("rejects unsupported methods and arbitrary destinations", async () => {
  const post = await handleRequest(new Request("https://proxy.example/video", { method: "POST" }), env);
  assert.equal(post.status, 405);

  const bad = await handleRequest(new Request(
    `https://proxy.example/video?url=${encodeURIComponent("https://example.com/a.mp4")}`,
  ), env);
  assert.equal(bad.status, 400);
});

test("stripAdSegmentsFromPlaylist removes CUE-OUT ad breaks", () => {
  const manifest = [
    "#EXTM3U",
    "#EXTINF:6.0,",
    "content1.ts",
    "#EXT-X-CUE-OUT:30",
    "#EXTINF:6.0,",
    "https://ads.example.com/ad1.ts",
    "#EXTINF:6.0,",
    "https://ads.example.com/ad2.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.0,",
    "content2.ts",
  ].join("\n");

  const { text, removedCount } = stripAdSegmentsFromPlaylist(manifest, "https://cdn.example.com/master.m3u8");
  assert.equal(removedCount, 2);
  assert.ok(!text.includes("ads.example.com"));
  assert.ok(text.includes("content1.ts"));
  assert.ok(text.includes("content2.ts"));
});

test("stripAdSegmentsFromPlaylist removes segments matching STREAM_AD_HINT even without CUE markers", () => {
  const manifest = [
    "#EXTM3U",
    "#EXTINF:6.0,",
    "seg1.ts",
    "#EXTINF:2.0,",
    "https://cdn.example.com/preroll_123.ts",
    "#EXTINF:6.0,",
    "seg2.ts",
  ].join("\n");

  const { text, removedCount } = stripAdSegmentsFromPlaylist(manifest, "https://cdn.example.com/master.m3u8");
  assert.equal(removedCount, 1);
  assert.ok(!text.includes("preroll_123.ts"));
  assert.ok(text.includes("seg1.ts"));
  assert.ok(text.includes("seg2.ts"));
});

test("/proxy-hls strips ad segments before rewriting URLs through the proxy", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(
    [
      "#EXTM3U",
      "#EXTINF:6.0,",
      "seg1.ts",
      "#EXT-X-CUE-OUT:15",
      "#EXTINF:6.0,",
      "https://ads.example.com/ad1.ts",
      "#EXT-X-CUE-IN",
      "#EXTINF:6.0,",
      "seg2.ts",
    ].join("\n"),
    { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } },
  );

  const upstream = "https://vimeos.net/master.m3u8";
  const request = new Request(
    `https://proxy.example/proxy-hls?url=${encodeURIComponent(upstream)}`,
    { headers: { Origin: "https://colevana.com" } },
  );
  const response = await handleRequest(request, env);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.ok(!body.includes("ads.example.com"), "no debe quedar la URL del anuncio");
  assert.ok(body.includes("/proxy-hls?url="), "los segmentos reales siguen pasando por el proxy");
});

test("/resolve-stream caches successful lookups", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("<script>file: \"https://vimeos.net/master.m3u8\"</script>", { status: 200 });
  };

  // Simula el Cache API de Cloudflare (no existe en Node).
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(req) { return store.get(req.url) || null; },
      async put(req, res) { store.set(req.url, res.clone ? res.clone() : res); },
    },
  };
  context.after(() => { delete globalThis.caches; });

  const embed = "https://goodstream.one/e/abc123";
  const request = () => new Request(
    `https://proxy.example/resolve-stream?url=${encodeURIComponent(embed)}`,
    { headers: { Origin: "https://colevana.com" } },
  );

  const first = await handleRequest(request(), env);
  assert.equal(first.status, 200);
  const second = await handleRequest(request(), env);
  assert.equal(second.status, 200);

  assert.equal(fetchCalls, 1, "la segunda consulta debe salir de la cache, sin pegarle de nuevo al embed");
});

test("/video responds with a clear reason when the upstream never answers", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });

  // No hace falta esperar el timeout real (15s): al servidor le da igual
  // si el AbortError vino del temporizador de fetchWithTimeout o de otra
  // causa, asi que el mock lo simula de una para que el test sea rapido.
  globalThis.fetch = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };

  const upstream = "https://github.com/pruebagonzalez605-lgtm/movies/releases/download/1.2/MJU.mp4";
  const request = new Request(`https://proxy.example/video?url=${encodeURIComponent(upstream)}`, {
    headers: { Origin: "https://colevana.com" },
  });

  const response = await handleRequest(request, env);
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, "upstream_timeout");
});
