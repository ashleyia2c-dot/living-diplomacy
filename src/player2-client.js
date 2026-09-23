import fs from "node:fs";
import path from "node:path";

let cachedConnection;

const HEALTH_TIMEOUT_MS = 10000;
const PLAYER2_CLOSED =
  "Player2 is not open. Open the Player2 app, sign in, and try again.";

// Player2 borra api.port al cerrar limpiamente, asi que su ausencia indica que la app
// no esta corriendo. Un cierre sucio puede dejarlo atras, por eso esto solo decide el
// mensaje de error: se intenta el puerto por defecto de todas formas.
export function player2AppDetected(config = {}) {
  if (config.player2Url) return true;
  try { return fs.readFileSync(player2PortFile(config.appData), "utf8").trim().length > 0; }
  catch { return false; }
}

function trimSlash(value) { return value.replace(/\/+$/, ""); }

export function player2PortFile(appData = process.env.APPDATA || "") {
  return path.join(appData, "game.player2.client", "api.port");
}

export function discoverPlayer2Root(config = {}) {
  if (config.player2Url) return trimSlash(config.player2Url).replace(/\/v1$/, "");
  const portFile = player2PortFile(config.appData);
  let port = 4315;
  try {
    const discovered = Number(fs.readFileSync(portFile, "utf8").trim());
    if (Number.isInteger(discovered) && discovered >= 1024 && discovered <= 65535) port = discovered;
  } catch { /* Player2 uses 4315 when its discovery file is unavailable. */ }
  return `http://127.0.0.1:${port}`;
}

function headers(config) {
  return {
    "content-type": "application/json",
    ...(config.player2GameKey ? { "player2-game-key": config.player2GameKey } : {})
  };
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

export async function connectPlayer2(config, fetchImpl = fetch) {
  if (cachedConnection) return cachedConnection;
  cachedConnection = (async () => {
    const root = discoverPlayer2Root(config);
    let health;
    try {
      health = await readJson(await fetchImpl(`${root}/v1/health`, {
        headers: headers(config), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      }), "Player2 health");
    } catch (error) {
      // Con la app cerrada el fallo es un rechazo de conexion, no un fallo del mod.
      if (!player2AppDetected(config)) throw new Error(PLAYER2_CLOSED);
      throw error;
    }
    let apiBase = `${root}/v1`;
    if (config.player2Profile) {
      const profiles = await readJson(await fetchImpl(`${root}/v1/ai_profiles`, { headers: headers(config), signal: AbortSignal.timeout(10000) }), "Player2 profiles");
      const wanted = profiles.find(item => item.name === config.player2Profile || item.id === config.player2Profile);
      if (!wanted?.base_url) throw new Error(`Player2 does not have the '${config.player2Profile}' profile`);
      apiBase = trimSlash(wanted.base_url);
    }
    return { root, apiBase, version: health.client_version || "unknown" };
  })().catch(error => { cachedConnection = undefined; throw error; });
  return cachedConnection;
}

export function resetPlayer2Connection() { cachedConnection = undefined; }

// Player2 calcula el time-spent de cada juego con estos pings, y el time-spent es parte
// de como reparte su programa de ingresos: su documentacion pide uno cada 60 segundos.
// Sin game key la peticion funciona igual, pero no se atribuye a nadie.
export async function player2Heartbeat(config, fetchImpl = fetch) {
  try {
    const connection = await connectPlayer2(config, fetchImpl);
    const response = await fetchImpl(`${connection.root}/v1/health`, {
      headers: headers(config), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Player2 health HTTP ${response.status}`);
    return true;
  } catch {
    // Player2 puede haberse reiniciado en otro puerto: la conexion cacheada ya no sirve.
    resetPlayer2Connection();
    return false;
  }
}

export async function player2Chat(config, messages, fetchImpl = fetch) {
  const connection = await connectPlayer2(config, fetchImpl);
  const response = await fetchImpl(`${connection.apiBase}/chat/completions`, {
    signal: AbortSignal.timeout(60000),
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ messages, stream: false, temperature: 0.75, max_tokens: 700 })
  });
  const payload = await readJson(response, "Player2 chat");
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Player2 did not return choices[0].message.content");
  return { text, model: payload.model || "model selected in Player2", connection };
}

export async function player2Speak(config, text, profile = {}, fetchImpl = fetch) {
  if (!config.player2Tts || typeof text !== "string" || !text.trim()) return false;
  const connection = await connectPlayer2(config, fetchImpl);
  const body = {
    text: text.trim().slice(0, 1800),
    play_in_app: true,
    speed: config.player2TtsSpeed
  };
  if (["male", "female", "other"].includes(profile.voiceGender)) body.voice_gender = profile.voiceGender;
  if (config.player2TtsLanguage) body.voice_language = config.player2TtsLanguage;
  if (Array.isArray(profile.voiceIds) && profile.voiceIds.length) body.voice_ids = profile.voiceIds.slice(0, 3);
  const instructions = profile.ttsInstructions || (profile.leader ? `Speak as ${profile.leader}, a ruler in Warhammer diplomacy.` : "");
  if (instructions) body.advanced_voice = { instructions: instructions.slice(0, 300) };
  await readJson(await fetchImpl(`${connection.root}/v1/tts/speak`, {
    method: "POST", headers: headers(config), body: JSON.stringify(body)
  }), "Player2 TTS");
  return true;
}
