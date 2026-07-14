export const TMDB_API_KEY = "58dc4e2bb092932970cdd7af79434942";
export const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";
export const TMDB_LANG = "es-419";

// Successful lookups rarely change, so they can be cached for a long time.
const CACHE_TTL_SUCCESS_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
// Empty/failed lookups (no match, network hiccup, rate limit) should be
// retried after a short while instead of being stuck forever as "no poster".
const CACHE_TTL_EMPTY_MS = 60 * 60 * 1000; // 1 hora

function tmdbCacheGet(key) {
  try {
    const raw = localStorage.getItem(`tmdb_cache_${key}`);
    if (!raw) return undefined;
    const entry = JSON.parse(raw);
    // Backward compatibility: old cache entries were the raw value itself
    // (no expiry), which could permanently "poison" a lookup as null.
    // Treat that legacy shape as expired so it gets refreshed.
    if (!entry || typeof entry !== "object" || !("value" in entry) || !("expiresAt" in entry)) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

function tmdbCacheSet(key, value) {
  try {
    const ttl = value === null || value === undefined || (Array.isArray(value) && value.length === 0)
      ? CACHE_TTL_EMPTY_MS
      : CACHE_TTL_SUCCESS_MS;
    localStorage.setItem(`tmdb_cache_${key}`, JSON.stringify({ value, expiresAt: Date.now() + ttl }));
  } catch {
    // Ignore storage quota issues.
  }
}

export async function tmdbSearchMoviePoster(title, year) {
  const cacheKey = `movie_${title}_${year || ""}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    let url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=${TMDB_LANG}&query=${encodeURIComponent(title)}`;
    if (year) url += `&year=${year}`;

    const res = await fetch(url);
    const data = await res.json();
    const result = data.results && data.results[0];
    const posterUrl = result && result.poster_path ? TMDB_IMG_BASE + result.poster_path : null;
    tmdbCacheSet(cacheKey, posterUrl);
    return posterUrl;
  } catch {
    return null;
  }
}

export async function tmdbSearchTvPoster(title, year) {
  const cacheKey = `tvposter_${title}_${year || ""}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    let url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&language=${TMDB_LANG}&query=${encodeURIComponent(title)}`;
    if (year) url += `&first_air_date_year=${year}`;

    const res = await fetch(url);
    const data = await res.json();
    const result = data.results && data.results[0];
    const posterUrl = result && result.poster_path ? TMDB_IMG_BASE + result.poster_path : null;
    tmdbCacheSet(cacheKey, posterUrl);
    return posterUrl;
  } catch {
    return null;
  }
}

export async function tmdbFindTvId(title, year) {
  const cacheKey = `tvid_${title}_${year || ""}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    let url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&language=${TMDB_LANG}&query=${encodeURIComponent(title)}`;
    if (year) url += `&first_air_date_year=${year}`;

    const res = await fetch(url);
    const data = await res.json();
    const result = data.results && data.results[0];
    const id = result ? result.id : null;
    tmdbCacheSet(cacheKey, id);
    return id;
  } catch {
    return null;
  }
}

export async function tmdbGetSeasonEpisodes(tvId, seasonNumber) {
  const cacheKey = `season_${tvId}_${seasonNumber}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}&language=${TMDB_LANG}`;
    const res = await fetch(url);
    const data = await res.json();
    const episodes = (data.episodes || []).map((ep) => ({
      title: ep.name,
      description: ep.overview,
      poster: ep.still_path ? TMDB_IMG_BASE + ep.still_path : null,
      runtime: Number.isFinite(ep.runtime) ? ep.runtime : null,
      airDate: ep.air_date || null,
      voteAverage: Number.isFinite(ep.vote_average) ? ep.vote_average : null,
    }));
    tmdbCacheSet(cacheKey, episodes);
    return episodes;
  } catch {
    return [];
  }
}

export async function resolveMoviePoster(movie) {
  const poster = await tmdbSearchMoviePoster(movie.tmdbTitle || movie.title, movie.tmdbYear);
  return poster || movie.poster || null;
}