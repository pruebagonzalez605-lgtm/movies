#!/usr/bin/env node
// Pone la misma version de cache (?v=...) en todos los HTML de la raiz y en
// los JS/CSS de src/. Ejecutar antes de cada push para que los navegadores
// descarguen los archivos nuevos en vez de usar los guardados en cache.
//
//   node tools/bump-version.mjs            -> ?v=AAAAMMDD-HHMM (hora actual)
//   node tools/bump-version.mjs mi-etiqueta -> ?v=mi-etiqueta
//
// Usar una sola version tambien evita que un mismo modulo se cargue dos veces
// por importarse con dos ?v= distintos desde archivos diferentes.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stamp = process.argv[2]
  || `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

if (!/^[A-Za-z0-9._-]+$/.test(stamp)) {
  console.error(`Version no valida: "${stamp}". Usa solo letras, numeros, punto, guion o guion bajo.`);
  process.exit(1);
}

function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(name))) out.push(full);
  }
  return out;
}

const files = [
  ...readdirSync(root).filter((name) => name.endsWith(".html")).map((name) => join(root, name)),
  ...walk(join(root, "src"), [".js", ".mjs", ".css"]),
];

// Solo URLs locales: "./algo.js?v=", "../x.css?v=", "/src/...?v=" o "algo.js?v=".
const pattern = /(\.(?:js|mjs|css)\?v=)[A-Za-z0-9._-]+/g;
let changedFiles = 0;
let replacements = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  let count = 0;
  const next = text.replace(pattern, (_, prefix) => {
    count += 1;
    return `${prefix}${stamp}`;
  });
  if (next !== text) {
    writeFileSync(file, next);
    changedFiles += 1;
    replacements += count;
  }
}

console.log(`Version ${stamp}: ${replacements} referencias actualizadas en ${changedFiles} archivos.`);
