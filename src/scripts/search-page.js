import { initKickAuthUI } from "./shared/kick-auth-ui.js";
import {
  searchSite,
  resolveItemGenre,
  getItemGenreSync,
} from "./shared/catalog-data.js";
import { GENRE_DEFINITIONS, GENRE_BY_ID } from "./config/genres.js";
import { createGenreFilter, genrePillHtml } from "./ui/genre-filter.js";

const params = new URLSearchParams(window.location.search);
const query = (params.get("q") || "").trim();
const titleNode = document.getElementById("searchTitle");
const introNode = document.getElementById("searchIntro");
const countNode = document.getElementById("searchCount");
const resultsNode = document.getElementById("searchResults");
const genreFilterMount = document.querySelector("[data-genre-filter]");

const state = {
  results: [],
  genreById: new Map(), // result -> genreId | null
  selected: null,
};

const genreFilter = genreFilterMount
  ? createGenreFilter({
      mount: genreFilterMount,
      label: "Filtrar resultados",
      onChange: (selected) => {
        state.selected = selected;
        renderResults();
      },
    })
  : null;

if (genreFilter) genreFilter.element.hidden = true;

function renderResultCard(result) {
  const card = document.createElement("a");
  card.className = "search-result-card";
  card.href = result.href;
  const pills = genrePillHtml(state.genreById.get(result));
  card.innerHTML = `
    <div class="search-result-art"></div>
    <div class="search-result-copy">
      <span class="catalog-card-code">${result.code}</span>
      <h3>${result.title}</h3>
      ${pills}
      <div class="search-result-subtitle">${result.subtitle}</div>
      <p>${result.description}</p>
    </div>
  `;

  const art = card.querySelector(".search-result-art");
  if (result.poster) {
    art.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.78)), url('${result.poster}')`;
    art.style.backgroundSize = "cover";
    art.style.backgroundPosition = "center";
  } else {
    art.style.background = `linear-gradient(160deg, ${result.gradient[0]}, ${result.gradient[1]})`;
  }

  return card;
}

function renderResults() {
  const visible = state.selected
    ? state.results.filter((result) => state.genreById.get(result) === state.selected)
    : state.results;

  resultsNode.innerHTML = "";
  if (!visible.length) {
    resultsNode.innerHTML = `<div class="catalog-empty genre-empty">Ningún resultado de este género.</div>`;
  } else {
    visible.forEach((result) => resultsNode.appendChild(renderResultCard(result)));
  }

  if (genreFilter) {
    const name = state.selected ? GENRE_BY_ID[state.selected]?.name : null;
    genreFilter.setStatus(
      name ? `${visible.length} en ${name}` : `${state.results.length} resultados`
    );
  }

  countNode.textContent = state.selected
    ? `${visible.length} de ${state.results.length} resultados`
    : `${state.results.length} resultados encontrados`;
}

/** Resuelve los generos de los resultados y muestra el filtro si vale la pena */
async function setupGenres() {
  if (!genreFilter) return;

  const resolved = await Promise.all(
    state.results.map((result) =>
      result.sourceItem
        ? Promise.resolve(resolveItemGenre(result.sourceItem, result.sourceKind || "movie")).catch(
            () => getItemGenreSync(result.sourceItem)
          )
        : Promise.resolve(null)
    )
  );
  state.results.forEach((result, index) => state.genreById.set(result, resolved[index]));

  const counts = new Map();
  resolved.forEach((genre) => {
    if (!genre) return;
    counts.set(genre, (counts.get(genre) || 0) + 1);
  });

  const available = GENRE_DEFINITIONS.filter((g) => counts.has(g.id)).map((g) => ({
    ...g,
    count: counts.get(g.id),
  }));

  genreFilter.setGenres(available, { total: state.results.length });
  // Con un solo genero el filtro no aporta nada (setGenres puede volver a
  // mostrarlo, por eso se oculta despues).
  genreFilter.element.hidden = available.length < 2;
  renderResults();
}

async function init() {
  initKickAuthUI();

  document.querySelectorAll(".site-search-input").forEach((input) => {
    input.value = query;
  });

  if (!query) {
    titleNode.textContent = "Busca en tu cartelera";
    introNode.textContent = "Encuentra peliculas, series, sagas o capitulos desde un solo lugar.";
    countNode.textContent = "Escribe algo en la barra para empezar.";
    resultsNode.innerHTML = "";
    if (genreFilter) genreFilter.element.hidden = true;
    return;
  }

  titleNode.textContent = `Resultados para "${query}"`;
  introNode.textContent = "Tu buscador revisa peliculas, series, sagas y episodios disponibles dentro del sitio.";
  countNode.textContent = "Buscando...";

  const results = await searchSite(query);
  state.results = results;
  state.selected = null;

  if (!results.length) {
    countNode.textContent = "No se encontraron coincidencias.";
    resultsNode.innerHTML = "";
    if (genreFilter) genreFilter.element.hidden = true;
    return;
  }

  renderResults();
  setupGenres();
}

init();
