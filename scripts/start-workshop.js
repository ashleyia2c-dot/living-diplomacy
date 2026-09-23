// Companion para el articulo Workshop existente. Nunca instala ni modifica el pack.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectWh3Root } from "../src/config.js";

const EXPECTED_PACK_SHA256 = "8748BA673E4EF85525E776DEA093673C8FE6A4A1F300D95B5F99265BF8C863CC";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();

try {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Se necesita Node.js 20 o superior.");
  const game = path.resolve(detectWh3Root());
  if (!fs.existsSync(path.join(game, "Warhammer3.exe"))) {
    throw new Error("No encuentro Warhammer III. Define WH3_ROOT con la carpeta que contiene Warhammer3.exe.");
  }
  const workshopRoot = process.env.STEAM_WORKSHOP_ROOT ||
    path.join(path.resolve(game, "..", ".."), "workshop", "content", "1142710");
  if (!fs.existsSync(workshopRoot)) {
    throw new Error(`No encuentro los mods de Workshop. Ruta buscada: ${workshopRoot}`);
  }
  const candidates = fs.readdirSync(workshopRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(workshopRoot, entry.name, "llm_diplomacy.pack"))
    .filter(file => fs.existsSync(file));
  if (candidates.length === 0) {
    throw new Error("No encuentro llm_diplomacy.pack en Workshop. Suscribete y espera la descarga de Steam.");
  }
  const workshopPack = candidates.find(file => hash(file) === EXPECTED_PACK_SHA256);
  if (!workshopPack) throw new Error(`El pack de Workshop aun no es esta version. Espera la actualizacion de Steam. SHA-256 requerido: ${EXPECTED_PACK_SHA256}`);
  const manualPack = path.join(game, "data", "llm_diplomacy.pack");
  if (fs.existsSync(manualPack)) {
    console.warn(`AVISO: tambien hay un pack manual en ${manualPack}. Activa solo el de Workshop en el gestor de mods.`);
  }
  console.log(`Workshop ${path.basename(path.dirname(workshopPack))}: pack verificado (${EXPECTED_PACK_SHA256}).`);
  if (process.argv.includes("--check")) process.exit(0);

  const result = spawnSync(process.execPath, ["src/companion.js"], {
    cwd: root, windowsHide: true, stdio: "inherit",
    env: { ...process.env, LLMDIP_PROVIDER: "player2", LLMDIP_DATA_DIR: path.join(root, "data") }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Player2 Diplomacy: ${error.message}`);
  process.exitCode = 1;
}
