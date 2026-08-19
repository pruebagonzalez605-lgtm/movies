/**
 * Deteccion de "es un dispositivo de TV" (Android TV, Google TV, Smart TVs,
 * Fire TV, Roku, Chromecast con navegador, etc.) a partir del user agent.
 *
 * Es el mismo metodo que ya usabamos en tv-app-prompt.js para mostrarle al
 * usuario el aviso de "descarga la app para TV" cuando entra a la web desde
 * un navegador de TV. Vive aca, en un modulo compartido, para poder
 * reutilizarlo tambien dentro del propio APK (player-page.js): el APK corre
 * el mismo codigo tanto en un Android TV como en un celular, asi que
 * necesita esta misma deteccion para saber cuando aplicar el look "TV"
 * (teatro fijo, fullscreen automatico, orientacion forzada) y cuando dejar
 * el comportamiento normal de celular -que ya funciona perfecto en la web-.
 */

// Palabras clave presentes en el user agent de la mayoria de navegadores
// y WebViews que corren sobre televisores / dispositivos de sala.
const TV_USER_AGENT_HINTS = [
  "android tv",
  "googletv",
  "google tv",
  "smart-tv",
  "smarttv",
  "tizen",
  "web0s",
  "webos",
  "hbbtv",
  "netcast",
  "viera",
  "bravia",
  "aft", // Amazon Fire TV (AFTB, AFTM, AFTT, AFTS...)
  "roku",
  "crkey", // Chromecast con navegador embebido
];

export function isLikelyTvBrowser() {
  const ua = navigator.userAgent ? navigator.userAgent.toLowerCase() : "";
  return TV_USER_AGENT_HINTS.some((hint) => ua.includes(hint));
}
