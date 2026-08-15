const KICK_CLIENT_ID = "01KX013P9HAMCVKK0JHVJP53QV";
const KICK_REDIRECT_URI = "https://iqmxbmodzdtjdfepggae.supabase.co/functions/v1/kick-oauth-callback";
const KICK_AUTHORIZE_URL = "https://id.kick.com/oauth/authorize";
const KICK_SESSION_KEY = "kick_session";

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
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

export function getKickSession() {
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

  async function startKickLogin() {
    kickLoginBtn.disabled = true;
    kickLoginBtn.textContent = "Redirigiendo...";
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
      showKickGate("No se pudo iniciar el login. Proba de nuevo.");
    }
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
