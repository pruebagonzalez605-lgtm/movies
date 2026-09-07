import {
  buildEpisodePlayerUrl,
  buildMoviePlayerUrl,
  ensureSeasonEpisodes,
  getMoviesSorted,
  getSagas,
  getSeriesSorted,
  resolveMovieCardPoster,
  resolveSagaCardPoster,
  resolveSeriesCardPoster,
  isNewItem,
  resolveAllGenres,
  collectAvailableGenres,
  filterItemsByGenre,
  getItemGenreSync,
} from "./shared/catalog-data.js";
import { GENRE_BY_ID, resolveGenreDef } from "./config/genres.js";
import { initKickAuthUI } from "./shared/kick-auth-ui.js";

const page = document.body.dataset.page || "movies";
const heroKicker = document.getElementById("catalogHeroKicker");
const heroTitle = document.getElementById("catalogHeroTitle");
const heroIntro = document.getElementById("catalogHeroIntro");
const spotlight = document.getElementById("catalogSpotlight");
const primaryGrid = document.getElementById("catalogPrimaryGrid");
const secondarySection = document.getElementById("catalogSecondarySection");
const genreChipsEl = document.getElementById("genreChips");
const genreClearBtn = document.getElementById("genreClearBtn");
const genreFilterStatus = document.getElementById("genreFilterStatus");

let modalElements = null;

/** Estado del filtro de género (uno solo a la vez) */
const genreState = {
  selected: null, // string id o null (= todos)
  resolvedMap: null, // Map<item, string|null>
  allItems: [],
  kind: "movie", // "movie" | "series"
  posters: [],
};

function applyPosterImage(node, posterUrl, gradient, options = {}) {
  const overlay = options.overlay || "linear-gradient(180deg, rgba(8,8,12,0.12), rgba(8,8,12,0.85))";
  node.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  if (!posterUrl) return;
  const img = new Image();
  img.onload = () => {
    node.style.backgroundImage = `${overlay}, url('${posterUrl}')`;
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
  };
  img.src = posterUrl;
}

function setHeroContent(config) {
  heroKicker.textContent = config.kicker;
  heroTitle.textContent = config.title;
  heroIntro.textContent = config.intro;
  spotlight.innerHTML = "";
  spotlight.classList.toggle("catalog-spotlight-compact", config.spotlightStyle === "compact");
  config.spotlight.forEach((item) => {
    const cardTag = item.href ? "a" : "div";
    const card = document.createElement(cardTag);
    card.className = `catalog-spotlight-card catalog-spotlight-note${config.spotlightStyle === "compact" ? " is-compact" : ""}`;
    if (item.href) card.href = item.href;
    if (config.spotlightStyle === "compact") {
      card.innerHTML = `
        <span>${item.label || config.kicker}</span>
        <strong>${item.title || item}</strong>
      `;
      if (item.poster) {
        applyPosterImage(card, item.poster, item.gradient || ["#1c1c22", "#141419"], {
          overlay:
            "linear-gradient(180deg, rgba(8,8,12,0.1) 0%, rgba(8,8,12,0.18) 35%, rgba(8,8,12,0.55) 62%, rgba(8,8,12,0.95) 100%)",
        });
      }
    } else {
      card.innerHTML = `<span>Vista</span><strong>${item}</strong>`;
    }
    spotlight.appendChild(card);
  });
}

function ensureCatalogModal() {
  if (modalElements) return modalElements;

  const overlay = document.createElement("div");
  overlay.className = "catalog-modal";
  overlay.innerHTML = `
    <div class="catalog-modal-dialog">
      <button class="catalog-modal-close" type="button" aria-label="Cerrar modal">Cerrar</button>
      <div class="catalog-modal-head">
        <span class="catalog-kicker" data-modal-kicker>Seleccion</span>
        <h2 data-modal-title>Explorar</h2>
        <p data-modal-intro>Selecciona el contenido que quieres abrir.</p>
      </div>
      <div class="catalog-modal-content" data-modal-content></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector(".catalog-modal-close");
  const modal = {
    overlay,
    closeBtn,
    kicker: overlay.querySelector("[data-modal-kicker]"),
    title: overlay.querySelector("[data-modal-title]"),
    intro: overlay.querySelector("[data-modal-intro]"),
    content: overlay.querySelector("[data-modal-content]"),
    close() {
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
    },
  };

  closeBtn.addEventListener("click", () => modal.close());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) modal.close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.close();
  });

  modalElements = modal;
  return modal;
}

function openCatalogModal({ kicker, title, intro, buildContent }) {
  const modal = ensureCatalogModal();
  modal.kicker.textContent = kicker;
  modal.title.textContent = title;
  modal.intro.textContent = intro;
  modal.content.innerHTML = "";
  buildContent(modal.content);
  modal.overlay.classList.add("is-open");
  document.body.classList.add("modal-open");
}

function buildGenrePillsHtml(item) {
  const genreId = getItemGenreSync(item);
  if (!genreId) return "";
  const def = resolveGenreDef(genreId);
  if (!def) return "";
  return `<div class="card-genre-pills"><span class="card-genre-pill" style="--pill-color:${def.color}">${def.name}</span></div>`;
}

function createMovieCard(movie, posterUrl) {
  const link = document.createElement("a");
  link.className = "catalog-card";
  link.href = buildMoviePlayerUrl(movie);
  const newBadge = isNewItem(movie)
    ? '<span class="catalog-new-badge">Nuevo</span>'
    : "";
  const genrePills = buildGenrePillsHtml(movie);
  link.innerHTML = `
    <div class="catalog-card-art">${newBadge}</div>
    <div class="catalog-card-copy">
      <span class="catalog-card-code">${movie.code || "Movie"}</span>
      <h3>${movie.title}</h3>
      ${genrePills}
      <p>${movie.saga ? `Parte de ${movie.saga}` : "Entrar directo al reproductor dedicado."}</p>
      <span class="catalog-link">Ver ahora</span>
    </div>
  `;
  applyPosterImage(link.querySelector(".catalog-card-art"), posterUrl, movie.gradient || ["#1c1c22", "#141419"]);
  return link;
}

function createSeriesCard(serie, posterUrl) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "catalog-card catalog-card-series catalog-select-card";
  const newBadge = isNewItem(serie)
    ? '<span class="catalog-new-badge">Nuevo</span>'
    : "";
  const genrePills = buildGenrePillsHtml(serie);
  card.innerHTML = `
    <div class="catalog-card-art">${newBadge}</div>
    <div class="catalog-card-copy">
      <span class="catalog-card-code">Serie</span>
      <h3>${serie.title}</h3>
      ${genrePills}
      <p>${serie.seasons.length} temporadas disponibles para explorar antes de reproducir.</p>
      <span class="catalog-link catalog-link-ghost">Ver temporadas</span>
    </div>
  `;
  applyPosterImage(card.querySelector(".catalog-card-art"), posterUrl, serie.gradient || ["#1c1c22", "#141419"]);
  return card;
}

function createEpisodeLink(serie, seasonNumber, episode, index) {
  const item = document.createElement("a");
  item.className = "catalog-inline-card";
  item.href = buildEpisodePlayerUrl(serie, seasonNumber, index + 1);
  item.innerHTML = `
    <div class="catalog-inline-thumb">
      <span class="catalog-inline-index">E${index + 1}</span>
    </div>
    <div class="catalog-inline-copy">
      <strong>${episode.title || `Episodio ${index + 1}`}</strong>
      <span>${episode.description || `Temporada ${seasonNumber}`}</span>
    </div>
  `;
  applyPosterImage(
    item.querySelector(".catalog-inline-thumb"),
    episode.poster || null,
    serie.gradient || ["#1c1c22", "#141419"],
  );
  return item;
}

function createMovieInlineCard(movie, posterUrl, secondaryText) {
  const item = document.createElement("a");
  item.className = "catalog-inline-card catalog-inline-card-poster";
  item.href = buildMoviePlayerUrl(movie);
  item.innerHTML = `
    <div class="catalog-inline-thumb catalog-inline-thumb-poster">
      <span class="catalog-inline-index">${movie.code || "Movie"}</span>
    </div>
    <div class="catalog-inline-copy">
      <strong>${movie.title}</strong>
      <span>${secondaryText}</span>
    </div>
  `;
  applyPosterImage(
    item.querySelector(".catalog-inline-thumb"),
    posterUrl || movie.poster || null,
    movie.gradient || ["#1c1c22", "#141419"],
  );
  return item;
}

function renderGenreChips(availableGenres) {
  if (!genreChipsEl) return;
  genreChipsEl.innerHTML = "";

  // Chip "Todos"
  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "genre-chip genre-chip-all" + (genreState.selected == null ? " is-active" : "");
  allChip.dataset.genreId = "";
  allChip.innerHTML = `<span class="genre-chip-emoji">✨</span> Todos`;
  allChip.addEventListener("click", () => {
    genreState.selected = null;
    applyGenreFilter();
  });
  genreChipsEl.appendChild(allChip);

  availableGenres.forEach((g) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "genre-chip" + (genreState.selected === g.id ? " is-active" : "");
    chip.dataset.genreId = g.id;
    chip.style.setProperty("--genre-color", g.color);
    chip.innerHTML = `<span class="genre-chip-emoji">${g.emoji}</span> ${g.name} <span class="genre-chip-count">${g.count}</span>`;
    chip.addEventListener("click", () => {
      // Un solo género a la vez (toggle)
      genreState.selected = genreState.selected === g.id ? null : g.id;
      applyGenreFilter();
    });
    genreChipsEl.appendChild(chip);
  });

  if (genreClearBtn) {
    genreClearBtn.hidden = genreState.selected == null;
    genreClearBtn.onclick = () => {
      genreState.selected = null;
      applyGenreFilter();
    };
  }
}

function updateGenreStatus(visibleCount, totalCount) {
  if (!genreFilterStatus) return;
  if (genreState.selected == null) {
    genreFilterStatus.textContent = `${totalCount} títulos en el catálogo`;
  } else {
    const name = GENRE_BY_ID[genreState.selected]?.name || genreState.selected;
    genreFilterStatus.textContent = `${visibleCount} de ${totalCount} · Género: ${name}`;
  }
}

function applyGenreFilter() {
  const filtered = filterItemsByGenre(
    genreState.allItems,
    genreState.selected,
    genreState.resolvedMap
  );

  if (genreChipsEl) {
    genreChipsEl.querySelectorAll(".genre-chip").forEach((chip) => {
      const id = chip.dataset.genreId;
      if (id === "") {
        chip.classList.toggle("is-active", genreState.selected == null);
      } else {
        chip.classList.toggle("is-active", genreState.selected === id);
      }
    });
  }
  if (genreClearBtn) genreClearBtn.hidden = genreState.selected == null;

  primaryGrid.innerHTML = "";
  if (filtered.length === 0) {
    primaryGrid.innerHTML = `<div class="catalog-empty genre-empty">No hay títulos en este género.</div>`;
  } else if (genreState.kind === "movie") {
    filtered.forEach((movie) => {
      const idx = genreState.allItems.indexOf(movie);
      primaryGrid.appendChild(createMovieCard(movie, genreState.posters[idx]));
    });
  } else {
    filtered.forEach((serie) => {
      const idx = genreState.allItems.indexOf(serie);
      const card = createSeriesCard(serie, genreState.posters[idx]);
      card.addEventListener("click", () => {
        [...primaryGrid.children].forEach((node) => node.classList.remove("is-selected"));
        card.classList.add("is-selected");
        openCatalogModal({
          kicker: "Serie",
          title: serie.title,
          intro: "Selecciona una temporada y entra al episodio que quieras ver.",
          buildContent(content) {
            serie.seasons.forEach((season) => {
              const block = document.createElement("section");
              block.className = "catalog-modal-section";
              block.innerHTML = `
                <div class="catalog-season-title">Temporada ${season.season}</div>
                <div class="catalog-inline-grid"><div class="catalog-empty">Cargando episodios...</div></div>
              `;
              content.appendChild(block);
              const grid = block.querySelector(".catalog-inline-grid");
              ensureSeasonEpisodes(serie, season).then((episodes) => {
                grid.innerHTML = "";
                if (!episodes.length) {
                  grid.innerHTML = '<div class="catalog-empty">Proximamente.</div>';
                  return;
                }
                episodes.forEach((episode, episodeIndex) => {
                  grid.appendChild(createEpisodeLink(serie, season.season, episode, episodeIndex));
                });
              });
            });
          },
        });
      });
      primaryGrid.appendChild(card);
    });
  }

  updateGenreStatus(filtered.length, genreState.allItems.length);
}

async function setupGenreFilters(items, kind) {
  genreState.allItems = items;
  genreState.kind = kind;
  genreState.selected = null;

  if (genreFilterStatus) {
    genreFilterStatus.textContent = "Detectando géneros…";
  }

  genreState.resolvedMap = await resolveAllGenres(items, kind);
  const available = collectAvailableGenres(items, genreState.resolvedMap);
  renderGenreChips(available);
  updateGenreStatus(items.length, items.length);
}

async function renderMoviesPage() {
  const movies = getMoviesSorted();
  setHeroContent({
    kicker: "Movies",
    title: "Explora la cartelera antes de entrar a reproducir.",
    intro: "Ahora las peliculas viven en un catalogo visual. Primero navegas, eliges el titulo y luego entras a una pagina de reproduccion separada. Filtra por categoría para encontrar más rápido.",
    spotlight: ["Catalogo visual", "Filtro por género", "Player dedicado"],
    spotlightStyle: "default",
  });

  const featured = movies.slice(0, 3);
  const featuredPosters = await Promise.all(featured.map((movie) => resolveMovieCardPoster(movie)));
  spotlight.innerHTML = "";
  featured.forEach((movie, index) => {
    const chip = document.createElement("a");
    chip.className = "catalog-spotlight-card";
    chip.href = buildMoviePlayerUrl(movie);
    chip.innerHTML = `<span>${movie.code}</span><strong>${movie.title}</strong>`;
    applyPosterImage(chip, featuredPosters[index], movie.gradient || ["#1c1c22", "#141419"]);
    spotlight.appendChild(chip);
  });

  const posters = await Promise.all(movies.map((movie) => resolveMovieCardPoster(movie)));
  genreState.posters = posters;
  primaryGrid.innerHTML = "";
  movies.forEach((movie, index) => {
    primaryGrid.appendChild(createMovieCard(movie, posters[index]));
  });

  if (secondarySection) secondarySection.style.display = "none";

  // Configurar filtros de género (no bloquea la primera pintura)
  setupGenreFilters(movies, "movie");
}

async function renderSeriesPage() {
  const series = getSeriesSorted();
  const posters = await Promise.all(series.map((serie) => resolveSeriesCardPoster(serie)));
  genreState.posters = posters;

  setHeroContent({
    kicker: "Series",
    title: "Navega temporadas y episodios sin entrar de una vez al player.",
    intro: "La seccion de series queda como un catalogo navegable. Puedes revisar cada temporada y saltar solo al episodio que quieres ver. Usa las categorías para filtrar.",
    spotlight: series.slice(0, 3).map((serie, index) => ({
      label: `${serie.seasons.length} temporadas`,
      title: serie.title,
      poster: posters[index],
      gradient: serie.gradient,
    })),
    spotlightStyle: "compact",
  });

  primaryGrid.innerHTML = "";

  series.forEach((serie, index) => {
    const card = createSeriesCard(serie, posters[index]);
    card.addEventListener("click", () => {
      [...primaryGrid.children].forEach((node) => node.classList.remove("is-selected"));
      card.classList.add("is-selected");
      openCatalogModal({
        kicker: "Serie",
        title: serie.title,
        intro: "Selecciona una temporada y entra al episodio que quieras ver.",
        buildContent(content) {
          serie.seasons.forEach((season) => {
            const block = document.createElement("section");
            block.className = "catalog-modal-section";
            block.innerHTML = `
              <div class="catalog-season-title">Temporada ${season.season}</div>
              <div class="catalog-inline-grid"><div class="catalog-empty">Cargando episodios...</div></div>
            `;
            content.appendChild(block);
            const grid = block.querySelector(".catalog-inline-grid");
            ensureSeasonEpisodes(serie, season).then((episodes) => {
              grid.innerHTML = "";
              if (!episodes.length) {
                grid.innerHTML = '<div class="catalog-empty">Proximamente.</div>';
                return;
              }
              episodes.forEach((episode, episodeIndex) => {
                grid.appendChild(createEpisodeLink(serie, season.season, episode, episodeIndex));
              });
            });
          });
        },
      });
    });
    primaryGrid.appendChild(card);
  });

  if (secondarySection) secondarySection.style.display = "none";

  setupGenreFilters(series, "series");
}

async function renderSagasPage() {
  const sagas = getSagas();
  const sagaPosters = await Promise.all(sagas.map((saga) => resolveSagaCardPoster(saga)));
  const sagaPosterMap = new Map(sagas.map((saga, index) => [saga.name, sagaPosters[index]]));

  const sagaSpotlight = sagas.slice(0, 3).map((saga, index) => ({
    label: `${saga.movies.length} peliculas`,
    title: saga.name,
    poster: sagaPosters[index],
    gradient: saga.gradient,
  }));
  setHeroContent({
    kicker: "Sagas",
    title: "Agrupa franquicias y entra a cada pelicula desde su propio espacio.",
    intro: "Las sagas ahora funcionan como colecciones. Primero ves la franquicia, despues eliges la pelicula concreta para abrir su reproduccion.",
    spotlight: sagaSpotlight,
    spotlightStyle: "compact",
  });

  const sagaMoviePosterEntries = await Promise.all(
    sagas.flatMap((saga) =>
      saga.movies.map(async (movie) => [movie.title, await resolveMovieCardPoster(movie)]),
    ),
  );
  const sagaMoviePosterMap = new Map(sagaMoviePosterEntries);

  primaryGrid.innerHTML = "";
  sagas.forEach((saga) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "catalog-card catalog-card-series catalog-select-card";
    card.innerHTML = `
      <div class="catalog-card-art"></div>
      <div class="catalog-card-copy">
        <span class="catalog-card-code">Saga</span>
        <h3>${saga.name}</h3>
        <p>${saga.movies.length} peliculas agrupadas en una sola vista.</p>
        <span class="catalog-link catalog-link-ghost">Ver peliculas</span>
      </div>
    `;
    applyPosterImage(card.querySelector(".catalog-card-art"), sagaPosterMap.get(saga.name), saga.gradient);
    card.addEventListener("click", () => {
      [...primaryGrid.children].forEach((node) => node.classList.remove("is-selected"));
      card.classList.add("is-selected");
      openCatalogModal({
        kicker: "Saga",
        title: saga.name,
        intro: "Selecciona la pelicula de la franquicia que quieres abrir.",
        buildContent(content) {
          const grid = document.createElement("div");
          grid.className = "catalog-inline-grid catalog-inline-grid-posters";
          saga.movies.forEach((movie) => {
            grid.appendChild(
              createMovieInlineCard(
                movie,
                sagaMoviePosterMap.get(movie.title) || movie.poster || null,
                saga.name,
              ),
            );
          });
          content.appendChild(grid);
        },
      });
    });
    primaryGrid.appendChild(card);
  });

  if (secondarySection) secondarySection.style.display = "none";
}

initKickAuthUI();

if (page === "series") {
  renderSeriesPage();
} else if (page === "sagas") {
  renderSagasPage();
} else {
  renderMoviesPage();
}
