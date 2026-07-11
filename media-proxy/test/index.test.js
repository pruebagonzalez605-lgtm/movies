import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, validateUpstream } from "../src/index.js";

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
