import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory-store.js";

test("standalone companion retains curated lord lore without external JSON files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-lore-"));
  try {
    const request = { campaignId: "test", interlocutor: "faction" };
    const identity = { leader: "Katarin", leaderSubtype: "lord", culture: "kislev" };
    const embeddedLore = {
      lord: { canonNotes: ["Lord-specific lore"], voiceNotes: ["Measured and resolute"], voiceGender: "female" },
      faction: { canonNotes: ["Faction fallback"] }
    };
    const store = new MemoryStore(root, { loreRoot: path.join(root, "absent"), embeddedLore });
    const profile = store.ensureProfile(request, identity);
    assert.deepEqual(profile.canonNotes, embeddedLore.lord.canonNotes);
    assert.deepEqual(profile.voiceNotes, embeddedLore.lord.voiceNotes);
    assert.equal(profile.voiceGender, "female");
    assert.deepEqual(store.ensureProfile(request, { ...identity, leaderSubtype: "successor" }).canonNotes, ["Faction fallback"]);
    embeddedLore.lord.canonNotes = ["Updated canonical lore"];
    assert.deepEqual(store.ensureProfile(request, identity).canonNotes, ["Updated canonical lore"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the executable build embeds JSON profiles and refuses an empty set", () => {
  const build = fs.readFileSync(new URL("../scripts/build-companion-exe.js", import.meta.url), "utf8");
  assert.match(build, /__LLMDIP_EMBEDDED_LORE__: JSON\.stringify\(embeddedLore\)/);
  assert.match(build, /if \(!Object\.keys\(embeddedLore\)\.length\) throw/);
});
