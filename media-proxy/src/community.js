// Inicio de sesion con Kick, calificaciones y sugerencias.
//
// Antes la web escribia directo en Supabase con la clave publica y un
// kick_username que mandaba el propio navegador: cualquiera podia calificar
// o publicar sugerencias en nombre de otro usuario. Ahora:
//   1. El Worker hace el login OAuth con Kick (PKCE + client secret) y le
//      entrega a la web una sesion FIRMADA (HMAC-SHA256 con SESSION_SECRET).
//   2. Solo el Worker escribe en la base (D1), y el usuario sale de la firma,
//      nunca del cuerpo de la peticion.
//
// Secretos (wrangler secret put): KICK_CLIENT_SECRET, SESSION_SECRET.
// Variable: KICK_CLIENT_ID. Base de datos: binding DB (db/schema.sql).

const KICK_AUTHORIZE_URL = "https://id.kick.com/oauth/authorize";
const KICK_TOKEN_URL = "https://id.kick.com/oauth/token";
const KICK_USERS_URL = "https://api.kick.com/public/v1/users";
const OAUTH_COOKIE = "cv_kick_oauth";
const OAUTH_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const CONTENT_KEY = /^(?:movie|series):[a-z0-9][a-z0-9:-]{0,199}$/;
const SUGGESTION_MAX = 1000;
const SUGGESTION_COOLDOWN_SECONDS = 60;
const SUGGESTIONS_PER_DAY = 10;

const encoder = new TextEncoder();

function base64UrlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(text) {
  return base64UrlFromBytes(encoder.encode(text));
}

function stringFromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function randomToken(bytes = 32) {
  return base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error("session_secret_missing");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Firma un objeto: "<payload base64url>.<firma base64url>". */
export async function signPayload(payload, secret) {
  const body = base64UrlFromString(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

// stringFromBase64Url decodifica como UTF-8; para la firma hacen falta los
// bytes crudos, asi que se decodifica aparte.
function bytesFromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Devuelve el objeto si la firma es valida y no vencio; si no, null. */
export async function verifySignedToken(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), bytesFromBase64Url(parts[1]), encoder.encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(stringFromBase64Url(parts[0]));
    if (!payload || typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}


function allowedOrigins(env) {
  return (env.ALLOWED_SITE_ORIGIN || "https://colevana.com").split(",").map((value) => value.trim()).filter(Boolean);
}

/** La vuelta del login solo puede ir a una pagina de Colevana (no open redirect). */
export function safeReturnUrl(raw, env) {
  const origins = allowedOrigins(env);
  try {
    const url = new URL(raw);
    if (origins.includes(url.origin)) {
      url.hash = "";
      return url.href;
    }
  } catch { /* se usa la portada */ }
  return `${origins[0]}/`;
}

function communityCors(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowedOrigins(env).includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(request, env, status, body) {
  return new Response(JSON.stringify(typeof body === "string" ? { error: body } : body), {
    status,
    headers: { ...communityCors(request, env), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", ...extraHeaders } });
}

async function sha256Base64Url(text) {
  return base64UrlFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

async function startKickLogin(request, env, url) {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) return json(request, env, 503, "kick_login_not_configured");
  const verifier = randomToken(48);
  const state = randomToken(24);
  const returnTo = safeReturnUrl(url.searchParams.get("return"), env);
  const cookie = await signPayload({ v: verifier, s: state, r: returnTo, exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS }, env.SESSION_SECRET);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.KICK_CLIENT_ID,
    redirect_uri: `${url.origin}/auth/kick/callback`,
    scope: "user:read",
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
    state,
  });
  return redirect(`${KICK_AUTHORIZE_URL}?${params}`, {
    "Set-Cookie": `${OAUTH_COOKIE}=${cookie}; Path=/auth/kick; Max-Age=${OAUTH_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function finishKickLogin(request, env, url, fetcher) {
  const clearCookie = `${OAUTH_COOKIE}=; Path=/auth/kick; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const flow = await verifySignedToken(readCookie(request, OAUTH_COOKIE), env.SESSION_SECRET);
  const fallback = safeReturnUrl(flow?.r, env);
  const fail = (reason) => redirect(`${fallback}#error=${encodeURIComponent(reason)}`, { "Set-Cookie": clearCookie });
  if (!flow) return fail("login_expired");
  if (url.searchParams.get("error")) return fail("login_cancelled");
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== flow.s) return fail("login_invalid");

  try {
    const tokenRes = await fetcher(KICK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.KICK_CLIENT_ID,
        client_secret: env.KICK_CLIENT_SECRET,
        redirect_uri: `${url.origin}/auth/kick/callback`,
        code_verifier: flow.v,
        code,
      }),
    });
    if (!tokenRes.ok) return fail("kick_token_failed");
    const { access_token: accessToken } = await tokenRes.json();
    const userRes = await fetcher(KICK_USERS_URL, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!userRes.ok) return fail("kick_user_failed");
    const user = (await userRes.json())?.data?.[0];
    const username = typeof user?.name === "string" ? user.name.trim() : "";
    if (!username) return fail("kick_user_failed");
    const avatar = typeof user.profile_picture === "string" && /^https:\/\//.test(user.profile_picture) ? user.profile_picture : null;
    const session = await signPayload({
      sub: String(user.user_id ?? ""),
      username: username.slice(0, 60),
      avatar,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }, env.SESSION_SECRET);
    return redirect(`${flow.r}#session=${session}`, { "Set-Cookie": clearCookie });
  } catch {
    return fail("kick_login_failed");
  }
}

async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const session = await verifySignedToken(token, env.SESSION_SECRET);
  return session?.username ? session : null;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 8000) throw new Error("too_large");
  return JSON.parse(text);
}

async function handleRatings(request, env) {
  if (request.method === "GET") {
    const key = new URL(request.url).searchParams.get("content_key") || "";
    if (!CONTENT_KEY.test(key)) return json(request, env, 400, "invalid_content_key");
    const { results } = await env.DB.prepare("SELECT rating, kick_username FROM ratings WHERE content_key = ?1 LIMIT 5000").bind(key).all();
    return json(request, env, 200, results || []);
  }
  if (request.method !== "POST") return json(request, env, 405, "method_not_allowed");
  const session = await requireSession(request, env);
  if (!session) return json(request, env, 401, "login_required");
  let body;
  try { body = await readJson(request); } catch { return json(request, env, 400, "invalid_body"); }
  const key = typeof body?.content_key === "string" ? body.content_key : "";
  const rating = Number(body?.rating);
  const title = typeof body?.content_title === "string" ? body.content_title.trim().slice(0, 200) : "";
  if (!CONTENT_KEY.test(key)) return json(request, env, 400, "invalid_content_key");
  // Estrellas de 0,5 en 0,5 (el selector permite medias estrellas).
  if (!Number.isInteger(rating * 2) || rating < 0.5 || rating > 5) return json(request, env, 400, "invalid_rating");
  await env.DB.prepare(`INSERT INTO ratings (content_key, kick_username, content_title, rating)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (content_key, kick_username) DO UPDATE SET rating = excluded.rating,
        content_title = excluded.content_title, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(key, session.username, title, rating).run();
  return json(request, env, 200, { ok: true });
}

async function handleSuggestions(request, env) {
  if (request.method === "GET") {
    const { results } = await env.DB.prepare("SELECT kick_username, message, created_at FROM suggestions ORDER BY created_at DESC LIMIT 200").all();
    return json(request, env, 200, results || []);
  }
  if (request.method !== "POST") return json(request, env, 405, "method_not_allowed");
  const session = await requireSession(request, env);
  if (!session) return json(request, env, 401, "login_required");
  let body;
  try { body = await readJson(request); } catch { return json(request, env, 400, "invalid_body"); }
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > SUGGESTION_MAX) return json(request, env, 400, "invalid_message");

  // Anti-spam por usuario: una cada minuto y como mucho 10 por dia.
  const recent = await env.DB.prepare(`SELECT
      SUM(created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2)) AS last_minute,
      COUNT(*) AS last_day
    FROM suggestions WHERE kick_username = ?1 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`)
    .bind(session.username, `-${SUGGESTION_COOLDOWN_SECONDS} seconds`).first();
  if (Number(recent?.last_minute) > 0 || Number(recent?.last_day) >= SUGGESTIONS_PER_DAY) {
    return json(request, env, 429, "too_many_suggestions");
  }
  await env.DB.prepare("INSERT INTO suggestions (kick_username, message) VALUES (?1, ?2)").bind(session.username, message).run();
  return json(request, env, 200, { ok: true });
}

/** Devuelve la respuesta si la ruta es de esta parte, o null. */
export async function handleCommunity(request, env, url, fetcher = fetch) {
  const { pathname } = url;
  const isApi = pathname === "/community/ratings" || pathname === "/community/suggestions";
  if (!isApi && pathname !== "/auth/kick/start" && pathname !== "/auth/kick/callback") return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: communityCors(request, env) });
  if (!env.SESSION_SECRET) return json(request, env, 503, "community_not_configured");
  try {
    if (pathname === "/auth/kick/start") return await startKickLogin(request, env, url);
    if (pathname === "/auth/kick/callback") return await finishKickLogin(request, env, url, fetcher);
    if (!env.DB) return json(request, env, 503, "community_not_configured");
    if (request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (!origin || !allowedOrigins(env).includes(origin)) return json(request, env, 403, "forbidden_origin");
    }
    return pathname === "/community/ratings" ? await handleRatings(request, env) : await handleSuggestions(request, env);
  } catch {
    return json(request, env, 500, "community_error");
  }
}
