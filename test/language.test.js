// Las respuestas salen en el idioma del jugador porque el prompt las hace imitar su
// mensaje. Las cartas proactivas no tienen nada que imitar, asi que el idioma se
// inyecta. Si el marcador se quedara sin sustituir, el modelo leeria "{{LANGUAGE}}".
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { detectLanguage, gameLanguageCode } from "../src/config.js";
const require = createRequire(import.meta.url);
import { systemPromptFor, SYSTEM_PROMPT } from "../src/llm-client.js";

function withEnv(value, fn) {
  const previous = process.env.LLMDIP_LANGUAGE;
  if (value === undefined) delete process.env.LLMDIP_LANGUAGE;
  else process.env.LLMDIP_LANGUAGE = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.LLMDIP_LANGUAGE;
    else process.env.LLMDIP_LANGUAGE = previous;
  }
}

test("LLMDIP_LANGUAGE manda sobre la deteccion automatica", () => {
  withEnv("Klingon", () => assert.equal(detectLanguage(), "Klingon"));
});

test("sin override devuelve un idioma real, nunca vacio", () => {
  withEnv(undefined, () => assert.ok(detectLanguage().length > 2));
});

test("el idioma se inyecta y no queda ningun marcador suelto", () => {
  for (const language of ["English", "French", "Simplified Chinese", "Brazilian Portuguese"]) {
    const prompt = systemPromptFor(language);
    assert.ok(prompt.includes(`Write 30-80 words in ${language}`), `falta el idioma ${language}`);
    assert.equal(prompt.includes("{{LANGUAGE}}"), false, "quedo el marcador sin sustituir");
  }
});

test("sin idioma cae a ingles en vez de dejar el marcador", () => {
  const prompt = systemPromptFor(undefined);
  assert.ok(prompt.includes("Write 30-80 words in English"));
  assert.equal(prompt.includes("{{LANGUAGE}}"), false);
});

test("el prompt sigue diciendo que responda en el idioma del jugador", () => {
  assert.match(SYSTEM_PROMPT, /Respond in the language used by the player/);
});

test("lee el idioma de las preferencias del JUEGO, no el de Windows", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "tw-prefs-"));
  const dir = path.join(appData, "The Creative Assembly", "Warhammer3", "scripts");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "preferences.script.txt"),
      'some_other_setting "1";\nlanguage_text "ge"; # comentario del juego\nlanguage_audio "";\n');
    assert.equal(gameLanguageCode(appData), "ge");
    assert.equal(gameLanguageCode(path.join(appData, "no-existe")), "");
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

test("el juego en blanco no rompe la deteccion", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "tw-prefs-"));
  const dir = path.join(appData, "The Creative Assembly", "Warhammer3", "scripts");
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "preferences.script.txt"), 'language_text ""; # sin fijar\n');
    assert.equal(gameLanguageCode(appData), "");
  } finally { fs.rmSync(appData, { recursive: true, force: true }); }
});

// Caso real del 16/09: preferencias del juego en blanco, juego en ingles por Steam y
// Windows en español. Las cartas salian en español porque el companion no podia saber
// el idioma real; ahora se lo dice el mod en cada peticion.
test("el idioma que manda el juego manda sobre el de Windows", async () => {
  const { languageForRequest, buildMessages } = await import("../src/llm-client.js");
  const { parseBridgeRequest } = await import("../src/protocol.js");
  const previous = process.env.LLMDIP_LANGUAGE;
  delete process.env.LLMDIP_LANGUAGE;
  try {
    const state = encodeURIComponent("turn=101,memory_parent=root,memory_head=r1,ui_language=en");
    const request = parseBridgeRequest("[LLMDIP] REQUEST|r1|camp1|wh3_dlc20_chs_sigvald|wh3_main_ksl_the_ice_court|proactive|" + state + "|Hola");
    const language = languageForRequest(request, { language: "Spanish" });
    assert.equal(language, "English");
    const system = buildMessages(request, [], {}, language)[0].content;
    assert.ok(system.includes("Write 30-80 words in English"));
  } finally {
    if (previous !== undefined) process.env.LLMDIP_LANGUAGE = previous;
  }
});

test("sin dato del juego se usa el del companion, y LLMDIP_LANGUAGE lo fuerza todo", async () => {
  const { languageForRequest } = await import("../src/llm-client.js");
  const previous = process.env.LLMDIP_LANGUAGE;
  try {
    delete process.env.LLMDIP_LANGUAGE;
    assert.equal(languageForRequest({ fields: { ui_language: "unknown" } }, { language: "Spanish" }), "Spanish");
    assert.equal(languageForRequest({ fields: { ui_language: "zh" } }, { language: "Spanish" }), "Simplified Chinese");
    process.env.LLMDIP_LANGUAGE = "German";
    assert.equal(languageForRequest({ fields: { ui_language: "en" } }, { language: "Spanish" }), "German");
  } finally {
    if (previous === undefined) delete process.env.LLMDIP_LANGUAGE;
    else process.env.LLMDIP_LANGUAGE = previous;
  }
});

// Caso real de la consola del 16/09: el mod mandaba el idioma bien (ui_language=en)
// pero su propia instruccion de carta decia "Write 30-80 words in Spanish", y el modelo
// recibia dos ordenes contradictorias.
test("la instruccion de carta del mod no fija ningun idioma", () => {
  const fsMod = require("node:fs");
  const lua = fsMod.readFileSync(new URL("../mod/script/campaign/mod/llm_diplomacy.lua", import.meta.url), "utf8");
  assert.doesNotMatch(lua, /Write 30-80 words in [A-Z]/);
});

test("un pack viejo con el idioma fijo no contradice al juego", async () => {
  const { languageForRequest, buildMessages } = await import("../src/llm-client.js");
  const { parseBridgeRequest } = await import("../src/protocol.js");
  const previous = process.env.LLMDIP_LANGUAGE;
  delete process.env.LLMDIP_LANGUAGE;
  try {
    const state = encodeURIComponent("turn=101,memory_parent=root,memory_head=r2,ui_language=en");
    const oldMessage = encodeURIComponent("You may send one brief personal letter this turn. Write 30-80 words in Spanish. The player has not spoken.");
    const request = parseBridgeRequest("[LLMDIP] REQUEST|r2|camp1|wh3_dlc20_chs_sigvald|wh3_main_ksl_the_ice_court|proactive|" + state + "|" + oldMessage);
    const messages = buildMessages(request, [], {}, languageForRequest(request, { language: "Spanish" }));
    const everything = messages.map(m => m.content).join("\n");
    assert.equal(everything.includes("in Spanish"), false, "alguna parte del prompt sigue pidiendo español");
    assert.ok(messages[0].content.includes("Write 30-80 words in English"));
  } finally {
    if (previous !== undefined) process.env.LLMDIP_LANGUAGE = previous;
  }
});
