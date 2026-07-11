import { createSupabaseService } from "./services/supabase.js";
import { resolveMediaUrl } from "./config/media.js";
import {
  buildEpisodePlayerUrl,
  buildMoviePlayerUrl,
  ensureSeasonEpisodes,
  findMovieBySlug,
  findSeriesBySlug,
  getMovies,
  resolveMovieCardPoster,
  resolveSeriesCardPoster,
  slugify,
} from "./shared/catalog-data.js";
import { getKickSession, initKickAuthUI } from "./shared/kick-auth-ui.js";

const supabase = createSupabaseService({
  url: "https://iqmxbmodzdtjdfepggae.supabase.co",
  anonKey: "sb_publishable_w2GCzCqZJcYMHi8yyCN23Q_IthBqvhF",
});
const supabaseRest = `${supabase.config.url}/rest/v1`;
const MIN_RESUME_SECONDS = 3;
const END_PROGRESS_MARGIN_SECONDS = 15;
const QUALITY_SWITCH_TIMEOUT_MS = 20000;

const dom = {
  status: document.getElementById("playerStatus"),
  video: document.getElementById("player"),
  related: document.getElementById("playerRelated"),
  collectionTitle: document.getElementById("playerCollectionTitle"),
  backLink: document.getElementById("playerBackLink"),
  globalStars: document.getElementById("globalStars"),
  ratingGlobalText: document.getElementById("ratingGlobalText"),
  ratingUserBlock: document.getElementById("ratingUserBlock"),
  userStars: document.getElementById("userStars"),
  ratingLoginHint: document.getElementById("ratingLoginHint"),
  resumeOverlay: document.getElementById("resumeOverlay"),
  resumeTitle: document.getElementById("resumeModalTitle"),
  resumeTime: document.getElementById("resumeModalTime"),
  resumeContinue: document.getElementById("resumeContinueBtn"),
  resumeRestart: document.getElementById("resumeRestartBtn"),
  resumeClose: document.getElementById("resumeCloseBtn"),
  quickSettings: document.getElementById("playerQuickSettings"),
  qualitySelect: document.getElementById("playerQualitySelect"),
  qualityHint: document.getElementById("playerQualityHint"),
};

const state = {
  currentContentKey: null,
  currentProgressKey: null,
  currentContentTitle: null,
  currentBaseSrc: null,
  currentOriginalSrc: null,
  lastProgressSave: 0,
  isRecovering: false,
  watchdogInterval: null,
  watchdogLastTime: 0,
  watchdogStallCount: 0,
  waitingTimer: null,
  playerUi: null,
  resumePrompted: false,
  availableSources: [],
  currentQuality: 1080,
  autoQuality: true,
  qualityChangeOrigin: null,
};

const boundVideoElements = new WeakSet();
let globalEventsBound = false;

function getActiveVideo() {
  const playerMedia = state.playerUi?.media;
  if (playerMedia?.isConnected) return playerMedia;
  return document.querySelector(".plyr video, video#player, video") || dom.video;
}

function syncActiveVideo() {
  const activeVideo = getActiveVideo();
  if (activeVideo) dom.video = activeVideo;
  return activeVideo;
}

function normalizeSources(media) {
  if (Array.isArray(media.sources) && media.sources.length) {
    return media.sources
      .filter((source) => source?.src)
      .map((source) => ({
        src: resolveMediaUrl(source.src),
        type: source.type || (source.src.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4"),
        size: Number(source.size || source.quality) || undefined,
      }));
  }
  return media.src ? [{
    src: resolveMediaUrl(media.src),
    type: media.type || (media.src.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4"),
    size: Number(media.quality) || 1080,
  }] : [];
}

function buildVariantUrl(src, quality) {
  try {
    const url = new URL(src);
    const parts = url.pathname.split("/");
    const filename = decodeURIComponent(parts.pop() || "");
    if (!/\.mp4$/i.test(filename)) return null;
    const base = filename.replace(/-(?:1080|720|480|360)p(?=\.mp4$)/i, "").replace(/\.mp4$/i, "");
    parts.push(encodeURIComponent(`${base}-${quality}p.mp4`).replace(/%2F/gi, "/"));
    url.pathname = parts.join("/");
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

async function discoverMediaSources(media) {
  const configured = normalizeSources(media);
  if (configured.length > 1 || !media.src) return configured;

  let original;
  try {
    original = new URL(media.src);
  } catch {
    return configured;
  }
  if (original.hostname !== "github.com" || !original.pathname.includes("/releases/download/")) {
    return configured;
  }

  const candidates = [720, 480]
    .map((size) => ({ size, src: buildVariantUrl(media.src, size) }))
    .filter((source) => source.src);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6000);

  try {
    const checked = await Promise.all(candidates.map(async (source) => {
      try {
        const response = await fetch(resolveMediaUrl(source.src), {
          method: "HEAD",
          signal: controller.signal,
        });
        return response.ok ? {
          src: resolveMediaUrl(source.src),
          type: "video/mp4",
          size: source.size,
        } : null;
      } catch {
        return null;
      }
    }));
    return [...configured, ...checked.filter(Boolean)].sort((a, b) => (b.size || 0) - (a.size || 0));
  } finally {
    window.clearTimeout(timeout);
  }
}

function normalizeTracks(media) {
  const tracks = media.tracks || media.subtitles || [];
  return tracks
    .filter((track) => track?.src)
    .map((track, index) => ({
      kind: track.kind || "subtitles",
      label: track.label || track.language || `Subtitulos ${index + 1}`,
      srcLang: track.srcLang || track.srclang || track.language || "es",
      src: track.src,
      default: Boolean(track.default),
    }));
}

function configureVideoElement(video, sources, tracks, initialQuality, poster) {
  const orderedSources = [...sources].sort(
    (a, b) => Number(Number(a.size) !== Number(initialQuality))
      - Number(Number(b.size) !== Number(initialQuality)),
  );
  const sourceElements = orderedSources.map((source) => {
    const element = document.createElement("source");
    element.src = source.src;
    element.type = source.type;
    if (Number.isFinite(Number(source.size))) element.setAttribute("size", String(source.size));
    return element;
  });
  const trackElements = tracks.map((track) => {
    const element = document.createElement("track");
    element.kind = track.kind;
    element.label = track.label;
    element.srclang = track.srcLang;
    element.src = track.src;
    element.default = track.default;
    return element;
  });

  video.removeAttribute("src");
  video.replaceChildren(...sourceElements, ...trackElements);
  video.poster = poster || "";
  video.load();
}

function isAppleMobileDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function chooseInitialQuality(sources) {
  const qualities = sources.map((source) => Number(source.size)).filter(Number.isFinite);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const slowConnection = connection?.saveData || ["slow-2g", "2g", "3g"].includes(connection?.effectiveType);
  if (slowConnection && qualities.includes(480)) return 480;
  if (window.matchMedia("(max-width: 700px), (pointer: coarse)").matches) {
    if (qualities.includes(720)) return 720;
    if (qualities.includes(480)) return 480;
  }
  return qualities.length ? Math.max(...qualities) : 1080;
}

function mountPlayerUi(media, defaultQuality, qualityOptions) {
  if (!window.Plyr || isAppleMobileDevice()) {
    document.documentElement.classList.add("native-ios-player");
    return;
  }
  const previewSrc = media.previewThumbnails || media.previewVtt;
  const compactControls = window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
  const controls = compactControls
    ? ["play-large", "play", "progress", "current-time", "mute", "volume", "settings", "fullscreen"]
    : [
      "play-large", "rewind", "play", "fast-forward", "progress", "current-time",
      "duration", "mute", "volume", "captions", "settings", "pip", "fullscreen",
    ];
  state.playerUi = new window.Plyr(dom.video, {
    controls,
    settings: ["captions", "quality", "speed"],
    quality: {
      default: defaultQuality,
      options: qualityOptions,
    },
    seekTime: 10,
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
    captions: { active: false, language: "auto", update: true },
    previewThumbnails: {
      enabled: Boolean(previewSrc),
      src: previewSrc || "",
    },
    i18n: {
      restart: "Reiniciar", rewind: "Retroceder {seektime}s", play: "Reproducir",
      pause: "Pausar", fastForward: "Adelantar {seektime}s", seek: "Buscar",
      seekLabel: "{currentTime} de {duration}", played: "Reproducido", buffered: "Cargado",
      currentTime: "Tiempo actual", duration: "Duracion", volume: "Volumen", mute: "Silenciar",
      unmute: "Activar sonido", enableCaptions: "Activar subtitulos",
      disableCaptions: "Desactivar subtitulos", settings: "Ajustes", speed: "Velocidad",
      normal: "Normal", quality: "Calidad", loop: "Repetir", start: "Iniciar",
      end: "Fin", all: "Todo", reset: "Restablecer", disabled: "Desactivado",
      enabled: "Activado", advertisement: "Anuncio", qualityBadge: {
        2160: "4K", 1440: "HD", 1080: "HD", 720: "HD", 576: "SD", 480: "SD",
      },
    },
  });
  bindVideoEvents(syncActiveVideo());
}

function withCacheBust(url) {
  if (!url) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_reconnect=${Date.now()}`;
}

function recoverPlayback() {
  if (state.isRecovering || !state.currentBaseSrc) return;
  const video = syncActiveVideo();
  if (!video) return;
  state.isRecovering = true;
  const resumeAt = video.currentTime || 0;
  const wasPlaying = !video.paused;
  dom.status.textContent = "La conexion se interrumpio. Reconectando el video...";

  let recoveryTimeout;
  const ready = () => {
    window.clearTimeout(recoveryTimeout);
    video.removeEventListener("loadedmetadata", ready);
    video.currentTime = Math.min(resumeAt, Number.isFinite(video.duration) ? video.duration : resumeAt);
    if (wasPlaying) video.play().catch(() => {});
    dom.status.textContent = "Video reconectado.";
    state.isRecovering = false;
    window.setTimeout(() => {
      if (dom.status.textContent === "Video reconectado.") dom.status.textContent = "";
    }, 2500);
  };
  recoveryTimeout = window.setTimeout(() => {
    video.removeEventListener("loadedmetadata", ready);
    state.isRecovering = false;
  }, 10000);

  video.addEventListener("loadedmetadata", ready);
  const activeSource = state.availableSources.find((source) => Number(source.size) === state.currentQuality)?.src
    || video.currentSrc
    || state.currentBaseSrc;
  video.src = withCacheBust(activeSource);
  video.load();
}

function switchPlaybackQuality(quality, reason = "") {
  const target = state.availableSources.find((source) => Number(source.size) === Number(quality));
  if (!target || state.isRecovering || Number(quality) === Number(state.currentQuality)) return false;

  const video = syncActiveVideo();
  if (!video) return false;

  const usingPlyr = Boolean(state.playerUi);
  state.isRecovering = true;
  state.qualityChangeOrigin = state.autoQuality ? "auto" : "manual";
  const resumeAt = video.currentTime || 0;
  const wasPlaying = !video.paused;
  if (state.waitingTimer) window.clearTimeout(state.waitingTimer);
  state.waitingTimer = null;
  if (reason) dom.status.textContent = reason;

  let recoveryTimeout;
  const ready = () => {
    window.clearTimeout(recoveryTimeout);
    video.removeEventListener("loadedmetadata", ready);
    if (!usingPlyr) {
      video.currentTime = Math.min(resumeAt, Number.isFinite(video.duration) ? video.duration : resumeAt);
    }
    state.currentQuality = Number(quality);
    state.isRecovering = false;
    state.qualityChangeOrigin = null;
    updateQualityControls();
    if (!usingPlyr && wasPlaying) video.play().catch(() => {});
  };
  recoveryTimeout = window.setTimeout(() => {
    video.removeEventListener("loadedmetadata", ready);
    state.isRecovering = false;
    state.qualityChangeOrigin = null;
    updateQualityControls();
  }, QUALITY_SWITCH_TIMEOUT_MS);
  video.addEventListener("loadedmetadata", ready);

  if (usingPlyr) {
    // Plyr conserva el tiempo, estado y seleccion visible de su menu interno.
    state.playerUi.quality = Number(quality);
  } else {
    // Safari iOS usa el reproductor nativo y necesita cambiar el recurso directo.
    video.src = target.src;
    video.load();
  }
  return true;
}

function handlePlaybackStall() {
  if (state.isRecovering) return;
  const lower = state.availableSources
    .filter((source) => Number(source.size) < Number(state.currentQuality))
    .sort((a, b) => Number(b.size) - Number(a.size))[0];
  if (lower) {
    state.autoQuality = true;
    updateQualityControls();
    switchPlaybackQuality(lower.size, `La conexion esta lenta. Bajando a ${lower.size}p...`);
    return;
  }
  recoverPlayback();
}

function updateQualityControls() {
  if (!dom.qualitySelect || !dom.qualityHint) return;
  dom.qualitySelect.value = state.autoQuality ? "auto" : String(state.currentQuality);
  dom.qualityHint.textContent = `Actual: ${state.currentQuality}p${state.autoQuality ? "" : " · Manual"}`;
}

function renderQualityControls(sources) {
  if (!dom.quickSettings || !dom.qualitySelect) return;
  const qualities = [...new Set(sources.map((source) => Number(source.size)).filter(Number.isFinite))]
    .sort((a, b) => b - a);
  // Plyr muestra las calidades dentro del engranaje. El selector externo queda
  // como respaldo para iPhone/iPad, donde se usa el reproductor nativo.
  dom.quickSettings.hidden = qualities.length < 2 || Boolean(state.playerUi);
  dom.qualitySelect.replaceChildren(
    Object.assign(document.createElement("option"), { value: "auto", textContent: "Automatica" }),
    ...qualities.map((quality) => Object.assign(document.createElement("option"), {
      value: String(quality),
      textContent: `${quality}p`,
    })),
  );
  updateQualityControls();
}

function startWatchdog() {
  if (state.watchdogInterval) window.clearInterval(state.watchdogInterval);
  const video = syncActiveVideo();
  if (!video) return;
  state.watchdogLastTime = video.currentTime;
  state.watchdogStallCount = 0;
  state.watchdogInterval = window.setInterval(() => {
    const activeVideo = syncActiveVideo();
    if (!activeVideo) return;
    if (state.isRecovering || activeVideo.paused || activeVideo.ended) {
      state.watchdogLastTime = activeVideo.currentTime;
      state.watchdogStallCount = 0;
      return;
    }
    const advanced = Math.abs(activeVideo.currentTime - state.watchdogLastTime) >= 0.15;
    state.watchdogStallCount = advanced ? 0 : state.watchdogStallCount + 1;
    state.watchdogLastTime = activeVideo.currentTime;
    if (state.watchdogStallCount >= 2) handlePlaybackStall();
  }, 8000);
}

function renderStarRow(container, value, interactive) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.toggle("interactive", Boolean(interactive));
  for (let i = 0; i < 5; i += 1) {
    const star = document.createElement("span");
    const frac = Math.max(0, Math.min(1, (value || 0) - i));
    star.className = "star";
    star.innerHTML = `<span class="star-bg">&#9733;</span><span class="star-fill" style="width:${frac * 100}%">&#9733;</span>`;
    container.appendChild(star);
  }
}

async function loadRatingsFor(contentKey) {
  if (!contentKey) return;
  dom.ratingGlobalText.textContent = "Cargando...";
  renderStarRow(dom.globalStars, 0, false);

  try {
    const url = `${supabaseRest}/ratings?content_key=eq.${encodeURIComponent(contentKey)}&select=rating,kick_username`;
    const res = await fetch(url, { headers: supabase.headers() });
    if (!res.ok) throw new Error("ratings_failed");
    const rows = await res.json();
    const count = rows.length;
    const avg = count ? rows.reduce((sum, row) => sum + Number(row.rating), 0) / count : 0;

    renderStarRow(dom.globalStars, avg, false);
    dom.ratingGlobalText.textContent = count
      ? `${avg.toFixed(1)} estrellas (${count} ${count === 1 ? "voto" : "votos"})`
      : "Sin calificaciones aun. Se el primero en calificar.";

    const session = getKickSession();
    if (session) {
      const ownVote = rows.find((row) => row.kick_username === session.username);
      renderStarRow(dom.userStars, ownVote ? Number(ownVote.rating) : 0, true);
      dom.ratingUserBlock.style.display = "flex";
      dom.ratingLoginHint.style.display = "none";
    } else {
      dom.ratingUserBlock.style.display = "none";
      dom.ratingLoginHint.style.display = "inline";
    }
  } catch {
    dom.ratingGlobalText.textContent = "No se pudo cargar la calificacion.";
  }
}

async function submitRating(value) {
  const session = getKickSession();
  if (!session || !state.currentContentKey) return;

  try {
    const res = await fetch(`${supabaseRest}/ratings?on_conflict=content_key,kick_username`, {
      method: "POST",
      headers: supabase.headers({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        content_key: state.currentContentKey,
        content_title: state.currentContentTitle,
        kick_username: session.username,
        rating: value,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error("submit_failed");
    await loadRatingsFor(state.currentContentKey);
  } catch {
    dom.ratingGlobalText.textContent = "No se pudo guardar tu calificacion.";
  }
}

function saveProgress(key, time, duration) {
  if (!key) return;
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    map[key] = { time, duration, updatedAt: Date.now() };
    localStorage.setItem("playback_progress", JSON.stringify(map));
    localStorage.setItem("last_watched_content", key);
  } catch {
    // Ignore storage errors.
  }
}

function getProgress(key) {
  if (!key) return null;
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    const progress = map[key]
      || (state.currentOriginalSrc ? map[state.currentOriginalSrc] : null)
      || (state.currentBaseSrc ? map[state.currentBaseSrc] : null);
    if (!progress || !Number.isFinite(Number(progress.time))) return null;
    return progress;
  } catch {
    return null;
  }
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function closeResumeModal() {
  dom.resumeOverlay.style.display = "none";
  document.body.classList.remove("resume-open");
}

function showResumeModal(progress) {
  if (!dom.resumeOverlay || state.resumePrompted) return;
  state.resumePrompted = true;
  dom.resumeTitle.textContent = state.currentContentTitle || "Progreso guardado";
  dom.resumeTime.textContent = formatTime(progress.time);
  dom.resumeOverlay.style.display = "flex";
  document.body.classList.add("resume-open");

  dom.resumeContinue.onclick = () => {
    const video = syncActiveVideo();
    closeResumeModal();
    if (!video) return;
    video.currentTime = Math.min(Number(progress.time), Math.max(0, video.duration - 1));
    video.play().catch(() => {});
  };
  dom.resumeRestart.onclick = () => {
    const video = syncActiveVideo();
    clearProgress(state.currentProgressKey);
    closeResumeModal();
    if (!video) return;
    video.currentTime = 0;
    video.play().catch(() => {});
  };
  dom.resumeClose.onclick = closeResumeModal;
}

function offerSavedProgress() {
  const progress = getProgress(state.currentProgressKey);
  if (!progress) return;
  const duration = Number(syncActiveVideo()?.duration) || Number(progress.duration) || 0;
  const resumeAt = Number(progress.time) || 0;
  if (resumeAt >= MIN_RESUME_SECONDS && (!duration || duration - resumeAt > END_PROGRESS_MARGIN_SECONDS)) {
    showResumeModal(progress);
  }
}

function clearProgress(key) {
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    delete map[key];
    if (state.currentOriginalSrc) delete map[state.currentOriginalSrc];
    if (state.currentBaseSrc) delete map[state.currentBaseSrc];
    localStorage.setItem("playback_progress", JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}

function createStoryCard({ href, poster, gradient, code, title, description, active = false }) {
  return `
    <a class="player-story-card${active ? " is-active" : ""}" href="${href}">
      <div class="player-story-art" style="${poster
        ? `background-image: linear-gradient(180deg, rgba(8,8,12,0.1), rgba(8,8,12,0.82)), url('${poster}'); background-size: cover; background-position: center;`
        : `background: linear-gradient(160deg, ${gradient[0]}, ${gradient[1]});`}">
        <span class="player-story-badge">${code}</span>
      </div>
      <div class="player-story-copy">
        <strong>${title}</strong>
        <p>${description}</p>
      </div>
    </a>
  `;
}

async function mountPlayer({ media, title, subtitle, poster, gradient, meta, backHref, contentKey, relatedHtml, collectionTitle }) {
  document.title = title ? `${title} - Player` : "Player";
  dom.backLink.href = backHref;
  dom.backLink.textContent = "Volver al catalogo";
  dom.related.innerHTML = relatedHtml;
  dom.collectionTitle.textContent = collectionTitle;

  dom.status.textContent = "Buscando calidades disponibles...";
  const sources = await discoverMediaSources(media);
  const tracks = normalizeTracks(media);
  const initialQuality = chooseInitialQuality(sources);
  const src = sources.find((source) => Number(source.size) === initialQuality)?.src || sources[0]?.src || "";
  state.currentContentKey = contentKey;
  state.currentProgressKey = contentKey;
  state.currentContentTitle = title;
  state.currentBaseSrc = src;
  state.currentOriginalSrc = media.src || src;
  state.availableSources = sources;
  state.currentQuality = initialQuality;
  state.autoQuality = true;
  state.resumePrompted = false;
  window.setTimeout(offerSavedProgress, 0);

  configureVideoElement(dom.video, sources, tracks, initialQuality, poster);
  if (!state.playerUi) {
    const qualityOptions = [...new Set(sources.map((source) => Number(source.size)).filter(Number.isFinite))]
      .sort((a, b) => b - a);
    mountPlayerUi(media, initialQuality, qualityOptions);
  }
  bindVideoEvents(syncActiveVideo());
  renderQualityControls(sources);
  dom.status.textContent = `Listo para reproducir: ${title}`;

  loadRatingsFor(contentKey);
}

async function renderMoviePlayer(movie) {
  const poster = await resolveMovieCardPoster(movie);
  const relatedPool = movie.saga
    ? getMovies().filter((item) => item.saga === movie.saga)
    : getMovies().filter((item) => item.title !== movie.title).slice(0, 4);
  const relatedMoviesWithPosters = await Promise.all(
    relatedPool.map(async (item) => ({
      item,
      poster: await resolveMovieCardPoster(item),
    })),
  );
  const relatedMovies = relatedMoviesWithPosters
    .map(({ item, poster: relatedPoster }) => createStoryCard({
      href: buildMoviePlayerUrl(item),
      poster: relatedPoster,
      gradient: item.gradient || ["#1c1c22", "#141419"],
      code: item.code || "Movie",
      title: item.title,
      description: item.saga ? `Saga ${item.saga}` : "Otra pelicula disponible en tu cartelera.",
      active: item.title === movie.title,
    }))
    .join("");

  await mountPlayer({
    media: movie,
    title: movie.title,
    subtitle: movie.saga ? `Saga: ${movie.saga}` : "Pelicula seleccionada desde el catalogo",
    poster,
    gradient: movie.gradient || ["#1c1c22", "#141419"],
    meta: ["Movie", movie.code ? `Codigo ${movie.code}` : "Seleccion actual", movie.saga || "Vista individual"],
    backHref: "./movies.html",
    contentKey: `movie:${slugify(movie.title)}`,
    relatedHtml: relatedMovies,
    collectionTitle: movie.saga ? `Peliculas de ${movie.saga}` : "Seguir explorando",
  });
}

async function renderEpisodePlayer(serie, seasonNumber, episodeNumber) {
  const season = serie.seasons.find((item) => item.season === seasonNumber);
  if (!season) throw new Error("season_not_found");

  const episodes = await ensureSeasonEpisodes(serie, season);
  const episode = episodes[episodeNumber - 1];
  if (!episode) throw new Error("episode_not_found");

  const poster = episode.poster || await resolveSeriesCardPoster(serie);
  const relatedEpisodes = episodes
    .map((item, index) => createStoryCard({
      href: buildEpisodePlayerUrl(serie, seasonNumber, index + 1),
      poster: item.poster || poster,
      gradient: serie.gradient || ["#1c1c22", "#141419"],
      code: `E${index + 1}`,
      title: item.title || `Episodio ${index + 1}`,
      description: item.description || `Temporada ${seasonNumber}`,
      active: index === episodeNumber - 1,
    }))
    .join("");

  await mountPlayer({
    media: episode,
    title: `${serie.title} - ${episode.title || `Episodio ${episodeNumber}`}`,
    subtitle: `Temporada ${seasonNumber} - Episodio ${episodeNumber}`,
    poster,
    gradient: serie.gradient || ["#1c1c22", "#141419"],
    meta: ["Serie", `Temporada ${seasonNumber}`, `Episodio ${episodeNumber}`],
    backHref: "./series.html",
    contentKey: `series:${slugify(serie.title)}:s${seasonNumber}:e${episodeNumber}`,
    relatedHtml: relatedEpisodes,
    collectionTitle: `Capitulos de la temporada ${seasonNumber}`,
  });
}

function normalizeComparableMediaUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    url.searchParams.delete("_reconnect");
    return url.href;
  } catch {
    return value || "";
  }
}

function syncQualityFromVideo(video, markAsManual, explicitQuality) {
  const currentUrl = normalizeComparableMediaUrl(video.currentSrc);
  const currentSource = state.availableSources.find(
    (source) => normalizeComparableMediaUrl(source.src) === currentUrl,
  );
  const selected = Number(explicitQuality || currentSource?.size || state.playerUi?.quality);
  if (!Number.isFinite(selected)) return;

  const qualityChanged = selected !== Number(state.currentQuality);
  state.currentQuality = selected;
  if (qualityChanged && markAsManual) {
    state.autoQuality = false;
    dom.status.textContent = `Calidad seleccionada: ${selected}p`;
  }
  updateQualityControls();
}

function bindVideoEvents(video) {
  if (!video || boundVideoElements.has(video)) return;
  boundVideoElements.add(video);

  video.addEventListener("loadedmetadata", () => {
    syncQualityFromVideo(video, !state.isRecovering);
    offerSavedProgress();
  });

  video.addEventListener("error", () => {
    dom.status.replaceChildren();
    const message = document.createElement("span");
    message.textContent = "No se pudo reproducir este archivo. ";
    const retry = document.createElement("a");
    retry.className = "player-native-link";
    retry.href = state.currentOriginalSrc || state.currentBaseSrc || "#";
    retry.textContent = "Abrir video directamente";
    retry.target = "_blank";
    retry.rel = "noopener";
    dom.status.append(message, retry);
  });

  video.addEventListener("playing", () => {
    if (state.waitingTimer) window.clearTimeout(state.waitingTimer);
    state.waitingTimer = null;
    dom.status.textContent = "";
    startWatchdog();
  });

  video.addEventListener("stalled", () => {
    if (!video.paused && video.readyState < 3) dom.status.textContent = "Cargando mas video...";
  });

  video.addEventListener("waiting", () => {
    if (!video.paused) dom.status.textContent = "Ajustando la reproduccion a tu conexion...";
    if (state.waitingTimer) window.clearTimeout(state.waitingTimer);
    state.waitingTimer = window.setTimeout(() => {
      if (!video.paused && !video.ended && video.readyState < 3) handlePlaybackStall();
    }, 10000);
  });

  video.addEventListener("qualitychange", (event) => {
    const pendingOrigin = state.qualityChangeOrigin;
    syncQualityFromVideo(video, pendingOrigin ? pendingOrigin === "manual" : true, event.detail?.quality);
  });

  video.addEventListener("timeupdate", () => {
    if (!state.currentBaseSrc || !video.duration) return;
    const now = Date.now();
    if (now - state.lastProgressSave < 5000) return;
    state.lastProgressSave = now;
    if (video.currentTime >= MIN_RESUME_SECONDS
      && video.duration - video.currentTime > END_PROGRESS_MARGIN_SECONDS) {
      saveProgress(state.currentProgressKey, video.currentTime, video.duration);
    }
  });

  video.addEventListener("seeked", () => {
    if (!state.currentBaseSrc || !video.duration) return;
    if (video.currentTime >= MIN_RESUME_SECONDS
      && video.duration - video.currentTime > END_PROGRESS_MARGIN_SECONDS) {
      saveProgress(state.currentProgressKey, video.currentTime, video.duration);
    }
  });

  video.addEventListener("ended", () => {
    if (state.currentProgressKey) clearProgress(state.currentProgressKey);
  });
}

function persistCurrentProgress() {
  const video = syncActiveVideo();
  if (!video || !state.currentProgressKey || !video.duration) return;
  if (video.currentTime >= MIN_RESUME_SECONDS
    && video.duration - video.currentTime > END_PROGRESS_MARGIN_SECONDS) {
    saveProgress(state.currentProgressKey, video.currentTime, video.duration);
  }
}

function bindEvents() {
  bindVideoEvents(syncActiveVideo());
  if (globalEventsBound) return;
  globalEventsBound = true;

  dom.qualitySelect?.addEventListener("change", () => {
    if (dom.qualitySelect.value === "auto") {
      state.autoQuality = true;
      const automaticQuality = chooseInitialQuality(state.availableSources);
      if (!switchPlaybackQuality(automaticQuality, `Calidad automatica: ${automaticQuality}p`)) {
        updateQualityControls();
      }
      return;
    }
    const selected = Number(dom.qualitySelect.value);
    state.autoQuality = false;
    if (!switchPlaybackQuality(selected, `Calidad seleccionada: ${selected}p`)) updateQualityControls();
  });

  window.addEventListener("pagehide", persistCurrentProgress);
  window.addEventListener("beforeunload", persistCurrentProgress);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCurrentProgress();
  });
  window.setInterval(persistCurrentProgress, 2000);

  dom.userStars?.addEventListener("click", (event) => {
    const session = getKickSession();
    if (!session) return;
    const starEl = event.target.closest(".star");
    if (!starEl) return;
    const stars = [...dom.userStars.children];
    const index = stars.indexOf(starEl);
    const rect = starEl.getBoundingClientRect();
    const isHalf = event.clientX - rect.left < rect.width / 2;
    const value = index + (isHalf ? 0.5 : 1);
    submitRating(value);
  });
}

async function init() {
  initKickAuthUI({
    onChange: () => {
      if (state.currentContentKey) loadRatingsFor(state.currentContentKey);
    },
  });
  bindEvents();

  const params = new URLSearchParams(window.location.search);
  const type = params.get("type");

  try {
    if (type === "movie") {
      const movie = findMovieBySlug(params.get("id") || "");
      if (!movie) throw new Error("movie_not_found");
      await renderMoviePlayer(movie);
      return;
    }

    if (type === "episode") {
      const serie = findSeriesBySlug(params.get("series") || "");
      const season = Number(params.get("season"));
      const episode = Number(params.get("episode"));
      if (!serie || !season || !episode) throw new Error("episode_not_found");
      await renderEpisodePlayer(serie, season, episode);
      return;
    }

    throw new Error("missing_query");
  } catch {
    document.title = "Contenido no encontrado - Player";
    dom.status.textContent = "Contenido no encontrado. Revisa el enlace y vuelve al catalogo.";
    dom.related.innerHTML = `
      ${createStoryCard({
        href: "./movies.html",
        poster: "",
        gradient: ["#3d2b10", "#8a6f2f"],
        code: "01",
        title: "Volver a Movies",
        description: "Explorar peliculas disponibles.",
      })}
      ${createStoryCard({
        href: "./series.html",
        poster: "",
        gradient: ["#1c1c22", "#141419"],
        code: "02",
        title: "Volver a Series",
        description: "Explorar temporadas y episodios.",
      })}
    `;
    dom.collectionTitle.textContent = "Sigue explorando";
  }
}

init();
