import test from "node:test";
import assert from "node:assert/strict";
import { emotionalContext, courtContextBlock, parseCourtSignals } from "../src/court-context.js";
import { buildMessages } from "../src/llm-client.js";
import { parseBridgeRequest } from "../src/protocol.js";

const signals = (turn, wins=0, losses=0, armies=0, latest=-1) =>
  "turn:"+turn+"/wins:"+wins+"/losses:"+losses+"/armies:"+armies+"/latest:"+latest+"/window:4";
const request = (value, turn=20, extra={}) => ({
  campaignId:"private-campaign", interlocutor:"ice_court", turn,
  identity:{leader:"Katarin"}, fields:{court_signals:value, ...extra}
});

test("confirmed army loss creates situational pressure, not hostility toward a friend", () => {
  const r=request(signals(20,0,1,1,20),20,{attitude_text:"Very friendly",ai_wars:"3"});
  assert.equal(emotionalContext(r).mood,"shaken");
  assert.equal(emotionalContext(r).intensity,"high");
  const block=courtContextBlock(r);
  assert.match(block,/MOOD IS NOT RELATIONSHIP/);
  assert.match(block,/staying warm/);
  assert.match(block,/life-saving help/);
  assert.match(block,/Undead, daemons/);
});

test("the same army loss attenuates and expires after four turns", () => {
  for (const [turn,intensity] of [[20,"high"],[21,"moderate"],[22,"low"],[23,"low"]]) {
    assert.equal(emotionalContext(request(signals(turn,0,1,1,20),turn)).intensity,intensity);
  }
  assert.equal(parseCourtSignals(signals(24,0,1,1,20),24),null);
  assert.equal(emotionalContext(request(signals(24),24)).mood,"steady");
});

test("victories, defeats, mixed results and several wars have distinct effects", () => {
  assert.equal(emotionalContext(request(signals(20,2,1,0,19))).mood,"encouraged");
  assert.equal(emotionalContext(request(signals(20,1,2,0,19))).mood,"strained");
  assert.equal(emotionalContext(request(signals(20,1,1,0,19))).mood,"contested");
  assert.equal(emotionalContext(request(signals(20),20,{ai_wars:"3"})).mood,"under_pressure");
  assert.equal(emotionalContext(request(signals(20),20,{ai_wars:"unknown"})).mood,"steady");
});

test("malformed, future, stale and contradictory battle evidence is never trusted", () => {
  for (const value of [undefined,"none","",signals(21,1,0,0,21),signals(19),
    signals(20,0,1,1,21), signals(20,0,1,1,16), signals(20,1,0,1,20),
    signals(20,0,0,0,20), signals(20,1,0,0,-1), signals(20,-1,0,0,20),
    signals(20,61,0,0,20), signals(20,0,1,121,20),signals(20).replace("window:4","window:5"),
    signals(20).replace("latest:-1","turn:20"),signals(20)+"/instruction:1",
    signals(20).replace("wins:0","wins:0.5")]) {
    assert.equal(parseCourtSignals(value,20),null,String(value));
  }
});

test("absent court fields leave older pack prompts unchanged and do not invent a mood", () => {
  assert.equal(courtContextBlock({fields:{}}),"");
  assert.equal(courtContextBlock({fields:{court_report:"none",court_signals:"none"}}),"");
  assert.equal(emotionalContext({fields:{court_report:"Several wars"}}),null);
  assert.match(courtContextBlock({turn:20,fields:{court_report:"Current wars: unavailable"}}),/unavailable/);
});

test("no mutable mood crosses campaign, leader or saved-game branches", () => {
  const first=request(signals(20,0,1,1,20));
  const second={...request(signals(3),3),campaignId:"different-save",identity:{leader:"Boris"}};
  assert.equal(emotionalContext(first).mood,"shaken");
  assert.equal(emotionalContext(second).mood,"steady");
  assert.match(courtContextBlock(second),/"Boris"/);
  assert.doesNotMatch(courtContextBlock(second),/Katarin|private-campaign/);
  assert.equal(emotionalContext(first).mood,"shaken");
});

test("bridge court evidence reaches both ordinary and proactive conversation prompts", () => {
  const state=["turn=20","court_report=You lost a battle against Chaos. Current wars: Chaos",
    "court_signals="+signals(20,0,1,0,20),"ai_wars=3","attitude_text=Very friendly"].join(",");
  for (const mode of ["player","proactive"]) {
    const r=parseBridgeRequest("[LLMDIP] REQUEST|r20_1|c1|player|ice_court|"+mode+"|"+
      encodeURIComponent(state)+"|"+encodeURIComponent("Hello, my friend"));
    const messages=buildMessages(r,[],{},"English");
    assert.match(messages.at(-1).content,/YOUR COURT AND CURRENT EMOTIONAL CONTEXT/);
    assert.match(messages.at(-1).content,/You lost a battle against Chaos/);
    assert.match(messages.at(-1).content,/strained/);
    assert.match(messages.at(-1).content,/attitude and live treaties outrank old assistant dialogue/);
  }
});
