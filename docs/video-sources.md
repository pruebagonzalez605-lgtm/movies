# Calidades y subtitulos

Todos los videos que solo tengan la propiedad `src` se consideran 1080p.

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
