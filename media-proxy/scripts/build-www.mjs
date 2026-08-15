#!/usr/bin/env node
/**
 * build-www.mjs
 * ---------------------------------------------------------------------------
 * Genera la carpeta `www/` que Capacitor necesita para empaquetar la app
 * (Android/Android TV). Copia el sitio estático que vive en la raíz del
 * repo (../ respecto a media-proxy/) hacia media-proxy/www.
 *
 * Uso:
 *   node scripts/build-www.mjs
 *   (normalmente se invoca vía "npm run build:www" o "npm run cap:sync")
 * ---------------------------------------------------------------------------
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// media-proxy/scripts -> media-proxy -> raíz del repo (donde vive el sitio)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MEDIA_PROXY_ROOT = path.resolve(__dirname, "..");
const WWW_DIR = path.join(MEDIA_PROXY_ROOT, "www");

// Archivos HTML sueltos en la raíz del sitio que hay que empaquetar
const HTML_FILES = [
  "index.html",
  "movies.html",
  "player.html",
  "sagas.html",
  "search.html",
  "series.html",
  "sugerencias.html",
];

// Otros archivos sueltos necesarios para que el sitio funcione
const ROOT_FILES = ["site.webmanifest"];

// Carpetas completas que hay que copiar tal cual
const DIRECTORIES = ["assets", "src"];

async function log(msg) {
  console.log(`[build-www] ${msg}`);
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function cleanWwwDir() {
  if (await pathExists(WWW_DIR)) {
    await fs.rm(WWW_DIR, { recursive: true, force: true });
    await log("Carpeta www/ anterior eliminada.");
  }
  await fs.mkdir(WWW_DIR, { recursive: true });
}

async function copyFileIfExists(relativePath) {
  const src = path.join(PROJECT_ROOT, relativePath);
  const dest = path.join(WWW_DIR, relativePath);

  if (!(await pathExists(src))) {
    await log(`AVISO: no se encontró "${relativePath}", se omite.`);
    return;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  await log(`Copiado archivo: ${relativePath}`);
}

async function copyDirIfExists(relativePath) {
  const src = path.join(PROJECT_ROOT, relativePath);
  const dest = path.join(WWW_DIR, relativePath);

  if (!(await pathExists(src))) {
    await log(`AVISO: no se encontró la carpeta "${relativePath}", se omite.`);
    return;
  }

  await fs.cp(src, dest, { recursive: true });
  await log(`Copiada carpeta: ${relativePath}/`);
}

async function writeCapacitorEntryFallback() {
  // Capacitor espera un index.html en la raíz de www/. Si por algún motivo
  // no existe (build incompleto), generamos uno mínimo para evitar que
  // `cap sync` falle, en vez de romper todo el proceso silenciosamente.
  const indexPath = path.join(WWW_DIR, "index.html");
  if (!(await pathExists(indexPath))) {
    await log("ERROR: no se generó index.html en www/. Creando fallback mínimo.");
    await fs.writeFile(
      indexPath,
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Colevana</title></head><body><h1>Falta el index.html real del sitio</h1></body></html>\n`,
      "utf-8"
    );
  }
}

async function main() {
  await log(`Proyecto raíz detectado en: ${PROJECT_ROOT}`);
  await log(`Destino (www) en: ${WWW_DIR}`);

  await cleanWwwDir();

  for (const file of HTML_FILES) {
    await copyFileIfExists(file);
  }

  for (const file of ROOT_FILES) {
    await copyFileIfExists(file);
  }

  for (const dir of DIRECTORIES) {
    await copyDirIfExists(dir);
  }

  await writeCapacitorEntryFallback();

  await log("Build de www/ completado ✔");
}

main().catch((err) => {
  console.error("[build-www] Falló el build:", err);
  process.exit(1);
});
