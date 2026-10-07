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
import { isTvDevice, isNativeAppShell } from "./shared/device.js";
import { remoteKey, seekVideo } from "./tv/media-controls.js";
import { createControlsVisibility } from "./tv/controls-visibility.js";
import { EXTERNAL_AD_NOTICE, externalEmbedUrl } from "./services/external-playback.js";
import { TMDB_EMBED_PROVIDERS, buildProviderCandidates, mergeProviderCandidates } from "./services/external-providers.js";

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
  "https://www.hlswish.com",
  "https://vimeus.com",
  "https://www.vimeus.com",
  "https://goodstream.one",
  "https://www.goodstream.one",
  "https://vimeos.net",
  "https://www.vimeos.net",
  ...TMDB_EMBED_PROVIDERS.map(provider => provider.origin),
];
const EXTERNAL_HEARTBEAT_MS = 5000;

// Los iframes externos se ofrecen solo después de agotar los streams directos.
// Su evento load no permite saber si muestran video o un muro antiadblock.

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
  mobileQuickControls: document.getElementById("mobileQuickControls"),
  mqRewindBtn: document.getElementById("mqRewindBtn"),
  mqPlayPauseBtn: document.getElementById("mqPlayPauseBtn"),
  mqForwardBtn: document.getElementById("mqForwardBtn"),
  externalLoadingOverlay: document.getElementById("externalLoadingOverlay"),
  externalLoadingText: document.getElementById("externalLoadingText"),
  tvBackBtn: document.getElementById("tvPlayerBackBtn"),
  tvControls: document.getElementById("tvPlaybackControls"),
  externalNotice: document.getElementById("externalProviderNotice"),
  episodeToggleBtn: document.getElementById("toggleEpisodeBtn"),
  episodeGridContainer: document.getElementById("episodeGridContainer"),
};

function restoreMediaSlotOverlays(container) {
  for (const overlay of [
    dom.mobileQuickControls,
    dom.nextEpisodeOverlay,
    dom.externalLoadingOverlay,
    dom.tvBackBtn,
    dom.tvControls,
    dom.externalNotice,
  ]) {
    if (overlay) container.appendChild(overlay);
  }
  if (isTvDevice()) {
    for (const control of [dom.episodeToggleBtn, dom.episodeGridContainer, dom.resumeOverlay]) {
      if (control) container.appendChild(control);
    }
  }
}

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
  tvVisibility: null,
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
  nextEpisodeCountdownTimer: null,
  nextEpisodeCountdownLeft: 0,
  /** Si true, el próximo mount no muestra "Continuar viendo" y fuerza play */
  autoplayNextEpisode: false,
  /** Evita que playNextEpisode() se dispare 2 veces en paralelo (boton +
   *  countdown + evento "ended" pueden solaparse) y deja rastro de si
   *  veniamos de fullscreen para poder recuperarlo si el navegador lo
   *  cierra solo durante la transicion. */
  nextEpisodeTransitioning: false,
  wasFullscreenBeforeTransition: false,
};

/** Segundos de cuenta regresiva en el botón (estilo Netflix). */
const NEXT_EPISODE_COUNTDOWN_SECONDS = 10;

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
// El APK es el mismo tanto para Android TV como para celular. El look "TV"
// (teatro fijo, fullscreen automatico sin gesto, orientacion forzada) solo
// debe aplicarse cuando corremos en un televisor de verdad; en un celular
// queremos el mismo comportamiento que ya usa la web movil.
//
// ANTES: isTvAppShell() = APK + user agent de TV. El problema es que el
// WebView de Capacitor en un Android TV reporta un user agent de Android
// comun (sin "android tv"), asi que la condicion daba false y el televisor
// se quedaba SIN pantalla completa aunque la fuente fuera el player propio.
// Ahora la deteccion vive en shared/device.js y usa, en orden: la bandera
// nativa de MainActivity (UiModeManager), el user agent, y por ultimo el
// tipo de entrada (sin touch ni hover = control remoto).
/** Televisor, sea el APK de TV o el navegador del propio televisor. */
function isTvScreen() {
  return isTvDevice();
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

// Pide pantalla completa REAL sobre #mediaSlot (el contenedor comun al
// <video> propio y al iframe externo).
//
// Solo se usa para el reproductor propio (state.playbackMode === "video"):
// cuando la fuente es un iframe externo, el fullscreen lo maneja el propio
// iframe y forzarlo desde afuera rompe sus controles.
//
// La Fullscreen API exige un gesto de usuario "fresco". Un control remoto
// no siempre lo genera, asi que si el pedido se rechaza dejamos armado un
// reintento que se dispara con la primera tecla/OK/click que llegue. En el
// APK esto es un extra: el look de pantalla completa ya lo garantiza el
// modo teatro por CSS (enterTvLockedTheaterMode), que no necesita gesto.
let pendingFullscreenRetry = null;

function getFullscreenTarget() {
  return document.getElementById("mediaSlot");
}

function isRealFullscreen() {
  const target = getFullscreenTarget();
  const current = document.fullscreenElement || document.webkitFullscreenElement;
  return Boolean(target && current === target);
}

function clearFullscreenRetry() {
  if (!pendingFullscreenRetry) return;
  ["keydown", "click", "touchend"].forEach((type) => {
    document.removeEventListener(type, pendingFullscreenRetry, true);
  });
  pendingFullscreenRetry = null;
}

function requestOwnPlayerFullscreen({ retryOnGesture = true } = {}) {
  if (state.playbackMode !== "video") return;
  const target = getFullscreenTarget();
  if (!target) return;
  if (isRealFullscreen()) {
    lockLandscapeOrientation();
    return;
  }

  const requestFs = (target.requestFullscreen
    || target.webkitRequestFullscreen
    || target.mozRequestFullScreen
    || target.msRequestFullscreen)?.bind(target);

  if (typeof requestFs !== "function") return;

  Promise.resolve(requestFs())
    .then(() => {
      clearFullscreenRetry();
      lockLandscapeOrientation();
    })
    .catch((err) => {
      playerConsole("warn", "[auto-fullscreen] Rechazado, se reintenta con el proximo gesto:", err?.message || err);
      if (!retryOnGesture || pendingFullscreenRetry) return;
      pendingFullscreenRetry = () => {
        clearFullscreenRetry();
        // Ya estamos dentro de un gesto de usuario: este pedido si lo
        // acepta el navegador/WebView.
        requestOwnPlayerFullscreen({ retryOnGesture: false });
      };
      ["keydown", "click", "touchend"].forEach((type) => {
        document.addEventListener(type, pendingFullscreenRetry, true);
      });
    });
}

/**
 * Pantalla completa del reproductor propio en televisor.
 *
 * - En el APK de TV alcanza con el modo teatro por CSS (no necesita gesto y
 *   MainActivity ya oculta la UI del sistema), pero igual intentamos el
 *   fullscreen real para que el video use el decodificador a pantalla
 *   completa del sistema.
 * - En el navegador de un Smart TV el CSS solo no tapa la barra del
 *   navegador, asi que el fullscreen real es lo que realmente importa.
 */
function ensureTvFullscreenForOwnPlayer() {
  if (!isTvScreen()) return;
  if (state.playbackMode !== "video") return;

  enterTvLockedTheaterMode();

  // Se intenta varias veces: justo despues de montar Plyr el <video> puede
  // no estar listo, y algunos WebViews solo aceptan el pedido una vez que
  // la reproduccion arranco de verdad.
  requestOwnPlayerFullscreen();
  window.setTimeout(() => requestOwnPlayerFullscreen(), 600);

  const video = syncActiveVideo();
  if (video && !video.dataset.tvFullscreenBound) {
    video.dataset.tvFullscreenBound = "1";
    video.addEventListener("playing", () => requestOwnPlayerFullscreen(), { once: true });
  }
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
  if (!isTvScreen()) return;
  document.documentElement.classList.add(TV_THEATER_CLASS);
  restoreMediaSlotOverlays(dom.mediaSlot);
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

// Desactivado en web: la capa #autoFullscreenGate bloqueaba volumen, seek
// y fullscreen de Plyr. El teatro a pantalla completa solo aplica en APK
// (enterTvLockedTheaterMode). Esta función solo limpia restos viejos del DOM.
function installAutoFullscreenGate() {
  document.getElementById("autoFullscreenGate")?.remove();
}

/** Quita capas viejas que puedan tapar el player (no toca el modo teatro). */
function removeStrayPlayerOverlays() {
  document.getElementById("autoFullscreenGate")?.remove();
  document.querySelectorAll("#autoFullscreenGate").forEach((el) => el.remove());
  // Restos de capas full-size transparentes dentro del slot
  const slot = document.getElementById("mediaSlot");
  if (slot) {
    slot.querySelectorAll(":scope > div").forEach((el) => {
      if (el.id === "nextEpisodeOverlay") return;
      if (el.id === "autoFullscreenGate") el.remove();
      const st = el.getAttribute("style") || "";
      if (el.getAttribute("aria-hidden") === "true" && /inset|100%|absolute/.test(st)) {
        el.remove();
      }
    });
  }
  // Asegura que Plyr reciba clics
  document.querySelectorAll(".plyr, .plyr__controls, .plyr__video-wrapper").forEach((el) => {
    el.style.pointerEvents = "auto";
  });
}

/** En navegador: quita capas que tapan el player y el modo TV si se coló. */
function ensureWebPlayerInteractable() {
  if (isTvScreen()) {
    // En un televisor el modo teatro se mantiene a proposito. En el
    // navegador del propio TV igual conviene limpiar capas viejas: si algo
    // queda tapando el player, el control remoto no puede enfocar nada.
    if (!isNativeAppShell()) removeStrayPlayerOverlays();
    return;
  }
  exitTvLockedTheaterMode();
  removeStrayPlayerOverlays();
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
    hideNextEpisodeOverlay();
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
  const compactControls = !isTvDevice() && isCoarsePointerViewport();
  const controls = compactControls
    ? ["play", "progress", "current-time", "mute", "volume", "settings", "airplay", "fullscreen"]
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
    hideControls: true,
    speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
    captions: { active: false, language: "auto", update: true },
    previewThumbnails: {
      enabled: Boolean(previewSrc),
      src: previewSrc || "",
    },
    i18n: { /* ... tu configuración de i18n ... */ },
    // Sin esto, Plyr pide fullscreen sobre su propio wrapper `.plyr` y no
    // sobre #mediaSlot. #nextEpisodeOverlay vive como hermano de `.plyr`
    // dentro de #mediaSlot, así que en fullscreen real quedaba fuera del
    // elemento fullscreen y el navegador nunca la pintaba, aunque el JS
    // le sacara el atributo `hidden` sin tirar ningún error.
    fullscreen: { enabled: true, fallback: true, iosNative: false, container: "#mediaSlot" },
  });
  initFullscreenOrientationLock(state.playerUi);
  bindVideoEvents(syncActiveVideo());
  if (compactControls) initMobileQuickControls(state.playerUi);
}

/**
 * Fila de retroceder 10s / play-pausa / adelantar 10s centrada sobre el
 * video, solo para mobile (ver compactControls en mountPlayerUi). Los
 * botones "rewind"/"fast-forward" nativos de Plyr no se usan en mobile
 * porque no muestran los 10 segundos, asi que esta capa los reemplaza
 * visualmente y opera directo sobre la instancia de Plyr para mantener
 * todo sincronizado (progreso, resume, etc.).
 */
function initMobileQuickControls(player) {
  const { mobileQuickControls, mqRewindBtn, mqPlayPauseBtn, mqForwardBtn } = dom;
  if (!mobileQuickControls || !mqRewindBtn || !mqPlayPauseBtn || !mqForwardBtn || !player) return;

  // Leemos siempre del <video> real (player.media) en vez de player.paused:
  // el getter .paused de Plyr a veces queda un paso atras del elemento real
  // (sobre todo justo despues de togglear play/pause en movil).
  const getVideoEl = () => player.media || dom.video;
  // Un solo atributo (data-state) decide el icono Y el aria-label en la
  // misma linea: antes se togleaban dos "hidden" por separado y podian
  // quedar desincronizados (aria-label decia "Pausar" pero el icono
  // visible seguia siendo el de play). Ver reglas de .mq-btn.mq-play en
  // app.css.
  const syncPlayIcon = () => {
    const video = getVideoEl();
    const playing = video ? !video.paused && !video.ended : !player.paused;
    mqPlayPauseBtn.dataset.state = playing ? "playing" : "paused";
    mqPlayPauseBtn.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
  };

  mqRewindBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    player.currentTime = Math.max(0, player.currentTime - 10);
  });
  mqForwardBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const max = Number.isFinite(player.duration) ? player.duration : Infinity;
    player.currentTime = Math.min(max, player.currentTime + 10);
  });
  mqPlayPauseBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    player.togglePlay();
    // Reconciliamos varias veces en el instante siguiente al click: el
    // evento play/pause de Plyr puede llegar con demora en movil, asi
    // que no alcanza con togglear una vez y confiar en ese evento solo.
    syncPlayIcon();
    requestAnimationFrame(syncPlayIcon);
    setTimeout(syncPlayIcon, 50);
    setTimeout(syncPlayIcon, 250);
  });

  player.on("play", syncPlayIcon);
  player.on("pause", syncPlayIcon);
  player.on("playing", syncPlayIcon);
  // Plyr agrega/saca "plyr--hide-controls" del wrapper .plyr al mostrar u
  // ocultar su barra de controles; espejamos ese estado en nuestra fila
  // para que aparezcan y desaparezcan juntas.
  player.on("controlsshown", () => mobileQuickControls.classList.remove("mq-hidden"));
  player.on("controlshidden", () => mobileQuickControls.classList.add("mq-hidden"));

  syncPlayIcon();
  mobileQuickControls.hidden = false;
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
}

function offerSavedProgress() {
  // Tras "Siguiente episodio" no interrumpir con el modal de continuar.
  if (state.autoplayNextEpisode) {
    state.autoplayNextEpisode = false;
    state.resumePrompted = true;
    const video = syncActiveVideo();
    video?.play?.()?.catch?.(() => {});
    return;
  }
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
    if (!EXTERNAL_PLAYER_ORIGINS.includes(event.origin)) return;
    if (event.source !== dom.mediaSlot.querySelector("iframe")?.contentWindow) return;
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
      // Solo en fullscreen: mostrar overlay / no auto-avanzar en ventana normal
      if (state.nextEpisodeTarget && isPlayerFullscreen()) showNextEpisodeOverlay();
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
  if (isTvScreen()) {
    enterTvLockedTheaterMode();
  } else {
    ensureWebPlayerInteractable();
  }

  dom.status.textContent = "Buscando fuente...";

  const sources = await discoverMediaSources(media);
  const hasValidLocalSource = sources.some((s) => s?.src && s.src.trim() !== "");

  if (!hasValidLocalSource) {
    dom.status.textContent = "Buscando fuente...";
    const success = await tryHlsWishFallback(true);
    // La fuente limpia ofrece el progreso al terminar de montar. Si ninguna
    // fuente funcionó, se limpia la reproducción automática pendiente.
    if (!success) state.autoplayNextEpisode = false;
    ensureWebPlayerInteractable();
    if (success) loadRatingsFor(contentKey);
    return; // Sin fuente local: el stream limpio ya montó el reproductor natural.
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
  // el <video> desprendido del DOM (reemplazado por el <iframe>) y con
  // padding-top:56.25% inline. Antes de usarlo de nuevo hay que devolver
  // el video a #mediaSlot y quitar estilos de iframe; si no, el video se
  // reproduce mal o "invisible".
  if (dom.mediaSlot) {
    dom.mediaSlot.removeAttribute("style");
    // OJO: cuando Plyr esta activo, envuelve el <video> en su propio
    // contenedor .plyr (con toda la barra de controles), asi que
    // dom.video.parentElement deja de ser mediaSlot directamente aunque
    // todo funcione bien. Antes este chequeo comparaba parentElement contra
    // mediaSlot, lo que daba "true" (video "perdido") en TODOS los cambios
    // de episodio despues del primero, y el replaceChildren de mas abajo
    // arrancaba el <video> de adentro del wrapper de Plyr, destruyendo los
    // controles (quedaba el video mudo, sin play/pausa/barra, aunque se
    // siguiera viendo la imagen). Con .contains() solo se dispara la
    // recuperacion cuando el video de verdad quedo afuera de mediaSlot
    // (el caso real que este bloque busca arreglar: haber caido al
    // fallback externo, que reemplaza todo con un iframe).
    if (dom.video && !dom.mediaSlot.contains(dom.video)) {
      dom.mediaSlot.replaceChildren(dom.video);
      restoreMediaSlotOverlays(dom.mediaSlot);
    }
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

  // Fuente local = reproductor propio. En televisor tiene que arrancar a
  // pantalla completa sin que el usuario toque el boton de fullscreen.
  ensureTvFullscreenForOwnPlayer();

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


/** True si el video está en fullscreen real, Plyr fullscreen, o teatro APK. */
function isPlayerFullscreen() {
  if (document.documentElement.classList.contains(TV_THEATER_CLASS)) return true;
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  if (fs) {
    if (fs.id === "mediaSlot" || fs.id === "player") return true;
    if (fs.closest?.("#mediaSlot") || fs.classList?.contains("plyr")) return true;
    if (fs === document.documentElement || fs === document.body) return true;
  }
  // Plyr marca el contenedor
  if (document.querySelector(".plyr.plyr--fullscreen-active, .plyr--fullscreen-enabled.plyr--fullscreen-active")) {
    return true;
  }
  try {
    if (state.playerUi?.fullscreen?.active) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function clearNextEpisodeCountdown() {
  if (state.nextEpisodeCountdownTimer) {
    window.clearInterval(state.nextEpisodeCountdownTimer);
    state.nextEpisodeCountdownTimer = null;
  }
  state.nextEpisodeCountdownLeft = 0;
}

function updateNextEpisodeBtnLabel(secondsLeft) {
  const btn = dom.nextEpisodeBtn;
  if (!btn) return;
  const label = btn.querySelector(".next-episode-btn-label");
  const text = secondsLeft > 0 ? `Siguiente · ${secondsLeft}s` : "Siguiente episodio";
  if (label) label.textContent = text;
  else btn.textContent = text;
}

function hideNextEpisodeOverlay() {
  clearNextEpisodeCountdown();
  if (!dom.nextEpisodeOverlay) return;
  dom.nextEpisodeOverlay.hidden = true;
  state.nextEpisodeVisible = false;
  updateNextEpisodeBtnLabel(0);
}

function startNextEpisodeCountdown() {
  clearNextEpisodeCountdown();
  state.nextEpisodeCountdownLeft = NEXT_EPISODE_COUNTDOWN_SECONDS;
  updateNextEpisodeBtnLabel(state.nextEpisodeCountdownLeft);
  state.nextEpisodeCountdownTimer = window.setInterval(() => {
    state.nextEpisodeCountdownLeft -= 1;
    if (state.nextEpisodeCountdownLeft <= 0) {
      clearNextEpisodeCountdown();
      updateNextEpisodeBtnLabel(0);
      playNextEpisode();
      return;
    }
    updateNextEpisodeBtnLabel(state.nextEpisodeCountdownLeft);
  }, 1000);
}

function showNextEpisodeOverlay() {
  if (!dom.nextEpisodeOverlay || !state.nextEpisodeTarget) return;
  // Solo en fullscreen (navegador o teatro APK). Fuera de fullscreen no se muestra.
  if (!isPlayerFullscreen()) {
    if (state.nextEpisodeVisible) hideNextEpisodeOverlay();
    return;
  }
  if (state.nextEpisodeVisible) return;
  if (dom.nextEpisodeTitle) {
    dom.nextEpisodeTitle.textContent = state.nextEpisodeTarget.title || "Siguiente episodio";
  }
  // Reinicia la barra de countdown CSS
  const ring = dom.nextEpisodeBtn?.querySelector(".next-episode-btn-ring");
  if (ring) {
    ring.style.animation = "none";
    // force reflow
    void ring.offsetWidth;
    ring.style.animation = "";
  }
  dom.nextEpisodeOverlay.hidden = false;
  state.nextEpisodeVisible = true;
  startNextEpisodeCountdown();
  dom.nextEpisodeBtn?.focus();
}

// Cuanto esperamos como maximo a que cargue el siguiente episodio antes de
// dar por perdida la transicion in-place y navegar de verdad. Sin esto, si
// discoverMediaSources/renderEpisodePlayer se cuelga (red lenta, HEAD que
// nunca responde, etc.) el reproductor queda "trabado" indefinidamente: no
// hubo reload de pagina, pero tampoco pasa nada y el usuario no puede saber
// si tocar de nuevo va a servir de algo.
const NEXT_EPISODE_TRANSITION_TIMEOUT_MS = 12000;

// Cambia de episodio sin recargar la página (usado tanto por el autoplay
// de "Siguiente episodio" como por la seleccion manual en la grilla de
// capitulos). Antes, elegir un episodio a mano hacia window.location.reload(),
// lo que explicaba el mismo sintoma reportado con el autoplay: la pagina
// "se refresca" y si estabas en fullscreen te saca. Unificar ambos casos en
// esta funcion evita duplicar el guard de reentrancia y la recuperacion de
// fullscreen.
async function transitionToEpisode(serie, seasonNumber, episodeNumber) {
  if (state.nextEpisodeTransitioning) return;
  state.nextEpisodeTransitioning = true;
  state.wasFullscreenBeforeTransition = isPlayerFullscreen();
  hideNextEpisodeOverlay();
  if (dom.nextEpisodeBtn) dom.nextEpisodeBtn.disabled = true;
  state.autoplayNextEpisode = true;
  const newUrl = buildEpisodePlayerUrl(serie, seasonNumber, episodeNumber);
  window.history.replaceState({}, "", newUrl);

  // Si venimos de fullscreen y el navegador lo cierra solo durante la
  // transicion (algunos moviles/TV lo hacen al resetear el <video> con
  // load()), lo volvemos a pedir apenas se detecte. Se limpia al terminar
  // la transicion, sea cual sea el resultado.
  const restoreFullscreenIfLost = () => {
    if (!state.wasFullscreenBeforeTransition || isPlayerFullscreen()) return;
    const target2 = dom.mediaSlot;
    const requestFs = target2 && (target2.requestFullscreen
      || target2.webkitRequestFullscreen
      || target2.mozRequestFullScreen
      || target2.msRequestFullscreen)?.bind(target2);
    if (typeof requestFs === "function") {
      Promise.resolve(requestFs()).catch(() => {
        // Puede fallar por falta de gesto reciente; el usuario siempre
        // puede volver a tocar el boton de fullscreen del propio player.
      });
    }
  };
  document.addEventListener("fullscreenchange", restoreFullscreenIfLost);
  document.addEventListener("webkitfullscreenchange", restoreFullscreenIfLost);

  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    playerConsole("warn", "[next-episode] Timeout esperando el siguiente episodio, navegando de verdad.");
    window.location.href = newUrl;
  }, NEXT_EPISODE_TRANSITION_TIMEOUT_MS);

  try {
    await renderEpisodePlayer(serie, seasonNumber, episodeNumber);
    if (timedOut) return; // ya navegamos por timeout, no seguir tocando el DOM viejo
    currentSeasonNum = seasonNumber;
    currentEpisodeNum = episodeNumber;
    if (typeof loadSeasonEpisodesGrid === "function") {
      renderSeasonDropdown(seasonNumber);
      loadSeasonEpisodesGrid(seasonNumber);
    }
    // Autoplay: no esperar gesto. Varios intentos por si el source tarda.
    const tryPlay = () => {
      const video = syncActiveVideo();
      if (!video) return;
      const p = video.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    };
    tryPlay();
    window.setTimeout(tryPlay, 400);
    window.setTimeout(tryPlay, 1200);
    ensureWebPlayerInteractable();
    window.setTimeout(ensureWebPlayerInteractable, 500);
    window.setTimeout(restoreFullscreenIfLost, 300);
  } catch (err) {
    if (timedOut) return;
    playerConsole("error", "[next-episode] No se pudo cargar, navegando:", err);
    window.location.href = newUrl;
  } finally {
    window.clearTimeout(timeoutId);
    document.removeEventListener("fullscreenchange", restoreFullscreenIfLost);
    document.removeEventListener("webkitfullscreenchange", restoreFullscreenIfLost);
    if (dom.nextEpisodeBtn) dom.nextEpisodeBtn.disabled = false;
    state.nextEpisodeTransitioning = false;
    state.wasFullscreenBeforeTransition = false;
  }
}

// Wrapper que usa el "siguiente episodio" ya calculado (overlay estilo
// Netflix / countdown / evento "ended").
function playNextEpisode() {
  const target = state.nextEpisodeTarget;
  if (!target) return;
  return transitionToEpisode(target.serie, target.seasonNumber, target.episodeNumber);
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
    // Solo en fullscreen: auto-siguiente. En ventana normal el episodio termina y listo.
    if (state.nextEpisodeTarget && isPlayerFullscreen()) {
      playNextEpisode();
    }
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
// Si se cayo al iframe externo (último recurso) no hay archivo propio
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
  dom.resumeClose?.addEventListener("click", closeResumeModal);
  document.getElementById("dismissExternalNotice")?.addEventListener("click", () => {
    if (dom.externalNotice) dom.externalNotice.hidden = true;
    document.getElementById(RETRY_LINK_ID)?.focus();
  });
  dom.tvBackBtn?.addEventListener("click", () => {
    persistCurrentProgress();
    window.location.assign(dom.backLink.href);
  });

  const onFsChange = () => {
    if (!isPlayerFullscreen() && state.nextEpisodeVisible) {
      hideNextEpisodeOverlay();
    }
  };
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);
  // Plyr emite enter/exit en el player cuando existe

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

// Flechas sobre el video desplazan; sobre botones navegan. Las teclas
// multimedia funcionan desde cualquier botón, salvo con un panel abierto.
function initRemoteSeekControls() {
  const hasOpenPanel = () => Boolean(document.querySelector(
    ".catalog-modal.is-open, .site-nav.is-open, .episode-grid-container.open, .season-dropdown-panel.open, .site-search-dropdown.is-open, .plyr__menu__container:not([hidden])",
  ));
  if (isTvDevice() && dom.mediaSlot) {
    state.tvVisibility = createControlsVisibility({
      slot: dom.mediaSlot, getVideo: getActiveVideo, getPlayer: () => state.playerUi,
      isBlocked: () => state.playbackMode !== "video" || hasOpenPanel(),
    });
    for (const type of ["pointermove", "pointerdown", "click"]) {
      dom.mediaSlot.addEventListener(type, () => {
        if (state.playbackMode === "video") state.tvVisibility.show();
      });
    }
    dom.mediaSlot.addEventListener("focusin", (event) => {
      if (event.target !== getActiveVideo() && state.playbackMode === "video") state.tvVisibility.show();
    });
  }
  const reveal = () => {
    if (state.tvVisibility) state.tvVisibility.show();
    else state.playerUi?.toggleControls?.(true);
  };
  const play = (video) => { video.play().catch(() => {}); };
  const handleKey = (event) => {
    const key = remoteKey(event);
    const active = document.activeElement;
    const overlayOpen = document.querySelector(
      ".catalog-modal.is-open, .site-nav.is-open, .episode-grid-container.open, .season-dropdown-panel.open, .site-search-dropdown.is-open, .plyr__menu__container:not([hidden])",
    );
    if (overlayOpen || active?.matches("textarea, select, input:not([type='range']), [contenteditable='true']")) return false;
    const video = syncActiveVideo();
    if (state.playbackMode !== "video" || !video?.isConnected) return false;
    const inPlayer = active === document.body || dom.mediaSlot?.contains(active);
    if (inPlayer && isTvDevice()) {
      if (["Escape", "Backspace", "BrowserBack", "GoBack"].includes(key)) return state.tvVisibility?.hide() || false;
      const wasHidden = state.tvVisibility?.isHidden();
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " ", "Spacebar"].includes(key)) {
        reveal();
        if (wasHidden && ["ArrowUp", "ArrowDown", "Enter"].includes(key)) {
          document.getElementById("tvPlayPauseBtn")?.focus();
          return true;
        }
      }
    }
    const onButton = active?.closest("button, a, [role='menuitem'], [role='menuitemradio']");
    let handled = false;
    if (key === "MediaRewind" || key === "MediaFastForward"
      || ((key === "ArrowLeft" || key === "ArrowRight") && inPlayer && !onButton)) {
      handled = seekVideo(video, (key === "ArrowRight" || key === "MediaFastForward" ? 1 : -1) * REMOTE_SEEK_STEP_SECONDS);
      const feedback = document.getElementById("tvSeekFeedback");
      if (feedback) feedback.textContent = handled
        ? `${Math.floor(video.currentTime / 60)}:${String(Math.floor(video.currentTime % 60)).padStart(2, "0")}`
        : "Espera a que el video esté listo para moverlo";
    } else if (["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop"].includes(key)
      || (inPlayer && !onButton && ["Enter", " ", "Spacebar"].includes(key))) {
      if (event.repeat) return true;
      if (key === "MediaPause" || key === "MediaStop" || (key !== "MediaPlay" && !video.paused)) video.pause();
      else play(video);
      handled = true;
    } else if (isTvDevice() && inPlayer && ["ArrowUp", "ArrowDown"].includes(key) && !onButton) {
      document.getElementById("tvPlayPauseBtn")?.focus();
      handled = true;
    }
    if (handled) reveal();
    return handled;
  };
  // Android entrega teclas multimedia que algunos WebView no convierten a DOM.
  window.ColevanaRemote = {
    handleKey: (key, repeat = false) => handleKey({ key, repeat }),
    hideControls: () => state.tvVisibility?.hide() || false,
  };
  dom.tvControls?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-tv-action]")?.dataset.tvAction;
    if (!action) return;
    event.stopPropagation();
    handleKey({ key: { rewind: "MediaRewind", forward: "MediaFastForward", play: "MediaPlayPause" }[action] });
  });
  // El elemento de video cambia al probar otra fuente: escuchar por delegación.
  for (const type of ["play", "pause", "loadedmetadata", "emptied"]) {
    document.addEventListener(type, () => {
      const video = getActiveVideo();
      const button = document.getElementById("tvPlayPauseBtn");
      if (button) button.textContent = video?.paused ? "▶ Reproducir" : "❚❚ Pausar";
      if (dom.tvControls) dom.tvControls.hidden = !isTvDevice() || state.playbackMode !== "video";
      if (state.tvVisibility && state.playbackMode === "video") reveal();
    }, true);
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (!handleKey(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

async function init() {
  ensureWebPlayerInteractable();
  if (isTvDevice() && dom.resumeOverlay) dom.mediaSlot.appendChild(dom.resumeOverlay);
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
    name: "Vimeos",
    label: "Reproduciendo (fuente alternativa)",
    match: (url) => isExternalEmbedUrl(url, VIMEOS_MIRROR_DOMAINS, /^\/(?:embed-|e\/)/),
  },
  {
    name: "HLSWish",
    label: "Reproduciendo (fuente alternativa)",
    match: (url) => isExternalEmbedUrl(url, HLSWISH_MIRROR_DOMAINS, /^\/(?:embed-|e\/)/),
    assumeMountedAfterMs: 3000,
  },
  {
    name: "GoodStream",
    label: "Reproduciendo (fuente alternativa)",
    match: (url) => isExternalEmbedUrl(url, GOODSTREAM_MIRROR_DOMAINS, /^\/(?:embed-|e\/)/),
  },
  {
    name: "Vimeus",
    label: "Reproduciendo (fuente alternativa)",
    match: (url) => isExternalEmbedUrl(url, ["vimeus.com", "www.vimeus.com"], /^\/(?:embed-|e\/)/),
  },
  {
    name: "MovieDays",
    label: "Reproduciendo (fuente alternativa)",
    match: (url) => isExternalEmbedUrl(url, ["moviedays.top", "www.moviedays.top"], /^\/.+/),
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
 * Reproduce un stream directo como reproductor natural de player.html:
 * mismo <video> + Plyr + controles (cast, progreso, etc.) que la fuente local.
 * Evita el iframe del proveedor y por tanto el preroll de JWPlayer.
 * Prioridad del sitio: 1) archivos de GitHub/release  2) este stream limpio  3) iframe.
 */

function destroyPlayerUi() {
  if (state.playerUi) {
    try {
      state.playerUi.destroy();
    } catch (_) {
      // ignore
    }
    state.playerUi = null;
  }
  // Plyr envuelve el video; al destruir puede quedar un wrapper suelto.
  document.querySelectorAll(".plyr").forEach((wrap) => {
    if (wrap.querySelector("video#player, video.plyr-video")) return;
    try {
      wrap.remove();
    } catch (_) {
      // ignore
    }
  });
}

function preferSpanishAudio(hls) {
  if (!hls || !Array.isArray(hls.audioTracks) || !hls.audioTracks.length) {
    playerConsole("info", "[hls] sin pistas de audio aún");
    return false;
  }
  const tracks = hls.audioTracks;
  console.info(
    "[hls] pistas de audio:",
    tracks.map((t, i) => ({
      i,
      name: t.name,
      lang: t.lang || t.language,
      default: t.default,
    })),
  );

  const isEs = (t) => {
    const lang = String(t.lang || t.language || "").toLowerCase().trim();
    const name = String(t.name || "").toLowerCase();
    return (
      // ISO 639-1 ("es", "es-419", "es-MX"...)
      lang === "es" || lang.startsWith("es-")
      // ISO 639-2/B ("spa"), muy comun en streams remuxeados con ffmpeg
      || lang === "spa" || lang.startsWith("spa-") || lang.startsWith("spa_")
      || /(^|[^a-z])espa[nñ]ol|spanish|latino|castellano|dual.?es(?![a-z])/.test(name)
    );
  };

  // Si hay mas de una pista y ninguna quedo identificada como ingles/otro
  // idioma reconocible, asumimos que el proveedor uso codigos no estandar
  // (p. ej. "aud1"/"aud2") y preferimos evitar tocar nada para no romper
  // el audio que el usuario ya esta escuchando.
  const isEn = (t) => {
    const lang = String(t.lang || t.language || "").toLowerCase().trim();
    const name = String(t.name || "").toLowerCase();
    return (
      lang === "en" || lang.startsWith("en-")
      || lang === "eng" || lang.startsWith("eng-") || lang.startsWith("eng_")
      || /(^|[^a-z])ingl[eé]s|english(?![a-z])/.test(name)
    );
  };

  // 1) default marcado español  2) cualquier es  3) heurística por descarte
  // 4) no tocar
  let idx = tracks.findIndex((t) => isEs(t) && (t.default === true || t.default === "yes"));
  if (idx < 0) idx = tracks.findIndex(isEs);
  if (idx < 0 && tracks.length > 1) {
    // El proveedor no etiquetó el idioma con un código/nombre reconocible
    // (pasa con algunos remuxes: "aud1"/"aud2" sin lang). Si exactamente
    // una pista es identificable como inglés, asumimos que la(s) otra(s)
    // es el doblaje y la probamos: es mejor apuesta que quedarse en inglés.
    const englishTracks = tracks.filter(isEn);
    const nonEnglish = tracks.filter((t) => !isEn(t));
    if (englishTracks.length && nonEnglish.length === 1) {
      idx = tracks.indexOf(nonEnglish[0]);
      playerConsole("info", "[hls] sin lang explicito, usando pista no-ingles por descarte");
    }
  }
  if (idx < 0) {
    console.warn(
      "[hls] no se encontró pista en español entre",
      tracks.length,
      "pista(s):",
      tracks.map((t) => t.lang || t.language || t.name || "?").join(", "),
    );
    return false;
  }
  if (hls.audioTrack !== idx) {
    console.info("[hls] forzando audio ES →", idx, tracks[idx]?.name || tracks[idx]?.lang);
    try {
      hls.audioTrack = idx;
    } catch (e) {
      playerConsole("warn", "[hls] no se pudo setear audioTrack", e);
      return false;
    }
  }
  return true;
}

const AUDIO_SELECTOR_ID = "playerAudioTrackSelector";

function removeAudioTrackSelector() {
  document.getElementById(AUDIO_SELECTOR_ID)?.remove();
}

// Selector manual de pista de audio: se muestra apenas hls.js reporta 2+
// pistas. UI pensada para web y APK/TV (botones enfocables con D-pad).
function showAudioTrackSelector(hls) {
  if (!hls || !Array.isArray(hls.audioTracks) || hls.audioTracks.length < 2) {
    removeAudioTrackSelector();
    return;
  }
  const tracks = hls.audioTracks;

  const existing = document.getElementById(AUDIO_SELECTOR_ID);
  const wrap = existing || document.createElement("div");
  wrap.id = AUDIO_SELECTOR_ID;
  wrap.className = "player-audio-tracks";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Pista de audio");
  wrap.innerHTML = "";

  const labelSpan = document.createElement("span");
  labelSpan.className = "player-audio-tracks-label";
  labelSpan.textContent = "Audio";
  wrap.appendChild(labelSpan);

  tracks.forEach((t, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player-audio-track-btn" + (hls.audioTrack === i ? " is-active" : "");
    const rawLabel = t.name || t.lang || t.language || `Pista ${i + 1}`;
    btn.textContent = rawLabel;
    btn.setAttribute("aria-pressed", hls.audioTrack === i ? "true" : "false");
    btn.addEventListener("click", () => {
      if (hls.audioTrack === i) return;
      try {
        hls.audioTrack = i;
        console.info("[hls] audio elegido manualmente →", i, rawLabel);
      } catch (e) {
        playerConsole("warn", "[hls] no se pudo cambiar audioTrack manualmente", e);
      }
      showAudioTrackSelector(hls);
    });
    wrap.appendChild(btn);
  });

  if (!existing) {
    // Debajo del status en web; en APK/TV el CSS lo posiciona sobre el video.
    const anchor = dom.status?.parentElement || document.querySelector(".theater") || document.body;
    if (dom.status?.nextSibling) {
      dom.status.parentElement.insertBefore(wrap, dom.status.nextSibling);
    } else {
      anchor.appendChild(wrap);
    }
  }
}

async function mountDirectStream(container, streamUrl) {
  stopExternalTracking();
  removeAudioTrackSelector();
  if (state._hls) {
    try { state._hls.destroy(); } catch (_) {}
    state._hls = null;
  }
  destroyPlayerUi();

  state.suppressVideoErrorUi = true;
  state.playbackMode = "video";
  state.currentBaseSrc = streamUrl;
  state.currentOriginalSrc = streamUrl;
  // Deteccion de HLS tolerante: basta con que ".m3u8" aparezca en la URL
  // (proxies, embeds con query extra, etc.).
  const looksLikeHls = /\.m3u8/i.test(streamUrl);
  console.info(
    "[direct-stream] montando como reproductor natural:",
    streamUrl,
    "→",
    looksLikeHls ? "HLS (hls.js)" : "video directo (mp4/nativo)",
  );
  state.availableSources = [{
    src: streamUrl,
    type: looksLikeHls ? "application/x-mpegURL" : "video/mp4",
    size: 1080,
  }];
  state.currentQuality = 1080;

  // Mismo <video> que el reproductor natural de player.html (Plyr lo envuelve).
  const video = document.createElement("video");
  video.id = "player";
  video.className = "plyr-video";
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.preload = "metadata";
  // Sin controls nativos: Plyr aporta la UI (igual que fuente local de GitHub).
  video.controls = false;

  // No forzar estilos de iframe: #mediaSlot mantiene el layout del teatro natural.
  container.removeAttribute("style");
  container.replaceChildren(video);
  restoreMediaSlotOverlays(container);

  dom.video = video;
  hideAdblockHint();
  resetCastButton();
  resetDownloadButton();

  if (looksLikeHls) {
    try {
      const Hls = await loadHlsScript();
      if (Hls?.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 1,
        });
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        state._hls = hls;
        // result: true = ok, false = fallo genérico, "cdn403" = CDN bloquea IP del Worker
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
          hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
            preferSpanishAudio(hls);
            showAudioTrackSelector(hls);
          });
          hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
            console.info("[hls] audio switched →", data);
            showAudioTrackSelector(hls);
          });
          hls.on(Hls.Events.ERROR, (_, data) => {
            const code = data?.response?.code;
            playerConsole("warn", "[hls] error", data?.type, data?.details, code);
            if (code === 403 && isProxyHlsCdnBlockedUrl(streamUrl)) {
              done("cdn403");
              return;
            }
            if (data?.fatal || code === 403 || code === 404 || code === 401) {
              done(false);
            }
          });
        });
        if (okPlayback === "cdn403") {
          try { hls.destroy(); } catch (_) {}
          state._hls = null;
          throw new Error("hls_forbidden_by_cdn");
        }
        if (!okPlayback) {
          try { hls.destroy(); } catch (_) {}
          state._hls = null;
          throw new Error("hls_playback_failed");
        }
        preferSpanishAudio(hls);
        showAudioTrackSelector(hls);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
        const okNative = await new Promise((resolve) => {
          const t = window.setTimeout(() => resolve(false), 8000);
          const onOk = () => { window.clearTimeout(t); resolve(true); };
          const onErr = () => { window.clearTimeout(t); resolve(false); };
          video.addEventListener("loadeddata", onOk, { once: true });
          video.addEventListener("canplay", onOk, { once: true });
          video.addEventListener("error", onErr, { once: true });
        });
        if (!okNative) throw new Error("hls_native_failed");
      } else {
        throw new Error("hls_unsupported");
      }
    } catch (e) {
      playerConsole("warn", "[direct-stream] HLS fallo:", e);
      throw e;
    }
  } else {
    video.src = streamUrl;
    const okMp4 = await new Promise((resolve) => {
      const t = window.setTimeout(() => resolve(false), 8000);
      const onOk = () => { window.clearTimeout(t); resolve(true); };
      const onErr = () => { window.clearTimeout(t); resolve(false); };
      video.addEventListener("loadeddata", onOk, { once: true });
      video.addEventListener("canplay", onOk, { once: true });
      video.addEventListener("error", onErr, { once: true });
    });
    if (!okMp4) throw new Error("mp4_playback_failed");
  }

  // UI natural de player.html / APK: mismo Plyr, controles, cast y progreso.
  mountPlayerUi({}, 1080, [1080]);
  bindVideoEvents(syncActiveVideo());
  bindCastButtonForActiveVideo();
  bindDownloadButtonForActiveVideo();
  renderQualityControls(state.availableSources);

  // TV: teatro a pantalla completa sin gesto (misma ruta que fuente local).
  // Este camino SIEMPRE usa el reproductor propio, asi que ademas pedimos
  // el fullscreen real.
  ensureTvFullscreenForOwnPlayer();

  try {
    await (syncActiveVideo() || video).play();
  } catch {
    // Autoplay bloqueado en web: el usuario usa Plyr. En APK MainActivity
    // suele permitir play sin gesto.
  }

  if (dom.status) {
    const title = state.currentContentTitle;
    dom.status.textContent = title ? `Reproduciendo: ${title}` : "Reproduciendo";
    dom.status.style.color = "";
  }

  // No mostrar "probar otra fuente" si el natural ya reproduce bien.
  removeExternalRetryLink();
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

/**
 * True si la URL apunta a /proxy-hls de un CDN que bloquea IPs de datacenter
 * (vimeos / goodstream / hlswish). Ante el primer 403 no vale reintentar mirrors.
 */
function isProxyHlsCdnBlockedUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    // Puede venir como URL del Worker: .../proxy-hls?url=<encoded>
    if (url.includes("/proxy-hls")) {
      const u = new URL(url, window.location.origin);
      const target = u.searchParams.get("url") || "";
      return /vimeos|goodstream|hlswish/i.test(target || url);
    }
    // O la URL cruda del CDN
    return /vimeos|goodstream|hlswish/i.test(url);
  } catch {
    return /vimeos|goodstream|hlswish/i.test(url);
  }
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
    const isMovieDaysLink = /^https:\/\/(?:www\.)?moviedays\.top\//i.test(embedUrl);
    const timer = window.setTimeout(() => controller.abort(), isMovieDaysLink ? 18000 : 15000);
    try {
      const res = await fetch(endpoint, { signal: controller.signal });
      if (!res.ok) {
        playerConsole("warn", "[resolve-stream] HTTP", res.status);
        return null;
      }
      const data = await res.json();
      const rawStreams = [...new Set([...(Array.isArray(data?.streams) ? data.streams : []), data?.stream].filter((url) => typeof url === "string" && /^https:\/\//i.test(url)))];
      const rawStream = rawStreams[0] || null;
      if (!rawStream || !/^https:\/\//i.test(rawStream)) {
        if (data?.proxied) return viaHlsProxy(data.proxied, embedUrl);
        return null;
      }
      // El MP4 de MovieDays se sirve directamente desde su CDN. /proxy-hls
      // está diseñado para manifiestos HLS y no debe envolver archivos MP4.
      // Mirrors: primero URL directa (IP del usuario + CORS *),
      // después la misma vía proxy-hls (por si el directo falla).
      const candidates = [];
      for (const stream of rawStreams) {
        if (/\.(mp4|webm)$/i.test(new URL(stream).pathname)) {
          candidates.push(stream);
          continue;
        }
        for (const u of expandStreamMirrors(stream)) {
        candidates.push(u);
        const proxied = viaHlsProxy(u, embedUrl);
        if (proxied && proxied !== u) candidates.push(proxied);
        }
      }
      playerConsole(
        "info",
        "[resolve-stream] candidatos (directo→proxy):",
        candidates.length,
        candidates[0],
      );
      return [...new Set(candidates)];
    } finally {
      window.clearTimeout(timer);
    }
  } catch (e) {
    playerConsole("warn", "[resolve-stream] fallo:", e);
    return null;
  }
}

// Conserva las URLs distintas de cada proveedor en orden de preferencia.
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
      for (const key of ["url", "embed_url", "embed", "iframe"]) {
        const url = typeof obj[key] === "string" ? externalEmbedUrl(obj[key]) : null;
        if (url && !EXTERNAL_PROVIDERS.some((p) => p.match(url))) unmatchedEmbeds.push(url);
      }
      Object.values(obj).forEach(walk);
    }
  }
  walk(data);

  const seen = new Set();
  const candidates = [];
  for (const provider of EXTERNAL_PROVIDERS) {
    for (const item of found) {
      if (item.provider !== provider || seen.has(item.url)) continue;
      seen.add(item.url);
      candidates.push(item);
    }
  }
  playerConsole("info", "[external-player] candidatos reconocidos:", candidates.map((item) => ({
    provider: item.provider.name,
    url: item.url,
  })));
  if (unmatchedEmbeds.length) {
    for (const url of unmatchedEmbeds) {
      if (seen.has(url)) continue;
      const candidate = mapMovieDaysEmbedToCandidate(url);
      if (candidate) { seen.add(url); candidates.push(candidate); }
    }
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
    state.tvVisibility?.destroy();
    container.classList.remove("tv-controls-hidden");
    stopExternalTracking();
    destroyPlayerUi();
    if (dom.mobileQuickControls) dom.mobileQuickControls.hidden = true;
    if (dom.tvControls) dom.tvControls.hidden = true;
    if (state._hls) {
      try { state._hls.destroy(); } catch (_) {}
      state._hls = null;
    }

    // El iframe es position:absolute; el slot necesita altura propia
    // (padding 16:9). Si antes se montó stream limpio y se limpiaron los
    // estilos inline, sin esto el frame queda colapsado (barra negra fina).
    container.style.cssText =
      "background:#000;position:relative;padding-top:56.25%;overflow:hidden;border-radius:8px;";

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
    iframe.title = `Reproductor externo de ${candidate.provider.name}`;
    iframe.tabIndex = 0;
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-presentation allow-forms",
    );
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);

    resetCastButton();
    resetDownloadButton();
    container.replaceChildren(iframe);
    restoreMediaSlotOverlays(container);
  });
}

const RETRY_LINK_ID = "playerExternalRetryLink";
const ADBLOCK_HINT_ID = "adblockHint";

function showAdblockHint() {
  const el = document.getElementById(ADBLOCK_HINT_ID);
  if (el) { el.hidden = false; el.textContent = EXTERNAL_AD_NOTICE; }
  if (dom.externalNotice) {
    dom.externalNotice.querySelector("p").textContent = EXTERNAL_AD_NOTICE;
    dom.externalNotice.hidden = false;
  }
}

function hideAdblockHint() {
  const el = document.getElementById(ADBLOCK_HINT_ID);
  if (el) el.hidden = true;
  if (dom.externalNotice) dom.externalNotice.hidden = true;
}

/**
 * Overlay de "Buscando fuente alternativa..." sobre #mediaSlot.
 *
 * Antes, mientras tryHlsWishFallback() bajaba el HTML del embed, le
 * resolvia el m3u8 limpio y probaba proveedores, la unica señal era el
 * texto chico de #playerStatus debajo del reproductor: la caja de video
 * quedaba negra y sin nada, como si se hubiera trabado. Se muestra al
 * entrar a ese camino y se oculta apenas hay algo que mostrar (un stream
 * propio montado, un iframe cargado) o cuando ya no queda nada mas para
 * probar (el mensaje final / enlace de reintento se encargan de ahi).
 */
function showExternalLoadingOverlay(text) {
  if (!dom.externalLoadingOverlay) return;
  if (text && dom.externalLoadingText) dom.externalLoadingText.textContent = text;
  dom.externalLoadingOverlay.hidden = false;
}

function hideExternalLoadingOverlay() {
  if (dom.externalLoadingOverlay) dom.externalLoadingOverlay.hidden = true;
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
  const link = document.createElement("button");
  link.id = RETRY_LINK_ID;
  link.type = "button";
  link.className = "player-native-link";
  link.textContent = label;
  link.style.cssText = "display:inline-block;margin-top:8px;cursor:pointer;";
  link.addEventListener("click", async () => {
    removeExternalRetryLink();
    try {
      await onRetry();
    } catch (error) {
      playerConsole("warn", "[external-player] acción fallida:", error);
      dom.status.textContent = "No se pudo cargar la fuente. Inténtalo de nuevo.";
      showExternalRetryLink(label, onRetry);
    }
  });
  if (isTvScreen()) dom.mediaSlot.appendChild(link);
  else dom.status.insertAdjacentElement("afterend", link);
}

function showUnavailablePlayerMessage(message) {
  state.tvVisibility?.destroy();
  dom.mediaSlot.classList.remove("tv-controls-hidden");
  stopExternalTracking();
  if (dom.mobileQuickControls) dom.mobileQuickControls.hidden = true;
  if (dom.tvControls) dom.tvControls.hidden = true;
  const panel = document.createElement("div");
  panel.className = "player-source-message";
  panel.textContent = message;
  dom.mediaSlot.style.cssText = "background:#000;position:relative;padding-top:56.25%;overflow:hidden;border-radius:8px;";
  dom.mediaSlot.replaceChildren(panel);
  restoreMediaSlotOverlays(dom.mediaSlot);
}

// ==================== MOVIEDAYS FALLBACK ====================
// Plan B cuando vimeus.com no responde nada util (caido, sin fuentes para
// ese titulo, listing vacio). MovieDays devuelve el mismo tipo de embeds
// (Vimeus/GoodStream/etc.) detras de una API key privada que vive solo en
// el Worker (env.MOVIEDAYS_API_KEY) — el cliente nunca la ve, solo pide
// por tmdb/type/se/ep. Se usa unicamente cuando vimeus.com falla o no
// devuelve nada, para no gastar cuota de MovieDays de mas.

// Los embeds que devuelve MovieDays son, en la practica, los mismos
// dominios que ya reconoce EXTERNAL_PROVIDERS (Vimeos, HLSWish,
// GoodStream). Este proveedor generico es solo una red de seguridad por si
// devuelven un host nuevo que aun no esta en esa lista: mejor intentar
// montarlo igual que descartarlo en silencio.
const MOVIEDAYS_GENERIC_PROVIDER = {
  name: "MovieDays",
  label: "Reproduciendo (fuente alternativa)",
  match: () => true,
};

function mapMovieDaysEmbedToCandidate(embedUrl) {
  let url;
  try {
    url = new URL(embedUrl);
    if (url.protocol !== "https:" || url.username || url.password) return null;
  } catch {
    return null;
  }
  const known = EXTERNAL_PROVIDERS.find((p) => p.match(embedUrl));
  return {
    provider: known || { ...MOVIEDAYS_GENERIC_PROVIDER, name: url.hostname.replace(/^www\./, "") },
    url: embedUrl,
    iframeEligible: true,
    resolveClean: Boolean(known),
  };
}

function buildMovieDaysFallbackUrl(embedInfo) {
  const proxyBase = (MEDIA_CONFIG?.proxyBaseUrl || "").replace(/\/+$/, "");
  if (!proxyBase) return null;
  const params = new URLSearchParams();
  params.set("tmdb", embedInfo.tmdbId);
  if (embedInfo.kind === "episode") {
    params.set("type", "serie");
    params.set("se", embedInfo.season);
    params.set("ep", embedInfo.episode);
  } else {
    params.set("type", "movie");
  }
  return `${proxyBase}/moviedays-fallback?${params.toString()}`;
}

async function fetchSourceListing(url, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    // Consumir el cuerpo dentro del plazo: algunos proveedores envían cabeceras
    // y luego dejan la descarga pendiente indefinidamente.
    const body = await response.text();
    return { ok: response.ok, status: response.status, text: async () => body, json: async () => JSON.parse(body) };
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchMovieDaysCandidates(embedInfo) {
  const url = buildMovieDaysFallbackUrl(embedInfo);
  if (!url) return [];
  try {
    const response = await fetchSourceListing(url, 15000);
    if (!response.ok) {
      playerConsole("warn", "[moviedays-fallback] respuesta no ok:", response.status);
      return [];
    }
    const data = await response.json();
    if (!data?.success || !Array.isArray(data.embeds) || !data.embeds.length) return [];
    const candidates = mergeProviderCandidates(data.embeds
      .filter((item) => typeof item?.embed_url === "string")
      .map((item) => mapMovieDaysEmbedToCandidate(item.embed_url))
      .filter(Boolean));
    playerConsole(
      "info",
      "[moviedays-fallback] candidatos:",
      candidates.map((c) => ({ provider: c.provider.name, url: c.url })),
    );
    return candidates;
  } catch (e) {
    playerConsole("warn", "[moviedays-fallback] fallo:", e);
    return [];
  }
}

async function fetchExternalCandidates(embedInfo) {
  const independentCandidates = buildProviderCandidates(embedInfo);
  let movieDaysSearched = false;
  try {
    const targetUrl = buildExternalListingUrl(embedInfo);
    // fetch directo a vimeus.com es bloqueado por CORS (el proveedor no
    // manda Access-Control-Allow-Origin para colevana.com). Se pasa por el
    // Worker (/listing), que hace el fetch server-to-server sin CORS y
    // reenvia el HTML con los headers correctos.
    const proxyBase = (MEDIA_CONFIG?.proxyBaseUrl || "").replace(/\/+$/, "");
    const url = proxyBase ? `${proxyBase}/listing?url=${encodeURIComponent(targetUrl)}` : targetUrl;
    const response = await fetchSourceListing(url, 18000);
    if (!response.ok) throw new Error(`listing_${response.status}`);
    const html = await response.text();

    const doc = new DOMParser().parseFromString(html, "text/html");
    const script = doc.querySelector("#data");
    if (!script) throw new Error("No data");

    const data = JSON.parse(script.textContent);
    const directStreams = collectDirectStreams(data);
    const embedCandidates = collectExternalCandidates(data);
    playerConsole("info", "[external-player] streams directos:", directStreams);

    if (!directStreams.length && !embedCandidates.length) {
      movieDaysSearched = true;
      playerConsole("info", "[external-player] vimeus.com sin fuentes, probando MovieDays...");
      const moviedaysCandidates = await fetchMovieDaysCandidates(embedInfo);
      if (moviedaysCandidates.length) {
        return { directStreams: [], embedCandidates: mergeProviderCandidates(moviedaysCandidates, independentCandidates), movieDaysSearched };
      }
    }

    return { directStreams, embedCandidates: mergeProviderCandidates(embedCandidates, independentCandidates), movieDaysSearched };
  } catch (e) {
    playerConsole("error", "Error obteniendo candidatos externos (vimeus.com):", e);
    playerConsole("info", "[external-player] vimeus.com fallo, probando MovieDays...");
    const moviedaysCandidates = await fetchMovieDaysCandidates(embedInfo);
    return { directStreams: [], embedCandidates: mergeProviderCandidates(moviedaysCandidates, independentCandidates), movieDaysSearched: true };
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
  showExternalLoadingOverlay("Buscando una fuente alternativa…");

  try {
  const embedInfo = await getExternalEmbedInfo();
  if (!embedInfo) {
    if (showMessage) dom.status.textContent = "No se encontró fuente alternativa.";
    showUnavailablePlayerMessage("No se encontró una fuente para este título.");
    showExternalRetryLink("Buscar fuentes de nuevo", async () => {
      await tryHlsWishFallback(true);
    });
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
  removeAudioTrackSelector();
  if (state._hls) {
    try { state._hls.destroy(); } catch (_) {}
    state._hls = null;
  }

  let { directStreams, embedCandidates, movieDaysSearched = false } = await fetchExternalCandidates(embedInfo);
  const externalCandidates = embedCandidates.filter((candidate) => candidate.iframeEligible !== false);
  let streamIndex = 0;
  let cleanIndex = 0;
  let embedIndex = 0;
  let secondarySearchDone = movieDaysSearched;

  const tryNextExternal = async () => {
    while (embedIndex < externalCandidates.length) {
      const candidate = externalCandidates[embedIndex++];
      if (showMessage) {
        dom.status.textContent = `Probando ${embedIndex} de ${externalCandidates.length}: ${candidate.provider.name}…`;
        dom.status.style.color = "#e8c468";
      }
      // load confirma solo la carga del documento, no la reproducción.
      if (!(await mountExternalCandidate(container, candidate))) continue;

      bindExternalPlaybackTracking(state.currentProgressKey);
      setTimeout(offerSavedProgress, 800);
      if (showMessage) dom.status.textContent = `Reproductor externo: ${candidate.provider.name}`;
      showAdblockHint();
      showExternalRetryLink("¿No reproduce? Probar otro proveedor", async () => {
        showExternalLoadingOverlay("Probando otro proveedor…");
        try {
          await tryNextExternal();
        } finally {
          hideExternalLoadingOverlay();
        }
      });
      return true;
    }

    hideAdblockHint();
    showUnavailablePlayerMessage("No respondió ningún reproductor externo.");
    if (showMessage) dom.status.textContent = "No se pudo cargar ningún reproductor externo.";
    showExternalRetryLink("Buscar fuentes de nuevo", async () => {
      await tryHlsWishFallback(true);
    });
    return false;
  };

  // Priorizar videos directos; si fallan, abrir automáticamente el proveedor.
  const tryNextCandidate = async () => {
    while (streamIndex < directStreams.length) {
      const streamUrl = directStreams[streamIndex];
      streamIndex += 1;
      playerConsole("info", "[player] stream directo:", streamUrl);
      if (showMessage) {
        dom.status.textContent = "Cargando reproductor...";
        dom.status.style.color = "";
      }
      const directCandidates = [streamUrl];
      const proxiedDirect = viaHlsProxy(streamUrl);
      if (proxiedDirect && proxiedDirect !== streamUrl) directCandidates.push(proxiedDirect);

      for (const candidateUrl of directCandidates) {
        playerConsole("info", "[player] probando stream directo:", candidateUrl.slice(0, 120));
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await mountDirectStream(container, candidateUrl);
          if (ok) {
            removeExternalRetryLink();
            hideAdblockHint();
            return true;
          }
        } catch (e) {
          playerConsole("warn", "[direct-stream] fallo:", e?.message || e);
          if (e?.message === "hls_forbidden_by_cdn") {
            // Pasar a la siguiente fuente; puede usar otro CDN.
            break;
          }
        }
      }
    }

    if (cleanIndex >= embedCandidates.length) {
      // Buscar también en MovieDays cuando el listado existe pero sus videos fallan.
      if (!secondarySearchDone) {
        secondarySearchDone = true;
        showExternalLoadingOverlay("Buscando en más proveedores…");
        const extra = await fetchMovieDaysCandidates(embedInfo);
        const seen = new Set(embedCandidates.map((item) => item.url));
        const fresh = extra.filter((item) => !seen.has(item.url) && seen.add(item.url));
        embedCandidates.push(...fresh);
        externalCandidates.push(...fresh.filter((item) => item.iframeEligible !== false));
        if (fresh.length) return tryNextCandidate();
      }
      if (externalCandidates.length) {
        showExternalLoadingOverlay("Cargando reproductor externo…");
        return await tryNextExternal();
      }
      const unavailableMessage = "No hay una fuente disponible para este título.";
      showUnavailablePlayerMessage(unavailableMessage);
      if (showMessage) {
        dom.status.textContent = unavailableMessage;
        dom.status.style.color = "#e8c468";
      }
      hideAdblockHint();
      showExternalRetryLink("Reintentar búsqueda de fuentes", async () => {
        await tryHlsWishFallback(true);
      });
      return false;
    }

    const candidate = embedCandidates[cleanIndex++];
    playerConsole("info", "[player] resolviendo embed:", candidate.provider.name, candidate.url);
    if (showMessage) {
      dom.status.textContent = "Cargando reproductor...";
      dom.status.style.color = "";
    }

    // eslint-disable-next-line no-await-in-loop
    const resolved = candidate.resolveClean === false ? null : await resolveEmbedStream(candidate.url);
    const cleanList = Array.isArray(resolved) ? resolved : (resolved ? [resolved] : []);
    for (const cleanStream of cleanList) {
      const viaProxy = /\/proxy-hls\?/i.test(cleanStream);
      playerConsole(
        "info",
        "[player] stream resuelto:",
        viaProxy ? "proxy" : "directo",
        cleanStream.slice(0, 140),
      );
      try {
        // eslint-disable-next-line no-await-in-loop
        const okDirect = await mountDirectStream(container, cleanStream);
        if (okDirect) {
          removeExternalRetryLink();
          hideAdblockHint();
          return true;
        }
      } catch (e) {
        playerConsole("warn", "[direct-stream] fallo:", e?.message || e);
        // Primer 403 de vimeos/goodstream/hlswish vía Worker → no probar más mirrors
        if (e?.message === "hls_forbidden_by_cdn") {
          playerConsole("info", "[player] CDN bloquea Worker; mirrors inútiles");
          break;
        }
      }
    }

    if (showMessage) dom.status.textContent = "Buscando otro stream limpio…";
    return tryNextCandidate();
  };

  return await tryNextCandidate();
  } finally {
    hideExternalLoadingOverlay();
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
    const item = document.createElement("button");
    item.type = "button";
    const isSelected = season.season === selectedSeasonNum;
    item.className = `season-dropdown-option${isSelected ? " selected" : ""}`;
    item.textContent = `Temporada ${season.season}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
    item.onclick = () => {
      closeSeasonDropdown();
      renderSeasonDropdown(season.season);
      loadSeasonEpisodesGrid(season.season);
      document.getElementById("seasonSelectTrigger")?.focus();
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

    const row = document.createElement("button");
    row.type = "button";
    row.className = `ep-row${isCurrent ? " current" : ""}`;
    row.innerHTML = `
      <div class="ep-row-left">
        <span class="ep-row-code">${seasonNum}×${epNum}</span>
        <span class="ep-row-title"></span>
        <span class="ep-row-description"></span>
      </div>
      <div class="ep-row-right">
        <span class="ep-row-meta">${metaText}</span>
      </div>
    `;

    row.querySelector(".ep-row-title").textContent = episode.title || `Episodio ${epNum}`;
    row.querySelector(".ep-row-description").textContent = episode.description || "Sinopsis no disponible todavía.";

    row.onclick = () => {
      // Antes esto hacia window.location.reload(): recargaba toda la
      // pagina para cambiar de capitulo, lo que sacaba al usuario de
      // fullscreen. Ahora usa la misma transicion in-place que "Siguiente
      // episodio", sin refrescar nada.
      transitionToEpisode(currentSeries, seasonNum, epNum);
      const container = document.getElementById("episodeGridContainer");
      const toggleBtn = document.getElementById("toggleEpisodeBtn");
      container?.classList.remove("open");
      toggleBtn?.classList.remove("is-hidden");
      toggleBtn?.focus();
    };

    grid.appendChild(row);
  });
  if (document.getElementById("episodeGridContainer")?.classList.contains("open")) {
    grid.querySelector(".ep-row")?.focus();
  }
}

// Inicializar eventos del grid
function initEpisodeGrid() {
  const toggleBtn = document.getElementById("toggleEpisodeBtn");
  const container = document.getElementById("episodeGridContainer");
  const closeBtn = document.getElementById("closeGridBtn");

  const openPanel = () => {
    container.classList.add("open");
    toggleBtn.classList.add("is-hidden");
    (container.querySelector(".ep-row") || closeBtn).focus();
  };

  const closePanel = () => {
    container.classList.remove("open");
    toggleBtn.classList.remove("is-hidden");
    closeSeasonDropdown();
    toggleBtn.focus();
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
