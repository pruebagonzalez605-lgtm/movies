import {
  fetchLatestApkDownloadUrl,
  RELEASES_PAGE_URL,
} from "../config/app-distribution.js?apk-updates=1";
import { APP_VERSION } from "../config/app-version.js";

// Guardamos la ULTIMA version que el usuario ya vio y descarto, no una
// fecha. Asi, si sale una version mas nueva todavia, el modal vuelve a
// aparecer aunque haya descartado una version anterior hace poco.
const DISMISS_VERSION_KEY = "colevana:update-prompt-dismissed-version";

// Guardamos ademas la version instalada que la app detecto la ULTIMA vez
// que se abrio. Sirve para notar cuando el usuario acaba de actualizar el
// APK (la version instalada cambio respecto de la ultima vez) y, en ese
// caso, limpiar cualquier "descarte" viejo que haya quedado guardado. Sin
// esto, un descarte guardado antes de actualizar podia quedar "pegado" y
// mezclarse con la logica de version-mas-nueva de forma confusa.
const LAST_SEEN_VERSION_KEY = "colevana:last-seen-app-version";

function isRunningInsideNativeApp() {
  // Solo tiene sentido ofrecer "actualizar la app" dentro del propio APK
  // (Capacitor). En el navegador normal no aplica.
  return typeof window !== "undefined" && Boolean(window.Capacitor);
}

function parseInstalledVersion(version) {
  const match = typeof version === "string" ? /^v?1\.0\.(\d+)$/i.exec(version.trim()) : null;
  if (!match) return null;
  const patch = Number(match[1]);
  return Number.isSafeInteger(patch) ? patch : null;
}

export function isNewerVersion(remoteVersion, currentVersion) {
  const remotePatch = parseInstalledVersion(remoteVersion);
  const currentPatch = parseInstalledVersion(currentVersion);
  return remotePatch !== null && currentPatch !== null && remotePatch > currentPatch;
}

// Las builds nuevas exponen la version compilada del APK. Las anteriores
// conservan la ultima version registrada por el sitio para evitar que una
// actualizacion de la web cambie artificialmente la version instalada.
export function resolveInstalledVersion(nativeVersion, lastSeenVersion, fallbackVersion = APP_VERSION) {
  if (parseInstalledVersion(nativeVersion) !== null) return nativeVersion.trim();
  if (parseInstalledVersion(lastSeenVersion) !== null) return lastSeenVersion.trim();
  return parseInstalledVersion(fallbackVersion) !== null ? fallbackVersion.trim() : null;
}

function getInstalledVersion() {
  let nativeVersion = null;
  let lastSeenVersion = null;
  try {
    nativeVersion = window.ColevanaNative?.getAppVersion?.();
  } catch {
    // Una APK anterior puede no exponer este metodo.
  }
  try {
    lastSeenVersion = localStorage.getItem(LAST_SEEN_VERSION_KEY);
  } catch {
    // El sitio sigue funcionando si el almacenamiento esta bloqueado.
  }
  return resolveInstalledVersion(nativeVersion, lastSeenVersion);
}

function wasDismissedForVersion(version) {
  try {
    return localStorage.getItem(DISMISS_VERSION_KEY) === version;
  } catch {
    return false;
  }
}

function markDismissedForVersion(version) {
  try {
    localStorage.setItem(DISMISS_VERSION_KEY, version);
  } catch {
    // Si localStorage no esta disponible, no pasa nada: el modal podria
    // volver a aparecer en la proxima apertura de la app.
  }
}

// Limpia los descartes solo cuando cambia la version instalada detectada.
function syncInstalledVersion(installedVersion) {
  try {
    const lastSeenVersion = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    if (lastSeenVersion === installedVersion) return;

    localStorage.setItem(LAST_SEEN_VERSION_KEY, installedVersion);
    localStorage.removeItem(DISMISS_VERSION_KEY);
  } catch {
    // Sin localStorage no podemos recordar nada entre aperturas; el
    // modal simplemente se comporta como si fuera siempre la primera vez.
  }
}

function buildModal(remoteVersion, downloadUrl) {
  const overlay = document.createElement("div");
  overlay.className = "catalog-modal tv-app-prompt update-app-prompt";
  overlay.innerHTML = `
    <div class="catalog-modal-dialog tv-app-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="updateAppPromptTitle">
      <button type="button" class="catalog-modal-close" data-update-prompt-dismiss>Cerrar</button>
      <div class="catalog-modal-head">
        <h2 id="updateAppPromptTitle">Hay una actualizacion disponible</h2>
        <p>Salio una nueva version de Colevana TV (${remoteVersion}). Actualiza para tener las ultimas mejoras y correcciones.</p>
      </div>
      <div class="catalog-modal-content">
        <div class="tv-app-prompt-actions">
          <a class="catalog-link tv-app-prompt-download" href="${downloadUrl}">
            Actualizar ahora
          </a>
          <button type="button" class="catalog-link catalog-link-ghost" data-update-prompt-dismiss>
            Recordarme despues
          </button>
        </div>
        <p class="tv-app-prompt-hint">Se va a abrir el navegador o tu gestor de descargas para instalar el nuevo APK. Si tu TV bloquea la instalacion, activa "Origenes desconocidos" en Ajustes antes de abrir el archivo descargado.</p>
      </div>
    </div>
  `;
  return overlay;
}

function wireModal(overlay, remoteVersion) {
  const closeButtons = overlay.querySelectorAll("[data-update-prompt-dismiss]");
  closeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      markDismissedForVersion(remoteVersion);
    });
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      markDismissedForVersion(remoteVersion);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.classList.contains("is-open")) {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      markDismissedForVersion(remoteVersion);
    }
  });
}

export async function initUpdateChecker() {
  if (!isRunningInsideNativeApp()) return;

  const installedVersion = getInstalledVersion();
  if (!installedVersion) return;
  syncInstalledVersion(installedVersion);

  try {
    const { downloadUrl, version } = await fetchLatestApkDownloadUrl();
    if (!version) return;
    // Si la version mas reciente publicada es igual a la que ya tenemos
    // instalada (o mas vieja), no hay nada que ofrecer: no se manda
    // ninguna alerta de actualizacion.
    if (!isNewerVersion(version, installedVersion)) return;
    if (wasDismissedForVersion(version)) return;

    const overlay = buildModal(version, downloadUrl || RELEASES_PAGE_URL);
    document.body.appendChild(overlay);
    wireModal(overlay, version);

    // Dejamos que el observer de spatial-nav.js detecte el nuevo
    // .catalog-modal recien insertado antes de abrirlo, para que el foco
    // salte automaticamente al primer boton al abrirse.
    requestAnimationFrame(() => {
      overlay.classList.add("is-open");
      document.body.classList.add("modal-open");
    });
  } catch {
    // Sin conexion a la API de GitHub (o rate-limit): no mostramos nada,
    // no bloqueamos el uso normal de la app.
  }
}

initUpdateChecker();
