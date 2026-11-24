import { MEDIA_CONFIG } from "../config/media.js";

// El login con Kick lo hace el Worker (media-proxy/src/community.js): guarda
// el client secret, hace PKCE y devuelve una sesion FIRMADA. La web guarda el
// token completo y lo manda al calificar o sugerir; el Worker solo acepta lo
// que viene con una firma valida.
const KICK_SESSION_KEY = "kick_session";
export const COMMUNITY_API = (MEDIA_CONFIG.proxyBaseUrl || "").replace(/\/+$/, "");

function decodeSessionToken(token) {
  try {
    if (typeof token !== "string" || token.split(".").length !== 2) return null;
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

export function getKickSession() {
  try {
    const raw = localStorage.getItem(KICK_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    // Las sesiones viejas (antes del login por el Worker) no traen token
    // firmado: hay que volver a iniciar sesion.
    if (!session || !session.exp || !session.token || Date.now() / 1000 > session.exp) {
      localStorage.removeItem(KICK_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
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
  if (!payload || !payload.username) return { handled: true, error: "invalid_token" };
  const session = { ...payload, token };
  localStorage.setItem(KICK_SESSION_KEY, JSON.stringify(session));
  return { handled: true, session };
}

export function initKickAuthUI({ onChange } = {}) {
  const kickGateError = document.getElementById("kickGateError");
  const kickLoginBtn = document.getElementById("kickLoginBtn");
  const kickUserBadge = document.getElementById("kickUserBadge");
  const kickUserAvatar = document.getElementById("kickUserAvatar");
  const kickUserName = document.getElementById("kickUserName");
  const kickLogoutBtn = document.getElementById("kickLogoutBtn");

  if (!kickLoginBtn || !kickUserBadge || !kickUserName) {
    return null;
  }

  function showKickGate(errorMsg) {
    kickLoginBtn.style.display = "inline-flex";
    kickUserBadge.style.display = "none";
    kickLoginBtn.disabled = false;
    kickLoginBtn.textContent = "Ingresar con Kick";
    if (kickGateError) {
      if (errorMsg) {
        kickGateError.textContent = errorMsg;
        kickGateError.style.display = "block";
      } else {
        kickGateError.style.display = "none";
      }
    }
    if (onChange) onChange(null);
  }

  function applyKickSession(session) {
    kickLoginBtn.style.display = "none";
    kickUserBadge.style.display = "flex";
    kickUserName.textContent = session.username || "Usuario de Kick";
    if (kickUserAvatar) {
      if (session.avatar) {
        kickUserAvatar.style.backgroundImage = `url('${session.avatar}')`;
        kickUserAvatar.style.display = "block";
      } else {
        kickUserAvatar.style.display = "none";
      }
    }
    if (onChange) onChange(session);
  }

  function startKickLogin() {
    kickLoginBtn.disabled = true;
    kickLoginBtn.textContent = "Redirigiendo...";
    const returnTo = window.location.href.split("#")[0];
    window.location.href = `${COMMUNITY_API}/auth/kick/start?return=${encodeURIComponent(returnTo)}`;
  }

  function logoutKick() {
    localStorage.removeItem(KICK_SESSION_KEY);
    showKickGate();
  }

  kickLoginBtn.addEventListener("click", startKickLogin);
  kickLogoutBtn?.addEventListener("click", logoutKick);

  const redirectResult = consumeAuthRedirect();
  if (redirectResult.error) {
    showKickGate("No se pudo iniciar sesion con Kick. Proba de nuevo.");
    return null;
  }

  const session = redirectResult.session || getKickSession();
  if (session) {
    applyKickSession(session);
    return session;
  }

  showKickGate();
  return null;
}

/** Cabeceras para escribir en /community/*: el Worker valida esta firma. */
export function communityAuthHeaders(session = getKickSession()) {
  return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
}
