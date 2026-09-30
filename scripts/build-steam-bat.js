// Player-facing Workshop companion: BAT + readable runtime source, no EXE,
// second game pack, developer tooling, private settings or saved conversations.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const release = path.join(root, "release", version);
const name = `Living-Diplomacy-Steam-BAT-${version}`;
const folder = path.join(release, name);
const zip = path.join(release, `${name}.zip`);
if (fs.existsSync(folder) || fs.existsSync(zip)) throw new Error(`Existing BAT release is preserved: ${folder}`);
fs.mkdirSync(path.join(folder, "scripts"), { recursive: true });
for (const directory of ["src", "lore-profiles"]) {
  fs.cpSync(path.join(root, directory), path.join(folder, directory), { recursive: true, errorOnExist: true });
}
fs.copyFileSync(path.join(root, "scripts", "start-workshop.js"), path.join(folder, "scripts", "start-workshop.js"));
fs.copyFileSync(path.join(root, "START_PLAYER2.bat"), path.join(folder, "START_PLAYER2.bat"));
fs.copyFileSync(path.join(root, `README_STEAM_BAT_${version}.txt`), path.join(folder, "READ_ME_FIRST.txt"));
fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({
  name: "living-diplomacy-steam-companion", version, private: true,
  type: "module", engines: { node: ">=20" }
}, null, 2) + "\n");
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -LiteralPath "${folder}" -DestinationPath "${zip}"`],
  { stdio: "pipe", windowsHide: true });
console.log(`Steam BAT companion (no EXE, no pack): ${zip}`);
