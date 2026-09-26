import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BetrayalStore, betrayalOpportunity, betrayalBlock, enforceBetrayal } from "../src/betrayal.js";
import { parseDiplomacyResponse } from "../src/tag-parser.js";
import { renderInbox } from "../src/lua-renderer.js";
import { buildMessages, SYSTEM_PROMPT } from "../src/llm-client.js";

const skaven = { culture: "wh2_main_skv_skaven", subculture: "wh2_main_sc_skv_skaven", personality: { axes: { honour: 60 } }, socialStyle: { opportunism: 20 } };
const cathay = { culture: "wh3_main_cth_cathay", subculture: "wh3_main_sc_cth_cathay", personality: { axes: { honour: 60 } }, socialStyle: { opportunism: 20 } };
const schemer = { ...cathay, personality: { axes: { honour: 30 } }, socialStyle: { opportunism: 70 } };
const request = (fields = {}, extra = {}) => ({ campaignId: "c1", sender: "player", interlocutor: "ai", requestId: "r1", turn: 20, mode: "proactive",
  identity: {}, fields: { mil_alliance: "1", allied: "1", relative_power_ratio: "0.9", attitude_category: "3", player_wars: "a", ...fields }, ...extra });
const always = { random: () => 0 }, never = { random: () => 0.99 };

test("a treacherous ally with the upper hand is offered the betrayal; the dice decide", () => {
  const offered = betrayalOpportunity(request(), skaven, null, always);
  assert.equal(offered.offered, true);
  assert.deepEqual(offered.treaties, ["military alliance", "alliance"]);
  assert.match(offered.motives.join(), /at least as strong/);
  const held = betrayalOpportunity(request(), skaven, null, never);
  assert.equal(held.offered, false);
  assert.equal(held.hint, true, "an eligible schemer who does not roll it still foreshadows");
});

test("no treaty, war already, a chat reply or the setting off mean no betrayal", () => {
  assert.equal(betrayalOpportunity(request({ mil_alliance: "0", allied: "0" }), skaven, null, always).offered, false);
  assert.equal(betrayalOpportunity(request({ direct_war_now: "1" }), skaven, null, always).offered, false);
  assert.equal(betrayalOpportunity(request({}, { mode: "player" }), skaven, null, always).offered, false);
  assert.equal(betrayalOpportunity(request(), skaven, null, { ...always, enabled: false }).offered, false);
});

test("an honest culture only betrays through a low-honour opportunist, and never a friend", () => {
  assert.equal(betrayalOpportunity(request(), cathay, null, always).offered, false);
  assert.equal(betrayalOpportunity(request(), schemer, null, always).offered, true);
  assert.equal(betrayalOpportunity(request({ attitude_category: "5" }), schemer, null, always).offered, false);
  assert.equal(betrayalOpportunity(request({ attitude_category: "5" }), skaven, null, always).offered, true, "Skaven stab friends too");
});

test("betrayal needs an advantage: strength or a player tied down in wars", () => {
  assert.equal(betrayalOpportunity(request({ relative_power_ratio: "1.8" }), skaven, null, always).offered, false);
  const busy = betrayalOpportunity(request({ relative_power_ratio: "1.8", player_wars: "a:b:c" }), skaven, null, always);
  assert.equal(busy.offered, true);
  assert.match(busy.motives.join(), /tied down in 3 wars/);
});

test("each faction betrays once, and the player gets ten quiet turns between betrayals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-betrayal-"));
  try {
    const store = new BetrayalStore(dir);
    store.record({ campaignId: "c1", sender: "player", interlocutor: "other", requestId: "x", turn: 15 });
    assert.equal(betrayalOpportunity(request(), skaven, store, always).offered, false, "another faction betrayed 5 turns ago");
    assert.equal(betrayalOpportunity(request({}, { turn: 25 }), skaven, store, always).offered, true);
    store.record({ campaignId: "c1", sender: "player", interlocutor: "ai", requestId: "y", turn: 25 });
    const again = betrayalOpportunity(request({}, { turn: 60 }), skaven, store, always);
    assert.equal(again.offered, false);
    assert.equal(again.hint, false);
    assert.equal(betrayalOpportunity({ ...request({}, { turn: 60 }), campaignId: "c2" }, skaven, store, always).offered, true, "other campaigns are separate");
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test("the model can only betray when the code offered it", () => {
  const parsed = parseDiplomacyResponse("Your alliance bores me. [diplo:betray_war] [relation:delta=0;reason=neutral]");
  assert.equal(parsed.action.type, "betray_war");
  assert.equal(enforceBetrayal(parsed, { offered: false }).action.type, "reject");
  assert.equal(enforceBetrayal(parsed, { offered: true }).action.type, "betray_war");
  assert.match(renderInbox({ requestId: "r1", ...parsed }), /"betray_war"/);
});

test("the prompt only carries the opportunity when it exists, and remembers a betrayal as fact", () => {
  assert.match(SYSTEM_PROMPT, /\[diplo:betray_war\] exists only when a BETRAYAL OPPORTUNITY block is present/);
  const offer = { offered: true, hint: false, treaties: ["military alliance"], motives: ["they are tied down in 3 wars"], nature: "culture" };
  const withOffer = buildMessages(request(), [], skaven, "English", offer).at(-1).content;
  assert.match(withOffer, /BETRAYAL OPPORTUNITY \(real, this letter only\)[^\n]*military alliance[^\n]*tied down in 3 wars/);
  assert.match(withOffer, /Never praise the pact or wish them well in a betrayal letter/);
  // 25-09: with the choice before the letter request, Queek praised the alliance and betrayed in the same letter.
  assert.ok(withOffer.indexOf("BETRAYAL OPPORTUNITY") > withOffer.indexOf("INTERNAL LETTER REQUEST"), "the choice comes last");
  assert.match(withOffer, /Your people betray allies whenever it pays/);
  assert.doesNotMatch(buildMessages(request(), [], skaven, "English", { offered: false, hint: false }).at(-1).content, /BETRAYAL OPPORTUNITY|SCHEMING/);
  assert.match(betrayalBlock({ offered: false, hint: true, treaties: ["trade agreement"] }), /SCHEMING \(flavour only\)[\s\S]*cannot betray them in this letter/);
  const scope = { campaignId: "c1", sender: "player", interlocutor: "ai" };
  const history = [{ role: "assistant", content: "Your alliance bores me.", action: { type: "betray_war" }, turn: 19, scope }];
  assert.match(buildMessages(request(), history, skaven, "English").at(-1).content, /With this letter YOUR faction betrayed the player/);
});

test("test mode offers it to any treaty partner, but still needs a treaty and a letter", () => {
  const test_ = { test: true };
  assert.equal(betrayalOpportunity(request({ relative_power_ratio: "5" }), cathay, null, test_).offered, true);
  assert.equal(betrayalOpportunity(request({ mil_alliance: "0", allied: "0" }), cathay, null, test_).offered, false);
  assert.equal(betrayalOpportunity(request({}, { mode: "player" }), cathay, null, test_).offered, false);
  assert.equal(betrayalOpportunity(request(), cathay, null, { ...test_, enabled: false }).offered, false);
});

test("a real non-aggression pact exists and is kept apart from the paid favour", () => {
  // 25-09: Miao Ying offered "non-aggression" through the paid favour; Vlad accepted, got
  // 500 gold and no pact was signed in the game.
  assert.equal(parseDiplomacyResponse("Peace. [diplo:non_aggression_pact] [relation:delta=0;reason=neutral]").action.type, "non_aggression_pact");
  assert.match(renderInbox({ requestId: "r1", ...parseDiplomacyResponse("Peace. [diplo:non_aggression_pact]") }), /"non_aggression_pact"/);
  assert.match(SYSTEM_PROMPT, /\[diplo:non_aggression_pact\] signs a real non-aggression pact/);
  assert.match(SYSTEM_PROMPT, /YOU pay the player gold for their promise not to attack you, and no treaty is signed/);
  const context = buildMessages(request({ nap: "1" }), [], skaven, "English").at(-1).content;
  assert.match(context, /Non-aggression pact: YES, in force now/);
});
