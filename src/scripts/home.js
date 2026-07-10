import {
  buildMoviePlayerUrl,
  getMovies,
  getSagas,
  getSeries,
  resolveMovieCardPoster,
  resolveSagaCardPoster,
  resolveSeriesCardPoster,
} from "./shared/catalog-data.js";

const moviesGrid = document.getElementById("homeMoviesGrid");
const seriesGrid = document.getElementById("homeSeriesGrid");
const sagasGrid = document.getElementById("homeSagasGrid");

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

function createPosterCard({ href, title, poster, gradient }) {
  const link = document.createElement("a");
  link.className = "catalog-card catalog-card-poster-only";
  link.href = href;
  link.innerHTML = `
    <div class="catalog-card-art"></div>
    <div class="catalog-card-copy">
      <h3>${title}</h3>
    </div>
  `;
  applyPosterImage(link.querySelector(".catalog-card-art"), poster, gradient || ["#1c1c22", "#141419"]);
  return link;
}

async function renderMovies() {
  if (!moviesGrid) return;
  const movies = getMovies().slice(0, 12);
  const cards = await Promise.all(
    movies.map(async (movie) => {
      const poster = await resolveMovieCardPoster(movie);
      return createPosterCard({
        href: buildMoviePlayerUrl(movie),
        title: movie.title,
        poster,
        gradient: movie.gradient,
      });
    }),
  );
  moviesGrid.innerHTML = "";
  cards.forEach((card) => moviesGrid.appendChild(card));
}

async function renderSeries() {
  if (!seriesGrid) return;
  const series = getSeries().slice(0, 12);
  const cards = await Promise.all(
    series.map(async (serie) => {
      const poster = await resolveSeriesCardPoster(serie);
      return createPosterCard({
        href: "./series.html",
        title: serie.title,
        poster,
        gradient: serie.gradient,
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
        href: "./sagas.html",
        title: saga.name,
        poster,
        gradient: saga.gradient,
      });
    }),
  );
  sagasGrid.innerHTML = "";
  cards.forEach((card) => sagasGrid.appendChild(card));
}

renderMovies();
renderSeries();
renderSagas();