import fs from "node:fs";
import path from "node:path";

let cachedConnection;

const HEALTH_TIMEOUT_MS = 10000;
const PLAYER2_CLOSED =
  "Player2 is not open. Open the Player2 app, sign in and try again.";

// Player2 deletes api.port when it closes cleanly, so its absence means the app is
// not running. An unclean exit can leave it behind, so this only decides the error
// message: the default port is tried anyway.
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
      // With the app closed the failure is a refused connection, not a mod failure.
      if (!player2AppDetected(config)) throw new Error(PLAYER2_CLOSED);
      throw error;
    }
    let apiBase = `${root}/v1`;
    if (config.player2Profile) {
      const profiles = await readJson(await fetchImpl(`${root}/v1/ai_profiles`, { headers: headers(config), signal: AbortSignal.timeout(10000) }), "Player2 profiles");
      const wanted = profiles.find(item => item.name === config.player2Profile || item.id === config.player2Profile);
      if (!wanted?.base_url) throw new Error(`Player2 has no profile '${config.player2Profile}'`);
      apiBase = trimSlash(wanted.base_url);
    }
    return { root, apiBase, version: health.client_version || "unknown" };
  })().catch(error => { cachedConnection = undefined; throw error; });
  return cachedConnection;
}

export function resetPlayer2Connection() { cachedConnection = undefined; }

// Player2 computes each game's time spent from these pings, and time spent is part of
// how its revenue programme pays out: its documentation asks for one every 60 seconds.
// Without a game key the request still works, but is attributed to nobody.
export async function player2Heartbeat(config, fetchImpl = fetch) {
  try {
    const connection = await connectPlayer2(config, fetchImpl);
    const response = await fetchImpl(`${connection.root}/v1/health`, {
      headers: headers(config), signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Player2 health HTTP ${response.status}`);
    return true;
  } catch {
    // Player2 may have restarted on another port: the cached connection is no longer valid.
    resetPlayer2Connection();
    return false;
  }
}

// The cap a reply may reach when its first attempt spent the whole cap reasoning.
const RETRY_MAX_TOKENS = 8000;

export async function player2Chat(config, messages, fetchImpl = fetch, { maxTokens = 2500, timeoutMs = 60000 } = {}) {
  const connection = await connectPlayer2(config, fetchImpl);
  const ask = async (cap, wait) => readJson(await fetchImpl(`${connection.apiBase}/chat/completions`, {
    signal: AbortSignal.timeout(wait),
    method: "POST",
    headers: headers(config),
    // The model Player2 picks may reason before it answers (deepseek-flash did on
    // 02-10-2026), and the reasoning counts against this cap: at 700 a briefing came
    // back empty and a letter used 685. 2500 was checked against the live API.
    // gpt-5.6-luna reasons too on long structured tasks: the courts' dispatches used all
    // 2500 and came back empty (03-10-2026), so that call asks for more.
    body: JSON.stringify({ messages, stream: false, temperature: 0.75, max_tokens: cap })
  }), "Player2 chat");
  let payload = await ask(maxTokens, timeoutMs);
  // 14-10-2026, in game: deepseek-flash weighed a paid war for all 2500 tokens and
  // answered nothing. A reply that used the whole cap without text is asked once more
  // with room to finish its thinking.
  const spentCap = p => typeof p?.choices?.[0]?.message?.content !== "string" && Number(p?.usage?.completion_tokens) >= maxTokens;
  if (spentCap(payload) && maxTokens < RETRY_MAX_TOKENS) payload = await ask(RETRY_MAX_TOKENS, timeoutMs * 2);
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    // Say why, so a refusal or a reply cut by the token cap can be told apart.
    const choice = payload?.choices?.[0];
    throw new Error(`Player2 returned no choices[0].message.content (finish_reason=${choice?.finish_reason ?? "none"}, model=${payload?.model ?? "?"}, completion_tokens=${payload?.usage?.completion_tokens ?? "?"})`);
  }
  return { text, model: payload.model || "model selected in Player2", connection };
}

// Player2's voice language for each game language (11-10-2026: its API takes en_GB,
// es_ES...; its voice list names them british_english, spanish...). Only languages with
// both male and female voices (checked 14-10-2026): French has one woman's voice, and
// German, Russian, Polish, Czech, Turkish and Korean have none. In those the game hides
// the Voice switch, and the companion never speaks them with a foreign accent.
const VOICE_LANGUAGES = {
  English: "en_GB", Spanish: "es_ES", Italian: "it_IT",
  "Brazilian Portuguese": "pt_BR", "Simplified Chinese": "zh_CN", "Traditional Chinese": "zh_CN"
};
const VOICE_LIST_LANGUAGES = {
  en_GB: "british_english", es_ES: "spanish", fr_FR: "french", it_IT: "italian", pt_BR: "brazilian_portuguese", zh_CN: "mandarin_chinese"
};
export function voiceLanguageFor(language) { return VOICE_LANGUAGES[language] || null; }

let voiceList = null;
async function player2Voices(config, connection, fetchImpl) {
  if (voiceList) return voiceList;
  try {
    const list = await readJson(await fetchImpl(`${connection.root}/v1/tts/voices`, { headers: headers(config) }), "Player2 voices");
    if (Array.isArray(list?.voices)) voiceList = list.voices;
  } catch { /* Without the list Player2 picks a voice by gender. */ }
  return voiceList || [];
}
export function resetPlayer2Voices() { voiceList = null; }

// The same lord always gets the same voice: picked among the voices of the language
// and gender by a hash of the lord. No voice of that language and gender: no voice,
// never another language's accent.
export function pickVoice(voices, code, gender, seed = "") {
  const lang = code;
  const pool = voices.filter(v => v.language === VOICE_LIST_LANGUAGES[lang] && (!gender || gender === "other" || v.gender === gender));
  if (!pool.length) return null;
  let hash = 2166136261;
  for (const char of String(seed)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return { id: pool[(hash >>> 0) % pool.length].id, language: lang };
}

// options.language: the game's language name ("Spanish"), so the lord speaks it without
// an English accent.
export async function player2Speak(config, text, profile = {}, fetchImpl = fetch, { language } = {}) {
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
  else if (language) {
    const code = voiceLanguageFor(language);
    if (!code) return false;
    const voice = pickVoice(await player2Voices(config, connection, fetchImpl), code, profile.voiceGender, profile.leaderSubtype || profile.leader);
    if (voice) { body.voice_ids = [voice.id]; body.voice_language = voice.language; }
    else body.voice_language = code;
  }
  const instructions = profile.ttsInstructions || (profile.leader ? `Speak as ${profile.leader}, a ruler in Warhammer diplomacy.` : "");
  if (instructions) body.advanced_voice = { instructions: instructions.slice(0, 300) };
  await readJson(await fetchImpl(`${connection.root}/v1/tts/speak`, {
    method: "POST", headers: headers(config), body: JSON.stringify(body)
  }), "Player2 TTS");
  return true;
}
