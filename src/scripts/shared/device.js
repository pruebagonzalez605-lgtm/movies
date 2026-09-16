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
  "leanback",
  "colevanatv", // marca que agrega MainActivity al user agent cuando el APK corre en TV
];

export function isLikelyTvBrowser() {
  const ua = navigator.userAgent ? navigator.userAgent.toLowerCase() : "";
  return TV_USER_AGENT_HINTS.some((hint) => ua.includes(hint));
}

/**
 * Marca el <html> con `tv-device` cuando estamos en un televisor.
 *
 * Sirve para que el CSS pueda agrandar controles (por ejemplo los chips de
 * genero) sin tocar el diseño de celular/web. Se llama una sola vez desde
 * nav.js, que ya se carga en todas las paginas.
 */
/** True si estamos dentro del APK (Capacitor), sea TV o celular. */
export function isNativeAppShell() {
  return Boolean(window.Capacitor?.isNativePlatform?.());
}

/**
 * Bandera que inyecta la capa nativa (MainActivity) via JavascriptInterface.
 * Es la fuente MAS confiable: Android decide si es TV con UiModeManager, que
 * no depende del user agent. Devuelve true/false, o null si no existe (web).
 */
export function nativeTvFlag() {
  try {
    const value = window.ColevanaNative?.isTv?.();
    if (typeof value === "boolean") return value;
  } catch {
    /* la interfaz no existe o fallo: seguimos con las otras heuristicas */
  }
  return null;
}

/**
 * Heuristica por tipo de entrada: un televisor se maneja con control remoto,
 * asi que no tiene touch NI hover (mouse), y la pantalla es grande. Un
 * celular tiene touch; una PC tiene hover. Sirve de red de seguridad cuando
 * el WebView de Android TV reporta un user agent de celular (pasa seguido:
 * el UA del WebView de Capacitor en Android TV no dice "android tv").
 */
export function hasTvLikeInput() {
  if (typeof window === "undefined") return false;
  // Nota: no se mira "ontouchstart" in window porque varios navegadores lo
  // definen aunque el aparato no tenga pantalla tactil. maxTouchPoints si
  // es confiable: 0 en Android TV, >=1 en celulares y tablets.
  const noTouch = (navigator.maxTouchPoints || 0) === 0;
  const noHover = window.matchMedia
    ? window.matchMedia("(hover: none)").matches
    : false;
  const screenSide = Math.max(window.screen?.width || 0, window.screen?.height || 0);
  return noTouch && noHover && screenSide >= 900;
}

/**
 * Deteccion definitiva de "estoy en un televisor", en este orden:
 *   1. Bandera nativa del APK (UiModeManager).
 *   2. User agent de TV (navegadores de Smart TV, y el APK de TV que se
 *      marca a si mismo con "ColevanaTV").
 *   3. Dentro del APK: aparato sin touch ni hover con pantalla grande.
 *
 * Antes solo existia (2), y por eso el APK corriendo en un Android TV real
 * muchas veces NO se reconocia como TV: el user agent del WebView es el de
 * un Android comun. Ese era el motivo de que el reproductor propio no se
 * pusiera en pantalla completa en el televisor.
 */
export function isTvDevice() {
  const nativeFlag = nativeTvFlag();
  if (nativeFlag !== null) return nativeFlag;
  if (isLikelyTvBrowser()) return true;
  return isNativeAppShell() && hasTvLikeInput();
}

export function applyDeviceClass() {
  if (typeof document === "undefined") return false;
  const isTv = isTvDevice();
  document.documentElement.classList.toggle("tv-device", isTv);
  return isTv;
}
