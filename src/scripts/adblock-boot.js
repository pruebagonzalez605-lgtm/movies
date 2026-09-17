/**
 * Arranque del adblock en páginas de Colevana (modo máximo optimizado).
 *
 * En player.html:
 *   <link rel="stylesheet" href="./src/styles/adblock.css">
 *   <script type="module" src="./src/scripts/adblock-boot.js"></script>
 */
import { initAdblock } from "./services/adblock.js";

function boot() {
  document.body.classList.add("cv-adblock-active");

  initAdblock({
    root: document.body,
    pollMs: 600, // no bajar de 400: evita "La página no responde"
    autoClickSkip: true,
    forceRemoveWaitOverlays: true,
    aggressiveSkip: true,
    blockPopunders: true,
    debug: false,
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
