import { createSupabaseService } from "./services/supabase.js";
import { resolveMediaUrl, MEDIA_CONFIG } from "./config/media.js";
import { tmdbFindTvId } from "./services/tmdb.js";
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
const VIEW_KEY = "OS0Bpp4nTipD72u76tahnxgWKxG-L6aYlucBohhx3P0";
const PLAYER_DEBUG = new URLSearchParams(window.location.search).has("debugPlayer");
const EXTERNAL_PLAYER_ORIGINS = [
  "https://hlswish.com",
  "https://vimeus.com",
  "https://goodstream.one",
  "https://vimeos.net",
];
const EXTERNAL_HEARTBEAT_MS = 5000;

const dom = {
  status: document.getElementById("playerStatus"),
  video: document.getElementById("player"),
  mediaSlot: document.getElementById("mediaSlot"),
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
  castBtn: document.getElementById("castBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  nextEpisodeOverlay: document.getElementById("nextEpisodeOverlay"),
  nextEpisodeTitle: document.getElementById("nextEpisodeTitle"),
  nextEpisodeBtn: document.getElementById("nextEpisodeBtn"),
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
  localPlaybackFallbackAttempted: false,
  externalFallbackInProgress: false,
  suppressVideoErrorUi: false,

  // --- Tracking de progreso para reproducción externa (HLSWish) ---
  playbackMode: "video", // "video" | "external"
  externalProgress: { time: 0, duration: 0 },
  externalHeartbeat: null,
  externalMessageCleanup: null,
  externalMessageSeen: false,

  // --- "Siguiente episodio" estilo Netflix (ver showNextEpisodeOverlay) ---
  nextEpisodeTarget: null, // { serie, seasonNumber, episodeNumber, title } | null
  nextEpisodeVisible: false,
};

// Cuanto antes del final (en segundos) aparece la tarjeta de siguiente
// episodio. 20s alcanza para que el usuario la vea y pueda tocar OK sin
// llegar a que termine el episodio actual.
const NEXT_EPISODE_LEAD_SECONDS = 20;

// Cuantos segundos avanza/retrocede cada toque de izquierda/derecha del
// control remoto (estilo Netflix: no hace falta enfocar la barra de
// progreso, las flechas siempre adelantan/retroceden directo).
const REMOTE_SEEK_STEP_SECONDS = 10;

const boundVideoElements = new WeakSet();
let globalEventsBound = false;

function playerConsole(method, ...args) {
  if (!PLAYER_DEBUG || typeof console[method] !== "function") return;
  console[method](...args);
}

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

function isCoarsePointerViewport() {
  return window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
}

// --- Fullscreen automatico dentro del APK (Capacitor) ---
// En la web dejamos que cada fuente decida: el <video> local usa el boton
// de Plyr, y las fuentes externas (godstream, hlswish, etc.) usan el boton
// de fullscreen que trae el propio iframe. En el APK no queremos esa
// eleccion: al abrir una pelicula o episodio el reproductor debe quedar en
// fullscreen de una, sin importar de que fuente termine sirviendo el video.
// La forma de lograrlo sin depender del tipo de fuente es pedir fullscreen
// sobre #mediaSlot (el contenedor que aloja tanto al <video> como al
// <iframe> externo, ver mountPlayer/tryHlsWishFallback) en lugar de pedirlo
// sobre el <video> o el iframe en si.
function isNativeAppShell() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

function lockLandscapeOrientation() {
  const orientation = window.screen?.orientation;
  if (orientation && typeof orientation.lock === "function") {
    orientation.lock("landscape").catch(() => {
      // Puede fallar si el navegador/WebView no esta en primer plano o no
      // soporta el lock; el usuario siempre puede rotar el dispositivo.
    });
  }
}

function enterAutoFullscreen() {
  if (!isNativeAppShell()) return;
  const target = document.getElementById("mediaSlot");
  if (!target) return;
  if (document.fullscreenElement === target || document.webkitFullscreenElement === target) {
    lockLandscapeOrientation();
    return;
  }

  const requestFs = (target.requestFullscreen
    || target.webkitRequestFullscreen
    || target.mozRequestFullScreen
    || target.msRequestFullscreen)?.bind(target);

  if (typeof requestFs !== "function") return;

  Promise.resolve(requestFs())
    .then(lockLandscapeOrientation)
    .catch((err) => {
      // Si el WebView rechaza el pedido (por ejemplo por falta de gesto de
      // usuario reciente), no rompemos nada: el usuario puede activar el
      // fullscreen a mano con los controles del reproductor.
      playerConsole("warn", "[auto-fullscreen] No se pudo activar automaticamente:", err?.message || err);
    });
}

// --- Modo teatro fijo para el shell nativo (APK de TV) ---
// Antes esto dependia de una capa transparente sobre #mediaSlot que
// esperaba un click/touchend para recien ahi pedir requestFullscreen()
// (que exige un gesto de usuario "fresco" para funcionar). Eso andaba con
// mouse/touch, pero un control remoto de TV no genera ese click sobre la
// capa: el D-pad mueve el foco entre elementos reales (botones, etc.) y el
// OK/Enter dispara el click directamente sobre el elemento enfocado, no
// sobre una capa invisible que ademas no es enfocable para spatial-nav.js.
// Resultado: en TV el fullscreen automatico nunca se disparaba sin tocar
// la pantalla a mano (mouse) primero.
//
// Como esta es una app nativa donde controlamos toda la ventana (ver
// MainActivity.hideSystemUi, que ahora se llama siempre, no solo cuando
// dispara la Fullscreen API), no hace falta la Fullscreen API del navegador
// para lograr el look fullscreen: alcanza con una clase CSS que reproduce
// las mismas reglas que hoy usan #mediaSlot:fullscreen. Una clase no
// requiere gesto de usuario, asi que se puede aplicar apenas se monta el
// reproductor, sin esperar ningun toque.
const TV_THEATER_CLASS = "tv-locked-fullscreen";

function enterTvLockedTheaterMode() {
  if (!isNativeAppShell()) return;
  document.documentElement.classList.add(TV_THEATER_CLASS);
  lockLandscapeOrientation();
  // El play automatico funciona sin gesto porque MainActivity ya desactiva
  // setMediaPlaybackRequiresUserGesture. Si la fuente activa es un iframe
  // externo (godstream/hlswish/etc.) no podemos dispararle el play porque
  // es de otro origen; el usuario lo arranca con los controles del propio
  // iframe, que ya van a quedar dentro del area "fullscreen" por CSS.
  if (state.playbackMode === "video") {
    dom.video?.play?.().catch(() => {
      // Si el dispositivo igual bloquea el autoplay, el usuario puede
      // tocar play a mano con los controles normales de Plyr.
    });
  }
}

function exitTvLockedTheaterMode() {
  document.documentElement.classList.remove(TV_THEATER_CLASS);
}

// Mantenemos la puerta de gesto original SOLO para cuando esto corre como
// sitio web comun (navegador de escritorio/mobile), donde si necesitamos
// la Fullscreen API real y por lo tanto un gesto de usuario genuino.
function installAutoFullscreenGate() {
  document.getElementById("autoFullscreenGate")?.remove();

  const mediaSlot = document.getElementById("mediaSlot");
  if (!mediaSlot) return;

  const gate = document.createElement("div");
  gate.id = "autoFullscreenGate";
  gate.setAttribute("aria-hidden", "true");
  gate.style.cssText = "background:transparent;cursor:pointer;";

  const onGateTap = () => {
    enterAutoFullscreen();
    if (state.playbackMode === "video") {
      dom.video?.play?.().catch(() => {});
    }
    gate.remove();
  };

  gate.addEventListener("click", onGateTap, { once: true });
  gate.addEventListener("touchend", onGateTap, { once: true });
  mediaSlot.appendChild(gate);
}


// La Fullscreen API por si sola no gira la pantalla; hace falta pedirlo
// explicitamente con la Screen Orientation API. Solo aplica en moviles
// (Android/Chrome principalmente) y solo funciona mientras estamos en
// fullscreen real, por eso se ata a los eventos enterfullscreen/exitfullscreen
// de Plyr. iOS no soporta lock() y ademas usa su propio reproductor nativo
// (ver isAppleMobileDevice en mountPlayerUi), que ya rota solo.
function initFullscreenOrientationLock(player) {
  if (!player || typeof player.on !== "function") return;
  const orientation = window.screen?.orientation;
  if (!orientation || typeof orientation.lock !== "function") return;

  player.on("enterfullscreen", () => {
    if (!isCoarsePointerViewport()) return;
    orientation.lock("landscape").catch(() => {
      // Algunos navegadores (o cuando la pagina no esta en primer plano/instalada
      // como PWA) rechazan el lock; el usuario siempre puede rotar a mano como antes.
    });
  });

  player.on("exitfullscreen", () => {
    if (typeof orientation.unlock === "function") {
      try { orientation.unlock(); } catch { /* no-op */ }
    }
  });
}

function mountPlayerUi(media, defaultQuality, qualityOptions) {
  if (!window.Plyr || isAppleMobileDevice()) {
    document.documentElement.classList.add("native-ios-player");
    return;
  }
  const previewSrc = media.previewThumbnails || media.previewVtt;
  const compactControls = isCoarsePointerViewport();
  const controls = compactControls
    ? ["play-large", "play", "progress", "current-time", "mute", "volume", "settings", "airplay", "fullscreen"]
    : [
      "play-large", "rewind", "play", "fast-forward", "progress", "current-time",
      "duration", "mute", "volume", "captions", "settings", "pip", "airplay", "fullscreen",
    ];
  state.playerUi = new window.Plyr(dom.video, {
    controls,
    settings: ["captions", "quality", "speed"],
    quality: {
      default: defaultQuality,
      options: qualityOptions,
    },
    seekTime: 10,
    // Desactivado: por defecto Plyr captura ArrowLeft/Right/Up/Down para
    // adelantar/retroceder y volumen, lo que le gana el paso a nuestra
    // navegacion por control remoto (tv/spatial-nav.js) y deja al usuario
    // sin poder salir del reproductor con el D-pad. Dejamos que sea
    // spatial-nav.js quien decida que hacer con las flechas; el seek
    // sigue funcionando igual cuando la barra de progreso (input range)
    // tiene el foco.
    keyboard: { focused: false, global: false },
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
    captions: { active: false, language: "auto", update: true },
    previewThumbnails: {
      enabled: Boolean(previewSrc),
      src: previewSrc || "",
    },
    i18n: { /* ... tu configuración de i18n ... */ },
  });
  initFullscreenOrientationLock(state.playerUi);
  bindVideoEvents(syncActiveVideo());
}

function mountCastButtonInPlayerControls(btn) {
  const controls = state.playerUi?.elements?.controls || document.querySelector(".plyr__controls");
  if (!btn || !controls) return;

  btn.classList.add("plyr__control", "cast-control-btn");
  btn.setAttribute("aria-label", "Transmitir a otra pantalla");
  btn.title = "Transmitir a otra pantalla";

  const fullscreenButton = controls.querySelector('[data-plyr="fullscreen"]');
  if (fullscreenButton?.parentElement === controls) {
    controls.insertBefore(btn, fullscreenButton);
  } else if (!controls.contains(btn)) {
    controls.appendChild(btn);
  }
}

function resetCastButton() {
  const btn = dom.castBtn;
  if (!btn) return;
  btn.hidden = true;
  btn.classList.remove("is-casting");
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
  dom.status.textContent = "La conexión se interrumpió. Reconectando...";

  let recoveryTimeout;
  const ready = () => {
    window.clearTimeout(recoveryTimeout);
    video.removeEventListener("loadedmetadata", ready);
    video.currentTime = Math.min(resumeAt, Number.isFinite(video.duration) ? video.duration : resumeAt);
    if (wasPlaying) video.play().catch(() => {});
    dom.status.textContent = "Video reconectado.";
    state.isRecovering = false;
    setTimeout(() => { if (dom.status.textContent.includes("reconectado")) dom.status.textContent = ""; }, 2500);
  };
  recoveryTimeout = setTimeout(() => {
    video.removeEventListener("loadedmetadata", ready);
    state.isRecovering = false;
  }, 10000);

  video.addEventListener("loadedmetadata", ready);
  const activeSource = state.availableSources.find(s => Number(s.size) === state.currentQuality)?.src || video.currentSrc || state.currentBaseSrc;
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
    if (!usingPlyr && wasPlaying) video.play().catch(() => { });
  };
  recoveryTimeout = window.setTimeout(() => {
    video.removeEventListener("loadedmetadata", ready);
    state.isRecovering = false;
    state.qualityChangeOrigin = null;
    updateQualityControls();
  }, QUALITY_SWITCH_TIMEOUT_MS);
  video.addEventListener("loadedmetadata", ready);

  if (usingPlyr) {
    state.playerUi.quality = Number(quality);
  } else {
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
  dom.resumeOverlay.classList.remove("is-open");
  document.body.classList.remove("resume-open", "modal-open");
}

function showResumeModal(progress) {
  if (!dom.resumeOverlay || state.resumePrompted) return;
  state.resumePrompted = true;
  dom.resumeTitle.textContent = state.currentContentTitle || "Progreso guardado";
  dom.resumeTime.textContent = formatTime(progress.time);
  dom.resumeOverlay.classList.add("is-open");
  document.body.classList.add("resume-open", "modal-open");

  const isExternal = state.playbackMode === "external";

  dom.resumeContinue.onclick = () => {
    closeResumeModal();
    if (isExternal) {
      // No hay forma confirmada de reposicionar el iframe externo a un
      // segundo exacto. Dejamos el progreso guardado intacto y seguimos
      // trackeando desde donde el usuario deje avanzar el reproductor externo.
      return;
    }
    const video = syncActiveVideo();
    if (!video) return;
    const t = Number(progress.time);
    if (!Number.isFinite(t) || t < 0) {
      video.play().catch(() => { });
      return;
    }
    const dur = Number(video.duration);
    const maxT = Number.isFinite(dur) && dur > 1 ? dur - 1 : t;
    video.currentTime = Math.min(t, Math.max(0, maxT));
    video.play().catch(() => { });
  };
  dom.resumeRestart.onclick = () => {
    clearProgress(state.currentProgressKey);
    closeResumeModal();
    if (isExternal) {
      state.externalProgress = { time: 0, duration: state.externalProgress.duration };
      return;
    }
    const video = syncActiveVideo();
    if (!video) return;
    try {
      video.currentTime = 0;
    } catch (_) { /* duration still unknown */ }
    video.play().catch(() => { });
  };
  dom.resumeClose.onclick = closeResumeModal;
}

function offerSavedProgress() {
  const progress = getProgress(state.currentProgressKey);
  if (!progress) return;
  const duration = state.playbackMode === "external"
    ? Number(progress.duration) || 0
    : (Number(syncActiveVideo()?.duration) || Number(progress.duration) || 0);
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

// ==================== TRACKING DE PROGRESO EXTERNO (HLSWish) ====================

function extractExternalEvent(raw) {
  const payload = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  if (!payload || typeof payload !== "object") return null;
  const time = Number(payload.currentTime ?? payload.time ?? payload.position);
  const duration = Number(payload.duration ?? payload.total);
  const ended = Boolean(payload.ended) || payload.event === "ended" || raw?.event === "ended";
  if (!Number.isFinite(time) && !ended) return null;
  return {
    time: Number.isFinite(time) ? time : state.externalProgress.time,
    duration: Number.isFinite(duration) ? duration : state.externalProgress.duration,
    ended,
  };
}

function persistExternalProgress() {
  if (!state.currentProgressKey) return;
  const { time, duration } = state.externalProgress;
  if (time >= MIN_RESUME_SECONDS && (!duration || duration - time > END_PROGRESS_MARGIN_SECONDS)) {
    saveProgress(state.currentProgressKey, time, duration);
  }
}

function stopExternalTracking() {
  if (state.externalHeartbeat) window.clearInterval(state.externalHeartbeat);
  state.externalHeartbeat = null;
  if (state.externalMessageCleanup) state.externalMessageCleanup();
  state.externalMessageCleanup = null;
  state.externalMessageSeen = false;
}

function bindExternalPlaybackTracking(contentKey) {
  stopExternalTracking();
  state.playbackMode = "external";

  const existing = getProgress(contentKey);
  state.externalProgress = {
    time: Number(existing?.time) || 0,
    duration: Number(existing?.duration) || 0,
  };

  const onMessage = (event) => {
    if (!EXTERNAL_PLAYER_ORIGINS.some((origin) => event.origin?.startsWith(origin))) return;
    let data = event.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    const parsed = extractExternalEvent(data);
    if (!parsed) {
      playerConsole("debug", "HLSWish postMessage sin formato reconocido:", event.data);
      return;
    }
    state.externalMessageSeen = true;
    if (parsed.ended) {
      clearProgress(state.currentProgressKey);
      if (state.nextEpisodeTarget) showNextEpisodeOverlay();
      return;
    }
    state.externalProgress = { time: parsed.time, duration: parsed.duration };
    persistExternalProgress();
  };
  window.addEventListener("message", onMessage);
  state.externalMessageCleanup = () => window.removeEventListener("message", onMessage);

  // Respaldo por reloj de pared: si el iframe no emite postMessage con el
  // tiempo de reproducción, estimamos el avance desde que se cargó.
  // Es aproximado (no detecta pausas dentro del iframe), pero evita que
  // "continuar viendo" quede completamente roto en modo externo.
  const startedAt = Date.now() - state.externalProgress.time * 1000;
  state.externalHeartbeat = window.setInterval(() => {
    if (state.externalMessageSeen) return; // ya tenemos datos reales, no adivinar
    state.externalProgress = {
      time: (Date.now() - startedAt) / 1000,
      duration: state.externalProgress.duration,
    };
    persistExternalProgress();
  }, EXTERNAL_HEARTBEAT_MS);
}

function createStoryCard({ href, poster, gradient, code, title, description, active = false, variant = "default" }) {
  const variantClass = variant === "episode" ? " player-story-card--episode" : "";
  const artVariantClass = variant === "episode" ? " player-story-art--episode" : "";
  return `
    <a class="player-story-card${variantClass}${active ? " is-active" : ""}" href="${href}">
      <div class="player-story-art${artVariantClass}" style="${poster
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

async function mountPlayer({ media, title, subtitle, poster, gradient, meta, backHref, contentKey, relatedHtml, collectionTitle, relatedVariant = "default" }) {
  document.title = title ? `${title} - Player` : "Player";
  dom.backLink.href = backHref;
  dom.backLink.textContent = "Volver al catalogo";
  dom.related.innerHTML = relatedHtml;
  dom.related.classList.toggle("player-story-grid--episodes", relatedVariant === "episode");
  dom.collectionTitle.textContent = collectionTitle;

  // Se define ANTES de resolver la fuente: así el fallback de HLSWish
  // también cuenta con contentKey/título para guardar progreso.
  state.currentContentKey = contentKey;
  state.currentProgressKey = contentKey;
  state.currentContentTitle = title;
  state.resumePrompted = false;
  state.playbackMode = "video";
  state.localPlaybackFallbackAttempted = false;
  stopExternalTracking();

  // Se aplica ANTES de saber si la fuente sera local o externa: #mediaSlot
  // es el contenedor comun a ambos casos, asi que el look fullscreen queda
  // parejo sin importar de donde termine viniendo el video.
  if (isNativeAppShell()) {
    // App nativa (APK de TV): sin gesto, sin toque. Ver enterTvLockedTheaterMode.
    enterTvLockedTheaterMode();
  } else {
    // Sitio web comun: si necesitamos un gesto real para la Fullscreen API.
    installAutoFullscreenGate();
  }

  dom.status.textContent = "Buscando fuente...";

  const sources = await discoverMediaSources(media);
  const hasValidLocalSource = sources.some((s) => s?.src && s.src.trim() !== "");

  if (!hasValidLocalSource) {
    dom.status.textContent = "Fuente local no disponible. Cargando Metodo 2...";
    const success = await tryHlsWishFallback(true);
    if (success) loadRatingsFor(contentKey);
    return; // Sin fuente local: no hay <video> que configurar de todos modos.
  }

  // Fuente local disponible
  const tracks = normalizeTracks(media);
  const initialQuality = chooseInitialQuality(sources);
  const src = sources.find((s) => Number(s.size) === initialQuality)?.src || sources[0]?.src || "";

  state.currentBaseSrc = src;
  state.currentOriginalSrc = media.src || src;
  state.availableSources = sources;
  state.currentQuality = initialQuality;
  state.autoQuality = true;

  // Si el episodio/pelicula anterior en esta misma pagina cayo al fallback
  // externo (ver mountExternalCandidate), #mediaSlot pudo haber quedado con
  // el <video> desprendido del DOM (reemplazado por el <iframe>). Antes de
  // usarlo de nuevo hay que devolverlo a #mediaSlot; si no, el video se
  // reproduce "invisible" (nunca se ve, aunque el audio y los eventos si
  // funcionen).
  if (dom.video && dom.mediaSlot && dom.video.parentElement !== dom.mediaSlot) {
    dom.mediaSlot.replaceChildren(...[dom.video, dom.nextEpisodeOverlay].filter(Boolean));
  }
  configureVideoElement(dom.video, sources, tracks, initialQuality, poster);
  if (!state.playerUi) {
    const qualityOptions = [...new Set(sources.map((s) => Number(s.size)).filter(Number.isFinite))].sort((a, b) => b - a);
    mountPlayerUi(media, initialQuality, qualityOptions);
  }
  bindCastButtonForActiveVideo();
  bindDownloadButtonForActiveVideo();

  bindVideoEvents(syncActiveVideo());
  renderQualityControls(sources);
  hideAdblockHint();
  dom.status.textContent = `Reproduciendo: ${title}`;

  loadRatingsFor(contentKey);
  setTimeout(offerSavedProgress, 800);
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

// --- "Siguiente episodio" estilo Netflix ---
// Busca el episodio que sigue al actual: el proximo de la misma temporada,
// o si este era el ultimo, el episodio 1 de la siguiente temporada que
// tenga contenido disponible. Devuelve null si no hay nada mas (ultimo
// episodio de la ultima temporada) para no mostrar la tarjeta en ese caso.
async function findNextEpisodeTarget(serie, seasonNumber, episodeNumber, episodesInSeason) {
  const nextInSeason = episodesInSeason[episodeNumber]; // indice = siguiente episodio (0-based)
  if (nextInSeason) {
    return {
      serie,
      seasonNumber,
      episodeNumber: episodeNumber + 1,
      title: nextInSeason.title || `Episodio ${episodeNumber + 1}`,
    };
  }

  const sortedSeasons = [...serie.seasons].sort((a, b) => a.season - b.season);
  const currentIndex = sortedSeasons.findIndex((item) => item.season === seasonNumber);
  if (currentIndex === -1) return null;

  for (let i = currentIndex + 1; i < sortedSeasons.length; i += 1) {
    const nextSeason = sortedSeasons[i];
    // eslint-disable-next-line no-await-in-loop
    const nextSeasonEpisodes = await ensureSeasonEpisodes(serie, nextSeason);
    if (nextSeasonEpisodes.length) {
      return {
        serie,
        seasonNumber: nextSeason.season,
        episodeNumber: 1,
        title: nextSeasonEpisodes[0].title || "Episodio 1",
      };
    }
  }

  return null;
}

function hideNextEpisodeOverlay() {
  if (!dom.nextEpisodeOverlay) return;
  dom.nextEpisodeOverlay.hidden = true;
  state.nextEpisodeVisible = false;
}

function showNextEpisodeOverlay() {
  if (!dom.nextEpisodeOverlay || !state.nextEpisodeTarget) return;
  if (state.nextEpisodeVisible) return; // ya esta visible, no reenfocar en cada tick
  dom.nextEpisodeTitle.textContent = state.nextEpisodeTarget.title;
  dom.nextEpisodeOverlay.hidden = false;
  state.nextEpisodeVisible = true;
  // Auto-foco: el pedido original es que alcance con tocar OK en el control
  // remoto, sin tener que navegar hasta el boton primero.
  dom.nextEpisodeBtn?.focus();
}

// Cambia de episodio SIN salir de player.html: en vez de armar un <a href>
// que dispare una navegacion completa, actualizamos la URL (para que
// compartir/recargar la pagina quede en el episodio correcto) y volvemos a
// correr el mismo flujo de montaje que uso el episodio actual. mountPlayer
// reusa el <video>/Plyr ya existentes (ver "if (!state.playerUi)"), asi que
// no hay parpadeo de salir del reproductor ni se pierde el modo teatro de
// la app de TV.
async function playNextEpisode() {
  const target = state.nextEpisodeTarget;
  if (!target) return;
  hideNextEpisodeOverlay();
  const newUrl = buildEpisodePlayerUrl(target.serie, target.seasonNumber, target.episodeNumber);
  window.history.replaceState({}, "", newUrl);
  try {
    await renderEpisodePlayer(target.serie, target.seasonNumber, target.episodeNumber);
    // Mantiene sincronizado el panel de episodios (boton "Episodios"), que
    // guarda su propio estado de temporada/episodio actual aparte.
    currentSeasonNum = target.seasonNumber;
    currentEpisodeNum = target.episodeNumber;
    if (typeof loadSeasonEpisodesGrid === "function") {
      renderSeasonDropdown(target.seasonNumber);
      loadSeasonEpisodesGrid(target.seasonNumber);
    }
  } catch (err) {
    playerConsole("error", "[next-episode] No se pudo cargar en el reproductor, navegando:", err);
    window.location.href = newUrl;
  }
}

async function renderEpisodePlayer(serie, seasonNumber, episodeNumber) {
  const season = serie.seasons.find((item) => item.season === seasonNumber);
  if (!season) throw new Error("season_not_found");

  const episodes = await ensureSeasonEpisodes(serie, season);
  const episode = episodes[episodeNumber - 1];
  if (!episode) throw new Error("episode_not_found");

  state.nextEpisodeTarget = await findNextEpisodeTarget(serie, seasonNumber, episodeNumber, episodes);
  hideNextEpisodeOverlay();

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
      variant: "episode",
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
    relatedVariant: "episode",
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
    // App nativa de TV (APK): arrancamos el video sin gesto del usuario.
    // Esto se dispara ACA (no en enterTvLockedTheaterMode) porque recien en
    // este punto el <source> del episodio nuevo ya esta cargado; antes de
    // esto el <video> podia seguir vacio (por ejemplo al pasar de un
    // episodio a "Siguiente episodio"), y llamar a play() en ese momento no
    // hacia nada, dejando el reproductor pausado sin forma de reanudarlo
    // con el control remoto. Si hay progreso guardado, offerSavedProgress
    // ya mostro el modal de "Continuar viendo" y es ese modal el que decide
    // cuando arrancar la reproduccion, asi que no interferimos.
    if (isNativeAppShell() && state.playbackMode === "video" && !state.resumePrompted) {
      video.play().catch(() => {
        // Si el dispositivo igual bloquea el autoplay, el usuario puede
        // tocar play a mano con los controles normales de Plyr.
      });
    }
  });

  video.addEventListener("error", () => {
    // Durante pruebas de stream limpio / mirrors no mostrar error fatal
    // ni relanzar fallback (rompe el flujo y deja pantalla negra).
    if (state.suppressVideoErrorUi || state.externalFallbackInProgress) {
      playerConsole("warn", "[video] error ignorado durante fallback externo");
      return;
    }

    // Un error de carga local intenta el fallback externo una sola vez.
    if (!state.localPlaybackFallbackAttempted && state.playbackMode === "video") {
      state.localPlaybackFallbackAttempted = true;
      dom.status.textContent = "El archivo local no está disponible. Buscando alternativa...";
      tryHlsWishFallback(true);
      return;
    }

    // Si ya hay un iframe de método 2/3, no pisar el status
    if (state.playbackMode === "external") return;
    if (document.querySelector("#mediaSlot iframe")) return;

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

    if (state.nextEpisodeTarget) {
      const remaining = video.duration - video.currentTime;
      if (remaining <= NEXT_EPISODE_LEAD_SECONDS) {
        showNextEpisodeOverlay();
      } else if (state.nextEpisodeVisible) {
        // El usuario retrocedio (seek) lejos del final: ocultamos la
        // tarjeta hasta que vuelva a estar cerca.
        hideNextEpisodeOverlay();
      }
    }

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
    // Estilo Netflix: si el usuario no toco "Siguiente episodio" durante
    // los ultimos NEXT_EPISODE_LEAD_SECONDS, al llegar al final se dispara
    // solo, sin esperar mas input.
    if (state.nextEpisodeTarget) playNextEpisode();
  });
}

function persistCurrentProgress() {
  if (state.playbackMode === "external") {
    persistExternalProgress();
    return;
  }
  const video = syncActiveVideo();
  if (!video || !state.currentProgressKey || !video.duration) return;
  if (video.currentTime >= MIN_RESUME_SECONDS
    && video.duration - video.currentTime > END_PROGRESS_MARGIN_SECONDS) {
    saveProgress(state.currentProgressKey, video.currentTime, video.duration);
  }
}

// --- Transmitir a otra pantalla (Chromecast / TVs con Cast integrado) ---
// Usa la Remote Playback API del navegador (Chrome, Edge, Android WebView).
// Safari resuelve AirPlay por su cuenta a traves del control "airplay" de Plyr,
// asi que aca solo cubrimos el caso en el que existe video.remote.
function initCastButton(video) {
  const btn = dom.castBtn;
  if (!btn || !video || !("remote" in video) || typeof video.remote?.prompt !== "function") {
    resetCastButton();
    return;
  }
  mountCastButtonInPlayerControls(btn);
  btn.hidden = false;

  if (typeof video.remote.watchAvailability === "function") {
    video.remote
      .watchAvailability((available) => {
        btn.hidden = !available;
        playerConsole("log", "Remote Playback: disponibilidad =", available);
      })
      .catch((err) => {
        // Muchos navegadores (incluido Chrome de escritorio) no pueden monitorear
        // la disponibilidad en segundo plano y rechazan la promesa con NotSupportedError
        // aunque SI soportan prompt(). El comportamiento recomendado por la especificacion
        // es mostrar el boton igual y dejar que el usuario intente conectarse manualmente.
        playerConsole("warn", "Remote Playback: no se puede monitorear disponibilidad, mostrando boton igual", err);
        btn.hidden = false;
      });
  }

  if (btn.dataset.castBound === "1") return; // Evita registrar el listener de click mas de una vez.
  btn.dataset.castBound = "1";

  btn.addEventListener("click", async () => {
    const activeVideo = syncActiveVideo();
    if (!activeVideo?.remote || typeof activeVideo.remote.prompt !== "function") {
      resetCastButton();
      return;
    }
    try {
      await activeVideo.remote.prompt();
    } catch (err) {
      playerConsole("warn", "No se pudo iniciar la transmision a pantalla", err);
      dom.status.textContent = "No se encontraron dispositivos para transmitir.";
      setTimeout(() => {
        if (dom.status.textContent.includes("transmitir")) dom.status.textContent = "";
      }, 3000);
    }
  });

  video.remote.addEventListener?.("connect", () => btn.classList.add("is-casting"));
  video.remote.addEventListener?.("disconnect", () => {
    btn.classList.remove("is-casting");
  });
}

function bindCastButtonForActiveVideo() {
  const video = syncActiveVideo();
  if (state.playbackMode !== "video") {
    resetCastButton();
    return;
  }
  initCastButton(video);
}

// --- Descargar la calidad actualmente en reproduccion ---
// Solo tiene sentido cuando hay un <video> local (state.playbackMode === "video").
// Si se cayo al Metodo 2/3 (iframe externo tipo HLSWish) no hay archivo propio
// que ofrecer, asi que el boton se mantiene oculto en ese caso.
function mountDownloadButtonInPlayerControls(btn) {
  const controls = state.playerUi?.elements?.controls || document.querySelector(".plyr__controls");
  if (!btn || !controls) return;

  btn.classList.add("plyr__control", "download-control-btn");
  btn.setAttribute("aria-label", "Descargar");

  const castButton = dom.castBtn;
  if (castButton && castButton.parentElement === controls) {
    controls.insertBefore(btn, castButton);
  } else {
    const fullscreenButton = controls.querySelector('[data-plyr="fullscreen"]');
    if (fullscreenButton?.parentElement === controls) {
      controls.insertBefore(btn, fullscreenButton);
    } else if (!controls.contains(btn)) {
      controls.appendChild(btn);
    }
  }
}

function resetDownloadButton() {
  const btn = dom.downloadBtn;
  if (!btn) return;
  btn.hidden = true;
}

function slugifyForFilename(value) {
  return String(value || "video")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "video";
}

function getActiveDownloadTarget() {
  const quality = state.currentQuality;
  const bySize = state.availableSources?.find((source) => Number(source.size) === Number(quality));
  const video = syncActiveVideo();
  const src = bySize?.src || video?.currentSrc || state.currentBaseSrc;
  if (!src) return null;

  const separator = src.includes("?") ? "&" : "?";
  const filenameBase = slugifyForFilename(state.currentContentTitle);
  const qualitySuffix = Number.isFinite(Number(quality)) ? `-${quality}p` : "";
  const downloadUrl = `${src}${separator}download=1&filename=${encodeURIComponent(`${filenameBase}${qualitySuffix}.mp4`)}`;
  return { url: downloadUrl, filename: `${filenameBase}${qualitySuffix}.mp4` };
}

function initDownloadButton() {
  const btn = dom.downloadBtn;
  if (!btn) return;

  mountDownloadButtonInPlayerControls(btn);
  btn.hidden = false;

  if (btn.dataset.downloadBound === "1") return; // Evita registrar el listener mas de una vez.
  btn.dataset.downloadBound = "1";

  btn.addEventListener("click", () => {
    const target = getActiveDownloadTarget();
    if (!target) {
      dom.status.textContent = "No se encontro un archivo para descargar.";
      setTimeout(() => {
        if (dom.status.textContent.includes("descargar")) dom.status.textContent = "";
      }, 3000);
      return;
    }
    const link = document.createElement("a");
    link.href = target.url;
    link.download = target.filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
}

function bindDownloadButtonForActiveVideo() {
  if (state.playbackMode !== "video" || !state.availableSources?.length) {
    resetDownloadButton();
    return;
  }
  initDownloadButton();
}

function bindEvents() {
  bindVideoEvents(syncActiveVideo());
  if (globalEventsBound) return;
  globalEventsBound = true;

  dom.nextEpisodeBtn?.addEventListener("click", playNextEpisode);

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

  // Desbloquea la rotacion cuando se sale del fullscreen automatico de
  // #mediaSlot por cualquier via (boton atras del sistema, gesto del
  // usuario, etc.), no solo cuando lo pedimos nosotros mismos.
  const handleFullscreenChange = () => {
    const stillFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (!stillFullscreen) {
      const orientation = window.screen?.orientation;
      if (orientation && typeof orientation.unlock === "function") {
        try { orientation.unlock(); } catch { /* no-op */ }
      }
    } else {
      // Si por algun motivo ya se entro en fullscreen (p. ej. el usuario
      // toco directamente el boton de Plyr), la capa de gesto ya no tiene
      // sentido y podria tapar controles.
      document.getElementById("autoFullscreenGate")?.remove();
    }
  };
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange);

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

// Estilo Netflix: izquierda/derecha del control remoto adelantan/retroceden
// SIEMPRE, sin necesidad de mover el foco hasta la barra de progreso (que
// ademas ya no es alcanzable con el D-pad, ver spatial-nav.js). Se registra
// en fase de "captura" para que se ejecute ANTES que el manejador de
// izquierda/derecha de spatial-nav.js (que solo mueve el foco entre
// botones) y le corta el paso con stopPropagation.
function initRemoteSeekControls() {
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      const video = dom.video;
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

      // Si hay un modal/menu/panel abierto (episodios, calidad, menu
      // hamburguesa, etc.), dejamos que las flechas se usen para navegar
      // ese overlay normalmente en vez de adelantar el video de fondo.
      const overlayOpen = document.querySelector(
        ".catalog-modal.is-open, .site-nav.is-open, .episode-grid-container.open, .site-search-dropdown.is-open",
      );
      if (overlayOpen) return;

      // Los campos de texto/listas siguen manejando sus propias flechas.
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT") return;
      if (tag === "INPUT" && active.type !== "range") return;

      event.preventDefault();
      event.stopPropagation();

      const delta = event.key === "ArrowRight" ? REMOTE_SEEK_STEP_SECONDS : -REMOTE_SEEK_STEP_SECONDS;
      video.currentTime = Math.min(Math.max(video.currentTime + delta, 0), video.duration);
    },
    true,
  );
}

async function init() {
  initRemoteSeekControls();
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

// ==================== HLSWISH FALLBACK ====================

async function getExternalEmbedInfo() {
  const params = new URLSearchParams(window.location.search);
  const explicitTmdbId = params.get("tmdb");
  const type = params.get("type");

  if (type === "movie") {
    const slug = params.get("id");
    const movie = getMovies().find((m) => slugify(m.title) === slug);
    let tmdbId = explicitTmdbId || movie?.tmdb_id || movie?.tmdbId || movie?.tmdb;
    if (!tmdbId && movie) {
      try {
        const res = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=58dc4e2bb092932970cdd7af79434942&language=es-419&query=${encodeURIComponent(movie.tmdbTitle || movie.title)}`);
        const data = await res.json();
        tmdbId = data.results?.[0]?.id;
      } catch (e) {
        playerConsole("warn", "No se pudo resolver tmdbId por busqueda:", e);
      }
    }
    return tmdbId ? { kind: "movie", tmdbId } : null;
  }

  if (type === "episode") {
    const seriesSlug = params.get("series");
    const season = Number(params.get("season"));
    const episode = Number(params.get("episode"));
    const serie = findSeriesBySlug(seriesSlug || "");
    if (!serie || !season || !episode) return null;

    let tmdbId = explicitTmdbId || serie.tmdb_id || serie.tmdbId;
    if (!tmdbId) {
      try {
        tmdbId = await tmdbFindTvId(serie.tmdbShow || serie.title, serie.tmdbYear);
      } catch (e) {
        playerConsole("warn", "No se pudo resolver tmdbId de la serie:", e);
      }
    }
    return tmdbId ? { kind: "episode", tmdbId, season, episode } : null;
  }

  return null;
}

function buildExternalListingUrl(embedInfo) {
  if (embedInfo.kind === "episode") {
    return `https://vimeus.com/e/serie?tmdb=${embedInfo.tmdbId}&se=${embedInfo.season}&ep=${embedInfo.episode}&view_key=${VIEW_KEY}`;
  }
  return `https://vimeus.com/e/movie?tmdb=${embedInfo.tmdbId}&view_key=${VIEW_KEY}`;
}

// Proveedores externos en orden de preferencia. Cada uno define cómo
// reconocer sus URLs de embed dentro del JSON de vimeus.com y un label
// para mostrar en el status.
//
// GoodStream rota/espeja su dominio de tanto en tanto (goodstream.one,
// vimeos.net, etc.), pero mantiene siempre el mismo formato de ruta
// "/embed-{slug}.html". Antes solo se reconocía "goodstream.one": si
// vimeus.com devolvía el mismo embed en un dominio espejo, el candidato
// se descartaba en silencio y el capitulo quedaba sin ninguna fuente
// utilizable (aunque el link espejo funcionara perfectamente si se abria
// suelto). Por eso se listan varios dominios conocidos en vez de uno solo.
const HLSWISH_MIRROR_DOMAINS = ["hlswish.com", "www.hlswish.com"];
const VIMEOS_MIRROR_DOMAINS = ["vimeos.net", "www.vimeos.net"];
const GOODSTREAM_MIRROR_DOMAINS = ["goodstream.one", "www.goodstream.one"];

function isExternalEmbedUrl(url, domains, pathPattern) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && domains.includes(parsed.hostname)
      && pathPattern.test(parsed.pathname);
  } catch {
    return false;
  }
}

const EXTERNAL_PROVIDERS = [
  {
    name: "HLSWish",
    label: "Reproduciendo con Metodo 2",
    match: (url) => isExternalEmbedUrl(url, HLSWISH_MIRROR_DOMAINS, /^\/e\//),
    assumeMountedAfterMs: 3000,
  },
  {
    name: "Vimeos",
    label: "Reproduciendo con Metodo 3",
    match: (url) => isExternalEmbedUrl(url, VIMEOS_MIRROR_DOMAINS, /^\/embed-/),
    sandbox: false,
  },
  {
    name: "GoodStream",
    label: "Reproduciendo con Metodo 3",
    match: (url) => isExternalEmbedUrl(url, GOODSTREAM_MIRROR_DOMAINS, /^\/embed-/),
  },
];

const STREAM_AD_HINT =
  /preroll|midroll|postroll|aviator|\bad\b|ads?[._/-]|advert|publicidad|promo|vast|ima|betwinner|anuncio/i;

const HLS_JS_SRC = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";

function isPlayableStreamUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return /\.m3u8(\?|$)/i.test(u.pathname + u.search) || /\.mp4(\?|$)/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

function isCleanStreamUrl(url) {
  return isPlayableStreamUrl(url) && !STREAM_AD_HINT.test(url);
}

/** Recorre el JSON de vimeus y junta posibles streams directos (no embeds de player). */
function collectDirectStreams(data) {
  const found = [];
  const seen = new Set();

  function walk(obj) {
    if (typeof obj === "string") {
      if (isCleanStreamUrl(obj) && !seen.has(obj)) {
        seen.add(obj);
        found.push(obj);
      }
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (obj && typeof obj === "object") {
      for (const key of ["file", "src", "source", "url", "stream", "hls", "link", "video"]) {
        if (typeof obj[key] === "string") walk(obj[key]);
      }
      Object.values(obj).forEach(walk);
    }
  }

  walk(data);
  found.sort((a, b) => Number(/\.m3u8/i.test(b)) - Number(/\.m3u8/i.test(a)));
  return found;
}

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${HLS_JS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Hls), { once: true });
      existing.addEventListener("error", () => reject(new Error("hls_load_failed")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = HLS_JS_SRC;
    s.onload = () => resolve(window.Hls);
    s.onerror = () => reject(new Error("hls_load_failed"));
    document.head.appendChild(s);
  });
}

/**
 * Reproduce un stream directo en #mediaSlot con <video> (+ hls.js si hace falta).
 * Evita el iframe del proveedor y por tanto el preroll de JWPlayer.
 */

function preferSpanishAudio(hls) {
  if (!hls || !Array.isArray(hls.audioTracks) || !hls.audioTracks.length) {
    playerConsole("info", "[hls] sin pistas de audio aún");
    return false;
  }
  const tracks = hls.audioTracks;
  playerConsole(
    "info",
    "[hls] pistas de audio:",
    tracks.map((t, i) => ({
      i,
      name: t.name,
      lang: t.lang || t.language,
      default: t.default,
    })),
  );

  const isEs = (t) => {
    const lang = String(t.lang || t.language || "").toLowerCase();
    const name = String(t.name || "").toLowerCase();
    return (
      lang.startsWith("es")
      || /espa[nñ]ol|spanish|latino|castellano|dual.?es/.test(name)
    );
  };

  // 1) default marcado español  2) cualquier es  3) no tocar
  let idx = tracks.findIndex((t) => isEs(t) && (t.default === true || t.default === "yes"));
  if (idx < 0) idx = tracks.findIndex(isEs);
  if (idx < 0) {
    playerConsole("warn", "[hls] no hay pista en español");
    return false;
  }
  if (hls.audioTrack !== idx) {
    playerConsole("info", "[hls] forzando audio ES →", idx, tracks[idx]?.name || tracks[idx]?.lang);
    try {
      hls.audioTrack = idx;
    } catch (e) {
      playerConsole("warn", "[hls] no se pudo setear audioTrack", e);
      return false;
    }
  }
  return true;
}

async function mountDirectStream(container, streamUrl) {
  stopExternalTracking();
  if (state._hls) {
    try { state._hls.destroy(); } catch (_) {}
    state._hls = null;
  }

  state.suppressVideoErrorUi = true;
  state.playbackMode = "video";
  state.currentBaseSrc = streamUrl;
  state.currentOriginalSrc = streamUrl;
  state.availableSources = [{
    src: streamUrl,
    type: /\.m3u8(\?|$)/i.test(streamUrl) ? "application/x-mpegURL" : "video/mp4",
    size: 1080,
  }];
  state.currentQuality = 1080;

  const video = document.createElement("video");
  video.id = "player";
  video.className = "plyr-video";
  video.controls = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.style.cssText = "position:absolute;inset:0;width:100%;height:100%;background:#000;";

  container.style.cssText =
    "background:#000;position:relative;padding-top:56.25%;overflow:hidden;border-radius:8px;";
  container.replaceChildren(video);
  if (dom.nextEpisodeOverlay) container.appendChild(dom.nextEpisodeOverlay);

  dom.video = video;
  hideAdblockHint();
  resetCastButton();
  resetDownloadButton();

  if (/\.m3u8(\?|$)/i.test(streamUrl)) {
    try {
      const Hls = await loadHlsScript();
      if (Hls?.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          // Fallar rápido si el CDN bloquea segmentos
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 1,
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        state._hls = hls;
        // No basta MANIFEST_PARSED: a veces el master responde y los .ts dan 403.
        // Exigimos al menos un fragmento cargado (o 5s de timeout).
        const okPlayback = await new Promise((resolve) => {
          let settled = false;
          const done = (v) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(t);
            resolve(v);
          };
          const t = window.setTimeout(() => done(false), 5000);
          hls.on(Hls.Events.FRAG_LOADED, () => done(true));
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            playerConsole("info", "[hls] manifest ok, esperando fragmento...");
            preferSpanishAudio(hls);
          });
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => preferSpanishAudio(hls));
          hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
            playerConsole("info", "[hls] audio switched →", data);
          });
          hls.on(Hls.Events.ERROR, (_, data) => {
            const code = data?.response?.code;
            playerConsole("warn", "[hls] error", data?.type, data?.details, code);
            if (data?.fatal || code === 403 || code === 404 || code === 401) {
              done(false);
            }
          });
        });
        if (!okPlayback) {
          try { hls.destroy(); } catch (_) {}
          state._hls = null;
          throw new Error("hls_playback_failed");
        }
        preferSpanishAudio(hls);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
        // Safari nativo: timeout corto si no arranca
        const okNative = await new Promise((resolve) => {
          const t = window.setTimeout(() => resolve(false), 5000);
          const onOk = () => { window.clearTimeout(t); resolve(true); };
          const onErr = () => { window.clearTimeout(t); resolve(false); };
          video.addEventListener("loadeddata", onOk, { once: true });
          video.addEventListener("error", onErr, { once: true });
        });
        if (!okNative) throw new Error("hls_native_failed");
      } else {
        throw new Error("hls_unsupported");
      }
    } catch (e) {
      playerConsole("warn", "[direct-stream] HLS fallo:", e);
      video.src = streamUrl;
    }
  } else {
    video.src = streamUrl;
  }

  bindVideoEvents(video);
  try {
    await video.play();
  } catch {
    // Autoplay bloqueado: el usuario usa controles.
  }

  bindCastButtonForActiveVideo();
  resetDownloadButton();
  setTimeout(offerSavedProgress, 600);
  return true;
}


function viaHlsProxy(streamUrl, embedUrl = null) {
  const proxyBase = (MEDIA_CONFIG?.proxyBaseUrl || "").replace(/\/+$/, "");
  if (!proxyBase || !streamUrl) return streamUrl;
  if (streamUrl.includes("/proxy-hls?")) {
    if (embedUrl && !streamUrl.includes("embed=")) {
      return `${streamUrl}&embed=${encodeURIComponent(embedUrl)}`;
    }
    return streamUrl;
  }
  try {
    const u = new URL(streamUrl);
    if (u.hostname.includes("workers.dev") || u.hostname === "github.com") return streamUrl;
  } catch {
    return streamUrl;
  }
  let out = `${proxyBase}/proxy-hls?url=${encodeURIComponent(streamUrl)}`;
  if (embedUrl) out += `&embed=${encodeURIComponent(embedUrl)}`;
  return out;
}

/** Genera mirrors del m3u8 (p3.vimeos.zip ↔ s10.vimeos.net, etc.) */
function expandStreamMirrors(streamUrl) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  add(streamUrl);
  try {
    const u = new URL(streamUrl);
    const srv = u.searchParams.get("srv");
    const host = u.hostname.toLowerCase();
    const qs = u.search || "";

    // p2.vimeos.zip + srv=s10 → s10.vimeos.net
    if (srv && (host.endsWith("vimeos.zip") || host.includes("vimeos"))) {
      const alt = new URL(streamUrl);
      alt.hostname = `${srv}.vimeos.net`;
      add(alt.href);
    }

    // .../CODE_,n,h,.urlset/master.m3u8 → variantes simples _h / _n
    // Ejemplo: /7eectpi8kx1s_,n,h,.urlset/master.m3u8
    const path = u.pathname;
    const um = path.match(/^(.*\/)([A-Za-z0-9]+)_,([^/]+),\.(urlset)\/master\.m3u8$/i);
    if (um) {
      const [, root, code, quals] = um;
      const qualities = quals.split(",").filter(Boolean);
      // Preferir calidad alta primero
      const ordered = [...qualities].sort((a, b) => (b === "h" ? 1 : 0) - (a === "h" ? 1 : 0));
      for (const q of ordered.slice(0, 2)) {
        for (const baseHost of [u.hostname, srv ? `${srv}.vimeos.net` : null].filter(Boolean)) {
          const a = new URL(streamUrl);
          a.hostname = baseHost;
          a.pathname = `${root}${code}_${q}/master.m3u8`;
          add(a.href);
        }
      }
    }
  } catch {
    // ignore
  }
  // Máximo 4 intentos para no demorar el iframe
  return out.slice(0, 4);
}

async function resolveEmbedStream(embedUrl) {
  try {
    const proxyBase = (MEDIA_CONFIG?.proxyBaseUrl || "").replace(/\/+$/, "");
    if (!proxyBase) return null;

    const endpoint = `${proxyBase}/resolve-stream?url=${encodeURIComponent(embedUrl)}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(endpoint, { signal: controller.signal });
      if (!res.ok) {
        playerConsole("warn", "[resolve-stream] HTTP", res.status);
        return null;
      }
      const data = await res.json();
      const rawStream = data?.stream || null;
      if (!rawStream || !/^https:\/\//i.test(rawStream)) {
        if (data?.proxied) return viaHlsProxy(data.proxied, embedUrl);
        return null;
      }
      // Lista de mirrors → el caller prueba en orden
      const mirrors = expandStreamMirrors(rawStream).map((u) => viaHlsProxy(u, embedUrl));
      playerConsole("info", "[resolve-stream] candidatos:", mirrors.length, mirrors[0]);
      return mirrors;
    } finally {
      window.clearTimeout(timer);
    }
  } catch (e) {
    playerConsole("warn", "[resolve-stream] fallo:", e);
    return null;
  }
}

// Recolecta TODOS los links de embed encontrados en el JSON (no solo el
// primero), agrupados por proveedor, respetando el orden de EXTERNAL_PROVIDERS.
function collectExternalCandidates(data) {
  const found = [];
  const unmatchedEmbeds = [];
  function walk(obj) {
    if (typeof obj === "string") {
      const provider = EXTERNAL_PROVIDERS.find((p) => p.match(obj));
      if (provider) found.push({ provider, url: obj });
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    if (obj && typeof obj === "object") {
      if (typeof obj.url === "string" && !EXTERNAL_PROVIDERS.some((p) => p.match(obj.url))) {
        unmatchedEmbeds.push(obj.url);
      }
      Object.values(obj).forEach(walk);
    }
  }
  walk(data);

  const candidates = EXTERNAL_PROVIDERS
    .map((provider) => found.find((item) => item.provider === provider))
    .filter(Boolean);
  playerConsole("info", "[external-player] candidatos reconocidos:", candidates.map((item) => ({
    provider: item.provider.name,
    url: item.url,
  })));
  if (unmatchedEmbeds.length) {
    playerConsole("info", "[external-player] embeds ignorados:", unmatchedEmbeds);
  }
  return candidates;
}

// Monta un candidato en el iframe. Se considera exitoso en cuanto el iframe
// termina de cargar su documento (evento "load"). No depende de recibir
// postMessage del proveedor, ya que muchos (p. ej. GoodStream) reproducen
// correctamente sin emitir ningún mensaje reconocible, lo que antes
// generaba falsos negativos y el mensaje "No se pudo cargar ninguna
// alternativa externa." aunque el video sí funcionara.
function mountExternalCandidate(container, candidate, loadTimeoutMs = 8000) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    let settled = false;
    let assumeMountedTimer = null;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(loadTimer);
      if (assumeMountedTimer) window.clearTimeout(assumeMountedTimer);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
      resolve(ok);
    };

    const onLoad = () => finish(true);
    const onError = () => finish(false);

    const loadTimer = window.setTimeout(() => finish(false), loadTimeoutMs);
    if (candidate.provider.assumeMountedAfterMs) {
      assumeMountedTimer = window.setTimeout(
        () => finish(true),
        candidate.provider.assumeMountedAfterMs,
      );
    }

    iframe.src = candidate.url;
    iframe.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;border:none;";
    iframe.setAttribute("frameborder", "0");
    if (candidate.provider.sandbox !== false) {
      iframe.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-presentation",
      );
    }
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);

    resetCastButton();
    resetDownloadButton();
    container.replaceChildren(iframe);
    // replaceChildren() tambien borraria #nextEpisodeOverlay (vive dentro
    // de #mediaSlot para quedar encima del video/iframe, ver player.html).
    // Lo reinsertamos para que la tarjeta de "siguiente episodio" pueda
    // seguir mostrandose aunque la fuente activa haya caido al fallback
    // externo (godstream/hlswish/etc.).
    if (dom.nextEpisodeOverlay) container.appendChild(dom.nextEpisodeOverlay);
  });
}

const RETRY_LINK_ID = "playerExternalRetryLink";
const ADBLOCK_HINT_ID = "adblockHint";

function showAdblockHint() {
  const el = document.getElementById(ADBLOCK_HINT_ID);
  if (!el) return;
  el.hidden = false;
  el.innerHTML =
    "Esta fuente del proveedor puede incluir anuncios. " +
    "Colevana prioriza fuente local y streams directos cuando existen para evitarlos.";
}

function hideAdblockHint() {
  const el = document.getElementById(ADBLOCK_HINT_ID);
  if (el) el.hidden = true;
}



function removeExternalRetryLink() {
  document.getElementById(RETRY_LINK_ID)?.remove();
}

// El evento "load" del iframe solo confirma que el documento remoto
// respondió, no que el video dentro de él esté realmente reproduciendo
// (el iframe es cross-origin: no podemos inspeccionar su contenido).
// Como consecuencia, un proveedor puede quedar "montado" pero mostrar una
// pantalla negra si ese título en particular no existe o falla del lado
// del proveedor, sin que nuestro código pueda notarlo. Por eso el enlace de
// reintento se muestra SIEMPRE que hay un candidato montado, sin importar
// si es el único disponible, para que el usuario nunca quede atrapado en
// una pantalla negra sin ninguna salida.
function showExternalRetryLink(label, onRetry) {
  removeExternalRetryLink();
  const link = document.createElement("a");
  link.id = RETRY_LINK_ID;
  link.href = "#";
  link.className = "player-native-link";
  link.textContent = label;
  link.style.cssText = "display:inline-block;margin-top:8px;cursor:pointer;";
  link.addEventListener("click", async (event) => {
    event.preventDefault();
    removeExternalRetryLink();
    await onRetry();
  });
  dom.status.insertAdjacentElement("afterend", link);
}

async function fetchExternalCandidates(embedInfo) {
  try {
    const url = buildExternalListingUrl(embedInfo);
    const response = await fetch(url);
    const html = await response.text();

    const doc = new DOMParser().parseFromString(html, "text/html");
    const script = doc.querySelector("#data");
    if (!script) throw new Error("No data");

    const data = JSON.parse(script.textContent);
    const directStreams = collectDirectStreams(data);
    const embedCandidates = collectExternalCandidates(data);
    playerConsole("info", "[external-player] streams directos:", directStreams);
    return { directStreams, embedCandidates };
  } catch (e) {
    playerConsole("error", "Error obteniendo candidatos externos:", e);
    return { directStreams: [], embedCandidates: [] };
  }
}

async function tryHlsWishFallback(showMessage = true) {
  // Evitar reentradas (error del <video> local + mountPlayer)
  if (state.externalFallbackInProgress) {
    playerConsole("info", "[external-player] fallback ya en curso, ignore");
    return false;
  }
  state.externalFallbackInProgress = true;
  state.suppressVideoErrorUi = true;

  try {
  const embedInfo = await getExternalEmbedInfo();
  if (!embedInfo) {
    if (showMessage) dom.status.textContent = "No se encontró fuente alternativa.";
    return false;
  }

  // FIX: el reemplazo queda acotado a #mediaSlot para no borrar el menu de episodios.
  const container = document.getElementById("mediaSlot");
  if (!container) {
    if (showMessage) dom.status.textContent = "No se pudo cargar alternativa externa.";
    return false;
  }

  container.style.cssText = "background:#000;position:relative;padding-top:56.25%;overflow:hidden;border-radius:8px;";
  removeExternalRetryLink();
  if (state._hls) {
    try { state._hls.destroy(); } catch (_) {}
    state._hls = null;
  }

  let { directStreams, embedCandidates } = await fetchExternalCandidates(embedInfo);
  let streamIndex = 0;
  let embedIndex = 0;

  const tryNextCandidate = async () => {
    // 1) Streams directos primero → <video> propio → sin preroll del host
    while (streamIndex < directStreams.length) {
      const streamUrl = directStreams[streamIndex];
      streamIndex += 1;
      playerConsole("info", "[external-player] probando stream directo:", streamUrl);
      if (showMessage) {
        dom.status.textContent = "Reproduciendo fuente limpia...";
        dom.status.style.color = "#e8c468";
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const ok = await mountDirectStream(container, viaHlsProxy(streamUrl));
        if (ok) {
          showExternalRetryLink("¿No carga el video? Probar otra fuente", async () => {
            dom.status.textContent = "Probando otra fuente...";
            await tryNextCandidate();
          });
          return true;
        }
      } catch (e) {
        playerConsole("warn", "[direct-stream] fallo:", e);
      }
    }

    // 2) Fallback a embeds (pueden incluir anuncios del proveedor)
    if (embedIndex >= embedCandidates.length) {
      if (showMessage) dom.status.textContent = "No se pudo cargar ninguna alternativa externa.";
      showExternalRetryLink("Reintentar búsqueda de fuentes", async () => {
        dom.status.textContent = "Buscando fuentes de nuevo...";
        ({ directStreams, embedCandidates } = await fetchExternalCandidates(embedInfo));
        streamIndex = 0;
        embedIndex = 0;
        await tryNextCandidate();
      });
      return false;
    }

    const candidate = embedCandidates[embedIndex];
    embedIndex += 1;
    playerConsole("info", "[external-player] probando embed:", {
      provider: candidate.provider.name,
      url: candidate.url,
    });

    // Intentar extraer m3u8 limpio vía Worker (sin iframe = sin preroll)
    if (showMessage) {
      dom.status.textContent = "Resolviendo stream limpio...";
      dom.status.style.color = "#e8c468";
    }
    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveEmbedStream(candidate.url);
    const cleanList = Array.isArray(resolved) ? resolved : (resolved ? [resolved] : []);
    for (const cleanStream of cleanList) {
      playerConsole("info", "[external-player] probando stream limpio:", cleanStream);
      if (showMessage) {
        dom.status.textContent = "Reproduciendo fuente limpia...";
        dom.status.style.color = "#e8c468";
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const okDirect = await mountDirectStream(container, cleanStream);
        if (okDirect) {
          showExternalRetryLink("¿No carga el video? Probar otra fuente", async () => {
            dom.status.textContent = "Probando otra fuente...";
            await tryNextCandidate();
          });
          return true;
        }
      } catch (e) {
        playerConsole("warn", "[direct-stream] fallo, probando mirror/iframe:", e?.message || e);
      }
    }
    if (cleanList.length && showMessage) {
      dom.status.textContent = "Fuente limpia no disponible. Cargando embed...";
    }

    // eslint-disable-next-line no-await-in-loop
    const ok = await mountExternalCandidate(container, candidate);
    if (!ok) return tryNextCandidate();

    bindExternalPlaybackTracking(state.currentProgressKey);
    setTimeout(offerSavedProgress, 800);
    if (showMessage) {
      dom.status.textContent = candidate.provider.label;
      dom.status.style.color = "#e8c468";
    }
    showAdblockHint();
    showExternalRetryLink("¿No carga el video? Probar otra fuente", async () => {
      dom.status.textContent = "Probando otra fuente...";
      await tryNextCandidate();
    });
    return true;
  };

  return await tryNextCandidate();
  } finally {
    state.externalFallbackInProgress = false;
    // Mantener suppress un momento por si el video residual dispara error
    window.setTimeout(() => { state.suppressVideoErrorUi = false; }, 1500);
  }
}

// ==================== EPISODE GRID FOR SERIES ====================
let currentSeries = null;
let currentSeasonNum = null;
let currentEpisodeNum = null;

async function loadEpisodeGrid() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("type") !== "episode") return;

  const seriesSlug = params.get("series");
  currentSeasonNum = Number(params.get("season"));
  currentEpisodeNum = Number(params.get("episode"));

  currentSeries = findSeriesBySlug(seriesSlug);
  if (!currentSeries) return;

  document.getElementById("gridSeriesTitle").textContent = currentSeries.title;

  renderSeasonDropdown(currentSeasonNum);
  document.getElementById("seasonSelectTrigger").onclick = () => {
    document.getElementById("seasonDropdownPanel").classList.contains("open")
      ? closeSeasonDropdown()
      : openSeasonDropdown();
  };

  await loadSeasonEpisodesGrid(currentSeasonNum);
  document.getElementById("toggleEpisodeBtn").style.display = "flex";
}

function closeSeasonDropdown() {
  const panel = document.getElementById("seasonDropdownPanel");
  const trigger = document.getElementById("seasonSelectTrigger");
  panel.classList.remove("open");
  trigger.setAttribute("aria-expanded", "false");
  document.removeEventListener("mousedown", handleSeasonOutsideClick);
}

function openSeasonDropdown() {
  const panel = document.getElementById("seasonDropdownPanel");
  const trigger = document.getElementById("seasonSelectTrigger");
  panel.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  document.addEventListener("mousedown", handleSeasonOutsideClick);
}

function handleSeasonOutsideClick(event) {
  const panel = document.getElementById("seasonDropdownPanel");
  const trigger = document.getElementById("seasonSelectTrigger");
  if (!panel.contains(event.target) && !trigger.contains(event.target)) {
    closeSeasonDropdown();
  }
}

// selectedSeasonNum is the season currently shown in the dropdown/grid,
// which is NOT always currentSeasonNum (the season that's actually
// playing) — browsing other seasons must not affect the "current" episode
// highlight, same as the old seasonSelect.onchange behaved.
function renderSeasonDropdown(selectedSeasonNum) {
  const panel = document.getElementById("seasonDropdownPanel");
  const label = document.getElementById("seasonSelectLabel");
  label.textContent = `Temporada ${selectedSeasonNum}`;
  panel.innerHTML = "";

  currentSeries.seasons.forEach((season) => {
    const item = document.createElement("div");
    const isSelected = season.season === selectedSeasonNum;
    item.className = `season-dropdown-option${isSelected ? " selected" : ""}`;
    item.textContent = `Temporada ${season.season}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
    item.onclick = () => {
      closeSeasonDropdown();
      renderSeasonDropdown(season.season);
      loadSeasonEpisodesGrid(season.season);
    };
    panel.appendChild(item);
  });
}

function formatEpisodeDate(isoDate) {
  if (!isoDate) return "";
  const parts = isoDate.split("-");
  if (parts.length !== 3) return "";
  const [year, month, day] = parts;
  return `${Number(day)}/${Number(month)}/${year}`;
}

function formatEpisodeDuration(minutes) {
  if (!minutes && minutes !== 0) return "";
  return `${Math.round(minutes)}m`;
}

async function loadSeasonEpisodesGrid(seasonNum) {
  const season = currentSeries.seasons.find(s => s.season === seasonNum);
  if (!season) return;

  const grid = document.getElementById("episodeGrid");
  grid.innerHTML = '<div class="ep-row-empty">Cargando episodios...</div>';

  const episodes = await ensureSeasonEpisodes(currentSeries, season);
  grid.innerHTML = "";

  if (!episodes.length) {
    grid.innerHTML = '<div class="ep-row-empty">Proximamente...</div>';
    return;
  }

  episodes.forEach((episode, index) => {
    const epNum = index + 1;
    const isCurrent = seasonNum === currentSeasonNum && epNum === currentEpisodeNum;

    const durationText = formatEpisodeDuration(episode.runtime);
    const dateText = formatEpisodeDate(episode.airDate);
    const metaText = [durationText, dateText].filter(Boolean).join(" • ");

    const row = document.createElement("div");
    row.className = `ep-row${isCurrent ? " current" : ""}`;
    row.innerHTML = `
      <div class="ep-row-left">
        <span class="ep-row-code">${seasonNum}×${epNum}</span>
        <span class="ep-row-title">${episode.title || `Episodio ${epNum}`}</span>
      </div>
      <div class="ep-row-right">
        <span class="ep-row-meta">${metaText}</span>
      </div>
    `;

    row.onclick = () => {
      const newUrl = buildEpisodePlayerUrl(currentSeries, seasonNum, epNum);
      window.history.replaceState({}, '', newUrl);
      window.location.reload(); // Recarga para cargar el nuevo episodio
    };

    grid.appendChild(row);
  });
}

// Inicializar eventos del grid
function initEpisodeGrid() {
  const toggleBtn = document.getElementById("toggleEpisodeBtn");
  const container = document.getElementById("episodeGridContainer");
  const closeBtn = document.getElementById("closeGridBtn");

  const openPanel = () => {
    container.classList.add("open");
    toggleBtn.classList.add("is-hidden");
  };

  const closePanel = () => {
    container.classList.remove("open");
    toggleBtn.classList.remove("is-hidden");
    closeSeasonDropdown();
  };

  toggleBtn.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);

  // Cerrar con Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && container.classList.contains("open")) {
      closePanel();
    }
  });
}

// Cargar grid de episodios si es una serie
initEpisodeGrid();
loadEpisodeGrid();
// Iniciar
init();