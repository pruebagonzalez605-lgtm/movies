import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchLatestApkDownloadUrl,
  parseApkReleaseTag,
} from "../../src/scripts/config/app-distribution.js";
import {
  isNewerVersion,
  resolveInstalledVersion,
} from "../../src/scripts/services/update-checker.js";

function release(tag, { apk = true, draft = false, prerelease = false } = {}) {
  return {
    tag_name: tag,
    draft,
    prerelease,
    assets: apk ? [{ name: "app-debug.apk", browser_download_url: `https://example.com/${tag}.apk` }] : [],
  };
}

test("APK updates ignore movie releases, including a movie release with an APK asset", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify([
    release("1.37"),
    release("1.0.34"),
    release("1.0.35", { apk: false }),
    release("1.0.36", { draft: true }),
  ]), { status: 200 });

  assert.deepEqual(await fetchLatestApkDownloadUrl(), {
    version: "1.0.34",
    downloadUrl: "https://example.com/1.0.34.apk",
  });
  assert.equal(parseApkReleaseTag("1.37"), null);
  assert.equal(parseApkReleaseTag("1.0.29"), null);
  assert.equal(parseApkReleaseTag("1.0.35"), 35);
});

test("APK updates select the highest version across release pages", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    const releases = urls.length === 1
      ? Array.from({ length: 100 }, (_, index) => release(`1.${index + 1}`))
      : [release("1.0.34"), release("1.0.35"), release("1.0.36", { prerelease: true })];
    return new Response(JSON.stringify(releases), { status: 200 });
  };

  assert.deepEqual(await fetchLatestApkDownloadUrl(), {
    version: "1.0.35",
    downloadUrl: "https://example.com/1.0.35.apk",
  });
  assert.equal(urls.length, 2);
});

test("installed APK version takes priority over the live website version", () => {
  assert.equal(resolveInstalledVersion("1.0.33", "1.0.34", "1.0.35"), "1.0.33");
  assert.equal(resolveInstalledVersion(null, "1.0.33", "1.0.35"), "1.0.33");
  assert.equal(resolveInstalledVersion(null, null, "1.0.34"), "1.0.34");
  assert.equal(isNewerVersion("1.0.34", "1.0.33"), true);
  assert.equal(isNewerVersion("1.0.34", "1.0.34"), false);
  assert.equal(isNewerVersion("1.37", "1.0.34"), false);
});
