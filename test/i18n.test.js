// La interfaz del mod se traduce con una tabla por idioma y una funcion llmdip_t.
// Dos formas silenciosas de romperlo: añadir un idioma al que le falten claves, o
// escribir mal una clave en una llamada (el jugador veria "close_dialog" en el boton).
// Esto las bloquea las dos.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "..", "mod", "script", "campaign", "mod");
const read = name => fs.readFileSync(path.join(MOD, name), "utf8");
const i18n = read("llm_diplomacy_i18n.lua");

// Los 13 idiomas en los que se publica Warhammer III.
const LANGUAGES = ["en", "es", "fr", "de", "it", "ru", "pl", "cs", "tr", "ko", "pt", "zh", "tw"];

function tables() {
  const found = {};
  for (const match of i18n.matchAll(/UI_TEXT\.([a-z]{2}) = \{([\s\S]*?)\n\}/g)) {
    found[match[1]] = match[2].split("\n")
      .map(line => (line.match(/^\s{4}([a-z_]+) = /) || [])[1])
      .filter(Boolean);
  }
  return found;
}

test("estan los 13 idiomas del juego", () => {
  const found = tables();
  for (const language of LANGUAGES) {
    assert.ok(found[language], `falta la tabla del idioma ${language}`);
  }
  assert.equal(Object.keys(found).length, LANGUAGES.length);
});

test("todos los idiomas tienen exactamente las mismas claves que el ingles", () => {
  const found = tables();
  const english = found.en;
  assert.ok(english.length >= 40, "el ingles se ha quedado corto de claves");
  for (const [language, keys] of Object.entries(found)) {
    const missing = english.filter(key => !keys.includes(key));
    const extra = keys.filter(key => !english.includes(key));
    assert.deepEqual(missing, [], `a ${language} le faltan claves`);
    assert.deepEqual(extra, [], `${language} tiene claves que el ingles no`);
  }
});

test("ninguna traduccion se quedo vacia o con el texto de otro idioma", () => {
  const spanishOnly = /[¿¡]|ción\b|Facción/;
  for (const match of i18n.matchAll(/UI_TEXT\.([a-z]{2}) = \{([\s\S]*?)\n\}/g)) {
    const [, language, body] = match;
    for (const line of body.split("\n")) {
      const entry = line.match(/^\s{4}([a-z_]+) = "(.*)",?$/);
      if (!entry) continue;
      assert.notEqual(entry[2].trim(), "", `${language}.${entry[1]} esta vacio`);
      if (language !== "es") {
        assert.doesNotMatch(entry[2], spanishOnly, `${language}.${entry[1]} se quedo en español`);
      }
    }
  }
});

test("cada clave usada en el mod existe en la tabla", () => {
  const english = tables().en;
  const used = new Set();
  for (const file of ["llm_diplomacy.lua", "llm_diplomacy_ui.lua", "llm_diplomacy_mailbox.lua"]) {
    for (const match of read(file).matchAll(/llmdip_t\("([a-z_]+)"\)/g)) used.add(match[1]);
  }
  assert.ok(used.size > 20, "casi no se esta usando la tabla: algo se quedo sin migrar");
  for (const key of used) {
    assert.ok(english.includes(key), `la clave "${key}" se usa en el mod pero no esta traducida`);
  }
});

test("la tabla no se referencia a si misma", () => {
  // Un llmdip_t dentro de la propia tabla se evalua antes de que exista la funcion.
  const body = i18n.slice(0, i18n.indexOf("function llmdip_t"));
  assert.doesNotMatch(body, /llmdip_t\(/, "hay una entrada de la tabla que llama a llmdip_t");
});

test("ningun texto usa flechas que la fuente del juego no sabe dibujar", () => {
  // En partida, "(↑ earlier · ↓ later)" se veia como "( earlier ·  later)".
  for (const file of ["llm_diplomacy_i18n.lua", "llm_diplomacy.lua", "llm_diplomacy_ui.lua", "llm_diplomacy_mailbox.lua"]) {
    assert.doesNotMatch(read(file), /[←-⇿]/, `${file} contiene flechas`);
  }
});

test("la sonda de idioma y el tooltip de actitud usan las mismas etiquetas oficiales", () => {
  // Las dos listas salen de los packs de localizacion del juego. Si una se corrige y la
  // otra no, el idioma se detectaria mal o la actitud dejaria de leerse en ese idioma.
  const table = (source, name) => {
    const body = source.match(new RegExp("local " + name + " = \\{([\\s\\S]*?)\\n\\}"));
    assert.ok(body, "no encuentro " + name);
    return Object.fromEntries([...body[1].matchAll(/^\s*([a-z]{2}) = "(.*)"/gm)].map(m => [m[1], m[2]]));
  };
  const probe = table(i18n, "LANGUAGE_PROBE");
  const attitude = table(read("llm_diplomacy_ui.lua"), "ATTITUDE_LABELS");
  assert.equal(Object.keys(probe).length, LANGUAGES.length);
  assert.deepEqual(probe, attitude);
});
