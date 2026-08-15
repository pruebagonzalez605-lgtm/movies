/**
 * Arranque del adblock en páginas de Colevana.
 *
 * En player.html (y opcionalmente en el resto):
 *   <link rel="stylesheet" href="./src/styles/adblock.css">
 *   <script type="module" src="./src/scripts/adblock-boot.js"></script>
 */
import { initAdblock } from "./services/adblock.js";

function boot() {
  document.body.classList.add("cv-adblock-active");

  // Observar todo el documento: los overlays de espera suelen inyectarse
  // como hermanos del iframe o sobre <body>, no solo dentro de #mediaSlot.
  initAdblock({
    root: document.body,
    pollMs: 350,
    autoClickSkip: true,
    forceRemoveWaitOverlays: true,
    debug: false,
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
