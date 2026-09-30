// Builds a readable, executable-from-source fallback without private data.
// The standalone EXE is easier, but an unsigned EXE must never be the only path.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const release = path.join(root, "release", version);
const folderName = `Living-Diplomacy-Workshop-Source-${version}`;
const source = path.join(release, folderName);
const zip = path.join(release, `${folderName}.zip`);
if (!fs.existsSync(release)) throw new Error(`Build the paired release first: ${release}`);
if (fs.existsSync(source) || fs.existsSync(zip)) throw new Error(`Source fallback already exists; refusing to overwrite ${source}`);

fs.mkdirSync(source);
for (const directory of ["src", "scripts", "lore-profiles", "mod", "assets", "test"]) {
  fs.cpSync(path.join(root, directory), path.join(source, directory), { recursive: true, errorOnExist: true });
}
for (const filename of ["package.json", "package-lock.json", "START_PLAYER2.bat",
  `README_SOURCE_${version}.txt`, `README_STEAM_BAT_${version}.txt`,
  `STEAM_DESCRIPTION_${version}.txt`]) {
  fs.copyFileSync(path.join(root, filename), path.join(source, filename));
}
fs.copyFileSync(path.join(root, `README_SOURCE_${version}.txt`), path.join(source, "README.txt"));
execFileSync("powershell", ["-NoProfile", "-Command",
  `Compress-Archive -LiteralPath "${source}" -DestinationPath "${zip}"`],
  { stdio: "pipe", windowsHide: true });
console.log(`Readable source fallback: ${zip}`);
