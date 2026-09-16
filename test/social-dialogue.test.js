import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYSTEM_PROMPT, buildMessages } from '../src/llm-client.js';
import { buildSocialStyle, personalityBrief } from '../src/personality.js';
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
  assert.match(SYSTEM_PROMPT,/Live state overrides stale dialogue/);
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
