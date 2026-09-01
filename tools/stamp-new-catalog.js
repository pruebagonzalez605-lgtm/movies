#!/usr/bin/env node
/**
 * Detecta peliculas/series NUEVAS respecto al commit anterior
 * y les inyecta addedAt: "YYYY-MM-DD" automaticamente.
 *
 * Uso local:
 *   node tools/stamp-new-catalog.js
 *   node tools/stamp-new-catalog.js --base HEAD~1 --head HEAD
 *
 * En CI se ejecuta en cada push que toque movies.js / series.js.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const FILES = [
  "src/scripts/data/movies.js",
  "src/scripts/data/series.js",
];

function todayISO() {
  // Fecha UTC YYYY-MM-DD
  return new Date().toISOString().slice(0, 10);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    throw err;
  }
}

function extractTitles(source) {
  if (!source) return new Set();
  const titles = new Set();
  // Solo el campo title: a nivel de objeto (no tmdbTitle)
  const re = /(^|[^\w])title\s*:\s*["'`]([^"'`]+)["'`]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    titles.add(m[2].trim());
  }
  return titles;
}

function gitShow(ref, file) {
  return run(`git show ${ref}:${file}`, { allowFail: true });
}

function fileExistsInGit(ref, file) {
  return Boolean(gitShow(ref, file));
}

/**
 * Inserta addedAt justo despues de la linea title: "X"
 * solo si ese objeto aun no tiene addedAt cerca.
 */
function stampTitlesInSource(source, newTitles, dateStr) {
  if (!newTitles.size) return { text: source, stamped: [] };

  const stamped = [];
  const lines = source.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);

    const titleMatch = line.match(/^\s*title\s*:\s*["'`]([^"'`]+)["'`]\s*,?\s*$/);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    if (!newTitles.has(title)) continue;

    // Mirar un bloque de ~25 lineas hacia adelante/atras para ver si ya tiene addedAt
    const windowStart = Math.max(0, i - 2);
    const windowEnd = Math.min(lines.length - 1, i + 25);
    let already = false;
    for (let j = windowStart; j <= windowEnd; j += 1) {
      if (/\baddedAt\s*:/.test(lines[j])) {
        already = true;
        break;
      }
      // Si cerramos el objeto antes, paramos
      if (j > i && /^\s*\},?\s*$/.test(lines[j])) break;
    }
    if (already) continue;

    // Conservar indentacion del title
    const indent = (line.match(/^(\s*)/) || ["", "  "])[1];
    out.push(`${indent}addedAt: "${dateStr}",`);
    stamped.push(title);
  }

  return { text: out.join("\n"), stamped };
}

function parseArgs(argv) {
  const args = { base: "HEAD~1", head: "HEAD", date: todayISO(), write: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--base" && argv[i + 1]) {
      args.base = argv[++i];
    } else if (a === "--head" && argv[i + 1]) {
      args.head = argv[++i];
    } else if (a === "--date" && argv[i + 1]) {
      args.date = argv[++i];
    } else if (a === "--dry-run") {
      args.write = false;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let totalStamped = 0;
  const report = [];

  // Si no hay commit padre (primer commit), no hay "nuevos" vs anterior
  const parentOk = run(`git rev-parse --verify ${args.base}`, { allowFail: true });
  if (!parentOk) {
    console.log(`[stamp] No existe base ${args.base}; nada que comparar.`);
    process.exit(0);
  }

  for (const file of FILES) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      console.log(`[stamp] Skip (no existe): ${file}`);
      continue;
    }

    const currentOnDisk = fs.readFileSync(abs, "utf8");
    const previous = fileExistsInGit(args.base, file)
      ? gitShow(args.base, file)
      : "";

    const prevTitles = extractTitles(previous);
    const currTitles = extractTitles(currentOnDisk);
    const newTitles = new Set([...currTitles].filter((t) => !prevTitles.has(t)));

    if (!newTitles.size) {
      console.log(`[stamp] ${file}: sin titulos nuevos`);
      continue;
    }

    console.log(`[stamp] ${file}: nuevos -> ${[...newTitles].join(" | ")}`);

    const { text, stamped } = stampTitlesInSource(currentOnDisk, newTitles, args.date);
    if (!stamped.length) {
      console.log(`[stamp] ${file}: ya tenian addedAt`);
      continue;
    }

    report.push({ file, stamped });
    totalStamped += stamped.length;

    if (args.write) {
      fs.writeFileSync(abs, text, "utf8");
      console.log(`[stamp] ${file}: stamped ${stamped.length} -> addedAt "${args.date}"`);
    } else {
      console.log(`[stamp] dry-run: hubieran stampado ${stamped.length}`);
    }
  }

  if (!totalStamped) {
    console.log("[stamp] Nada para escribir.");
    process.exit(0);
  }

  console.log(`[stamp] Total stamped: ${totalStamped}`);
  // Salida legible para el workflow
  for (const r of report) {
    console.log(`  - ${r.file}: ${r.stamped.join(", ")}`);
  }
}

main();
