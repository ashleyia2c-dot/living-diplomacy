import test from "node:test";
import assert from "node:assert/strict";
import { cessionReason, cedableRegions, regionCessionAllowed, goldCap, dealLimitsBlock, dealViolation } from "../src/deal-limits.js";
import { buildMessages, toneReminder } from "../src/llm-client.js";
import { powerStance } from "../src/personality.js";

// Turn 4, Karl Franz asking Karaz-a-Karak for a hold: roughly matched, friendly, at peace.
const dwarfs = {
  relative_power_ratio: "1.10", war: "0", direct_war_now: "0",
  ai_culture: "wh_main_dwf_dwarfs", ai_subculture: "wh_main_sc_dwf_dwarfs",
  ai_regions: "wh3_main_combi_region_karaz_a_karak:wh3_main_combi_region_pillars_of_grungni:wh3_main_combi_region_karak_hirn",
  ai_capital: "wh3_main_combi_region_karaz_a_karak",
  ai_key_regions: "wh3_main_combi_region_karaz_a_karak",
  ai_settlements: "3", ai_treasury: "8000"
};

test("a ruler that is not losing or far weaker cedes no land", () => {
  assert.equal(cessionReason(dwarfs), null);
  assert.deepEqual(cedableRegions(dwarfs), []);
  assert.equal(regionCessionAllowed(dwarfs, "wh3_main_combi_region_pillars_of_grungni"), false);
  assert.match(dealViolation({ type: "transfer_region", region: "wh3_main_combi_region_pillars_of_grungni", recipient: "player" }, dwarfs), /neither losing a war nor far weaker/);
});

test("dwarfs part with a hold only when the war is lost", () => {
  assert.equal(cessionReason({ ...dwarfs, relative_power_ratio: "4" }), null);
  assert.equal(cessionReason({ ...dwarfs, relative_power_ratio: "2", war: "1" }), null);
  assert.equal(cessionReason({ ...dwarfs, relative_power_ratio: "3.5", war: "1" }), "losing_war");
});

test("a far weaker or beaten ruler may cede minor regions, never its capitals", () => {
  const empire = { ...dwarfs, ai_culture: "wh_main_emp_empire", ai_subculture: "wh_main_sc_emp_empire",
    ai_key_regions: "wh3_main_combi_region_karaz_a_karak:wh3_main_combi_region_karak_hirn" };
  const beaten = { ...empire, relative_power_ratio: "1.8", war: "1" };
  assert.equal(cessionReason(beaten), "losing_war");
  assert.deepEqual(cedableRegions(beaten), ["wh3_main_combi_region_pillars_of_grungni"]);
  assert.equal(regionCessionAllowed(beaten, "wh3_main_combi_region_karaz_a_karak"), false);
  assert.match(dealViolation({ type: "transfer_region", region: "wh3_main_combi_region_karak_hirn", recipient: "player" }, beaten), /capital/);
  assert.equal(dealViolation({ type: "transfer_region", region: "wh3_main_combi_region_pillars_of_grungni", recipient: "player" }, beaten), null);
  assert.equal(cessionReason({ ...empire, relative_power_ratio: "3.2" }), "far_weaker");
  assert.equal(cessionReason({ ...empire, relative_power_ratio: "5", ai_settlements: "1" }), null, "never the last region");
});

test("land given to the ruler is never limited", () => {
  assert.equal(dealViolation({ type: "transfer_region", region: "wh3_main_combi_region_altdorf", recipient: "interlocutor" }, dwarfs), null);
});

test("gold gifts are a small share of the treasury, more when buying peace", () => {
  assert.equal(goldCap(dwarfs, "offer_gold"), 800);
  assert.equal(goldCap(dwarfs, "favor"), 2000);
  assert.equal(goldCap({ ...dwarfs, relative_power_ratio: "2", war: "1" }, "offer_gold"), 2800);
  assert.equal(goldCap({ ...dwarfs, ai_treasury: "500" }, "offer_gold"), 0);
  assert.equal(goldCap({ ...dwarfs, ai_treasury: "900000" }, "offer_gold"), 20000);
  assert.equal(dealViolation({ type: "offer_gold", amount: 800 }, dwarfs), null);
  assert.match(dealViolation({ type: "offer_gold", amount: 5000 }, dwarfs), /more than the 800/);
  assert.match(dealViolation({ type: "favor", favor: "defend", amount: 3000 }, dwarfs), /more than the 2000/);
  assert.equal(dealViolation({ type: "request_gold", amount: 20000 }, dwarfs), null, "what the player pays is the player's choice");
});

test("the prompt says what the ruler is willing to give", () => {
  assert.match(dealLimitsBlock(dwarfs), /you cede none of your regions now/);
  assert.match(dealLimitsBlock(dwarfs), /at most 800 in a single offer_gold/);
  const beaten = { ...dwarfs, ai_culture: "wh_main_emp_empire", ai_subculture: "", relative_power_ratio: "1.8", war: "1" };
  assert.match(dealLimitsBlock(beaten), /Only these regions of yours could be ceded: wh3_main_combi_region_pillars_of_grungni, wh3_main_combi_region_karak_hirn/);
});

const request = (fields, extra = {}) => ({
  campaignId: "c", sender: "wh_main_emp_empire", interlocutor: "wh_dlc03_bst_beastmen", mode: "player", turn: 4,
  message: "Let us make peace.", fields, state: Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(","),
  identity: { culture: "wh_dlc03_bst_beastmen", subculture: "wh_dlc03_sc_bst_beastmen", leader: "Khazrak" }, ...extra
});

test("peoples that court no one keep their voice when a deal suits them", () => {
  const stance = powerStance("wh_dlc03_bst_beastmen wh_dlc03_sc_bst_beastmen");
  assert.match(toneReminder({ relative_power_ratio: "1" }, stance), /never makes you kind, grateful or courteous/);
  assert.equal(toneReminder({ relative_power_ratio: "4" }, stance), "", "the far-weaker reminder already says it");
  assert.equal(toneReminder({ relative_power_ratio: "1" }, powerStance("wh_main_emp_empire")), "");
  const fields = { relative_power_ratio: "1", ai_treasury: "3000", ai_regions: "a:b", ai_key_regions: "a", ai_capital: "a" };
  const prompt = buildMessages(request(fields), [], {}, "English")[1].content;
  assert.match(prompt, /YOUR VOICE: your culture sets your tone/);
  assert.match(prompt, /WHAT YOU ARE WILLING TO GIVE/);
  assert.doesNotMatch(prompt, /ai_key_regions=|ai_capital=/, "the raw keys stay out of the dossier");
});

test("a second draft is told why the first could not stand", () => {
  const fields = { relative_power_ratio: "1", ai_treasury: "3000" };
  const prompt = buildMessages(request(fields, { dealCorrection: "you offered gold your treasury cannot spare" }), [], {}, "English")[1].content;
  assert.match(prompt, /YOUR FIRST DRAFT COULD NOT STAND: you offered gold your treasury cannot spare\./);
  assert.ok(prompt.trimEnd().endsWith("keep the words and the tag consistent."));
  assert.doesNotMatch(buildMessages(request(fields), [], {}, "English")[1].content, /FIRST DRAFT/);
});

test("gold is no longer suggested as a greeting", () => {
  const system = buildMessages(request({ relative_power_ratio: "1" }), [], {}, "English")[0].content;
  assert.doesNotMatch(system, /welcome may offer a small amount of gold/);
  assert.match(system, /Gold is never a greeting gift/);
});

test("the player can give gold and regions, and a reject never claims a deal", () => {
  const system = buildMessages(request({ relative_power_ratio: "1" }), [], {}, "English")[0].content;
  assert.match(system, /when the player offers you gold .* attach \[diplo:request_gold:amount=N\]/);
  assert.match(system, /offers you one of their regions .*;recipient=interlocutor]/);
  assert.match(system, /never say you accept a gift, a region or a deal, or that something was carried out, while attaching \[diplo:reject\]/);
});
