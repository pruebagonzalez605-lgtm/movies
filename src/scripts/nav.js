const navButtons = document.querySelectorAll("[data-nav-toggle]");

function closeOpenNav() {
  const openNav = document.querySelector(".site-nav.is-open");
  const openButton = document.querySelector("[data-nav-toggle][aria-expanded='true']");
  if (!openNav || !openButton) return;

  openNav.classList.remove("is-open");
  openButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("nav-open");
  // Devuelve el foco al boton de hamburguesa para que, en TV, el control
  // remoto quede sobre un elemento visible y no "perdido" en el limbo.
  openButton.focus();
}

navButtons.forEach((button) => {
  const navId = button.getAttribute("aria-controls");
  const nav = navId ? document.getElementById(navId) : null;
  if (!nav) return;

  button.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    button.setAttribute("aria-expanded", String(isOpen));
    document.body.classList.toggle("nav-open", isOpen);
  });
});

document.addEventListener("click", (event) => {
  const openNav = document.querySelector(".site-nav.is-open");
  const openButton = document.querySelector("[data-nav-toggle][aria-expanded='true']");
  if (!openNav || !openButton) return;

  const clickedInsideNav = openNav.contains(event.target);
  const clickedButton = openButton.contains(event.target);
  if (clickedInsideNav || clickedButton) return;

  closeOpenNav();
});

// Con un control remoto no hay "click afuera" para cerrar el menu: el
// boton "atras"/"back" del control dispara Escape (via spatial-nav.js) o
// Backspace directamente. Cerramos el menu igual que con el click afuera.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" && event.key !== "Backspace") return;
  const openNav = document.querySelector(".site-nav.is-open");
  if (!openNav) return;
  closeOpenNav();
});

// Boton "Volver arriba" al final de cada apartado (.catalog-section) de
// la pagina. Cada seccion puede crecer bastante (grillas largas de
// peliculas/series, temporadas, etc.), asi que este boton hace scroll
// de vuelta al inicio de ESA seccion puntual, no de toda la pagina.
function addBackToTopButtons() {
  document.querySelectorAll(".catalog-section").forEach((section) => {
    // Ya tiene su boton (por ejemplo si esta funcion corre de nuevo
    // porque el contenido de la seccion se termino de cargar).
    if (section.querySelector(":scope > .catalog-back-to-top")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "catalog-back-to-top";
    button.setAttribute("aria-label", "Volver al inicio de esta seccion");
    button.innerHTML = '<span class="catalog-back-to-top-icon" aria-hidden="true">&uarr;</span> Volver arriba';
    button.addEventListener("click", () => {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    section.appendChild(button);
  });
}

addBackToTopButtons();

// Varias secciones (por ejemplo "Explorar mas" en movies/series/sagas)
// arrancan vacias u ocultas y se llenan de forma asincronica despues de
// que este script corre (ver catalog.js, home.js, suggestions-page.js).
// Observamos el contenido principal para agregar el boton tambien a esas
// secciones en cuanto aparecen, sin tener que tocar cada script.
const catalogMain = document.querySelector(".catalog-main");
if (catalogMain) {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    // Agrupamos varias mutaciones seguidas (ej: se insertan 20 tarjetas
    // de golpe) en una sola pasada, en vez de recorrer el DOM por cada
    // nodo agregado.
    requestAnimationFrame(() => {
      scheduled = false;
      addBackToTopButtons();
    });
  });
  observer.observe(catalogMain, { childList: true, subtree: true });
}