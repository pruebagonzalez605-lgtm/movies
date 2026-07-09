const navButtons = document.querySelectorAll("[data-nav-toggle]");

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

  openNav.classList.remove("is-open");
  openButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("nav-open");
});
