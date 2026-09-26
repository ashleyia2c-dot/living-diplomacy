// Companion launcher for the existing Workshop item. It never installs or modifies the pack.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectWh3Root } from "../src/config.js";

const EXPECTED_PACK_SHA256 = "588BB2465D7416DBBCEB65F5FBB6FC76A21B2607CADF151CA001473EE4C1AB01";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();

try {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required.");
  const game = path.resolve(detectWh3Root());
  if (!fs.existsSync(path.join(game, "Warhammer3.exe"))) {
    throw new Error("WARHAMMER III was not found. Set WH3_ROOT to the folder containing Warhammer3.exe.");
  }
  const workshopRoot = process.env.STEAM_WORKSHOP_ROOT ||
    path.join(path.resolve(game, "..", ".."), "workshop", "content", "1142710");
  if (!fs.existsSync(workshopRoot)) {
    throw new Error(`Steam Workshop files were not found at: ${workshopRoot}`);
  }
  const candidates = fs.readdirSync(workshopRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(workshopRoot, entry.name, "llm_diplomacy.pack"))
    .filter(file => fs.existsSync(file));
  if (candidates.length === 0) {
    throw new Error("llm_diplomacy.pack was not found in Workshop. Subscribe and wait for Steam to finish downloading.");
  }
  const workshopPack = candidates.find(file => hash(file) === EXPECTED_PACK_SHA256);
  if (!workshopPack) throw new Error(`The Workshop pack is not yet this version. Wait for Steam to update it. Required SHA-256: ${EXPECTED_PACK_SHA256}`);
  const manualPack = path.join(game, "data", "llm_diplomacy.pack");
  if (fs.existsSync(manualPack)) {
    console.warn(`WARNING: a manual pack also exists at ${manualPack}. Enable only the Workshop version in the game launcher.`);
  }
  console.log(`Workshop ${path.basename(path.dirname(workshopPack))}: game pack verified (${EXPECTED_PACK_SHA256}).`);
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
