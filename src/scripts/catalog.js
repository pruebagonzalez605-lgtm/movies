import {
  buildEpisodePlayerUrl,
  buildMoviePlayerUrl,
  ensureSeasonEpisodes,
  getMovies,
  getSagas,
  getSeries,
  resolveMovieCardPoster,
  resolveSeriesCardPoster,
} from "./shared/catalog-data.js";
import { initKickAuthUI } from "./shared/kick-auth-ui.js";

const page = document.body.dataset.page || "movies";
const heroKicker = document.getElementById("catalogHeroKicker");
const heroTitle = document.getElementById("catalogHeroTitle");
const heroIntro = document.getElementById("catalogHeroIntro");
const spotlight = document.getElementById("catalogSpotlight");
const primaryGrid = document.getElementById("catalogPrimaryGrid");
const secondarySection = document.getElementById("catalogSecondarySection");

let modalElements = null;

function applyPosterImage(node, posterUrl, gradient) {
  node.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  if (!posterUrl) return;
  const img = new Image();
  img.onload = () => {
    node.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.12), rgba(8,8,12,0.85)), url('${posterUrl}')`;
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
        applyPosterImage(card, item.poster, item.gradient || ["#1c1c22", "#141419"]);
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

function createMovieCard(movie, posterUrl) {
  const link = document.createElement("a");
  link.className = "catalog-card";
  link.href = buildMoviePlayerUrl(movie);
  link.innerHTML = `
    <div class="catalog-card-art"></div>
    <div class="catalog-card-copy">
      <span class="catalog-card-code">${movie.code || "Movie"}</span>
      <h3>${movie.title}</h3>
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
  card.innerHTML = `
    <div class="catalog-card-art"></div>
    <div class="catalog-card-copy">
      <span class="catalog-card-code">Serie</span>
      <h3>${serie.title}</h3>
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
  item.className = "catalog-inline-card";
  item.href = buildMoviePlayerUrl(movie);
  item.innerHTML = `
    <div class="catalog-inline-thumb">
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

async function renderMoviesPage() {
  const movies = getMovies();
  setHeroContent({
    kicker: "Movies",
    title: "Explora la cartelera antes de entrar a reproducir.",
    intro: "Ahora las peliculas viven en un catalogo visual. Primero navegas, eliges el titulo y luego entras a una pagina de reproduccion separada.",
    spotlight: ["Catalogo visual", "Acceso por titulo", "Player dedicado"],
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
  primaryGrid.innerHTML = "";
  movies.forEach((movie, index) => {
    primaryGrid.appendChild(createMovieCard(movie, posters[index]));
  });

  if (secondarySection) secondarySection.style.display = "none";
}

async function renderSeriesPage() {
  const series = getSeries();
  const posters = await Promise.all(series.map((serie) => resolveSeriesCardPoster(serie)));
  setHeroContent({
    kicker: "Series",
    title: "Navega temporadas y episodios sin entrar de una vez al player.",
    intro: "La seccion de series queda como un catalogo navegable. Puedes revisar cada temporada y saltar solo al episodio que quieres ver.",
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
}

async function renderSagasPage() {
  const sagas = getSagas();
  const sagaSpotlight = sagas.slice(0, 3).map((saga) => ({
    label: `${saga.movies.length} peliculas`,
    title: saga.name,
    poster: saga.poster,
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
    applyPosterImage(card.querySelector(".catalog-card-art"), saga.poster, saga.gradient);
    card.addEventListener("click", () => {
      [...primaryGrid.children].forEach((node) => node.classList.remove("is-selected"));
      card.classList.add("is-selected");
      openCatalogModal({
        kicker: "Saga",
        title: saga.name,
        intro: "Selecciona la pelicula de la franquicia que quieres abrir.",
        buildContent(content) {
          const grid = document.createElement("div");
          grid.className = "catalog-inline-grid";
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
