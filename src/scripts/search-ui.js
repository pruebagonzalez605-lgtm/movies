import { searchSite } from "./shared/catalog-data.js";

function buildDropdownCard(result) {
  const link = document.createElement("a");
  link.className = "site-search-result";
  link.href = result.href;
  link.innerHTML = `
    <div class="site-search-result-art"></div>
    <div class="site-search-result-copy">
      <span>${result.code}</span>
      <strong>${result.title}</strong>
      <small>${result.subtitle}</small>
    </div>
  `;

  const art = link.querySelector(".site-search-result-art");
  if (result.poster) {
    art.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.72)), url('${result.poster}')`;
    art.style.backgroundSize = "cover";
    art.style.backgroundPosition = "center";
  } else {
    art.style.background = `linear-gradient(160deg, ${result.gradient[0]}, ${result.gradient[1]})`;
  }

  return link;
}

function closeDropdown(form) {
  const dropdown = form.querySelector(".site-search-dropdown");
  if (!dropdown) return;
  dropdown.classList.remove("is-open");
  dropdown.innerHTML = "";
}

function openDropdown(form) {
  const dropdown = form.querySelector(".site-search-dropdown");
  if (!dropdown) return;
  dropdown.classList.add("is-open");
}

function initSearchForm(form) {
  const input = form.querySelector(".site-search-input");
  const dropdown = form.querySelector(".site-search-dropdown");
  if (!input || !dropdown) return;

  let debounceId = null;
  let token = 0;

  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(debounceId);

    if (query.length < 2) {
      closeDropdown(form);
      return;
    }

    debounceId = window.setTimeout(async () => {
      const currentToken = ++token;
      dropdown.innerHTML = '<div class="site-search-empty">Buscando...</div>';
      openDropdown(form);

      const results = await searchSite(query, { limit: 6 });
      if (currentToken !== token) return;

      dropdown.innerHTML = "";
      if (!results.length) {
        dropdown.innerHTML = '<div class="site-search-empty">Sin coincidencias.</div>';
        openDropdown(form);
        return;
      }

      results.forEach((result) => {
        dropdown.appendChild(buildDropdownCard(result));
      });
      openDropdown(form);
    }, 180);
  });

  input.addEventListener("focus", () => {
    if (dropdown.innerHTML.trim()) {
      openDropdown(form);
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDropdown(form);
      input.blur();
    }
  });
}

document.querySelectorAll(".site-search").forEach(initSearchForm);

document.addEventListener("click", (event) => {
  document.querySelectorAll(".site-search").forEach((form) => {
    if (form.contains(event.target)) return;
    closeDropdown(form);
  });
});
