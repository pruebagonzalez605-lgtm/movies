import { MOVIES } from "./data/movies.js";
import { buildMoviePlayerUrl } from "./shared/catalog-data.js";
import { resolveMoviePoster } from "./services/tmdb.js";

const heroPanel = document.getElementById("homeHeroPanel");
const heroBackdrop = document.getElementById("homeHeroBackdrop");
const featuredStrip = document.getElementById("featuredPosterStrip");
const featuredGrid = document.getElementById("featuredPosterGrid");

async function buildHomeVisuals() {
  const featuredMovies = MOVIES.slice(0, 6);
  const featured = await Promise.all(
    featuredMovies.map(async (movie) => ({
      ...movie,
      resolvedPoster: await resolveMoviePoster(movie),
    })),
  );

  const backdropMovies = featured.filter((movie) => movie.resolvedPoster).slice(0, 3);
  if (heroPanel && backdropMovies.length) {
    heroPanel.style.setProperty("--hero-poster", `url('${backdropMovies[0].resolvedPoster}')`);
    heroPanel.classList.add("is-poster-powered");
  }

  if (heroBackdrop) {
    heroBackdrop.innerHTML = "";
    backdropMovies.forEach((movie) => {
      const frame = document.createElement("div");
      frame.className = "hero-backdrop-card";
      frame.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.72)), url('${movie.resolvedPoster}')`;
      frame.setAttribute("aria-label", movie.title);
      heroBackdrop.appendChild(frame);
    });
  }

  if (featuredStrip) {
    featuredStrip.innerHTML = "";
    featured.slice(0, 4).forEach((movie) => {
      const item = document.createElement("a");
      item.className = "featured-poster-chip";
      item.href = buildMoviePlayerUrl(movie);
      item.innerHTML = `
        <span class="featured-poster-chip-label">${movie.code}</span>
        <span class="featured-poster-chip-title">${movie.title}</span>
      `;
      if (movie.resolvedPoster) {
        item.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.12), rgba(8,8,12,0.88)), url('${movie.resolvedPoster}')`;
      }
      featuredStrip.appendChild(item);
    });
  }

  if (featuredGrid) {
    featuredGrid.innerHTML = "";
    featured.slice(0, 4).forEach((movie) => {
      const item = document.createElement("article");
      item.className = "home-poster-card";
      item.innerHTML = `
        <div class="home-poster-art"></div>
        <div class="home-poster-copy">
          <span class="home-poster-code">${movie.code}</span>
          <h3>${movie.title}</h3>
        </div>
      `;
      item.addEventListener("click", () => {
        window.location.href = buildMoviePlayerUrl(movie);
      });
      if (movie.resolvedPoster) {
        item.querySelector(".home-poster-art").style.backgroundImage =
          `linear-gradient(180deg, rgba(8,8,12,0.06), rgba(8,8,12,0.7)), url('${movie.resolvedPoster}')`;
      }
      featuredGrid.appendChild(item);
    });
  }
}

buildHomeVisuals();
