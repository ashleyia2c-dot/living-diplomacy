import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore, DIGEST_LIMIT_MESSAGES, DIGEST_KEEP_RAW } from "../src/memory-store.js";
import { buildDigestMessages, cleanDigest, describeAction, foldedLetters, shortName } from "../src/memory-digest.js";
import { buildMessages, pairEvents, pairEventsText, compactDossier } from "../src/llm-client.js";

const base = { campaignId: "camp", sender: "vlad", interlocutor: "miao", mode: "player" };

function converse(store, count, { prefix = "r", parent = "root", turn = 10 } = {}) {
  let head = parent;
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}${i}`;
    store.append({ ...base, requestId: id, memoryParent: head, turn: turn + i, message: `player says ${i}` }, `lord answers ${i}`, { type: "reject" }, { delta: 0, reason: "neutral" });
    head = id;
  }
  return head;
}

const RECORD = "PROMISES:\n- Vlad promised to retake the Great Bastion.\nDONE BETWEEN THEM:\n- Essen given to Miao Ying.\nSURVIVAL:\n- The Bastion fell.\nTHE BOND:\n- Warm trust.\nSTILL OPEN:\n- none";

test("a short correspondence needs no record and letters are built exactly as before", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-digest-"));
  const store = new MemoryStore(root);
  const head = converse(store, 3);
  const request = { ...base, requestId: "next", memoryParent: head };
  assert.equal(store.digestPlan(request), null);
  const { digest, recent } = store.recall(request);
  assert.equal(digest, null);
  assert.deepEqual(recent.map(m => m.content), store.history(request).map(m => m.content));
  fs.rmSync(root, { recursive: true, force: true });
});

test("past the limit the oldest letters are folded, whole exchanges only, and the newest stay raw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-digest-"));
  const store = new MemoryStore(root);
  const head = converse(store, 9); // 18 messages
  const request = { ...base, requestId: "next", memoryParent: head };
  const plan = store.digestPlan(request);
  assert.ok(18 > DIGEST_LIMIT_MESSAGES && plan, "18 messages pass the limit");
  assert.equal(plan.fold.length, 18 - DIGEST_KEEP_RAW);
  assert.equal(plan.fold.at(-1).role, "assistant", "a player's words are never folded without the reply");
  assert.equal(plan.throughNode, "r6");
  store.saveDigest(request, plan, RECORD);
  const { digest, recent } = store.recall(request);
  assert.equal(digest.text, RECORD);
  assert.equal(digest.throughTurn, 16);
  assert.deepEqual(recent.map(m => m.content), ["player says 7", "lord answers 7", "player says 8", "lord answers 8", "player says 9", "lord answers 9"]);
  assert.equal(store.digestPlan(request), null, "nothing more to fold");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a long single letter also triggers a fold: the limit counts characters too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-digest-"));
  const store = new MemoryStore(root);
  let head = "root";
  for (let i = 1; i <= 5; i++) {
    const id = `long${i}`;
    store.append({ ...base, requestId: id, memoryParent: head, turn: i, message: "x".repeat(900) }, "y".repeat(200), { type: "reject" }, { delta: 0, reason: "neutral" });
    head = id;
  }
  const plan = store.digestPlan({ ...base, requestId: "n", memoryParent: head });
  assert.ok(plan && plan.fold.length === 4, "10 messages but over 3500 characters");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a record belongs to its save branch: an older save never sees letters it does not have", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-digest-"));
  const store = new MemoryStore(root);
  const early = converse(store, 2, { prefix: "a" });
  const late = converse(store, 8, { prefix: "b", parent: early, turn: 20 });
  const lateRequest = { ...base, requestId: "next", memoryParent: late };
  store.saveDigest(lateRequest, store.digestPlan(lateRequest), RECORD);
  assert.ok(store.recall(lateRequest).digest, "the branch that was folded uses its record");
  // The player reloads the save made after a2 and plays a different story.
  const reloaded = { ...base, requestId: "other", memoryParent: early };
  assert.equal(store.recall(reloaded).digest, null);
  assert.deepEqual(store.recall(reloaded).recent.map(m => m.content), ["player says 1", "lord answers 1", "player says 2", "lord answers 2"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a later fold rolls the previous record forward", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-digest-"));
  const store = new MemoryStore(root);
  const first = converse(store, 9);
  const request = { ...base, requestId: "n", memoryParent: first };
  store.saveDigest(request, store.digestPlan(request), RECORD);
  const second = converse(store, 6, { prefix: "s", parent: first, turn: 40 });
  const plan = store.digestPlan({ ...base, requestId: "n2", memoryParent: second });
  assert.ok(plan);
  assert.equal(plan.previous, RECORD);
  assert.equal(plan.fold[0].content, "player says 7", "folding resumes right after the record");
  const messages = buildDigestMessages(plan, { lord: "Miao Ying", player: "Vlad" });
  assert.match(messages[1].content, /PREVIOUS RECORD[\s\S]*retake the Great Bastion/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the record prompt asks for promises, deeds, survival, the bond and open matters, and gives the lord's real words", () => {
  const fold = [
    { role: "user", content: "te ayudaremos a recuperar la muralla", turn: 56, speakerIdentity: { leader: "Vlad von Carstein" } },
    { role: "assistant", content: "Esperaré tu llegada.", turn: 56, mode: "player", speakerIdentity: { leader: "Miao Ying_ la Dragona de la Tormenta " },
      action: { type: "transfer_region", region: "wh3_main_combi_region_zhufbar", recipient: "interlocutor" } }
  ];
  const [system, user] = buildDigestMessages({ previous: "", fold }, { lord: "Miao Ying", player: "Vlad", events: "turn 56: agreed through letters: alliance" });
  for (const section of ["PROMISES:", "DONE BETWEEN THEM:", "SURVIVAL:", "THE BOND:", "STILL OPEN:"]) assert.ok(system.content.includes(section));
  assert.match(system.content, /romance/);
  assert.match(system.content, /never write "I", "we" or "you"/);
  assert.match(user.content, /Esperaré tu llegada/, "the lord's own promises are read");
  assert.match(user.content, /Miao Ying formally proposed in this letter: Vlad hands the region zhufbar to Miao Ying/);
  assert.match(user.content, /GAME RECORD OF EVENTS BETWEEN THE TWO REALMS: turn 56/);
  assert.doesNotMatch(user.content, /la Dragona de la Tormenta/, "long titles are shortened");
  assert.equal(shortName("Miao Ying_ la Dragona de la Tormenta "), "Miao Ying");
  assert.equal(describeAction({ type: "offer_gold", amount: 500 }, "Miao Ying", "Vlad"), "Miao Ying gives 500 gold to Vlad");
  assert.match(foldedLetters(fold, { lord: "Miao Ying", player: "Vlad" }), /^turn 56, Vlad von Carstein \(the player\) wrote/);
});

test("the record is cleaned to its five sections and trimmed without losing one", () => {
  assert.equal(cleanDigest("Sure! Here is a summary."), "", "not a record");
  const raw = "```\n**PROMISES:** Vlad will help\nDONE BETWEEN THEM:\n- alliance\nSURVIVAL:\n- none\nTHE BOND:\n- trust\nSTILL OPEN:\n- none\n```";
  assert.equal(cleanDigest(raw), "PROMISES:\n- Vlad will help\nDONE BETWEEN THEM:\n- alliance\nSURVIVAL:\n- none\nTHE BOND:\n- trust\nSTILL OPEN:\n- none");
  const long = ["PROMISES:", ...Array(30).fill("- a long promise line that goes on and on for quite a while"), "DONE BETWEEN THEM:", "- x", "SURVIVAL:", "- y", "THE BOND:", "- z", "STILL OPEN:", "- the open matter"].join("\n");
  const cleaned = cleanDigest(long);
  assert.ok(cleaned.length <= 1400);
  assert.match(cleaned, /STILL OPEN:\n- the open matter$/);
});

test("the letters between the two realms are read from both lists once, and leave the dossier", () => {
  const fields = {
    ai_recent_diplomacy: "56~llm_deal_alliance~vlad~miao:60~war_declared~miao~chaos:82~offer_rejected~miao~vlad:82~offer_rejected~miao~vlad",
    player_recent_diplomacy: "79~war_declared~vlad~khorne:82~offer_rejected~miao~vlad:82~offer_rejected~miao~vlad"
  };
  const events = pairEvents(fields, "vlad", "miao");
  assert.deepEqual(events.map(e => `${e.turn}:${e.event}`), ["56:llm_deal_alliance", "82:offer_rejected", "82:offer_rejected"]);
  assert.match(pairEventsText(events, { lord: "miao", playerName: "Sylvania" }), /^turn 56: agreed through letters: alliance \(the game names Sylvania first, then you\)/);
  const dossier = compactDossier("turn=82,memory_parent=r1,memory_head=r2,ui_language=es,ai_recent_diplomacy=" + fields.ai_recent_diplomacy + ",mil_alliance=1", { pair: ["vlad", "miao"] });
  assert.equal(dossier, "turn=82,ai_recent_diplomacy=60~war_declared~miao~chaos,mil_alliance=1");
});

test("the letter opens with who the lord is and the balance of power, and closes with memory and the live relationship", () => {
  const request = { ...base, requestId: "q", turn: 83, message: "¿recuerdas lo que te prometí?", identity: { leader: "Miao Ying" }, playerIdentity: { leader: "Vlad", factionName: "Sylvania" },
    state: "turn=83,memory_parent=r1,mil_alliance=1,ai_recent_diplomacy=56~llm_deal_alliance~vlad~miao",
    fields: { mil_alliance: "1", allied: "1", attitude_text: "Amigos de confianza", relative_power_ratio: "1.5", ai_wars: "2", direct_war_events: "82~offer_rejected~by_interlocutor",
      ai_recent_diplomacy: "56~llm_deal_alliance~vlad~miao" } };
  const history = [{ role: "user", content: "hola", turn: 82, mode: "player", speakerIdentity: { leader: "Vlad" }, scope: { campaignId: "camp", sender: "vlad", interlocutor: "miao" } },
    { role: "assistant", content: "Saludos, Vlad.", turn: 82, mode: "player", speakerIdentity: { leader: "Miao Ying" }, action: { type: "reject" }, scope: { campaignId: "camp", sender: "vlad", interlocutor: "miao" } }];
  const text = buildMessages(request, history, { leader: "Miao Ying" }, "Spanish", null, { text: RECORD, throughTurn: 69 })[1].content;
  const at = needle => { const i = text.indexOf(needle); assert.ok(i >= 0, `missing ${needle}`); return i; };
  const order = ["YOUR IDENTITY", "Curated canonical notes", "POWER BALANCE", "WHO ADDRESSES YOU", "AUTHORITATIVE LIVE STRATEGIC DOSSIER",
    "PAIR-SPECIFIC BATTLE FACT CHECK", "WHAT YOU REMEMBER OF THIS RULER", "retake the Great Bastion", "Recent letters",
    "TREATIES BETWEEN YOU TWO RIGHT NOW", "CURRENT RELATIONSHIP", "Power, in one line:", "PLAYER'S CURRENT WORDS"];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  assert.match(text, /written record of your older letters with this ruler \(through turn 69\)/);
  assert.match(text, /Recent game record between your realms \(oldest first\): turn 56: agreed through letters: alliance/);
  assert.doesNotMatch(text, /memory_parent=/, "bookkeeping is not shown to the model");
  assert.doesNotMatch(text, /ai_recent_diplomacy=56~llm_deal/, "the pair's events are shown once, near the end");
  assert.match(text, /immediately previous AI reply, historical and possibly mistaken[^\n]*Saludos, Vlad/);
  assert.equal(text.split("82~offer_rejected~by_interlocutor").length - 1, 1, "the pair's recorded events appear once");
});

test("the companion folds old letters in the background after answering, and builds letters from the record", () => {
  const companion = fs.readFileSync(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.match(companion, /const \{ digest, recent: history \} = memory\.recall\(request\)/);
  assert.match(companion, /callLlm\(config, request, history, profile, betrayal, digest, codexText\)/);
  const handle = companion.slice(companion.indexOf("async function handleRequest"), companion.indexOf("const digesting"));
  assert.ok(handle.indexOf("enqueueInbox(renderInbox") < handle.indexOf("scheduleDigest(request, profile)"), "the letter is delivered first");
  const schedule = companion.slice(companion.indexOf("function scheduleDigest"), companion.indexOf("// The player's court briefing"));
  assert.doesNotMatch(schedule, /^\s*await \(async/m, "the fold is never awaited by the letter");
  assert.match(schedule, /digesting\.has\(key\)/, "one fold at a time per lord");
});

test("every female lord is presented as a woman, whatever the game's broken male flag says", async () => {
  const { genderFor } = await import("../src/llm-client.js");
  const dir = new URL("../lore-profiles/", import.meta.url);
  const profiles = fs.readdirSync(dir).filter(name => name.endsWith(".json") && !name.startsWith("_"))
    .map(name => ({ key: name.slice(0, -5), ...JSON.parse(fs.readFileSync(new URL(name, dir), "utf8")) }));
  // Female legendary lords of WH3 (script logs report ai_leader_male=1 for all of them).
  const women = ["wh3_main_cth_miao_ying", "wh3_main_ksl_katarin", "wh3_dlc24_ksl_mother_ostankya", "wh2_dlc09_tmb_khalida",
    "wh3_dlc29_vmp_neferata", "wh3_dlc25_emp_elspeth_von_draken", "wh3_dlc20_kho_valkia", "wh_dlc07_brt_fay_enchantress",
    "wh2_dlc14_brt_repanse", "wh2_dlc16_wef_drycha", "wh2_dlc16_wef_sisters_of_twilight", "wh2_dlc16_wef_ariel",
    "wh2_dlc10_hef_alarielle", "wh2_main_def_morathi", "wh2_dlc10_def_crone_hellebron", "wh2_dlc11_cst_aranessa",
    "wh2_dlc11_cst_cylostra", "wh3_dlc27_sla_dechala", "wh3_dlc27_sla_masque_of_slaanesh", "wh_pro02_vmp_isabella_von_carstein"];
  const byKey = Object.fromEntries(profiles.map(p => [p.key, p]));
  const female = profiles.filter(p => p.voiceGender === "female").map(p => p.key);
  for (const key of new Set([...women, ...female])) {
    assert.equal(genderFor(key, byKey[key]?.voiceGender), "female", key);
    const request = { campaignId: "c", sender: "p", interlocutor: "ai", turn: 1, mode: "player", message: "hola",
      state: "ai_leader_male=1,player_leader_male=1", fields: { ai_leader_male: "1" },
      identity: { leader: key, leaderSubtype: key }, playerIdentity: { leader: key, leaderSubtype: key, gender: byKey[key]?.voiceGender } };
    const text = buildMessages(request, [], { leader: key, leaderSubtype: key, voiceGender: byKey[key]?.voiceGender }, "English")[1].content;
    assert.match(text, /YOUR IDENTITY — INTERLOCUTOR:[\s\S]*?Gender: female[\s\S]*WHO ADDRESSES YOU — PLAYER:[\s\S]*?Gender: female/, key);
    assert.doesNotMatch(text, /leader_male/, "the broken flag never reaches the model");
  }
  assert.equal(genderFor("wh_main_emp_karl_franz", "male"), "male");
  assert.equal(genderFor("wh_main_emp_lord", undefined), "", "an unknown generic lord gets no guessed gender");
});
