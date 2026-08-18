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

// Cuantos releases recientes revisamos como maximo buscando uno que
// tenga un .apk adjunto. GitHub pagina de a 30 por defecto, con esto
// alcanza de sobra salvo que se publiquen muchisimos releases sin apk.
const MAX_RELEASES_TO_SCAN = 30;

/**
 * Consulta la API publica de GitHub y devuelve la URL directa de descarga
 * del primer archivo .apk encontrado, revisando los releases del repo
 * del mas reciente al mas viejo.
 *
 * A proposito NO usamos el endpoint /releases/latest: ese endpoint de
 * GitHub devuelve el release marcado como "Latest" (el mas reciente que
 * no sea draft ni prerelease), pero no garantiza que ese release tenga
 * un .apk adjunto. Si publicas un release sin apk (por ejemplo solo con
 * notas de la version, o todavia armando el build), "latest" apuntaria
 * ahi y el checker no encontraria ningun apk para descargar. En cambio,
 * recorremos la lista de releases y nos quedamos con el primero (osea
 * el mas nuevo) que SI tenga un asset .apk adjunto, ignorando los que
 * no lo tengan.
 */
export async function fetchLatestApkDownloadUrl() {
  const apiUrl = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases?per_page=${MAX_RELEASES_TO_SCAN}`;

  const response = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases API respondio ${response.status}`);
  }

  const releases = await response.json();
  if (!Array.isArray(releases)) return { downloadUrl: null, version: null };

  // La API ya devuelve los releases ordenados del mas nuevo al mas
  // viejo (por fecha de creacion), asi que basta con tomar el primero
  // que cumpla los requisitos.
  for (const release of releases) {
    // Ignoramos drafts (todavia no publicados) para no ofrecer una
    // version que ni siquiera esta disponible publicamente.
    if (release.draft) continue;

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const apkAsset = assets.find(
      (asset) => asset.name && asset.name.toLowerCase().endsWith(".apk")
    );

    if (apkAsset) {
      return {
        downloadUrl: apkAsset.browser_download_url,
        version: release.tag_name || null,
      };
    }
  }

  // Ningun release reciente tiene un .apk adjunto.
  return { downloadUrl: null, version: null };
}