// Endpoints públicos documentados por los proveedores. La disponibilidad
// del documento del reproductor no garantiza que tengan cada título.
export const TMDB_EMBED_PROVIDERS = [
  { name: "Videasy", origin: "https://player.videasy.to", movie: "/movie", tv: "/tv" },
  { name: "VidSrc", origin: "https://vidsrc.to", movie: "/embed/movie", tv: "/embed/tv" },
  { name: "VidSrc SH", origin: "https://vidsrc.sh", movie: "/embed/movie", tv: "/embed/tv" },
  { name: "VidSrc Link", origin: "https://www.vidsrc.link", movie: "/embed/movie", tv: "/embed/tv" },
];

// Enlace HLS compartido por el usuario después de verificar Voe. Es temporal:
// s + e indica la vigencia de la firma; después se usa el embed de respaldo.
const MR_ROBOT_S1E1_STREAM = {
  url: "https://ugc-cdn-caching-n34e0iwmh45hhkfwkr.cloudwindow-route.com/engine/hls2-c/01/18309/7b9skbphpmon_,n,.urlset/master.m3u8?t=RNyEYlAIvuC9mYBA7POPIt6AZgPJjst5iXPwmLqvx4c&s=1791416501&e=14400&f=91546341&node=PvA+PsfoyCg4sSANgS9mEA+1TCLcoSqtt2o71fD2bow=&i=191.107&sp=2500&asn=3816&q=n&rq=7f24S8wT6IEFXtE7vGeQkYpH4IsygB1S0TYNmfar",
  expiresAt: 1791430901000,
};

export function buildVerifiedDirectStreams(info, now = Date.now()) {
  if (info?.kind !== "episode" || Number(info.tmdbId) !== 62560
    || Number(info.season) !== 1 || Number(info.episode) !== 1
    || !Number.isFinite(now) || now >= MR_ROBOT_S1E1_STREAM.expiresAt) return [];
  return [MR_ROBOT_S1E1_STREAM.url];
}

export function getProviderSandbox(value) {
  // Videasy y los reproductores internos de VidSrc rechazan sandbox incluso
  // con scripts y formularios permitidos. Validar origen y ruta, nunca el nombre.
  try {
    const url = new URL(value);
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
