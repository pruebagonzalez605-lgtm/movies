# Sistema "Nuevos" - Catalogo Colevana

## Archivos incluidos

| Archivo | Destino en el repo |
|---------|--------------------|
| `src/scripts/shared/catalog-data.js` | Reemplazar el actual |
| `src/scripts/home.js` | Reemplazar el actual |
| `src/scripts/catalog.js` | Reemplazar el actual |
| `src/styles/catalog-new-badge.css` | Pegar el contenido en `src/styles/app.css` (reemplazar `.catalog-card-art`) |

## Uso

Al agregar una pelicula o serie nueva, incluye el campo:

```js
addedAt: "2026-08-31",
```

Ejemplo en `movies.js`:

```js
{
  code: "82",
  title: "Mi Pelicula Nueva",
  addedAt: "2026-08-31",
  gradient: ["#3d0d0d", "#8a6a1e"],
  src: "https://github.com/...",
}
```

## Comportamiento

- Items con `addedAt` reciente aparecen primero
- Sin `addedAt` o antiguos: orden por `code`
- Badge **Nuevo** visible durante 14 dias (configurable en `NEW_WINDOW_DAYS`)
