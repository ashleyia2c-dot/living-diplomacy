// El reparto de ingresos de Player2 depende de dos cosas y solo dos: que cada peticion
// lleve el Game Client Id en player2-game-key, y que se pinguee /v1/health cada 60s para
// que puedan medir el time-spent. Si esto se rompe, el mod sigue funcionando perfectamente
// y deja de generar ingresos en silencio, que es la peor forma de romperse.
import test from "node:test";
import assert from "node:assert/strict";
import {
  player2Chat, player2Heartbeat, player2Speak, player2AppDetected, resetPlayer2Connection
} from "../src/player2-client.js";

const GAME_KEY = "test-game-client-id";
const CONFIG = { player2Url: "http://127.0.0.1:4315", player2GameKey: GAME_KEY };

function response(value, ok = true, status = 200) {
  return { ok, status, json: async () => value, text: async () => JSON.stringify(value) };
}

function recorder(handler) {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/health")) return response({ client_version: "test" });
    return handler ? handler(url, options) : response({});
  };
  return { calls, fakeFetch };
}

test("el heartbeat pingea /v1/health con el game key", async () => {
  resetPlayer2Connection();
  const { calls, fakeFetch } = recorder();
  assert.equal(await player2Heartbeat(CONFIG, fakeFetch), true);
  const pings = calls.filter(call => call.url.endsWith("/v1/health"));
  assert.ok(pings.length >= 1, "debe llamar a /v1/health");
  for (const ping of pings) assert.equal(ping.options.headers["player2-game-key"], GAME_KEY);
});

test("el chat y el TTS tambien van atribuidos", async () => {
  resetPlayer2Connection();
  const chat = recorder(() => response({ choices: [{ message: { content: "ok" } }] }));
  await player2Chat(CONFIG, [{ role: "user", content: "hola" }], chat.fakeFetch);
  resetPlayer2Connection();
  const tts = recorder(() => response({ data: "" }));
  await player2Speak({ ...CONFIG, player2Tts: true, player2TtsSpeed: 1, player2TtsLanguage: "" },
    "Por el Imperio.", {}, tts.fakeFetch);
  for (const call of [...chat.calls, ...tts.calls]) {
    assert.equal(call.options.headers["player2-game-key"], GAME_KEY, `sin atribuir: ${call.url}`);
  }
});

test("un heartbeat fallido suelta la conexion cacheada para reconectar en otro puerto", async () => {
  resetPlayer2Connection();
  let healthCalls = 0;
  const failing = async url => {
    if (url.endsWith("/health")) { healthCalls += 1; throw new Error("ECONNREFUSED"); }
    return response({});
  };
  assert.equal(await player2Heartbeat({ ...CONFIG }, failing), false, "no debe lanzar, solo informar");
  assert.equal(await player2Heartbeat({ ...CONFIG }, failing), false);
  // Con la conexion cacheada retenida tras el fallo, el segundo intento ni tocaria la red.
  assert.equal(healthCalls, 2, "cada intento debe reintentar la conexion");
});

test("sin game key la peticion sale, pero sin cabecera de atribucion", async () => {
  resetPlayer2Connection();
  const { calls, fakeFetch } = recorder();
  await player2Heartbeat({ player2Url: CONFIG.player2Url, player2GameKey: "" }, fakeFetch);
  assert.equal("player2-game-key" in calls[0].options.headers, false);
});

test("Player2 cerrado se detecta por la ausencia de api.port", () => {
  assert.equal(player2AppDetected({ appData: "C:\ruta\que\no\existe" }), false);
});
