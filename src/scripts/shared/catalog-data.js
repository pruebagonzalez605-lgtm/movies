import { MOVIES } from "../data/movies.js";
import { SERIES } from "../data/series.js";
import {
  resolveMoviePoster,
  tmdbFindTvId,
  tmdbGetSeasonEpisodes,
  tmdbSearchTvPoster,
  tmdbSearchMovieGenres,
  tmdbSearchTvGenres,
} from "../services/tmdb.js";
import {
  GENRE_DEFINITIONS,
  GENRE_BY_ID,
  mapTmdbGenreIds,
  normalizeGenre,
  resolveGenreDef,
} from "../config/genres.js";

/** Dias que un item se considera "nuevo" */
export const NEW_WINDOW_DAYS = 14;

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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryMatches(haystack, normalizedQuery) {
  if (!normalizedQuery) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(normalizedQuery)}\\b`, "i");
  return pattern.test(haystack);
}

export function parseAddedAt(item) {
  if (!item?.addedAt) return 0;
  const t = Date.parse(item.addedAt);
  return Number.isFinite(t) ? t : 0;
}

export function isNewItem(item, windowDays = NEW_WINDOW_DAYS) {
  const t = parseAddedAt(item);
  if (!t) return false;
  const ageMs = Date.now() - t;
  return ageMs >= 0 && ageMs <= windowDays * 24 * 60 * 60 * 1000;
}

function compareCode(a, b) {
  const ca = String(a.code || "").padStart(4, "0");
  const cb = String(b.code || "").padStart(4, "0");
  return ca.localeCompare(cb, undefined, { numeric: true });
}

/** Nuevos primero (addedAt desc), luego por code asc */
export function sortCatalogItems(items) {
  return [...items].sort((a, b) => {
    const ta = parseAddedAt(a);
    const tb = parseAddedAt(b);
    if (ta !== tb) return tb - ta;
    return compareCode(a, b);
  });
}

export function getMovies() {
  return MOVIES;
}

export function getSeries() {
  return SERIES;
}

export function getMoviesSorted() {
  return sortCatalogItems(MOVIES);
}

export function getSeriesSorted() {
  return sortCatalogItems(SERIES);
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

/* ========== Sistema de géneros (un solo género por título) ========== */

/** Cache en memoria de género ya resuelto en esta sesión */
const _genreResolveCache = new WeakMap();

/**
 * Resuelve EL género de un ítem (película o serie).
 * Prioridad: 1) campo `genre` o `genres` en los datos  2) TMDB
 * Devuelve un id canónico (ej: "terror") o null.
 */
export async function resolveItemGenre(item, kind = "movie") {
  if (!item) return null;

  if (_genreResolveCache.has(item)) {
    return _genreResolveCache.get(item);
  }

  // 1) Campo explícito en los datos (genre string o genres array legacy)
  const fromData = normalizeGenre(item.genre ?? item.genres);
  if (fromData) {
    _genreResolveCache.set(item, fromData);
    return fromData;
  }

  // 2) Consultar TMDB
  try {
    const title = kind === "series"
      ? (item.tmdbShow || item.title)
      : (item.tmdbTitle || item.title);
    const year = item.tmdbYear || null;

    const tmdbIds = kind === "series"
      ? await tmdbSearchTvGenres(title, year)
      : await tmdbSearchMovieGenres(title, year);

    const id = mapTmdbGenreIds(tmdbIds);
    _genreResolveCache.set(item, id);
    return id;
  } catch {
    _genreResolveCache.set(item, null);
    return null;
  }
}

/** Versión síncrona: solo datos locales */
export function getItemGenreSync(item) {
  if (!item) return null;
  return normalizeGenre(item.genre ?? item.genres);
}

/**
 * Filtra por un único género.
 * Si selectedGenreId es null/vacío, devuelve todos.
 */
export function filterItemsByGenre(items, selectedGenreId, resolvedMap) {
  if (!selectedGenreId) return items;
  return items.filter((item) => {
    const genre = resolvedMap?.get(item) ?? getItemGenreSync(item);
    return genre === selectedGenreId;
  });
}

/**
 * Géneros presentes en el catálogo + conteo (un género por ítem).
 */
export function collectAvailableGenres(items, resolvedMap) {
  const counts = new Map();
  for (const item of items) {
    const genre = resolvedMap?.get(item) ?? getItemGenreSync(item);
    if (!genre) continue;
    counts.set(genre, (counts.get(genre) || 0) + 1);
  }
  return GENRE_DEFINITIONS
    .filter((g) => counts.has(g.id))
    .map((g) => ({
      ...g,
      count: counts.get(g.id) || 0,
    }));
}

/** Pre-resuelve el género de una lista */
export async function resolveAllGenres(items, kind = "movie") {
  const map = new Map();
  const batchSize = 8;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((item) => resolveItemGenre(item, kind))
    );
    batch.forEach((item, idx) => map.set(item, results[idx]));
  }
  return map;
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

export async function resolveSagaCardPoster(saga) {
  const firstMovie = saga.movies && saga.movies[0];
  if (!firstMovie) return saga.poster || null;
  const resolved = await resolveMovieCardPoster(firstMovie);
  return resolved || saga.poster || null;
}

export async function resolveSeriesCardPoster(serie) {
  const poster = await tmdbSearchTvPoster(serie.tmdbShow || serie.title, serie.tmdbYear);
  return poster || serie.poster || null;
}

async function probeUrlExists(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

// Detecta automaticamente que episodios de una temporada ya fueron subidos
// al release, sin necesidad de listar cada URL a mano. Prueba secuencialmente
// prefix+1, prefix+2, ... y se detiene en el primer archivo que no exista
// (asume que los episodios se suben en orden, igual que las peliculas).
async function autoDetectSeasonSrcs({ releaseTag, prefix, maxEpisodes = 20 }) {
  const base = `https://github.com/pruebagonzalez605-lgtm/movies/releases/download/${releaseTag}/`;
  const srcs = [];
  for (let episodeNumber = 1; episodeNumber <= maxEpisodes; episodeNumber += 1) {
    const url = `${base}${prefix}${episodeNumber}.mp4`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await probeUrlExists(url);
    if (!exists) break;
    srcs.push(url);
  }
  return srcs;
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

  if (!season.srcs && season.autoDetect && !season._autoDetectAttempted) {
    season._autoDetectAttempted = true;
    season.srcs = await autoDetectSeasonSrcs(season.autoDetect);
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

  for (const movie of MOVIES) {
    if (results.length >= limit) break;
    const haystack = normalizeText(`${movie.title} ${movie.saga || ""}`);
    if (!queryMatches(haystack, normalizedQuery)) continue;
    const moviePoster = await resolveMovieCardPoster(movie);
    pushResult({
      kind: "movie",
      title: movie.title,
      subtitle: movie.saga ? `Saga ${movie.saga}` : "Pelicula",
      description: "Abrir esta pelicula en el reproductor.",
      href: buildMoviePlayerUrl(movie),
      poster: moviePoster,
      gradient: movie.gradient || ["#1c1c22", "#141419"],
      code: movie.code || "Movie",
    });
  }

  for (const serie of SERIES) {
    if (results.length >= limit) break;
    const haystack = normalizeText(`${serie.title} ${serie.tmdbShow || ""}`);
    if (!queryMatches(haystack, normalizedQuery)) continue;
    const seriePoster = await resolveSeriesCardPoster(serie);
    pushResult({
      kind: "series",
      title: serie.title,
      subtitle: `${serie.seasons.length} temporadas`,
      description: "Abrir esta serie y explorar sus capitulos.",
      href: "./series.html",
      poster: seriePoster,
      gradient: serie.gradient || ["#1c1c22", "#141419"],
      code: "Serie",
    });
  }

  for (const saga of sagas) {
    if (results.length >= limit) break;
    const haystack = normalizeText(`${saga.name} ${saga.movies.map((movie) => movie.title).join(" ")}`);
    if (!queryMatches(haystack, normalizedQuery)) continue;
    const sagaPoster = await resolveSagaCardPoster(saga);
    pushResult({
      kind: "saga",
      title: saga.name,
      subtitle: `${saga.movies.length} peliculas`,
      description: "Abrir esta saga y elegir una pelicula.",
      href: "./sagas.html",
      poster: sagaPoster,
      gradient: saga.gradient || ["#1c1c22", "#141419"],
      code: "Saga",
    });
  }

  for (const serie of SERIES) {
    if (results.length >= limit) break;
    let serieFallbackPoster;
    for (const season of serie.seasons) {
      if (results.length >= limit) break;
      const episodes = await ensureSeasonEpisodes(serie, season);
      for (const [index, episode] of episodes.entries()) {
        if (results.length >= limit) break;
        const haystack = normalizeText(episode.title || "");
        if (!queryMatches(haystack, normalizedQuery)) continue;
        if (!episode.poster && serieFallbackPoster === undefined) {
          serieFallbackPoster = await resolveSeriesCardPoster(serie);
        }
        pushResult({
          kind: "episode",
          title: `${serie.title} - ${episode.title || `Episodio ${index + 1}`}`,
          subtitle: `Temporada ${season.season} - Episodio ${index + 1}`,
          description: episode.description || "Abrir este episodio en el reproductor.",
          href: buildEpisodePlayerUrl(serie, season.season, index + 1),
          poster: episode.poster || serieFallbackPoster || null,
          gradient: serie.gradient || ["#1c1c22", "#141419"],
          code: `E${index + 1}`,
        });
      }
    }
  }

  return results;
}
