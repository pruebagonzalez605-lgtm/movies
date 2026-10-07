# Colevana

Sitio web de catalogo y reproduccion. Los archivos HTML de la raiz son las
paginas publicas; `src/scripts/`, `src/styles/` y `assets/` contienen los
modulos y recursos que usan esas paginas.

## Componentes

- `src/scripts/data/`: catalogo de peliculas y series.
- `media-proxy/src/index.js`: Worker de Cloudflare para video.
- `media-proxy/android/`: proyecto Android TV / Capacitor.
- `tools/` y `.github/workflows/`: herramientas para el catalogo y los videos.

## Comprobar cambios

Desde `media-proxy/`, ejecuta `node --test test/apk-updates.test.mjs test/index.test.js test/stream-discovery.test.mjs test/tv-controls.test.mjs test/tv-visibility.test.mjs test/external-playback.test.mjs` para las
pruebas del Worker, descubrimiento de fuentes, controles de TV y actualizaciones. Para sincronizar la
web incluida en el proyecto Android, ejecuta `npm run cap:sync`.

El sitio dentro de la APK carga `https://colevana.com`, por lo que un cambio
en Java requiere compilar y publicar una APK nueva. Los releases de la APK
usan tags `1.0.30`, `1.0.31`, etc.; los releases de peliculas usan otra serie.
