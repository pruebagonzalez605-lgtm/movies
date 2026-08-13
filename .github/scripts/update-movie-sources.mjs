#!/usr/bin/env node
// .github/scripts/update-movie-sources.mjs
//
// Actualiza src/scripts/data/movies.js agregando o reemplazando el array
// `sources` de UNA pelicula, despues de que el workflow "Generar calidades
// de video" sube las variantes -720p/-480p al Release.
//
// No reescribe el archivo entero: localiza el bloque `{ ... }` de la
// pelicula por su `src` original (match exacto de substring) y solo edita
// ese fragmento, para no perder comentarios ni el formato del resto.
//
// Uso:
//   node update-movie-sources.mjs <originalSrcUrl> <calidadesCSV>
//
// Ejemplo:
//   node update-movie-sources.mjs \
//     "https://github.com/OWNER/REPO/releases/download/1.3/Obson.mp4" \
//     "1080,720,480"
//
// Si no encuentra ninguna entrada con ese `src`, termina con exit 0
// (no falla el job: puede ser un asset que no pertenece a movies.js).

import { readFileSync, writeFileSync } from "node:fs";

const [, , originalUrl, qualitiesArg] = process.argv;

if (!originalUrl || !qualitiesArg) {
  console.error("Uso: node update-movie-sources.mjs <originalSrcUrl> <calidadesCSV>");
  process.exit(1);
}

const qualities = [...new Set(qualitiesArg.split(",").map(Number).filter(Boolean))];

const filePath = "src/scripts/data/movies.js";
const text = readFileSync(filePath, "utf8");

// Encuentra el bloque `{ ... }` (nivel de indentacion de 2 espacios, el de
// cada entrada del array MOVIES) que contiene la URL original dada.
function findObjectContaining(source, needle) {
  const needleIndex = source.indexOf(needle);
  if (needleIndex === -1) return null;

  const openMarker = "\n  {";
  let start = source.lastIndexOf(openMarker, needleIndex);
  if (start === -1) return null;
  start += 1; // saltar el "\n" inicial, quedarnos parados en la "{"

  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return null;
  return { start, end };
}

const block = findObjectContaining(text, originalUrl);
if (!block) {
  console.log(`[update-movie-sources] No se encontro ninguna entrada con src="${originalUrl}" en ${filePath}. Se omite.`);
  process.exit(0);
}

// Calcula el nombre base (stem) a partir de la URL original, quitando un
// posible sufijo "-1080p" si el original ya lo traia (igual que hace el
// workflow al transcodificar).
function stemFromUrl(url) {
  const filename = url.split("/").pop() || "";
  return filename.replace(/-1080p\.mp4$/i, "").replace(/\.mp4$/i, "");
}

function buildSourcesBlock(url, qualitiesList) {
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const stem = stemFromUrl(url);

  const lines = [...qualitiesList]
    .sort((a, b) => b - a)
    .map((q) => {
      const fileName = q === 1080 ? `${stem}.mp4` : `${stem}-${q}p.mp4`;
      return `      { src: "${base}${fileName}", size: ${q} },`;
    })
    .join("\n");

  return `sources: [\n${lines}\n    ],`;
}

let objectText = text.slice(block.start, block.end);
const sourcesBlock = buildSourcesBlock(originalUrl, qualities);

if (/\n {4}sources:\s*\[[\s\S]*?\n {4}\],/.test(objectText)) {
  // Ya existe un array sources: se reemplaza completo.
  objectText = objectText.replace(
    /sources:\s*\[[\s\S]*?\n {4}\],/,
    sourcesBlock,
  );
} else {
  // No existe: se inserta justo despues de la linea `src: "...",`.
  const inserted = objectText.replace(
    /( {4}src:\s*"[^"]+",\n)/,
    `$1    ${sourcesBlock}\n`,
  );
  if (inserted === objectText) {
    console.log(`[update-movie-sources] No se pudo ubicar la linea "src:" dentro del bloque de "${originalUrl}". Se omite.`);
    process.exit(0);
  }
  objectText = inserted;
}

const newText = text.slice(0, block.start) + objectText + text.slice(block.end);

if (newText === text) {
  console.log(`[update-movie-sources] Sin cambios para "${originalUrl}" (calidades ya estaban al dia).`);
  process.exit(0);
}

writeFileSync(filePath, newText);
console.log(`[update-movie-sources] Actualizado: "${originalUrl}" -> calidades [${qualities.sort((a, b) => b - a).join(", ")}]`);
