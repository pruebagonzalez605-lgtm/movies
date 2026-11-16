import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchLatestApkDownloadUrl,
  parseApkReleaseTag,
} from "../../src/scripts/config/app-distribution.js";
import { APP_VERSION } from "../../src/scripts/config/app-version.js";
import {
  isNewerVersion,
  resolveInstalledVersion,
} from "../../src/scripts/services/update-checker.js";

test("APK updates come from APP_VERSION, never from GitHub's Latest release", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new Error("Must not ask the GitHub API"); };

  assert.deepEqual(await fetchLatestApkDownloadUrl("1.0.36"), {
    version: "1.0.36",
    downloadUrl: "https://github.com/pruebagonzalez605-lgtm/movies/releases/download/1.0.36/app-debug.apk",
  });
  const current = await fetchLatestApkDownloadUrl();
  assert.equal(current.version, APP_VERSION);
  assert.equal(current.downloadUrl.endsWith(`/releases/download/${APP_VERSION}/app-debug.apk`), true);
});

test("movie and series release tags are never treated as APK versions", async () => {
  for (const tag of ["1.42", "1.37", "1.0.29", "", null, "1.0.x"]) {
    assert.deepEqual(await fetchLatestApkDownloadUrl(tag), { downloadUrl: null, version: null }, String(tag));
  }
  assert.equal(parseApkReleaseTag("1.42"), null);
  assert.equal(parseApkReleaseTag("1.0.35"), 35);
});

test("installed APK version takes priority over the live website version", () => {
  assert.equal(resolveInstalledVersion("1.0.33", "1.0.34", "1.0.35"), "1.0.33");
  assert.equal(resolveInstalledVersion(null, "1.0.33", "1.0.35"), "1.0.33");
  assert.equal(resolveInstalledVersion(null, null, "1.0.34"), "1.0.34");
  assert.equal(isNewerVersion("1.0.34", "1.0.33"), true);
  assert.equal(isNewerVersion("1.0.34", "1.0.34"), false);
  assert.equal(isNewerVersion("1.37", "1.0.34"), false);
});
