# Calidades y subtitulos

Todos los videos que solo tengan la propiedad `src` se consideran 1080p.

Para que funcionen en Safari de iPhone, los archivos deben usar H.264 (`yuv420p`) y audio AAC, tener los metadatos al inicio (`faststart`) y subirse al Release con el tipo MIME `video/mp4`. Si GitHub los entrega como `application/octet-stream`, Safari puede rechazarlos aunque Chrome los reproduzca.

Los Releases existentes no necesitan volver a subirse. El proyecto incluye `media-proxy`, un Cloudflare Worker que conserva `Range`, transmite el archivo sin cargarlo entero en memoria y corrige el MIME y la descarga forzada. Consulta `media-proxy/README.md`; despues de desplegarlo solo hay que pegar su URL en `src/scripts/config/media.js`.

## Generacion gratuita de 720p y 480p

El workflow `.github/workflows/generate-release-video-qualities.yml` procesa los Releases con GitHub Actions y nunca modifica el MP4 original.

- En Releases nuevos se ejecuta automaticamente al publicarlos.
- Para uno existente, abre **Actions > Generar calidades de video > Run workflow**.
- Escribe la etiqueta exacta, por ejemplo `1.2`.
- `asset_name` puede quedar vacio para procesar todos los MP4 originales del Release, o contener uno exacto como `MJU.mp4`.
- Las salidas se adjuntan al mismo Release como `MJU-720p.mp4` y `MJU-480p.mp4`.
- El reproductor las descubre automaticamente; no hay que editar el catalogo.

El repositorio debe permitir que GitHub Actions escriba contenido. Si la subida recibe un error de permisos, activa **Settings > Actions > General > Workflow permissions > Read and write permissions**.

```js
{
  title: "Nombre de la pelicula",
  src: "https://github.com/usuario/repositorio/releases/download/version/video.mp4",
}
```

Cuando haya otras versiones disponibles, reemplaza `src` por la fuente principal y agrega `sources`:

```js
{
  title: "Nombre de la pelicula",
  src: "https://github.com/usuario/repositorio/releases/download/version/video-1080p.mp4",
  sources: [
    {
      src: "https://github.com/usuario/repositorio/releases/download/version/video-1080p.mp4",
      type: "video/mp4",
      size: 1080,
    },
    {
      src: "https://github.com/usuario/repositorio/releases/download/version/video-720p.mp4",
      type: "video/mp4",
      size: 720,
    },
    {
      src: "https://github.com/usuario/repositorio/releases/download/version/video-480p.mp4",
      type: "video/mp4",
      size: 480,
    },
  ],
}
```

El reproductor crea el menu de calidad automaticamente. La propiedad `src` debe seguir apuntando a 1080p para identificar el contenido, guardar el progreso y usarla como respaldo.

Los subtitulos WebVTT deben guardarse en `assets/subtitles` para que se sirvan desde el mismo sitio:

```js
subtitles: [
  {
    src: "./assets/subtitles/video-es.vtt",
    label: "Espanol",
    language: "es",
    default: true,
  },
]
```

## Capturas de la linea de tiempo

El reproductor muestra capturas al pasar el cursor cuando el contenido incluye un archivo WebVTT de miniaturas:

```js
{
  title: "Nombre de la pelicula",
  src: "https://github.com/usuario/repositorio/releases/download/version/video-1080p.mp4",
  previewThumbnails: "./assets/thumbnails/video/thumbnails.vtt",
}
```

El archivo VTT puede apuntar a imagenes individuales o a un mosaico de capturas mediante fragmentos `#xywh`. Las imagenes y el VTT deben estar dentro de `assets/thumbnails` para evitar bloqueos CORS de GitHub.

El proyecto incluye un generador que crea mosaicos de capturas cada 10 segundos y el archivo VTT correspondiente. Necesita FFmpeg y ffprobe:

```powershell
.\tools\generate-video-thumbnails.ps1 `
  -InputVideo "C:\Videos\pelicula.mp4" `
  -OutputDirectory ".\assets\thumbnails\pelicula"
```
