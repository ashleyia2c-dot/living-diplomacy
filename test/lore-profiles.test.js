import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory-store.js";
import { personalityBrief } from "../src/personality.js";

const dir = path.resolve("lore-profiles");
const files = fs.readdirSync(dir).filter(name => name.endsWith(".json") && !name.startsWith("_"));

test("every legendary lord profile is complete and within range", () => {
  assert.ok(files.length >= 118, `only ${files.length} profiles`);
  for (const name of files) {
    const profile = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    assert.match(name, /^[a-z0-9_]+\.json$/, name);
    assert.ok(profile.canonNotes.length >= 2 && profile.canonNotes.every(note => typeof note === "string" && note.length > 20 && note.length < 400), name);
    assert.ok(profile.voiceNotes.length >= 2, name);
    assert.deepEqual(Object.keys(profile.temperament), ["aggression", "caution", "pride", "greed", "honour"], name);
    assert.deepEqual(Object.keys(profile.socialStyle), ["warmth", "sociability", "generosity", "vanity", "spite", "opportunism"], name);
    for (const value of [...Object.values(profile.temperament), ...Object.values(profile.socialStyle)]) assert.ok(value >= 0 && value <= 100, name);
    assert.ok(["male", "female", "other"].includes(profile.voiceGender), name);
  }
  // The newest DLC's lords are covered too.
  for (const lord of ["wh3_dlc29_nag_nagash", "wh3_dlc29_vmp_neferata", "wh3_dlc29_skv_thanquol", "wh3_dlc29_chs_glottkin"]) {
    assert.ok(files.includes(`${lord}.json`), lord);
  }
});

test("curated lore and personality reach a lord first met before the profile existed", () => {
  // 25-09: Miao Ying's saved copy had empty lore and a random pride of 53; the saved
  // copy used to win over any curated profile forever.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-lore-"));
  try {
    const store = new MemoryStore(root);
    const request = { campaignId: "c1", sender: "player", interlocutor: "wh3_main_cth_the_northern_provinces", requestId: "r1", turn: 1, mode: "player" };
    const identity = { leader: "Miao Ying", leaderSubtype: "wh3_main_cth_miao_ying", culture: "wh3_main_cth_cathay", subculture: "wh3_main_sc_cth_cathay" };
    const saved = path.join(root, "campaigns", "c1", request.interlocutor, "leaders", "wh3_main_cth_miao_ying.json");
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, JSON.stringify({ canonNotes: [], voiceNotes: [], personality: { axes: { aggression: 47, caution: 80, pride: 53, greed: 35, honour: 50 }, temperament: "old" } }));
    const profile = store.ensureProfile(request, identity);
    assert.match(profile.canonNotes.join(" "), /Great Bastion/);
    assert.equal(profile.personality.axes.pride, 85);
    assert.match(profile.personality.temperament, /pride 85\/100/);
    assert.equal(profile.socialStyle.vanity, 75);
    assert.equal(profile.voiceGender, "female");
    assert.match(personalityBrief(profile, identity), /pride 85\/100[\s\S]*vanity 75\/100/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("a lord's own profile wins over a faction file, so a successor does not inherit it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-lore-"));
  try {
    const store = new MemoryStore(root);
    const request = { campaignId: "c1", sender: "player", interlocutor: "wh_main_emp_empire", requestId: "r1", turn: 1, mode: "player" };
    const karl = store.ensureProfile(request, { leader: "Karl Franz", leaderSubtype: "wh_main_emp_karl_franz" });
    assert.match(karl.canonNotes.join(" "), /Ghal Maraz/);
    const successor = store.ensureProfile(request, { leader: "Some Elector", leaderSubtype: "wh_main_emp_lord" });
    assert.doesNotMatch(successor.canonNotes.join(" "), /Ghal Maraz/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
