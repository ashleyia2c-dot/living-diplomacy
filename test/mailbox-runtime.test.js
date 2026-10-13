import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fengari from 'fengari';
import luaparse from 'luaparse';
import { MemoryStore } from '../src/memory-store.js';

const {lua,lauxlib,lualib,to_luastring,to_jsstring}=fengari;
const read = name => fs.readFileSync(new URL('../mod/script/campaign/mod/'+name,import.meta.url),'utf8');
const mailbox=read('llm_diplomacy_mailbox.lua'), bridge=read('llm_diplomacy.lua');
// Los textos viven en su propio chunk. Sin el, un fichero ejecutado suelto no
// tendria llmdip_t y reventaria en la primera etiqueta que intente pintar.
const i18n=read('llm_diplomacy_i18n.lua');
const harness=String.raw`
setfenv=function() end
-- WH3 replaces string.find: its native wrapper accepts two or three arguments,
-- not Lua's optional fourth plain flag. Keep the mock stricter than Fengari.
local standard_find=string.find
string.find=function(...)
 assert(select('#',...)<=3, 'WH3 string.find: unsupported fourth argument poisons native argument reader')
 return standard_find(...)
end
listeners={}; first={}; saved={}; widgets={}; phase=true; battle=false; round=1; requests=0; opens=0; callbacks={}
out=function() end
core={get_env=function() return _G end, remove_listener=function() end,
 add_listener=function(self,name,event,condition,callback) listeners[name]={event=event,condition=condition,callback=callback} end}
function fire(name, id) listeners[name].callback({string=id}) end
cm={add_first_tick_callback=function(self,fn) table.insert(first,fn) end,
 -- El juego real tiene real_callback (reloj de pared, el unico que avanza
 -- mientras la diplomacia congela la campana). Aqui se guardan para dispararlos
 -- a mano en la prueba que los necesite.
 real_callback=function(self,fn,ms) callbacks[#callbacks+1]={fn=fn,ms=ms} end,
 get_saved_value=function(self,key) return saved[key] end,
 set_saved_value=function(self,key,value) saved[key]=value end,
 is_processing_battle=function() return battle end,
 is_pending_battle_active=function() return battle end,
 model=function() return {turn_number=function() return round end} end,
 get_faction=function() return {is_dead=function() return false end,is_human=function() return false end,is_null_interface=function() return false end} end}
function llmdip_player_phase() return phase end
function llmdip_mail_request(excluded)
 requests=requests+1
 if not excluded.ai then return 'ai' end
 if not excluded.ai2 then return 'ai2' end
 return false,true
end
function llmdip_ui_open_target(target) opens=opens+1; return true end
function widget(id,parent)
 local w={id=id,parent=parent,visible=true,children={}}
 if parent then parent.children[id]=w end
 widgets[id]=w
 function w:IsValid() return true end
 function w:CreateComponent(id,template)
  local child=widget(id,self); child.template=template
  if template=='ui/templates/square_medium_text_button' then widget('button_txt',child) end
  if template=='llmdip_ui/llmdip_chat' then widget('entry_box',child) end
  if template=='llmdip_ui/llmdip_shell' then
   widget('header_title',child); widget('header_meta',child); widget('header_attitude',child)
   local card=widget('proposal_card',child)
   widget('proposal_title',card); widget('proposal_detail',card)
  end
  if template=='llmdip_ui/llmdip_history' then
   widget('history_text',child)
   child.SetStateText=function() error('Do not write to a non-text container') end
  end
  if template=='llmdip_ui/llmdip_bubble' then
   widget('bubble_text',child)
   child.SetStateText=function() error('Do not write to a non-text container') end
  end
  return child
 end
 function w:SetVisible(v) self.visible=v end
 function w:SetStateText(v) self.text=v end
 function w:SetTooltipText(v) self.tooltip=v end
 function w:Bounds() return 1920,1080 end
 function w:Position() return self.x or 0,self.y or 0 end
 for _,name in ipairs({'SetCanResizeWidth','SetCanResizeHeight','Resize','SetImagePath','SetDockingPoint','SetDockOffset','SetInteractive','PropagatePriority','MoveTo','RegisterTopMost','RemoveTopMost'}) do w[name]=function() end end
 function w:SetDockingPoint(value) self.dock=value end
 function w:SetDockOffset(x,y) self.x=x; self.y=y end
 function w:MoveTo(x,y) self.x=x; self.y=y end
 function w:PropagatePriority(value) self.priority=value end
 function w:Resize(width,height) self.width=width; self.height=height end
 function w:SetInteractive(value) self.interactive=value end
 function w:Destroy()
  self.visible=false
  if self.parent then self.parent.children[self.id]=nil end
  if widgets[self.id]==self then widgets[self.id]=nil end
 end
 return w
end
root=widget('root'); widget('menu_bar',root); widget('buttongroup',widgets.menu_bar)
core.get_ui_root=function() return root end
find_uicomponent=function(parent,id) return parent.children[id] or (parent==root and widgets[id] or nil) end
core.get_or_create_component=function(self,id,template,parent) return parent.children[id] or parent:CreateComponent(id,template) end
UIComponent=function(v) return v end
is_uicomponent=function(v) return type(v)=='table' end
function set_up(fn,name,value)
 for i=1,100 do local n=debug.getupvalue(fn,i); if not n then break end
  if n==name then debug.setupvalue(fn,i,value); return end
 end
 error('Missing upvalue '..name)
end
`;
function run(source, body) {
 const L=lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
 try {
  const status=lauxlib.luaL_dostring(L,to_luastring(harness+'\n'+i18n+'\n'+source+'\n'+body));
  assert.equal(status,lua.LUA_OK,status!==lua.LUA_OK?to_jsstring(lua.lua_tostring(L,-1)):'');
 } finally {lua.lua_close(L);}
}
test('all five campaign files parse as Lua 5.1; mailbox has no AI opening/intervention',()=>{
 for(const name of ['llm_diplomacy.lua','llm_diplomacy_i18n.lua','llm_diplomacy_ui.lua','llm_diplomacy_mailbox.lua','llm_diplomacy_world.lua']) luaparse.parse(read(name),{luaVersion:'5.1'});
 assert.doesNotMatch(mailbox,/OpenDiplomacyWith|intervention:new|trigger_transient_intervention|FactionTurnStart/);
 assert.doesNotMatch(bridge,/llmdip_proactive_turn|llm_diplomacy_initiative/);
 assert.match(bridge,/add_faction_turn_start_listener_by_name/);
});
for(const [name,body] of [
 ['AI turns do not query or create UI',`phase=false; llmdip_mail_tick(); assert(requests==0 and widgets.llmdip39_mail_button==nil)`],
 ['battles do not query or create UI',`battle=true; llmdip_mail_tick(); assert(requests==0 and widgets.llmdip39_mail_button==nil)`],
 ['each enabled sender is checked once, and load keeps per-turn attempts',`first[1](); for i=1,20 do llmdip_mail_tick() end; assert(requests==3 and saved.llmdip39_mailbox.queries==2); first[1](); llmdip_mail_tick(); assert(requests==3); round=2; llmdip_mail_tick(); assert(requests==4)`],
 ['incoming message never opens diplomacy; identities persist',`first[1](); llmdip_mail_receive('r1',{interlocutor='ai',faction_name='Kislev',leader='Katarin',turn=1},'Saludos','reject'); assert(opens==0); assert(saved.llmdip39_mailbox.rows[1].lord=='Katarin'); assert(not saved.llmdip39_mailbox.rows[1].read)`],
 ['duplicates are ignored and saved rows are isolated copies',`first[1](); llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Carta','reject'); local old=saved.llmdip39_mailbox; llmdip_mail_read('ai'); assert(old.rows[1].read==false); assert(saved.llmdip39_mailbox.rows[1].read); llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Duplicada','reject'); assert(#saved.llmdip39_mailbox.rows==1)`],
 ['explicit reply uses shared conversation, closing does not query',`first[1](); llmdip_mail_tick(); llmdip_mail_receive('r1',{interlocutor='ai',turn=1,faction_name='Kislev',leader='Katarin'},'Carta','reject'); fire('llmdip39_mail_click','llmdip39_mail_button'); assert(widgets.llmdip_hub_shell.visible); fire('llmdip39_mail_click','llmdip39_mail_reply_1'); assert(opens==1 and not widgets.llmdip_hub_shell.visible)`],
 ['closed mailbox stays closed on arrival',`first[1](); llmdip_mail_tick(); fire('llmdip39_mail_click','llmdip39_mail_button'); fire('llmdip39_mail_click','llmdip39_mail_button'); assert(not widgets.llmdip_hub_shell.visible); llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Carta','reject'); assert(not widgets.llmdip_hub_shell.visible and opens==0)`],
 ['blocking panels suspend queries and hide the mailbox',`first[1](); llmdip_mail_tick(); fire('llmdip39_mail_click','llmdip39_mail_button'); fire('llmdip39_mail_panel_open','popup_pre_battle'); llmdip_mail_tick(); assert(requests==1 and not widgets.llmdip_hub_shell.visible); fire('llmdip39_mail_panel_close','popup_pre_battle'); llmdip_mail_tick(); assert(requests==2)`],
 ['ignored unread letters do not stop background queries or open diplomacy',`first[1](); for i=1,4 do llmdip_mail_receive('r'..i,{interlocutor='ai',turn=1},'Carta','reject') end; llmdip_mail_tick(); assert(requests==1 and opens==0)`],
 ['restoring older mailbox snapshot excludes future letters',`first[1](); llmdip_mail_receive('old',{interlocutor='ai',turn=1},'Antes','reject'); local snapshot=saved.llmdip39_mailbox; llmdip_mail_receive('future',{interlocutor='ai',turn=2},'Después','reject'); saved.llmdip39_mailbox=snapshot; first[1](); llmdip_mail_read('ai'); assert(#saved.llmdip39_mailbox.rows==1 and saved.llmdip39_mailbox.rows[1].id=='old')`]
]) test(name,()=>run(mailbox,body));
test('temporary unready state does not suppress letters for the entire round',()=>run(mailbox,`
 first[1](); llmdip_mail_request=function() requests=requests+1; return false end
 llmdip_mail_tick(); llmdip_mail_tick(); assert(requests==2)
 llmdip_mail_request=function() requests=requests+1; return false,true end
 llmdip_mail_tick(); llmdip_mail_tick(); assert(requests==3)
`));

test('invalid campaign root is rejected before native lookup or creation',()=>run(mailbox,`
 first[1](); root.IsValid=function() return false end
 find_uicomponent=function() error('Native lookup must not run') end
 llmdip_mail_tick(); llmdip_mail_hide()
 assert(requests==0 and widgets.llmdip39_mail_button==nil)
`));

test('root rejected by type helper is never passed to native lookup',()=>run(mailbox,`
 first[1](); is_uicomponent=function() return false end
 find_uicomponent=function() error('Native lookup must not run') end
 llmdip_mail_tick(); assert(requests==0)
`));

test('mail button is owned by root, not an engine toolbar',()=>run(mailbox,`
 first[1](); llmdip_mail_tick()
 assert(widgets.llmdip39_mail_button.parent==root)
`));

test('one entry button with a readable label, top-left docking and priority',()=>run(mailbox,`
 first[1](); llmdip_mail_tick()
 local b=widgets.llmdip39_mail_button
 assert(b.template=='ui/templates/square_medium_text_button')
 assert(b.dock==1 and b.x==20 and b.y==123 and b.priority==200)
 assert(b.width==210 and b.height==36 and b.interactive)
 assert(b.children.button_txt.text==llmdip_t('hub_button')..' (0)' and not b.children.button_txt.interactive)
 llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Carta','reject')
 assert(b.children.button_txt.text==llmdip_t('hub_button')..' (1)')
`));

test('the contacts tab draws text-template rows inside the window frame',()=>run(mailbox,`
 llmdip_toggle_contact=function() return true end
 llmdip_contact_groups=function() return {{key='ksl',name='Kislev',count=1,enabled=0,factions={{key='ai',name='Katarin',enabled=false}}}} end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_contacts')
 local shell, nav, row=widgets.llmdip_hub_shell, widgets.llmdip_hub_nav, widgets.llmdip_hub_row_1
 assert(nav.template=='ui/templates/square_medium_text_button' and nav.parent==root)
 assert(nav.children.button_txt.text==llmdip_t('see_all_factions'))
 assert(row.parent==root and row.children.button_txt.text=='Kislev (0/1'..llmdip_t('enabled_suffix'))
 assert(row.x>=shell.x and row.x+row.width<=shell.x+680 and row.y>=shell.y+60 and row.y+row.height<=shell.y+500)
 assert(not widgets.llmdip_hub_mark_1.visible, 'races show counts, not a tick')
 fire('llmdip39_mail_click','llmdip_hub_row_1')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Katarin'..'  ['..llmdip_t('contact_off')..']')
 assert(not widgets.llmdip_hub_mark_1.visible, 'no tick while it cannot write: the cross looked like close')
 assert(widgets.llmdip_hub_race_on.visible and widgets.llmdip_hub_race_off.visible)
 fire('llmdip39_mail_click','llmdip_hub_row_1')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Katarin'..'  ['..llmdip_t('contact_on')..']', 'the click answers at once')
 assert(widgets.llmdip_hub_mark_1.visible)
 assert(widgets.llmdip_hub_nav.children.button_txt.text==llmdip_t('back_to_races'))
 assert(not widgets.llmdip_hub_card_1.visible, 'letters are hidden on this tab')
`));

test('the window reuses the chat frame and message cards, and closes without destruction',()=>run(mailbox,`
 first[1](); llmdip_mail_tick()
 local chat=root:CreateComponent('llmdip_diplomacy_shell','llmdip_ui/llmdip_shell')
 chat.children.header_title:SetStateText('Katarin')
 fire('llmdip39_mail_click','llmdip39_mail_button')
 local shell, card=widgets.llmdip_hub_shell, widgets.llmdip_hub_card_1
 assert(shell.template=='llmdip_ui/llmdip_shell' and shell.parent==root and shell.visible)
 assert(shell.width==680 and shell.height==500)
 assert(shell.children.header_title.text==llmdip_t('hub_title'))
 assert(not shell.children.header_attitude.visible and not shell.children.proposal_card.visible)
 assert(card.template=='llmdip_ui/llmdip_bubble' and card.parent==root and card.visible)
 assert(string.find(card.children.bubble_text.text,llmdip_t('letters_empty'),1))
 fire('llmdip39_mail_click','llmdip39_mail_close'); assert(not shell.visible and not card.visible)
 fire('llmdip39_mail_click','llmdip39_mail_button'); assert(shell==widgets.llmdip_hub_shell and shell.visible)
 assert(chat.children.header_title.text=='Katarin', 'the chat frame is never touched')
`));

test('localized faction labels and alphabetical order retain internal action keys',()=>run(bridge,`
 common={get_localised_string=function(key)
  return ({factions_screen_name_ai_a='Sylvania',factions_screen_name_ai_b='Carcassonne'})[key] or ''
 end}
 cm.get_local_faction=function() return {name=function() return 'player' end,is_null_interface=function() return false end,
  factions_met=function() return {num_items=function() return 2 end,item_at=function(self,i) return {
   name=function() return i==0 and 'ai_a' or 'ai_b' end,is_human=function() return false end,is_dead=function() return false end} end} end} end
 saved.llmdip_contacts_player=',ai_b,'
 local factions=llmdip_contact_groups()[1].factions
 assert(factions[1].key=='ai_b' and factions[1].name=='Carcassonne' and factions[1].enabled==true)
 assert(factions[2].key=='ai_a' and factions[2].name=='Sylvania' and factions[2].enabled==false)
`));

test('contact groups exclude dead and human factions, count each race and switch through events',()=>run(bridge,`
 local factions={}
 for i=1,11 do factions[#factions+1]={key='dark_'..i,race='wh2_main_sc_def_dark_elves'} end
 factions[#factions+1]={key='kislev',race='wh3_main_sc_ksl_kislev'}
 factions[#factions+1]={key='dead',race='wh_main_sc_dwf_dwarfs',dead=true}
 factions[#factions+1]={key='human',race='wh_main_sc_emp_empire',human=true}
 common={get_localised_string=function(key) return key end}
 cm.get_local_faction=function() return {name=function() return 'player' end,
  is_null_interface=function() return false end,command_queue_index=function() return 1 end,
  factions_met=function() return {num_items=function() return #factions end,item_at=function(self,i)
   local f=factions[i+1]
   return {name=function() return f.key end,subculture=function() return f.race end,
    is_dead=function() return f.dead or false end,is_human=function() return f.human or false end}
  end} end} end
 saved.llmdip_contacts_player=',dark_1,'
 local groups=llmdip_contact_groups()
 assert(#groups==2, 'dead and human factions never appear')
 assert(groups[1].key=='wh2_main_sc_def_dark_elves' and groups[1].name=='Elfos Oscuros')
 assert(groups[1].count==11 and groups[1].enabled==1 and groups[1].factions[1].key=='dark_1' and groups[1].factions[1].enabled)
 assert(groups[2].key=='wh3_main_sc_ksl_kislev' and groups[2].count==1 and groups[2].enabled==0)
 local trigger
 CampaignUI={TriggerCampaignScriptEvent=function(cqi,event) trigger=event end}
 llmdip_toggle_contact('kislev'); assert(trigger=='LLMDIP2|T|kislev')
 assert(saved.llmdip_contacts_player==',dark_1,', 'the switch travels as an event, never written directly')
`));

test('contacts paginate seven rows at a time and a queued refresh never reopens a closed window',()=>run(mailbox,`
 local dark={}
 for i=1,11 do dark[#dark+1]={key='dark_'..i,name='Dark '..string.format('%02d',i),enabled=i==1} end
 local groups={{key='dark',name='Elfos Oscuros',count=11,enabled=1,factions=dark},
  {key='ksl',name='Kislev',count=1,enabled=0,factions={{key='kislev',name='Kislev',enabled=false}}}}
 llmdip_contact_groups=function() return groups end
 local toggled={}
 llmdip_toggle_contact=function(key) toggled[#toggled+1]=key end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_contacts')
 fire('llmdip39_mail_click','llmdip_hub_row_1')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Dark 01'..'  ['..llmdip_t('contact_on')..']')
 assert(widgets.llmdip39_mail_next.visible and not widgets.llmdip39_mail_prev.visible)
 fire('llmdip39_mail_click','llmdip39_mail_next')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Dark 08'..'  ['..llmdip_t('contact_off')..']')
 assert(widgets.llmdip39_mail_prev.visible and not widgets.llmdip39_mail_next.visible)
 assert(not widgets.llmdip_hub_row_5.visible, 'page two has four rows')
 fire('llmdip39_mail_click','llmdip_hub_race_on')
 assert(#toggled==10, 'turning a race on only flips the factions that were off')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Dark 08'..'  ['..llmdip_t('contact_on')..']', 'the row shows the switch at once')
 fire('llmdip39_mail_click','llmdip_hub_nav')
 fire('llmdip39_mail_click','llmdip_hub_row_2')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Kislev'..'  ['..llmdip_t('contact_off')..']' and not widgets.llmdip39_mail_next.visible)
 callbacks={}
 fire('llmdip39_mail_click','llmdip_hub_mark_1'); assert(toggled[#toggled]=='kislev')
 fire('llmdip39_mail_click','llmdip39_mail_close')
 for _,c in ipairs(callbacks) do c.fn() end
 assert(not widgets.llmdip_hub_shell.visible, 'a queued refresh must not reopen a closed window')
`));

// El valor de actitud sale del tooltip de diplomacia vanilla, que esta traducido.
// Si el idioma del jugador no se reconoce, el mod se queda sin el dato mas
// importante de la relacion y el lord habla como si no os conocierais.
// El idioma de la interfaz lo dice el propio juego. Antes esperaba al companion, y un
// inbox viejo con llmdip_set_language("en") dejaba en ingles una partida en español.
test('el idioma de la interfaz sale del juego y un inbox viejo no lo pisa',()=>run(mailbox,`
 common={get_localised_string=function(key)
  if key=='uied_component_texts_localised_string_tx_total_attitude_NewState_Text_5c0047' then return 'Valor total de actitud:' end
  return ''
 end}
 llmdip_set_language('en')
 assert(llmdip_language()=='es')
 assert(llmdip_t('races')=='Razas')
 assert(llmdip_t('ai_factions_button')=='Facciones IA')
`));

// El puente manda al companion solo el idioma que el juego ha confirmado: nunca una
// suposicion, que es justo lo que dejaba las cartas en el idioma equivocado.
test('el puente solo informa del idioma confirmado por el juego',()=>run(bridge,`
 common={get_localised_string=function() return '' end}
 assert(llmdip_game_language()==nil)
 common={get_localised_string=function(key)
  if key=='uied_component_texts_localised_string_tx_total_attitude_NewState_Text_5c0047' then return 'Total attitude value:' end
  return ''
 end}
 assert(llmdip_game_language()=='en')
`));

// Si el juego no responde a la sonda, el idioma que manda el companion sigue valiendo.
test('sin respuesta del juego, el idioma del companion sirve de respaldo',()=>run(mailbox,`
 common={get_localised_string=function() return '' end}
 llmdip_set_language('fr')
 assert(llmdip_t('races')=='Races')
 assert(llmdip_t('next_page_btn')=='suivantes >')
`));

// La clave real de la base de datos es cultures_subcultures_name_<raza>; con la que se
// usaba antes (subcultures_name_) nunca resolvia y todo el mundo veia las razas en español.
test('los nombres de raza salen de la localizacion del juego',()=>run(bridge,`
 common={get_localised_string=function(key)
  if key=='cultures_subcultures_name_wh2_main_sc_def_dark_elves' then return 'Dunkelelfen' end
  return key
 end}
 cm.get_local_faction=function() return {name=function() return 'player' end,
  is_null_interface=function() return false end,command_queue_index=function() return 1 end,
  factions_met=function() return {num_items=function() return 1 end,item_at=function()
   return {name=function() return 'dark_1' end,subculture=function() return 'wh2_main_sc_def_dark_elves' end,
    is_dead=function() return false end,is_human=function() return false end}
  end} end} end
 local name=llmdip_contact_groups()[1].name
 assert(name=='Dunkelelfen', name)
`));

test('el valor de actitud se lee del tooltip en cualquier idioma',()=>run(read('llm_diplomacy_ui.lua'),`
 common={get_localised_string=function() return '' end}
 assert(attitude_from_tooltip('Casa Real\\nTotal attitude value: 42')==42)
 assert(attitude_from_tooltip('Valor total de actitud: -17')==-17)
 assert(attitude_from_tooltip('Gesamteinstellung: 8')==8)
 assert(attitude_from_tooltip("Valeur totale de l'attitude : -3")==-3)
 assert(attitude_from_tooltip('Toplam tutum değeri: 11')==11)
 assert(attitude_from_tooltip('총 태도 가치: -5')==-5)
 -- Chino: dos puntos de ancho completo.
 assert(attitude_from_tooltip('总体态度值：25')==25)
 assert(attitude_from_tooltip('總態度值：-9')==-9)
 -- Respaldo para un idioma o formato que no reconozcamos.
 assert(attitude_from_tooltip('Etiqueta rara: 7')==7)
 assert(attitude_from_tooltip('un tooltip sin numeros')==nil)
`));

// La etiqueta del idioma activo la da el juego, y manda sobre la tabla fija.
test('la etiqueta viva del juego tiene prioridad sobre la tabla',()=>run(read('llm_diplomacy_ui.lua'),`
 common={get_localised_string=function() return 'Pozornost celkem:' end}
 assert(attitude_from_tooltip('Pozornost celkem: 33')==33)
`));
test('the editable box stops before the buttons, which sit outside it inside the row',()=>run(read('llm_diplomacy_ui.lua'),`
 -- In game the chat component IS the entry box; its width is the wrap width.
 -- Buttons dock to its right edge with positive offsets (outside the box).
 local chat,history,shell=ensure_owned_ui()
 local send=chat.children.llmdip_diplomacy_send
 local accept=chat.children.llmdip_diplomacy_accept
 local close=chat.children.llmdip_diplomacy_close
 assert(chat.parent==root and history.parent==root and shell.parent==root)
 local function right(button) return chat.width+button.x end
 local function left(button) return right(button)-button.width end
 assert(chat.width==552 and right(close)==636 and right(send)==594,'no proposal '..chat.width..' '..send.x..' '..close.x)
 assert(left(send)>chat.width and left(close)>right(send),'buttons overlap the box or each other')
 -- A proposal puts Accept/Reject on its card; the row keeps send and close.
 state.proposal='military_access,mutual'; refresh_owned_ui()
 assert(state.card_buttons_ok and chat.width==552 and not accept.visible and right(send)==594)
 -- If the card buttons could not be built, the row accept button returns.
 state.card_buttons_ok=false; refresh_owned_ui()
 assert(chat.width==510 and accept.visible and right(accept)==552 and right(send)==594 and right(close)==636)
 assert(left(accept)>chat.width and left(send)>right(accept) and left(close)>right(send))
 state.proposal=nil; refresh_owned_ui()
 assert(chat.width==552 and not accept.visible and right(send)==594)
`));
test('pending proposal has a read-only card and a shorter but fully scrollable history',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 llmdip_set_language('es')
 state.target='ai'; state.visible=true
 state.inbox.ai={history={'Player2: '..string.rep('Hablaremos de nuestras fronteras. ',30)}}
 local chat,history,shell=ensure_owned_ui()
 local card=shell.children.proposal_card
 refresh_owned_ui()
 assert(history.height==380 and history.children.history_text.height==380 and not card.visible)
 assert(history_capacity()==15)
 assert(string.match(history.children.history_text.text,'%[%[col:yellow%]%]'..llmdip_t('conversation')..'%[%[/col%]%]'))
 state.proposal='military_access,mutual'; refresh_owned_ui()
 assert(history.height==310 and history.children.history_text.height==310 and card.visible)
 assert(history_capacity()==12)
 -- Agreement first, "pending proposal" underneath; Accept/Reject on the card.
 assert(card.children.proposal_title.text=='Acceso militar mutuo')
 assert(card.children.proposal_detail.text==llmdip_t('pending_proposal'))
 assert(state.card_buttons_ok==true)
 assert(card.children.llmdip_proposal_accept.children.button_txt.text==llmdip_t('accept_button'))
 assert(card.children.llmdip_proposal_decline.children.button_txt.text==llmdip_t('decline_button'))
 assert(card.children.proposal_title.width+54<=640-2*124-10,'Card text runs under its buttons')
 local minimum,maximum=history_scroll_bounds('ai')
 local all=history_body_lines('ai')
 local seen={}
 for offset=minimum,maximum do
  state.history_offset=offset
  local shown_page=history_display('ai')
  local rows=0
  for line in string.gmatch(shown_page,'[^\n]+') do
   rows=rows+1; seen[line]=true
  end
  assert(rows<=14)
 end
 for i=1,#all do assert(seen[all[i]],'Pending proposal hides history line '..i) end
 state.history_offset=maximum
 local shown=history_display('ai')
 assert(not string.find(shown,llmdip_t('lines_hint'),1))
 assert(string.find(shown,' / ',1))
 state.proposal=nil; refresh_owned_ui()
 assert(history.height==380 and history.children.history_text.height==380 and not card.visible)
`));
test('experimental bubbles reuse owned components and never replace the editable input',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 state.visible=true; state.target='ai'
 state.header_portrait='ui/portraits/katarin.png'; state.header_player_flag='ui/flags/vmp/mon_64.png'
 local you=llmdip_t('you')
 state.inbox.ai={history={you..': Buenas tardes.','Player2: La Madre Patria escucha.',llmdip_t('speaker_system')..': Acuerdo ejecutado.'}}
 local chat,history=ensure_owned_ui(); refresh_owned_ui(); local input=chat.children.entry_box
 state.history_offset=history_scroll_bounds('ai')
 render_history_bubbles('ai')
 assert(history.children.history_text.text:match(llmdip_t('conversation')),'Missing caption: '..tostring(history.children.history_text.text))
 assert(not history.children.history_text.text:match('Madre Patria'),'Fallback: '..tostring(history.children.history_text.text))
 local first=root.children.llmdip_diplomacy_bubble_1
 local second=root.children.llmdip_diplomacy_bubble_2
 local third=root.children.llmdip_diplomacy_bubble_3
 assert(first and second and third,'Expected 3 bubbles; got '..tostring(first)..' '..tostring(second)..' '..tostring(third)..' field='..tostring(history.children.history_text.text))
 assert(first.parent==root and first.template=='llmdip_ui/llmdip_bubble','Wrong ownership')
 -- Player cards end at the right edge, rival cards start at the left, system
 -- cards are centred; none reaches the arrow gutter (x >= 598).
 assert(first.x+first.width==538 and second.x==60,'Unexpected bubble positions '..tostring(first.x)..'+'..tostring(first.width)..','..tostring(second.x))
 -- No icon may be created at the UI root: that crashed the game twice (24-09).
 assert(root.children.llmdip_diplomacy_icon_1==nil and root.children.msg_icon_1==nil,'Icons must not be created at root')
 assert(math.abs((third.x+third.width/2)-299)<=1,'System card not centred '..tostring(third.x)..'+'..tostring(third.width))
 for _,card in ipairs({first,second,third}) do assert(card.x>=8 and card.x+card.width<=590,'Card enters the arrow gutter') end
 assert(first.priority==250,'Card below the history')
 assert(first.children.bubble_text.text:match('Buenas tardes'),'First bubble: '..tostring(first.children.bubble_text.text))
 assert(second.children.bubble_text.text:match('Madre Patria'),'Second bubble: '..tostring(second.children.bubble_text.text))
 assert(third.children.bubble_text.text:match('Acuerdo ejecutado'),'Third bubble: '..tostring(third.children.bubble_text.text))
 assert(input==chat.children.entry_box and input.interactive,'Input changed')
 render_history_bubbles('ai')
 assert(first==root.children.llmdip_diplomacy_bubble_1,'Bubble recreated')
 state.inbox.ai.history={you..': Otra carta.'}
 render_history_bubbles('ai')
 assert(first.visible and not second.visible and not third.visible,'Unused bubbles visible')
 assert(first.children.bubble_text.text:match('Otra carta'),'Replacement text missing')
`));
test('bubble pagination reaches the last line in normal and proposal heights without fallback',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 state.visible=true; state.target='ai'
 state.inbox.ai={history={'Player2: '..string.rep('Proteged Kislev de los enemigos del norte. ',40)..' FIN_DEL_MENSAJE'}}
 local _,history=ensure_owned_ui()
 for mode=1,2 do
  state.proposal=mode==2 and 'military_access,mutual' or nil
  local minimum,maximum=history_scroll_bounds('ai')
  for offset=minimum,maximum do
   state.history_offset=offset; render_history_bubbles('ai')
   assert(not history.children.history_text.text:match('Proteged'), 'Fallback at '..offset)
   local seen=false
   for i=1,BUBBLE_LIMIT do
    local bubble=root.children[BUBBLE_ID_PREFIX..i]
    if bubble and bubble.visible and bubble.children.bubble_text.text:match('FIN_DEL_MENSAJE') then seen=true end
   end
   if offset==maximum then assert(seen,'Final message not visible in bubble') end
  end
 end
`));
test('chat pagination reaches every line, including final deal text, without exceeding display budget',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 state.target='ai'
 local long='Player2: '..string.rep('Exijo una alianza y respeto. ',100)..' ÚLTIMA_FRASE'
 state.inbox.ai={attitude_label='Muy hostil',history={'Tú: hola',long,'Propuesta: entregar 100 de oro. FINAL_PROPUESTA'}}
 local all=history_body_lines('ai')
 local minimum,maximum,base=history_scroll_bounds('ai')
 state.history_offset=minimum
 local seen={}
 for offset=minimum,maximum do
  local shown=history_display('ai'); local rows={}
  for line in string.gmatch(shown,'[^\n]+') do rows[#rows+1]=line end
  assert(#rows<=HISTORY_TOTAL_LINES)
  for i=1,#rows do seen[rows[i]]=true end
  fire('llmdip_contextual_clicks','llmdip_diplomacy_history_next')
  assert(state.history_offset==math.min(maximum,offset+1))
 end
 for i=1,#all do assert(seen[all[i]],'Unreachable line '..i) end
 assert(string.match(history_display('ai'),'FINAL_PROPUESTA'))
 for i=1,maximum-minimum+5 do fire('llmdip_contextual_clicks','llmdip_diplomacy_history_prev') end
 assert(state.history_offset==minimum)
 assert(widgets.llmdip_diplomacy_history.children.history_text.width==640)
 assert(widgets.llmdip_diplomacy_history.children.history_text.height==380)
`));

test('chat display styles speakers without contaminating saved conversation text',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 state.target='ai'
 local you=llmdip_t('you'); local system=llmdip_t('speaker_system')
 state.inbox.ai={
  header_ai_speaker='Zarina Katarin',header_player_speaker='Vlad von Carstein',
  history={you..': hola','Player2: La Madre Patria escucha.',system..': Acuerdo ejecutado.'}
 }
 local original=table.concat(state.inbox.ai.history,'|')
 local lines,latest=history_body_lines('ai')
 local shown=table.concat(lines,'\n')
 local player_margin=string.rep(' ',PLAYER_INDENT)
 assert(string.match(shown,player_margin..'%[%[col:green%]%]'..you..' · Vlad von Carstein:%[%[/col%]%]\n'..player_margin..'%[%[col:green%]%]  hola%[%[/col%]%]'),shown)
 assert(string.match(shown,'%[%[col:yellow%]%]Zarina Katarin:%[%[/col%]%]\n  La Madre Patria escucha%.'))
 assert(string.match(shown,'%[%[col:grey%]%]'..system..':%[%[/col%]%]\n%[%[col:grey%]%]  Acuerdo ejecutado%.'))
 assert(lines[latest]=='[[col:grey]]'..system..':[[/col]]')
 assert(lines[latest-1]==' ')
 assert(table.concat(state.inbox.ai.history,'|')==original)
`));
test('outgoing inset remains within the history width even for long UTF-8 text',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 state.inbox.ai={history={llmdip_t('you')..': '..string.rep('La Madre Patria y Sylvania conversarán. ',18)}}
 local lines=history_body_lines('ai')
 local body_count=0
 for i=1,#lines do
  local plain=string.gsub(lines[i],'%[%[.-%]%]','')
  if string.match(plain,'^'..string.rep(' ',PLAYER_INDENT+2)) then
   body_count=body_count+1
   local width=0
   for char in string.gmatch(plain,'[%z\1-\127\194-\244][\128-\191]*') do width=width+history_char_width(char) end
   assert(width<=HISTORY_TEXT_WIDTH,'Outgoing line exceeds viewport: '..width)
  end
 end
 assert(body_count>3)
`));

test('proposal history uses a readable agreement name without changing stored action keys',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 llmdip_set_language('es')
 state.target='ai'
 local raw=llmdip_t('speaker_proposal')..': military_access,mutual. Reacción al aceptar: mejora leve.'
 state.inbox.ai={attitude_label='Neutral',history={raw}}
 local shown=history_display('ai')
 assert(string.match(shown,'Acceso militar mutuo'))
 assert(not string.match(shown,'military_access,mutual'))
 assert(not string.match(shown,'Relación:'))
 assert(state.inbox.ai.history[1]==raw)
 assert(llmdip_action_label('offer_gold,100')=='Regalo de oro (100)')
 assert(llmdip_action_label('military_access,interlocutor_to_player')=='Ellos te conceden acceso militar')
 assert(llmdip_action_label('military_access,player_to_interlocutor')=='Tú les concedes acceso militar')
 local actions={'declare_war','make_peace','alliance,defensive','alliance,military',
  'trade_agreement','military_access,mutual','military_access,interlocutor_to_player',
  'military_access,player_to_interlocutor','transfer_region,wh3_main_example,player',
  'vassalize,player','vassalize,interlocutor','offer_gold,100','request_gold,100',
  'favor,defend,100,none','non_aggression_pact','betray_war'}
 for _,code in ipairs({'en','es','fr','de','it','ru','pl','cs','tr','ko','pt','zh','tw'}) do
  llmdip_set_language(code)
  for _,action in ipairs(actions) do
   local label=llmdip_action_label(action)
   assert(label~='' and label~=action,code..': '..action)
  end
 end
`));

test('the header separates attitude from traits and restores the right faction on switching',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 common={get_context_value=function() return 'La Corte de Hielo' end}
 cm.get_faction=function() return {is_null_interface=function() return false end} end
 cm.get_local_faction=function() return {is_null_interface=function() return false end} end
 set_up(capture_header,'leader_name_for_faction',function() return 'Zarina Katarin' end)
 state.attitude_value=-14; state.attitude_label='Neutral'
 state.personality_attributes='Leal a la Madre Patria:Purgador'
 capture_header('kislev')
 assert(state.header_title=='Zarina Katarin — La Corte de Hielo')
 assert(state.header_meta=='Leal a la Madre Patria · Purgador')
 assert(state.header_attitude=='Neutral · -14')
 select_target('otro'); assert(state.header_attitude=='')
 select_target('kislev'); assert(state.header_attitude=='Neutral · -14')
`));

test('chat wrapping preserves UTF-8 and splits unusually long words without losing text',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 local original=string.rep('á',75)..' '..string.rep('W',75)..' ¿Alianza? Sí.'
 local lines=wrap_history_text(original)
 for i=1,#lines do
  local width=0; for char in string.gmatch(lines[i],'[%z\1-\127\194-\244][\128-\191]*') do width=width+history_char_width(char) end
  assert(width<=HISTORY_TEXT_WIDTH)
 end
 assert(string.gsub(table.concat(lines,''),'%s','')==string.gsub(original,'%s',''))
`));

test('chat uses the available width rather than an arbitrary 32-character column',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 local rows=wrap_history_text(string.rep('amistad y respeto ',12))
 assert(#rows[1]>50)
 local width=0; for char in string.gmatch(rows[1],'[%z\1-\127\194-\244][\128-\191]*') do width=width+history_char_width(char) end
 assert(width>HISTORY_TEXT_WIDTH*0.85 and width<=HISTORY_TEXT_WIDTH)
 assert(HISTORY_TOTAL_LINES==17)
`));

test('chat wrapping keeps ordinary words together instead of orphaning a final word',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 local rows=wrap_history_text('pero cualquier intrusión contra Reikland recibirá una respuesta digna del Emperador.')
 for i=1,#rows do assert(rows[i]~='respuesta','Una palabra normal no debe quedar aislada') end
 assert(string.match(table.concat(rows,' '),'respuesta digna del Emperador%.'))
`));

test('changing factions or losing target clears previous reply, deal and identity state',()=>run(read('llm_diplomacy_ui.lua'),`
 state.inbox.a={response='SECRET_A',request='ra',proposal='offer_gold,100',attitude_value=50}
 select_target('a'); assert(state.response=='SECRET_A' and state.request_id=='ra')
 select_target('b'); assert(state.response=='' and state.request_id==nil and state.proposal==nil and state.attitude_value==nil)
 llmdip_ui_on_proposal('rb','reject',0,'neutral','b',false)
 assert(not string.match(state.inbox.b.response,'SECRET_A'))
 state.history_offset=3
 llmdip_ui_on_response('ra2','SECOND_SECRET_A','a')
 assert(state.target=='b' and state.history_offset==3 and not string.match(state.response,'SECOND_SECRET_A'))
 local before=#state.inbox.b.history
 llmdip_ui_on_proposal('unknown','reject',0,'neutral',nil,false)
 assert(#state.inbox.b.history==before)
 assert(capture_target()==nil and state.target==nil and state.request_id==nil and state.proposal==nil)
`));

test('a single entry button: the old floating faction button is gone',()=>{
 assert.doesNotMatch(bridge,/llmdip_menu_button|create_menu_button|llmdip_ui_clicks/);
 assert.match(mailbox,/b:SetDockingPoint\(1\); b:SetDockOffset\(20, 123\)/);
 // The window registers its controls on events only, like the chat; the
 // one-second tick just updates the button's counter.
 const tick = mailbox.slice(mailbox.indexOf('function llmdip_mail_tick'), mailbox.indexOf('local function toggle_contacts'));
 assert.match(tick, /b:SetVisible\(true\); refresh_button\(\)/);
 assert.doesNotMatch(tick, /[^_]refresh\(\)/);
});

test('bridge defers responses outside player phase and rejects stale load responses',()=>run(bridge,`
 set_up(llmdip_player_phase,'player_phase',false)
 assert(not llmdip_publish_response('r1','hola','reject',0,'neutral'))
 set_up(llmdip_player_phase,'player_phase',true)
 assert(not llmdip_publish_response('old','hola','reject',0,'neutral'))
`));

test('contact lookup works with WH3 native string.find arity, including an empty list',()=>run(bridge,`
 cm.get_local_faction=function() return {name=function() return 'player' end,is_null_interface=function() return false end} end
 assert(not llmdip_is_contact_enabled('ai'))
 saved.llmdip_contacts_player=',ai_long,ai,another,'
 assert(llmdip_is_contact_enabled('ai'))
 assert(llmdip_is_contact_enabled('ai_long'))
 assert(not llmdip_is_contact_enabled('a'))
 assert(not llmdip_is_contact_enabled('long'))
`));

test('contact toggle preserves exact keys without fourth-argument string.find',()=>run(bridge,`
 local toggle
 for i=1,100 do
  local name,value=debug.getupvalue(listeners.llmdip_mp_events.callback,i)
  if name=='set_contact' then toggle=value; break end
 end
 assert(toggle)
 saved.llmdip_contacts_player=',ai_long,'
 toggle('player','ai'); assert(saved.llmdip_contacts_player==',ai_long,ai,')
 toggle('player','ai'); assert(saved.llmdip_contacts_player==',ai_long,')
`));

test('real proactive selection with no enabled contacts keeps native string calls valid',()=>run(bridge,`
 set_up(llmdip_player_phase,'player_phase',true)
 set_up(llmdip_mail_request,'campaign_id','campaign_test')
 cm.is_multiplayer=function() return false end
 local ai={name=function() return 'ai' end,is_human=function() return false end,is_dead=function() return false end}
 cm.get_local_faction=function() return {
  name=function() return 'player' end,
  factions_met=function() return {num_items=function() return 1 end,item_at=function() return ai end} end
 } end
 local target,exhausted=llmdip_mail_request({})
 assert(target==false and exhausted==true)
 assert(string.sub('UIComponent (test)',1,12)=='UIComponent ')
`));

test('all activated factions can get an opportunity, not only two per turn',()=>run(mailbox,`
 first[1]()
 llmdip_mail_request=function(excluded)
  for i=1,6 do local key='ai'..i; if not excluded[key] then return key end end
  return false,true
 end
 for i=1,20 do llmdip_mail_tick() end
 assert(saved.llmdip39_mailbox.queries==6)
 first[1](); llmdip_mail_tick(); assert(saved.llmdip39_mailbox.queries==6)
 round=2; for i=1,20 do llmdip_mail_tick() end
 assert(saved.llmdip39_mailbox.queries==6)
`));

test('bridge serializes generations and permits the same contact again next turn',()=>run(bridge,`
 set_up(llmdip_player_phase,'player_phase',true)
 set_up(llmdip_mail_request,'campaign_id','campaign_test')
 cm.is_multiplayer=function() return false end
 local ai={name=function() return 'ai' end,is_human=function() return false end,is_dead=function() return false end}
 cm.get_local_faction=function() return {name=function() return 'player' end,
  factions_met=function() return {num_items=function() return 1 end,item_at=function() return ai end} end} end
 saved.llmdip_contacts_player=',ai,'
 local sent=0
 set_up(llmdip_mail_request,'new_request',function() sent=sent+1; return true end)
 set_up(llmdip_mail_request,'pending',{busy={mode='proactive'}})
 local result,exhausted=llmdip_mail_request({}); assert(not result and not exhausted and sent==0)
 set_up(llmdip_mail_request,'pending',{})
 assert(llmdip_mail_request({})=='ai' and sent==1)
 assert(not llmdip_mail_request({}) and sent==1)
 round=2; assert(llmdip_mail_request({})=='ai' and sent==2)
`));

test('delayed letter consumes arrival turn to avoid two letters from one ruler',()=>run(bridge,`
 set_up(llmdip_player_phase,'player_phase',true)
 round=3
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='proactive',turn=2}})
 llmdip_mail_receive=function() end
 assert(llmdip_publish_response('r1','Carta','reject',0,'neutral'))
 assert(saved.llmdip_last_player_ai==3)
`));
test('proactive response cannot change relations; proposal is saved, delivered once',()=>run(bridge,`
 set_up(llmdip_player_phase,'player_phase',true)
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='proactive',turn=1}})
 local received=0; llmdip_mail_receive=function() received=received+1 end
 assert(llmdip_publish_response('r1','Carta','offer_gold,100',1,'respect'))
 assert(saved.llmdip39_pending.r1.relation_delta==0 and received==1)
 assert(not llmdip_publish_response('r1','Carta','offer_gold,100',1,'respect'))
 assert(received==1)
`));
test('NO_CONTACT is consumed without showing a message',()=>run(bridge,`
 set_up(llmdip_player_phase,'player_phase',true)
 set_up(llmdip_no_contact,'pending',{r1={mode='proactive'}})
 llmdip_ui_on_response=function() error('Must not render') end
 assert(llmdip_no_contact('r1')); assert(saved.llmdip39_pending.r1==nil)
`));
test('letter memory does not invent player words; silence keeps the timeline connected',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'llmdip39-test-'));
 try {
  const store=new MemoryStore(dir);
  const r={requestId:'r1',campaignId:'c1',sender:'player',interlocutor:'ai',mode:'proactive',turn:1,memoryParent:'root',message:'INTERNAL SEED'};
  store.append(r,'Carta',{type:'reject'},{delta:0,reason:'neutral'});
  store.append({...r,requestId:'r2',memoryParent:'r1'},'',{type:'reject'},{delta:0,reason:'neutral'});
  const history=store.history({...r,memoryParent:'r2'});
  assert.deepEqual(history.map(x=>[x.role,x.content]),[['assistant','Carta']]);
  assert.deepEqual(store.history({...r,memoryParent:'root'}),[]);
 } finally {fs.rmSync(dir,{recursive:true});}
});

test('card Reject declines the pending offer without executing it, and Accept still accepts',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 llmdip_set_language('es')
 local declined, accepted = {}, {}
 llmdip_decline=function(id) declined[#declined+1]=id; return true end
 llmdip_accept=function(id) accepted[#accepted+1]=id; return true end
 state.target='ai'; state.visible=true
 state.inbox.ai={history={'Player2: Te ofrezco paso libre.'},proposal='military_access,mutual',request='r1'}
 state.request_id='r1'; state.proposal='military_access,mutual'
 local chat,history,shell=ensure_owned_ui(); refresh_owned_ui()
 local card=shell.children.proposal_card
 assert(card.visible)
 fire('llmdip_contextual_clicks','llmdip_proposal_decline')
 assert(#declined==1 and declined[1]=='r1' and #accepted==0,'Reject must decline r1 only')
 assert(state.proposal==nil and state.inbox.ai.proposal==nil and not card.visible)
 local last=state.inbox.ai.history[#state.inbox.ai.history]
 assert(last==llmdip_t('speaker_system')..': '..llmdip_t('proposal_declined'),'Missing note: '..tostring(last))
 state.request_id='r2'; state.proposal='trade_agreement'; refresh_owned_ui()
 fire('llmdip_contextual_clicks','llmdip_proposal_accept')
 assert(#accepted==1 and accepted[1]=='r2' and #declined==1)
`));

test('player lines with an accented label are recognised even with a character-indexed string.sub',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 -- In game "Tú: ..." lines were never recognised as the player's (24-09): the
 -- old byte-length prefix check failed once string.sub counted characters.
 string.sub=function(s,i,j)
  local chars={}
  for c in string.gmatch(s,'[%z\1-\127\194-\244][\128-\191]*') do chars[#chars+1]=c end
  j=j or #chars
  if i<0 then i=#chars+i+1 end
  if j<0 then j=#chars+j+1 end
  if i<1 then i=1 end
  if j>#chars then j=#chars end
  if i>j then return '' end
  return table.concat(chars,'',i,j)
 end
 llmdip_set_language('es')
 state.target='ai'
 state.inbox.ai={history={llmdip_t('you')..': no rompí ninguna alianza','Player2: Lo sé.'}}
 local lines=history_body_lines('ai')
 assert(lines[1]:match('%[%[col:green%]%]'..llmdip_t('you')..':'),'Player header missing: '..tostring(lines[1]))
 assert(lines[2]:match('no rompí ninguna alianza'),'Player body lost its first letters: '..tostring(lines[2]))
 assert(not table.concat(lines,'|'):match(llmdip_t('you')..': no'),'Raw unparsed player line shown')
`));

test('portrait and crest slots come from the shell and sit beside their cards',()=>run(read('llm_diplomacy_ui.lua'),String.raw`
 state.visible=true; state.target='ai'
 state.header_portrait='ui/portraits/katarin.png'; state.header_player_flag='ui/flags/vmp/mon_64.png'; state.header_has_portrait=true
 local you=llmdip_t('you')
 state.inbox.ai={history={you..': Buenas tardes.','Player2: La Madre Patria escucha.',llmdip_t('speaker_system')..': Acuerdo ejecutado.'}}
 local chat,history,shell=ensure_owned_ui()
 for i=1,16 do widget('msg_icon_'..i,shell); widget('msg_portrait_'..i,shell) end
 refresh_owned_ui(); render_history_bubbles('ai')
 local first,second=root.children.llmdip_diplomacy_bubble_1,root.children.llmdip_diplomacy_bubble_2
 local icon1,icon3=shell.children.msg_icon_1,shell.children.msg_icon_3
 local crest2,portrait2=shell.children.msg_icon_2,shell.children.msg_portrait_2
 assert(icon1.visible and icon1.x==546 and icon1.y==first.y,'Player crest '..tostring(icon1.x))
 assert(not shell.children.msg_portrait_1.visible,'Player must not use a portrait slot')
 assert(portrait2.visible and portrait2.x==8 and portrait2.y==second.y and not crest2.visible,'Rival portrait slot '..tostring(portrait2.x))
 assert(not icon3.visible and not shell.children.msg_portrait_3.visible,'System line must have no icon')
 assert(first.height>=44 and second.height>=44,'Card shorter than its icon')
 hide_dialog()
 assert(not icon1.visible and not portrait2.visible,'Icons must hide with the dialog')
`));

const betrayalSetup = String.raw`
 set_up(llmdip_player_phase,'player_phase',true)
 wars={}
 cm.force_declare_war=function(self,a,b) wars[#wars+1]=a..'>'..b end
 local player={name=function() return 'player' end,is_null_interface=function() return false end,is_human=function() return true end}
 ai={name=function() return 'ai' end,is_null_interface=function() return false end,is_human=function() return false end,is_dead=function() return false end,at_war_with=function() return false end}
 cm.get_faction=function(self,key) return key=='player' and player or ai end
 mail_status=nil; llmdip_mail_receive=function(id,p,n,a) mail_status=a end
 proposals={}; llmdip_ui_on_proposal=function(id,c) proposals[#proposals+1]=c end
 betrayed=nil; llmdip_ui_on_betrayal=function(id,t,ok) betrayed=ok end
`;
test('a betrayal letter declares war at once, with no card to accept', () => run(bridge, betrayalSetup + String.raw`
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='proactive',turn=1}})
 assert(llmdip_publish_response('r1','Tu alianza me estorba.','betray_war',0,'neutral'))
 assert(#wars==1 and wars[1]=='ai>player')
 assert(#proposals==0 and betrayed==true and mail_status=='betray_war')
 assert(saved.llmdip39_pending.r1==nil)
`));
test('betray_war outside a background letter is only words', () => run(bridge, betrayalSetup + String.raw`
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='player',turn=1}})
 assert(llmdip_publish_response('r1','Nunca te traicionaria.','betray_war',0,'neutral'))
 assert(#wars==0 and betrayed==nil and proposals[1]=='reject')
`));
test('no betrayal war is declared on someone already at war', () => run(bridge, betrayalSetup + String.raw`
 ai.at_war_with=function() return true end
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='proactive',turn=1}})
 assert(not llmdip_publish_response('r1','Ya estamos en guerra.','betray_war',0,'neutral'))
 assert(#wars==0 and betrayed==false and mail_status=='reject')
`));
test('the inbox and the chat mark a betrayal', () => {
  run(mailbox, String.raw`llmdip_set_language('es'); first[1](); llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Carta','betray_war'); assert(saved.llmdip39_mailbox.rows[1].status==llmdip_t('betrayal_status'))`);
  run(read('llm_diplomacy_ui.lua'), String.raw`llmdip_set_language('es'); state.inbox.ai={history={}}; llmdip_ui_on_betrayal('r1','ai',true); local h=history_for('ai'); assert(string.find(h[#h], 'Traici'))`);
});

const redoUi = String.raw`
 llmdip_set_language('es')
 calls={}
 llmdip_regenerate=function(target,id,text,delta) calls[#calls+1]={target=target,id=id,text=text,delta=delta}; return true end
 state.target='ai'; state.visible=true
 local you=llmdip_t('you')..': '
`;
// Quien se suscribe en el Workshop y no instala el companion se quedaba mirando
// "Pensando..." sin explicacion. Ahora se le avisa, pero el aviso es de la
// interfaz: si entrara en el historial, el modelo lo leeria en el siguiente
// mensaje como si se lo hubiera dicho un lider.
test('el aviso de companion ausente se ve, pero no entra en el historial', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={you..'hola', 'Player2: '..llmdip_t('thinking')}}
 callbacks={}
 watch_for_companion('ai')
 assert(#callbacks==1 and callbacks[1].ms>=5000, 'el vigilante espera, no dispara al momento')
 callbacks[1].fn()

 local historia=state.inbox.ai.history
 assert(#historia==2, 'el historial sigue teniendo dos lineas')
 assert(historia[2]=='Player2: '..llmdip_t('thinking'), 'el hueco del lider no se toca')
 for i=1,#historia do
  assert(not string.find(historia[i], 'living%-diplomacy', 1), 'el aviso no puede quedarse en el historial')
 end

 local pintado=table.concat(history_body_lines('ai'), '\n')
 assert(string.find(pintado, 'living%-diplomacy', 1), 'pero el jugador si lo ve')
 assert(string.find(pintado, llmdip_t('speaker_system'), 1), 'y sale como System, no como el lider')

 llmdip_ui_on_response('r1','Katarin responde','ai')
 assert(state.notice==nil, 'una respuesta retira el aviso')
 assert(not string.find(table.concat(history_body_lines('ai'), '\n'), 'living%-diplomacy', 1))
`));

test('cerrar la ventana antes de tiempo no deja el aviso armado', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={you..'hola', 'Player2: '..llmdip_t('thinking')}}
 callbacks={}
 watch_for_companion('ai')
 state.visible=false
 callbacks[1].fn()
 assert(state.notice==nil, 'con la ventana cerrada no se arma nada')
 state.visible=true
 assert(not string.find(table.concat(history_body_lines('ai'), ' '), 'living%-diplomacy', 1), 'ni aparece al reabrir')
`));

// Steam actualiza el mod solo. El companion viejo se niega a arrancar, pero el
// fichero del inbox de la sesion anterior sigue en disco y el juego lo vuelve a
// ejecutar cada segundo. Esas lineas viejas no pueden pasar por un companion vivo.
test('una senal vieja del inbox no tapa el aviso de companion ausente', () => run(bridge, String.raw`
 cm.get_local_faction=function() return {name=function() return 'player' end,is_null_interface=function() return false end} end
 local function upvalue(fn, wanted)
  for i=1,200 do local n,v=debug.getupvalue(fn,i); if not n then return nil end; if n==wanted then return v end end
 end
 local watch=upvalue(upvalue(llmdip_send_request,'new_request'),'watch_companion')
 assert(watch, 'new_request vigila cada peticion')
 saved.llmdip_last_player_request_player_ai='r5_1_200_7_1'
 callbacks={}
 watch('r5_1_200_7_1')
 llmdip_companion_alive('r4_1_100_3_9')
 llmdip_companion_alive()
 assert(not llmdip_companion_answered_target('ai'), 'una linea de otra sesion no es una respuesta')
 callbacks[1].fn()
 assert(llmdip_companion_silent(), 'nadie la recogio: la ventana de cartas lo dira')
 llmdip_companion_alive('r4_1_100_3_9')
 assert(llmdip_companion_silent(), 'la linea vieja, repetida cada segundo, no borra el aviso')
 llmdip_companion_alive('r5_1_200_7_1')
 assert(llmdip_companion_answered_target('ai') and not llmdip_companion_silent(), 'el companion nuevo responde')
`));

test('si el companion no responde, la ventana de cartas lo dice primero y las cartas bajan un puesto', () => run(mailbox, String.raw`
 local silent=true
 llmdip_companion_silent=function() return silent end
 first[1](); llmdip_mail_tick()
 for i=1,3 do llmdip_mail_receive('r'..i,{interlocutor='ai'..i,faction_name='F'..i,leader='L'..i,turn=i},'Carta '..i,'reject') end
 fire('llmdip39_mail_click','llmdip39_mail_button')
 local first_card=widgets.llmdip_hub_card_1.children.bubble_text.text
 assert(string.find(first_card,'github.com/ashleyia2c',1), first_card)
 assert(not widgets.llmdip39_mail_reply_1.visible, 'el aviso no tiene boton de responder')
 assert(string.find(widgets.llmdip_hub_card_2.children.bubble_text.text,'L3',1), 'la carta mas nueva baja al segundo puesto')
 assert(widgets.llmdip39_mail_next.visible, 'con el aviso caben dos cartas por pagina')
 fire('llmdip39_mail_click','llmdip39_mail_reply_2')
 assert(opens==1, 'responder abre la carta que se ve en ese puesto')
 silent=false
 fire('llmdip39_mail_click','llmdip39_mail_button')
 assert(string.find(widgets.llmdip_hub_card_1.children.bubble_text.text,'L3',1), 'sin aviso, todo vuelve a su sitio')
`));

test('un companion viejo que responde se marca como desactualizado; uno al dia no', () => run(bridge, String.raw`
 local function upvalue(fn, wanted)
  for i=1,200 do local n,v=debug.getupvalue(fn,i); if not n then return nil end; if n==wanted then return v end end
 end
 local watch=upvalue(upvalue(llmdip_send_request,'new_request'),'watch_companion')
 watch('r1_1_100_1_1'); watch('r2_1_100_1_2')
 llmdip_companion_alive('r1_1_100_1_1', 1)
 assert(llmdip_companion_outdated(), 'protocol 1 (before 0.45) is older than this pack accepts')
 llmdip_companion_alive('r2_1_100_1_2', 2)
 assert(not llmdip_companion_outdated(), 'a current companion clears it')
 llmdip_companion_alive('r9_old_session', 0)
 assert(not llmdip_companion_outdated(), 'a stale line never marks anything')
`));

test('si el companion esta desactualizado, el chat lo dice aunque ya haya respondido', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={you..'hola', 'Player2: Katarin responde'}}
 callbacks={}
 llmdip_companion_answered_target=function() return true end
 llmdip_companion_outdated=function() return true end
 watch_for_companion('ai')
 callbacks[1].fn()
 assert(state.notice and state.notice.text==llmdip_t('companion_outdated'))
 assert(#state.inbox.ai.history==2, 'the history is untouched')
`));

test('la ventana de cartas avisa de un companion desactualizado', () => run(mailbox, String.raw`
 llmdip_companion_silent=function() return false end
 llmdip_companion_outdated=function() return true end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 local text=widgets.llmdip_hub_card_1.children.bubble_text.text
 assert(string.find(text,'github.com/ashleyia2c',1), text)
`));

test('el companion vivo impide el aviso aunque el modelo tarde', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={you..'hola', 'Player2: '..llmdip_t('thinking')}}
 callbacks={}
 llmdip_companion_answered_target=function() return true end
 watch_for_companion('ai')
 callbacks[1].fn()
 assert(state.notice==nil, 'si el companion contesta, no se acusa a nadie')
`));

test('redo resends the player words and replaces the bad reply', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={you..'hola', 'Player2: Zarina Katarin responde con amabilidad seca...', llmdip_t('speaker_result')..': nada'}, request='r9', applied_delta=1, attitude_value=50, proposal='trade_agreement'}
 regenerate_last()
 assert(#calls==1 and calls[1].id=='r9' and calls[1].text=='hola' and calls[1].delta==1)
 local h=state.inbox.ai.history
 assert(#h==2 and h[1]==you..'hola' and h[2]=='Player2: '..llmdip_t('thinking'))
 assert(state.inbox.ai.request==nil and state.inbox.ai.proposal==nil and state.proposal==nil)
 assert(state.inbox.ai.attitude_value==49)
`));
test('redo refuses an executed deal, a pending reply and an empty chat', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 -- 26-09: refusals only reached the input's tooltip and the button looked dead; they
 -- are now visible lines in the chat.
 local system=llmdip_t('speaker_system')..': '
 state.inbox.ai={history={you..'hola','Player2: vale'}, request='r9', executed_request='r9'}
 regenerate_last(); local h=state.inbox.ai.history
 assert(#calls==0 and h[#h]==system..llmdip_t('redo_blocked_deal'))
 state.inbox.ai={history={you..'hola','Player2: '..llmdip_t('thinking')}, request='r9'}
 regenerate_last(); h=state.inbox.ai.history
 assert(#calls==0 and #h==2, 'a click while waiting adds nothing, so the reply can still replace the thinking line')
 state.inbox.ai={history={'Player2: una carta'}, request='r9'}
 regenerate_last(); h=state.inbox.ai.history
 assert(#calls==0 and h[#h]==system..llmdip_t('redo_nothing'))
`));
test('a reply saved before redo existed can still be redone', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={you..'hola','Player2: Zarina Katarin responde con amabilidad seca...'}}
 regenerate_last()
 assert(#calls==1 and calls[1].id==nil and calls[1].text=='hola')
 local h=state.inbox.ai.history
 assert(#h==2 and h[2]=='Player2: '..llmdip_t('thinking'))
`));
test('the bridge redoes only the latest reply and takes back its relation change', () => run(bridge, String.raw`
 set_up(llmdip_player_phase,'player_phase',true)
 local player={name=function() return 'player' end,is_null_interface=function() return false end}
 local ai={name=function() return 'ai' end,is_null_interface=function() return false end,is_human=function() return false end,is_dead=function() return false end}
 cm.get_faction=function(self,key) return ai end
 cm.get_local_faction=function() return player end
 local bonus={}; cm.apply_dilemma_diplomatic_bonus=function(self,a,b,v) bonus[#bonus+1]=v end
 local sent; set_up(llmdip_regenerate,'new_request',function(p,i,mode,text,att,pers,of) sent={mode=mode,text=text,of=of}; return true end)
 set_up(llmdip_regenerate,'pending',{r9={player='player',interlocutor='ai',mode='player',action={'trade_agreement'}}})
 saved.llmdip_last_player_request_player_ai='r9'
 saved.llmdip_relation_player_ai='1,1'
 assert(llmdip_regenerate('ai','r9','hola',1))
 assert(sent.mode=='player' and sent.text=='hola' and sent.of=='r9')
 assert(bonus[1]==-1 and saved.llmdip_relation_player_ai=='1,0')
 assert(saved.llmdip39_pending.r9==nil)
 saved.llmdip_last_player_request_player_ai='r10'
 assert(not llmdip_regenerate('ai','r9','hola',0), 'an older reply cannot be redone')
 sent=nil
 assert(llmdip_regenerate('ai',nil,'hola',0), 'a reply saved before redo existed has no id')
 assert(sent.text=='hola' and sent.of==nil)
`));
test('redo finds the player line in Spanish even with WH3 character-indexed string.sub', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 -- 26-09: WH3's string.sub counts characters while # counts bytes, so "Tú: " never matched.
 string.sub=function(s,i,j)
  local chars={} for c in string.gmatch(s,"[\0-\127\194-\244][\128-\191]*") do chars[#chars+1]=c end
  j=j or #chars; if j<0 then j=#chars+j+1 end; if i<0 then i=#chars+i+1 end
  return table.concat(chars,"",math.max(i,1),math.min(j,#chars))
 end
 assert(llmdip_t('you')=='Tú')
 state.inbox.ai={history={you..'katarin','Player2: Vlad. Tus mensajes suelen ser breves...',llmdip_t('speaker_result')..': nada'}, request='r69'}
 regenerate_last()
 assert(#calls==1 and calls[1].text=='katarin' and calls[1].id=='r69')
`));

test('the World tab draws chronicle and gossip cards inside the frame, with nothing to answer',()=>run(mailbox,`
 llmdip_world_entries=function() return {
  {turn=4,kind='news',text='The Empire and Kislev have sealed a military alliance.',new=true},
  {turn=3,kind='gossip',text='Too many letters pass between them for this to be mere politics.',new=false}} end
 local seen=0
 llmdip_world_unseen=function() return seen==0 and 1 or 0 end
 llmdip_world_mark_seen=function() seen=seen+1 end
 first[1](); llmdip_mail_tick()
 llmdip_mail_receive('r1',{interlocutor='ai',turn=1,faction_name='Kislev',leader='Katarin'},'Carta','reject')
 fire('llmdip39_mail_click','llmdip39_mail_button')
 local shell, tab=widgets.llmdip_hub_shell, widgets.llmdip_hub_tab_world
 assert(tab.parent==root and tab.children.button_txt.text==llmdip_t('tab_world')..' (1)')
 for _,id in ipairs({'llmdip_hub_tab_letters','llmdip_hub_tab_contacts','llmdip_hub_tab_world'}) do
  local b=widgets[id]; assert(b.x>=shell.x+20 and b.x+b.width<=shell.x+680-20, id..' leaves the frame')
 end
 assert(widgets.llmdip39_mail_reply_1.visible, 'the letter can be answered')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 assert(seen==1, 'opening the tab marks the news as seen')
 local first_card=widgets.llmdip_hub_card_1.children.bubble_text.text
 assert(string.find(first_card,llmdip_t('world_news'),1) and string.find(first_card,'Kislev',1) and string.find(first_card,'yellow',1))
 assert(string.find(widgets.llmdip_hub_card_2.children.bubble_text.text,llmdip_t('world_gossip'),1))
 assert(not widgets.llmdip_hub_card_3.visible)
 assert(not widgets.llmdip39_mail_reply_1.visible, 'news cannot be answered')
 fire('llmdip39_mail_click','llmdip39_mail_reply_1'); assert(opens==0)
 fire('llmdip39_mail_click','llmdip_hub_tab_letters'); assert(widgets.llmdip39_mail_reply_1.visible)
`));

test('the World tab explains itself when empty and survives a broken world module',()=>run(mailbox,`
 llmdip_world_entries=function() error('broken') end
 llmdip_world_unseen=function() error('broken') end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 assert(widgets.llmdip_hub_shell.visible, 'the window stays open')
 assert(widgets.llmdip_hub_tab_world.children.button_txt.text==llmdip_t('tab_world'))
 assert(string.find(widgets.llmdip_hub_card_1.children.bubble_text.text,string.sub(llmdip_t('world_empty'),1,12),1), 'the empty hint')
`));

test('the court report card grows to show every line, and the chronicle fits under it',()=>run(mailbox,`
 local topics={}
 for i=1,4 do topics[i]='Topic '..i..': '..string.rep('Kislev ',9)..'END'..i end
 llmdip_world_report=function() return {turn=84,lines=topics,text=table.concat(topics,' ')} end
 local list={}
 for i=1,6 do list[i]={turn=84,kind='news',text='Entry '..i,new=true} end
 llmdip_world_entries=function() return list end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 local shell, report=widgets.llmdip_hub_shell, widgets.llmdip_hub_card_1
 local text=report.children.bubble_text.text
 for i=1,4 do assert(string.find(text,'END'..i,1), 'topic '..i..' was cut') end
 assert(report.height>96, 'the report needs more room than a normal card')
 local last=report
 for i=2,3 do
  local card=widgets['llmdip_hub_card_'..i]
  if card.visible then
   assert(card.y>=last.y+last.height, 'cards overlap')
   assert(card.y+card.height<=shell.y+500-48, 'card '..i..' runs under the page arrows')
   last=card
  end
 end
 local first_page=0
 for i=2,3 do if widgets['llmdip_hub_card_'..i].visible then first_page=first_page+1 end end
 assert(string.find(widgets.llmdip_hub_card_2.children.bubble_text.text,'Entry 1',1), 'the newest entry follows the report')
 assert(widgets.llmdip39_mail_next.visible)
 fire('llmdip39_mail_click','llmdip39_mail_next')
 assert(not string.find(widgets.llmdip_hub_card_1.children.bubble_text.text,'END1',1), 'the report is only on the first page')
 assert(string.find(widgets.llmdip_hub_card_1.children.bubble_text.text,'Entry '..(first_page+1),1), 'page two continues where page one stopped')
`));

test('the World tab shows both switches with their state in words, and they switch at once',()=>run(mailbox,`
 local opts={treaties=true, romance=true}
 llmdip_world_options=function() return {treaties=opts.treaties, romance=opts.romance} end
 llmdip_world_toggle=function(name) opts[name]=not opts[name]; return opts[name] end
 llmdip_world_entries=function() return {} end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 assert(widgets.llmdip_hub_opt_treaties==nil or not widgets.llmdip_hub_opt_treaties.visible, 'not on the letters tab')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 local shell, treaties, romance=widgets.llmdip_hub_shell, widgets.llmdip_hub_opt_treaties, widgets.llmdip_hub_opt_romance
 assert(treaties.visible and romance.visible and treaties.parent==root)
 assert(treaties.children.button_txt.text==llmdip_t('opt_treaties')..': '..llmdip_t('opt_on'))
 assert(romance.x>=treaties.x+treaties.width and romance.x+romance.width<=shell.x+680-100, 'clear of the page arrows')
 assert(treaties.y+treaties.height<=shell.y+500)
 fire('llmdip39_mail_click','llmdip_hub_opt_treaties')
 assert(opts.treaties==false and treaties.children.button_txt.text==llmdip_t('opt_treaties')..': '..llmdip_t('opt_off'))
 fire('llmdip39_mail_click','llmdip_hub_tab_contacts')
 assert(not treaties.visible and not romance.visible, 'switches belong to the World tab')
`));

test('each faction in the list shows the game\'s own attitude next to its switch',()=>run(mailbox,`
 llmdip_toggle_contact=function() return true end
 llmdip_contact_groups=function() return {{key='ksl',name='Kislev',count=1,enabled=1,
  factions={{key='ai',name='Katarin',enabled=true,attitude='Amigos de confianza'}}}} end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_contacts')
 fire('llmdip39_mail_click','llmdip_hub_row_1')
 assert(widgets.llmdip_hub_row_1.children.button_txt.text=='Katarin  ['..llmdip_t('contact_on')..']  Amigos de confianza')
`));

test('the court view: open it from the World tab, write, send, and the input leaves with it',()=>run(mailbox,`
 local sent, history={}, {}
 llmdip_world_entries=function() return {} end
 llmdip_council_history=function() return history end
 llmdip_council_waiting=function() return #sent>#history/2 and #sent>0 and history[#history].who=='you' end
 llmdip_council_send=function(text) sent[#sent+1]=text; history[#history+1]={who='you',text=text}; return true end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 local open=widgets.llmdip_hub_council_open
 assert(open and open.visible and open.parent==root, 'the court icon sits beside the first card')
 fire('llmdip39_mail_click','llmdip_hub_council_open')
 local shell, input=widgets.llmdip_hub_shell, widgets.llmdip_hub_council_input
 assert(input and input.visible and input.parent==root and input.template=='llmdip_ui/llmdip_chat')
 assert(input.y+input.height<=shell.y+500 and input.x>=shell.x+20)
 assert(string.find(widgets.llmdip_hub_card_1.children.bubble_text.text,string.sub(llmdip_t('council_hint'),1,12),1), 'an empty court explains itself')
 assert(shell.children.header_title.text==llmdip_t('hub_title') and shell.children.header_meta.text==llmdip_t('council_title'))
 input.GetStateText=function() return 'Should I help Kislev?' end
 fire('llmdip39_mail_click','llmdip_hub_council_send')
 assert(sent[1]=='Should I help Kislev?')
 assert(string.find(widgets.llmdip_hub_card_2.children.bubble_text.text,llmdip_t('council_thinking'),1), 'the court is thinking under your words')
 history[#history+1]={who='court',text='Help them, my lord, but send gold, not armies.'}
 llmdip_mail_redraw()
 local last=widgets.llmdip_hub_card_2.children.bubble_text.text
 assert(string.find(last,'send gold',1) and string.find(last,llmdip_t('council_speaker'),1))
 fire('llmdip39_mail_click','llmdip_hub_tab_letters')
 assert(not input.visible and not widgets.llmdip_hub_council_send.visible, 'the input belongs to the court view')
`));

test('a long court report takes the whole first page and is never cut',()=>run(mailbox,`
 local long=string.rep('Kislev ',95)..'LAST_WORDS'
 llmdip_world_report=function() return {turn=84,lines={long},text=long} end
 llmdip_world_entries=function() return {{turn=84,kind='news',text='Entry 1',new=true}} end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 local card=widgets.llmdip_hub_card_1
 assert(string.find(card.children.bubble_text.text,'LAST_WORDS',1), 'the end of the report is shown')
 assert(card.y+card.height<=widgets.llmdip_hub_shell.y+500-48, 'above the switches')
`));

test('rumours and deeds are shown whole, each card as tall as its text, and pages never overflow',()=>run(mailbox,`
 local rumour=string.rep('Miao Ying ',22)..'RUMOUR_END'
 local deed=string.rep('Katarin ',24)..'DEED_END'
 local list={{turn=85,kind='deed',text=deed,new=true},{turn=85,kind='rumour',text=rumour,new=true}}
 for i=1,6 do list[#list+1]={turn=84,kind='news',text='Entry '..i,new=false} end
 llmdip_world_report=function() return nil end
 llmdip_world_entries=function() return list end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 local one, two=widgets.llmdip_hub_card_1, widgets.llmdip_hub_card_2
 assert(string.find(one.children.bubble_text.text,'DEED_END',1), 'the whole deed')
 assert(string.find(two.children.bubble_text.text,'RUMOUR_END',1), 'the whole rumour')
 assert(one.height>96 and two.height>96, 'long cards grow')
 assert(two.y>=one.y+one.height, 'cards do not overlap')
 local shell=widgets.llmdip_hub_shell
 for i=1,3 do
  local card=widgets['llmdip_hub_card_'..i]
  if card and card.visible then assert(card.y+card.height<=shell.y+500-48, 'card '..i..' above the switches') end
 end
 -- Every entry is on some page.
 local seen={}
 for page=1,6 do
  for i=1,3 do
   local card=widgets['llmdip_hub_card_'..i]
   if card and card.visible then for n in string.gmatch(card.children.bubble_text.text,'Entry (%d)') do seen[n]=true end end
  end
  if widgets.llmdip39_mail_next and widgets.llmdip39_mail_next.visible then fire('llmdip39_mail_click','llmdip39_mail_next') end
 end
 for i=1,6 do assert(seen[tostring(i)], 'entry '..i..' reachable') end
`));

// 0.45: greetings, ending the audience, brokered deals and the Voice switch.
test('0.45: a ruler who ends the audience is not heard again this turn; a redo reopens it', () => run(bridge, betrayalSetup + String.raw`
 local p=cm:get_faction('player')
 cm.get_local_faction=function() return p end
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='player',turn=1}})
 closed=nil; llmdip_ui_on_talk_closed=function(t) closed=t end
 cm.apply_dilemma_diplomatic_bonus=function() end
 assert(llmdip_publish_response('r1','Fuera de mi vista.','reject',-1,'insult',true))
 assert(closed=='ai' and saved.llmdip_talk_closed_player_ai==1)
 assert(llmdip_talk_closed('ai'))
 assert(not llmdip_send_request('ai','perdon',0,'unknown'), 'no words reach a ruler who ended the audience')
 set_up(llmdip_regenerate,'new_request',function() return true end)
 assert(llmdip_regenerate('ai',nil,'hola',0))
 assert(not llmdip_talk_closed('ai'), 'redoing the closing reply reopens the audience')
 saved.llmdip_talk_closed_player_ai=1; round=2
 assert(not llmdip_talk_closed('ai'), 'the next turn the ruler listens again')
`));
test('0.45: only a ruler answering the player can end the audience', () => run(bridge, betrayalSetup + String.raw`
 set_up(llmdip_publish_response,'pending',{r1={player='player',interlocutor='ai',mode='proactive',turn=1}})
 llmdip_ui_on_talk_closed=function() error('a letter must not close the audience') end
 assert(llmdip_publish_response('r1','Carta','reject',0,'neutral',true))
 assert(saved.llmdip_talk_closed_player_ai==nil)
`));
test('0.45: the audience opens with one greeting a turn, never after the player wrote or a letter came', () => run(bridge, betrayalSetup + String.raw`
 local p=cm:get_faction('player')
 cm.get_local_faction=function() return p end
 local sent=0
 set_up(llmdip_request_greeting,'new_request',function(s,i,mode) assert(mode=='greeting'); sent=sent+1; return true end)
 assert(llmdip_request_greeting('ai') and sent==1)
 assert(not llmdip_request_greeting('ai'), 'once a turn')
 round=2; saved.llmdip_last_player_ai=2
 assert(not llmdip_request_greeting('ai'), 'a letter this turn already said hello')
 round=3; saved.llmdip_talk_closed_player_ai=3
 assert(not llmdip_request_greeting('ai'), 'not when the audience is closed')
 round=4; set_up(llmdip_send_request,'new_request',function() return true end)
 assert(llmdip_send_request('ai','hola',0,'unknown'))
 assert(not llmdip_request_greeting('ai'), 'not after the player has spoken this turn')
 assert(sent==1)
`));
test('0.45: a greeting is shown as words only, with no proposal and nothing pending', () => run(bridge, betrayalSetup + String.raw`
 set_up(llmdip_publish_response,'pending',{g1={player='player',interlocutor='ai',mode='greeting',turn=1}})
 local shown=nil; llmdip_ui_on_response=function(id,n) shown=n end
 assert(llmdip_publish_response('g1','Bienvenido, Vlad.','reject',0,'neutral'))
 assert(shown=='Bienvenido, Vlad.' and #proposals==0 and saved.llmdip39_pending.g1==nil)
`));
const brokerSetup = betrayalSetup + String.raw`
 peaces={}
 cm.force_make_peace=function(self,a,b) peaces[#peaces+1]=a..'='..b end
 local p=cm:get_faction('player')
 atwar=true; allied=false
 ai.at_war_with=function(self,o) return o:name()=='enemy' and atwar end
 ai.allied_with=function() return false end
 enemy={name=function() return 'enemy' end,is_null_interface=function() return false end,is_human=function() return false end,
  is_dead=function() return false end,allied_with=function(self,o) return allied end}
 cm.get_faction=function(self,key) if key=='player' then return p elseif key=='enemy' then return enemy end return ai end
 function offer(act) set_up(llmdip_accept,'pending',{b1={player='player',interlocutor='ai',mode='player',turn=1,action={'broker',act,'enemy'}}}) end
`;
test('0.45: a brokered peace is made with the third realm', () => run(bridge, brokerSetup + String.raw`
 offer('peace'); assert(llmdip_accept('b1')); assert(peaces[1]=='ai=enemy' and #wars==0)
 atwar=false; offer('peace'); assert(not llmdip_accept('b1'), 'no peace with a realm they are not fighting')
`));
test('0.45: a brokered war is declared, never on the player\'s ally', () => run(bridge, brokerSetup + String.raw`
 atwar=false; offer('war'); assert(llmdip_accept('b1')); assert(wars[1]=='ai>enemy')
 allied=true; offer('war'); assert(not llmdip_accept('b1') and #wars==1, 'the player\'s ally is never the target')
`));
test('0.45: the World tab shows three switches, Voice starts off, and all fit before the arrows',()=>run(mailbox,`
 local opts={treaties=true, romance=true, voice=false}
 llmdip_world_options=function() return {treaties=opts.treaties, romance=opts.romance, voice=opts.voice} end
 llmdip_world_toggle=function(name) opts[name]=not opts[name]; return opts[name] end
 llmdip_world_entries=function() return {} end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 local shell, romance, voice=widgets.llmdip_hub_shell, widgets.llmdip_hub_opt_romance, widgets.llmdip_hub_opt_voice
 assert(voice.visible and voice.children.button_txt.text==llmdip_t('opt_voice')..': '..llmdip_t('opt_off'))
 assert(voice.x>=romance.x+romance.width and voice.x+voice.width<=shell.x+680-100, 'clear of the page arrows')
 fire('llmdip39_mail_click','llmdip_hub_opt_voice')
 assert(opts.voice==true and voice.children.button_txt.text==llmdip_t('opt_voice')..': '..llmdip_t('opt_on'))
 fire('llmdip39_mail_click','llmdip_hub_tab_contacts')
 assert(not voice.visible)
`));
test('0.45: closing the audience is said in the chat, and sending then explains why and clears the words', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 state.inbox.ai={history={}}
 llmdip_ui_on_talk_closed('ai')
 local h=history_for('ai'); assert(h[#h]==llmdip_t('speaker_system')..': '..llmdip_t('talk_closed'))
 llmdip_talk_closed=function() return true end
 local sent=false; llmdip_send_request=function() sent=true; return true end
 local cleared=false; clear_input_text=function() cleared=true end
 capture_target=function() return 'ai' end; read_input_text=function() return 'perdon' end
 send_text()
 assert(not sent and state.notice and state.notice.text==llmdip_t('talk_closed_send'))
 assert(cleared, 'the shared input must not carry the words into the next audience')
`));
test('0.45: a lord without a surname is shown by name, never by the raw name key', () => run(read('llm_diplomacy_ui.lua'), redoUi + String.raw`
 common={}; common.get_localised_string=function(key) if key=='names_name_1' then return 'Morathi' end; return '' end
 assert(localised_ui_value('names_name_1')=='Morathi')
 assert(localised_ui_value('names_name_2147360508')=='', 'an empty surname is empty')
 assert(localised_ui_value('some_other_key')=='some_other_key')
`));
test('0.45: the Voice switch is hidden in a game language Player2 cannot speak, and the request says voice=0',()=>run(mailbox,`
 local opts={treaties=true, romance=true, voice=true}
 llmdip_world_options=function() return {treaties=opts.treaties, romance=opts.romance, voice=opts.voice} end
 llmdip_world_toggle=function(name) opts[name]=not opts[name]; return opts[name] end
 llmdip_world_entries=function() return {} end
 local lang='de'; llmdip_language=function() return lang end
 first[1](); llmdip_mail_tick()
 fire('llmdip39_mail_click','llmdip39_mail_button')
 fire('llmdip39_mail_click','llmdip_hub_tab_world')
 assert(not widgets.llmdip_hub_opt_voice.visible and widgets.llmdip_hub_opt_romance.visible)
 for _,code in ipairs({'fr','ru','pl','cs','tr','ko'}) do lang=code; assert(not llmdip_voice_supported(), code) end
 for _,code in ipairs({'en','es','it','pt','zh','tw'}) do lang=code; assert(llmdip_voice_supported(), code) end
`));
