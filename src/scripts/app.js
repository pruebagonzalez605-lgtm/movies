import { MOVIES } from "./data/movies.js";
import { SERIES } from "./data/series.js";
import {
  tmdbSearchMoviePoster,
  tmdbSearchTvPoster,
  tmdbFindTvId,
  tmdbGetSeasonEpisodes,
} from "./services/tmdb.js";

const SUPABASE_URL = "https://iqmxbmodzdtjdfepggae.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_w2GCzCqZJcYMHi8yyCN23Q_IthBqvhF";
const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;

const KICK_CLIENT_ID = "01KX013P9HAMCVKK0JHVJP53QV";
const KICK_REDIRECT_URI = "https://iqmxbmodzdtjdfepggae.supabase.co/functions/v1/kick-oauth-callback";
const KICK_AUTHORIZE_URL = "https://id.kick.com/oauth/authorize";
const KICK_SESSION_KEY = "kick_session";
const currentPage = document.body.dataset.page || "movies";

const dom = {
  player: document.getElementById("player"),
  playerSource: document.getElementById("playerSource"),
  carousel: document.getElementById("carousel"),
  seriesCarousel: document.getElementById("seriesCarousel"),
  seasonSelector: document.getElementById("seasonSelector"),
  episodeCarousel: document.getElementById("episodeCarousel"),
  sagaCarousel: document.getElementById("sagaCarousel"),
  sagaMoviesLabel: document.getElementById("sagaMoviesLabel"),
  sagaMoviesCarousel: document.getElementById("sagaMoviesCarousel"),
  titleDisplay: document.getElementById("titleDisplay"),
  status: document.getElementById("status"),
  moviesSection: document.getElementById("moviesSection"),
  seriesSection: document.getElementById("seriesSection"),
  sagasSection: document.getElementById("sagasSection"),
  sugerenciasSection: document.getElementById("sugerenciasSection"),
  tabs: document.getElementById("tabs"),
  kickGateError: document.getElementById("kickGateError"),
  kickLoginBtn: document.getElementById("kickLoginBtn"),
  kickUserBadge: document.getElementById("kickUserBadge"),
  kickUserAvatar: document.getElementById("kickUserAvatar"),
  kickUserName: document.getElementById("kickUserName"),
  kickLogoutBtn: document.getElementById("kickLogoutBtn"),
  globalStarsEl: document.getElementById("globalStars"),
  ratingGlobalText: document.getElementById("ratingGlobalText"),
  ratingUserBlock: document.getElementById("ratingUserBlock"),
  userStarsEl: document.getElementById("userStars"),
  ratingLoginHint: document.getElementById("ratingLoginHint"),
  suggestionForm: document.getElementById("suggestionForm"),
  suggestionLoginHint: document.getElementById("suggestionLoginHint"),
  suggestionInput: document.getElementById("suggestionInput"),
  suggestionSubmitBtn: document.getElementById("suggestionSubmitBtn"),
  suggestionList: document.getElementById("suggestionList"),
};

const state = {
  currentContentKey: null,
  currentContentTitle: null,
  currentSeriesIndex: null,
  currentSeasonIndex: 0,
  movieOrder: MOVIES.map((_, index) => index),
  watchdogInterval: null,
  watchdogLastTime: 0,
  watchdogStallCount: 0,
  isRecovering: false,
  lastProgressSave: 0,
};

function supabaseHeaders(extra) {
  return Object.assign(
    {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    extra || {},
  );
}

function slugify(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

function renderStarRow(container, value, interactive) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.toggle("interactive", Boolean(interactive));
  for (let i = 0; i < 5; i += 1) {
    const star = document.createElement("span");
    const frac = Math.max(0, Math.min(1, (value || 0) - i));
    star.className = "star";
    star.innerHTML = `<span class="star-bg">★</span><span class="star-fill" style="width:${frac * 100}%">★</span>`;
    container.appendChild(star);
  }
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUrlSafeString(byteLength = 64) {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return base64UrlEncodeBytes(arr);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function startKickLogin() {
  dom.kickLoginBtn.disabled = true;
  dom.kickLoginBtn.textContent = "Redirigiendo...";
  try {
    const stateToken = randomUrlSafeString();
    const codeChallenge = await sha256Base64Url(stateToken);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: KICK_CLIENT_ID,
      redirect_uri: KICK_REDIRECT_URI,
      scope: "user:read",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: stateToken,
    });
    window.location.href = `${KICK_AUTHORIZE_URL}?${params.toString()}`;
  } catch {
    dom.kickLoginBtn.disabled = false;
    dom.kickLoginBtn.textContent = "Ingresar con Kick";
    dom.kickGateError.textContent = "No se pudo iniciar el login. Proba de nuevo.";
    dom.kickGateError.style.display = "block";
  }
}

function decodeSessionToken(token) {
  try {
    const payloadPart = token.split(".")[0];
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized);
    const percentEncoded = binary
      .split("")
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    return JSON.parse(decodeURIComponent(percentEncoded));
  } catch {
    return null;
  }
}

function getKickSession() {
  try {
    const raw = localStorage.getItem(KICK_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (!session || !session.exp || Date.now() / 1000 > session.exp) {
      localStorage.removeItem(KICK_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function showKickGate(errorMsg) {
  dom.kickLoginBtn.style.display = "inline-block";
  dom.kickUserBadge.style.display = "none";
  dom.kickLoginBtn.disabled = false;
  dom.kickLoginBtn.textContent = "Ingresar con Kick";
  if (errorMsg) {
    dom.kickGateError.textContent = errorMsg;
    dom.kickGateError.style.display = "block";
  } else {
    dom.kickGateError.style.display = "none";
  }
}

function applyKickSession(session) {
  dom.kickLoginBtn.style.display = "none";
  dom.kickUserBadge.style.display = "flex";
  dom.kickUserName.textContent = session.username || "Usuario de Kick";
  if (session.avatar) {
    dom.kickUserAvatar.style.backgroundImage = `url('${session.avatar}')`;
    dom.kickUserAvatar.style.display = "block";
  } else {
    dom.kickUserAvatar.style.display = "none";
  }
  refreshAuthDependentUI();
}

function logoutKick() {
  localStorage.removeItem(KICK_SESSION_KEY);
  showKickGate();
  refreshAuthDependentUI();
}

function refreshAuthDependentUI() {
  const session = getKickSession();
  if (dom.suggestionForm && dom.suggestionLoginHint) {
    dom.suggestionForm.style.display = session ? "flex" : "none";
    dom.suggestionLoginHint.style.display = session ? "none" : "block";
  }
  if (state.currentContentKey) loadRatingsFor(state.currentContentKey);
}

function consumeAuthRedirect() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return { handled: false };
  const hashParams = new URLSearchParams(hash.slice(1));
  const token = hashParams.get("session");
  const error = hashParams.get("error");
  if (!token && !error) return { handled: false };
  history.replaceState(null, "", window.location.pathname + window.location.search);
  if (error) return { handled: true, error };
  const payload = decodeSessionToken(token);
  if (!payload) return { handled: true, error: "invalid_token" };
  localStorage.setItem(KICK_SESSION_KEY, JSON.stringify(payload));
  return { handled: true, session: payload };
}

async function loadRatingsFor(contentKey) {
  if (!contentKey) return;
  dom.ratingGlobalText.textContent = "Cargando...";
  renderStarRow(dom.globalStarsEl, 0, false);
  try {
    const url = `${SUPABASE_REST}/ratings?content_key=eq.${encodeURIComponent(contentKey)}&select=rating,kick_username`;
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("fetch_failed");
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("bad_response");

    const count = rows.length;
    const avg = count ? rows.reduce((sum, row) => sum + Number(row.rating), 0) / count : 0;
    renderStarRow(dom.globalStarsEl, avg, false);
    dom.ratingGlobalText.textContent = count
      ? `${avg.toFixed(1)} ★ (${count}${count === 1 ? " voto" : " votos"})`
      : "Sin calificaciones aun. Se el primero en calificar.";

    const session = getKickSession();
    if (session) {
      const mine = rows.find((row) => row.kick_username === session.username);
      renderStarRow(dom.userStarsEl, mine ? Number(mine.rating) : 0, true);
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

async function submitRating(contentKey, contentTitle, value) {
  const session = getKickSession();
  if (!session || !contentKey) return;
  renderStarRow(dom.userStarsEl, value, true);
  try {
    const res = await fetch(`${SUPABASE_REST}/ratings?on_conflict=content_key,kick_username`, {
      method: "POST",
      headers: supabaseHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        content_key: contentKey,
        content_title: contentTitle,
        kick_username: session.username,
        rating: value,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error("rating_failed");
    if (contentKey === state.currentContentKey) await loadRatingsFor(contentKey);
  } catch {
    dom.ratingGlobalText.textContent = "No se pudo guardar tu calificacion. Proba de nuevo.";
  }
}

async function loadSuggestions() {
  dom.suggestionList.innerHTML = '<div class="suggestion-empty">Cargando...</div>';
  try {
    const url = `${SUPABASE_REST}/suggestions?select=kick_username,message,created_at&order=created_at.desc&limit=200`;
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) throw new Error("fetch_failed");
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("bad_response");

    dom.suggestionList.innerHTML = "";
    if (!rows.length) {
      dom.suggestionList.innerHTML = '<div class="suggestion-empty">Todavia no hay sugerencias. Se el primero.</div>';
      return;
    }

    rows.forEach((row) => {
      const item = document.createElement("div");
      const date = new Date(row.created_at);
      const dateStr = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
      item.className = "suggestion-item";
      item.innerHTML = `
        <div class="suggestion-meta">
          <span class="suggestion-user">${escapeHtml(row.kick_username)}</span>
          <span class="suggestion-date">${dateStr}</span>
        </div>
        <div class="suggestion-text">${escapeHtml(row.message)}</div>
      `;
      dom.suggestionList.appendChild(item);
    });
  } catch {
    dom.suggestionList.innerHTML = '<div class="suggestion-empty">No se pudieron cargar las sugerencias.</div>';
  }
}

const lazyPosterObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const card = entry.target;
    lazyPosterObserver.unobserve(card);
    loadPosterImageNow(card, card.dataset.lazyUrl, JSON.parse(card.dataset.lazyGradient));
  });
}, { root: null, rootMargin: "400px", threshold: 0.01 });

function loadPosterImageNow(card, url, gradient) {
  const setGradient = () => {
    card.style.backgroundImage = "none";
    card.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  };
  if (url) {
    card.style.backgroundSize = "cover";
    card.style.backgroundPosition = "center";
    const testImg = new Image();
    testImg.onload = () => {
      card.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.15) 55%, rgba(0,0,0,0.9) 100%), url('${url}')`;
    };
    testImg.onerror = setGradient;
    testImg.src = url;
  } else {
    setGradient();
  }
}

function applyPosterImage(card, url, gradient) {
  card.style.backgroundColor = gradient[1];
  if (!url) {
    card.style.backgroundImage = "none";
    card.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
    return;
  }
  card.dataset.lazyUrl = url;
  card.dataset.lazyGradient = JSON.stringify(gradient);
  lazyPosterObserver.observe(card);
}

function createPosterCard(item, opts = {}) {
  const card = document.createElement("div");
  card.className = `poster${item.texture ? ` texture-${item.texture}` : ""}`;
  const gradient = item.gradient || ["#1c1c22", "#141419"];
  if (!opts.noAutoFetch) {
    applyPosterImage(card, null, gradient);
    const searchTitle = item.tmdbShow || item.title;
    const posterSearch = opts.mediaType === "tv"
      ? tmdbSearchTvPoster(searchTitle, item.tmdbYear)
      : tmdbSearchMoviePoster(searchTitle, item.tmdbYear);
    posterSearch.then((url) => {
      const resolvedPoster = url || item.poster || null;
      if (!resolvedPoster) return;
      item.poster = resolvedPoster;
      applyPosterImage(card, resolvedPoster, gradient);
    });
  } else {
    applyPosterImage(card, item.poster || null, gradient);
  }

  card.innerHTML = `
    <span class="code">${item.code || ""}</span>
    <span class="now-playing">Reproduciendo</span>
    ${item.saga ? `<span class="saga-tag">Saga: ${item.saga}</span>` : ""}
    <h3>${item.title}</h3>
  `;
  return card;
}

function renderCarousel() {
  dom.carousel.innerHTML = "";
  state.movieOrder.forEach((movieIdx) => {
    const movie = MOVIES[movieIdx];
    const card = createPosterCard(movie);
    card.addEventListener("click", () => selectMovie(movieIdx));
    dom.carousel.appendChild(card);
  });
}

function selectMovie(movieIdx) {
  const movie = MOVIES[movieIdx];
  if (!movie) return;
  dom.playerSource.src = movie.src;
  dom.playerSource.dataset.baseSrc = movie.src;
  dom.player.load();
  dom.titleDisplay.textContent = movie.title;
  dom.status.textContent = `Cargando: ${movie.title}`;
  startWatchdog();

  state.currentContentKey = `movie:${slugify(movie.title)}`;
  state.currentContentTitle = movie.title;
  loadRatingsFor(state.currentContentKey);

  if (movie.saga) {
    const sameSaga = MOVIES.map((_, i) => i).filter((i) => MOVIES[i].saga === movie.saga && i !== movieIdx);
    const rest = MOVIES.map((_, i) => i).filter((i) => MOVIES[i].saga !== movie.saga && i !== movieIdx);
    state.movieOrder = [movieIdx, ...sameSaga, ...rest];
    renderCarousel();
  }

  const displayIdx = state.movieOrder.indexOf(movieIdx);
  [...dom.carousel.children].forEach((el, i) => el.classList.toggle("active", i === displayIdx));
  dom.player.play().catch(() => {});
}

function renderSeriesCarousel() {
  dom.seriesCarousel.innerHTML = "";
  SERIES.forEach((serie, i) => {
    const card = createPosterCard(serie, { mediaType: "tv" });
    card.addEventListener("click", () => selectSeries(i));
    dom.seriesCarousel.appendChild(card);
  });
}

function selectSeries(index) {
  const serie = SERIES[index];
  if (!serie) return;
  state.currentSeriesIndex = index;
  state.currentSeasonIndex = 0;
  [...dom.seriesCarousel.children].forEach((el, i) => el.classList.toggle("active", i === index));
  renderSeasonSelector();
  renderEpisodeCarousel();
}

function renderSeasonSelector() {
  const serie = SERIES[state.currentSeriesIndex];
  if (!serie) {
    dom.seasonSelector.style.display = "none";
    return;
  }
  dom.seasonSelector.innerHTML = "";
  dom.seasonSelector.style.display = serie.seasons.length > 1 ? "flex" : "none";
  serie.seasons.forEach((season, i) => {
    const pill = document.createElement("button");
    pill.className = `season-pill${i === state.currentSeasonIndex ? " active" : ""}`;
    pill.textContent = `Temporada ${season.season}`;
    pill.addEventListener("click", () => {
      state.currentSeasonIndex = i;
      renderSeasonSelector();
      renderEpisodeCarousel();
    });
    dom.seasonSelector.appendChild(pill);
  });
}

async function ensureSeasonEpisodes(serie, season) {
  if (season.episodes) {
    const missingPoster = season.episodes.some((ep) => !ep.poster);
    if (missingPoster && !season._posterFetchAttempted) {
      season._posterFetchAttempted = true;
      const tvId = await tmdbFindTvId(serie.tmdbShow || serie.title, serie.tmdbYear);
      if (tvId) {
        const tmdbEpisodes = await tmdbGetSeasonEpisodes(tvId, season.season);
        season.episodes.forEach((ep, i) => {
          if (!ep.poster && tmdbEpisodes[i] && tmdbEpisodes[i].poster) {
            ep.poster = tmdbEpisodes[i].poster;
          }
        });
      }
    }
    return season.episodes;
  }
  if (!season.srcs || !season.srcs.length) {
    season.episodes = [];
    return season.episodes;
  }

  const tvId = await tmdbFindTvId(serie.tmdbShow || serie.title, serie.tmdbYear);
  let tmdbEpisodes = [];
  if (tvId) tmdbEpisodes = await tmdbGetSeasonEpisodes(tvId, season.season);
  season.episodes = season.srcs.map((src, i) => {
    const tmdbEp = tmdbEpisodes[i] || {};
    return {
      title: tmdbEp.title || `Episodio ${i + 1}`,
      description: tmdbEp.description || "",
      poster: tmdbEp.poster || null,
      src,
    };
  });
  return season.episodes;
}

function createEpisodeCard(ep, index) {
  const card = document.createElement("div");
  card.className = "episode-card";
  const thumb = document.createElement("div");
  thumb.className = "episode-thumb";
  if (ep.poster) {
    thumb.dataset.lazyUrl = ep.poster;
    thumb.dataset.lazyGradient = JSON.stringify(["#1c1c22", "#141419"]);
    lazyPosterObserver.observe(thumb);
  }
  thumb.innerHTML = `
    <span class="ep-code">${index + 1}</span>
    <span class="ep-playing">Reproduciendo</span>
  `;

  const title = document.createElement("div");
  title.className = "episode-title";
  title.textContent = `${index + 1}. ${ep.title}`;

  card.appendChild(thumb);
  card.appendChild(title);
  if (ep.description) {
    const desc = document.createElement("div");
    desc.className = "episode-desc";
    desc.textContent = ep.description;
    card.appendChild(desc);
  }
  return card;
}

async function renderEpisodeCarousel() {
  const serie = SERIES[state.currentSeriesIndex];
  if (!serie) {
    dom.episodeCarousel.style.display = "none";
    return;
  }
  const season = serie.seasons[state.currentSeasonIndex];
  dom.episodeCarousel.style.display = "flex";

  if (!season.episodes && season.srcs && season.srcs.length) {
    dom.episodeCarousel.innerHTML = '<div style="color:var(--text-dim);font-size:12px;letter-spacing:0.1em;padding:20px 10px;">Buscando episodios en TMDB...</div>';
  }

  const episodes = await ensureSeasonEpisodes(serie, season);
  if (SERIES[state.currentSeriesIndex] !== serie || serie.seasons[state.currentSeasonIndex] !== season) return;

  dom.episodeCarousel.innerHTML = "";
  if (!episodes.length) {
    const soon = document.createElement("div");
    soon.style.color = "var(--text-dim)";
    soon.style.fontSize = "12px";
    soon.style.letterSpacing = "0.1em";
    soon.style.padding = "20px 10px";
    soon.textContent = "Proximamente...";
    dom.episodeCarousel.appendChild(soon);
    return;
  }

  episodes.forEach((ep, i) => {
    const card = createEpisodeCard(ep, i);
    card.addEventListener("click", () => selectEpisode(i));
    dom.episodeCarousel.appendChild(card);
  });
}

function selectEpisode(index) {
  const serie = SERIES[state.currentSeriesIndex];
  const season = serie.seasons[state.currentSeasonIndex];
  const ep = season.episodes[index];
  if (!ep) return;
  dom.playerSource.src = ep.src;
  dom.playerSource.dataset.baseSrc = ep.src;
  dom.player.load();
  dom.titleDisplay.textContent = `${serie.title} - ${ep.title}`;
  dom.status.textContent = `Cargando: ${ep.title}`;
  startWatchdog();

  state.currentContentKey = `series:${slugify(serie.title)}:s${season.season}`;
  state.currentContentTitle = `${serie.title} - Temporada ${season.season}`;
  loadRatingsFor(state.currentContentKey);

  [...dom.episodeCarousel.children].forEach((el, i) => el.classList.toggle("active", i === index));
  dom.player.play().catch(() => {});
}

function getSagas() {
  const map = new Map();
  MOVIES.forEach((movie, i) => {
    if (!movie.saga) return;
    if (!map.has(movie.saga)) map.set(movie.saga, []);
    map.get(movie.saga).push(i);
  });
  return [...map.entries()].map(([name, indices]) => ({
    name,
    poster: MOVIES[indices[0]].poster,
    gradient: MOVIES[indices[0]].gradient,
    movieIndices: indices,
  }));
}

function renderSagaCarousel() {
  const sagas = getSagas();
  dom.sagaCarousel.innerHTML = "";
  sagas.forEach((saga, i) => {
    const card = createPosterCard({ title: saga.name, poster: saga.poster, gradient: saga.gradient });
    card.addEventListener("click", () => selectSaga(i));
    dom.sagaCarousel.appendChild(card);
  });
}

function selectSaga(index) {
  const sagas = getSagas();
  const saga = sagas[index];
  if (!saga) return;
  [...dom.sagaCarousel.children].forEach((el, i) => el.classList.toggle("active", i === index));
  dom.sagaMoviesLabel.style.display = "block";
  dom.sagaMoviesCarousel.style.display = "flex";
  dom.sagaMoviesCarousel.innerHTML = "";
  saga.movieIndices.forEach((movieIdx) => {
    const movie = MOVIES[movieIdx];
    const card = createPosterCard(movie);
    card.addEventListener("click", () => {
      if (currentPage !== "sagas") {
        switchTab("movies");
      }
      selectMovie(movieIdx);
    });
    dom.sagaMoviesCarousel.appendChild(card);
  });
}

function switchTab(tabName) {
  if (dom.tabs) {
    [...dom.tabs.children].forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabName));
  }
  if (dom.moviesSection) dom.moviesSection.style.display = tabName === "movies" ? "block" : "none";
  if (dom.seriesSection) dom.seriesSection.style.display = tabName === "series" ? "block" : "none";
  if (dom.sagasSection) dom.sagasSection.style.display = tabName === "sagas" ? "block" : "none";
  if (dom.sugerenciasSection) dom.sugerenciasSection.style.display = tabName === "sugerencias" ? "block" : "none";
  if (tabName === "sugerencias") loadSuggestions();
}

function withCacheBust(url) {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_r=${Date.now()}`;
}

function recoverPlayback() {
  if (state.isRecovering) return;
  state.isRecovering = true;
  const resumeAt = dom.player.currentTime;
  const baseSrc = dom.playerSource.dataset.baseSrc || dom.playerSource.src;
  dom.status.textContent = "El video se trabo, reconectando...";
  dom.playerSource.dataset.baseSrc = baseSrc;
  dom.playerSource.src = withCacheBust(baseSrc);
  dom.player.load();
  const onReady = () => {
    dom.player.currentTime = resumeAt;
    dom.player.play().catch(() => {});
    dom.status.textContent = "";
    state.isRecovering = false;
    dom.player.removeEventListener("loadedmetadata", onReady);
  };
  dom.player.addEventListener("loadedmetadata", onReady);
}

function startWatchdog() {
  if (state.watchdogInterval) clearInterval(state.watchdogInterval);
  state.watchdogLastTime = dom.player.currentTime;
  state.watchdogStallCount = 0;
  state.watchdogInterval = setInterval(() => {
    if (state.isRecovering || dom.player.paused || dom.player.ended) {
      state.watchdogLastTime = dom.player.currentTime;
      state.watchdogStallCount = 0;
      return;
    }
    if (Math.abs(dom.player.currentTime - state.watchdogLastTime) < 0.15) {
      state.watchdogStallCount += 1;
      if (state.watchdogStallCount >= 2) {
        state.watchdogStallCount = 0;
        recoverPlayback();
      }
    } else {
      state.watchdogStallCount = 0;
    }
    state.watchdogLastTime = dom.player.currentTime;
  }, 8000);
}

function saveProgress(src, time, duration) {
  if (!src) return;
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    map[src] = { time, duration, updatedAt: Date.now() };
    localStorage.setItem("playback_progress", JSON.stringify(map));
    localStorage.setItem("last_watched_src", src);
  } catch {
    // ignore
  }
}

function getProgress(src) {
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    return map[src] || null;
  } catch {
    return null;
  }
}

function clearProgress(src) {
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    delete map[src];
    localStorage.setItem("playback_progress", JSON.stringify(map));
  } catch {
    // ignore
  }
}

function findContentLocation(src) {
  const movieIdx = MOVIES.findIndex((movie) => movie.src === src);
  if (movieIdx !== -1) return { kind: "movie", movieIdx, title: MOVIES[movieIdx].title };

  for (let si = 0; si < SERIES.length; si += 1) {
    const serie = SERIES[si];
    for (let sj = 0; sj < serie.seasons.length; sj += 1) {
      const season = serie.seasons[sj];
      if (season.srcs) {
        const epIdx = season.srcs.indexOf(src);
        if (epIdx !== -1) {
          return { kind: "episode", seriesIndex: si, seasonIndex: sj, episodeIndex: epIdx, title: `${serie.title} - T${serie.seasons[sj].season}E${epIdx + 1}` };
        }
      }
      if (season.episodes) {
        const epIdx = season.episodes.findIndex((episode) => episode.src === src);
        if (epIdx !== -1) {
          return { kind: "episode", seriesIndex: si, seasonIndex: sj, episodeIndex: epIdx, title: `${serie.title} - ${season.episodes[epIdx].title}` };
        }
      }
    }
  }
  return null;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

async function goToLocation(location, seekTime) {
  if (location.kind === "movie") {
    switchTab("movies");
    selectMovie(location.movieIdx);
  } else {
    switchTab("series");
    state.currentSeriesIndex = location.seriesIndex;
    state.currentSeasonIndex = location.seasonIndex;
    [...dom.seriesCarousel.children].forEach((el, i) => el.classList.toggle("active", i === location.seriesIndex));
    renderSeasonSelector();
    await renderEpisodeCarousel();
    selectEpisode(location.episodeIndex);
  }
  if (seekTime > 0) {
    const onReady = () => {
      dom.player.currentTime = seekTime;
      dom.player.removeEventListener("loadedmetadata", onReady);
    };
    dom.player.addEventListener("loadedmetadata", onReady);
  }
}

function showResumeModal(location, progress) {
  document.getElementById("resumeModalTitle").textContent = location.title;
  document.getElementById("resumeModalTime").textContent = formatTime(progress.time);
  const overlay = document.getElementById("resumeOverlay");
  overlay.style.display = "flex";

  document.getElementById("resumeContinueBtn").onclick = () => {
    overlay.style.display = "none";
    goToLocation(location, progress.time);
  };
  document.getElementById("resumeRestartBtn").onclick = () => {
    overlay.style.display = "none";
    clearProgress(location.src);
    goToLocation(location, 0);
  };
  document.getElementById("resumeCloseBtn").onclick = () => {
    overlay.style.display = "none";
  };
}

function bindEvents() {
  dom.kickLoginBtn.addEventListener("click", startKickLogin);
  dom.kickLogoutBtn.addEventListener("click", logoutKick);
  if (dom.tabs) {
    dom.tabs.addEventListener("click", (event) => {
      const btn = event.target.closest(".tab");
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });
  }

  dom.player.addEventListener("error", () => {
    dom.status.textContent = "No se pudo cargar el video. Revisa que el release de GitHub siga disponible.";
  });
  dom.player.addEventListener("playing", () => {
    dom.status.textContent = "";
  });
  dom.player.addEventListener("timeupdate", () => {
    const src = dom.playerSource.dataset.baseSrc;
    if (!src || !dom.player.duration) return;
    const now = Date.now();
    if (now - state.lastProgressSave < 5000) return;
    state.lastProgressSave = now;
    if (dom.player.currentTime > 10 && dom.player.duration - dom.player.currentTime > 15) {
      saveProgress(src, dom.player.currentTime, dom.player.duration);
    }
  });
  dom.player.addEventListener("ended", () => {
    const src = dom.playerSource.dataset.baseSrc;
    if (src) clearProgress(src);
  });

  if (dom.userStarsEl) {
    dom.userStarsEl.addEventListener("click", (event) => {
      const session = getKickSession();
      if (!session || !state.currentContentKey) return;
      const starEl = event.target.closest(".star");
      if (!starEl) return;
      const stars = [...dom.userStarsEl.children];
      const idx = stars.indexOf(starEl);
      const rect = starEl.getBoundingClientRect();
      const isHalf = event.clientX - rect.left < rect.width / 2;
      const value = idx + (isHalf ? 0.5 : 1);
      submitRating(state.currentContentKey, state.currentContentTitle, value);
    });
  }

  if (dom.suggestionSubmitBtn) {
    dom.suggestionSubmitBtn.addEventListener("click", async () => {
      const session = getKickSession();
      if (!session) return;
      const text = dom.suggestionInput.value.trim();
      if (!text) return;
      dom.suggestionSubmitBtn.disabled = true;
      dom.suggestionSubmitBtn.textContent = "Enviando...";
      try {
        const res = await fetch(`${SUPABASE_REST}/suggestions`, {
          method: "POST",
          headers: supabaseHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
          body: JSON.stringify({ kick_username: session.username, message: text }),
        });
        if (!res.ok) throw new Error("insert_failed");
        dom.suggestionInput.value = "";
        await loadSuggestions();
      } catch {
        alert("No se pudo enviar la sugerencia. Proba de nuevo.");
      } finally {
        dom.suggestionSubmitBtn.disabled = false;
        dom.suggestionSubmitBtn.textContent = "Enviar sugerencia";
      }
    });
  }
}

function initKickAuth() {
  const redirectResult = consumeAuthRedirect();
  if (redirectResult.error) {
    showKickGate("No se pudo iniciar sesion con Kick. Proba de nuevo.");
    return;
  }
  const session = redirectResult.session || getKickSession();
  if (session) {
    applyKickSession(session);
  } else {
    showKickGate();
  }
}

function initResumePrompt() {
  try {
    const lastSrc = localStorage.getItem("last_watched_src");
    if (!lastSrc) return;
    const progress = getProgress(lastSrc);
    if (!progress || progress.time <= 15) return;
    const location = findContentLocation(lastSrc);
    if (!location) return;
    location.src = lastSrc;
    showResumeModal(location, progress);
  } catch {
    // ignore
  }
}

function init() {
  bindEvents();
  initKickAuth();
  startWatchdog();
  renderCarousel();
  renderSeriesCarousel();
  renderSagaCarousel();
  if (currentPage === "movies") {
    switchTab("movies");
    selectMovie(0);
  } else if (currentPage === "series") {
    switchTab("series");
    dom.titleDisplay.textContent = "Explora las series";
    selectSeries(0);
  } else if (currentPage === "sagas") {
    switchTab("sagas");
    dom.titleDisplay.textContent = "Explora las sagas";
    selectSaga(0);
  } else if (currentPage === "sugerencias") {
    switchTab("sugerencias");
    dom.titleDisplay.textContent = "Deja tu sugerencia";
  } else {
    switchTab("movies");
    selectMovie(0);
  }
  initResumePrompt();
}

init();
