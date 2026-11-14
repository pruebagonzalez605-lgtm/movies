import { isNativeAppShell, isTvDevice } from "./shared/device.js";

function whenIdle(callback) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout: 1500 });
  } else {
    window.setTimeout(callback, 400);
  }
}

if (isTvDevice()) {
  whenIdle(() => import("./services/tv-app-prompt.js").catch(() => {}));
  import("./tv/spatial-nav.js").catch(() => {});
}

if (isNativeAppShell()) {
  whenIdle(() => import("./services/update-checker.js").catch(() => {}));
}
