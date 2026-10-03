// The campaign codex (src/codex.js): names in a conversation bring in who that realm,
// ruler, people, god or place is, in any of the game's languages, within a budget.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Codex, parseCodexLine, mentions, normalise, CODEX_BUDGET } from "../src/codex.js";
import { PEOPLES } from "../src/codex-data.js";
import { MemoryStore } from "../src/memory-store.js";
import { buildMessages } from "../src/llm-client.js";
import { buildCouncilMessages } from "../src/court-briefing.js";

const ROWS = [
  ["wh3_dlc29_chs_host_of_the_triplets", "Hueste de los Trillizos", "Guerreros del Caos", "wh_main_sc_chs_chaos", "Glottkin", "wh3_dlc29_chs_glottkin", "12", "8", ""],
  ["wh3_main_ksl_the_ice_court", "La Corte de Hielo", "Kislev", "wh3_main_sc_ksl_kislev", "Zarina Katarin", "wh3_main_ksl_katarin", "1", "20", ""],
  ["wh3_main_ksl_the_great_orthodoxy", "La Gran Ortodoxia", "Kislev", "wh3_main_sc_ksl_kislev", "Kostaltyn, el Patriarca Supremo", "wh3_main_ksl_kostaltyn", "14", "9", ""],
  ["wh2_dlc09_tmb_khalida", "Lybaras", "Reyes Funerarios", "wh2_dlc09_sc_tmb_tomb_kings", "Gran Reina Khalida", "wh2_dlc09_tmb_khalida", "30", "4", ""],
  ["wh_main_emp_empire", "El Imperio", "El Imperio", "wh_main_sc_emp_empire", "Karl Franz", "wh_main_emp_karl_franz", "3", "40", ""],
  ["wh_main_vmp_schwartzhafen", "Sylvania", "Condes Vampiro", "wh_main_sc_vmp_vampire_counts", "Vlad von Carstein", "wh_dlc04_vmp_vlad_con_carstein", "2", "70", "player"]
];
const LINE = `[LLMDIP] CODEX|c1|wh_main_vmp_schwartzhafen|85|es|${encodeURIComponent(ROWS.map(row => row.join("\t")).join("\n"))}`;

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-codex-"));
  const memory = new MemoryStore(dir, { loreRoot: path.resolve("lore-profiles"), embeddedLore: {} });
  const codex = new Codex(dir, memory);
  codex.store(parseCodexLine(LINE));
  return { dir, memory, codex };
}
const ids = (codex, text, options) => codex.select("c1", [text], options).map(entry => entry.id);

test("the game's realm index is read and kept for the campaign, also after a restart", () => {
  const { dir, memory, codex } = fresh();
  const index = parseCodexLine(LINE);
  assert.equal(index.realms.length, 6);
  assert.deepEqual(index.realms[0], { key: "wh3_dlc29_chs_host_of_the_triplets", name: "Hueste de los Trillizos", people: "Guerreros del Caos",
    subculture: "wh_main_sc_chs_chaos", ruler: "Glottkin", subtype: "wh3_dlc29_chs_glottkin", rank: 12, settlements: 8, player: false });
  assert.ok(index.realms.at(-1).player);
  const restarted = new Codex(dir, memory);
  assert.ok(restarted.select("c1", ["¿quiénes son los de la hueste de los trillizos?"]).length > 0);
  assert.equal(parseCodexLine("[LLMDIP] REQUEST|x"), null);
  assert.throws(() => parseCodexLine("[LLMDIP] CODEX|c1|p|1"));
});

test("a realm named in the conversation brings its people, its ruler and that ruler's lore", () => {
  const { codex } = fresh();
  const chosen = codex.select("c1", ["la hueste de los trillizos ? , quienes son esos ?"]);
  assert.deepEqual(chosen.map(entry => entry.id), ["realm:wh3_dlc29_chs_host_of_the_triplets", "people:wh_main_sc_chs_chaos"]);
  assert.match(chosen[0].text, /Hueste de los Trillizos, a realm of the Guerreros del Caos, ruled by Glottkin\. Strength rank 12/);
  assert.match(chosen[0].text, /Glottkin: .*Nurgle/);
  assert.ok(PEOPLES.wh_main_sc_chs_chaos.startsWith(chosen[1].text), "the people's first sentence");
  assert.deepEqual(ids(codex, "¿Qué opinas de Kostaltyn?"), ["realm:wh3_main_ksl_the_great_orthodoxy", "people:wh3_main_sc_ksl_kislev"]);
  assert.deepEqual(ids(codex, "Dile a Glottkin que se rinda").slice(0, 1), ["realm:wh3_dlc29_chs_host_of_the_triplets"]);
  assert.deepEqual(ids(codex, "khalida me ha escrito").slice(0, 1), ["realm:wh2_dlc09_tmb_khalida"]);
});

test("it works in every language: accents, Cyrillic, Chinese and Korean", () => {
  const { codex } = fresh();
  assert.equal(normalise("Gran Bastión ÉCLAIR 코른"), "gran bastion eclair 코른");
  assert.ok(ids(codex, "¿Qué pasó en el Gran Bastion?").some(id => id.startsWith("topic:")));
  assert.ok(ids(codex, "Les disciples de Hashut m'inquiètent").length === 1);
  assert.ok(ids(codex, "Что ты думаешь о Хашут?").length === 1);
  assert.ok(ids(codex, "你怎么看恐虐？").length === 1);
  assert.ok(ids(codex, "코른은 어떤 신이야?").length === 1);
  assert.ok(ids(codex, "Wo liegt die Chaoswüste?").length === 1);
  assert.ok(mentions(normalise("la hueste de los trillizos?"), "Hueste de los Trillizos"));
  assert.ok(!mentions(normalise("los trillizosos"), "trillizos"), "whole words only");
});

test("common words and titles never fire an entry on their own", () => {
  const { codex } = fresh();
  assert.deepEqual(ids(codex, "Es una gran idea, mi reina"), [], "'Gran Reina Khalida' does not fire on 'gran'");
  assert.deepEqual(ids(codex, "Defenderé mi imperio"), [], "'El Imperio' needs its whole name");
  assert.deepEqual(ids(codex, "La zarina de la corte"), [], "a title is not a name");
  assert.ok(ids(codex, "El Imperio nos traicionó").includes("realm:wh_main_emp_empire"));
});

test("the player's words come first, the budget is kept, and nobody is told who they are", () => {
  const { codex } = fresh();
  const chosen = codex.select("c1", ["Kostaltyn", "Glottkin y Khalida y el Gran Bastión y Hashut y Sigmar y Nurgle"], { budget: 700 });
  assert.equal(chosen[0].id, "realm:wh3_main_ksl_the_great_orthodoxy", "what the player named first");
  assert.ok(chosen.reduce((sum, entry) => sum + entry.text.length, 0) <= 700);
  assert.deepEqual(ids(codex, "Katarin y Vlad", { exclude: ["wh3_main_ksl_the_ice_court", "wh_main_vmp_schwartzhafen"] }), []);
  assert.equal(codex.block("c1", ["nada que ver"]), "", "nothing named, nothing paid");
  assert.ok(CODEX_BUDGET <= 2000);
});

test("letters and the court's adviser carry the codex block; it costs nothing when unused", () => {
  const { codex } = fresh();
  const block = codex.block("c1", ["la hueste de los trillizos ? , quienes son esos ?"], { exclude: ["wh3_main_ksl_the_ice_court"] });
  const request = { campaignId: "c1", sender: "wh_main_vmp_schwartzhafen", interlocutor: "wh3_main_ksl_the_ice_court", turn: 85, mode: "player",
    message: "la hueste de los trillizos ? , quienes son esos ?", identity: {}, playerIdentity: {}, state: "", fields: {} };
  const text = buildMessages(request, [], {}, "Spanish", null, null, block)[1].content;
  assert.match(text, /WHAT YOU KNOW OF THE NAMES MENTIONED[\s\S]*Hueste de los Trillizos, a realm of the Guerreros del Caos/);
  assert.ok(text.indexOf("WHAT YOU KNOW OF THE NAMES MENTIONED") < text.indexOf("WHAT YOU REMEMBER OF THIS RULER"));
  assert.doesNotMatch(buildMessages(request, [], {}, "Spanish")[1].content, /WHAT YOU KNOW OF THE NAMES/);
  const council = buildCouncilMessages({ facts: "Ruler: Vlad", talk: "", words: "¿quiénes son los de la hueste de los trillizos?", people: "" }, "Spanish", {}, block);
  assert.match(council[1].content, /WHAT YOU KNOW OF THE NAMES MENTIONED[\s\S]*YOUR RULER NOW SAYS/);
});

test("the companion reads the CODEX line and uses the codex for letters and the court", () => {
  const companion = fs.readFileSync(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.match(companion, /codexLine = parseCodexLine\(line\)/);
  assert.match(companion, /codex\.store\(codexLine\)/);
  assert.match(companion, /callLlm\(config, request, history, profile, betrayal, digest, codexText\)/);
  assert.match(companion, /exclude: \[request\.interlocutor, request\.sender\]/);
  assert.match(companion, /buildCouncilMessages\(council, language, lore, known\)/);
});

test("the codex tells who someone is, not their whole life: one short line each, four entries at most", async () => {
  const { firstSentence, CODEX_MAX_ENTRIES } = await import("../src/codex.js");
  const { codex } = fresh();
  const [realm, people] = codex.select("c1", ["la hueste de los trillizos ? , quienes son esos ?"]);
  assert.ok(realm.text.length < 380, realm.text);
  assert.doesNotMatch(realm.text, /Nordland/, "only the first line of the ruler's lore");
  assert.doesNotMatch(people.text, /Archaon/, "only the first sentence of the people");
  const many = codex.select("c1", ["Glottkin, Kostaltyn, Khalida, Karl Franz, Hashut, Sigmar, Nurgle y Praag"]);
  assert.ok(many.length <= CODEX_MAX_ENTRIES);
  assert.ok(many.reduce((sum, entry) => sum + entry.text.length, 0) <= CODEX_BUDGET);
  assert.equal(firstSentence("One. Two."), "One.");
  assert.ok(firstSentence("word ".repeat(80)).length <= 171);
});

test("a relation reason written in the player's language does not cost the letter", async () => {
  const { parseDiplomacyResponse } = await import("../src/tag-parser.js");
  assert.equal(parseDiplomacyResponse("Hola. [diplo:reject] [relation:delta=1;reason=credibilidad]").reaction.reason, "credibility");
  assert.equal(parseDiplomacyResponse("Hola. [diplo:reject] [relation:delta=1;reason=empatía]").reaction.reason, "empathy");
  assert.equal(parseDiplomacyResponse("Hola. [diplo:reject] [relation:delta=-1;reason=whatever]").reaction.reason, "insult");
  assert.equal(parseDiplomacyResponse("Hola. [diplo:reject] [relation:delta=0;reason=xyz]").reaction.reason, "neutral");
});

test("the court advises on wars but never asks for military orders: the player moves the armies", async () => {
  const { buildBriefingMessages, buildCouncilMessages } = await import("../src/court-briefing.js");
  const brief = buildBriefingMessages({ facts: "Ruler: Vlad", people: "" }, "Spanish")[0].content;
  assert.match(brief, /never ask for orders about them or imply that you will carry them out/);
  assert.match(brief, /brief question about diplomacy/);
  assert.doesNotMatch(brief, /question asking for orders/);
  const council = buildCouncilMessages({ facts: "Ruler: Vlad", talk: "", words: "hola", people: "" }, "Spanish")[0].content;
  assert.match(council, /never ask for military orders or offer to carry them out/);
});
