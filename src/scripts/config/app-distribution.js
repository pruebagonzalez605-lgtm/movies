export const APP_DISTRIBUTION_CONFIG = {
  // Usuario/organizacion y repositorio de GitHub donde se publican los
  // releases con el .apk adjunto (Settings > Releases del repo).
  githubOwner: "pruebagonzalez605-lgtm",
  githubRepo: "movies",
};

const { githubOwner, githubRepo } = APP_DISTRIBUTION_CONFIG;

// Pagina de releases, sirve como respaldo si la API de GitHub falla o
// si no se encuentra ningun release con un asset .apk adjunto.
export const RELEASES_PAGE_URL = `https://github.com/${githubOwner}/${githubRepo}/releases`;

// Peliculas y APK comparten repositorio. Solo los tags 1.0.x, desde
// 1.0.30, representan versiones instalables de la app.
const APK_TAG_PATTERN = /^v?1\.0\.(\d+)$/i;
const FIRST_APK_PATCH = 30;
const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 5;

export function parseApkReleaseTag(tag) {
  const match = typeof tag === "string" ? APK_TAG_PATTERN.exec(tag.trim()) : null;
  if (!match) return null;
  const patch = Number(match[1]);
  return Number.isSafeInteger(patch) && patch >= FIRST_APK_PATCH ? patch : null;
}

/**
 * Consulta la API publica de GitHub y devuelve la URL directa de descarga
 * del APK con la mayor version 1.0.x publicada.
 *
 * A proposito NO usamos el endpoint /releases/latest: ese endpoint de
 * GitHub devuelve el release marcado como "Latest", que puede ser una
 * pelicula (por ejemplo 1.37). Tampoco confiamos en el orden por fecha:
 * un release antiguo republicado no debe superar a una version mayor.
 */
export async function fetchLatestApkDownloadUrl() {
  let latest = null;

  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const apiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
    let response;
    try {
      response = await fetch(apiUrl, {
        headers: { Accept: "application/vnd.github+json" },
      });
    } catch (error) {
      if (latest) break;
      throw error;
    }
    if (!response.ok && latest) break;
    if (!response.ok) {
      throw new Error(`GitHub releases API respondio ${response.status}`);
    }

    const releases = await response.json();
    if (!Array.isArray(releases)) break;

    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const patch = parseApkReleaseTag(release.tag_name);
      if (patch === null || (latest && patch <= latest.patch)) continue;

      const assets = Array.isArray(release.assets) ? release.assets : [];
      const apkAsset = assets.find((asset) =>
        typeof asset.name === "string"
        && asset.name.toLowerCase().endsWith(".apk")
        && typeof asset.browser_download_url === "string"
      );
      if (apkAsset) {
        latest = {
          patch,
          downloadUrl: apkAsset.browser_download_url,
          version: release.tag_name,
        };
      }
    }

    if (releases.length < RELEASES_PER_PAGE) break;
  }

  return latest
    ? { downloadUrl: latest.downloadUrl, version: latest.version }
    : { downloadUrl: null, version: null };
}
