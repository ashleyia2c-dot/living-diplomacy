// The state of the world (llm_diplomacy_world.lua), run in Fengari against a small
// fake campaign: factions, treaties, attitudes and settlements that the tests change
// between turns, the way the game would.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fengari from 'fengari';
import { worldBlock, gossipFlavour, buildMessages, powerBalance } from '../src/llm-client.js';
import { parseBridgeRequest } from '../src/protocol.js';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const read = name => fs.readFileSync(new URL('../mod/script/campaign/mod/'+name,import.meta.url),'utf8');
const i18n=read('llm_diplomacy_i18n.lua'), world=read('llm_diplomacy_world.lua');

const harness=String.raw`
setfenv=function() end
local standard_find=string.find
string.find=function(...)
 assert(select('#',...)<=3, 'WH3 string.find: unsupported fourth argument')
 return standard_find(...)
end
saved={}; first={}; turn_listeners={}; logs={}; round=1; mp=false; myturn=true
out=function(line) logs[#logs+1]=line end
event_listeners={}
core={get_env=function() return _G end,
 remove_listener=function(self,name) event_listeners[name]=nil end,
 add_listener=function(self,name,event,condition,callback,persistent)
  event_listeners[name]={event=event,condition=condition,callback=callback}
 end}
function emit(event,context)
 for _,listener in pairs(event_listeners) do
  if listener.event==event and (listener.condition==true or listener.condition(context)) then listener.callback(context) end
 end
end
NAMES={}
common={get_localised_string=function(key) return NAMES[key] or key end}
PLAYER='player'
-- F[key] = {rank, regions, sub, leader, human, dead, met, str}
F={}; REL={}; ATT={}; VASSAL={}
local function pk(a,b) if a<b then return a..'|'..b end return b..'|'..a end
function relate(a,b,flags) REL[pk(a,b)]=flags end
local function list(items) return {num_items=function() return #items end, item_at=function(self,i) return items[i+1] end} end
local function sorted_keys(filter)
 local keys={} for k,s in pairs(F) do if filter(k,s) then keys[#keys+1]=k end end
 table.sort(keys); return keys
end
function faction(key)
 local spec=F[key]
 local f={}
 function f:name() return key end
 function f:is_null_interface() return spec==nil end
 function f:is_dead() return spec.dead==true end
 function f:is_human() return spec.human==true end
 function f:subculture() return spec.sub or 'wh_main_sc_emp_empire' end
 function f:region_list()
  local items={} for _,name in ipairs(spec.regions or {}) do items[#items+1]={name=function() return name end} end
  return list(items)
 end
 function f:military_force_list() return list({{is_null_interface=function() return false end, strength=function() return spec.str or 100 end}}) end
 function f:factions_met()
  local items={} for _,k in ipairs(sorted_keys(function(k,s) return k~=key and s.met end)) do items[#items+1]=faction(k) end
  return list(items)
 end
 function f:faction_leader()
  return {is_null_interface=function() return false end,
   character_subtype_key=function() return spec.leader or ('lord_'..key) end,
   get_forename=function() return 'names_'..key end, get_surname=function() return '' end}
 end
 local function rel(other) return REL[pk(key,other:name())] or {} end
 function f:at_war_with(o) return rel(o).w==true end
 function f:military_allies_with(o) return rel(o).m==true end
 function f:defensive_allies_with(o) return rel(o).d==true end
 function f:non_aggression_pact_with(o) return rel(o).n==true end
 function f:trade_agreement_with(o) return rel(o).t==true end
 function f:is_vassal_of(o) return VASSAL[key]==o:name() end
 function f:factions_at_war_with()
  if spec.fail_wars then error('war list unavailable') end
  local items={} for _,k in ipairs(sorted_keys(function(k) return k~=key end)) do
   if rel(faction(k)).w then items[#items+1]=faction(k) end
  end
  return list(items)
 end
 function f:factions_allied_with()
  local items={} for _,k in ipairs(sorted_keys(function(k) return k~=key end)) do
   local r=rel(faction(k)); if r.m or r.d then items[#items+1]=faction(k) end
  end
  return list(items)
 end
 -- Only the key form works, like the real game is expected to behave; the other
 -- spellings fail and the module has to find the right one by itself.
 function f:diplomatic_attitude_towards(other)
  if type(other)~='string' then error('faction key expected') end
  return ATT[key..'>'..other] or 0
 end
 return f
end
local function owner_of(region)
 for k,s in pairs(F) do for _,r in ipairs(s.regions or {}) do if r==region and not s.dead then return k end end end
end
BATTLE={a={},d={},aw=true,dw=false,ak=0,dk=0,ar='decisive_victory',dr='close_defeat'}
FORCES={}
local function pending_battle()
 return {
  is_draw=function() return BATTLE.draw==true end,
  siege_battle=function() return BATTLE.siege==true end,
  attacker_battle_result=function() return BATTLE.ar end,
  defender_battle_result=function() return BATTLE.dr end,
  is_auto_resolved=function() return BATTLE.auto==true end,
  percentage_of_attacker_killed=function() return BATTLE.ak end,
  percentage_of_defender_killed=function() return BATTLE.dk end
 }
end
cm={
 pending_battle_cache_num_attackers=function() return #BATTLE.a end,
 pending_battle_cache_num_defenders=function() return #BATTLE.d end,
 pending_battle_cache_get_attacker=function(self,i) return table.unpack(BATTLE.a[i]) end,
 pending_battle_cache_get_defender=function(self,i) return table.unpack(BATTLE.d[i]) end,
 pending_battle_cache_attacker_victory=function() return BATTLE.aw end,
 pending_battle_cache_defender_victory=function() return BATTLE.dw end,
 add_first_tick_callback=function(self,fn) first[#first+1]=fn end,
 add_faction_turn_start_listener_by_name=function(self,name,key,fn) turn_listeners[name]=fn end,
 get_saved_value=function(self,key) return saved[key] end,
 set_saved_value=function(self,key,value) saved[key]=value end,
 is_multiplayer=function() return mp end,
 is_local_players_turn=function() return myturn end,
 random_number=function(self,max) return 1 end,
 get_local_faction=function() return faction(PLAYER) end,
 get_faction=function(self,key) return faction(key) end,
 get_region=function(self,region)
  return {owning_faction=function()
   local owner=owner_of(region)
   if owner then return faction(owner) end
   return {is_null_interface=function() return true end}
  end}
 end,
 model=function() return {
  pending_battle=pending_battle,
  military_force_for_command_queue_index=function(self,q)
   local spec=FORCES[q]
   if spec and spec.fail then error('force query unavailable') end
   return {is_null_interface=function() return not spec or spec.dead==true end,
    is_armed_citizenry=function() return spec.garrison==true end}
  end,
  turn_number=function() return round end,
  faction_strength_rank=function(self,f) return F[f:name()].rank or 0 end,
  world=function() return {faction_list=function()
   local items={} for _,k in ipairs(sorted_keys(function() return true end)) do items[#items+1]=faction(k) end
   return list(items)
  end} end
 } end
}
function next_turn() round=round+1; turn_listeners.llmdip_world_turn() end
function has_log(pattern) for _,line in ipairs(logs) do if string.match(line,pattern) then return true end end return false end
function entries_of(kind)
 local result={}
 for _,e in ipairs(saved.llmdip_world_v1.e) do if e.k==kind then result[#result+1]=e end end
 return result
end
-- Four realms the player knows, all with different peoples and low in the ranking, so
-- no gossip appears unless a test sets up its conditions.
function base_world()
 F={player={human=true,rank=3,regions={'p1','p2'},sub='wh_main_sc_brt_bretonnia',met=false},
  emp={rank=20,regions={'e1','e2','e3'},sub='wh_main_sc_emp_empire',met=true},
  ksl={rank=21,regions={'k1','k2'},sub='wh3_main_sc_ksl_kislev',met=true},
  dwf={rank=22,regions={'d1','d2'},sub='wh_main_sc_dwf_dwarfs',met=true},
  grn={rank=23,regions={'g1','g2','g3','g4'},sub='wh_main_sc_grn_greenskins',met=true}}
 REL={}; ATT={}; VASSAL={}
end
function prepare_battle(a,d)
 BATTLE={a=a or {{11,101,'emp'}},d=d or {{22,202,'ksl'}},aw=true,dw=false,ak=5,dk=40,ar='decisive_victory',dr='close_defeat'}
 FORCES={}
 for _,side in ipairs({BATTLE.a,BATTLE.d}) do for _,row in ipairs(side) do FORCES[row[2]]={} end end
end
`;

function run(body) {
 const L=lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
 try {
  const status=lauxlib.luaL_dostring(L,to_luastring(harness+'\n'+i18n+'\n'+world+'\n'+body));
  assert.equal(status,lua.LUA_OK,status!==lua.LUA_OK?to_jsstring(lua.lua_tostring(L,-1)):'');
 } finally {lua.lua_close(L);}
}

test('the first look at a campaign writes no news, only a baseline, and finds the attitude call',()=>run(`
 base_world(); ATT['emp>ksl']=60; ATT['ksl>dwf']=-70; first[1]()
 local w=saved.llmdip_world_v1
 assert(w and w.turn==1 and #entries_of('war')==0, 'baseline only')
 assert(w.snap.f.emp and w.snap.f.player.h==1, 'the player is watched too')
 assert(has_log('^%[LLMDIP%] WORLD_ATTITUDE|attitude_towards_key'), 'the key form of the attitude call is chosen')
 assert(has_log('^%[LLMDIP%] WORLD_SCAN|turn=1|factions=5'))
`));

test('a new military alliance becomes news with the names the player sees',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4; NAMES.factions_screen_name_emp='The Empire'; NAMES.factions_screen_name_ksl='Kislev'
 first[1](); relate('emp','ksl',{m=true}); next_turn()
 local news=entries_of('alliance_military')
 assert(#news==1, 'one alliance')
 local text=llmdip_world_entries()[1].text
 assert(string.find(text,'The Empire',1) and string.find(text,'Kislev',1), text)
 assert(llmdip_world_entries()[1].kind=='news' and llmdip_world_entries()[1].new)
`));

test('allies that end up at war are a betrayal, not just another war',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4
 relate('emp','ksl',{m=true}); first[1]()
 relate('emp','ksl',{w=true}); next_turn()
 assert(#entries_of('betrayal')==1 and #entries_of('war')==0)
 local gossip=entries_of('dishonour')
 assert(#gossip==1, 'the courts talk about it')
 local text
 for _,e in ipairs(llmdip_world_entries()) do if e.kind=='gossip' then text=e.text end end
 assert(text and not string.find(text,'did to',1), 'nobody is blamed: the game does not say who broke the pact')
`));

test('wars between minor realms far from the player are left out of the chronicle',()=>run(`
 base_world(); F.dwf.met=false; F.grn.met=false
 first[1](); relate('dwf','grn',{w=true}); next_turn()
 assert(#entries_of('war')==0, 'noise')
 relate('player','emp',{w=true}); next_turn()
 assert(#entries_of('war')==1, 'a war of the player always counts')
`));

test('settlements that change hands are counted, and the loser does not forget',()=>run(`
 base_world(); F.dwf.rank=8; F.grn.rank=9
 first[1]()
 F.dwf.regions={}; F.grn.regions={'g1','g2','g3','g4','d1','d2'}; relate('dwf','grn',{w=true}); next_turn()
 local capture=entries_of('capture')[1]
 assert(capture and capture.a=='grn' and capture.b=='dwf' and capture.n==2, 'two settlements taken')
 assert(string.find(llmdip_t_lang('en','w_capture_many'),'{n}',1))
 local humiliation=entries_of('humiliation')[1]
 assert(humiliation and humiliation.a=='dwf' and humiliation.b=='grn' and humiliation.n==2)
`));

test('jealousy: an old ally watches its partner court someone else',()=>run(`
 base_world()
 relate('dwf','emp',{d=true}); first[1]()
 relate('emp','ksl',{d=true}); next_turn()
 local item=entries_of('jealousy')[1]
 assert(item and item.a=='dwf' and item.b=='emp' and item.x=='ksl' and item.tr=='interp', 'dwarfs are jealous of Kislev')
`));

test('servility needs real numbers: much weaker, adoring and bound to the stronger realm',()=>run(`
 base_world(); F.ksl.str=50; F.emp.str=400
 relate('ksl','emp',{t=true}); ATT['ksl>emp']=150
 first[1]()
 local item=entries_of('servility')[1]
 assert(item and item.a=='ksl' and item.b=='emp')
`));

test('the player is never the subject of court gossip in this phase',()=>run(`
 base_world(); F.player.str=10; F.emp.str=400
 relate('player','emp',{t=true}); ATT['player>emp']=200
 first[1]()
 for _,e in ipairs(saved.llmdip_world_v1.e) do
  assert(e.a~='player' and e.b~='player' and e.x~='player', 'gossip about the player')
 end
`));

test('canon pairs talk about the lords by name while both lead their realms',()=>run(`
 base_world()
 F.emp.leader='wh2_main_hef_tyrion'; F.ksl.leader='wh2_dlc10_hef_alarielle'
 NAMES.names_emp='Tyrion'; NAMES.names_ksl='Alarielle'
 first[1]()
 local item=entries_of('lore_affection')[1]
 assert(item, 'Tyrion and Alarielle')
 local text=llmdip_world_entries()[1].text
 assert(string.find(text,'Tyrion',1) and string.find(text,'Alarielle',1), text)
 relate('emp','ksl',{w=true}); round=20; turn_listeners.llmdip_world_turn()
 assert(#entries_of('lore_affection')==1, 'no tender gossip while they are at war')
`));

test('the same turn is never scanned twice, and multiplayer is left alone',()=>run(`
 base_world(); first[1](); local before=#logs
 turn_listeners.llmdip_world_turn(); turn_listeners.llmdip_world_turn()
 assert(#logs==before, 'second scan of turn 1')
`));

test('a multiplayer campaign keeps no world state at all',()=>run(`
 base_world(); mp=true; first[1]()
 assert(saved.llmdip_world_v1==nil and turn_listeners.llmdip_world_turn==nil)
`));

test('saved state is a copy: later changes do not leak into an earlier save',()=>run(`
 base_world(); first[1]()
 local snapshot=saved.llmdip_world_v1
 relate('emp','ksl',{m=true}); F.emp.rank=2; next_turn()
 assert(#snapshot.e==0 or snapshot.e[1].k~='alliance_military', 'the earlier save changed')
 assert(snapshot.turn==1 and saved.llmdip_world_v1.turn==2)
`));

test('loading an older save brings back the world of that save',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4; first[1]()
 local turn1=saved.llmdip_world_v1
 relate('emp','ksl',{m=true}); next_turn()
 saved.llmdip_world_v1=turn1; round=1; first[1]()
 assert(#llmdip_world_entries()==#turn1.e, 'the future leaked into the past')
`));

test('the conversation brief is English, without dossier separators, and marks each realm',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4
 NAMES.factions_screen_name_emp='The Empire, of Sigmar'; NAMES.factions_screen_name_ksl='Kislev'
 relate('dwf','emp',{d=true}); first[1]()
 relate('emp','ksl',{m=true}); next_turn()
 local news, gossip=llmdip_world_brief('dwf','player')
 assert(string.find(news,'turn 2: The Empire of Sigmar %(your ally%) and Kislev have sealed a military alliance%.',1), news)
 assert(not string.find(news,'[,;|=]'), 'separators would break the dossier')
 local own=llmdip_world_brief('ksl','player')
 assert(string.find(own,'Kislev %(this is you%)',1), own)
 assert(string.find(gossip,'the motive is court talk',1), gossip)
`));

test('the World tab counts what the player has not seen yet',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4; first[1]()
 relate('emp','ksl',{m=true}); next_turn()
 assert(llmdip_world_unseen()>=1)
 llmdip_world_mark_seen()
 assert(llmdip_world_unseen()==0 and not llmdip_world_entries()[1].new)
`));

test('a failure inside the scan is logged and never escapes',()=>run(`
 base_world(); first[1]()
 cm.model=function() error('boom') end
 round=2
 local ok=llmdip_world_scan()
 assert(ok==false and has_log('WORLD_SCAN_ERROR'))
`));

test('the dossier keeps the world fields, each in its own pcall',()=>{
 const bridge=read('llm_diplomacy.lua');
 assert.match(bridge,/local function world_brief\(interlocutor, player\)/);
 assert.match(bridge,/if llmdip_world_brief then return llmdip_world_brief\(interlocutor:name\(\), player:name\(\)\) end/);
 assert.match(bridge,/"world_news=" \.\. clean_value\(world_news\)/);
 assert.match(bridge,/"court_gossip=" \.\. clean_value\(court_gossip\)/);
 // Computed before the snapshot's own pcall: an error there must not cost the dossier.
 const briefing=bridge.indexOf('local world_news, court_gossip, court_report, court_signals, war_course, court_dispatch = world_brief(interlocutor, player)');
 assert.ok(briefing >= 0 && briefing < bridge.indexOf('local ok, value = pcall(function()\n        local ai_leader'));
 assert.match(bridge,/"court_report=" \.\. clean_value\(court_report\)/);
 assert.match(bridge,/"court_signals=" \.\. clean_value\(court_signals\)/);
 assert.match(bridge,/"war_course=" \.\. clean_value\(war_course\)/);
});

test('the companion shows THE WIDER WORLD only when the pack sends something',()=>{
 assert.equal(worldBlock({}), '');
 assert.equal(worldBlock({world_news:'none',court_gossip:'none'}), '');
 const block=worldBlock({world_news:'turn 4: A and B have sealed a military alliance.',court_gossip:'turn 4: x [the facts are true - the motive is court talk]'},'wh_main_sc_dwf_dwarfs');
 assert.match(block,/^THE WIDER WORLD/);
 assert.match(block,/News: turn 4/);
 assert.match(block,/Court gossip: turn 4/);
 assert.match(block,/Book of Grudges/);
 assert.match(block,/never invent other events/);
 assert.equal(gossipFlavour('wh3_dlc23_sc_chd_chaos_dwarfs'),'', 'Chaos Dwarfs are not dwarfs');
});

test('a dossier with the world fields still parses and reaches the model',()=>{
 const state=[
  'turn=4','memory_parent=root','memory_head=r4_1','ai_culture=wh_main_dwf_dwarfs','ai_subculture=wh_main_sc_dwf_dwarfs',
  'world_news='+'turn 4: The Empire and Kislev have sealed a military alliance. / '.repeat(11),
  'court_gossip=turn 3: In Karak Hirn they did not like seeing their ally grow so close to Kislev. [the facts are true - the motive is court talk]',
  'filler='+'x'.repeat(7600)
 ].join(',');
 const line=`[LLMDIP] REQUEST|r4_1|c1|player|ai|player|${encodeURIComponent(state)}|${encodeURIComponent('Hola')}`;
 const request=parseBridgeRequest(line);
 assert.ok(request.state.length>8000, 'longer than the old limit');
 const messages=buildMessages(request,[],{},'English');
 assert.match(messages[1].content,/THE WIDER WORLD/);
 assert.match(messages[1].content,/Court gossip: turn 3/);
});

test('field army loss requires prebattle classification and immediate 100% killed evidence',()=>run(`
 base_world(); first[1](); prepare_battle()
 emit('ScriptEventPendingBattle'); FORCES[202].dead=true; BATTLE.dk=100; emit('BattleCompleted')
 local b=saved.llmdip_world_v1.b[1]
 assert(b.destroyed.ksl==1 and b.loss_status=='confirmed')
 local report=llmdip_world_court_report('ksl','player')
 assert(string.find(report,'you lost a battle against emp',1),report)
 assert(string.find(report,'close defeat',1),report)
 assert(not string.find(report,'decisive victory',1),'loser shown winner result')
 assert(llmdip_world_court_signals('ksl')=='turn:1/wins:0/losses:1/armies:1/latest:1/window:4')
 assert(llmdip_world_court_signals('emp')=='turn:1/wins:1/losses:0/armies:0/latest:1/window:4')
 next_turn(); assert(#entries_of('army_destroyed')==1)
 round=5; turn_listeners.llmdip_world_turn()
 assert(llmdip_world_court_signals('ksl')=='turn:5/wins:0/losses:0/armies:0/latest:-1/window:4')
`));

test('garrisons and retreating armies never become annihilated field armies',()=>run(`
 base_world(); first[1](); prepare_battle()
 FORCES[202].garrison=true; emit('ScriptEventPendingBattle')
 FORCES[202].dead=true; BATTLE.dk=100; emit('BattleCompleted')
 assert(next(saved.llmdip_world_v1.b[1].destroyed)==nil)
 prepare_battle(); emit('ScriptEventPendingBattle')
 FORCES[202].dead=true; BATTLE.dk=95; emit('BattleCompleted')
 assert(next(saved.llmdip_world_v1.b[1].destroyed)==nil)
 next_turn(); assert(#entries_of('army_destroyed')==0)
`));

test('failed force queries and missing prebattle events preserve unknown losses',()=>run(`
 base_world(); first[1](); prepare_battle()
 FORCES[202].fail=true; emit('ScriptEventPendingBattle')
 FORCES[202]={dead=true}; BATTLE.dk=100; emit('BattleCompleted')
 assert(saved.llmdip_world_v1.b[1].loss_status=='unknown')
 prepare_battle({{12,103,'emp'}},{{23,204,'ksl'}})
 FORCES[204].dead=true; BATTLE.dk=100; emit('BattleCompleted')
 assert(saved.llmdip_world_v1.b[1].loss_status=='unknown')
 assert(not has_log('WORLD_BATTLE_ERROR'))
`));

test('reinforcing factions retain their own armies and defeats',()=>run(`
 base_world(); first[1](); prepare_battle(nil,{{22,202,'ksl'},{33,303,'dwf'}})
 emit('ScriptEventPendingBattle'); FORCES[303].dead=true; BATTLE.dk=100; emit('BattleCompleted')
 local b=saved.llmdip_world_v1.b[1]
 assert(b.destroyed.dwf==1 and b.destroyed.ksl==nil)
 assert(llmdip_world_court_signals('ksl')=='turn:1/wins:0/losses:1/armies:0/latest:1/window:4')
 assert(llmdip_world_court_signals('dwf')=='turn:1/wins:0/losses:1/armies:1/latest:1/window:4')
 next_turn(); assert(entries_of('army_destroyed')[1].a=='dwf')
`));

test('draws are not defeats and duplicate callbacks are idempotent',()=>run(`
 base_world(); first[1](); prepare_battle(); BATTLE.aw=false; BATTLE.draw=true
 emit('ScriptEventPendingBattle'); FORCES[202].dead=true; BATTLE.dk=100
 emit('BattleCompleted'); emit('BattleCompleted')
 assert(#saved.llmdip_world_v1.b==1)
 assert(llmdip_world_court_signals('ksl')=='turn:1/wins:0/losses:0/armies:0/latest:-1/window:4')
 assert(string.find(llmdip_world_court_report('ksl','player'),'you drew',1))
 prepare_battle(); emit('ScriptEventPendingBattle'); emit('BattleCompleted')
 assert(#saved.llmdip_world_v1.b==2,'separate battle with the same forces discarded')
`));

test('later disbanding cannot turn an earlier retreat into annihilation',()=>run(`
 base_world(); first[1](); prepare_battle()
 emit('ScriptEventPendingBattle'); emit('BattleCompleted')
 FORCES[202].dead=true; next_turn()
 assert(next(saved.llmdip_world_v1.b[1].destroyed)==nil)
 assert(#entries_of('army_destroyed')==0)
`));

test('own battles reach the court but hidden losses reach neither player nor third parties',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4; first[1](); prepare_battle()
 emit('ScriptEventPendingBattle'); FORCES[202].dead=true; BATTLE.dk=100; emit('BattleCompleted'); next_turn()
 assert(#entries_of('army_destroyed')==1)
 for _,item in ipairs(llmdip_world_entries()) do assert(not string.find(item.text,'field army',1)) end
 assert(string.find(llmdip_world_court_report('ksl','player'),'confirmed destroyed',1))
 assert(not string.find(llmdip_world_court_report('dwf','player'),'confirmed destroyed',1))
 local news=llmdip_world_brief('dwf','player')
 assert(not string.find(news,'field army',1))
 assert(llmdip_world_court_signals('dwf')=='turn:2/wins:0/losses:0/armies:0/latest:-1/window:4')
`));

test('undiscovered protagonists remain hidden even if globally powerful',()=>run(`
 base_world(); F.emp.met=false; F.ksl.met=false; F.emp.rank=1; F.ksl.rank=2; first[1]()
 relate('emp','ksl',{m=true}); next_turn()
 assert(#entries_of('alliance_military')==1)
 for _,item in ipairs(llmdip_world_entries()) do assert(not string.find(item.text,'military alliance',1)) end
 local news=llmdip_world_brief('dwf','player')
 assert(not string.find(news,'military alliance',1))
`));

test('failed war queries are unavailable, never invented peace',()=>run(`
 base_world(); first[1](); F.ksl.fail_wars=true
 local report=llmdip_world_court_report('ksl','player')
 assert(string.find(report,'Current wars: unavailable',1),report)
 assert(not string.find(report,'At war with nobody',1),report)
`));

test('known enemies exert pressure without hidden army strength filtering',()=>run(`
 base_world(); F.emp.str=1; F.ksl.str=10000; relate('ksl','emp',{w=true}); first[1]()
 local report=llmdip_world_court_report('ksl','player')
 assert(string.find(report,'emp %(known enemy hidden army strength unknown%)',1),report)
`));

test('battle knowledge and mood rewind with the saved campaign',()=>run(`
 base_world(); first[1](); local before=saved.llmdip_world_v1; prepare_battle()
 emit('ScriptEventPendingBattle'); emit('BattleCompleted')
 assert(string.find(llmdip_world_court_signals('ksl'),'losses:1',1))
 saved.llmdip_world_v1=before; first[1]()
 assert(llmdip_world_court_signals('ksl')=='turn:1/wins:0/losses:0/armies:0/latest:-1/window:4')
`));

test('the player report names who likes or loathes them with the game\'s own attitude label',()=>run(`
 base_world()
 local CAT={emp=6, ksl=0, dwf=3}
 local LABEL={emp='Trusted Friends', ksl='Hostile', dwf='Indifferent'}
 common.get_context_value=function(ctx,key,field)
  if field=='AttitudeCategory' then return CAT[key] end
  if field=='AttitudeTooltip' then return LABEL[key] end
 end
 NAMES.factions_screen_name_emp='The Empire'; NAMES.factions_screen_name_ksl='Kislev'
 first[1]()
 local r=llmdip_world_report_data()
 assert(r.lines[1]=='They are fond of you: The Empire (Trusted Friends).', tostring(r.lines[1]))
 assert(r.lines[2]=='They loathe you: Kislev (Hostile).', tostring(r.lines[2]))
 assert(#r.lines==2, 'an indifferent court is not listed')
`));

test('without the game\'s attitude category nobody is called fond or hateful',()=>run(`
 base_world(); ATT['emp>player']=500; ATT['ksl>player']=-900
 first[1]()
 local r=llmdip_world_report_data()
 assert(#r.lines==1 and r.lines[1]==llmdip_t('report_quiet'), tostring(r.lines[1]))
`));

// A new alliance of great powers: Dwarfs and Greenskins (who loathe the Empire and like
// each other) meet in secret, and next turn sign a real defensive alliance.
const coalitionWorld = `
 base_world(); F.emp.rank=2; F.ksl.rank=4
 ATT['dwf>emp']=-900; ATT['grn>emp']=-900; ATT['dwf>grn']=500; ATT['grn>dwf']=500
 forced={}
 cm.force_alliance=function(self,a,b,military) forced[#forced+1]=a..'+'..b; relate(a,b,{d=true}) end
 first[1]()
 relate('emp','ksl',{m=true}); next_turn()
`;

test('a great-power alliance opens secret talks among the realms it threatens',()=>run(coalitionWorld+`
 local talk=entries_of('crisis_meeting')[1]
 assert(talk and talk.a=='dwf' and talk.b=='grn' and talk.tr=='interp', 'dwarfs and greenskins meet')
 assert(#forced==0, 'nothing is signed on the turn the talks start')
 assert(has_log('WORLD_CRISIS_OPEN|dwf|grn'))
`));

test('next turn the talks end in a real alliance, checked in the game and told once',()=>run(coalitionWorld+`
 next_turn()
 assert(#forced==1 and forced[1]=='dwf+grn', 'one real treaty')
 local news=entries_of('coalition')[1]
 assert(news and news.a=='dwf' and news.b=='grn' and news.x=='emp')
 next_turn()
 assert(#entries_of('alliance_defensive')==0, 'the treaty we signed is not announced twice')
 assert(#forced==1, 'no second treaty')
`));

test('failed dice mean failed talks, and nothing is signed',()=>run(coalitionWorld+`
 cm.random_number=function(self,max) return max end
 next_turn()
 assert(#forced==0 and #entries_of('talks_failed')==1)
`));

test('switching AI treaties off ends the talks and nothing is signed',()=>run(coalitionWorld+`
 assert(llmdip_world_options().treaties==true, 'on by default')
 assert(llmdip_world_toggle('treaties')==false)
 next_turn()
 assert(#forced==0 and #entries_of('coalition')==0 and #entries_of('talks_failed')==0)
 assert(saved.llmdip_world_v1.opt.treaties==false, 'the switch is saved with the campaign')
`));

test('the player is never pulled into a coalition',()=>run(`
 base_world(); F.emp.rank=2; F.ksl.rank=4
 ATT['dwf>emp']=-900; ATT['player>emp']=-900; ATT['dwf>player']=500; ATT['player>dwf']=500
 forced={}
 cm.force_alliance=function(self,a,b) forced[#forced+1]=a..'+'..b end
 first[1](); relate('emp','ksl',{m=true}); next_turn(); next_turn()
 assert(#forced==0 and #entries_of('crisis_meeting')==0)
`));

test('with romance off the courts keep affairs of the heart to themselves',()=>run(`
 base_world()
 F.emp.leader='wh2_main_hef_tyrion'; F.ksl.leader='wh2_dlc10_hef_alarielle'
 first[1]()
 assert(#entries_of('lore_affection')==1, 'on by default')
 llmdip_world_toggle('romance')
 for i=1,15 do next_turn() end
 assert(#entries_of('lore_affection')==1, 'no new romance gossip while it is off')
`));

// Miao Ying's case: five beaten armies that all escape. No annihilation, but the war
// must read as going badly, never as a war she is winning.
test('five defeats with armies escaping still read as a war going badly',()=>run(`
 base_world(); relate('emp','ksl',{w=true}); first[1]()
 for i=1,5 do
  prepare_battle(); BATTLE.dk=i<=2 and 75 or 35; BATTLE.dr=i==3 and 'decisive_defeat' or 'close_defeat'
  emit('ScriptEventPendingBattle'); emit('BattleCompleted')
  if i%2==0 then next_turn() end
 end
 local b=saved.llmdip_world_v1.b[1]
 assert(next(b.destroyed)==nil, 'no army was wiped out')
 local course=llmdip_world_war_course('ksl')
 assert(course=='heavy:3/won:0/lost:5/trend:-1', course)
 local report=llmdip_world_court_report('ksl','player')
 assert(string.find(report,'0 battles won and 5 lost %(3 of them heavy defeats%)',1), report)
 assert(string.find(report,'the war is going badly for you',1), report)
 assert(string.find(llmdip_world_court_report('emp','player'),'the war is going well for you',1))
 relate('emp','ksl',{}); next_turn()
 assert(string.find(llmdip_world_war_course('ksl'),'/won:0/lost:0/trend:0',1), 'peace closes the war record')
`));

test('the companion turns repeated defeats into a battered mood and never a winning one',async()=>{
 const { emotionalContext, parseWarCourse } = await import('../src/court-context.js');
 const ask=(signals,course)=>emotionalContext({turn:12,fields:{court_signals:signals,war_course:course}});
 const beaten=ask('turn:12/wins:0/losses:3/armies:0/latest:12/window:4','heavy:2/won:0/lost:5/trend:-1');
 assert.equal(beaten.mood,'battered');
 const lucky=ask('turn:12/wins:1/losses:0/armies:0/latest:12/window:4','heavy:0/won:1/lost:6/trend:-1');
 assert.equal(lucky.mood,'contested','one win inside a lost war is not confidence');
 const quiet=ask('turn:12/wins:0/losses:0/armies:0/latest:-1/window:4','heavy:0/won:0/lost:6/trend:-1');
 assert.equal(quiet.mood,'under_pressure');
 assert.equal(parseWarCourse('heavy:1/won:2/lost:3/trend:5'),null);
 assert.equal(ask('turn:12/wins:2/losses:0/armies:0/latest:12/window:4',undefined).mood,'encouraged','older packs keep the old behaviour');
});

function runGet(body) {
 const L=lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
 try {
  const status=lauxlib.luaL_dostring(L,to_luastring(harness+'\n'+i18n+'\n'+world+'\n'+body));
  assert.equal(status,lua.LUA_OK,status!==lua.LUA_OK?to_jsstring(lua.lua_tostring(L,-1)):'');
  lua.lua_getglobal(L,to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L,-1));
 } finally {lua.lua_close(L);}
}

test('each turn the game asks its court for a briefing, and the companion can read the request',async()=>{
 const { parseBriefingRequest, buildBriefingMessages } = await import('../src/court-briefing.js');
 const line=runGet(`
  base_world(); saved.llmdip_campaign_id='c123'; F.emp.rank=2; F.ksl.rank=4
  NAMES.factions_screen_name_player='Couronne | of the Lady'; NAMES.names_player='Louen'
  first[1](); relate('emp','ksl',{m=true}); next_turn()
  for _,l in ipairs(logs) do if string.find(l,'BRIEFING|',1) then RESULT=l end end
 `);
 const request=parseBriefingRequest(line);
 assert.equal(request.player,'player');
 assert.equal(request.turn,2);
 assert.equal(request.campaignId,'c123');
 assert.match(request.facts,/^Ruler: Louen  ?of Couronne \| of the Lady$/m);
 assert.match(request.facts,/People: wh_main_sc_brt_bretonnia/);
 assert.match(request.facts,/have sealed a military alliance/);
 const messages=buildBriefingMessages(request,'Spanish');
 assert.match(messages[0].content,/royal seneschal/);
 assert.match(messages[0].content,/Write in Spanish/);
 assert.match(messages[0].content,/Never invent/);
 assert.match(messages[1].content,/FACTS GATHERED BY THE COURT/);
});

test('the World tab shows the court briefing, waits politely, and drops stale answers',()=>run(`
 base_world(); saved.llmdip_campaign_id='c123'; first[1]()
 local brief=saved.llmdip_world_v1.brief
 assert(brief and brief.status=='pending')
 local r=llmdip_world_report()
 assert(r.pending and r.lines[1]==llmdip_t('brief_pending'))
 assert(llmdip_world_briefing('brief_1_999','An old answer from another save.')==false)
 assert(has_log('BRIEFING_ACK|brief_1_999'), 'stale answers are acknowledged so the inbox empties')
 assert(llmdip_world_briefing(brief.id,'My lord, Kislev speaks well of you since Praag; Naggarond spreads poison about you.')==true)
 r=llmdip_world_report()
 assert(not r.pending and string.find(r.lines[1],'Praag',1))
 assert(saved.llmdip_world_v1.brief.status=='ready', 'the briefing is saved with the campaign')
 next_turn()
 assert(llmdip_world_report().pending, 'a new turn asks again')
`));

test('without a campaign id or a companion the World tab shows no briefing at all',()=>run(`
 base_world(); first[1]()
 assert(saved.llmdip_world_v1.brief==nil and llmdip_world_report()==nil)
 assert(not has_log('BRIEFING|'))
 saved.llmdip_campaign_id='c123'; next_turn()
 local id=saved.llmdip_world_v1.brief.id
 llmdip_world_briefing_failed(id)
 assert(llmdip_world_report()==nil, 'a failed briefing leaves no card, never a data dump')
`));

test('the companion keeps only the plain paragraph of a briefing',async()=>{
 const { cleanBriefing, parseBriefingRequest, narratorFor } = await import('../src/court-briefing.js');
 assert.equal(cleanBriefing('## Report\n**My lord**, the dwarfs grumble.\n\nThat is all.'),'My lord, the dwarfs grumble. That is all.');
 assert.equal(cleanBriefing('"Short."'),'');
 assert.equal(narratorFor('wh2_main_sc_skv_skaven'),'a nervous, scheming grey seer');
 assert.equal(narratorFor('wh3_dlc23_sc_chd_chaos_dwarfs'),'a daemonsmith of your council, proud and bitter');
 assert.throws(()=>parseBriefingRequest('[LLMDIP] BRIEFING|brief_1_2|c1|player|1|es'));
 assert.equal(parseBriefingRequest('[LLMDIP] REQUEST|x'),null);
});

test('loading mid-turn without a briefing asks the court once more, never twice',()=>run(`
 base_world(); saved.llmdip_campaign_id='c123'; first[1]()
 local count=0
 for _,l in ipairs(logs) do if string.find(l,'BRIEFING|',1) then count=count+1 end end
 assert(count==1, 'a fresh turn asks once')
 first[1]()
 count=0
 for _,l in ipairs(logs) do if string.find(l,'BRIEFING|',1) then count=count+1 end end
 assert(count==2, 'a reload with no briefing asks again')
 llmdip_world_briefing(saved.llmdip_world_v1.brief.id,'My lord, all is quiet on our borders this turn.')
 first[1]()
 count=0
 for _,l in ipairs(logs) do if string.find(l,'BRIEFING|',1) then count=count+1 end end
 assert(count==2, 'a ready briefing is not asked for again')
`));

// A court that knows its own realm: these are the real numbers the game gives it.
const richRealm = `
 local base_faction=faction
 faction=function(key)
  local f=base_faction(key)
  if key=='player' then
   f.treasury=function() return 5400 end
   f.net_income=function() return 1250 end
   f.military_force_list=function() return {num_items=function() return 3 end, item_at=function(self,i)
    return {is_null_interface=function() return false end, is_armed_citizenry=function() return i==2 end, strength=function() return 100 end} end} end
   f.faction_leader=function() return {is_null_interface=function() return false end, character_subtype_key=function() return 'wh3_main_cth_miao_ying' end,
    rank=function() return 32 end, get_forename=function() return 'names_player' end, get_surname=function() return '' end} end
  end
  return f
 end
`;

test('talking to your court sends the words, the conversation and what the court knows of the realm',async()=>{
 const { parseCouncilRequest, buildCouncilMessages } = await import('../src/court-briefing.js');
 const { MemoryStore } = await import('../src/memory-store.js');
 const line=runGet(`
  base_world(); saved.llmdip_campaign_id='c123'; F.player.sub='wh3_main_sc_cth_cathay'
  `+richRealm+`
  first[1]()
  assert(llmdip_council_send('Should I help Kislev against Chaos?'))
  assert(not llmdip_council_send('And again?'), 'one question at a time')
  for _,l in ipairs(logs) do if string.find(l,'COUNCIL|',1) then RESULT=l end end
 `);
 const council=parseCouncilRequest(line);
 assert.equal(council.words,'Should I help Kislev against Chaos?');
 assert.match(council.facts,/Treasury: 5400 gold \(net income 1250 a turn\)/);
 assert.match(council.facts,/Field armies: 2\./, 'the garrison is not an army');
 assert.match(council.facts,/Military strength rank: 3 \(1 is the strongest/);
 assert.equal(council.rulerSubtype,'wh3_main_cth_miao_ying');
 const lore=new MemoryStore(fs.mkdtempSync(path.join(os.tmpdir(),'llmdip-council-'))).curatedLore(council.rulerSubtype,'player');
 assert.ok(Array.isArray(lore.canonNotes) && lore.canonNotes.length>0, 'the curated lore of the ruler is found');
 const messages=buildCouncilMessages(council,'Spanish',lore);
 assert.match(messages[0].content,/court astrologer of the Celestial palace/);
 assert.match(messages[0].content,/Answer in Spanish/);
 assert.match(messages[0].content,/never urge war against a far stronger realm/);
 assert.match(messages[0].content,/What you know of your ruler/);
 assert.match(messages[1].content,/YOUR RULER NOW SAYS \(answer this\): Should I help Kislev/);
});

test('the court answers once, late answers are dropped, and silence becomes a note',()=>run(`
 base_world(); saved.llmdip_campaign_id='c123'; first[1]()
 assert(llmdip_council_send('How goes the war?'))
 local id=saved.llmdip_world_v1.cwait.id
 assert(llmdip_council_waiting())
 assert(llmdip_world_council_reply('council_1_1_99','A late answer from another save.')==false)
 assert(has_log('COUNCIL_ACK|council_1_1_99'))
 assert(llmdip_world_council_reply(id,'Badly, my lord: three defeats and no allies.'))
 local h=llmdip_council_history()
 assert(#h==2 and h[1].who=='you' and h[2].who=='court' and string.find(h[2].text,'three defeats',1))
 assert(llmdip_council_send('Then what?'))
 local real_time=os.time; os.time=function() return real_time()+1000 end -- the saved copy is not the live state
 assert(not llmdip_council_waiting())
 h=llmdip_council_history()
 assert(h[#h].who=='note' and h[#h].text=='council_no_answer', 'silence is said, never left as thinking forever')
 assert(llmdip_council_send('Hello?'), 'the ruler may speak again')
`));

test('each piece of world and court context reaches the model once, never twice',()=>{
 const news='turn 84: The Empire and Kislev have sealed a military alliance.';
 const gossip='turn 84: In Hashut nobody hides it: The Great Orthodoxy is hated there. [true]';
 const report='At war with: Chaos Legion. How your wars are going: against Chaos Legion since turn 75: 1 battles won and 5 lost - the war is going badly for you';
 const state=['turn=84','memory_parent=root','memory_head=r84_1','ai_subculture=wh3_main_sc_cth_cathay','mil_alliance=1',
  'world_news='+news,'court_gossip='+gossip,'court_report='+report,
  'court_signals=turn:84/wins:0/losses:2/armies:0/latest:84/window:4','war_course=heavy:2/won:1/lost:5/trend:-1'].join(',');
 const line=`[LLMDIP] REQUEST|r84_1|c1|player|ai|player|${encodeURIComponent(state)}|${encodeURIComponent('Hola')}`;
 const request=parseBridgeRequest(line);
 const text=buildMessages(request,[],{},'English')[1].content;
 const count=(needle)=>text.split(needle).length-1;
 assert.equal(count(news),1,'news once');
 assert.equal(count(gossip.slice(0,40)),1,'gossip once');
 assert.equal(count(report),1,'court report once');
 assert.equal(count('court_signals='),0,'machine signals never shown raw');
 assert.equal(count('war_course='),0);
 assert.match(text,/mil_alliance=1/,'the rest of the dossier is untouched');
 assert.match(text,/battered/,'the mood still comes through in words');
 // Without a block to show them, the fields stay in the dossier.
 const bare=parseBridgeRequest(`[LLMDIP] REQUEST|r84_1|c1|player|ai|player|${encodeURIComponent('turn=84,memory_parent=root,memory_head=r84_1,court_report=none,world_news=none')}|${encodeURIComponent('Hola')}`);
 assert.match(buildMessages(bare,[],{},'English')[1].content,/world_news=none/);
});

test('the court names every realm with its people, and its report opens the court conversation',async()=>{
 const { parseBriefingRequest } = await import('../src/court-briefing.js');
 const line=runGet(`
  base_world(); saved.llmdip_campaign_id='c123'; F.emp.rank=2; F.ksl.rank=4
  NAMES.factions_screen_name_emp='The Empire'; NAMES.factions_screen_name_ksl='Kislev'
  NAMES.cultures_subcultures_name_wh_main_sc_emp_empire='Empire'; NAMES['cultures_subcultures_name_wh3_main_sc_ksl_kislev']='Kislev'
  first[1](); relate('emp','ksl',{m=true}); next_turn()
  for _,l in ipairs(logs) do if string.find(l,'BRIEFING|',1) then RESULT=l end end
  local id=saved.llmdip_world_v1.brief.id
  assert(llmdip_world_briefing(id,'My lord, the Empire, a realm of men, has allied with Kislev.'))
  local h=llmdip_council_history()
  assert(#h==1 and h[1].who=='court' and string.find(h[1].text,'allied with Kislev',1), 'the report is the court first word')
 `);
 const request=parseBriefingRequest(line);
 assert.match(request.facts,/The Empire \(a realm of the Empire\) and Kislev \(a realm of the Kislev\) have sealed a military alliance/);
});

test('every lord knows its real number of settlements and field armies',()=>{
 const fields={relative_power_ratio:'0.70',ai_regions:'a:b:c:d:e:f:g:h:i:j:k:l',ai_settlements:'74',player_settlements:'20',ai_field_armies:'13',player_field_armies:'6',ai_wars:'2'};
 const balance=powerBalance(fields);
 assert.match(balance,/Regions held: you 74, the player 20\./, 'not the 12 of the capped list');
 assert.match(balance,/Field armies: you 13, the player 6\./);
 assert.match(powerBalance({relative_power_ratio:'0.70',ai_regions:'a:b',player_regions:'c'}),/Regions held: you 2, the player 1\./,'older packs still work');
 const bridge=read('llm_diplomacy.lua');
 assert.match(bridge,/"ai_field_armies=" \.\. tostring\(field_army_count\(interlocutor\) or "unknown"\)/);
 assert.match(bridge,/"ai_settlements=" \.\. tostring\(safe_value\("unknown", function\(\) return interlocutor:region_list\(\):num_items\(\) end\)\)/);
});

// 03-10-2026: the game crashed twice at the same AI battle right after our pre-battle
// capture queried the engine. During the AI's turns nothing of ours may touch it.
test('during the AI turns a battle only queues names and winner: no engine calls, no save',()=>run(`
 base_world(); relate('emp','ksl',{w=true}); first[1]()
 local touches=0
 local real_model, real_faction=cm.model, cm.get_faction
 cm.model=function(...) touches=touches+1; return real_model(...) end
 cm.get_faction=function(...) touches=touches+1; return real_faction(...) end
 emit('ScriptEventPlayerFactionTurnEnd')
 local before=saved.llmdip_world_v1
 prepare_battle(); emit('ScriptEventPendingBattle'); emit('BattleCompleted'); emit('BattleCompleted')
 assert(touches==0, 'the engine was queried during the AI turn: '..touches)
 assert(saved.llmdip_world_v1==before, 'the world was saved during the AI turn')
 assert(#saved.llmdip_world_bq==1, 'one battle queued, duplicates ignored')
 cm.model, cm.get_faction=real_model, real_faction
 -- The player's turn starts: the battle becomes an ordinary record.
 next_turn()
 local b=saved.llmdip_world_v1.b[1]
 assert(b and b.w=='a' and b.loss_status=='unknown' and next(b.destroyed)==nil)
 assert(#saved.llmdip_world_bq==0)
 assert(string.find(llmdip_world_court_report('ksl','player'),'you lost a battle against emp',1))
 assert(has_log('WORLD_BATTLE|emp|ksl|winner=a|siege=unknown|losses=unknown'))
 next_turn(); assert(#saved.llmdip_world_v1.b==1, 'a flushed battle is never recorded twice')
`));

test('a queued battle survives a manual battle that reloads the campaign mid AI turn',()=>run(`
 base_world(); first[1](); emit('ScriptEventPlayerFactionTurnEnd')
 prepare_battle(); emit('BattleCompleted')
 -- The player fights a battle by hand: the campaign scripts load again, still in the AI turn.
 myturn=false; first[1]()
 assert(#saved.llmdip_world_bq==1)
 prepare_battle({{12,103,'emp'}},{{23,204,'ksl'}}); emit('ScriptEventPendingBattle'); emit('BattleCompleted')
 assert(#saved.llmdip_world_bq==2)
 myturn=true; next_turn()
 assert(#saved.llmdip_world_v1.b==2)
 assert(string.find(llmdip_world_court_signals('ksl'),'losses:2',1))
`));

// The council of courts: dispatches, rumours, whispers and real deeds, all in the
// player's turn and all checked by the game first.
const council = `
 base_world(); saved.llmdip_campaign_id='c123'
 NAMES.factions_screen_name_emp='El Imperio'; NAMES.factions_screen_name_ksl='Kislev'
 llmdip_is_contact_enabled=function(key) return key~='grn' end
 ATT['emp>ksl']=90; ATT['ksl>emp']=90; ATT['emp>dwf']=-90; ATT['dwf>emp']=-90
 cm.force_alliance=function(self,a,b) relate(a,b,{d=true}) end
 cm.force_declare_war=function(self,a,b) relate(a,b,{w=true}) end
 cm.force_make_peace=function(self,a,b) relate(a,b,{}) end
 cm.force_make_trade_agreement=function(self,a,b) relate(a,b,{t=true}) end
 cm.force_non_aggression_pact=function(self,a,b) relate(a,b,{n=true}) end
 function plainfind(text, s) return string.find(text, (string.gsub(s, '[%^%$%(%)%%%.%[%]%*%+%-%?]', '%%%0')), 1) end
 function count_logs(pattern) local n=0 for _,l in ipairs(logs) do if plainfind(l,pattern) then n=n+1 end end return n end
`;

test('the turn asks the courts first and the briefing only after they answer',()=>run(council+`
 first[1]()
 local req=saved.llmdip_world_v1.courts
 assert(req and req.status=='pending' and req.t==1)
 assert(count_logs('[LLMDIP] COURTS|courts_1_')==1)
 assert(count_logs('BRIEFING|brief_')==0, 'the briefing waits for the courts')
 assert(llmdip_world_report().pending, 'the World tab says the court is preparing its report')
 local realms=table.concat(req.realms,',')
 assert(plainfind(realms,'emp') and plainfind(realms,'ksl') and not plainfind(realms,'grn'), realms)
 assert(llmdip_world_courts(req.id, {{f='emp', mood='scheming', stance='Orcs press us.', plans={}}})==true)
 assert(count_logs('BRIEFING|brief_')==1, 'the briefing is asked once the courts have spoken')
`));

test('rumours are published with their author, whispered to who would hear, and the plain gossip steps aside',()=>run(council+`
 first[1]()
 local req=saved.llmdip_world_v1.courts
 table.insert(saved.llmdip_world_v1.e, 1, {t=1,c='gossip',k='hatred',a='emp',b='dwf'})
 llmdip_world_courts(req.id, {
  {f='emp', mood='scheming', stance='We need Kislev.', plans={},
   r={k='scandal', about={'ksl'}, tx='En la corte de El Imperio dicen que la zarina Katarin de Kislev compra a sus boyardos con oro.'}},
  {f='ksl', mood='worried', stance='The north burns.', plans={}}})
 local found=false
 for _,e in ipairs(llmdip_world_entries()) do
  assert(e.kind~='gossip', 'attitude gossip is no longer shown')
  if e.kind=='rumour' and plainfind(e.text,'Katarin') then found=true end
 end
 assert(found, 'the rumour is in the World tab')
 local heard=saved.llmdip_world_v1.heard.ksl
 assert(heard and heard[1].by=='emp', 'Kislev hears what is said about it, and who said it')
 local text=llmdip_world_dispatch('ksl')
 assert(plainfind(text,'you heard a rumour spread by El Imperio'), text)
 local _, gossip=llmdip_world_brief('ksl','player')
 assert(plainfind(gossip,'a rumour spread by'), gossip)
`));

test("a sane plan between AI realms becomes a real treaty, told as that court's deed",()=>run(council+`
 first[1]()
 local req=saved.llmdip_world_v1.courts
 llmdip_world_courts(req.id, {
  {f='emp', mood='confident', stance='Together we hold.', plans={{d='ally', t='ksl', why='common foes', an='Karl Franz del Imperio sella una alianza con Katarin de Kislev ante la amenaza del norte.'}}},
  {f='ksl', mood='worried', stance='We need friends.', plans={{d='ally', t='emp', why='the north', an='Kislev se une al Imperio.'}}}})
 assert(REL['emp|ksl'] and REL['emp|ksl'].d, 'the alliance exists in the game')
 assert(has_log('COURT_DEED|ally|emp|ksl|called=true|visible=true'))
 assert(count_logs('COURT_DEED|')==1, 'one alliance, not two')
 local deed
 for _,e in ipairs(llmdip_world_entries()) do if e.kind=='deed' then deed=e end end
 assert(deed and plainfind(deed.text,'sella una alianza'))
 next_turn()
 assert(#entries_of('alliance_defensive')==0, 'not announced a second time as ordinary news')
`));

test('the game refuses insane or forbidden plans: wars on stronger realms, on the player, or with treaties off',()=>run(council+`
 F.dwf.str=1000; F.emp.str=100
 first[1]()
 local req=saved.llmdip_world_v1.courts
 llmdip_world_courts(req.id, {
  {f='emp', mood='furious', stance='Grudges.', plans={{d='war', t='dwf', why='old grudge', an='El Imperio declara la guerra a los Enanos.'}}},
  {f='ksl', mood='furious', stance='Hm.', plans={{d='war', t='player', why='envy', an='Kislev ataca.'}}}})
 assert(not (REL['dwf|emp'] and REL['dwf|emp'].w), 'no war against a realm ten times stronger')
 assert(count_logs('COURT_DEED|')==0)
 F.dwf.str=50; next_turn()
 req=saved.llmdip_world_v1.courts
 llmdip_world_toggle('treaties')
 llmdip_world_courts(req.id, {{f='emp', mood='furious', stance='Now.', plans={{d='war', t='dwf', why='old grudge', an='El Imperio declara la guerra a los Enanos.'}}}})
 assert(count_logs('COURT_DEED|')==0, 'treaties between AI switched off: nothing happens')
 llmdip_world_toggle('treaties'); next_turn()
 req=saved.llmdip_world_v1.courts
 llmdip_world_courts(req.id, {{f='emp', mood='vengeful', stance='Now.', plans={{d='war', t='dwf', why='old grudge', an='El Imperio declara la guerra a los Enanos de Karaz.'}}}})
 assert(REL['dwf|emp'] and REL['dwf|emp'].w, 'a winnable war with a motive does happen')
`));

test("a plan aimed at the player becomes the reason for that lord's letter, once",()=>run(council+`
 first[1]()
 local req=saved.llmdip_world_v1.courts
 llmdip_world_courts(req.id, {{f='ksl', mood='fearful', stance='The north is falling.', plans={{d='ask_player_help', t='player', why='the Chaos hordes at Praag'}}}})
 local motive=llmdip_world_letter_motive('ksl')
 assert(motive and plainfind(motive,'ask the player for help') and plainfind(motive,'Praag'), motive)
 assert(llmdip_world_letter_motive('emp')==nil)
 llmdip_world_motive_used('ksl')
 assert(llmdip_world_letter_motive('ksl')==nil, 'used once')
 assert(plainfind(llmdip_world_dispatch('ksl'),'you decided to ask the player for help'))
`));

test('late, foreign or silent councils change nothing, and the briefing still comes',()=>run(council+`
 first[1]()
 local req=saved.llmdip_world_v1.courts
 assert(llmdip_world_courts('courts_1_123', {{f='emp', plans={}}})==false, 'another request')
 assert(has_log('COURTS_ACK|courts_1_123'))
 round=2
 assert(llmdip_world_courts(req.id, {{f='emp', mood='content', plans={{d='ally', t='ksl', an='El Imperio y Kislev se alian.'}}}})==false, 'an answer from an earlier turn')
 assert(count_logs('COURT_DEED|')==0)
 round=1; next_turn()
 local real_time=os.time
 os.time=function() return real_time()+1000 end
 llmdip_world_tick()
 os.time=real_time
 assert(saved.llmdip_world_v1.courts.status=='timeout' and count_logs('BRIEFING|brief_2_')==1, 'a silent council does not cost the briefing')
`));

test('what each court can know goes out in one COURTS line, read by the companion with its own fog',async()=>{
 const { parseCourtsRequest, validateCourts, renderCourtsInbox, buildCourtsMessages } = await import('../src/court-council.js');
 // The line the game writes, taken from a real run of the world script.
 let line='';
 const L=fengari.lauxlib.luaL_newstate(); fengari.lualib.luaL_openlibs(L);
 const status=fengari.lauxlib.luaL_dostring(L,fengari.to_luastring(harness+'\n'+i18n+'\n'+world+'\n'+council+`
  first[1]()
  for _,l in ipairs(logs) do if plainfind(l,'[LLMDIP] COURTS|') then COURTS_LINE=l end end
  return COURTS_LINE`));
 assert.equal(status,fengari.lua.LUA_OK);
 line=fengari.to_jsstring(fengari.lua.lua_tostring(L,-1)); fengari.lua.lua_close(L);
 const request=parseCourtsRequest(line);
 assert.deepEqual(request.realms.map(r=>r.key).sort(),['dwf','emp','ksl']);
 const emp=request.realms.find(r=>r.key==='emp');
 assert.match(emp.block,/At war with: nobody/);
 assert.match(emp.block,/Dislikes: .*\[dwf\]/);
 assert.match(emp.block,/The player, .*\[player\]/);
 const courts=validateCourts({courts:[
  {realm:'emp',mood:'scheming',stance:'x',plans:[
   {do:'war',target:'dwf',why:'grudge',announce:'El Imperio declara la guerra a los Enanos.'},
   {do:'war',target:'ksl',why:'second war',announce:'El Imperio ataca también a Kislev.'}],
   rumour:{about:['ksl','nobody'],kind:'romance',text:'En la corte de El Imperio dicen que Katarin de Kislev suspira por Karl Franz.'}},
  {realm:'ksl',mood:'nonsense',plans:[{do:'war',target:'player',announce:'Kislev ataca al jugador sin piedad.'},{do:'ask_player_help',target:'player',why:'Praag'}]},
  {realm:'grn',mood:'furious',plans:[]}
 ]}, request.realms, request);
 assert.equal(courts.length,2,'a realm that was not asked is dropped');
 assert.deepEqual(courts[0].plans.map(p=>p.d+':'+p.t),['war:dwf'],'one war at most');
 assert.equal(courts[0].r?.k, request.romance ? 'romance' : undefined);
 assert.deepEqual(courts[1].plans.map(p=>p.d+':'+p.t),['ask_player_help:player'],'never a war plan on the player');
 assert.equal(courts[1].mood,'content');
 const inbox=renderCourtsInbox(request.id,courts);
 assert.match(inbox,/^if llmdip_world_courts then llmdip_world_courts\("courts_1_\d+", \{\{f = "emp"/);
 const messages=buildCourtsMessages(request,request.realms,'Spanish');
 assert.match(messages[0].content,/RUMOURS are the life of the courts/);
 assert.match(messages[0].content,/Never against a far stronger realm/);
 assert.match(messages[0].content,/in Spanish/);
 // The answer runs as Lua in the game: it must load there.
 const L2=fengari.lauxlib.luaL_newstate(); fengari.lualib.luaL_openlibs(L2);
 assert.equal(fengari.lauxlib.luaL_loadstring(L2,fengari.to_luastring(inbox)),fengari.lua.LUA_OK);
 fengari.lua.lua_close(L2);
});

test("a lord's letter carries their court's council near the end, and the dossier does not repeat it",()=>{
 const request={campaignId:'c',sender:'player',interlocutor:'ksl',turn:2,mode:'player',message:'Hola',identity:{},playerIdentity:{},
  state:'turn=2,court_dispatch=mood fearful / you decided to ask the player for help (Praag),mil_alliance=0',
  fields:{court_dispatch:'mood fearful / you decided to ask the player for help (Praag)',mil_alliance:'0'}};
 const text=buildMessages(request,[],{},'English')[1].content;
 assert.match(text,/YOUR COURT'S COUNCIL THIS TURN[^\n]*\n- mood fearful\n- you decided to ask the player for help \(Praag\)/);
 assert.ok(text.indexOf("YOUR COURT'S COUNCIL") > text.indexOf('WHAT YOU REMEMBER OF THIS RULER'));
 assert.ok(text.indexOf("YOUR COURT'S COUNCIL") < text.indexOf('TREATIES BETWEEN YOU TWO RIGHT NOW'));
 assert.doesNotMatch(text,/court_dispatch=/);
});

test("no court's war can drag the player in: never against the player's allies or vassals",()=>run(council+`
 relate('player','dwf',{d=true}); F.dwf.str=50; F.emp.str=100
 first[1]()
 local req=saved.llmdip_world_v1.courts
 llmdip_world_courts(req.id, {{f='emp', mood='vengeful', stance='Now.', plans={{d='war', t='dwf', why='old grudge', an='El Imperio declara la guerra a los Enanos de Karaz.'}}}})
 assert(not (REL['dwf|emp'] and REL['dwf|emp'].w), 'the player is allied with the target')
 assert(count_logs('COURT_DEED|')==0)
`));

test('each court is offered the moves the game would accept, and only two courts write to the player',()=>run(council+`
 first[1]()
 local req=saved.llmdip_world_v1.courts
 -- The facts went out with the moves; read them back from the log line.
 local line
 for _,l in ipairs(logs) do if plainfind(l,'[LLMDIP] COURTS|') then line=l end end
 local facts=string.gsub(line, '%%(%x%x)', function(h) return string.char(tonumber(h,16)) end)
 assert(plainfind(facts,'Moves the game would accept now (realm keys): ally with ksl'), facts)
 local three={}
 for _,key in ipairs(req.realms) do three[#three+1]={f=key, mood='worried', stance='x', plans={{d='ask_player_help', t='player', why='help'}}} end
 llmdip_world_courts(req.id, three)
 local writers=0
 for _,key in ipairs(req.realms) do if llmdip_world_letter_motive(key) then writers=writers+1 end end
 assert(writers==2, 'at most two letters a turn come from the council: '..writers)
`));

test('keys copied with their brackets are understood, and never reach the player',async()=>{
 const { parseCourtsRequest, validateCourts } = await import('../src/court-council.js');
 const facts='Player: Sylvania [p], ruled by Vlad\nTurn: 2\nRomance rumours: allowed\n#REALM emp\nRealm: Empire [emp]. Ruler: Karl\nFond of: Katarin of Kislev [ksl] (roughly your equal).';
 const request=parseCourtsRequest(`[LLMDIP] COURTS|courts_2_99|c1|p|2|es|${encodeURIComponent(facts)}`);
 const [court]=validateCourts({courts:[{realm:'[emp]',mood:'content',plans:[{do:'ally',target:'[ksl]',why:'x',announce:'Karl Franz del Imperio [emp] sella una alianza con Katarin de Kislev.'}],
  rumour:{about:['[ksl]'],kind:'romance',text:'En la corte del Imperio [emp] se dice que Katarin de Kislev [ksl] escribe demasiado a Karl Franz.'}}]}, request.realms, request);
 assert.equal(court.f,'emp');
 assert.deepEqual(court.plans.map(p=>p.t),['ksl']);
 assert.doesNotMatch(court.plans[0].an,/\[/);
 assert.deepEqual(court.r.about,['ksl']);
 assert.doesNotMatch(court.r.tx,/\[/);
});

test("a lord's court names each realm with its people, so the lord knows who they are",()=>run(`
 base_world(); relate('emp','ksl',{w=true})
 NAMES.factions_screen_name_ksl='Hueste de los Trillizos'
 NAMES.cultures_subcultures_name_wh3_main_sc_ksl_kislev='Guerreros del Caos'
 first[1]()
 local report=llmdip_world_court_report('emp','player')
 assert(string.find(report,'Hueste de los Trillizos %(Guerreros del Caos%)',1), report)
`));

test('letters never show markdown asterisks in the game',async()=>{
 const { parseDiplomacyResponse } = await import('../src/tag-parser.js');
 const parsed=parseDiplomacyResponse('La corte los llama **Hueste de los Trillizos**; __nos odian__. [diplo:reject] [relation:delta=1;reason=respect]');
 assert.equal(parsed.narrative,'La corte los llama Hueste de los Trillizos; nos odian.');
});

test('the turn sends the codex: every realm with the names the player sees, read by the companion',async()=>{
 const { parseCodexLine } = await import('../src/codex.js');
 const L=fengari.lauxlib.luaL_newstate(); fengari.lualib.luaL_openlibs(L);
 const status=fengari.lauxlib.luaL_dostring(L,fengari.to_luastring(harness+'\n'+i18n+'\n'+world+'\n'+`
  base_world(); saved.llmdip_campaign_id='c123'
  NAMES.factions_screen_name_ksl='La Corte de Hielo'; NAMES.cultures_subcultures_name_wh3_main_sc_ksl_kislev='Kislev'
  F.ksl.leader='wh3_main_ksl_katarin'
  first[1]()
  for _,l in ipairs(logs) do if string.find(l,'%[LLMDIP%] CODEX|',1) then CODEX_LINE=l end end
  return CODEX_LINE`));
 assert.equal(status,fengari.lua.LUA_OK,status!==fengari.lua.LUA_OK?fengari.to_jsstring(fengari.lua.lua_tostring(L,-1)):'');
 const line=fengari.to_jsstring(fengari.lua.lua_tostring(L,-1)); fengari.lua.lua_close(L);
 const index=parseCodexLine(line);
 assert.equal(index.campaignId,'c123');
 const ksl=index.realms.find(r=>r.key==='ksl');
 assert.equal(ksl.name,'La Corte de Hielo');
 assert.equal(ksl.people,'Kislev');
 assert.equal(ksl.subtype,'wh3_main_ksl_katarin');
 assert.ok(index.realms.find(r=>r.key==='player').player, 'the player is marked');
});

// 03-10-2026 log: the inbox ran the same briefing four times before the companion read
// the acknowledgement. Every inbox entry point must be harmless when repeated.
test('an inbox entry repeated every second changes nothing the second time',()=>run(`
 base_world(); saved.llmdip_campaign_id='c123'; first[1]()
 local id=saved.llmdip_world_v1.brief.id
 for i=1,4 do llmdip_world_briefing(id,'My lord, the Ice Court has sealed a pact with the ogres this turn.') end
 local copies=0
 for _,m in ipairs(llmdip_council_history()) do if m.who=='court' then copies=copies+1 end end
 assert(copies==1, 'the report is in the court conversation once: '..copies)
 llmdip_world_briefing_failed(id)
 assert(llmdip_world_report() and not llmdip_world_report().pending, 'a late failure does not undo a ready report')
 -- A save from before the fix: its repeated copies are folded on load.
 local w=saved.llmdip_world_v1
 w.council={{w='court',x='Same.',t=1},{w='court',x='Same.',t=1},{w='you',x='Hi',t=1},{w='court',x='Same.',t=1}}
 first[1]()
 assert(#llmdip_council_history()==3, 'adjacent copies folded, separate ones kept')
`));

// A big campaign over ten turns: 28 realms, 8 courts, dispatches with every kind of plan,
// rumours and AI-turn battles. Nothing may error, the limits must hold.
test('ten turns of a big campaign: no errors, every limit holds',()=>run(`
 base_world(); saved.llmdip_campaign_id='c123'
 local subs={'wh_main_sc_emp_empire','wh3_main_sc_ksl_kislev','wh_main_sc_dwf_dwarfs','wh_main_sc_grn_greenskins','wh3_main_sc_cth_cathay','wh3_main_sc_ogr_ogre_kingdoms','wh_main_sc_chs_chaos'}
 for i=1,24 do
  F['r'..i]={rank=i+3, regions={'x'..i..'a','x'..i..'b'}, sub=subs[(i%7)+1], met=true, str=50+i*10, leader='lord_'..i}
 end
 for i=1,24 do for j=i+1,24 do
  if (i*j)%11==0 then relate('r'..i,'r'..j,{w=true}) elseif (i+j)%9==0 then relate('r'..i,'r'..j,{d=true}) elseif (i+j)%5==0 then relate('r'..i,'r'..j,{t=true}) end
  ATT['r'..i..'>r'..j]=((i*7+j*3)%200)-100; ATT['r'..j..'>r'..i]=((j*5+i*11)%200)-100
 end end
 llmdip_is_contact_enabled=function(key) return true end
 local forced=0
 cm.force_alliance=function(self,a,b) forced=forced+1; relate(a,b,{d=true}) end
 cm.force_declare_war=function(self,a,b) forced=forced+1; relate(a,b,{w=true}) end
 cm.force_make_peace=function(self,a,b) forced=forced+1; relate(a,b,{}) end
 cm.force_make_trade_agreement=function(self,a,b) forced=forced+1; relate(a,b,{t=true}) end
 cm.force_non_aggression_pact=function(self,a,b) forced=forced+1; relate(a,b,{n=true}) end
 local kinds={'ally','war','peace','trade','nap','ask_player_help','threaten_player','consolidate'}
 local maxfacts, maxdeeds = 0, 0
 first[1]()
 for turn=1,10 do
  local req=saved.llmdip_world_v1.courts
  assert(req and req.status=='pending' and #req.realms<=8, 'turn '..turn..': a council is asked for at most eight courts')
  for _,l in ipairs(logs) do
   if string.find(l,'%[LLMDIP%] COURTS|courts_'..req.t..'_',1) then
    local facts=string.gsub(string.match(l,'|([^|]*)$'), '%%(%x%x)', function(h) return string.char(tonumber(h,16)) end)
    if #facts>maxfacts then maxfacts=#facts end
   end
  end
  local list={}
  for n,key in ipairs(req.realms) do
   local target=req.realms[(n % #req.realms)+1]
   local kind=kinds[((n+turn) % #kinds)+1]
   list[#list+1]={f=key, mood='scheming', stance='Turn '..turn, plans={{d=kind, t=(kind:find('player') and 'player') or (kind=='consolidate' and '') or target, why='because', an=key..' acts against '..target..' this turn.'}},
    r={k='scandal', about={target}, tx='At the court of '..key..' they say that '..target..' bribes its own generals.'}}
  end
  local before=forced
  llmdip_world_courts(req.id, list)
  local deeds=forced-before
  if deeds>maxdeeds then maxdeeds=deeds end
  assert(deeds<=2, 'turn '..turn..': at most two deeds, got '..deeds)
  -- The AI's turn: battles only queue.
  emit('ScriptEventPlayerFactionTurnEnd')
  prepare_battle({{1,100+turn,'r1'}},{{2,200+turn,'r2'}}); emit('ScriptEventPendingBattle'); emit('BattleCompleted')
  next_turn()
 end
 for _,l in ipairs(logs) do assert(not string.find(l,'_ERROR',1), l) end
 assert(maxfacts<=11000, 'COURTS facts stay under the cap: '..maxfacts)
 assert(#saved.llmdip_world_v1.e<=200, 'the chronicle stays bounded')
 local codex
 for _,l in ipairs(logs) do if string.find(l,'%[LLMDIP%] CODEX|',1) then codex=l end end
 assert(codex and #codex<20000, 'the codex line stays small')
 out('STRESS|facts='..maxfacts..'|deeds='..maxdeeds..'|codex='..#codex..'|entries='..#saved.llmdip_world_v1.e)
`));
