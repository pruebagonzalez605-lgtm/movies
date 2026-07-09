import { createSupabaseService } from "./services/supabase.js";
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

const dom = {
  title: document.getElementById("playerTitle"),
  subtitle: document.getElementById("playerSubtitle"),
  status: document.getElementById("playerStatus"),
  video: document.getElementById("player"),
  source: document.getElementById("playerSource"),
  poster: document.getElementById("playerPoster"),
  meta: document.getElementById("playerMeta"),
  related: document.getElementById("playerRelated"),
  collectionTitle: document.getElementById("playerCollectionTitle"),
  backLink: document.getElementById("playerBackLink"),
  globalStars: document.getElementById("globalStars"),
  ratingGlobalText: document.getElementById("ratingGlobalText"),
  ratingUserBlock: document.getElementById("ratingUserBlock"),
  userStars: document.getElementById("userStars"),
  ratingLoginHint: document.getElementById("ratingLoginHint"),
};

const state = {
  currentContentKey: null,
  currentContentTitle: null,
  currentBaseSrc: null,
  lastProgressSave: 0,
};

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

function saveProgress(src, time, duration) {
  if (!src) return;
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    map[src] = { time, duration, updatedAt: Date.now() };
    localStorage.setItem("playback_progress", JSON.stringify(map));
    localStorage.setItem("last_watched_src", src);
  } catch {
    // Ignore storage errors.
  }
}

function clearProgress(src) {
  try {
    const map = JSON.parse(localStorage.getItem("playback_progress") || "{}");
    delete map[src];
    localStorage.setItem("playback_progress", JSON.stringify(map));
  } catch {
    // Ignore storage errors.
  }
}

function setPoster(node, posterUrl, gradient) {
  node.style.background = `linear-gradient(160deg, ${gradient[0]}, ${gradient[1]})`;
  if (!posterUrl) return;
  node.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.82)), url('${posterUrl}')`;
  node.style.backgroundSize = "cover";
  node.style.backgroundPosition = "center";
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

function mountPlayer({ src, title, subtitle, poster, gradient, meta, backHref, contentKey, relatedHtml, collectionTitle }) {
  dom.title.textContent = title;
  dom.subtitle.textContent = subtitle;
  dom.backLink.href = backHref;
  dom.backLink.textContent = "Volver al catalogo";
  dom.meta.innerHTML = meta.map((item) => `<span>${item}</span>`).join("");
  dom.related.innerHTML = relatedHtml;
  dom.collectionTitle.textContent = collectionTitle;

  setPoster(dom.poster, poster, gradient);
  dom.source.src = src;
  dom.source.dataset.baseSrc = src;
  dom.video.load();
  dom.status.textContent = `Listo para reproducir: ${title}`;

  state.currentContentKey = contentKey;
  state.currentContentTitle = title;
  state.currentBaseSrc = src;

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

  mountPlayer({
    src: movie.src,
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

  mountPlayer({
    src: episode.src,
    title: `${serie.title} - ${episode.title || `Episodio ${episodeNumber}`}`,
    subtitle: `Temporada ${seasonNumber} - Episodio ${episodeNumber}`,
    poster,
    gradient: serie.gradient || ["#1c1c22", "#141419"],
    meta: ["Serie", `Temporada ${seasonNumber}`, `Episodio ${episodeNumber}`],
    backHref: "./series.html",
    contentKey: `series:${slugify(serie.title)}:s${seasonNumber}`,
    relatedHtml: relatedEpisodes,
    collectionTitle: `Capitulos de la temporada ${seasonNumber}`,
  });
}

function bindEvents() {
  dom.video.addEventListener("error", () => {
    dom.status.textContent = "No se pudo cargar el video seleccionado.";
  });

  dom.video.addEventListener("playing", () => {
    dom.status.textContent = "";
  });

  dom.video.addEventListener("timeupdate", () => {
    if (!state.currentBaseSrc || !dom.video.duration) return;
    const now = Date.now();
    if (now - state.lastProgressSave < 5000) return;
    state.lastProgressSave = now;
    if (dom.video.currentTime > 10 && dom.video.duration - dom.video.currentTime > 15) {
      saveProgress(state.currentBaseSrc, dom.video.currentTime, dom.video.duration);
    }
  });

  dom.video.addEventListener("ended", () => {
    if (state.currentBaseSrc) clearProgress(state.currentBaseSrc);
  });

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
    dom.title.textContent = "Contenido no encontrado";
    dom.subtitle.textContent = "Revisa el enlace y vuelve al catalogo.";
    dom.status.textContent = "";
    dom.meta.innerHTML = "<span>Sin coincidencias</span>";
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
