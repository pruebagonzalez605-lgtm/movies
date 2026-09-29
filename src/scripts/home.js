import {
  buildMoviePlayerUrl,
  getMoviesSorted,
  getSagas,
  getSeriesSorted,
  resolveMovieCardPoster,
  resolveSagaCardPoster,
  resolveSeriesCardPoster,
  isNewItem,
  slugify,
  resolveItemGenre,
  getItemGenreSync,
} from "./shared/catalog-data.js";
import { genrePillHtml, applyGenrePillToCard } from "./ui/genre-filter.js";

const moviesGrid = document.getElementById("homeMoviesGrid");
const seriesGrid = document.getElementById("homeSeriesGrid");
const sagasGrid = document.getElementById("homeSagasGrid");
const featureArt = document.getElementById("homeFeatureArt");
const featureTitle = document.getElementById("homeFeatureTitle");
const featureDescription = document.getElementById("homeFeatureDescription");
const featurePlay = document.getElementById("homeFeaturePlay");

async function renderFeature(movie) {
  if (!movie || !featureArt || !featureTitle || !featurePlay) return;
  featureTitle.textContent = movie.title;
  featureDescription.textContent = movie.saga
    ? `Una historia de ${movie.saga}. Disponible para reproducir ahora.`
    : "Una historia para ver hoy. Disponible para reproducir ahora.";
  featurePlay.href = buildMoviePlayerUrl(movie);
  const poster = movie.poster && movie.poster !== "..."
    ? movie.poster
    : await resolveMovieCardPoster(movie);
  if (poster) {
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.onload = () => featureArt.replaceChildren(image);
    image.src = poster;
  }
}

function applyPosterImage(node, posterUrl, gradient) {
  node.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  if (!posterUrl) return;
  const img = new Image();
  img.onload = () => {
    node.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.75)), url('${posterUrl}')`;
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
  };
  img.src = posterUrl;
}

function createPosterCard({ href, title, poster, gradient, isNew, item, kind }) {
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
  applyPosterImage(link.querySelector(".catalog-card-art"), poster, gradient || ["#1c1c22", "#141419"]);

  // Si el genero no estaba en los datos locales, se completa despues con TMDB
  // sin bloquear el pintado de la portada.
  if (item && !getItemGenreSync(item)) {
    Promise.resolve(resolveItemGenre(item, kind || "movie"))
      .then((genreId) => applyGenrePillToCard(link, genreId))
      .catch(() => {});
  }

  return link;
}

async function renderMovies() {
  if (!moviesGrid) return;
  const movies = getMoviesSorted().slice(0, 12);
  renderFeature(movies.find((movie) => movie.poster && movie.poster !== "...") || movies[0]);
  const cards = await Promise.all(
    movies.map(async (movie) => {
      const poster = await resolveMovieCardPoster(movie);
      return createPosterCard({
        href: buildMoviePlayerUrl(movie),
        title: movie.title,
        poster,
        gradient: movie.gradient,
        isNew: isNewItem(movie),
        item: movie,
        kind: "movie",
      });
    }),
  );
  moviesGrid.innerHTML = "";
  cards.forEach((card) => moviesGrid.appendChild(card));
}

async function renderSeries() {
  if (!seriesGrid) return;
  const series = getSeriesSorted().slice(0, 12);
  const cards = await Promise.all(
    series.map(async (serie) => {
      const poster = await resolveSeriesCardPoster(serie);
      return createPosterCard({
        href: `./series.html?item=${encodeURIComponent(slugify(serie.title))}`,
        title: serie.title,
        poster,
        gradient: serie.gradient,
        isNew: isNewItem(serie),
        item: serie,
        kind: "series",
      });
    }),
  );
  seriesGrid.innerHTML = "";
  cards.forEach((card) => seriesGrid.appendChild(card));
}

async function renderSagas() {
  if (!sagasGrid) return;
  const sagas = getSagas().slice(0, 12);
  const cards = await Promise.all(
    sagas.map(async (saga) => {
      const poster = await resolveSagaCardPoster(saga);
      return createPosterCard({
        href: `./sagas.html?item=${encodeURIComponent(saga.slug)}`,
        title: saga.name,
        poster,
        gradient: saga.gradient,
        isNew: false,
        item: saga.movies[0] || null,
        kind: "movie",
      });
    }),
  );
  sagasGrid.innerHTML = "";
  cards.forEach((card) => sagasGrid.appendChild(card));
}

renderMovies();
renderSeries();
renderSagas();
