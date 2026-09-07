/**
 * Sistema de géneros (un solo género por título).
 * Nombres en español + mapeo a IDs de TMDB.
 */

export const GENRE_DEFINITIONS = [
  { id: "animacion", name: "Animación", tmdbIds: [16], color: "#f59e0b", emoji: "🎨" },
  { id: "accion", name: "Acción", tmdbIds: [28], color: "#ef4444", emoji: "💥" },
  { id: "aventura", name: "Aventura", tmdbIds: [12], color: "#f97316", emoji: "🗺️" },
  { id: "comedia", name: "Comedia", tmdbIds: [35], color: "#eab308", emoji: "😂" },
  { id: "terror", name: "Terror", tmdbIds: [27], color: "#7f1d1d", emoji: "👻" },
  { id: "thriller", name: "Thriller", tmdbIds: [53], color: "#6b21a8", emoji: "🔪" },
  { id: "drama", name: "Drama", tmdbIds: [18], color: "#3b82f6", emoji: "🎭" },
  { id: "ciencia-ficcion", name: "Ciencia Ficción", tmdbIds: [878], color: "#06b6d4", emoji: "🚀" },
  { id: "fantasia", name: "Fantasía", tmdbIds: [14], color: "#a855f7", emoji: "🧙" },
  { id: "romance", name: "Romance", tmdbIds: [10749], color: "#ec4899", emoji: "❤️" },
  { id: "crimen", name: "Crimen", tmdbIds: [80], color: "#64748b", emoji: "🕵️" },
  { id: "misterio", name: "Misterio", tmdbIds: [9648], color: "#475569", emoji: "🔍" },
  { id: "familia", name: "Familia", tmdbIds: [10751], color: "#22c55e", emoji: "👨‍👩‍👧‍👦" },
  { id: "musica", name: "Música", tmdbIds: [10402], color: "#d946ef", emoji: "🎵" },
  { id: "guerra", name: "Guerra", tmdbIds: [10752], color: "#78716c", emoji: "⚔️" },
  { id: "historia", name: "Historia", tmdbIds: [36], color: "#a16207", emoji: "📜" },
  { id: "western", name: "Western", tmdbIds: [37], color: "#b45309", emoji: "🤠" },
  { id: "documental", name: "Documental", tmdbIds: [99], color: "#0ea5e9", emoji: "🎥" },
];

/** Prioridad al elegir UN género desde varios de TMDB (el primero que aparezca gana) */
const GENRE_PRIORITY = [
  "terror",
  "animacion",
  "ciencia-ficcion",
  "fantasia",
  "accion",
  "aventura",
  "thriller",
  "crimen",
  "misterio",
  "comedia",
  "romance",
  "drama",
  "familia",
  "musica",
  "guerra",
  "historia",
  "western",
  "documental",
];

export const GENRE_BY_ID = Object.fromEntries(
  GENRE_DEFINITIONS.map((g) => [g.id, g])
);

export const TMDB_TO_GENRE_ID = (() => {
  const map = {};
  for (const g of GENRE_DEFINITIONS) {
    for (const tid of g.tmdbIds) {
      map[tid] = g.id;
    }
  }
  return map;
})();

/** Normaliza a un solo id de género (string) o null */
export function normalizeGenre(genre) {
  if (genre == null || genre === "") return null;
  // Si viene array (datos viejos), tomar el primero prioritario
  if (Array.isArray(genre)) {
    return pickPrimaryGenre(genre.map((g) => normalizeGenre(g)).filter(Boolean));
  }
  const s = String(genre).toLowerCase().trim();
  if (GENRE_BY_ID[s]) return s;
  const found = GENRE_DEFINITIONS.find(
    (def) =>
      def.name.toLowerCase() === s ||
      def.id === s ||
      def.name.toLowerCase().includes(s) ||
      s.includes(def.name.toLowerCase())
  );
  return found ? found.id : null;
}

/** Elige un único género según prioridad */
export function pickPrimaryGenre(genreIds) {
  if (!Array.isArray(genreIds) || genreIds.length === 0) return null;
  const set = new Set(genreIds.filter(Boolean));
  for (const id of GENRE_PRIORITY) {
    if (set.has(id)) return id;
  }
  return genreIds[0] || null;
}

/** Convierte genre_ids de TMDB a UN solo id nuestro */
export function mapTmdbGenreIds(tmdbGenreIds) {
  if (!Array.isArray(tmdbGenreIds)) return null;
  const ids = [];
  for (const tid of tmdbGenreIds) {
    const ourId = TMDB_TO_GENRE_ID[tid];
    if (ourId && !ids.includes(ourId)) ids.push(ourId);
  }
  return pickPrimaryGenre(ids);
}

export function resolveGenreDef(genreId) {
  const id = normalizeGenre(genreId);
  return id ? GENRE_BY_ID[id] : null;
}
