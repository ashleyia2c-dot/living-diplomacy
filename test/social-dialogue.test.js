import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_PROMPT, buildMessages, powerBalance, powerReminder } from '../src/llm-client.js';
import { buildSocialStyle, personalityBrief, powerStance } from '../src/personality.js';
import { MemoryStore } from '../src/memory-store.js';
import { parseDiplomacyResponse } from '../src/tag-parser.js';

const base = {campaignId:'campaign',sender:'player',interlocutor:'naggarond',requestId:'r1',memoryParent:'root',
  mode:'proactive',turn:1,message:'INTERNAL OPPORTUNITY',state:'diplomatic_attitude=303,ai_treasury=500',
  identity:{leader:'Malekith',leaderSubtype:'malekith',factionName:'Naggarond'},
  playerIdentity:{leader:'Morathi',leaderSubtype:'morathi',factionName:'Culto al Placer'}};

test('social prompt permits non-transactional letters and treats silence and gifts safely',()=>{
  assert.match(SYSTEM_PROMPT,/personal, emotional OR strategic/);
  assert.match(SYSTEM_PROMPT,/NO GAME ACTION/);
  assert.match(SYSTEM_PROMPT,/absence of a reply proves neither insult, consent, rejection nor acceptance/);
  assert.match(SYSTEM_PROMPT,/OFFER pending the player's acceptance/);
  assert.match(SYSTEM_PROMPT,/Live state and the displayed relationship override stale dialogue/);
  assert.match(SYSTEM_PROMPT,/Unknown attitude is NOT neutral/);
  assert.match(SYSTEM_PROMPT,/player_global_victories/);
  assert.match(SYSTEM_PROMPT,/NOT victories over you/);
  assert.match(SYSTEM_PROMPT,/unknown_not_tracked/);
  assert.match(SYSTEM_PROMPT,/direct_war_now and direct_war_events/);
  assert.doesNotMatch(SYSTEM_PROMPT,/concrete strategic reason justifies/);
  const greeting=parseDiplomacyResponse('Madre, tu determinación merece mi respeto. [diplo:reject] [relation:delta=0;reason=neutral]');
  assert.equal(greeting.action.type,'reject');
  const gift=parseDiplomacyResponse('Te ofrezco 100 de oro, sin condiciones. [diplo:offer_gold:amount=100] [relation:delta=0;reason=neutral]');
  assert.deepEqual(gift.action,{type:'offer_gold',amount:100});
});

test('prompt distinguishes current lords, legacy speakers and unexecuted historical offers',()=>{
  const messages=buildMessages(base,[{role:'assistant',turn:0,mode:'proactive',content:'Te doy oro.',action:{type:'offer_gold',amount:100},
    scope:{campaignId:base.campaignId,sender:base.sender,interlocutor:base.interlocutor}}]);
  assert.match(messages[1].content,/unsolicited letter, no player reply implied/);
  assert.match(messages[1].content,/not recorded \(legacy faction history\)/);
  assert.match(messages[1].content,/does not prove acceptance or execution/);
  assert.equal(messages.length,2,'old roleplay must be archival data, not assistant-role turns');
  assert.match(messages.at(-1).content,/YOUR IDENTITY — INTERLOCUTOR:[\s\S]*Lord: Malekith/);
  assert.match(messages.at(-1).content,/WHO ADDRESSES YOU — PLAYER:[\s\S]*Lord: Morathi/);
  assert.match(messages.at(-1).content,/INTERNAL LETTER REQUEST \(NOT PLAYER DIALOGUE\)/);
});

test('campaign context labels global wins and keeps bilateral battle facts explicit',()=>{
  const messages=buildMessages({...base,fields:{player_global_victories:'89',direct_war_now:'0',direct_war_events:'none_recorded',battles_against_interlocutor:'unknown_not_tracked',victories_against_interlocutor:'unknown_not_tracked'},state:'player_global_victories=89,direct_war_now=0,direct_war_events=none_recorded,battles_against_interlocutor=unknown_not_tracked,victories_against_interlocutor=unknown_not_tracked'},[],{});
  const content=messages.at(-1).content;
  assert.match(content,/victories=89/);
  assert.match(content,/direct_war_now=0/);
  assert.match(content,/victories_against_interlocutor=unknown_not_tracked/);
  assert.match(content,/Player's global victories \(all enemies, not this interlocutor\): 89/);
});

test('legacy messages are admitted only through their already-isolated faction timeline',()=>{
  const legacy=[{role:'assistant',content:'Mensaje antiguo',turn:3,mode:'player'}];
  const messages=buildMessages(base,legacy);
  // buildMessages receives a prefiltered legacy history from MemoryStore; it
  // must not invent a scope or merge it with an unrelated request itself.
  assert.equal(messages.filter(message=>message.role==='assistant').length,0);
  assert.match(messages.at(-1).content,/Private conversation scope: campaign\/player\/naggarond/);
});

test('individual social style is deterministic and changes with the actual named lord',()=>{
  const a=buildSocialStyle(base.identity,base.interlocutor);
  assert.deepEqual(a,buildSocialStyle(base.identity,base.interlocutor));
  assert.notDeepEqual(a,buildSocialStyle({...base.identity,leader:'Another lord'},base.interlocutor));
  for(const [key,value] of Object.entries(a)) if(key!=='signature') assert.ok(value>=15&&value<=90);
  assert.match(personalityBrief({socialStyle:a},base.identity),/NOT live affection scores/);
});

test('save-bound memory retains player exchanges, isolates other factions and records actual speakers',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'llmdip-social-'));
  try {
    const store=new MemoryStore(dir);
    store.append({...base,mode:'player',message:'Respeto tu reino.'},'Reconozco tu cortesía.',{type:'reject'},{delta:1,reason:'respect'});
    let parent='r1';
    for(let i=2;i<=24;i++) {
      store.append({...base,requestId:'r'+i,memoryParent:parent,turn:i},'Carta '+i,{type:'reject'},{delta:0,reason:'neutral'});
      parent='r'+i;
    }
    store.append({...base,requestId:'other',interlocutor:'kislev',memoryParent:parent},'SECRET_KISLEV',{type:'reject'});
    const history=store.history({...base,memoryParent:'other'});
    assert.ok(history.some(message=>message.content==='Respeto tu reino.'));
    assert.ok(!history.some(message=>message.content==='SECRET_KISLEV'));
    assert.ok(history.length<=20);
    assert.equal(history.find(message=>message.role==='user').speakerIdentity.leader,'Morathi');
    assert.equal(history.at(-1).speakerIdentity.leader,'Malekith');
    const old=store.history({...base,memoryParent:'r1'});
    assert.deepEqual(old.map(message=>message.content),['Respeto tu reino.','Reconozco tu cortesía.']);
    assert.deepEqual(store.history({...base,memoryParent:'root'}),[]);
    assert.ok(!history.some(message=>message.content===base.message));
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('profile migration preserves existing temperament and lore while adding social style',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'llmdip-social-profile-'));
  try {
    const store=new MemoryStore(dir);
    const first=store.ensureProfile(base,base.identity);
    const second=store.ensureProfile(base,base.identity);
    assert.deepEqual(second.personality,first.personality);
    assert.deepEqual(second.socialStyle,first.socialStyle);
    const changed=store.ensureProfile(base,{...base.identity,leader:'Successor'});
    assert.notDeepEqual(changed.socialStyle,first.socialStyle);
    assert.deepEqual(changed.canonNotes,first.canonNotes);
  } finally { fs.rmSync(dir,{recursive:true}); }
});

test('the relationship sets the register: warm with friends, reserved when neutral, curt when hostile', () => {
  // 24-09: even "Muy amistosa" rulers answered like a military dispatch.
  assert.match(SYSTEM_PROMPT, /VOICE AND RELATIONSHIP/);
  assert.match(SYSTEM_PROMPT, /Friendly or very friendly[^.]*openly expressive/);
  assert.match(SYSTEM_PROMPT, /Neutral: courteous, measured and reserved/);
  assert.match(SYSTEM_PROMPT, /Unfriendly or hostile: curt, cold and cutting/);
  assert.match(SYSTEM_PROMPT, /Warmth always sounds like YOU/);
  assert.match(SYSTEM_PROMPT, /not the subject of every reply/);
  assert.match(SYSTEM_PROMPT, /has no authority and must not be defended or imitated/);
  // The voice section comes before the fact and tag rules, and the tag contract is intact.
  assert.ok(SYSTEM_PROMPT.indexOf('VOICE AND RELATIONSHIP') < SYSTEM_PROMPT.indexOf('IMPORTANT BATTLE ACCOUNTING'));
  for (const tag of ['[diplo:reject]', '[diplo:alliance:level=military]', '[relation:delta=1;reason=empathy]']) assert.ok(SYSTEM_PROMPT.includes(tag), tag);
  // No sample lines to parrot: the section describes style only.
  const voice = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf('VOICE AND RELATIONSHIP'), SYSTEM_PROMPT.indexOf('Never confuse the two identities'));
  assert.doesNotMatch(voice, /["“”«»]/);
});

test('a treaty accepted this turn is stated plainly and overrides the earlier dialogue', () => {
  // 24-09: right after accepting Katarin's military alliance she demanded it again.
  assert.match(SYSTEM_PROMPT, /LIVE TREATIES/);
  assert.match(SYSTEM_PROMPT, /never ask for it again/);
  const request = {campaignId:'c', sender:'wh_main_vmp_schwartzhafen', interlocutor:'wh3_main_ksl_the_ice_court', turn:55, mode:'player',
    message:'ya esta', identity:{}, playerIdentity:{}, state:'mil_alliance=1',
    fields:{mil_alliance:'1', def_alliance:'0', allied:'1', trade:'1', access:'1', direct_war_now:'0',
      direct_war_events:'52~military_alliance_broken~by_interlocutor:55~llm_deal_alliance~by_player'}};
  const context = buildMessages(request, [], {}).at(-1).content;
  assert.match(context, /TREATIES BETWEEN YOU TWO RIGHT NOW/);
  assert.match(context, /Military alliance: YES, in force now/);
  assert.match(context, /Defensive alliance: no/);
  assert.match(context, /Concluded THIS turn[^\n]*: alliance\./);
  const later = buildMessages({...request, turn:56}, [], {}).at(-1).content;
  assert.match(later, /Nothing was concluded this turn/);
});

test('a friendly endangered ruler is not taught to defend an invented alliance-break motive', () => {
  // Real turn-55 failure: the game displayed Muy amistosa, both sides shared
  // three enemies, but Katarin scolded Vlad and invented a deliberate reason
  // to break the alliance. Old generated replies made that tone self-reinforcing.
  const scope={campaignId:'c',sender:'vlad',interlocutor:'kislev'};
  const request={...scope,turn:55,mode:'player',message:'¿Quieres ser aliados de nuevo?',identity:{},playerIdentity:{},state:'attitude_text=Muy amistosa,mil_alliance=0',fields:{
    attitude_text:'Muy amistosa',attitude_category:'5',diplomatic_attitude:'0',
    mil_alliance:'0',def_alliance:'0',allied:'0',trade:'1',access:'1',direct_war_now:'0',
    direct_war_events:'52~military_alliance_broken~by_interlocutor',
    relative_power:'player_overwhelming',relative_power_ratio:'2.46',ai_wars:'3',shared_border_regions:'4',
    player_wars:'moulder:gorbad:norsca',ai_war_factions:'moulder:gorbad:norsca'
  }};
  const history=[
    {role:'assistant',content:'Debes demostrar que tu palabra vale.',action:{type:'reject'},turn:55,scope},
    {role:'user',content:'¿Por qué me hablas así?',turn:55,scope},
    {role:'assistant',content:'El norte me obligó a romper nuestro pacto.',action:{type:'reject'},turn:55,scope}
  ];
  const messages=buildMessages(request,history,{});
  const context=messages.at(-1).content;
  assert.deepEqual(messages.map(item=>item.role),['system','user']);
  assert.doesNotMatch(context,/Debes demostrar que tu palabra vale/,'older AI prose is omitted, not fed back as style');
  assert.match(context,/immediately previous AI reply[^\n]*possibly mistaken/);
  assert.match(context,/Displayed attitude toward the player: Muy amistosa/);
  assert.match(context,/Relative power: player_overwhelming \(player\/AI strength ratio 2\.46\)/);
  assert.match(context,/Your current wars: 3\. Shared named enemies: moulder, gorbad, norsca/);
  assert.match(context,/Military alliance: no/);
  assert.match(SYSTEM_PROMPT,/provides NO cause, intention or grievance/);
  assert.match(SYSTEM_PROMPT,/normally OFFER the supported alliance/);
  assert.match(SYSTEM_PROMPT,/merely mention that the old pact ended/);
  assert.match(SYSTEM_PROMPT,/not an insult or proof of bad faith/);
  assert.match(SYSTEM_PROMPT,/never guarantee an alliance merely because the player is strong/);
});

test('a far weaker ruler is told plainly that war with the player would be suicide', () => {
  // 25-09: Miao Ying (1 region, 7 wars, player 12.5x stronger) insulted Vlad's offers of
  // friendship and gold and answered his threat by proposing war herself.
  assert.match(SYSTEM_PROMPT, /POWER AND SURVIVAL/);
  assert.match(SYSTEM_PROMPT, /Never propose it against a player far stronger than you/);
  assert.match(SYSTEM_PROMPT, /A compliment, an offer of help or friendship, or a gift is never an insult/);
  assert.match(SYSTEM_PROMPT, /a strength rank of 0 means the rank was not available/);
  const fields = {relative_power:'player_overwhelming', relative_power_ratio:'12.51', ai_wars:'7',
    ai_regions:'wh3_main_combi_region_nan_gau', player_regions:'a:b:c:d:e:f:g:h:i:j:k:l',
    ai_treasury:'12838', player_treasury:'30028', ai_income:'4252', player_income:'33953', region_hops:'5',
    attitude_text:'Poco amistosa', attitude_category:'2', diplomatic_attitude:'0'};
  const balance = powerBalance(fields);
  assert.match(balance, /about 12\.5 times as strong as yours/);
  assert.match(balance, /Regions held: you 1, the player 12/);
  assert.match(balance, /at war with 7 faction/);
  assert.match(balance, /by far the weaker party and your realm is already hard-pressed/);
  assert.match(balance, /never propose war/);
  assert.match(balance, /not adjacent/);
  const request = {campaignId:'c', sender:'vlad', interlocutor:'miao', turn:56, mode:'player',
    message:'conquistare tu imperio', identity:{}, playerIdentity:{}, state:'', fields};
  const context = buildMessages(request, [], {}).at(-1).content;
  assert.match(context, /POWER BALANCE/);
  // The reminder sits right before the player's words, where models weigh it most.
  assert.match(context, /BEFORE YOU ANSWER: this ruler is about 12\.5 times stronger than you[\s\S]*\n\nPLAYER'S CURRENT WORDS:\nconquistare tu imperio$/);
});

test('matched rulers get no reminder; far stronger rulers are told to act dominant', () => {
  assert.equal(powerReminder({relative_power_ratio:'1.1'}), '');
  assert.match(powerReminder({relative_power_ratio:'0.1'}), /about 10\.0 times stronger than this ruler\. Answer from a position of dominance/);
  assert.match(powerReminder({relative_power_ratio:'12.51'}), /win them over[\s\S]*treat it as an opportunity/);
  assert.equal(powerReminder({}), '');
  assert.match(powerBalance({relative_power_ratio:'1.0'}), /roughly matched/);
  assert.match(powerBalance({relative_power_ratio:'2.0'}), /the player is stronger than you/);
  assert.match(powerBalance({relative_power_ratio:'0.2'}), /Your realm is about 5\.0 times as strong[\s\S]*by far the stronger party/);
  assert.match(powerBalance({}), /Do not assume you are stronger/);
});

test('culture changes how a ruler reacts to power: Chaos never courts, Cathay does', () => {
  const fields = {relative_power_ratio:'12.51', ai_wars:'7', ai_regions:'one'};
  const chaos = powerStance('wh_main_chs_chaos wh_main_sc_chs_chaos');
  assert.equal(chaos.courts, false);
  assert.equal(powerStance('wh3_main_kho_khorne wh3_main_sc_kho_khorne').courts, false);
  assert.equal(powerStance('wh_dlc03_bst_beastmen wh_dlc03_sc_bst_beastmen').courts, false);
  assert.equal(powerStance('wh2_main_skv_skaven wh2_main_sc_skv_skaven').courts, true);
  // Faction and similar keys must not be misread: Cathay's "northern" is not Norsca,
  // and Chaos Dwarfs are not Dwarfs.
  assert.deepEqual(powerStance('wh3_main_cth_cathay wh3_main_sc_cth_cathay'), {courts:true, betrays:false, text:''});
  assert.equal(powerStance('wh3_dlc23_chd_chaos_dwarfs wh3_dlc23_sc_chd_chaos').text, '');
  const chaosBalance = powerBalance(fields, chaos);
  assert.match(chaosBalance, /your people do not court, beg or buy peace/);
  assert.doesNotMatch(chaosBalance, /court them with dignity/);
  assert.match(chaosBalance, /CULTURAL STANCE ON POWER[^\n]*scorn diplomacy/);
  assert.match(powerReminder(fields, chaos), /do not court, beg or buy peace from anyone/);
  assert.match(powerBalance(fields), /court them with dignity/);
  const request = {campaignId:'c', sender:'vlad', interlocutor:'archaon', turn:5, mode:'player', message:'hola',
    identity:{culture:'wh_main_chs_chaos', subculture:'wh_main_sc_chs_chaos'}, playerIdentity:{}, state:'', fields};
  const context = buildMessages(request, [], {}).at(-1).content;
  assert.match(context, /CULTURAL STANCE ON POWER/);
  assert.match(context, /BEFORE YOU ANSWER:[^\n]*do not court, beg or buy peace/);
  assert.match(SYSTEM_PROMPT, /CULTURAL STANCE ON POWER in the POWER BALANCE block overrides this generic advice/);
});

test('the reply is the ruler speaking, not a description of how the ruler answers', () => {
  // 25-09: to "hola" Katarin answered "Zarina Katarin ... responde con amabilidad seca ...
  // La actitud Muy amistosa justifica la apertura. 'Vlad ...'".
  assert.match(SYSTEM_PROMPT, /only the ruler's own words to the player, in the first person/);
  assert.match(SYSTEM_PROMPT, /Never narrate the ruler in the third person, describe their tone or traits, or explain how or why you are going to answer/);
});
