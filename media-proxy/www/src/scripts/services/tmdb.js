export const TMDB_API_KEY = "58dc4e2bb092932970cdd7af79434942";
export const TMDB_IMG_BASE = "https://image.tmdb.org/t/p/w500";
export const TMDB_LANG = "es-419";

// eslint-disable-next-line no-console
console.log("[tmdb.js] loaded build: episode-title-fix-v5");

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
async function translateText(text, targetLang = "es") {
  if (!text) return text;

  const cacheKey = `translate_${targetLang}_${hashText(text)}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
    const res = await fetch(url);
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    const looksTranslated = typeof translated === "string"
      && translated.trim().length > 0
      && translated.trim().toLowerCase() !== text.trim().toLowerCase();

    if (looksTranslated) {
      tmdbCacheSet(cacheKey, translated, CACHE_TTL_SUCCESS_MS);
      return translated;
    }
    // Didn't actually translate (rate-limited, unsupported, etc.): fall
    // back to the original text but retry again soon.
    tmdbCacheSet(cacheKey, text, CACHE_TTL_EMPTY_MS);
    return text;
  } catch {
    return text;
  }
}

async function fetchSeasonRaw(tvId, seasonNumber, language) {
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}&language=${language}`;
  const res = await fetch(url);
  const data = await res.json();
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
    const res = await fetch(url);
    const data = await res.json();
    const translations = data.translations || [];
    tmdbCacheSet(cacheKey, translations, translations.length ? undefined : CACHE_TTL_EMPTY_MS);
    return translations;
  } catch {
    return [];
  }
}

function pickEpisodeNameFromTranslations(translations, { spanishOnly = false } = {}) {
  for (const item of translations) {
    const lang = item.iso_639_1 || "";
    const name = item.data?.name;
    if (!name) continue;
    if (spanishOnly && lang !== "es") continue;
    if (!spanishOnly && lang !== "en") continue;
    return name;
  }
  return null;
}

export async function tmdbGetSeasonEpisodes(tvId, seasonNumber) {
  // v5: adds a per-episode /translations lookup as a last-resort title
  // source, for cases where the /season endpoint returns a blank `name`
  // in every language it was queried with. Bumping the key invalidates
  // entries cached as "complete" under v4 with a placeholder title.
  const cacheKey = `season_v5_${tvId}_${seasonNumber}`;
  const cached = tmdbCacheGet(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const primaryEpisodes = await fetchSeasonRaw(tvId, seasonNumber, TMDB_LANG);

    // Recently added or less-popular shows are often not translated into
    // es-419 yet: TMDB returns the episode list with empty name/overview
    // strings even though English text already exists. When that happens,
    // fetch the English season data too and use it to fill the gaps so the
    // UI doesn't fall back to generic placeholders unnecessarily.
    const needsFallback = primaryEpisodes.some((ep) => !ep.name || !ep.overview);
    let fallbackEpisodes = [];
    if (needsFallback) {
      try {
        fallbackEpisodes = await fetchSeasonRaw(tvId, seasonNumber, "en-US");
      } catch {
        fallbackEpisodes = [];
      }
    }

    const episodes = await Promise.all(primaryEpisodes.map(async (ep, i) => {
      const fallback = fallbackEpisodes[i] || {};

      // TMDB is inconsistent about how it signals "no Spanish translation
      // yet": `overview` comes back as an empty string, but `name` instead
      // silently comes back containing the raw English text. So a missing
      // title isn't just `!ep.name` — it's also the case where `ep.name`
      // is identical to the English fallback, which means it was never
      // actually translated.
      const isUntranslated = (primaryText, fallbackText) => {
        if (!primaryText) return true;
        if (!fallbackText) return false;
        return primaryText.trim().toLowerCase() === fallbackText.trim().toLowerCase();
      };

      let title = ep.name || null;
      if (isUntranslated(ep.name, fallback.name) && fallback.name) {
        title = await translateText(fallback.name, "es");
      } else if (!title) {
        // Season endpoint had nothing for this episode in either language.
        // Fall back to the per-episode translations endpoint, which
        // reliably includes the original English title.
        const translations = await fetchEpisodeTranslations(tvId, seasonNumber, i + 1);
        const spanishName = pickEpisodeNameFromTranslations(translations, { spanishOnly: true });
        if (spanishName) {
          title = spanishName;
        } else {
          const englishName = pickEpisodeNameFromTranslations(translations);
          if (englishName) title = await translateText(englishName, "es");
        }
      }

      let description = ep.overview || null;
      if (isUntranslated(ep.overview, fallback.overview) && fallback.overview) {
        description = await translateText(fallback.overview, "es");
      }

      return {
        title,
        description,
        poster: ep.still_path ? TMDB_IMG_BASE + ep.still_path : (fallback.still_path ? TMDB_IMG_BASE + fallback.still_path : null),
        runtime: Number.isFinite(ep.runtime) ? ep.runtime : (Number.isFinite(fallback.runtime) ? fallback.runtime : null),
        airDate: ep.air_date || fallback.air_date || null,
        voteAverage: Number.isFinite(ep.vote_average) ? ep.vote_average : (Number.isFinite(fallback.vote_average) ? fallback.vote_average : null),
      };
    }));

    // If some episodes still lack a title/description (TMDB has nothing in
    // either language yet, or translation failed), cache this season only
    // briefly so we automatically pick up real data once it's added instead
    // of being stuck showing placeholders for 30 days.
    const stillIncomplete = episodes.some((ep) => !ep.title || !ep.description);
    tmdbCacheSet(cacheKey, episodes, stillIncomplete ? CACHE_TTL_EMPTY_MS : undefined);
    return episodes;
  } catch {
    return [];
  }
}

export async function resolveMoviePoster(movie) {
  const poster = await tmdbSearchMoviePoster(movie.tmdbTitle || movie.title, movie.tmdbYear);
  return poster || movie.poster || null;
}