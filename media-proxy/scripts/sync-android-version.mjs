#!/usr/bin/env node
/**
 * sync-android-version.mjs
 * ---------------------------------------------------------------------------
 * Lee la version "fuente de verdad" desde src/scripts/config/app-version.js
 * (la misma que usa el modal de "actualizacion disponible" en la app) y la
 * escribe automaticamente en android/app/build.gradle, tanto en:
 *
 *   - versionName: string visible para el usuario (Ajustes > Apps, etc).
 *   - versionCode: entero que Android usa internamente para decidir si un
 *     APK es "mas nuevo" que el instalado. Se deriva matematicamente de
 *     APP_VERSION, asi que SIEMPRE sube cuando subis la version, sin tener
 *     que acordarte de tocarlo a mano.
 *
 * Se ejecuta automaticamente como parte de "npm run cap:sync", asi que ya
 * no hace falta editar build.gradle a mano nunca mas: basta con actualizar
 * APP_VERSION en app-version.js (que ya haciamos) y todo lo demas se
 * sincroniza solo antes de generar el APK.
 *
 * Uso:
 *   node scripts/sync-android-version.mjs
 *   (normalmente se invoca via "npm run sync:version" o "npm run cap:sync")
 * ---------------------------------------------------------------------------
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// media-proxy/scripts -> media-proxy -> raiz del repo (donde vive app-version.js)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const MEDIA_PROXY_ROOT = path.resolve(__dirname, "..");

const APP_VERSION_FILE = path.join(
  PROJECT_ROOT,
  "src",
  "scripts",
  "config",
  "app-version.js"
);
const BUILD_GRADLE_FILE = path.join(
  MEDIA_PROXY_ROOT,
  "android",
  "app",
  "build.gradle"
);

async function log(msg) {
  console.log(`[sync-android-version] ${msg}`);
}

async function readAppVersion() {
  const content = await fs.readFile(APP_VERSION_FILE, "utf8");
  const match = content.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
  if (!match) {
    throw new Error(
      `No se pudo encontrar APP_VERSION dentro de ${APP_VERSION_FILE}`
    );
  }
  return match[1].trim();
}

// Convierte "1.0.29" -> [1, 0, 29]. Cada segmento se interpreta como
// numero entero (sin ceros a la izquierda con significado especial).
function parseVersionParts(version) {
  const parts = version
    .replace(/^v/i, "")
    .split(".")
    .map((part) => parseInt(part, 10));

  if (parts.some((part) => Number.isNaN(part))) {
    throw new Error(
      `APP_VERSION "${version}" tiene un formato invalido (se espera algo tipo "1.0.29").`
    );
  }
  return parts;
}

// Deriva un versionCode entero, creciente, a partir de la version textual.
// Formula: major*1_000_000 + minor*1_000 + patch.
// Sirve mientras minor y patch se mantengan por debajo de 1000, que es
// mas que suficiente para el ciclo de vida normal de esta app. Si algun
// segmento se pasa de ese rango, lanzamos un error en vez de generar un
// versionCode incorrecto silenciosamente.
function computeVersionCode(version) {
  const [major = 0, minor = 0, patch = 0] = parseVersionParts(version);

  if (minor >= 1000 || patch >= 1000) {
    throw new Error(
      `APP_VERSION "${version}" tiene un segmento demasiado grande para derivar versionCode automaticamente. Revisa el esquema de versionado.`
    );
  }

  return major * 1_000_000 + minor * 1_000 + patch;
}

async function updateBuildGradle(version, versionCode) {
  let content = await fs.readFile(BUILD_GRADLE_FILE, "utf8");

  const versionNameRegex = /versionName\s+"[^"]*"/;
  const versionCodeRegex = /versionCode\s+\d+/;

  if (!versionNameRegex.test(content) || !versionCodeRegex.test(content)) {
    throw new Error(
      `No se encontraron las lineas versionName/versionCode en ${BUILD_GRADLE_FILE}`
    );
  }

  content = content.replace(versionNameRegex, `versionName "${version}"`);
  content = content.replace(versionCodeRegex, `versionCode ${versionCode}`);

  await fs.writeFile(BUILD_GRADLE_FILE, content, "utf8");
}

async function main() {
  const version = await readAppVersion();
  const versionCode = computeVersionCode(version);

  await updateBuildGradle(version, versionCode);

  await log(
    `build.gradle actualizado -> versionName "${version}", versionCode ${versionCode}.`
  );
}

main().catch((error) => {
  console.error(`[sync-android-version] ERROR: ${error.message}`);
  process.exitCode = 1;
});
