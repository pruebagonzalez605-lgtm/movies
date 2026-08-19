import {
  fetchLatestApkDownloadUrl,
  RELEASES_PAGE_URL,
} from "../config/app-distribution.js";
import { isLikelyTvBrowser } from "../shared/device.js";

const DISMISS_STORAGE_KEY = "colevana:tv-app-prompt-dismissed-at";
// Si el usuario cierra el aviso, no lo volvemos a mostrar durante este
// tiempo (en ms). 7 dias.
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function isRunningInsideNativeApp() {
  // Si esto corre dentro del propio APK (Capacitor), no tiene sentido
  // ofrecer descargarlo: ya esta instalado.
  return typeof window !== "undefined" && Boolean(window.Capacitor);
}

function wasRecentlyDismissed() {
  const raw = localStorage.getItem(DISMISS_STORAGE_KEY);
  if (!raw) return false;
  const dismissedAt = Number(raw);
  if (!Number.isFinite(dismissedAt)) return false;
  return Date.now() - dismissedAt < DISMISS_DURATION_MS;
}

function markAsDismissed() {
  try {
    localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
  } catch {
    // Si localStorage no esta disponible (privado/restringido), no pasa nada:
    // simplemente el aviso podria volver a aparecer en la proxima visita.
  }
}

function buildModal() {
  const overlay = document.createElement("div");
  overlay.className = "catalog-modal tv-app-prompt";
  overlay.innerHTML = `
    <div class="catalog-modal-dialog tv-app-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="tvAppPromptTitle">
      <button type="button" class="catalog-modal-close" data-tv-prompt-dismiss>Cerrar</button>
      <div class="catalog-modal-head">
        <h2 id="tvAppPromptTitle">Mira Colevana con la app para TV</h2>
        <p>Descarga la app de Colevana para una experiencia optimizada en tu televisor: navegacion mas fluida con el control remoto y arranque mas rapido.</p>
      </div>
      <div class="catalog-modal-content">
        <div class="tv-app-prompt-actions">
          <a class="catalog-link tv-app-prompt-download" data-tv-prompt-download href="${RELEASES_PAGE_URL}">
            Descargar app (.apk)
          </a>
          <button type="button" class="catalog-link catalog-link-ghost" data-tv-prompt-dismiss>
            Seguir en el navegador
          </button>
        </div>
        <p class="tv-app-prompt-hint">Si tu TV bloquea la instalacion, activa "Origenes desconocidos" para el navegador en Ajustes antes de abrir el archivo descargado.</p>
      </div>
    </div>
  `;
  return overlay;
}

function wireModal(overlay) {
  const closeButtons = overlay.querySelectorAll("[data-tv-prompt-dismiss]");
  closeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      markAsDismissed();
    });
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      markAsDismissed();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.classList.contains("is-open")) {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      markAsDismissed();
    }
  });
}

async function resolveDownloadLink(overlay) {
  const downloadLink = overlay.querySelector("[data-tv-prompt-download]");
  if (!downloadLink) return;

  try {
    const { downloadUrl, version } = await fetchLatestApkDownloadUrl();
    if (downloadUrl) {
      downloadLink.href = downloadUrl;
      if (version) {
        downloadLink.textContent = `Descargar app (.apk) ${version}`;
      }
    }
    // Si no hay .apk adjunto todavia, el link se queda apuntando a la
    // pagina de releases (ya seteado por defecto en buildModal()).
  } catch {
    // Sin conexion a la API de GitHub: dejamos el link a la pagina de
    // releases, que ya esta seteado por defecto.
  }
}

export function initTvAppPrompt() {
  if (isRunningInsideNativeApp()) return;
  if (!isLikelyTvBrowser()) return;
  if (wasRecentlyDismissed()) return;

  const overlay = buildModal();
  document.body.appendChild(overlay);
  wireModal(overlay);
  resolveDownloadLink(overlay);

  // Dejamos que el observer de spatial-nav.js detecte el nuevo
  // .catalog-modal recien insertado antes de abrirlo, para que el foco
  // salte automaticamente al primer boton al abrirse.
  requestAnimationFrame(() => {
    overlay.classList.add("is-open");
    document.body.classList.add("modal-open");
  });
}

initTvAppPrompt();
