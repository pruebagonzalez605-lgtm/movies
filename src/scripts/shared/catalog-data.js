import { MOVIES } from "../data/movies.js";
import { SERIES } from "../data/series.js";
import {
  resolveMoviePoster,
  tmdbFindTvId,
  tmdbGetSeasonEpisodes,
  tmdbSearchTvPoster,
} from "../services/tmdb.js";

export function slugify(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeText(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function getMovies() {
  return MOVIES;
}

export function getSeries() {
  return SERIES;
}

export function getSagas() {
  const grouped = new Map();

  MOVIES.forEach((movie) => {
    if (!movie.saga) return;
    if (!grouped.has(movie.saga)) grouped.set(movie.saga, []);
    grouped.get(movie.saga).push(movie);
  });

  return [...grouped.entries()].map(([name, movies]) => ({
    slug: slugify(name),
    name,
    movies,
    poster: movies[0]?.poster || null,
    gradient: movies[0]?.gradient || ["#1c1c22", "#141419"],
  }));
}

export function findMovieBySlug(slug) {
  return MOVIES.find((movie) => slugify(movie.title) === slug) || null;
}

export function findSeriesBySlug(slug) {
  return SERIES.find((serie) => slugify(serie.title) === slug) || null;
}

export function buildMoviePlayerUrl(movie) {
  return `./player.html?type=movie&id=${encodeURIComponent(slugify(movie.title))}`;
}

export function buildEpisodePlayerUrl(serie, seasonNumber, episodeNumber) {
  const params = new URLSearchParams({
    type: "episode",
    series: slugify(serie.title),
    season: String(seasonNumber),
    episode: String(episodeNumber),
  });
  return `./player.html?${params.toString()}`;
}

export async function resolveMovieCardPoster(movie) {
  return resolveMoviePoster(movie);
}

export async function resolveSeriesCardPoster(serie) {
  const poster = await tmdbSearchTvPoster(serie.tmdbShow || serie.title, serie.tmdbYear);
  return poster || serie.poster || null;
}

export async function ensureSeasonEpisodes(serie, season) {
  if (season.episodes) {
    const missingPoster = season.episodes.some((episode) => !episode.poster);
    if (missingPoster && !season._posterFetchAttempted) {
      season._posterFetchAttempted = true;
      const tvId = await tmdbFindTvId(serie.tmdbShow || serie.title, serie.tmdbYear);
      if (tvId) {
        const tmdbEpisodes = await tmdbGetSeasonEpisodes(tvId, season.season);
        season.episodes.forEach((episode, index) => {
          if (!episode.poster && tmdbEpisodes[index]?.poster) {
            episode.poster = tmdbEpisodes[index].poster;
          }
        });
      }
    }
    return season.episodes;
  }

  if (!season.srcs || !season.srcs.length) {
    season.episodes = [];
    return season.episodes;
  }

  const tvId = await tmdbFindTvId(serie.tmdbShow || serie.title, serie.tmdbYear);
  const tmdbEpisodes = tvId ? await tmdbGetSeasonEpisodes(tvId, season.season) : [];

  season.episodes = season.srcs.map((src, index) => {
    const tmdbEpisode = tmdbEpisodes[index] || {};
    return {
      title: tmdbEpisode.title || `Episodio ${index + 1}`,
      description: tmdbEpisode.description || "",
      poster: tmdbEpisode.poster || null,
      src,
    };
  });

  return season.episodes;
}

export async function searchSite(query, options = {}) {
  const normalizedQuery = normalizeText(query).trim();
  if (!normalizedQuery) return [];

  const results = [];
  const sagas = getSagas();
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;

  function pushResult(result) {
    if (results.length >= limit) return false;
    results.push(result);
    return results.length < limit;
  }

  MOVIES.forEach((movie) => {
    if (results.length >= limit) return;
    const haystack = normalizeText(`${movie.title} ${movie.saga || ""}`);
    if (!haystack.includes(normalizedQuery)) return;
    pushResult({
      kind: "movie",
      title: movie.title,
      subtitle: movie.saga ? `Saga ${movie.saga}` : "Pelicula",
      description: "Abrir esta pelicula en el reproductor.",
      href: buildMoviePlayerUrl(movie),
      poster: movie.poster || null,
      gradient: movie.gradient || ["#1c1c22", "#141419"],
      code: movie.code || "Movie",
    });
  });

  SERIES.forEach((serie) => {
    if (results.length >= limit) return;
    const haystack = normalizeText(`${serie.title} ${serie.tmdbShow || ""}`);
    if (!haystack.includes(normalizedQuery)) return;
    pushResult({
      kind: "series",
      title: serie.title,
      subtitle: `${serie.seasons.length} temporadas`,
      description: "Abrir esta serie y explorar sus capitulos.",
      href: "./series.html",
      poster: serie.poster || null,
      gradient: serie.gradient || ["#1c1c22", "#141419"],
      code: "Serie",
    });
  });

  sagas.forEach((saga) => {
    if (results.length >= limit) return;
    const haystack = normalizeText(`${saga.name} ${saga.movies.map((movie) => movie.title).join(" ")}`);
    if (!haystack.includes(normalizedQuery)) return;
    pushResult({
      kind: "saga",
      title: saga.name,
      subtitle: `${saga.movies.length} peliculas`,
      description: "Abrir esta saga y elegir una pelicula.",
      href: "./sagas.html",
      poster: saga.poster || null,
      gradient: saga.gradient || ["#1c1c22", "#141419"],
      code: "Saga",
    });
  });

  for (const serie of SERIES) {
    if (results.length >= limit) break;
    for (const season of serie.seasons) {
      if (results.length >= limit) break;
      const episodes = await ensureSeasonEpisodes(serie, season);
      episodes.forEach((episode, index) => {
        if (results.length >= limit) return;
        const haystack = normalizeText(`${serie.title} ${episode.title || ""} ${episode.description || ""}`);
        if (!haystack.includes(normalizedQuery)) return;
        pushResult({
          kind: "episode",
          title: `${serie.title} - ${episode.title || `Episodio ${index + 1}`}`,
          subtitle: `Temporada ${season.season} - Episodio ${index + 1}`,
          description: episode.description || "Abrir este episodio en el reproductor.",
          href: buildEpisodePlayerUrl(serie, season.season, index + 1),
          poster: episode.poster || serie.poster || null,
          gradient: serie.gradient || ["#1c1c22", "#141419"],
          code: `E${index + 1}`,
        });
      });
    }
  }

  return results;
}
