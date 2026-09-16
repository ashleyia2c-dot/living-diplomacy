// Empaqueta el companion en un unico .exe con el runtime de Node dentro (Node SEA),
// para que el jugador no tenga que instalar Node ni ejecutar un .bat suelto.
//
//   node scripts/build-companion-exe.js
//
// El build FALLA a proposito si no hay Game Client Id: un ejecutable publicado sin
// atribucion funciona igual de bien y no genera un centimo, y nadie lo notaria.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PLAYER2_GAME_CLIENT_ID } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(ROOT, "build");
const DIST_DIR = path.join(ROOT, "dist");
const EXE = path.join(DIST_DIR, "WH3-LLM-Diplomacy-Companion.exe");
const BUNDLE = path.join(BUILD_DIR, "companion.cjs");
const BLOB = path.join(BUILD_DIR, "companion.blob");
const SEA_CONFIG = path.join(BUILD_DIR, "sea-config.json");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// node.exe viene firmado por la Node.js Foundation. Inyectar dentro rompe esa firma,
// y un binario con firma CORRUPTA levanta mas sospechas en los antivirus que uno sin
// firma. Si el SDK de Windows esta instalado, la retiramos antes de inyectar.
function findSigntool() {
  const roots = ["C:/Program Files (x86)/Windows Kits/10/bin", "C:/Program Files/Windows Kits/10/bin"];
  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      const candidate = path.join(root, version, "x64", "signtool.exe");
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return found.sort().pop();
}

if (!PLAYER2_GAME_CLIENT_ID && !process.argv.includes("--sin-atribucion")) {
  console.error([
    "",
    "  BUILD DETENIDO: falta PLAYER2_GAME_CLIENT_ID en src/config.js",
    "",
    "  Sin el, Player2 no puede atribuir el tiempo de juego a este mod y el",
    "  reparto de ingresos es cero. Crea el juego en:",
    "      https://player2.game/profile/developer",
    "  copia el Game Client Id y pegalo en src/config.js.",
    "",
    "  Para una build de pruebas sin atribucion: --sin-atribucion",
    ""
  ].join("\n"));
  process.exit(1);
}

fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// Node SEA solo admite un punto de entrada CommonJS, y el companion es ESM: esbuild
// lo aplana a un unico CJS. Por eso companion.js no puede usar top-level await.
console.log("1/4  Empaquetando el companion (ESM -> CommonJS)...");
await build({
  entryPoints: [path.join(ROOT, "src", "companion.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: BUNDLE,
  legalComments: "none"
});

console.log("2/4  Generando el blob SEA...");
fs.writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: BLOB,
  disableExperimentalSEAWarning: true,
  useCodeCache: true
}, null, 2));
execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], { stdio: "inherit" });

console.log("3/4  Copiando el runtime de Node...");
fs.rmSync(EXE, { force: true });
fs.copyFileSync(process.execPath, EXE);

const signtool = findSigntool();
if (signtool) {
  try {
    execFileSync(signtool, ["remove", "/s", EXE], { stdio: "pipe" });
    console.log("     firma original de Node retirada");
  } catch { console.log("     (no se pudo retirar la firma; no es critico)"); }
} else {
  console.log("     (sin signtool: quedara una firma invalida de Node)");
}

console.log("4/4  Inyectando el companion en el ejecutable...");
execFileSync(process.execPath, [
  path.join(ROOT, "node_modules", "postject", "dist", "cli.js"),
  EXE, "NODE_SEA_BLOB", BLOB, "--sentinel-fuse", FUSE
], { stdio: "inherit" });

const megabytes = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log("");
console.log(`Listo: ${EXE}  (${megabytes} MB)`);
console.log(PLAYER2_GAME_CLIENT_ID
  ? `Atribucion incrustada: ${PLAYER2_GAME_CLIENT_ID}`
  : "SIN ATRIBUCION (build de pruebas): no generara ingresos.");
