// Arma la carpeta release/ con todo lo que se publica, ya separado por canal:
//   release/workshop/  -> lo que sube al Steam Workshop (solo el .pack y su imagen)
//   release/companion/ -> lo que se cuelga en Nexus o GitHub Releases (el .exe + LEEME)
//
//   node scripts/build-release.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { PLAYER2_GAME_CLIENT_ID } from "../src/config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = path.join(ROOT, "release");
const WORKSHOP = path.join(RELEASE, "workshop");
const COMPANION = path.join(RELEASE, "companion");
const PACK_NAME = "llm_diplomacy.pack";
const EXE_NAME = "WH3-LLM-Diplomacy-Companion.exe";

const pack = path.join(ROOT, "dist", PACK_NAME);
const exe = path.join(ROOT, "dist", EXE_NAME);
for (const [file, hint] of [[pack, "npm run build:pack"], [exe, "npm run build:exe"]]) {
  if (!fs.existsSync(file)) {
    console.error(`Falta ${path.basename(file)}. Ejecuta antes: ${hint}`);
    process.exit(1);
  }
}

// Mismo candado que el build del .exe: una release sin atribucion se ve idéntica,
// funciona igual y no genera un centimo. Es justo el error que no se nota.
if (!PLAYER2_GAME_CLIENT_ID && !process.argv.includes("--sin-atribucion")) {
  console.error("");
  console.error("  RELEASE DETENIDA: falta PLAYER2_GAME_CLIENT_ID en src/config.js");
  console.error("  Pega el Game Client Id, reconstruye el .exe y repite.");
  console.error("");
  process.exit(1);
}

fs.rmSync(RELEASE, { recursive: true, force: true });
fs.mkdirSync(WORKSHOP, { recursive: true });
fs.mkdirSync(COMPANION, { recursive: true });

fs.copyFileSync(pack, path.join(WORKSHOP, PACK_NAME));
fs.copyFileSync(exe, path.join(COMPANION, EXE_NAME));

// El launcher de Warhammer III exige una imagen con el MISMO nombre que el .pack.
const thumbnail = path.join(ROOT, "assets", "llm_diplomacy.png");
if (fs.existsSync(thumbnail)) {
  fs.copyFileSync(thumbnail, path.join(WORKSHOP, "llm_diplomacy.png"));
} else {
  fs.writeFileSync(path.join(WORKSHOP, "FALTA-LA-IMAGEN.txt"), [
    "Falta la miniatura del Workshop.",
    "",
    "El launcher de Total War: WARHAMMER III necesita una imagen con el MISMO",
    "nombre que el pack, en la misma carpeta:",
    "",
    "    llm_diplomacy.pack",
    "    llm_diplomacy.png",
    "",
    "Ponla en assets/llm_diplomacy.png y vuelve a ejecutar este script.",
    "Recomendado: PNG cuadrado, 512x512 o mayor, por debajo de 1 MB."
  ].join("\n"), "utf8");
}

fs.writeFileSync(path.join(COMPANION, "README.txt"), [
  "LLM Diplomacy for Total War: WARHAMMER III",
  "==========================================",
  "",
  "The AI factions write to you and answer you with a language model.",
  "It is free: no API to pay for, no key to enter.",
  "The mod follows your game language automatically.",
  "",
  "INSTALL",
  "",
  "  1. Install the Player2 app from https://player2.game and sign in.",
  "     It provides the language model. Without it the lords stay silent.",
  "  2. Subscribe to the mod on the Steam Workshop and enable it in the launcher.",
  "     (If you got this as a zip, copy llm_diplomacy.pack into the data folder",
  "      of your Total War: WARHAMMER III install and enable it in the launcher.)",
  "  3. Put this executable anywhere you like and run it BEFORE you play.",
  "     It closes itself when you close Warhammer III.",
  "  4. Play. In campaign, press LLM and pick which factions may talk to you.",
  "",
  "IF SOMETHING GOES WRONG",
  "",
  "  - \"Player2 is not open\": start the Player2 app and run this again.",
  "  - \"Total War: WARHAMMER III not found\": your game is on another drive.",
  "    Create a .env file next to this executable with one line like:",
  "        WH3_ROOT=D:/SteamLibrary/steamapps/common/Total War WARHAMMER III",
  "  - Windows warns about an unknown publisher: expected, the file is not signed.",
  "    Choose \"More info\" and \"Run anyway\".",
  "  - You want a different language than your game: add LLMDIP_LANGUAGE=English",
  "    (or French, German, Italian, Russian, Polish, Czech, Turkish, Korean,",
  "    Brazilian Portuguese, Simplified Chinese, Traditional Chinese) to that .env.",
  "",
  "PRIVACY",
  "",
  "  The companion only talks to the Player2 app on your own machine (127.0.0.1).",
  "  Conversations are stored in the data folder next to this executable.",
  ""].join("\n"), "utf8");

// Nexus, GitHub Releases y el directorio de Player2 esperan UN archivo, no dos piezas
// sueltas. El pack va dentro tambien: quien no use Steam lo necesita igual.
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const bundleName = `LLM-Diplomacy-WH3-${version}.zip`;
const bundleDir = path.join(RELEASE, bundleName.slice(0, -4));
fs.mkdirSync(bundleDir, { recursive: true });
fs.copyFileSync(exe, path.join(bundleDir, EXE_NAME));
fs.copyFileSync(pack, path.join(bundleDir, PACK_NAME));
fs.copyFileSync(path.join(COMPANION, "README.txt"), path.join(bundleDir, "README.txt"));
try {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Compress-Archive -Path "${bundleDir}" -DestinationPath "${path.join(RELEASE, bundleName)}" -Force`],
    { stdio: "pipe", windowsHide: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });
} catch (error) {
  console.warn("No se pudo comprimir el zip: " + error.message);
  console.warn("La carpeta release/bundle/ queda lista para comprimir a mano.");
}

console.log("release/ preparada:");
console.log(`  workshop/  -> ${PACK_NAME}` + (fs.existsSync(thumbnail) ? " + llm_diplomacy.png" : "  (FALTA la imagen)"));
console.log(`  companion/ -> ${EXE_NAME} + README.txt`);
if (fs.existsSync(path.join(RELEASE, bundleName))) {
  const mb = (fs.statSync(path.join(RELEASE, bundleName)).size / 1024 / 1024).toFixed(1);
  console.log(`  ${bundleName}  (${mb} MB)  -> Nexus / GitHub Releases / ficha de Player2`);
}
console.log(PLAYER2_GAME_CLIENT_ID
  ? `  atribucion: ${PLAYER2_GAME_CLIENT_ID}`
  : "  ATENCION: el .exe se construyo SIN atribucion; no generara ingresos.");
