// A treaty sold for a price (0.44). A player on Steam (ganzi, 06-10-2026) paid 5000 gold
// for a non-aggression pact that never happened: the payment was one card and the pact
// was promised for a later letter, which the game then refused. Now the price travels on
// the treaty itself and the game takes the gold only once the treaty really exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fengari from "fengari";
import { parseDiplomacyResponse } from "../src/tag-parser.js";
import { compactAction } from "../src/protocol.js";
import { dealViolation } from "../src/deal-limits.js";
import { describeAction } from "../src/memory-digest.js";

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const readMod = name => fs.readFileSync(new URL("../mod/script/campaign/mod/" + name, import.meta.url), "utf8");
const bridge = readMod("llm_diplomacy.lua");
const i18n = readMod("llm_diplomacy_i18n.lua");

const REPLY = "Pay me and Karak Eight Peaks will not march on you.\n[diplo:non_aggression_pact:price=5000]\n[relation:delta=0;reason=neutral]";

test("the price travels on the treaty tag and in the compact action", () => {
  const { action } = parseDiplomacyResponse(REPLY);
  assert.deepEqual(action, { type: "non_aggression_pact", price: 5000 });
  assert.equal(compactAction(action), "non_aggression_pact,price_5000");
  assert.equal(compactAction({ type: "alliance", level: "military", price: 900 }), "alliance,military,price_900");
  assert.equal(compactAction({ type: "military_access", direction: "mutual", price: 300 }), "military_access,mutual,price_300");
  assert.equal(compactAction({ type: "non_aggression_pact" }), "non_aggression_pact");
});

test("only treaties can carry a price", () => {
  assert.throws(() => parseDiplomacyResponse("Fine.\n[diplo:request_gold:amount=500;price=500]\n[relation:delta=0;reason=neutral]"));
  assert.throws(() => parseDiplomacyResponse("War.\n[diplo:declare_war:price=500]\n[relation:delta=0;reason=neutral]"));
  assert.throws(() => parseDiplomacyResponse("Pact.\n[diplo:non_aggression_pact:price=50]\n[relation:delta=0;reason=neutral]"));
});

test("a price above the player's treasury is sent back for a second draft", () => {
  const fields = { player_treasury: "3000", ai_treasury: "9000" };
  assert.match(dealViolation({ type: "non_aggression_pact", price: 5000 }, fields), /only 3000/);
  assert.match(dealViolation({ type: "request_gold", amount: 5000 }, fields), /only 3000/);
  assert.equal(dealViolation({ type: "non_aggression_pact", price: 2000 }, fields), null);
});

test("the written record says who pays for the treaty", () => {
  assert.equal(describeAction({ type: "non_aggression_pact", price: 5000 }, "Thorgrim", "Neferata"),
    "non aggression pact, for which Neferata pays 5000 gold to Thorgrim");
});

test("the card shows the price", () => runLua(`
  local label = llmdip_action_label("non_aggression_pact,price_5000")
  assert(string.find(label, "Non-aggression pact", 1, true), label)
  assert(string.find(label, "5000", 1, true), label)
  assert(llmdip_action_label("alliance,military,price_900") == "Military alliance (you pay 900 gold)", llmdip_action_label("alliance,military,price_900"))
  assert(llmdip_action_label("non_aggression_pact") == "Non-aggression pact")
`));

// The bridge runs for real against a small fake campaign. visible_after: real-time
// checks before the forced pact shows in the model (nil = the game never signs it).
function runLua(body, { gold = 6000, visibleAfter = 0 } = {}) {
  const harness = String.raw`
setfenv=function() end
saved={}; queue={}; logs={}; forced=0; ticks=0
out=function(s) logs[#logs+1]=s end
core={get_env=function() return _G end, remove_listener=function() end, add_listener=function() end, get_ui_root=function() return nil end}
local function faction(key, human, gold)
  local f = {key=key, human=human, gold=gold}
  return setmetatable(f, {__index={
    name=function(self) return self.key end, is_null_interface=function() return false end,
    is_human=function(self) return self.human end, is_dead=function() return false end,
    treasury=function(self) return self.gold end, command_queue_index=function() return 1 end,
    at_war_with=function() return false end, allied_with=function() return false end,
    defensive_allies_with=function() return false end, military_allies_with=function() return false end,
    trade_agreement_with=function() return false end, military_access_pact_with=function() return false end,
    non_aggression_pact_with=function() return pact_signed_at ~= nil and ticks >= pact_signed_at end}})
end
player=faction("wh2_dlc11_vmp_the_barrow_legion", true, ${gold})
ai=faction("wh_main_dwf_karak_izor", false, 9000)
factions={[player.key]=player, [ai.key]=ai}
saved.llmdip39_pending={req1={player=player.key, interlocutor=ai.key, action={"non_aggression_pact","price_5000"}, mode="player", turn=1}}
cm={add_first_tick_callback=function(self,fn) fn_first=fn end,
 get_saved_value=function(self,key) return saved[key] end,
 set_saved_value=function(self,key,value) saved[key]=value end,
 real_callback=function(self,fn) queue[#queue+1]=fn end,
 is_multiplayer=function() return false end, is_local_players_turn=function() return true end,
 get_local_faction=function() return player end, get_faction=function(self,key) return factions[key] end,
 add_faction_turn_start_listener_by_name=function() end,
 is_processing_battle=function() return false end, is_pending_battle_active=function() return false end,
 apply_dilemma_diplomatic_bonus=function() end,
 treasury_mod=function(self,key,amount) factions[key].gold=factions[key].gold+amount end,
 force_non_aggression_pact=function(self,a,b) forced=forced+1; ${visibleAfter === null ? "" : `pact_signed_at=ticks+${visibleAfter}`} end,
 model=function() return {turn_number=function() return 1 end} end}
-- Runs the real-time callbacks the bridge queued (its own poll re-queues itself).
function run_callbacks(n)
  for i = 1, n do
    local fn = table.remove(queue, 1)
    if not fn then return end
    ticks = ticks + 1
    fn()
  end
end
function has_log(text) for _, line in ipairs(logs) do if string.find(line, text, 1, true) then return true end end return false end
`;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  try {
    const status = lauxlib.luaL_dostring(L, to_luastring(harness + "\n" + i18n + "\n" + bridge + "\nfn_first()\n" + body));
    assert.equal(status, lua.LUA_OK, status !== lua.LUA_OK ? to_jsstring(lua.lua_tostring(L, -1)) : "");
  } finally { lua.lua_close(L); }
}

test("the gold is taken only once the pact really exists", () => runLua(`
  assert(llmdip_accept("req1") == true)
  assert(forced == 1, "the pact is signed first")
  assert(player.gold == 6000, "nothing is taken before the game shows the pact")
  run_callbacks(30)
  assert(player.gold == 1000, "paid: " .. tostring(player.gold))
  assert(ai.gold == 14000, "received: " .. tostring(ai.gold))
  assert(has_log("[LLMDIP] PRICE|req1|5000|signed=true|paid=true"))
`, { visibleAfter: 3 }));

test("a pact the game never signs costs nothing", () => runLua(`
  assert(llmdip_accept("req1") == true)
  run_callbacks(60)
  assert(player.gold == 6000, "nothing taken: " .. tostring(player.gold))
  assert(ai.gold == 9000)
  assert(has_log("[LLMDIP] PRICE|req1|5000|signed=false|paid=false"))
`, { visibleAfter: null }));

test("without the gold to pay, nothing is signed", () => runLua(`
  assert(llmdip_accept("req1") == false)
  assert(forced == 0, "no pact without the payment")
  assert(player.gold == 3000)
`, { gold: 3000, visibleAfter: 0 }));
