import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverPlayer2Root, player2Chat, player2Speak, resetPlayer2Connection } from "../src/player2-client.js";

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
