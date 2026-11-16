import { APP_VERSION } from "./app-version.js";

export const APP_DISTRIBUTION_CONFIG = {
  // Usuario/organizacion y repositorio de GitHub donde se publican los
  // releases con el .apk adjunto (Settings > Releases del repo).
  githubOwner: "pruebagonzalez605-lgtm",
  githubRepo: "movies",
  // Nombre del archivo adjunto en cada release del APK.
  apkAssetName: "app-debug.apk",
};

const { githubOwner, githubRepo, apkAssetName } = APP_DISTRIBUTION_CONFIG;

// Pagina de releases, sirve como respaldo si la version no es valida.
export const RELEASES_PAGE_URL = `https://github.com/${githubOwner}/${githubRepo}/releases`;

// Solo los tags 1.0.x, desde 1.0.30, representan versiones instalables de
// la app (peliculas y APK comparten repositorio).
const APK_TAG_PATTERN = /^v?1\.0\.(\d+)$/i;
const FIRST_APK_PATCH = 30;

export function parseApkReleaseTag(tag) {
  const match = typeof tag === "string" ? APK_TAG_PATTERN.exec(tag.trim()) : null;
  if (!match) return null;
  const patch = Number(match[1]);
  return Number.isSafeInteger(patch) && patch >= FIRST_APK_PATCH ? patch : null;
}

export function apkDownloadUrl(version) {
  return `https://github.com/${githubOwner}/${githubRepo}/releases/download/${encodeURIComponent(version)}/${apkAssetName}`;
}

/**
 * La version mas reciente del APK es APP_VERSION (config/app-version.js),
 * no lo que diga la API de GitHub: los releases de peliculas y series
 * comparten repositorio y GitHub marca como "Latest" el ultimo que se
 * publica, lo que hacia que la TV ofreciera "actualizar a 1.42".
 *
 * Por eso, al sacar un APK nuevo: primero se publica el release 1.0.x con
 * app-debug.apk adjunto, y despues se sube a la web el APP_VERSION nuevo.
 * Si se sube antes, el aviso apuntaria a un archivo que todavia no existe.
 *
 * Se mantiene async y con el mismo formato de respuesta que antes para no
 * cambiar a quienes la usan (update-checker.js y tv-app-prompt.js).
 */
export async function fetchLatestApkDownloadUrl(version = APP_VERSION) {
  if (parseApkReleaseTag(version) === null) return { downloadUrl: null, version: null };
  const tag = version.trim();
  return { downloadUrl: apkDownloadUrl(tag), version: tag };
}
