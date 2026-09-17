/**
 * Adblock interno de Colevana — modo máximo OPTIMIZADO
 * ----------------------------------------------------
 * Evita congelar la página ("La página no responde"):
 * - Polling más suave + throttle de MutationObserver
 * - querySelectorAll por lotes, no en cada tick completo
 * - Skip/overlays solo sobre nodos visibles recientes
 * - No escanea miles de nodos en un solo frame
 *
 * Limitación: no puede modificar el interior de iframes cross-origin.
 */

const SKIP_TEXT_RE =
  /\b(saltar|skip|continuar|omitir|cerrar|close|continuar\s*sin\s*anuncios?|skip\s*ad|skip\s*ads|saltar\s*anuncio|ver\s*ahora|ver\s*video|play\s*now)\b/i;

const WAIT_TEXT_RE =
  /\b(espera|wait|segundos?|seconds?|anuncio|advertisement|publicidad|ad\s*in|skip\s*in|puedes\s*saltar|podrás\s*saltar|podras\s*saltar|please\s*wait|loading\s*ad)\b/i;

const COUNTDOWN_RE = /(\d+)\s*(s|seg|secs?|seconds?|segundos?)?/i;

/** Selectores prioritarios (pocos, de alto impacto) */
const AD_SELECTORS_FAST = [
  "iframe[src*='doubleclick']",
  "iframe[src*='googlesyndication']",
  "iframe[src*='adservice']",
  "iframe[src*='adnxs']",
  "iframe[src*='popads']",
  "iframe[src*='propeller']",
  "iframe[src*='clickadu']",
  "iframe[src*='exoclick']",
  "iframe[src*='juicyads']",
  "iframe[src*='adsterra']",
  "iframe[src*='mgid']",
  "iframe[src*='taboola']",
  "[data-ad]",
  "[data-ads]",
  "[data-ad-slot]",
  ".popup-ad",
  ".interstitial",
  ".pre-roll",
  ".preroll",
  ".midroll",
  ".overlay-ad",
  "[class*='ad-overlay']",
  "[class*='ad-banner']",
  "[class*='skip-ad']",
  "[class*='skipad']",
  "[id*='ts_ad']",
  "[class*='ts_ad']",
  "[class*='popunder']",
  "[id*='popunder']",
];

const PROCESSED_ATTR = "data-cv-adblock";

let observer = null;
let tickTimer = null;
let rootEl = null;
let mutationQueued = false;
let lastFullSweep = 0;
let options = {
  pollMs: 600,
  autoClickSkip: true,
  forceRemoveWaitOverlays: true,
  aggressiveSkip: true,
  blockPopunders: true,
  debug: false,
};

function log(...args) {
  if (options.debug) console.info("[adblock]", ...args);
}

function textOf(el) {
  if (!el) return "";
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function isVisibleCheap(el) {
  if (!(el instanceof Element)) return false;
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 8 && rect.height > 8;
}

function isInsidePlayerChrome(el) {
  return Boolean(
    el.closest?.(
      ".plyr, .site-header, .site-nav, .episode-grid-container, .rating-panel, .resume-overlay, .next-episode-overlay, .mobile-quick-controls, .external-loading-overlay, .player-quick-settings, [data-cv-keep]"
    )
  );
}

function markProcessed(el, value = "1") {
  try {
    el.setAttribute(PROCESSED_ATTR, value);
  } catch {
    // ignore
  }
}

function neutralize(el, reason) {
  if (!el || el.getAttribute?.(PROCESSED_ATTR) === "removed") return;
  if (isInsidePlayerChrome(el)) return;
  if (el.tagName === "IFRAME" && el.parentElement?.id === "mediaSlot") return;

  log("neutralize", reason, el);

  try {
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
    el.style.setProperty("opacity", "0", "important");
    el.setAttribute("aria-hidden", "true");
    markProcessed(el, "removed");

    const classId = `${el.className || ""} ${el.id || ""}`;
    if (
      el.tagName === "IFRAME" ||
      /overlay|interstitial|preroll|popup|banner|ad-/i.test(classId)
    ) {
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
  const hasCountdown = COUNTDOWN_RE.test(text) || /\b\d+\b/.test(text);
  const hasSkipContext = SKIP_TEXT_RE.test(text) || /anuncio|ad\b|publicidad/i.test(text);
  return hasCountdown || hasSkipContext;
}

function looksLikeSkipButton(el) {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag !== "BUTTON" && tag !== "A" && tag !== "DIV" && tag !== "SPAN") return false;
  if (!isVisibleCheap(el)) return false;

  const text = textOf(el);
  if (!text || text.length > 80) return false;
  if (!SKIP_TEXT_RE.test(text)) return false;
  if (el.closest?.("[data-cv-keep]")) return false;

  if (!options.aggressiveSkip) {
    if (/\b(espera|wait|in)\b/i.test(text) && COUNTDOWN_RE.test(text)) return false;
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
  for (const selector of AD_SELECTORS_FAST) {
    let nodes;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    const max = Math.min(nodes.length, 40);
    for (let i = 0; i < max; i += 1) {
      const node = nodes[i];
      if (node.getAttribute?.(PROCESSED_ATTR) === "removed") continue;
      if (isInsidePlayerChrome(node)) continue;
      if (node.tagName === "IFRAME" && node.parentElement?.id === "mediaSlot") continue;

      const name = `${node.id || ""} ${node.className || ""}`;
      const text = textOf(node);
      const suspicious =
        node.tagName === "IFRAME" ||
        WAIT_TEXT_RE.test(text) ||
        SKIP_TEXT_RE.test(text) ||
        /ad|ads|advert|banner|sponsor|publicidad|popunder|preroll|midroll/i.test(name);

      if (suspicious) neutralize(node, `selector:${selector}`);
    }
  }
}

function scanTextOverlays(root) {
  const candidates = root.querySelectorAll(
    "div[style*='fixed'], div[style*='absolute'], section[style*='fixed'], [class*='overlay'], [class*='modal'], [class*='popup'], [class*='countdown'], [class*='wait']"
  );
  const max = Math.min(candidates.length, 50);
  for (let i = 0; i < max; i += 1) {
    const el = candidates[i];
    if (el.getAttribute?.(PROCESSED_ATTR) === "removed") continue;
    if (isInsidePlayerChrome(el)) continue;
    if (!isVisibleCheap(el)) continue;

    if (looksLikeWaitOverlay(el) && options.forceRemoveWaitOverlays) {
      neutralize(el, "wait-overlay");
      continue;
    }

    const rect = el.getBoundingClientRect();
    const large =
      rect.width >= window.innerWidth * 0.45 &&
      rect.height >= window.innerHeight * 0.25;
    if (!large) continue;

    const text = textOf(el);
    if (WAIT_TEXT_RE.test(text) || SKIP_TEXT_RE.test(text) || /anuncio|publicidad|\bad\b/i.test(text)) {
      neutralize(el, "large-overlay");
    }
  }

  const bodyKids = document.body?.children;
  if (!bodyKids) return;
  const limit = Math.min(bodyKids.length, 30);
  for (let i = 0; i < limit; i += 1) {
    const el = bodyKids[i];
    if (!(el instanceof HTMLElement)) continue;
    if (el.getAttribute?.(PROCESSED_ATTR) === "removed") continue;
    if (isInsidePlayerChrome(el)) continue;
    if (el.id === "mediaSlot" || el.classList?.contains("screen-frame")) continue;

    let pos = "";
    try {
      pos = window.getComputedStyle(el).position;
    } catch {
      continue;
    }
    if (pos !== "fixed" && pos !== "absolute") continue;
    if (!isVisibleCheap(el)) continue;

    const rect = el.getBoundingClientRect();
    const large =
      rect.width >= window.innerWidth * 0.4 &&
      rect.height >= window.innerHeight * 0.22;
    if (!large) continue;

    const text = textOf(el);
    if (looksLikeWaitOverlay(el) || WAIT_TEXT_RE.test(text) || SKIP_TEXT_RE.test(text)) {
      neutralize(el, "body-fixed-overlay");
    }
  }
}

function scanSkipButtons(root) {
  if (!options.autoClickSkip) return;
  const clickables = root.querySelectorAll(
    "button, a[role='button'], [role='button'], div[class*='skip'], span[class*='skip'], button[class*='skip']"
  );
  const max = Math.min(clickables.length, 40);
  for (let i = 0; i < max; i += 1) {
    const el = clickables[i];
    if (el.getAttribute?.(PROCESSED_ATTR) === "clicked") continue;
    if (isInsidePlayerChrome(el)) continue;
    if (looksLikeSkipButton(el)) {
      markProcessed(el, "clicked");
      clickSkip(el);
      const parentOverlay = el.closest("div, section, aside");
      if (parentOverlay && looksLikeWaitOverlay(parentOverlay)) {
        neutralize(parentOverlay, "parent-of-skip");
      }
    }
  }
}

function accelerateCountdowns(root) {
  const nodes = root.querySelectorAll(
    "[class*='countdown'], [class*='timer'], [id*='countdown'], [id*='timer']"
  );
  const max = Math.min(nodes.length, 30);
  for (let i = 0; i < max; i += 1) {
    const el = nodes[i];
    if (isInsidePlayerChrome(el)) continue;
    const text = textOf(el);
    if (!text || text.length > 100) continue;
    if (/^\s*\d+\s*(s|seg|secs?|seconds?|segundos?)?\s*$/i.test(text)) {
      el.textContent = "0";
    }
  }
}

function installPopunderGuard() {
  if (!options.blockPopunders) return;
  if (window.__cvPopunderGuarded) return;
  window.__cvPopunderGuarded = true;

  window.open = function guardedOpen() {
    log("blocked window.open");
    return null;
  };

  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (isInsidePlayerChrome(t)) return;
      const a = t.closest?.("a[target='_blank']");
      if (
        !a ||
        a.closest?.("#mediaSlot") ||
        a.closest?.(".site-header") ||
        a.closest?.(".adblock-hint")
      ) {
        return;
      }
      const href = a.getAttribute("href") || "";
      if (
        href &&
        !href.startsWith("./") &&
        !href.startsWith("/") &&
        !href.includes("colevana") &&
        /ad|ads|click|pop|banner|tracker|doubleclick/i.test(href)
      ) {
        e.preventDefault();
        e.stopPropagation();
        neutralize(a, "ad-link-click");
      }
    },
    true
  );
}

function sweep(mode = "fast") {
  const root = rootEl || document.body;
  if (!root) return;

  scanSelectorHits(root);

  if (mode === "full") {
    scanTextOverlays(root);
    accelerateCountdowns(root);
    scanSkipButtons(root);
    lastFullSweep = Date.now();
  } else {
    scanSkipButtons(root);
  }
}

function scheduleSweepFromMutation() {
  if (mutationQueued) return;
  mutationQueued = true;
  requestAnimationFrame(() => {
    mutationQueued = false;
    const now = Date.now();
    if (now - lastFullSweep > 1200) {
      sweep("full");
    } else {
      sweep("fast");
    }
  });
}

function onMutations(mutations) {
  for (const mutation of mutations) {
    if (mutation.type === "childList" && mutation.addedNodes.length) {
      scheduleSweepFromMutation();
      return;
    }
    if (mutation.type === "attributes") {
      const t = mutation.target;
      if (t instanceof Element && isInsidePlayerChrome(t)) continue;
      scheduleSweepFromMutation();
      return;
    }
  }
}

export function initAdblock(opts = {}) {
  options = { ...options, ...opts };
  if (options.pollMs < 400) options.pollMs = 400;

  rootEl = opts.root instanceof Element ? opts.root : document.body;

  installPopunderGuard();
  sweep("full");

  if (observer) observer.disconnect();
  observer = new MutationObserver(onMutations);
  observer.observe(rootEl, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "id", "hidden", "src"],
  });

  if (tickTimer) window.clearInterval(tickTimer);
  tickTimer = window.setInterval(() => {
    const now = Date.now();
    if (now - lastFullSweep > 1800) sweep("full");
    else sweep("fast");
  }, options.pollMs);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sweep("full");
  });

  window.setTimeout(() => sweep("full"), 800);
  window.setTimeout(() => sweep("full"), 2500);

  log("activo (máximo optimizado)", { root: rootEl, options });
  return {
    sweep: () => sweep("full"),
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

if (typeof window !== "undefined") {
  window.ColevanaAdblock = { initAdblock, stopAdblock };
}
