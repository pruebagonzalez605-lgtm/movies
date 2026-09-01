import {
  fetchLatestApkDownloadUrl,
  RELEASES_PAGE_URL,
} from "../config/app-distribution.js";
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

// Compara la version instalada actual (APP_VERSION, la que viene
// empaquetada en este build del APK) contra la que quedo guardada la
// ultima vez que la app se abrio. Si son distintas, la app se acaba de
// actualizar (o es la primera vez que se abre). En ese caso guardamos la
// version nueva y borramos cualquier "recordar despues" viejo: ese
// descarte corresponde a un chequeo hecho con la version anterior y no
// tiene sentido que siga afectando el comportamiento del modal ahora.
function syncInstalledVersion() {
  try {
    const lastSeenVersion = localStorage.getItem(LAST_SEEN_VERSION_KEY);
    if (lastSeenVersion === APP_VERSION) return;

    localStorage.setItem(LAST_SEEN_VERSION_KEY, APP_VERSION);
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

  // Guarda/actualiza la version instalada detectada en este dispositivo y
  // limpia descartes viejos si la app se acaba de actualizar. Esto pasa
  // SIEMPRE al abrir la app, antes de consultar si hay algo mas nuevo.
  syncInstalledVersion();

  try {
    const { downloadUrl, version } = await fetchLatestApkDownloadUrl();
    if (!version) return;
    // Si la version mas reciente publicada es igual a la que ya tenemos
    // instalada (o mas vieja), no hay nada que ofrecer: no se manda
    // ninguna alerta de actualizacion.
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