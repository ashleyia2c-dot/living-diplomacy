import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPersonality, personalityBrief } from "../src/personality.js";
import { MemoryStore } from "../src/memory-store.js";

test("generated lord personalities are stable and distinct", () => {
  const identity = { leaderSubtype: "wh3_main_ogr_tyrant", culture: "wh3_main_ogr_ogre_kingdoms" };
  const first = buildPersonality(identity, "wh3_main_ogr_goldtooth");
  const again = buildPersonality(identity, "wh3_main_ogr_goldtooth");
  const other = buildPersonality({ ...identity, leaderSubtype: "wh3_main_ogr_slaughtermaster" }, "wh3_main_ogr_goldtooth");
  assert.deepEqual(first, again);
  assert.notDeepEqual(first.axes, other.axes);
  assert.match(first.archetype, /Ogre warlord/);
});

test("personality brief combines stable temperament with live vanilla traits", () => {
  const profile = { personality: buildPersonality({ leaderSubtype: "lord" }, "faction") };
  const brief = personalityBrief(profile, { vanillaPersonality: ["Agresivo", "Codicioso"], traits: ["trait_one"] });
  assert.match(brief, /Agresivo, Codicioso/);
  assert.match(brief, /trait_one/);
});

test("existing leader profiles migrate without losing authored lore", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-profile-"));
  const store = new MemoryStore(root);
  const request = { campaignId: "campaign", interlocutor: "faction", sender: "player" };
  const dir = path.join(root, "campaigns", "campaign", "faction", "leaders");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lord.json"), JSON.stringify({ canonNotes: ["authored"], leader: "Old" }));
  const profile = store.ensureProfile(request, { leader: "Current Lord", leaderSubtype: "lord", culture: "culture", subculture: "subculture" });
  assert.equal(profile.leader, "Current Lord");
  assert.deepEqual(profile.canonNotes, ["authored"]);
  assert.ok(profile.personality?.axes);
  fs.rmSync(root, { recursive: true, force: true });
});
