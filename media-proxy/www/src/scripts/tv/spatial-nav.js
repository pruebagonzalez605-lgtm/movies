/**
 * Navegacion por control remoto (D-pad) para TV.
 *
 * No depende de ningun framework: mueve el foco del navegador entre los
 * elementos interactivos visibles (tarjetas, botones, enlaces, inputs)
 * usando las flechas del teclado, que es lo que Android TV / WebView
 * genera al presionar el D-pad de un control remoto.
 *
 * Se activa solo con teclado/D-pad; no interfiere con mouse ni touch.
 * No requiere cambios en el resto del proyecto: basta con incluir este
 * script (type="module") en cada pagina, despues de nav.js.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const ARROW_TO_DIRECTION = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA"]);

let lastFocusedBeforeModal = null;

function isVisible(el) {
  if (!el || el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getOpenModalDialog() {
  const openModal = document.querySelector(".catalog-modal.is-open");
  if (!openModal) return null;
  return openModal.querySelector(".catalog-modal-dialog") || openModal;
}

function getScopeRoot() {
  return getOpenModalDialog() || document;
}

function getFocusables(root = getScopeRoot()) {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
}

function rectCenter(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function scoreCandidate(currentRect, currentCenter, candidateRect, direction, strict) {
  const center = rectCenter(candidateRect);
  let primary;
  let perpendicular;
  let inCone;

  switch (direction) {
    case "left":
      primary = currentRect.left - candidateRect.right;
      perpendicular = Math.abs(center.y - currentCenter.y);
      inCone = strict ? candidateRect.right <= currentRect.left + 1 : center.x < currentCenter.x;
      break;
    case "right":
      primary = candidateRect.left - currentRect.right;
      perpendicular = Math.abs(center.y - currentCenter.y);
      inCone = strict ? candidateRect.left >= currentRect.right - 1 : center.x > currentCenter.x;
      break;
    case "up":
      primary = currentRect.top - candidateRect.bottom;
      perpendicular = Math.abs(center.x - currentCenter.x);
      inCone = strict ? candidateRect.bottom <= currentRect.top + 1 : center.y < currentCenter.y;
      break;
    case "down":
    default:
      primary = candidateRect.top - currentRect.bottom;
      perpendicular = Math.abs(center.x - currentCenter.x);
      inCone = strict ? candidateRect.top >= currentRect.bottom - 1 : center.y > currentCenter.y;
      break;
  }

  if (!inCone) return null;
  return Math.max(primary, 0) + perpendicular * 1.5;
}

function findNextFocus(current, direction) {
  const candidates = getFocusables().filter((el) => el !== current);
  if (!candidates.length) return null;

  const currentRect = current.getBoundingClientRect();
  const currentCenter = rectCenter(currentRect);

  for (const strict of [true, false]) {
    let best = null;
    let bestScore = Infinity;
    for (const el of candidates) {
      const score = scoreCandidate(currentRect, currentCenter, el.getBoundingClientRect(), direction, strict);
      if (score !== null && score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) return best;
  }
  return null;
}

function scrollIntoViewIfNeeded(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function focusFirstAvailable() {
  const candidates = getFocusables();
  if (!candidates.length) return;
  candidates[0].focus();
  scrollIntoViewIfNeeded(candidates[0]);
}

function handleBack(event) {
  const active = document.activeElement;
  if (active && TEXT_ENTRY_TAGS.has(active.tagName)) return; // dejar borrar texto

  const openModal = document.querySelector(".catalog-modal.is-open");
  const openSearchDropdown = document.querySelector(".site-search-dropdown.is-open");
  if (!openModal && !openSearchDropdown) return;

  event.preventDefault();
  // Reutiliza el cierre ya implementado en cada pagina, que escucha "Escape".
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function handleDirectional(event) {
  const direction = ARROW_TO_DIRECTION[event.key];
  if (!direction) return;

  const active = document.activeElement;

  // Dejar que los inputs de texto manejen sus propias flechas (cursor de texto).
  if (active && TEXT_ENTRY_TAGS.has(active.tagName)) return;
  if (active && active.tagName === "SELECT") return;

  // Los sliders (barra de progreso y volumen de Plyr son <input type="range">)
  // manejan izquierda/derecha para su propio seek/ajuste nativo, pero arriba/
  // abajo deben poder sacar el foco del control. Si no, con un D-pad (que no
  // tiene Tab) el foco queda atrapado ahi para siempre: cualquier flecha
  // termina interpretada como "avanzar"/"retroceder" en vez de mover el foco
  // a otro control.
  if (active && active.tagName === "INPUT" && active.type === "range") {
    if (direction === "left" || direction === "right") return;
  }

  if (!active || active === document.body) {
    event.preventDefault();
    focusFirstAvailable();
    return;
  }

  const next = findNextFocus(active, direction);
  if (next) {
    event.preventDefault();
    next.focus();
    scrollIntoViewIfNeeded(next);
  }
}

function observeModal(modalEl) {
  const observer = new MutationObserver(() => {
    if (modalEl.classList.contains("is-open")) {
      lastFocusedBeforeModal = document.activeElement;
      const dialog = modalEl.querySelector(".catalog-modal-dialog") || modalEl;
      const [firstFocusable] = getFocusables(dialog);
      if (firstFocusable) {
        firstFocusable.focus();
        scrollIntoViewIfNeeded(firstFocusable);
      }
    } else if (lastFocusedBeforeModal) {
      if (document.contains(lastFocusedBeforeModal)) {
        lastFocusedBeforeModal.focus();
      }
      lastFocusedBeforeModal = null;
    }
  });
  observer.observe(modalEl, { attributes: true, attributeFilter: ["class"] });
}

function watchForModals() {
  document.querySelectorAll(".catalog-modal").forEach(observeModal);

  // El modal del catalogo se crea de forma perezosa (al abrirlo la primera
  // vez), asi que tambien observamos si aparece mas adelante.
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && node.classList && node.classList.contains("catalog-modal")) {
          observeModal(node);
        }
      });
    }
  }).observe(document.body, { childList: true });
}

function markFocusForFallback() {
  // Ademas de :focus-visible (que ya cubren los navegadores basados en
  // Chromium usados por Android TV), dejamos una clase explicita por si el
  // WebView del dispositivo no la soporta bien.
  //
  // Solo queremos que el borde grueso (.tv-focus) aparezca cuando el foco
  // llega por teclado/D-pad, no por click de mouse/touch. Para eso
  // llevamos la cuenta de cual fue el ultimo tipo de input usado.
  let lastInputWasPointer = false;

  document.addEventListener("pointerdown", () => { lastInputWasPointer = true; }, true);
  document.addEventListener("mousedown", () => { lastInputWasPointer = true; }, true);
  document.addEventListener("touchstart", () => { lastInputWasPointer = true; }, true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (Object.prototype.hasOwnProperty.call(ARROW_TO_DIRECTION, event.key) || event.key === "Tab") {
        lastInputWasPointer = false;
      }
    },
    true,
  );

  document.addEventListener(
    "focusin",
    (event) => {
      document.querySelectorAll(".tv-focus").forEach((el) => el.classList.remove("tv-focus"));
      if (event.target instanceof Element && event.target !== document.body && !lastInputWasPointer) {
        event.target.classList.add("tv-focus");
      }
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (event) => {
      if (event.target instanceof Element) {
        event.target.classList.remove("tv-focus");
      }
    },
    true,
  );
}

function init() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Backspace") {
      handleBack(event);
      return;
    }
    handleDirectional(event);
  });

  markFocusForFallback();
  watchForModals();
}

init();