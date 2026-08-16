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