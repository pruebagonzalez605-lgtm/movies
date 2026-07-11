# Proxy de video de Colevana

Este Cloudflare Worker reutiliza los MP4 que ya estan publicados en GitHub Releases. No descarga el archivo completo, no lo guarda y no lo recodifica: transmite el `ReadableStream` de GitHub al navegador, conserva las solicitudes HTTP `Range` y corrige las cabeceras para Safari:

- `Content-Type: video/mp4`
- `Content-Disposition: inline`
- `Accept-Ranges: bytes`
- CORS limitado al sitio configurado

El Worker solo acepta assets del repositorio `pruebagonzalez605-lgtm/movies`; no funciona como proxy abierto.

## Desplegar

Se necesita una cuenta de Cloudflare y Node.js:

```powershell
cd media-proxy
npm install
npm test
npx wrangler login
npm run deploy
```

### Si `wrangler login` muestra `upstream connect error`

Ese error ocurre antes de autenticar y no esta relacionado con el codigo del Worker. Usa una de estas rutas:

**Ruta rapida, sin login local:**

```powershell
npm install
.\deploy-worker.ps1
```

Wrangler imprimira una URL para reclamar el despliegue. Abrela en un navegador o dispositivo que pueda entrar a `dash.cloudflare.com` y reclamala dentro de los 60 minutos indicados.

El script usa automaticamente el Node 24 incluido en el workspace cuando esta disponible, porque las versiones nuevas de Wrangler requieren Node 22 o superior.

**Ruta con API Token:** crea en Cloudflare un token usando la plantilla **Edit Cloudflare Workers**. No pegues el token en ningun archivo ni lo compartas. En la misma ventana de PowerShell ejecuta:

```powershell
$env:CLOUDFLARE_API_TOKEN="PEGA_AQUI_TU_TOKEN"
npx wrangler whoami
.\deploy-worker.ps1 -Permanent
Remove-Item Env:CLOUDFLARE_API_TOKEN
```

Si el panel de Cloudflare esta bloqueado en la red actual, crea el token o reclama el despliegue desde otro navegador, el telefono con datos moviles u otra red. La API usada para desplegar puede seguir funcionando aunque el panel web este bloqueado.

Wrangler mostrara una URL parecida a:

```text
https://colevana-media.tu-usuario.workers.dev
```

Copia esa URL en `src/scripts/config/media.js`:

```js
export const MEDIA_CONFIG = {
  proxyBaseUrl: "https://colevana-media.tu-usuario.workers.dev",
};
```

Luego publica nuevamente el sitio web. No hay que modificar `movies.js`, `series.js` ni volver a subir los videos: el reproductor transforma los enlaces de Releases en tiempo de ejecucion.

## Verificar

```text
https://TU-WORKER.workers.dev/health
```

Debe responder `ok`. Para probar un MP4:

```text
https://TU-WORKER.workers.dev/video?url=URL_DE_GITHUB_CODIFICADA
```

## Limites reales

Cloudflare Workers puede transmitir respuestas sin limite impuesto al tamano del cuerpo mientras el cliente siga conectado. El plan gratuito permite actualmente 100.000 solicitudes al dia. Los MP4 grandes superan el limite de cache por objeto del plan gratuito, por lo que esta solucion corrige compatibilidad, cabeceras y saltos `Range`, pero no convierte 1080p en calidad adaptativa ni garantiza que GitHub nunca se ralentice.

Para los videos nuevos, sigue siendo recomendable publicar 720p/480p ademas de 1080p. Los archivos actuales pueden quedarse exactamente donde estan.
