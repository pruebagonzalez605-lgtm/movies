import {
  buildMoviePlayerUrl,
  getMoviesSorted,
  getSagas,
  getSeriesSorted,
  optimizePosterUrl,
  resolveMovieCardPoster,
  resolveSagaCardPoster,
  resolveSeriesCardPoster,
  isNewItem,
  slugify,
  resolveItemGenre,
  getItemGenreSync,
} from "./shared/catalog-data.js?v=20261114-kuroko";
import { genrePillHtml, applyGenrePillToCard } from "./ui/genre-filter.js";

const moviesGrid = document.getElementById("homeMoviesGrid");
const seriesGrid = document.getElementById("homeSeriesGrid");
const sagasGrid = document.getElementById("homeSagasGrid");
const featureImage = document.getElementById("homeFeatureImage");
const featureTitle = document.getElementById("homeFeatureTitle");
const featureDescription = document.getElementById("homeFeatureDescription");
const featurePlay = document.getElementById("homeFeaturePlay");

const posterConfigs = new WeakMap();
const posterObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadPosterImage(entry.target);
      });
    }, { rootMargin: "350px 200px" })
  : null;

function loadPosterImage(node) {
  const config = posterConfigs.get(node);
  if (!config) return;

  const apply = (posterUrl) => {
    if (!posterUrl || !node.isConnected) return;
    const optimizedUrl = optimizePosterUrl(posterUrl);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      node.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.75)), url('${optimizedUrl}')`;
      node.style.backgroundSize = "cover";
      node.style.backgroundPosition = "center";
    };
    image.src = optimizedUrl;
  };

  if (config.poster) {
    apply(config.poster);
    return;
  }
  if (config.resolvePoster && !config.resolving) {
    config.resolving = true;
    Promise.resolve(config.resolvePoster()).then(apply).catch(() => {});
  }
}

async function renderFeature(movie) {
  if (!movie || !featureImage || !featureTitle || !featurePlay) return;
  featureTitle.textContent = movie.title;
  featureDescription.textContent = movie.saga
    ? `Una historia de ${movie.saga}. Disponible para reproducir ahora.`
    : "Una historia para ver hoy. Disponible para reproducir ahora.";
  featurePlay.href = buildMoviePlayerUrl(movie);
  const poster = movie.poster && movie.poster !== "..."
    ? movie.poster
    : await resolveMovieCardPoster(movie);
  if (poster && featureImage) featureImage.src = poster;
}

function applyPosterImage(node, posterUrl, gradient, resolvePoster = null) {
  node.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  posterConfigs.set(node, { poster: posterUrl || null, resolvePoster, resolving: false });
  if (posterObserver) posterObserver.observe(node);
  else loadPosterImage(node);
}

function createPosterCard({ href, title, poster, resolvePoster, gradient, isNew, item, kind }) {
  const link = document.createElement("a");
  link.className = "catalog-card catalog-card-poster-only";
  link.href = href;
  link.innerHTML = `
    <div class="catalog-card-art">
      ${isNew ? '<span class="catalog-new-badge">Nuevo</span>' : ""}
    </div>
    <div class="catalog-card-copy">
      <h3>${title}</h3>
      ${genrePillHtml(getItemGenreSync(item))}
    </div>
  `;
  applyPosterImage(
    link.querySelector(".catalog-card-art"),
    poster,
    gradient || ["#1c1c22", "#141419"],
    resolvePoster,
  );

  // Si el genero no estaba en los datos locales, se completa despues con TMDB
  // sin bloquear el pintado de la portada.
  if (item && !getItemGenreSync(item)) {
    Promise.resolve(resolveItemGenre(item, kind || "movie"))
      .then((genreId) => applyGenrePillToCard(link, genreId))
      .catch(() => {});
  }

  return link;
}

function renderMovies() {
  if (!moviesGrid) return;
  const movies = getMoviesSorted().slice(0, 12);
  renderFeature(movies.find((movie) => movie.poster && movie.poster !== "...") || movies[0]);
  moviesGrid.replaceChildren(...movies.map((movie) => createPosterCard({
    href: buildMoviePlayerUrl(movie),
    title: movie.title,
    poster: movie.poster && movie.poster !== "..." ? movie.poster : null,
    resolvePoster: () => resolveMovieCardPoster(movie),
    gradient: movie.gradient,
    isNew: isNewItem(movie),
    item: movie,
    kind: "movie",
  })));
}

async function renderSeries() {
  if (!seriesGrid) return;
  const series = (await getSeriesSorted()).slice(0, 12);
  seriesGrid.replaceChildren(...series.map((serie) => createPosterCard({
    href: `./series.html?item=${encodeURIComponent(slugify(serie.title))}`,
    title: serie.title,
    poster: serie.poster || null,
    resolvePoster: () => resolveSeriesCardPoster(serie),
    gradient: serie.gradient,
    isNew: isNewItem(serie),
    item: serie,
    kind: "series",
  })));
  seriesGrid.classList.remove("is-pending");
}

function renderSagas() {
  if (!sagasGrid) return;
  const sagas = getSagas().slice(0, 12);
  sagasGrid.replaceChildren(...sagas.map((saga) => createPosterCard({
    href: `./sagas.html?item=${encodeURIComponent(saga.slug)}`,
    title: saga.name,
    poster: saga.poster || null,
    resolvePoster: () => resolveSagaCardPoster(saga),
    gradient: saga.gradient,
    isNew: false,
    item: saga.movies[0] || null,
    kind: "movie",
  })));
  sagasGrid.classList.remove("is-pending");
}

renderMovies();

function runWhenNearViewport(node, callback) {
  if (!node) return;
  if (!("IntersectionObserver" in window)) {
    callback();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    callback();
  }, { rootMargin: "100px 0px" });
  observer.observe(node);
}

runWhenNearViewport(seriesGrid, renderSeries);
runWhenNearViewport(sagasGrid, renderSagas);
