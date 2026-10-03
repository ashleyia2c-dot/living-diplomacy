// Readable Node.js alternative to the standalone executable. It never installs
// or changes a game pack; the Workshop or the player handles that separately.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfig } from "../src/config.js";
import { checkInstalledPack } from "../src/pack-compat.js";
import { chooseBundle } from "../src/bundle-loader.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required.");
  // Both direct CLI launches and BAT shortcuts must read settings and profiles
  // from this extraction folder, never from the caller's current directory.
  process.chdir(root);
  // Any installed copy will do: compatibility is checked by protocol once the
  // game runs, so a Steam update rarely needs a new companion.
  const result = checkInstalledPack(getConfig().wh3Root);
  if (!result.ok) throw new Error(`${result.reason}\nChecked: ${result.candidates.join("\nChecked: ")}`);
  console.log(`Living Diplomacy mod found: ${result.pack}`);
  if (result.warning) console.warn(result.warning);
  if (process.argv.includes("--check")) process.exit(0);
  // Do not import history or start a second provider while another companion is
  // writing the same stable data folder. The user decides which window to close.
  let alreadyRunning = false;
  try {
    const response = await fetch("http://127.0.0.1:" + getConfig().port + "/api/events", {signal:AbortSignal.timeout(1500)});
    alreadyRunning = response.ok;
  } catch { /* No local companion at this port. */ }
  if (alreadyRunning) {
    console.log("A Living Diplomacy companion is already running. Close its window before starting another one.");
    process.exit(0);
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  console.log("Keep Player2 open and signed in. Leave this window open while playing.");
  // The mod carries the companion of its own release (src/bundle-loader.js): when Steam
  // has brought a newer one than this folder, run that one instead.
  let entry = "src/companion.js";
  const choice = process.env.LLMDIP_NO_PACK_BUNDLE === "1" ? { bundle: null } : chooseBundle(result.found.map(item => item.pack), version);
  if (choice.skipped) console.warn(`Note: ${choice.skipped}.`);
  if (choice.bundle) {
    entry = path.join(os.tmpdir(), `living-diplomacy-companion-${choice.bundle.version}.cjs`);
    fs.writeFileSync(entry, choice.bundle.code, "utf8");
    console.log(`Companion ${choice.bundle.version}, updated through the mod (this folder: ${version}).`);
  }
  const child = spawnSync(process.execPath, [entry], {
    cwd: root, windowsHide: true, stdio: "inherit",
    // No LLMDIP_DATA_DIR: memory goes to the fixed per-user folder, and an older
    // "data" folder next to this BAT is copied there on start-up.
    env: { ...process.env, LLMDIP_PROVIDER: "player2" }
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(`Living Diplomacy: ${error.message}`);
  process.exitCode = 1;
}
