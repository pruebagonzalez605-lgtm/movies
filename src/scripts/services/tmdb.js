import { splitTranslationText, cleanEpisodeText, differsFromEnglish, createRequestQueue } from "./episode-text.js";

export const TMDB_API_KEY = "58dc4e2bb092932970cdd7af79434942";
export const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";
export const TMDB_LANG = "es-419";

// eslint-disable-next-line no-console
console.log("[tmdb.js] loaded build: episode-spanish-v6");

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

function tmdbCacheSet(key, value, ttlOverrideMs) {
  try {
    const ttl = ttlOverrideMs !== undefined
      ? ttlOverrideMs
      : (value === null || value === undefined || (Array.isArray(value) && value.length === 0)
        ? CACHE_TTL_EMPTY_MS
        : CACHE_TTL_SUCCESS_MS);
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

// Simple client-side hash so long episode overviews don't produce
// unreasonably long localStorage keys.
function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// Stopgap machine translation for episode text TMDB hasn't translated to
// Spanish yet. Uses MyMemory's free, keyless translation API. Failures or
// no-op "translations" (API returns the source text unchanged, which it
// does when it can't translate) are cached briefly so we retry soon instead
// of being stuck; real translations are cached long-term since they don't
// change.
const queueTranslation = createRequestQueue(3);
const translationRequests = new Map();

async function fetchEpisodeJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Metadata HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function translateText(text, targetLang = "es") {
  if (!text) return text;

  const cacheKey = `translate_v6_${targetLang}_${hashText(text)}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  if (translationRequests.has(cacheKey)) return translationRequests.get(cacheKey);
  const request = (async () => {
    try {
      const pieces = [];
      for (const chunk of splitTranslationText(text)) {
        const data = await queueTranslation(() => fetchEpisodeJson(
          `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${targetLang}`));
        const result = cleanEpisodeText(data?.responseData?.translatedText);
        if (Number(data.responseStatus) !== 200 || data.quotaFinished || !result) {
          throw new Error("Translation unavailable");
        }
        pieces.push(result);
      }
      const translated = pieces.join(" ");
      tmdbCacheSet(cacheKey, translated, differsFromEnglish(translated, text)
        ? CACHE_TTL_SUCCESS_MS : CACHE_TTL_EMPTY_MS);
      return translated;
    } catch {
      tmdbCacheSet(cacheKey, text, CACHE_TTL_EMPTY_MS);
      return text;
    }
  })();
  translationRequests.set(cacheKey, request);
  try { return await request; } finally { translationRequests.delete(cacheKey); }
}

async function fetchSeasonRaw(tvId, seasonNumber, language) {
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}&language=${language}`;
  const data = await fetchEpisodeJson(url);
  return data.episodes || [];
}

// The /season endpoint sometimes returns a blank `name` for a given
// language even when TMDB does have a title for the episode in some
// language — the season endpoint just doesn't fall back the way the
// website's own UI does. The per-episode /translations endpoint is more
// reliable: it lists every language TMDB has data for, including the
// original English title, so it's used as a last-resort source when both
// the primary and en-US season responses come back empty for `name`.
async function fetchEpisodeTranslations(tvId, seasonNumber, episodeNumber) {
  const cacheKey = `ep_translations_${tvId}_${seasonNumber}_${episodeNumber}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNumber}/episode/${episodeNumber}/translations?api_key=${TMDB_API_KEY}`;
    const data = await fetchEpisodeJson(url);
    const translations = data.translations || [];
    tmdbCacheSet(cacheKey, translations, translations.length ? undefined : CACHE_TTL_EMPTY_MS);
    return translations;
  } catch {
    return [];
  }
}

// Resolver cada campo por separado: puede existir título en español y sinopsis en inglés.
const seasonRequests = new Map();
const queueEpisodeTranslations = createRequestQueue(3);

export async function tmdbGetSeasonEpisodes(tvId, seasonNumber) {
  const cacheKey = `season_v6_${tvId}_${seasonNumber}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;
  if (seasonRequests.has(cacheKey)) return seasonRequests.get(cacheKey);

  const request = (async () => {
    try {
      const load = (lang) => fetchSeasonRaw(tvId, seasonNumber, lang).catch(() => []);
      const [primary, english] = await Promise.all([load(TMDB_LANG), load("en-US")]);
      const byNumber = (episodes) => new Map(episodes.map(ep => [ep.episode_number, ep]));
      const enMap = byNumber(english);
      const primaryMap = byNumber(primary);
      const numbers = [...new Set([...primaryMap.keys(), ...enMap.keys()])].sort((a, b) => a - b);
      if (!numbers.length) { tmdbCacheSet(cacheKey, []); return []; }
      const needsSpanish = numbers.some(n => ["name", "overview"].some(field =>
        !differsFromEnglish(primaryMap.get(n)?.[field], enMap.get(n)?.[field])));
      const extraSpanish = needsSpanish
        ? await Promise.all([load("es-MX"), load("es-ES")]) : [];
      const spanishMaps = [primaryMap, ...extraSpanish.map(byNumber)];
      let incomplete = false;
      const episodes = await Promise.all(numbers.map(async episodeNumber => {
        const ep = primaryMap.get(episodeNumber) || {};
        const fallback = enMap.get(episodeNumber) || {};
        const official = {};
        for (const field of ["name", "overview"]) {
          official[field] = spanishMaps.map(map => map.get(episodeNumber)?.[field])
            .find(value => differsFromEnglish(value, fallback[field]));
        }
        let translations = [];
        if (!official.name || !official.overview) {
          translations = await queueEpisodeTranslations(() =>
            fetchEpisodeTranslations(tvId, seasonNumber, episodeNumber));
        }
        const spanish = translations.filter(item => item.iso_639_1 === "es")
          .sort((a, b) => (a.iso_3166_1 === "MX" ? -1 : 0) - (b.iso_3166_1 === "MX" ? -1 : 0));
        const resolve = async (field) => {
          const localized = official[field] || spanish.map(item => item.data?.[field])
            .find(value => cleanEpisodeText(value));
          if (localized) return cleanEpisodeText(localized);
          const original = cleanEpisodeText(fallback[field]) || cleanEpisodeText(
            translations.find(item => item.iso_639_1 === "en" && cleanEpisodeText(item.data?.[field]))?.data?.[field]);
          if (original) {
            const translated = await translateText(original);
            if (!differsFromEnglish(translated, original)) incomplete = true;
            return translated;
          }
          incomplete = true;
          return cleanEpisodeText(ep[field]) || null;
        };
        const [title, description] = await Promise.all([resolve("name"), resolve("overview")]);
        return {
          episodeNumber,
          title,
          description,
          poster: (ep.still_path || fallback.still_path)
            ? TMDB_IMG_BASE + (ep.still_path || fallback.still_path) : null,
          runtime: Number.isFinite(ep.runtime) ? ep.runtime : (Number.isFinite(fallback.runtime) ? fallback.runtime : null),
          airDate: ep.air_date || fallback.air_date || null,
          voteAverage: Number.isFinite(ep.vote_average) ? ep.vote_average : (Number.isFinite(fallback.vote_average) ? fallback.vote_average : null),
        };
      }));
      tmdbCacheSet(cacheKey, episodes, incomplete ? CACHE_TTL_EMPTY_MS : CACHE_TTL_SUCCESS_MS);
      return episodes;
    } catch { return []; }
  })();
  seasonRequests.set(cacheKey, request);
  try { return await request; } finally { seasonRequests.delete(cacheKey); }
}

export async function resolveMoviePoster(movie) {
  const poster = await tmdbSearchMoviePoster(movie.tmdbTitle || movie.title, movie.tmdbYear);
  return poster || movie.poster || null;
}

/**
 * Busca una película en TMDB y devuelve sus genre_ids (números TMDB).
 * Cachea el resultado para no golpear la API en cada carga.
 */
export async function tmdbSearchMovieGenres(title, year) {
  const cacheKey = `moviegenres_${title}_${year || ""}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    let url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&language=${TMDB_LANG}&query=${encodeURIComponent(title)}`;
    if (year) url += `&year=${year}`;

    const res = await fetch(url);
    const data = await res.json();
    const result = data.results && data.results[0];
    const genreIds = result && Array.isArray(result.genre_ids) ? result.genre_ids : [];
    tmdbCacheSet(cacheKey, genreIds);
    return genreIds;
  } catch {
    tmdbCacheSet(cacheKey, [], CACHE_TTL_EMPTY_MS);
    return [];
  }
}

/**
 * Busca una serie en TMDB y devuelve sus genre_ids.
 */
export async function tmdbSearchTvGenres(title, year) {
  const cacheKey = `tvgenres_${title}_${year || ""}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    let url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&language=${TMDB_LANG}&query=${encodeURIComponent(title)}`;
    if (year) url += `&first_air_date_year=${year}`;

    const res = await fetch(url);
    const data = await res.json();
    const result = data.results && data.results[0];
    const genreIds = result && Array.isArray(result.genre_ids) ? result.genre_ids : [];
    tmdbCacheSet(cacheKey, genreIds);
    return genreIds;
  } catch {
    tmdbCacheSet(cacheKey, [], CACHE_TTL_EMPTY_MS);
    return [];
  }
}
