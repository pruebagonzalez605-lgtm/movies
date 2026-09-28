import { initAdblock } from "./services/adblock.js";

function boot() {
  initAdblock({ root: document.body });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
