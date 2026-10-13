// 0.45: roleplay actions, ending the audience, greetings, brokered deals, the player's
// own lords and the Voice switch, as the companion sees them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDiplomacyResponse } from "../src/tag-parser.js";
import { compactAction, parseBridgeRequest, COMPANION_PROTOCOL } from "../src/protocol.js";
import { renderInbox } from "../src/lua-renderer.js";
import { buildMessages, customBlock } from "../src/llm-client.js";
import { MemoryStore } from "../src/memory-store.js";

const SYSTEM = buildMessages({ campaignId: "c", sender: "p", interlocutor: "ai", mode: "player", turn: 1, message: "hola", fields: {} }, [], {}, "English")[0].content;

test("[talk:end] is read, removed from the words and passed to the game", () => {
  const parsed = parseDiplomacyResponse("Enough. Get out of my sight. [diplo:reject] [relation:delta=-1;reason=insult] [talk:end]");
  assert.equal(parsed.endsTalk, true);
  assert.equal(parsed.narrative, "Enough. Get out of my sight.");
  assert.equal(parseDiplomacyResponse("Fine. [diplo:reject] [relation:delta=0;reason=neutral]").endsTalk, false);
  assert.match(renderInbox({ requestId: "r1", ...parsed }), /, -1, "insult", true\)/);
});

test("actions between single asterisks stay in the words", () => {
  const parsed = parseDiplomacyResponse("*kicks the head aside* You think this frightens me? [diplo:reject] [relation:delta=-1;reason=threat]");
  assert.equal(parsed.narrative, "*kicks the head aside* You think this frightens me?");
});

test("a brokered deal names the act and the third realm, with an optional price", () => {
  const peace = parseDiplomacyResponse("Very well. [diplo:broker:act=peace;target=wh_dlc03_bst_beastmen] [relation:delta=0;reason=neutral]");
  assert.deepEqual(peace.action, { type: "broker", act: "peace", target: "wh_dlc03_bst_beastmen" });
  assert.equal(compactAction(peace.action), "broker,peace,wh_dlc03_bst_beastmen");
  const war = parseDiplomacyResponse("For a price. [diplo:broker:act=war;target=wh_main_emp_middenland;price=1500] [relation:delta=0;reason=neutral]");
  assert.equal(compactAction(war.action), "broker,war,wh_main_emp_middenland,price_1500");
  assert.throws(() => parseDiplomacyResponse("No. [diplo:broker:act=betray;target=x] [relation:delta=0;reason=neutral]"), /act/);
});

test("the game may ask for a greeting, and protocol 2 says so", () => {
  assert.equal(COMPANION_PROTOCOL, 2);
  const line = "[LLMDIP] REQUEST|r1_1_1_1_1|c1|player|ai|greeting|turn%3D1|greeting";
  assert.equal(parseBridgeRequest(line).mode, "greeting");
});

test("the prompt allows short roleplay actions but still forbids narrating the ruler", () => {
  assert.match(SYSTEM, /ROLEPLAY ACTIONS: the player may describe what they do between single asterisks/);
  assert.match(SYSTEM, /never narrate the ruler in the third person/);
  assert.match(SYSTEM, /An action never changes the game/);
});

test("the prompt explains when a ruler ends the audience and lists the tag", () => {
  assert.match(SYSTEM, /ENDING THE AUDIENCE:/);
  assert.match(SYSTEM, /never with a friend or ally who is simply talking, and never in a background letter/);
  assert.match(SYSTEM, /\n\[talk:end\]\n/);
});

test("the prompt explains brokered deals and lists their tags", () => {
  assert.match(SYSTEM, /BROKERED DEALS:/);
  assert.match(SYSTEM, /never on your own allies and never on the player or the player's allies/);
  assert.match(SYSTEM, /\[diplo:broker:act=war;target=FACTION_KEY;price=INTEGER_100_TO_20000\]/);
});

test("a greeting request asks the ruler to speak first, in the game's language, without a deal", () => {
  const request = { campaignId: "c", sender: "p", interlocutor: "ai", mode: "greeting", turn: 3, message: "greeting", fields: {} };
  const user = buildMessages(request, [], {}, "Spanish")[1].content;
  assert.match(user, /INTERNAL GREETING REQUEST \(NOT PLAYER DIALOGUE\)/);
  assert.match(user, /written in Spanish/);
  assert.match(user, /use \[diplo:reject\] and \[relation:delta=0;reason=neutral\]/);
  assert.doesNotMatch(user, /PLAYER'S CURRENT WORDS/);
});

test("the player's own direction reaches the prompt without overriding the rules", () => {
  assert.equal(customBlock({ general: "", lord: "" }), "");
  const block = customBlock({ general: "Keep it short.", lord: "Speak like a pirate." });
  assert.match(block, /never changes the tags, the reply format, what the game allows/);
  const request = { campaignId: "c", sender: "p", interlocutor: "ai", mode: "player", turn: 1, message: "hola", fields: {},
    custom: { general: "Keep it short.", lord: "Speak like a pirate." } };
  const user = buildMessages(request, [], {}, "English")[1].content;
  assert.ok(user.indexOf("For you: Speak like a pirate.") < user.indexOf("PLAYER'S CURRENT WORDS"));
});

test("custom/ is created once, and the player's lord file overrides the curated one field by field", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-custom-"));
  try {
    const dataDir = path.join(base, "data");
    const lore = { wh3_main_ksl_katarin: { canonNotes: ["Ice Queen."], voiceNotes: ["Cold."], voiceGender: "female" } };
    const store = new MemoryStore(dataDir, { loreRoot: path.join(base, "none"), embeddedLore: lore });
    const custom = store.ensureCustomFolder();
    assert.equal(custom, path.join(base, "custom"));
    assert.ok(fs.existsSync(path.join(custom, "README.txt")) && fs.existsSync(path.join(custom, "lords", "_example.json")));
    fs.writeFileSync(path.join(custom, "README.txt"), "mine");
    store.ensureCustomFolder();
    assert.equal(fs.readFileSync(path.join(custom, "README.txt"), "utf8"), "mine", "never overwritten");

    fs.writeFileSync(path.join(custom, "lords", "wh3_main_ksl_katarin.json"), JSON.stringify({ voiceNotes: ["Warm and teasing."], instructions: "Call me cousin." }));
    fs.writeFileSync(path.join(custom, "instructions.txt"), "Short replies.");
    const merged = store.curatedLore("wh3_main_ksl_katarin", "wh3_main_ksl_the_ice_court");
    assert.deepEqual(merged.voiceNotes, ["Warm and teasing."]);
    assert.deepEqual(merged.canonNotes, ["Ice Queen."], "fields the player left out keep the mod's version");
    assert.deepEqual(store.customInstructions("wh3_main_ksl_katarin", "x"), { general: "Short replies.", lord: "Call me cousin." });

    fs.writeFileSync(path.join(custom, "lords", "wh3_main_ksl_katarin.json"), "{ broken");
    assert.deepEqual(store.curatedLore("wh3_main_ksl_katarin", "x").voiceNotes, ["Cold."], "a broken file is ignored");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a greeting is remembered as the ruler speaking first, with no player words", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-greet-"));
  try {
    const store = new MemoryStore(path.join(base, "data"));
    const r = { requestId: "g1", campaignId: "c1", sender: "player", interlocutor: "ai", mode: "greeting", turn: 1, memoryParent: "root", message: "greeting" };
    store.append(r, "Welcome back.", { type: "reject" }, { delta: 0, reason: "neutral" });
    assert.deepEqual(store.history({ ...r, memoryParent: "g1" }).map(x => [x.role, x.content]), [["assistant", "Welcome back."]]);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a reply the game cannot read gets a second draft that says what went wrong", () => {
  const request = { campaignId: "c", sender: "p", interlocutor: "ai", mode: "player", turn: 1, message: "war on them for 1500", fields: {},
    formatCorrection: "LLM must emit exactly one [diplo:...] tag" };
  const user = buildMessages(request, [], {}, "Spanish")[1].content;
  assert.match(user, /YOUR FIRST DRAFT COULD NOT BE READ BY THE GAME: LLM must emit exactly one/);
  assert.match(user, /the price goes on that same tag with ;price=N, never as a second gold tag/);
  assert.doesNotMatch(buildMessages({ ...request, formatCorrection: undefined }, [], {}, "Spanish")[1].content, /COULD NOT BE READ/);
});
