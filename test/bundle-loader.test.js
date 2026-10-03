// The companion inside the mod (src/bundle-loader.js, src/launcher.js): a Steam update of
// the mod updates the companion, and a missing or broken copy never stops it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { wrapBundle, findBundle, chooseBundle, compareVersions, LOADER_API } from "../src/bundle-loader.js";

const pack = (...parts) => Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8")));
const binary = Buffer.from([0x50, 0x46, 0x48, 0x35, 0, 1, 2, 3, 255, 254]);

test("the bundle is found inside a pack and checked against its own hash", () => {
  const code = "console.log('Ñandú, 你好');\n".repeat(50);
  const found = findBundle(pack(binary, "-- lua --", wrapBundle(code, "0.43.0"), binary));
  assert.equal(found.version, "0.43.0");
  assert.equal(found.api, LOADER_API);
  assert.equal(found.code, code, "multi-byte text survives");
  const broken = pack(binary, wrapBundle(code, "0.43.0").replace("Ñandú", "Nandu"));
  assert.equal(findBundle(broken), null, "a changed byte is rejected");
  assert.equal(findBundle(pack(binary, "/*LLMDIP-COMPANION-BUNDLE not json*/\n")), null);
  assert.equal(findBundle(binary), null, "an old pack without a bundle");
});

test("the newest usable copy wins, and only when it is newer than the launcher's own", () => {
  const packs = { a: pack(binary, wrapBundle("a", "0.43.0")), b: pack(binary, wrapBundle("b", "0.44.2")), old: binary };
  const read = file => packs[file];
  assert.equal(chooseBundle(["a", "b", "old"], "0.43.0", { read }).bundle.version, "0.44.2");
  assert.equal(chooseBundle(["a", "b"], "0.44.2", { read }).bundle, null, "the launcher is already as new");
  assert.equal(chooseBundle(["old"], "0.0.0", { read }).bundle, null, "no bundle, built-in companion");
  assert.equal(chooseBundle(["missing"], "0.0.0", { read: () => { throw new Error("ENOENT"); } }).bundle, null);
  const future = pack(binary, wrapBundle("x", "0.50.0").replace(`"api":${LOADER_API}`, `"api":${LOADER_API + 1}`));
  const choice = chooseBundle(["f"], "0.43.0", { read: () => future });
  assert.equal(choice.bundle, null, "a bundle for a newer launcher is not run");
  assert.match(choice.skipped, /needs a newer launcher/);
  assert.ok(compareVersions("0.43.10", "0.43.9") > 0);
  assert.ok(compareVersions("0.43.1-private", "0.43.0") > 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("the .exe starts through the launcher, and every pack carries its release's companion", () => {
  const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const exe = read("scripts/build-companion-exe.js");
  assert.match(exe, /entryPoints: \[path\.join\(ROOT, "src", "launcher\.js"\)\]/);
  assert.match(exe, /define: companionDefines\(\)/);
  const builder = read("scripts/build-pack.js");
  assert.match(builder, /const bundle = await buildCompanionBundle\(\)/);
  assert.match(builder, /\{ File: "living_diplomacy\/companion_bundle\.js" \}/);
  assert.match(builder, /change_compression_format.*"None"/, "uncompressed, so the launcher can read it");
  const launcher = read("src/launcher.js");
  assert.match(launcher, /if \(!startFromMod\(\)\) import\("\.\/companion\.js"\)/);
  assert.match(read("scripts/start-workshop.js"), /chooseBundle\(result\.found\.map/);
  assert.doesNotMatch(read("src/companion.js"), /bundle-loader/, "the bundle never contains the loader's markers");
});
