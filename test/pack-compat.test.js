import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { checkInstalledPack } from "../src/pack-compat.js";

test("any installed copy of the mod is accepted; only a missing mod stops the companion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-pack-"));
  try {
    const pack = path.join(root, "data", "llm_diplomacy.pack");
    const workshopRoot = path.join(root, "workshop");
    const workshopPack = path.join(workshopRoot, "3802515040", "llm_diplomacy.pack");
    const check = () => checkInstalledPack(root, workshopRoot);
    assert.equal(check().ok, false);
    assert.match(check().reason, /Subscribe on Steam/);
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    fs.writeFileSync(pack, "any version of the pack");
    assert.equal(check().ok, true, "a Steam update never makes the companion refuse to start");
    fs.rmSync(pack);
    fs.mkdirSync(path.dirname(workshopPack), { recursive: true });
    fs.writeFileSync(workshopPack, "workshop pack");
    assert.equal(check().ok, true, "Workshop-only installation works without a manual pack");
    assert.equal(check().warning, "");
    fs.writeFileSync(pack, "a different manual copy");
    assert.match(check().warning, /Two different copies/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the executable checks that the mod is installed before anything else", () => {
  const build = fs.readFileSync(new URL("../scripts/build-companion-exe.js", import.meta.url), "utf8");
  const companion = fs.readFileSync(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.match(build, /define: companionDefines\(\)/);
  assert.match(fs.readFileSync(new URL("../scripts/build-bundle.js", import.meta.url), "utf8"), /__LLMDIP_PACKAGED__: "true"/);
  assert.doesNotMatch(build, /__LLMDIP_EXPECTED_PACK_SHA256__/);
  assert.ok(companion.indexOf("checkInstalledPack(config.wh3Root") < companion.indexOf("new MemoryStore(config.dataDir)"));
  assert.match(companion, /process\.argv\.includes\("--verify-install"\)/);
});

test("release builder never erases the shared release archive", () => {
  const source = fs.readFileSync(new URL("../scripts/build-release.js", import.meta.url), "utf8");
  assert.match(source, /path\.join\(ROOT, "release", version\)/);
  assert.match(source, /if \(fs\.existsSync\(RELEASE\)\) throw/);
  assert.doesNotMatch(source, /rmSync\(RELEASE/);
});

test("the readable Node launcher accepts any installed copy and keeps memory in the fixed folder", () => {
  const launcher = fs.readFileSync(new URL("../scripts/start-workshop.js", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /EXPECTED_PACK_SHA256/);
  // The launcher must not pin memory to its own folder (comments may mention it).
  assert.doesNotMatch(launcher.replace(/\/\/.*$/gm, ''), /LLMDIP_DATA_DIR/);
});
