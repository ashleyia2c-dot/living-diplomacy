// Readable Node.js alternative to the standalone executable. It never installs
// or changes a game pack; the Workshop or the player handles that separately.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getConfig } from "../src/config.js";
import { checkInstalledPack } from "../src/pack-compat.js";

const EXPECTED_PACK_SHA256 = "560958E6C72974AE9D3201DFFD32FED357FB3C5B92D0B396F022F9062892F245";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("Node.js 20 or newer is required.");
  // Both direct CLI launches and BAT shortcuts must read settings and profiles
  // from this extraction folder, never from the caller's current directory.
  process.chdir(root);
  const result = checkInstalledPack(getConfig().wh3Root, EXPECTED_PACK_SHA256);
  if (!result.ok) throw new Error(`${result.reason}\nChecked: ${result.candidates.join("\nChecked: ")}`);
  console.log(`Matching game pack verified: ${result.pack}`);
  if (result.warning) console.warn(result.warning);
  if (process.argv.includes("--check")) process.exit(0);
  console.log("Living Diplomacy 0.42.2 - Steam BAT companion");
  console.log("Keep Player2 open and signed in. Leave this window open while playing.");
  const child = spawnSync(process.execPath, ["src/companion.js"], {
    cwd: root, windowsHide: true, stdio: "inherit",
    env: { ...process.env, LLMDIP_PROVIDER: "player2", LLMDIP_DATA_DIR: path.join(root, "data") }
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} catch (error) {
  console.error(`Living Diplomacy: ${error.message}`);
  process.exitCode = 1;
}
