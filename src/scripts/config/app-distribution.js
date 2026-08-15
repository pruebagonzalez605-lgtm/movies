export const APP_DISTRIBUTION_CONFIG = {
  // Usuario/organizacion y repositorio de GitHub donde se publican los
  // releases con el .apk adjunto (Settings > Releases del repo).
  githubOwner: "pruebagonzalez605-lgtm",
  githubRepo: "movies",
};

const { githubOwner, githubRepo } = APP_DISTRIBUTION_CONFIG;

// Pagina de releases, sirve como respaldo si la API de GitHub falla o
// si no se encuentra ningun asset .apk en el release mas reciente.
export const RELEASES_PAGE_URL = `https://github.com/${githubOwner}/${githubRepo}/releases/latest`;

/**
 * Consulta la API publica de GitHub y devuelve la URL directa de descarga
 * del primer archivo .apk adjunto al release mas reciente, o null si no
 * hay ninguno (por ejemplo, si el release todavia no tiene un apk subido).
 */
export async function fetchLatestApkDownloadUrl() {
  const apiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;

  const response = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases API respondio ${response.status}`);
  }

  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const apkAsset = assets.find((asset) => asset.name && asset.name.toLowerCase().endsWith(".apk"));

  return {
    downloadUrl: apkAsset ? apkAsset.browser_download_url : null,
    version: release.tag_name || null,
  };
}
