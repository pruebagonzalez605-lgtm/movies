export const MEDIA_CONFIG = {
  // Ejemplo: "https://colevana-media.tu-usuario.workers.dev"
  // Dejalo vacio para usar GitHub Releases directamente.
  proxyBaseUrl: "https://colevana-media.tall-aristosuchus.workers.dev",
};

export function resolveMediaUrl(src) {
  if (!src || !MEDIA_CONFIG.proxyBaseUrl) return src;

  try {
    const url = new URL(src);
    const isAllowedRelease = url.protocol === "https:"
      && url.hostname === "github.com"
      && url.pathname.includes("/releases/download/");
    if (!isAllowedRelease) return src;

    const proxyBase = MEDIA_CONFIG.proxyBaseUrl.replace(/\/+$/, "");
    return `${proxyBase}/video?url=${encodeURIComponent(url.href)}`;
  } catch {
    return src;
  }
}
