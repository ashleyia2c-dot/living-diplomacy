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
listeners={}; first={}; saved={}; widgets={}; phase=true; battle=false; round=1; requests=0; opens=0
out=function() end
core={get_env=function() return _G end, remove_listener=function() end,
 add_listener=function(self,name,event,condition,callback) listeners[name]={event=event,condition=condition,callback=callback} end}
function fire(name, id) listeners[name].callback({string=id}) end
cm={add_first_tick_callback=function(self,fn) table.insert(first,fn) end,
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
test('all four campaign files parse as Lua 5.1; mailbox has no AI opening/intervention',()=>{
 for(const name of ['llm_diplomacy.lua','llm_diplomacy_i18n.lua','llm_diplomacy_ui.lua','llm_diplomacy_mailbox.lua']) luaparse.parse(read(name),{luaVersion:'5.1'});
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
 ['explicit reply uses shared conversation, closing does not query',`first[1](); llmdip_mail_tick(); llmdip_mail_receive('r1',{interlocutor='ai',turn=1,faction_name='Kislev',leader='Katarin'},'Carta','reject'); fire('llmdip39_mail_click','llmdip39_mail_button'); assert(widgets.llmdip39_mail_panel.visible); fire('llmdip39_mail_click','llmdip39_mail_reply_1'); assert(opens==1 and not widgets.llmdip39_mail_panel.visible)`],
 ['closed mailbox stays closed on arrival',`first[1](); llmdip_mail_tick(); fire('llmdip39_mail_click','llmdip39_mail_button'); fire('llmdip39_mail_click','llmdip39_mail_button'); assert(not widgets.llmdip39_mail_panel.visible); llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Carta','reject'); assert(not widgets.llmdip39_mail_panel.visible and opens==0)`],
 ['blocking panels suspend queries and hide the mailbox',`first[1](); llmdip_mail_tick(); fire('llmdip39_mail_click','llmdip39_mail_button'); fire('llmdip39_mail_panel_open','popup_pre_battle'); llmdip_mail_tick(); assert(requests==1 and not widgets.llmdip39_mail_panel.visible); fire('llmdip39_mail_panel_close','popup_pre_battle'); llmdip_mail_tick(); assert(requests==2)`],
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

test('mail entry has readable child label, explicit top-left docking and priority',()=>run(mailbox,`
 first[1](); llmdip_mail_tick()
 local b=widgets.llmdip39_mail_button
 assert(b.template=='ui/templates/square_medium_text_button')
 assert(b.dock==1 and b.x==190 and b.y==123 and b.priority==200)
 assert(b.width==180 and b.height==36 and b.interactive)
 assert(b.children.button_txt.text==llmdip_t('ai_messages_button')..'0)' and not b.children.button_txt.interactive)
 llmdip_mail_receive('r1',{interlocutor='ai',turn=1},'Carta','reject')
 assert(b.children.button_txt.text==llmdip_t('ai_messages_button')..'1)')
`));

test('faction menu uses text template children and is placed below the map entries',()=>run(bridge,`
 cm.get_local_faction=function() return {name=function() return 'player' end,
  factions_met=function() return {num_items=function() return 1 end,item_at=function() return {
   name=function() return 'ai' end,is_human=function() return false end,is_dead=function() return false end} end} end} end
 fire('llmdip_ui_clicks','llmdip_menu_button')
 assert(widgets.llmdip_close.dock==1 and widgets.llmdip_close.x==270 and widgets.llmdip_close.y==170)
 assert(widgets.llmdip_close.width==325)
 assert(widgets.llmdip_close.children.button_txt.text==llmdip_t('menu_close'))
 fire('llmdip_ui_clicks','llmdip_all_races')
 assert(widgets.llmdip_contact_ai.children.button_txt.text==llmdip_t('contact_off')..'ai')
`));

test('mailbox reuses verified history template, sizes the text child and closes without destruction',()=>run(mailbox,`
 first[1](); llmdip_mail_tick()
 local manual=root:CreateComponent('manual_history','llmdip_ui/llmdip_history')
 manual.children.history_text:SetStateText('Conversación manual intacta')
 fire('llmdip39_mail_click','llmdip39_mail_button')
 local p=widgets.llmdip39_mail_panel
 assert(p.template=='llmdip_ui/llmdip_history' and p.parent==root)
 assert(p.children.history_text.width==540 and p.children.history_text.height==370)
 assert(string.find(p.children.history_text.text,llmdip_t('no_letters'),1))
 fire('llmdip39_mail_click','llmdip39_mail_close'); assert(not p.visible)
 fire('llmdip39_mail_click','llmdip39_mail_button'); assert(p==widgets.llmdip39_mail_panel and p.visible)
 assert(manual.children.history_text.text=='Conversación manual intacta')
`));

test('localized faction labels and alphabetical order retain internal action keys',()=>run(bridge,`
 common={get_localised_string=function(key)
  return ({factions_screen_name_ai_a='Sylvania',factions_screen_name_ai_b='Carcassonne'})[key] or ''
 end}
 cm.get_local_faction=function() return {name=function() return 'player' end,
  factions_met=function() return {num_items=function() return 2 end,item_at=function(self,i) return {
   name=function() return i==0 and 'ai_a' or 'ai_b' end,is_human=function() return false end,is_dead=function() return false end} end} end} end
 saved.llmdip_contacts_player=',ai_b,'
 fire('llmdip_ui_clicks','llmdip_menu_button')
 fire('llmdip_ui_clicks','llmdip_all_races')
 assert(widgets.llmdip_contact_ai_b.children.button_txt.text==llmdip_t('contact_on')..'Carcassonne')
 assert(widgets.llmdip_contact_ai_a.children.button_txt.text==llmdip_t('contact_off')..'Sylvania')
 assert(widgets.llmdip_contact_ai_b.y<widgets.llmdip_contact_ai_a.y)
`));

test('race drilldown excludes dead/human factions and keeps activation and pagination isolated',()=>run(bridge,`
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
 fire('llmdip_ui_clicks','llmdip_menu_button')
 assert(widgets.llmdip_race_wh2_main_sc_def_dark_elves.children.button_txt.text=='Elfos Oscuros (1/11'..llmdip_t('enabled_suffix'))
 assert(not widgets.llmdip_race_wh_main_sc_dwf_dwarfs and not widgets.llmdip_race_wh_main_sc_emp_empire)
 fire('llmdip_ui_clicks','llmdip_race_wh2_main_sc_def_dark_elves')
 assert(widgets.llmdip_contact_dark_1 and not widgets.llmdip_contact_kislev)
 assert(widgets.llmdip_next and not widgets.llmdip_prev)
 fire('llmdip_ui_clicks','llmdip_next')
 assert(widgets.llmdip_prev and not widgets.llmdip_next)
 fire('llmdip_ui_clicks','llmdip_races_back')
 fire('llmdip_ui_clicks','llmdip_race_wh3_main_sc_ksl_kislev')
 assert(widgets.llmdip_contact_kislev and not widgets.llmdip_contact_dark_1 and not widgets.llmdip_next)
 assert(saved.llmdip_contacts_player==',dark_1,')
 local trigger, delayed
 CampaignUI={TriggerCampaignScriptEvent=function(cqi,event) trigger=event end}
 cm.callback=function(self,fn) delayed=fn end
 fire('llmdip_ui_clicks','llmdip_contact_kislev'); assert(trigger=='LLMDIP2|T|kislev')
 fire('llmdip_ui_clicks','llmdip_close'); delayed()
 assert(not widgets.llmdip_close, 'A queued refresh must not reopen a closed menu')
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
 fire('llmdip_ui_clicks','llmdip_menu_button')
 local text=widgets.llmdip_race_wh2_main_sc_def_dark_elves.children.button_txt.text
 assert(string.sub(text,1,11)=='Dunkelelfen', text)
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
  'favor,defend,100,none'}
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

test('faction entry has its own visible label and cannot overlap the mail entry',()=>run(bridge,`
 local create
 for i=1,100 do
  local name,value=debug.getupvalue(first[#first],i)
  if name=='create_menu_button' then create=value; break end
 end
 assert(create); create()
 local b=widgets.llmdip_menu_button
 assert(b.parent==root and b.dock==1 and b.x==20 and b.y==123 and b.priority==200)
 assert(b.children.button_txt.text==llmdip_t('ai_factions_button') and b.visible)
 assert(b.x+b.width<190)
`));

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
