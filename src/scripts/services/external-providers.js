// Endpoints públicos documentados por los proveedores. La disponibilidad
// del documento del reproductor no garantiza que tengan cada título.
// Videasy se quitó en nov. 2026: player.videasy.to dejó de resolver en DNS.
export const TMDB_EMBED_PROVIDERS = [
  { name: "VidSrc", origin: "https://vidsrc.to", movie: "/embed/movie", tv: "/embed/tv" },
  { name: "VidSrc SH", origin: "https://vidsrc.sh", movie: "/embed/movie", tv: "/embed/tv" },
  { name: "VidSrc Link", origin: "https://www.vidsrc.link", movie: "/embed/movie", tv: "/embed/tv" },
];

// Reproductor oficial de Dailymotion (src "dailymotion:<id>" en series.js).
// Es un reproductor de plataforma, sin redirecciones: va sin sandbox para
// que pueda usar pantalla completa y su propio control de reproduccion.
const DAILYMOTION_PLAYER = /^\/player\/[a-z0-9]{3,12}\.html$/i;

export function getProviderSandbox(value) {
  // Videasy y los reproductores internos de VidSrc rechazan sandbox incluso
  // con scripts y formularios permitidos. Validar origen y ruta, nunca el nombre.
  try {
    const url = new URL(value);
    if (url.origin === "https://geo.dailymotion.com" && !url.username && !url.password
      && DAILYMOTION_PLAYER.test(url.pathname) && /^[a-z0-9]{5,12}$/i.test(url.searchParams.get("video") || "")) return null;
    const provider = TMDB_EMBED_PROVIDERS.find(item => item.origin === url.origin);
    const isMovie = provider && url.pathname.startsWith(`${provider.movie}/`)
      && /^[1-9]\d*\/?$/.test(url.pathname.slice(provider.movie.length + 1));
    const isEpisode = provider && url.pathname.startsWith(`${provider.tv}/`)
      && /^[1-9]\d*\/\d+\/[1-9]\d*\/?$/.test(url.pathname.slice(provider.tv.length + 1));
    if (provider && !url.username && !url.password && (isMovie || isEpisode)) {
      return null;
    }
  } catch (_) {}
  return "allow-scripts allow-same-origin allow-presentation allow-forms";
}

export function buildProviderCandidates(info) {
  if (!info || !["movie", "episode"].includes(info.kind)) return [];
  const id = Number(info.tmdbId);
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const season = Number(info.season);
  const episode = Number(info.episode);
  if (info.kind === "episode" && (!Number.isSafeInteger(season) || season < 0
    || !Number.isSafeInteger(episode) || episode <= 0)) return [];
  return TMDB_EMBED_PROVIDERS.map(provider => ({
    provider: { name: provider.name, label: "Reproductor externo" },
    url: info.kind === "movie" ? `${provider.origin}${provider.movie}/${id}`
      : `${provider.origin}${provider.tv}/${id}/${season}/${episode}`,
    iframeEligible: true,
    // Resolver el stream del proveedor y montarlo en el reproductor propio.
    resolveClean: true,
  }));
}

export function mergeProviderCandidates(...groups) {
  const seen = new Set();
  return groups.flat().filter(candidate => {
    if (!candidate?.url || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}
