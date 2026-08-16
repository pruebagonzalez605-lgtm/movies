import {
  fetchLatestApkDownloadUrl,
  RELEASES_PAGE_URL,
} from "../config/app-distribution.js";
import { APP_VERSION } from "../config/app-version.js";

// Guardamos la ULTIMA version que el usuario ya vio y descarto, no una
// fecha. Asi, si sale una version mas nueva todavia, el modal vuelve a
// aparecer aunque haya descartado una version anterior hace poco.
const DISMISS_VERSION_KEY = "colevana:update-prompt-dismissed-version";

function isRunningInsideNativeApp() {
  // Solo tiene sentido ofrecer "actualizar la app" dentro del propio APK
  // (Capacitor). En el navegador normal no aplica.
  return typeof window !== "undefined" && Boolean(window.Capacitor);
}

function normalizeVersion(version) {
  return (version || "").toString().trim().replace(/^v/i, "");
}

// Compara versiones tipo "1.30" vs "1.4", "1.2.1" vs "1.2", etc. sin
// depender de que sean semver estricto.
function isNewerVersion(remoteVersion, currentVersion) {
  const remote = normalizeVersion(remoteVersion).split(".").map((n) => parseInt(n, 10) || 0);
  const current = normalizeVersion(currentVersion).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(remote.length, current.length);

  for (let i = 0; i < len; i++) {
    const r = remote[i] || 0;
    const c = current[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
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

  try {
    const { downloadUrl, version } = await fetchLatestApkDownloadUrl();
    if (!version) return;
    if (!isNewerVersion(version, APP_VERSION)) return;
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
