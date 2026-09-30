import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { checkInstalledPack } from "../src/pack-compat.js";

test("the packaged companion rejects missing, invalid and mismatched Workshop packs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-pack-"));
  try {
    const pack = path.join(root, "data", "llm_diplomacy.pack");
    const workshopRoot = path.join(root, "workshop");
    const workshopPack = path.join(workshopRoot, "3802515040", "llm_diplomacy.pack");
    const check = () => checkInstalledPack(root, expected, workshopRoot);
    const expected = crypto.createHash("sha256").update("matching-pack").digest("hex");
    assert.equal(check().ok, false);
    assert.match(check().reason, /Subscribe on Steam/);
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    fs.writeFileSync(pack, "old-pack");
    assert.equal(check().ok, false);
    assert.match(check().reason, /matching companion version/);
    fs.writeFileSync(pack, "matching-pack");
    assert.equal(check().ok, true);
    fs.rmSync(pack);
    fs.mkdirSync(path.dirname(workshopPack), { recursive: true });
    fs.writeFileSync(workshopPack, "matching-pack");
    assert.equal(check().ok, true, "Workshop-only installation works without a manual pack");
    fs.writeFileSync(pack, "old-pack");
    assert.match(check().warning, /Another, different copy/);
    assert.equal(checkInstalledPack(root, "invalid", workshopRoot).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the executable embeds its matching pack hash and checks before launching", () => {
  const build = fs.readFileSync(new URL("../scripts/build-companion-exe.js", import.meta.url), "utf8");
  const companion = fs.readFileSync(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.match(build, /__LLMDIP_EXPECTED_PACK_SHA256__: JSON\.stringify\(expectedPackSha256\)/);
  assert.ok(companion.indexOf("checkInstalledPack(config.wh3Root") < companion.indexOf("new MemoryStore(config.dataDir)"));
  assert.match(companion, /process\.argv\.includes\("--verify-install"\)/);
});

test("release builder never erases the shared release archive", () => {
  const source = fs.readFileSync(new URL("../scripts/build-release.js", import.meta.url), "utf8");
  assert.match(source, /path\.join\(ROOT, "release", version\)/);
  assert.match(source, /if \(fs\.existsSync\(RELEASE\)\) throw/);
  assert.doesNotMatch(source, /rmSync\(RELEASE/);
});

test("the readable Node launcher expects this exact built pack", () => {
  const launcher = fs.readFileSync(new URL("../scripts/start-workshop.js", import.meta.url), "utf8");
  assert.match(launcher, /EXPECTED_PACK_SHA256 = "[A-F0-9]{64}"/);
  // Source-only downloads deliberately omit compiled packs. The paired-pack
  // check is additional validation in the author's release workspace.
  const packUrl = new URL("../dist/llm_diplomacy.pack", import.meta.url);
  if (!fs.existsSync(packUrl)) return;
  const pack = fs.readFileSync(packUrl);
  const expected = crypto.createHash("sha256").update(pack).digest("hex").toUpperCase();
  assert.match(launcher, new RegExp(`EXPECTED_PACK_SHA256 = "${expected}"`));
});
