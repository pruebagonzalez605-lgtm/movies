/**
 * Adblock interno de Colevana
 * -----------------------
 * Bloquea overlays, countdowns y anuncios de "espera X segundos para saltar"
 * que se inyectan en la misma página (no puede modificar iframes cross-origin
 * de proveedores externos por la política same-origin del navegador).
 *
 * Uso:
 *   import { initAdblock } from "./services/adblock.js";
 *   initAdblock({ root: document.getElementById("mediaSlot") || document.body });
 */

const SKIP_TEXT_RE =
  /\b(saltar|skip|continuar|omitir|cerrar|close|continuar\s*sin\s*anuncios?|skip\s*ad|skip\s*ads|saltar\s*anuncio)\b/i;

const WAIT_TEXT_RE =
  /\b(espera|wait|segundos?|seconds?|anuncio|advertisement|publicidad|ad\s*in|skip\s*in|puedes\s*saltar|podrás\s*saltar|podras\s*saltar)\b/i;

const COUNTDOWN_RE = /(\d+)\s*(s|seg|secs?|seconds?|segundos?)?/i;

/** Selectores frecuentes de overlays / banners de anuncios en embeds y páginas */
const AD_SELECTORS = [
  // Genericos
  "[id*='ad-']",
  "[id*='ads-']",
  "[id*='advert']",
  "[class*='ad-overlay']",
  "[class*='ad-banner']",
  "[class*='ad-container']",
  "[class*='ad-wrapper']",
  "[class*='adsbox']",
  "[class*='advertisement']",
  "[class*='sponsored']",
  "[data-ad]",
  "[data-ads]",
  "iframe[src*='doubleclick']",
  "iframe[src*='googlesyndication']",
  "iframe[src*='adservice']",
  "iframe[src*='adnxs']",
  "iframe[src*='advertising']",
  // Temporizadores / skip gates
  "[class*='skip-ad']",
  "[class*='skipad']",
  "[class*='skip_ad']",
  "[class*='ad-skip']",
  "[class*='countdown']",
  "[class*='timer-ad']",
  "[id*='skip']",
  "[id*='countdown']",
  // Popunders / intersticiales comunes
  ".popup-ad",
  ".interstitial",
  ".pre-roll",
  ".preroll",
  ".midroll",
  ".overlay-ad",
  // Redes conocidas en sitios de streaming LATAM
  "[id*='ts_ad']",
  "[class*='ts_ad']",
  "[id*='float'][class*='ad']",
];

/** Atributos o clases que marcan un nodo como “ya procesado” para no re-escanearlo en bucle */
const PROCESSED_ATTR = "data-cv-adblock";

let observer = null;
let tickTimer = null;
let rootEl = null;
let options = {
  /** Intervalo de re-escaneo activo (ms) mientras haya nodos sospechosos */
  pollMs: 400,
  /** Auto-clickear botones de saltar cuando el texto indique que ya se puede */
  autoClickSkip: true,
  /** Quitar overlays de espera aunque el countdown no haya terminado */
  forceRemoveWaitOverlays: true,
  /** Log en consola (útil para depurar) */
  debug: false,
};

function log(...args) {
  if (options.debug) console.info("[adblock]", ...args);
}

function textOf(el) {
  if (!el) return "";
  return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
}

function isVisible(el) {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 8 && rect.height > 8;
}

function isInsidePlayerChrome(el) {
  // No tocar controles legítimos de Plyr / UI propia de Colevana
  return Boolean(
    el.closest?.(".plyr") ||
      el.closest?.(".site-header") ||
      el.closest?.(".site-nav") ||
      el.closest?.(".episode-grid-container") ||
      el.closest?.(".rating-panel") ||
      el.closest?.(".resume-overlay") ||
      el.closest?.("[data-cv-keep]")
  );
}

function markProcessed(el) {
  try {
    el.setAttribute(PROCESSED_ATTR, "1");
  } catch {
    // ignore
  }
}

function neutralize(el, reason) {
  if (!el || el.getAttribute?.(PROCESSED_ATTR) === "removed") return;
  if (isInsidePlayerChrome(el)) return;

  log("neutralize", reason, el);

  try {
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("opacity", "0", "important");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute(PROCESSED_ATTR, "removed");

    // Si es un overlay a pantalla casi completa, también intentar eliminarlo del DOM
    const rect = el.getBoundingClientRect?.();
    const coversViewport =
      rect &&
      rect.width >= window.innerWidth * 0.6 &&
      rect.height >= window.innerHeight * 0.35;

    if (coversViewport || /overlay|interstitial|preroll|popup/i.test(el.className || "")) {
      el.remove();
    }
  } catch {
    // ignore
  }
}

function looksLikeWaitOverlay(el) {
  const text = textOf(el);
  if (!text || text.length > 400) return false;
  if (!WAIT_TEXT_RE.test(text)) return false;
  // Debe mencionar tiempo o “saltar” en contexto de anuncio
  const hasCountdown = COUNTDOWN_RE.test(text) || /\b\d+\b/.test(text);
  const hasSkipContext = SKIP_TEXT_RE.test(text) || /anuncio|ad\b|publicidad/i.test(text);
  return hasCountdown || hasSkipContext;
}

function looksLikeSkipButton(el) {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag !== "BUTTON" && tag !== "A" && tag !== "DIV" && tag !== "SPAN") return false;
  if (!isVisible(el)) return false;

  const text = textOf(el);
  if (!text || text.length > 80) return false;
  if (!SKIP_TEXT_RE.test(text)) return false;

  // Evitar “Saltar intro” legítimo del reproductor propio si estuviera marcado
  if (el.closest?.("[data-cv-keep]")) return false;

  // Si el botón aún dice "espera Xs" / "skip in Xs", no está listo
  if (/\b(espera|wait|in)\b/i.test(text) && COUNTDOWN_RE.test(text)) {
    return false;
  }
  return true;
}

function clickSkip(el) {
  log("auto-click skip", el);
  try {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === "function") el.click();
  } catch {
    // ignore
  }
}

function scanSelectorHits(root) {
  for (const selector of AD_SELECTORS) {
    let nodes;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    nodes.forEach((node) => {
      if (node.getAttribute?.(PROCESSED_ATTR) === "removed") return;
      if (isInsidePlayerChrome(node)) return;
      // Solo neutralizar si parece publicidad o está oculto como ad clásico
      const text = textOf(node);
      const suspicious =
        WAIT_TEXT_RE.test(text) ||
        SKIP_TEXT_RE.test(text) ||
        /ad|ads|advert|banner|sponsor|publicidad/i.test(
          `${node.id || ""} ${node.className || ""}`
        );
      if (suspicious || node.tagName === "IFRAME") {
        neutralize(node, `selector:${selector}`);
      }
    });
  }
}

function scanTextOverlays(root) {
  // Buscar candidatos a overlay de espera: fixed/absolute grandes con texto de countdown
  const candidates = root.querySelectorAll("div, section, aside, dialog");
  candidates.forEach((el) => {
    if (el.getAttribute?.(PROCESSED_ATTR) === "removed") return;
    if (isInsidePlayerChrome(el)) return;
    if (!isVisible(el)) return;

    const style = window.getComputedStyle(el);
    const positioned =
      style.position === "fixed" ||
      style.position === "absolute" ||
      style.position === "sticky";
    if (!positioned && !looksLikeWaitOverlay(el)) return;

    if (looksLikeWaitOverlay(el) && options.forceRemoveWaitOverlays) {
      neutralize(el, "wait-overlay");
      return;
    }

    // Overlay grande fixed con z-index alto y poco texto → probable intersticial
    const z = Number.parseInt(style.zIndex, 10);
    const rect = el.getBoundingClientRect();
    const large =
      rect.width >= window.innerWidth * 0.5 && rect.height >= window.innerHeight * 0.3;
    if (positioned && large && Number.isFinite(z) && z >= 1000) {
      const text = textOf(el);
      if (WAIT_TEXT_RE.test(text) || SKIP_TEXT_RE.test(text) || /anuncio|publicidad|\bad\b/i.test(text)) {
        neutralize(el, "large-fixed-ad");
      }
    }
  });
}

function scanSkipButtons(root) {
  if (!options.autoClickSkip) return;
  const clickables = root.querySelectorAll("button, a, [role='button'], div[onclick], span[onclick]");
  clickables.forEach((el) => {
    if (el.getAttribute?.(PROCESSED_ATTR) === "clicked") return;
    if (isInsidePlayerChrome(el)) return;
    if (looksLikeSkipButton(el)) {
      markProcessed(el);
      el.setAttribute(PROCESSED_ATTR, "clicked");
      clickSkip(el);
      // Algunos anuncios solo habilitan el botón tras el countdown:
      // si aún hay un padre overlay, intentar neutralizarlo también.
      const parentOverlay = el.closest("div, section, aside");
      if (parentOverlay && looksLikeWaitOverlay(parentOverlay)) {
        neutralize(parentOverlay, "parent-of-skip");
      }
    }
  });
}

/** Fuerza el “fin” de countdowns visibles mutando texto y disparando clicks */
function accelerateCountdowns(root) {
  const nodes = root.querySelectorAll("div, span, p, button, a");
  nodes.forEach((el) => {
    if (isInsidePlayerChrome(el)) return;
    const text = textOf(el);
    if (!text || text.length > 120) return;
    if (!WAIT_TEXT_RE.test(text)) return;
    if (!COUNTDOWN_RE.test(text)) return;

    // Si el nodo solo contiene el número del countdown, poner 0
    if (/^\s*\d+\s*(s|seg|secs?|seconds?|segundos?)?\s*$/i.test(text)) {
      el.textContent = "0";
      log("countdown zeroed", el);
    }
  });
}

function sweep(root = rootEl || document.body) {
  if (!root) return;
  scanSelectorHits(root);
  scanTextOverlays(root);
  accelerateCountdowns(root);
  scanSkipButtons(root);
}

function onMutations(mutations) {
  let needsSweep = false;
  for (const mutation of mutations) {
    if (mutation.type === "childList" && mutation.addedNodes.length) {
      needsSweep = true;
      break;
    }
    if (mutation.type === "attributes") {
      needsSweep = true;
      break;
    }
  }
  if (needsSweep) sweep();
}

/**
 * Inicializa el adblock interno.
 * @param {{ root?: Element, pollMs?: number, autoClickSkip?: boolean, forceRemoveWaitOverlays?: boolean, debug?: boolean }} opts
 */
export function initAdblock(opts = {}) {
  options = { ...options, ...opts };
  rootEl = opts.root instanceof Element ? opts.root : document.body;

  // Barrido inmediato
  sweep(rootEl);

  // Observar inyecciones dinámicas
  if (observer) observer.disconnect();
  observer = new MutationObserver(onMutations);
  observer.observe(rootEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "id", "hidden"],
  });

  // Poll suave: algunos scripts de ads mutan texto del countdown sin tocar atributos
  if (tickTimer) window.clearInterval(tickTimer);
  tickTimer = window.setInterval(() => sweep(rootEl), options.pollMs);

  // También al volver a la pestaña
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sweep(rootEl);
  });

  log("activo", { root: rootEl, options });
  return {
    sweep: () => sweep(rootEl),
    stop: stopAdblock,
  };
}

export function stopAdblock() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (tickTimer) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Arranque automático si se carga como script clásico (sin module) */
if (typeof window !== "undefined") {
  window.ColevanaAdblock = { initAdblock, stopAdblock };
}
