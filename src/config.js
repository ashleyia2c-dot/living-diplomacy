import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Player2 Game Client Id, from https://player2.game/profile/developer
// (create the game there; it does not need to be published for attribution to work).
// It is NOT a secret: it ships inside the build, as in Player2's Unity/Godot SDKs.
// It is the production fallback, so attribution survives a deleted or edited .env.
// LLMDIP_PLAYER2_GAME_KEY overrides it for testing.
export const PLAYER2_GAME_CLIENT_ID = "01a0a8a9-8c98-7b76-8a12-b6a532ac0cb7";

// As a packaged .exe, cwd is wherever the player double-clicked.
// .env and data/ are anchored next to the program so they do not depend on cwd.
function baseDir() {
  try {
    const sea = process.getBuiltinModule?.("node:sea");
    if (sea?.isSea?.()) return path.dirname(process.execPath);
  } catch { /* Node sin node:sea: comportamiento de desarrollo. */ }
  return process.cwd();
}

function loadDotEnv(file = path.join(baseDir(), ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const DEFAULT_WH3_ROOT = "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III";
const WH3_SUBPATH = path.join("steamapps", "common", "Total War WARHAMMER III");

function steamRootsFromRegistry() {
  const roots = [];
  const keys = [
    ["HKCU\Software\Valve\Steam", "SteamPath"],
    ["HKLM\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"],
    ["HKLM\SOFTWARE\Valve\Steam", "InstallPath"]
  ];
  for (const [key, value] of keys) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", value],
        { encoding: "utf8", windowsHide: true, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      const match = out.match(/REG_SZ\s+(.+)/);
      if (match) roots.push(match[1].trim());
    } catch { /* Steam no registrado por esa via. */ }
  }
  return roots;
}

// A Steam library can be on any drive, and people move large games off C:.
// libraryfolders.vdf is the authoritative list of libraries.
function librariesFrom(steamRoot) {
  try {
    const file = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
    const text = fs.readFileSync(file, "utf8");
    return [...text.matchAll(/"path"\s+"([^"]+)"/g)].map(match => match[1].replace(/\\/g, "\\"));
  } catch { return []; }
}

// Published builds run on other people's PCs: a fixed path under C:\Program Files
// only matches default installations.
export function detectWh3Root() {
  if (process.env.WH3_ROOT) return process.env.WH3_ROOT;
  const steamRoots = [
    ...steamRootsFromRegistry(),
    "C:/Program Files (x86)/Steam",
    "C:/Program Files/Steam"
  ];
  const candidates = [];
  for (const steamRoot of steamRoots) candidates.push(steamRoot, ...librariesFrom(steamRoot));
  for (const drive of ["C", "D", "E", "F", "G", "H"]) {
    candidates.push(`${drive}:/SteamLibrary`, `${drive}:/Steam`, `${drive}:/Games/SteamLibrary`);
  }
  for (const library of new Set(candidates)) {
    const root = path.join(library, WH3_SUBPATH);
    if (fs.existsSync(path.join(root, "Warhammer3.exe"))) return root;
  }
  return DEFAULT_WH3_ROOT;
}

export function wh3RootLooksValid(root) {
  try { return fs.existsSync(path.join(root, "Warhammer3.exe")); } catch { return false; }
}

// Warhammer III is played in 13 languages. REPLIES already come in the player's
// language because the prompt makes them mirror the player's message; PROACTIVE
// letters have no message to mirror, so the model must be told which language to use.
const LANGUAGE_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  ru: "Russian", pl: "Polish", cs: "Czech", tr: "Turkish", ko: "Korean",
  ja: "Japanese", nl: "Dutch", sv: "Swedish", uk: "Ukrainian"
};

// Warhammer III stores ITS language in the user preferences, which may differ from
// Windows: many people play in English on a system in another language. This is the
// right source; the system locale is only used if the game leaves it blank.
// Note: the game uses its own codes (sp/ge/kr/cz/br) besides the standard ones.
const GAME_LANGUAGE_CODES = {
  en: "English", fr: "French", it: "Italian", ru: "Russian", pl: "Polish",
  tr: "Turkish", es: "Spanish", sp: "Spanish", de: "German", ge: "German",
  ko: "Korean", kr: "Korean", cs: "Czech", cz: "Czech", ja: "Japanese",
  br: "Brazilian Portuguese", pt: "Brazilian Portuguese",
  cn: "Simplified Chinese", zh: "Traditional Chinese"
};

export function gameLanguageCode(appData = process.env.APPDATA || "") {
  const file = path.join(appData, "The Creative Assembly", "Warhammer3", "scripts",
    "preferences.script.txt");
  try {
    for (const line of fs.readFileSync(file, "utf8").split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("language_text")) continue;
      const open = trimmed.indexOf(String.fromCharCode(34));
      const close = trimmed.indexOf(String.fromCharCode(34), open + 1);
      if (open >= 0 && close > open) return trimmed.slice(open + 1, close).trim().toLowerCase();
    }
  } catch { /* Sin preferencias: se cae al locale del sistema. */ }
  return "";
}

export function detectLanguage() {
  if (process.env.LLMDIP_LANGUAGE) return process.env.LLMDIP_LANGUAGE;
  const fromGame = GAME_LANGUAGE_CODES[gameLanguageCode()];
  if (fromGame) return fromGame;
  try {
    const locale = (Intl.DateTimeFormat().resolvedOptions().locale || "en").toLowerCase();
    const primary = locale.split("-")[0];
    if (primary === "zh") return locale.includes("tw") || locale.includes("hant")
      ? "Traditional Chinese" : "Simplified Chinese";
    if (primary === "pt") return locale.includes("br") ? "Brazilian Portuguese" : "Portuguese";
    return LANGUAGE_NAMES[primary] || "English";
  } catch { return "English"; }
}

// Codes of the mod's text table (mod/script/campaign/mod/llm_diplomacy.lua).
// A language without a table falls back to English inside the Lua itself.
const UI_LANGUAGE_CODES = {
  English: "en", Spanish: "es", French: "fr", German: "de", Italian: "it",
  Russian: "ru", Polish: "pl", Czech: "cs", Turkish: "tr", Korean: "ko",
  "Brazilian Portuguese": "pt", Portuguese: "pt",
  "Simplified Chinese": "zh", "Traditional Chinese": "tw"
};

export function uiLanguageCode(language) {
  return UI_LANGUAGE_CODES[language || ""] || "en";
}

export function getConfig() {
  loadDotEnv();
  const wh3Root = detectWh3Root();
  const provider = (process.env.LLMDIP_PROVIDER || "player2").toLowerCase();
  if (!new Set(["player2", "openai"]).has(provider)) throw new Error("LLMDIP_PROVIDER must be player2 or openai");
  return {
    provider,
    player2Url: (process.env.LLMDIP_PLAYER2_URL || "").replace(/\/$/, ""),
    player2Profile: process.env.LLMDIP_PLAYER2_PROFILE || "",
    player2GameKey: process.env.LLMDIP_PLAYER2_GAME_KEY || PLAYER2_GAME_CLIENT_ID,
    player2Tts: false, // This branch is deliberately text-only.
    player2TtsLanguage: process.env.LLMDIP_PLAYER2_TTS_LANGUAGE || "",
    player2TtsSpeed: Math.min(4, Math.max(0.25, Number(process.env.LLMDIP_PLAYER2_TTS_SPEED || 1))),
    appData: process.env.APPDATA || "",
    baseUrl: (process.env.LLMDIP_BASE_URL || "https://api.x.ai/v1").replace(/\/$/, ""),
    model: process.env.LLMDIP_MODEL || "grok-4-1-fast-reasoning",
    apiKey: process.env.LLMDIP_API_KEY || "",
    wh3Root,
    language: detectLanguage(),
    uiLanguage: uiLanguageCode(detectLanguage()),
    scriptLog: process.env.WH3_SCRIPT_LOG || "",
    inboxFile: path.join(wh3Root, "exec", "llm_diplomacy_inbox.lua"),
    dataDir: path.resolve(baseDir(), process.env.LLMDIP_DATA_DIR || "data"),
    pollMs: Math.max(200, Number(process.env.LLMDIP_POLL_MS || 500)),
    port: Math.max(1024, Number(process.env.LLMDIP_PORT || 43127))
  };
}
