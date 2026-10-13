import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPlayer2Root, player2Chat, player2Speak, resetPlayer2Connection, resetPlayer2Voices, pickVoice } from "../src/player2-client.js";

function response(value, ok = true, status = 200) {
  return { ok, status, json: async () => value, text: async () => JSON.stringify(value) };
}

test("discovers the dynamic Player2 port from APPDATA", () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "player2-appdata-"));
  const directory = path.join(appData, "game.player2.client");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "api.port"), "54321\n");
  assert.equal(discoverPlayer2Root({ appData }), "http://127.0.0.1:54321");
  fs.rmSync(appData, { recursive: true, force: true });
});

test("uses Player2 selected model without forcing a model id", async () => {
  resetPlayer2Connection();
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/health")) return response({ client_version: "test" });
    return response({ model: "selected-in-player2", choices: [{ message: { content: "Hola" } }] });
  };
  const result = await player2Chat({ player2Url: "http://127.0.0.1:4315", player2GameKey: "" }, [{ role: "user", content: "Hola" }], fakeFetch);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(result.text, "Hola");
  assert.equal(body.model, undefined);
  assert.equal(calls[1].url, "http://127.0.0.1:4315/v1/chat/completions");
});

test("sends TTS to Player2 with the curated leader gender", async () => {
  resetPlayer2Connection();
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/health")) return response({ client_version: "test" });
    return response({ data: "" });
  };
  await player2Speak(
    { player2Url: "http://127.0.0.1:4315", player2GameKey: "", player2Tts: true, player2TtsSpeed: 1, player2TtsLanguage: "" },
    "Por el Imperio.",
    { leader: "Karl Franz", voiceGender: "male" },
    fakeFetch
  );
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.play_in_app, true);
  assert.equal(body.voice_gender, "male");
  assert.equal(calls[1].url, "http://127.0.0.1:4315/v1/tts/speak");
});

test("each lord speaks the game's language with a voice of their own (0.45)", async () => {
  resetPlayer2Connection(); resetPlayer2Voices();
  const voices = [
    { id: "es-m1", language: "spanish", gender: "male" }, { id: "es-m2", language: "spanish", gender: "male" },
    { id: "es-f1", language: "spanish", gender: "female" }, { id: "gb-m1", language: "british_english", gender: "male" },
    { id: "fr-f1", language: "french", gender: "female" }
  ];
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/health")) return response({ client_version: "test" });
    if (url.endsWith("/v1/tts/voices")) return response({ voices });
    return response({ data: "" });
  };
  const config = { player2Url: "http://127.0.0.1:4315", player2GameKey: "", player2Tts: true, player2TtsSpeed: 1, player2TtsLanguage: "" };
  const spoken = async (profile, language) => {
    await player2Speak(config, "Hola.", profile, fakeFetch, { language });
    return JSON.parse(calls.filter(c => c.url.endsWith("/v1/tts/speak")).at(-1).options.body);
  };
  const katarin = await spoken({ leader: "Katarin", leaderSubtype: "wh3_main_ksl_katarin", voiceGender: "female" }, "Spanish");
  assert.deepEqual([katarin.voice_language, katarin.voice_ids], ["es_ES", ["es-f1"]]);
  const arkhan = await spoken({ leader: "Arkhan", leaderSubtype: "wh2_dlc09_tmb_arkhan", voiceGender: "male" }, "Spanish");
  assert.equal(arkhan.voice_language, "es_ES");
  assert.ok(["es-m1", "es-m2"].includes(arkhan.voice_ids[0]));
  assert.deepEqual((await spoken({ leader: "Arkhan", leaderSubtype: "wh2_dlc09_tmb_arkhan", voiceGender: "male" }, "Spanish")).voice_ids, arkhan.voice_ids, "always the same voice");
  const english = await spoken({ leader: "Louen", leaderSubtype: "wh_main_brt_louen", voiceGender: "male" }, "English");
  assert.deepEqual([english.voice_language, english.voice_ids], ["en_GB", ["gb-m1"]], "an English game speaks English");
  const before = calls.length;
  for (const language of ["French", "German", "Russian", "Korean"]) {
    assert.equal(await player2Speak(config, "Bonjour.", { leader: "Louen", voiceGender: "male" }, fakeFetch, { language }), false, language);
  }
  assert.equal(calls.filter((c, i) => i >= before && c.url.endsWith("/v1/tts/speak")).length, 0, "no foreign accent: no voice at all");
  assert.equal(calls.filter(c => c.url.endsWith("/v1/tts/voices")).length, 1, "the voice list is asked once");
  assert.equal(pickVoice([], "es_ES", "male", "x"), null);
  assert.equal(pickVoice(voices, "fr_FR", "male", "x"), null, "never another language's voice");
});

test("a reply that spent the whole cap reasoning is asked once more with room to finish (0.45)", async () => {
  resetPlayer2Connection();
  const caps = [];
  const fakeFetch = async (url, options = {}) => {
    if (url.endsWith("/health")) return response({ client_version: "test" });
    const cap = JSON.parse(options.body).max_tokens;
    caps.push(cap);
    if (cap === 2500) return response({ model: "deepseek-flash", choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }], usage: { completion_tokens: 2500 } });
    return response({ model: "deepseek-flash", choices: [{ message: { role: "assistant", content: "Hecho. [diplo:reject] [relation:delta=0;reason=neutral]" } }], usage: { completion_tokens: 3100 } });
  };
  const config = { player2Url: "http://127.0.0.1:4315", player2GameKey: "" };
  const reply = await player2Chat(config, [{ role: "user", content: "x" }], fakeFetch);
  assert.match(reply.text, /^Hecho/);
  assert.deepEqual(caps, [2500, 8000]);
  // A plain refusal (no text, cap not reached) is not asked again, and says why.
  caps.length = 0;
  const refusing = async (url, options = {}) => {
    if (url.endsWith("/health")) return response({ client_version: "test" });
    caps.push(JSON.parse(options.body).max_tokens);
    return response({ model: "m", choices: [{ message: { content: null }, finish_reason: "content_filter" }], usage: { completion_tokens: 3 } });
  };
  resetPlayer2Connection();
  await assert.rejects(player2Chat(config, [{ role: "user", content: "x" }], refusing), /finish_reason=content_filter/);
  assert.deepEqual(caps, [2500]);
});
