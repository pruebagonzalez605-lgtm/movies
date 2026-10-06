export const EXTERNAL_AD_NOTICE = "Este reproductor y sus anuncios pertenecen a un proveedor externo, no a Colevana. Recomendamos usar un bloqueador de anuncios (AdBlock). Algunos proveedores pueden bloquear la reproducción si lo detectan; si ocurre, prueba otra fuente.";

export function externalEmbedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    // No confundir posters, archivos directos ni recursos con reproductores.
    if (/\.(?:mp4|m3u8|webm|jpg|jpeg|png|gif|webp|svg|css|js)$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}
