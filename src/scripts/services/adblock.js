/** Oculta anuncios añadidos al documento propio sin tocar reproductores externos. */
const AD_SELECTOR = [
  "iframe[src*='doubleclick.net']",
  "iframe[src*='googlesyndication.com']",
  "iframe[src*='adservice.google.com']",
  "iframe[src*='adnxs.com']",
  "iframe[src*='popads.net']",
  "iframe[src*='propellerads.com']",
  "iframe[src*='clickadu.com']",
  "iframe[src*='adsterra.com']",
  "iframe[src*='exoclick.com']",
  "iframe[src*='juicyads.com']",
  "iframe[src*='mgid.com']",
  "iframe[src*='taboola.com']",
  "iframe[src*='outbrain.com']",
  "[data-ad-slot]",
  ".adsbygoogle",
  ".popup-ad",
  ".overlay-ad",
  ".popunder",
].join(",");

const PLAYER_UI_SELECTOR = [
  "#mediaSlot",
  ".plyr",
  ".site-header",
  ".site-nav",
  "[data-cv-keep]",
].join(",");

let observer = null;
let frame = null;
let root = null;

function hideAd(node) {
  if (!(node instanceof Element) || node.closest(PLAYER_UI_SELECTOR)) return;
  node.setAttribute("data-cv-adblock", "removed");
}

function sweep() {
  frame = null;
  if (!root) return;
  if (root.matches?.(AD_SELECTOR)) hideAd(root);
  root.querySelectorAll(AD_SELECTOR).forEach(hideAd);
}

function scheduleSweep(mutations) {
  if (!mutations.some((mutation) => mutation.addedNodes.length)) return;
  if (frame === null) frame = window.requestAnimationFrame(sweep);
}

export function initAdblock({ root: requestedRoot } = {}) {
  stopAdblock();
  root = requestedRoot instanceof Element ? requestedRoot : document.body;
  if (!root) return { sweep, stop: stopAdblock };
  sweep();
  observer = new MutationObserver(scheduleSweep);
  observer.observe(root, { childList: true, subtree: true });
  return { sweep, stop: stopAdblock };
}

export function stopAdblock() {
  observer?.disconnect();
  observer = null;
  if (frame !== null) window.cancelAnimationFrame(frame);
  frame = null;
  root = null;
}

if (typeof window !== "undefined") {
  window.ColevanaAdblock = { initAdblock, stopAdblock };
}
