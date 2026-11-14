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
  optimizePosterUrl,
  slugify,
} from "./shared/catalog-data.js?v=20261114-kuroko";
import { GENRE_BY_ID } from "./config/genres.js";
import { initKickAuthUI } from "./shared/kick-auth-ui.js";
import {
  createGenreFilter,
  genrePillHtml,
  applyGenrePillToCard,
} from "./ui/genre-filter.js";

const page = document.body.dataset.page || "movies";
const heroKicker = document.getElementById("catalogHeroKicker");
const heroTitle = document.getElementById("catalogHeroTitle");
const heroIntro = document.getElementById("catalogHeroIntro");
const spotlight = document.getElementById("catalogSpotlight");
const primaryGrid = document.getElementById("catalogPrimaryGrid");
const secondarySection = document.getElementById("catalogSecondarySection");
const genreFilterMount = document.querySelector("[data-genre-filter]");

let modalElements = null;

/** Estado del filtro de género (uno solo a la vez) */
const genreState = {
  selected: null, // string id o null (= todos)
  resolvedMap: null, // Map<item, string|null>
  allItems: [],
  kind: "movie", // "movie" | "series" | "saga"
  posters: [],
  cardsByItem: new Map(), // item -> tarjeta en el DOM (para refrescar pildoras)
};

/** Instancia unica del filtro visual de generos */
const genreFilter = genreFilterMount
  ? createGenreFilter({
      mount: genreFilterMount,
      onChange: (selected) => {
        genreState.selected = selected;
        applyGenreFilter();
      },
    })
  : null;

const posterObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const node = entry.target;
        observer.unobserve(node);
        loadPosterForNode(node);
      });
    }, { rootMargin: "220px 0px" })
  : null;

function loadPosterForNode(node) {
  const loadImage = (posterUrl) => {
    if (!posterUrl || !node.isConnected) return;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!node.isConnected) return;
      node.style.backgroundImage = `${node.dataset.posterOverlay || ""}url('${posterUrl}')`;
      node.style.backgroundSize = "cover";
      node.style.backgroundPosition = "center";
    };
    image.src = posterUrl;
  };

  if (node.dataset.posterUrl && node.dataset.posterUrl !== "null") {
    loadImage(node.dataset.posterUrl);
    return;
  }
  const resolver = node.__posterResolver;
  if (!resolver || node.dataset.posterLoading === "true") return;
  node.dataset.posterLoading = "true";
  Promise.resolve(resolver())
    .then((posterUrl) => {
      if (!posterUrl) return;
      const optimizedPosterUrl = optimizePosterUrl(posterUrl);
      node.dataset.posterUrl = optimizedPosterUrl;
      loadImage(optimizedPosterUrl);
    })
    .catch(() => {})
    .finally(() => { node.dataset.posterLoading = "false"; });
}

function applyPosterImage(node, posterUrl, gradient, options = {}) {
  const overlay = options.overlay || "linear-gradient(180deg, rgba(8,8,12,0.12), rgba(8,8,12,0.85))";
  node.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  node.dataset.posterOverlay = overlay ? `${overlay}, ` : "";
  node.__posterResolver = options.resolvePoster || null;
  const optimizedPosterUrl = optimizePosterUrl(posterUrl);
  if (optimizedPosterUrl) node.dataset.posterUrl = optimizedPosterUrl;
  else delete node.dataset.posterUrl;
  if (!optimizedPosterUrl && !options.resolvePoster) return;
  if (posterObserver) posterObserver.observe(node);
  else loadPosterForNode(node);
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
          resolvePoster: item.resolvePoster,
        });
      } else if (item.resolvePoster) {
        applyPosterImage(card, null, item.gradient || ["#1c1c22", "#141419"], {
          overlay:
            "linear-gradient(180deg, rgba(8,8,12,0.1) 0%, rgba(8,8,12,0.18) 35%, rgba(8,8,12,0.55) 62%, rgba(8,8,12,0.95) 100%)",
          resolvePoster: item.resolvePoster,
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
    <div class="catalog-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="catalogModalTitle">
      <button class="catalog-modal-close" type="button" aria-label="Cerrar modal">Cerrar</button>
      <div class="catalog-modal-head">
        <span class="catalog-kicker" data-modal-kicker>Seleccion</span>
        <h2 id="catalogModalTitle" data-modal-title>Explorar</h2>
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
    returnFocus: null,
    close() {
      if (!overlay.classList.contains("is-open")) return;
      overlay.classList.remove("is-open");
      document.body.classList.remove("modal-open");
      this.returnFocus?.focus?.();
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
  modal.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.kicker.textContent = kicker;
  modal.title.textContent = title;
  modal.intro.textContent = intro;
  modal.content.innerHTML = "";
  buildContent(modal.content);
  modal.overlay.classList.add("is-open");
  document.body.classList.add("modal-open");
  modal.closeBtn.focus();
}

function buildGenrePillsHtml(item) {
  return genrePillHtml(genreState.resolvedMap?.get(item) ?? getItemGenreSync(item));
}

/** Completa las pildoras de las tarjetas ya pintadas una vez resueltos los generos */
function refreshCardGenrePills() {
  if (!genreState.resolvedMap) return;
  genreState.cardsByItem.forEach((card, item) => {
    applyGenrePillToCard(card, genreState.resolvedMap.get(item) ?? getItemGenreSync(item));
  });
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
  applyPosterImage(link.querySelector(".catalog-card-art"), posterUrl, movie.gradient || ["#1c1c22", "#141419"], {
    resolvePoster: () => resolveMovieCardPoster(movie),
  });
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
  applyPosterImage(card.querySelector(".catalog-card-art"), posterUrl, serie.gradient || ["#1c1c22", "#141419"], {
    resolvePoster: () => resolveSeriesCardPoster(serie),
  });
  return card;
}

function createEpisodeLink(serie, seasonNumber, episode, index) {
  const item = document.createElement("a");
  item.className = "catalog-inline-card";
  item.href = buildEpisodePlayerUrl(serie, seasonNumber, index + 1);
  item.innerHTML = `
    <div class="catalog-inline-thumb">
      <span class="catalog-inline-index">T${seasonNumber} · E${index + 1}</span>
    </div>
    <div class="catalog-inline-copy">
      <strong></strong>
      <span></span>
    </div>
  `;
  item.querySelector(".catalog-inline-copy strong").textContent = episode.title || `Episodio ${index + 1}`;
  item.querySelector(".catalog-inline-copy span").textContent = episode.description || "Sinopsis no disponible todavía.";
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

function updateGenreStatus(visibleCount, totalCount) {
  if (!genreFilter) return;
  if (genreState.selected == null) {
    genreFilter.setStatus(`${totalCount} títulos`);
  } else {
    const name = GENRE_BY_ID[genreState.selected]?.name || genreState.selected;
    genreFilter.setStatus(`${visibleCount} en ${name}`);
  }
}

/** Crea la tarjeta que corresponde al tipo de pagina actual */
function createCardForItem(item, poster) {
  if (genreState.kind === "series") {
    const card = createSeriesCard(item, poster);
    card.addEventListener("click", () => {
      [...primaryGrid.children].forEach((node) => node.classList.remove("is-selected"));
      card.classList.add("is-selected");
      openSeriesModal(item);
    });
    return card;
  }
  if (genreState.kind === "saga") {
    return createSagaCard(item, poster);
  }
  return createMovieCard(item, poster);
}

/** Pinta una lista de items en la grilla principal */
function renderItems(list) {
  primaryGrid.innerHTML = "";
  genreState.cardsByItem = new Map();

  if (!list.length) {
    primaryGrid.innerHTML = `<div class="catalog-empty genre-empty">No hay títulos en este género todavía.</div>`;
    return;
  }

  const indexes = new Map(genreState.allItems.map((item, index) => [item, index]));
  const fragment = document.createDocumentFragment();
  list.forEach((item) => {
    const idx = indexes.get(item) ?? -1;
    const card = createCardForItem(item, genreState.posters[idx]);
    genreState.cardsByItem.set(item, card);
    fragment.appendChild(card);
  });
  primaryGrid.appendChild(fragment);
}

function applyGenreFilter() {
  const filtered = filterItemsByGenre(
    genreState.allItems,
    genreState.selected,
    genreState.resolvedMap
  );
  renderItems(filtered);
  updateGenreStatus(filtered.length, genreState.allItems.length);
}

/**
 * Resuelve el genero de cada saga a partir del genero dominante de sus
 * peliculas (una saga no tiene genero propio en los datos).
 */
function resolveSagaGenres(sagas) {
  const map = new Map();
  sagas.forEach((saga) => {
    const counts = new Map();
    saga.movies.forEach((movie) => {
      const genre = getItemGenreSync(movie);
      if (genre) counts.set(genre, (counts.get(genre) || 0) + 1);
    });
    let best = null;
    let bestCount = 0;
    counts.forEach((count, genre) => {
      if (count > bestCount) {
        bestCount = count;
        best = genre;
      }
    });
    map.set(saga, best);
  });
  return map;
}

async function setupGenreFilters(items, kind) {
  genreState.allItems = items;
  genreState.kind = kind;
  genreState.selected = null;

  if (!genreFilter) return;
  genreFilter.setLoading("Detectando géneros…");

  genreState.resolvedMap = kind === "saga"
    ? resolveSagaGenres(items)
    : await resolveAllGenres(items, kind);

  const available = collectAvailableGenres(items, genreState.resolvedMap);
  genreFilter.setGenres(available, { total: items.length });
  updateGenreStatus(items.length, items.length);
  refreshCardGenrePills();
}

/** Modal de temporadas/episodios de una serie */
function openSeriesModal(serie) {
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
}

/** Modal con las peliculas de una saga */
function openSagaModal(saga) {
  const posterNodes = [];
  openCatalogModal({
    kicker: "Saga",
    title: saga.name,
    intro: "Selecciona la pelicula de la franquicia que quieres abrir.",
    buildContent(content) {
      const grid = document.createElement("div");
      grid.className = "catalog-inline-grid catalog-inline-grid-posters";
      saga.movies.forEach((movie) => {
        const card = createMovieInlineCard(movie, movie.poster || null, saga.name);
        posterNodes.push({ movie, art: card.querySelector(".catalog-inline-thumb") });
        grid.appendChild(card);
      });
      content.appendChild(grid);
    },
  });

  // Las portadas de películas se resuelven únicamente al abrir su saga.
  Promise.all(posterNodes.map(async ({ movie, art }) => {
    const poster = await resolveMovieCardPoster(movie);
    if (poster && art.isConnected) {
      applyPosterImage(art, poster, movie.gradient || ["#1c1c22", "#141419"]);
    }
  }));
}

function createSagaCard(saga, posterUrl) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "catalog-card catalog-card-series catalog-select-card";
  const genrePills = buildGenrePillsHtml(saga);
  card.innerHTML = `
    <div class="catalog-card-art"></div>
    <div class="catalog-card-copy">
      <span class="catalog-card-code">Saga</span>
      <h3>${saga.name}</h3>
      ${genrePills}
      <p>${saga.movies.length} peliculas agrupadas en una sola vista.</p>
      <span class="catalog-link catalog-link-ghost">Ver peliculas</span>
    </div>
  `;
  applyPosterImage(card.querySelector(".catalog-card-art"), posterUrl, saga.gradient, {
    resolvePoster: () => resolveSagaCardPoster(saga),
  });
  card.addEventListener("click", () => {
    [...primaryGrid.children].forEach((node) => node.classList.remove("is-selected"));
    card.classList.add("is-selected");
    openSagaModal(saga);
  });
  return card;
}

async function renderMoviesPage() {
  const movies = getMoviesSorted();
  setHeroContent({
    kicker: "PELÍCULAS · COLEVANA",
    title: "Tu próxima película empieza aquí.",
    intro: "Explora el catálogo, descubre algo nuevo y empieza a verlo cuando quieras.",
    spotlight: ["Destacados", "Géneros", "Ver ahora"],
    spotlightStyle: "default",
  });

  genreState.posters = movies.map((movie) => movie.poster || null);
  genreState.allItems = movies;
  genreState.kind = "movie";
  genreState.resolvedMap = new Map(movies.map((movie) => [movie, getItemGenreSync(movie)]));
  renderItems(movies);

  if (secondarySection) secondarySection.style.display = "none";

  // Configurar filtros de género (no bloquea la primera pintura)
  setupGenreFilters(movies, "movie");
}

async function renderSeriesPage() {
  const series = await getSeriesSorted();
  const posters = series.map((serie) => serie.poster || null);
  genreState.posters = posters;
  genreState.allItems = series;
  genreState.kind = "series";
  genreState.resolvedMap = new Map(series.map((serie) => [serie, getItemGenreSync(serie)]));

  setHeroContent({
    kicker: "SERIES · COLEVANA",
    title: "Una historia más. Un episodio más.",
    intro: "Encuentra tu serie y elige exactamente la temporada y el episodio que quieres ver.",
    spotlight: series.slice(0, 3).map((serie, index) => ({
      label: `${serie.seasons.length} temporadas`,
      title: serie.title,
      href: `./series.html?item=${encodeURIComponent(slugify(serie.title))}`,
      poster: posters[index],
      resolvePoster: () => resolveSeriesCardPoster(serie),
      gradient: serie.gradient,
    })),
    spotlightStyle: "compact",
  });

  renderItems(series);
  const requestedSeries = new URLSearchParams(location.search).get("item");
  if (requestedSeries) {
    const match = series.find((serie) => slugify(serie.title) === requestedSeries);
    if (match) openSeriesModal(match);
  }

  if (secondarySection) secondarySection.style.display = "none";

  setupGenreFilters(series, "series");
}

async function renderSagasPage() {
  const sagas = getSagas();
  // Pintamos inmediatamente con portadas locales y dejamos la búsqueda remota
  // para después del primer render.
  const sagaPosters = sagas.map((saga) => saga.poster || null);

  const sagaSpotlight = sagas.slice(0, 3).map((saga, index) => ({
    label: `${saga.movies.length} peliculas`,
    title: saga.name,
    href: `./sagas.html?item=${encodeURIComponent(saga.slug)}`,
    poster: sagaPosters[index],
    resolvePoster: () => resolveSagaCardPoster(saga),
    gradient: saga.gradient,
  }));
  setHeroContent({
    kicker: "SAGAS · COLEVANA",
    title: "Cada gran historia tiene más de un capítulo.",
    intro: "Recorre franquicias completas y elige la película con la que quieres empezar.",
    spotlight: sagaSpotlight,
    spotlightStyle: "compact",
  });

  genreState.posters = sagaPosters;
  genreState.allItems = sagas;
  genreState.kind = "saga";
  genreState.resolvedMap = resolveSagaGenres(sagas);
  setupGenreFilters(sagas, "saga");
  renderItems(sagas);
  const requestedSaga = new URLSearchParams(location.search).get("item");
  if (requestedSaga) {
    const match = sagas.find((saga) => saga.slug === requestedSaga);
    if (match) openSagaModal(match);
  }

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
