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

import { remoteKey } from "./media-controls.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  // Excluimos type='range': son los sliders de progreso/volumen de Plyr.
  // Navegarlos con el D-pad (moviendo el foco hasta ahi y despues usando
  // izquierda/derecha para arrastrar de a poquito) es incomodo en TV. En su
  // lugar, izquierda/derecha adelantan/retroceden directamente sin
  // necesidad de enfocar nada (ver el keydown de player-page.js).
  "input:not([disabled]):not([type='hidden']):not([type='range'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe[tabindex='0']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const ARROW_TO_DIRECTION = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA"]);

// En TV el teclado en pantalla se abria con solo pasar por encima de un
// campo de texto, y luego las flechas movian el teclado en vez de salir del
// campo. Ahora el campo se puede recorrer como cualquier boton y el teclado
// solo se abre al pulsar OK sobre el. Mientras el teclado esta abierto, las
// flechas son del campo (cursor de texto).
function isEditing(el) {
  return Boolean(el && TEXT_ENTRY_TAGS.has(el.tagName) && el.dataset.tvEditing === "true");
}

function lockTextEntry(el) {
  if (!el || !TEXT_ENTRY_TAGS.has(el.tagName) || el.dataset.tvEditing === "true") return;
  if (!("tvInputMode" in el.dataset)) el.dataset.tvInputMode = el.getAttribute("inputmode") || "";
  el.setAttribute("inputmode", "none");
}

function startEditing(el) {
  el.dataset.tvEditing = "true";
  // Cambiar inputmode de "none" a un modo de texto con el campo enfocado es
  // lo que hace que Android TV muestre el teclado (blur/focus no lo abre).
  el.setAttribute("inputmode", el.dataset.tvInputMode || (el.type === "search" ? "search" : "text"));
}

document.addEventListener("focusin", (event) => lockTextEntry(event.target));
document.addEventListener("focusout", (event) => {
  const el = event.target;
  if (el?.dataset?.tvEditing === "true" && document.visibilityState === "visible") {
    window.setTimeout(() => {
      if (document.activeElement !== el) { delete el.dataset.tvEditing; lockTextEntry(el); }
    }, 0);
  }
});

function isVisible(el) {
  if (!el || el.closest("[hidden], [inert], [aria-hidden='true']") || el.disabled) return false;
  if (el.closest(".plyr--hide-controls") && el.closest(".plyr__controls")) return false;
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

// El menu hamburguesa (.site-nav) no usa las clases .catalog-modal, pero
// necesita el mismo comportamiento: mientras esta abierto, el D-pad debe
// quedar encerrado adentro (si no, el foco "se escapa" hacia el contenido
// de la pagina de abajo y hay que recorrer todo el catalogo para volver).
function getOpenSiteNav() {
  return document.querySelector(".site-nav.is-open");
}

function getOpenPlayerPanel() {
  return document.querySelector(".plyr__menu__container:not([hidden])")
    || document.querySelector(".season-dropdown-panel.open")
    || document.querySelector(".episode-grid-container.open");
}

function getOpenOverlay() {
  return getOpenModalDialog() || getOpenSiteNav() || getOpenPlayerPanel();
}

function getScopeRoot() {
  return getOpenOverlay() || (document.documentElement.classList.contains("tv-locked-fullscreen")
    ? document.getElementById("mediaSlot") : null) || document;
}

function getFocusables(root = getScopeRoot()) {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) =>
    isVisible(el) && !el.matches("input[type='range']"));
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
  // Si se solapan en el eje perpendicular (p. ej. el buscador del menu, mas
  // ancho que los enlaces de arriba), no se penaliza el desplazamiento: si
  // no, ganaba un boton mas lejano pero mejor centrado y el buscador quedaba
  // inalcanzable con el mando.
  const vertical = direction === "up" || direction === "down";
  const overlap = vertical
    ? Math.min(currentRect.right, candidateRect.right) - Math.max(currentRect.left, candidateRect.left)
    : Math.min(currentRect.bottom, candidateRect.bottom) - Math.max(currentRect.top, candidateRect.top);
  if (overlap > 0) perpendicular = 0;
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
  // Centrado vertical: con "nearest" las tarjetas altas quedaban cortadas
  // por abajo o tapadas por la cabecera fija.
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
}

// Al abrir una pagina no hay nada enfocado y la primera flecha iba al logo.
// Se prefiere la accion principal de cada pagina.
const PREFERRED_FIRST_FOCUS = [
  ".home-feature-play",
  "#mediaSlot .plyr__control--overlaid",
  ".catalog-main .catalog-card",
  ".catalog-main a, .catalog-main button",
];

function focusFirstAvailable() {
  const candidates = getFocusables();
  if (!candidates.length) return;
  const preferred = PREFERRED_FIRST_FOCUS
    .map((selector) => candidates.find((el) => el.matches(selector)))
    .find(Boolean);
  const target = preferred || candidates[0];
  target.focus();
  scrollIntoViewIfNeeded(target);
}

function handleBack(event) {
  const active = document.activeElement;
  if (isEditing(active)) return; // dejar borrar texto

  const openModal = document.querySelector(".catalog-modal.is-open");
  const openSearchDropdown = document.querySelector(".site-search-dropdown.is-open");
  const openSiteNav = getOpenSiteNav();
  const openSeasonDropdown = document.querySelector(".season-dropdown-panel.open");
  const openEpisodeGrid = document.querySelector(".episode-grid-container.open");
  const playerMenu = document.querySelector(".plyr__menu__container:not([hidden])");
  // Aviso de donacion: con el mando cuesta llegar a la X, asi que Atras lo cierra.
  const donationClose = document.querySelector(".donation-prompt .donation-prompt-close");
  if (!openModal && !openSearchDropdown && !openSiteNav && !openSeasonDropdown && !openEpisodeGrid && !playerMenu) {
    if (!donationClose) return false;
    event.preventDefault();
    donationClose.click();
    return true;
  }

  event.preventDefault();
  if (playerMenu) {
    document.querySelector(".plyr [data-plyr='settings']")?.click();
    document.querySelector(".plyr [data-plyr='settings']")?.focus();
    return true;
  }
  if (openSeasonDropdown) {
    document.getElementById("seasonSelectTrigger")?.click();
    document.getElementById("seasonSelectTrigger")?.focus();
    return true;
  }
  if (openEpisodeGrid) {
    document.getElementById("closeGridBtn")?.click();
    document.getElementById("toggleEpisodeBtn")?.focus();
    return true;
  }
  // Reutiliza los botones de cierre y sus manejadores de cada página.
  if (openModal) openModal.querySelector(".catalog-modal-close, .resume-dismiss, [data-modal-close]")?.click();
  else if (openSiteNav) document.querySelector("[data-nav-toggle]")?.click();
  else if (openSearchDropdown) openSearchDropdown.classList.remove("is-open");
  return true;
}

function handleDirectional(event) {
  const direction = ARROW_TO_DIRECTION[remoteKey(event)];
  if (!direction) return;

  const active = document.activeElement;

  // Dejar que los inputs de texto manejen sus propias flechas (cursor de texto).
  if (isEditing(active)) return;
  if (active && active.tagName === "SELECT") return;

  if (!active || active === document.body || !isVisible(active) || !getScopeRoot().contains(active)) {
    event.preventDefault();
    focusFirstAvailable();
    return;
  }

  const next = findNextFocus(active, direction);
  if (next) {
    event.preventDefault();
    next.focus();
    scrollIntoViewIfNeeded(next);
  } else if (getOpenOverlay() || document.documentElement.classList.contains("tv-locked-fullscreen")) {
    // Sin destino dentro del menu/panel o del reproductor a pantalla
    // completa: el WebView movia el foco por su cuenta hacia la pagina de
    // abajo (p. ej. al logo, escondido detras del video) y no habia vuelta.
    event.preventDefault();
    // Recien mostrados los controles del reproductor, botones como
    // "Episodios" siguen un instante con la animacion de entrada y aun no
    // cuentan como visibles: se reintenta una vez.
    window.setTimeout(() => {
      if (document.activeElement !== active) return;
      const retry = findNextFocus(active, direction);
      if (retry) { retry.focus(); scrollIntoViewIfNeeded(retry); }
    }, 260);
  }
}

function observeOverlay(overlayEl, dialogSelector) {
  let returnFocus = null;
  const onChange = () => {
    if (overlayEl.classList.contains("is-open")) {
      if (!overlayEl.contains(document.activeElement)) returnFocus = document.activeElement;
      const dialog = (dialogSelector && overlayEl.querySelector(dialogSelector)) || overlayEl;
      // Empezar por el contenido (primer capitulo/pelicula), no por "Cerrar":
      // para cerrar ya esta el boton Atras del mando.
      const focusables = getFocusables(dialog);
      const firstFocusable = focusables.find((el) => !el.matches(".catalog-modal-close")) || focusables[0];
      // Los capitulos llegan de TMDB un momento despues de abrir: si solo
      // estaba "Cerrar", pasar al primer contenido en cuanto aparezca (y
      // mientras el usuario no se haya movido).
      if (firstFocusable?.matches(".catalog-modal-close")) {
        // Puede que ya esten pero aun con la animacion de entrada (no
        // cuentan como visibles), o que lleguen despues: se reintenta un rato.
        let tries = 0;
        const moveToContent = () => {
          if (document.activeElement !== firstFocusable || !overlayEl.classList.contains("is-open")) return;
          const content = getFocusables(dialog).find((el) => !el.matches(".catalog-modal-close"));
          if (content) { content.focus(); scrollIntoViewIfNeeded(content); return; }
          if (++tries < 30) window.setTimeout(moveToContent, 250);
        };
        window.setTimeout(moveToContent, 150);
      }
      if (firstFocusable) {
        firstFocusable.focus();
        scrollIntoViewIfNeeded(firstFocusable);
      }
    } else if (returnFocus) {
      if (document.contains(returnFocus)
        && (overlayEl.contains(document.activeElement) || document.activeElement === document.body)) {
        returnFocus.focus();
      }
      returnFocus = null;
    }
  };
  new MutationObserver(onChange).observe(overlayEl, { attributes: true, attributeFilter: ["class"] });
  // La ficha del catalogo se crea y se abre en el mismo instante la primera
  // vez: cuando se empieza a vigilar ya esta abierta y no habra cambio de clase.
  if (overlayEl.classList.contains("is-open")) onChange();
}

function watchForModals() {
  document.querySelectorAll(".catalog-modal").forEach((el) => observeOverlay(el, ".catalog-modal-dialog"));
  // El menu hamburguesa (.site-nav) tambien necesita que el foco entre al
  // primer link apenas se abre, igual que un modal.
  document.querySelectorAll(".site-nav").forEach((el) => observeOverlay(el));

  // El modal del catalogo se crea de forma perezosa (al abrirlo la primera
  // vez), asi que tambien observamos si aparece mas adelante.
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && node.classList && node.classList.contains("catalog-modal")) {
          observeOverlay(node, ".catalog-modal-dialog");
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
      const isPlaybackSurface = event.target instanceof Element
        && event.target.matches("#mediaSlot, #mediaSlot video, #mediaSlot iframe, #mediaSlot .plyr, #mediaSlot .plyr__video-wrapper");
      if (event.target instanceof Element && event.target !== document.body && !isPlaybackSurface && !lastInputWasPointer) {
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

// En la primera pagina de la app, Atras cerraba Colevana de golpe (y las
// siguientes pulsaciones caian en otra app). Ahora el primer Atras avisa y
// solo el segundo, dentro de unos segundos, deja salir.
let exitArmedUntil = 0;
function confirmExit() {
  if (window.history.length > 1) return false; // hay pagina anterior: volver
  if (Date.now() < exitArmedUntil) return false; // segundo Atras: salir
  exitArmedUntil = Date.now() + 3000;
  let toast = document.getElementById("tvExitToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "tvExitToast";
    toast.className = "tv-exit-toast";
    toast.setAttribute("role", "status");
    toast.textContent = "Pulsa Atrás otra vez para salir de Colevana";
    document.body.appendChild(toast);
  }
  toast.classList.add("is-visible");
  window.setTimeout(() => toast.classList.remove("is-visible"), 3000);
  return true;
}

function init() {
  window.ColevanaHandleBack = () => handleBack({ preventDefault() {} }) === true
    || window.ColevanaRemote?.hideControls?.() === true
    || confirmExit();
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const key = remoteKey(event);
    if (key === "Backspace" || key === "Escape" || key === "BrowserBack" || key === "GoBack") {
      handleBack(event);
      return;
    }
    if (["Enter", "Select", "Accept"].includes(key)) {
      const active = document.activeElement;
      if (active && TEXT_ENTRY_TAGS.has(active.tagName) && !isEditing(active)) {
        event.preventDefault();
        startEditing(active);
        return;
      }
      // Escribiendo en un buscador: Enter/OK lanza la busqueda (el WebView de
      // TV no siempre hace el envio implicito del formulario).
      if (isEditing(active) && active.tagName === "INPUT" && active.form) {
        event.preventDefault();
        if (active.value.trim()) active.form.requestSubmit();
        return;
      }
      if (active?.matches("button, a, [role='button'], [role='menuitemradio']") && isVisible(active)) {
        event.preventDefault();
        if (!event.repeat) active.click();
      } else if (active === document.body) {
        event.preventDefault();
        focusFirstAvailable();
      }
      return;
    }
    handleDirectional(event);
  });

  markFocusForFallback();
  watchForModals();

  // Con el mando hay que ver desde el principio que esta seleccionado. En el
  // reproductor no: alli el foco lo maneja player-page.js.
  if (document.body?.dataset.page !== "player") {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) focusFirstAvailable();
    }, 900);
  }
}

init();
