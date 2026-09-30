// Alguien que solo se suscribe en el Workshop se queda sin companion, y hasta
// ahora el chat se quedaba en "Pensando..." para siempre sin decir por que: 89
// suscriptores contra 36 descargas del companion. Ahora se le avisa.
//
// El aviso es INTERFAZ, no conversacion. Estas pruebas fijan lo que de verdad
// importa: que ese texto no entre nunca en el historial que se guarda con la
// partida ni en el contexto que lee el modelo, porque ahi pareceria que lo dijo
// un lider y lo contestaria como si fuera parte de la charla.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const readMod = name => fs.readFileSync(new URL('../mod/script/campaign/mod/' + name, import.meta.url), 'utf8');
const ui = readMod('llm_diplomacy_ui.lua');
const bridge = readMod('llm_diplomacy.lua');
const i18n = readMod('llm_diplomacy_i18n.lua');
const companion = fs.readFileSync(new URL('../src/companion.js', import.meta.url), 'utf8');

const LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'ru', 'pl', 'cs', 'tr', 'ko', 'pt', 'zh', 'tw'];

test('el aviso existe en los 13 idiomas y dice donde conseguir el companion', () => {
  const found = [...i18n.matchAll(/^ {4}companion_missing = "(.+)",$/gm)].map(m => m[1]);
  assert.equal(found.length, LANGUAGES.length);
  for (const text of found) {
    assert.match(text, /Player2/);
    assert.match(text, /github\.com\/ashleyia2c-dot\/living-diplomacy/);
    assert.doesNotMatch(text, /\uFFFD/);
  }
});

test('el aviso no se escribe en el historial ni se guarda con la partida', () => {
  // Una sola aparicion: la que rellena state.notice. Si alguien vuelve a
  // meterlo por add_history, el texto acabaria en el contexto del modelo.
  const uses = [...ui.matchAll(/companion_missing/g)];
  assert.equal(uses.length, 1);
  const notice = /state\.notice = \{target = target, text = llmdip_t\("companion_missing"\)\}/;
  assert.match(ui, notice);
  const watchdog = ui.slice(ui.indexOf('local function watch_for_companion'), ui.indexOf('local function send_text'));
  assert.doesNotMatch(watchdog, /add_history/);
  assert.doesNotMatch(watchdog, /persist_history/);
  assert.doesNotMatch(watchdog, /messages\[#messages\] =[^=]/);
  // Lo unico que viaja a la partida guardada es state.inbox, y el aviso vive fuera.
  assert.match(ui, /cm:set_saved_value\("llmdip39_history", copy\(state\.inbox\)\)/);
  assert.doesNotMatch(ui, /inbox\[[^\]]*\]\.notice/);
});

test('se pinta sobre una copia, el historial real queda intacto', () => {
  const body = ui.slice(ui.indexOf('local function history_body_lines'), ui.indexOf('local function history_display'));
  assert.match(body, /if state\.notice and state\.notice\.target == target then/);
  assert.match(body, /for i = 1, #history do shown\[i\] = history\[i\] end/);
  assert.match(body, /shown\[#shown \+ 1\] = llmdip_t\("speaker_system"\)/);
  assert.match(body, /history = shown/);
});

test('el aviso se retira al responder, al enviar de nuevo y al cerrar', () => {
  const response = ui.slice(ui.indexOf('function llmdip_ui_on_response'));
  assert.match(response.slice(0, 200), /state\.notice = nil/);
  assert.equal([...ui.matchAll(/state\.notice = nil/g)].length, 4);
});

test('solo se avisa si el companion no ha dado senales de vida', () => {
  assert.match(ui, /if llmdip_companion_is_alive and llmdip_companion_is_alive\(\) then return end/);
  // Un modelo lento no puede disparar el aviso mientras el companion conteste.
  assert.match(ui, /local COMPANION_WAIT_MS = (\d+)/);
  assert.ok(Number(/local COMPANION_WAIT_MS = (\d+)/.exec(ui)[1]) >= 5000);
});

test('el companion se anuncia al recoger la peticion, antes de hablar con el modelo', () => {
  const poll = companion.slice(companion.indexOf('if (request) {'), companion.indexOf('await handleRequest(request)'));
  assert.match(poll, /enqueueInbox\("if llmdip_companion_alive then llmdip_companion_alive\(\) end/);
  // Y tambien al arrancar, para quien abre el companion con la partida ya puesta.
  assert.match(companion, /"if llmdip_companion_alive then llmdip_companion_alive\(\) end\\n" \+/);
});

// El puente se ejecuta de verdad, no solo se lee.
function run(source, body) {
  const harness = String.raw`
setfenv=function() end
listeners={}; first={}; saved={}; phase=true
out=function() end
core={get_env=function() return _G end, remove_listener=function() end, add_listener=function() end,
 get_ui_root=function() return nil end}
cm={add_first_tick_callback=function(self,fn) table.insert(first,fn) end,
 get_saved_value=function(self,key) return saved[key] end,
 set_saved_value=function(self,key,value) saved[key]=value end,
 real_callback=function() end,
 add_faction_turn_start_listener_by_name=function() end,
 is_processing_battle=function() return false end,
 is_pending_battle_active=function() return false end,
 model=function() return {turn_number=function() return 1 end} end}
function llmdip_player_phase() return phase end
`;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  try {
    const status = lauxlib.luaL_dostring(L, to_luastring(harness + '\n' + i18n + '\n' + source + '\n' + body));
    assert.equal(status, lua.LUA_OK, status !== lua.LUA_OK ? to_jsstring(lua.lua_tostring(L, -1)) : '');
  } finally { lua.lua_close(L); }
}

test('la senal de vida del companion se enciende y no se apaga sola', () => run(bridge, `
  assert(llmdip_companion_is_alive() == false, 'arranca sin companion visto')
  llmdip_companion_alive()
  assert(llmdip_companion_is_alive() == true, 'la senal enciende')
  llmdip_companion_alive()
  assert(llmdip_companion_is_alive() == true, 'llamarla dos veces no molesta')
`));
