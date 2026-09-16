/**
 * Filtro de géneros reutilizable (web / celular / TV).
 *
 * Construye toda la UI por JS a partir de un contenedor vacío, así que
 * cualquier página puede tener el mismo diseño con solo poner:
 *
 *   <div data-genre-filter></div>
 *
 * y llamar a createGenreFilter({ mount, onChange }).
 *
 * Detalles pensados para cada pantalla:
 *  - Celular: carrusel horizontal con scroll-snap y márgenes de seguridad.
 *  - Web: mismas píldoras + flechas laterales para navegar con el mouse.
 *  - TV: píldoras más grandes, foco visible y auto-scroll al enfocar con el
 *    D-pad (el navegador centra el chip enfocado dentro del riel).
 */

import { GENRE_BY_ID } from "../config/genres.js";

/** "#f59e0b" -> "245,158,11" (para usar en rgba() sin depender de color-mix) */
export function hexToRgbChannels(hex) {
  if (typeof hex !== "string") return "232,196,104";
  let value = hex.trim().replace("#", "");
  if (value.length === 3) {
    value = value.split("").map((c) => c + c).join("");
  }
  if (value.length !== 6 || /[^0-9a-f]/i.test(value)) return "232,196,104";
  const int = parseInt(value, 16);
  return `${(int >> 16) & 255},${(int >> 8) & 255},${int & 255}`;
}

/** Píldora de género para usar dentro de las tarjetas del catálogo */
export function genrePillHtml(genreId) {
  const def = GENRE_BY_ID[genreId];
  if (!def) return "";
  const rgb = hexToRgbChannels(def.color);
  return `<div class="card-genre-pills"><span class="card-genre-pill" style="--pill-color:${def.color};--pill-rgb:${rgb}"><span class="card-genre-pill-emoji">${def.emoji}</span>${def.name}</span></div>`;
}

/** Inserta / actualiza la píldora de género dentro de una tarjeta ya creada */
export function applyGenrePillToCard(card, genreId) {
  if (!card) return;
  const copy = card.querySelector(".catalog-card-copy, .search-result-copy");
  if (!copy) return;
  const existing = copy.querySelector(".card-genre-pills");
  const html = genrePillHtml(genreId);
  if (!html) {
    existing?.remove();
    return;
  }
  const temp = document.createElement("div");
  temp.innerHTML = html;
  const pills = temp.firstElementChild;
  if (existing) {
    existing.replaceWith(pills);
    return;
  }
  const title = copy.querySelector("h3");
  if (title && title.nextSibling) {
    copy.insertBefore(pills, title.nextSibling);
  } else {
    copy.appendChild(pills);
  }
}

const SECTION_TEMPLATE = `
  <div class="genre-filter-glow" aria-hidden="true"></div>
  <div class="genre-filter-header">
    <div class="genre-filter-heading">
      <span class="genre-filter-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h16M7 12h10M10 19h4" />
        </svg>
      </span>
      <span class="genre-filter-label" data-genre-label>Género</span>
      <span class="genre-filter-status" data-genre-status aria-live="polite"></span>
    </div>
    <button type="button" class="genre-clear-btn" data-genre-clear hidden>
      <span aria-hidden="true">✕</span> Limpiar
    </button>
  </div>
  <div class="genre-rail">
    <button type="button" class="genre-rail-arrow genre-rail-arrow-prev" data-genre-arrow="-1" aria-label="Ver géneros anteriores" tabindex="-1">‹</button>
    <div class="genre-chips" data-genre-chips role="group" aria-label="Géneros disponibles"></div>
    <button type="button" class="genre-rail-arrow genre-rail-arrow-next" data-genre-arrow="1" aria-label="Ver más géneros" tabindex="-1">›</button>
  </div>
`;

export function createGenreFilter({ mount, label = "Género", onChange } = {}) {
  if (!mount) return null;

  const section = document.createElement("section");
  section.className = "genre-filter-section is-loading";
  section.setAttribute("aria-label", "Filtrar por género");
  section.innerHTML = SECTION_TEMPLATE;

  if (mount.tagName === "SECTION" || mount.dataset.genreFilter !== undefined) {
    mount.replaceWith(section);
  } else {
    mount.appendChild(section);
  }

  const chipsEl = section.querySelector("[data-genre-chips]");
  const statusEl = section.querySelector("[data-genre-status]");
  const clearBtn = section.querySelector("[data-genre-clear]");
  const labelEl = section.querySelector("[data-genre-label]");
  labelEl.textContent = label;

  const state = { selected: null, genres: [] };

  function emit() {
    updateActiveStyles();
    if (typeof onChange === "function") onChange(state.selected);
  }

  function select(id) {
    state.selected = state.selected === id ? null : id;
    emit();
  }

  function updateActiveStyles() {
    const def = state.selected ? GENRE_BY_ID[state.selected] : null;
    section.classList.toggle("has-active", Boolean(def));
    section.style.setProperty(
      "--active-rgb",
      def ? hexToRgbChannels(def.color) : "232,196,104"
    );
    chipsEl.querySelectorAll(".genre-chip").forEach((chip) => {
      const id = chip.dataset.genreId || null;
      const active = (id || null) === state.selected;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (clearBtn) clearBtn.hidden = state.selected == null;

    const activeChip = chipsEl.querySelector(".genre-chip.is-active");
    if (activeChip && typeof activeChip.scrollIntoView === "function") {
      activeChip.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }

  function buildChip({ id, name, emoji, color, count }) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "genre-chip" + (id ? "" : " genre-chip-all");
    chip.dataset.genreId = id || "";
    chip.setAttribute("aria-pressed", "false");
    chip.style.setProperty("--genre-color", color);
    chip.style.setProperty("--genre-rgb", hexToRgbChannels(color));
    chip.innerHTML = `
      <span class="genre-chip-emoji" aria-hidden="true">${emoji}</span>
      <span class="genre-chip-name">${name}</span>
      ${count != null ? `<span class="genre-chip-count">${count}</span>` : ""}
    `;
    chip.addEventListener("click", () => select(id || null));
    return chip;
  }

  function setGenres(genres, { total } = {}) {
    state.genres = genres || [];
    section.classList.remove("is-loading");
    chipsEl.innerHTML = "";

    const totalCount = total != null
      ? total
      : state.genres.reduce((sum, g) => sum + (g.count || 0), 0);

    chipsEl.appendChild(
      buildChip({ id: null, name: "Todos", emoji: "✨", color: "#e8c468", count: totalCount })
    );
    state.genres.forEach((g) => chipsEl.appendChild(buildChip(g)));

    section.hidden = state.genres.length === 0;
    updateActiveStyles();
    requestAnimationFrame(updateArrows);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function setLoading(text = "Detectando géneros…") {
    section.classList.add("is-loading");
    chipsEl.innerHTML = `
      <span class="genre-chip genre-chip-skeleton"></span>
      <span class="genre-chip genre-chip-skeleton"></span>
      <span class="genre-chip genre-chip-skeleton"></span>
      <span class="genre-chip genre-chip-skeleton"></span>
    `;
    setStatus(text);
  }

  function reset() {
    state.selected = null;
    emit();
  }

  /* ----- Flechas del riel (solo web con mouse) ----- */
  function updateArrows() {
    const scrollable = chipsEl.scrollWidth - chipsEl.clientWidth > 8;
    section.classList.toggle("can-scroll", scrollable);
    section.classList.toggle("at-start", chipsEl.scrollLeft <= 4);
    section.classList.toggle(
      "at-end",
      chipsEl.scrollLeft >= chipsEl.scrollWidth - chipsEl.clientWidth - 4
    );
  }

  section.querySelectorAll("[data-genre-arrow]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = Number(btn.dataset.genreArrow) || 1;
      chipsEl.scrollBy({ left: dir * Math.max(220, chipsEl.clientWidth * 0.7), behavior: "smooth" });
    });
  });
  chipsEl.addEventListener("scroll", updateArrows, { passive: true });
  window.addEventListener("resize", updateArrows);

  // Shift + rueda desplaza el riel (el scroll vertical normal de la pagina
  // se respeta para no molestar al navegar).
  chipsEl.addEventListener(
    "wheel",
    (event) => {
      if (!event.shiftKey) return;
      if (chipsEl.scrollWidth <= chipsEl.clientWidth) return;
      event.preventDefault();
      chipsEl.scrollBy({ left: event.deltaY, behavior: "smooth" });
    },
    { passive: false }
  );

  if (clearBtn) clearBtn.addEventListener("click", reset);

  setLoading();

  return {
    element: section,
    setGenres,
    setStatus,
    setLoading,
    reset,
    get selected() {
      return state.selected;
    },
  };
}
