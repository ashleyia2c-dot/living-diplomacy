import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function setup() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-steam-bat-"));
  const folder = path.join(temp, "Fresh extracted folder");
  fs.mkdirSync(path.join(folder, "scripts"), { recursive: true });
  fs.cpSync(path.join(project, "src"), path.join(folder, "src"), { recursive: true });
  fs.copyFileSync(path.join(project, "START_PLAYER2.bat"), path.join(folder, "START_PLAYER2.bat"));
  fs.copyFileSync(path.join(project, "scripts", "start-workshop.js"), path.join(folder, "scripts", "start-workshop.js"));
  fs.writeFileSync(path.join(folder, "package.json"), '{"type":"module"}');
  const game = path.join(temp, "Steam Library", "steamapps", "common", "Total War WARHAMMER III");
  const pack = path.join(temp, "Steam Library", "steamapps", "workshop", "content", "1142710", "3802515040", "llm_diplomacy.pack");
  fs.mkdirSync(game, { recursive: true });
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.copyFileSync(path.join(project, "dist", "llm_diplomacy.pack"), pack);
  fs.writeFileSync(path.join(folder, ".env"), `WH3_ROOT=${game}\n`);
  const env = { ...process.env, APPDATA: temp };
  delete env.WH3_ROOT;
  delete env.STEAM_WORKSHOP_ROOT;
  delete env.LLMDIP_PROVIDER;
  return { temp, folder, game, pack, env };
}

test("fresh BAT download works with Workshop-only pack, spaces and no npm install", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(project, "dist", "llm_diplomacy.pack"))
}, () => {
  const fixture = setup();
  try {
    const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", `call "${path.join(fixture.folder, "START_PLAYER2.bat")}" --check`], {
      cwd: fixture.temp, env: fixture.env, encoding: "utf8", timeout: 15000, windowsHide: true,
      windowsVerbatimArguments: true
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(fixture.pack), result.stdout);
    assert.equal(fs.existsSync(path.join(fixture.folder, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(fixture.folder, "data")), false, "check must not start the companion");
    assert.equal(fs.existsSync(path.join(fixture.game, "data", "llm_diplomacy.pack")), false, "Workshop does not need a manual pack");
  } finally {
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("BAT reports missing Node clearly and returns a nonzero check without hanging", {
  skip: process.platform !== "win32" || !fs.existsSync(path.join(project, "dist", "llm_diplomacy.pack"))
}, () => {
  const fixture = setup();
  try {
    for (const key of Object.keys(fixture.env)) if (key.toLowerCase() === "path") delete fixture.env[key];
    fixture.env.PATH = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", `call "${path.join(fixture.folder, "START_PLAYER2.bat")}" --check`], {
      cwd: fixture.temp, env: fixture.env, encoding: "utf8", timeout: 15000, windowsHide: true,
      windowsVerbatimArguments: true
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Node\.js is not installed/);
    assert.match(result.stdout, /nodejs\.org/);
  } finally {
    fs.rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("Steam consumer package is source-only and its guide distinguishes one-time setup from each session", () => {
  const builder = fs.readFileSync(path.join(project, "scripts", "build-steam-bat.js"), "utf8");
  assert.doesNotMatch(builder, /copyFileSync[^\n]*(?:\.exe|\.pack)/i);
  assert.match(builder, /\["src", "lore-profiles"\]/);
  const guide = fs.readFileSync(path.join(project, "README_STEAM_BAT_0.42.2.txt"), "utf8");
  for (const text of ["SUBSCRIBE INSTALLS THE GAME MOD, NOT THE AI COMPANION", "ONE-TIME SETUP", "EVERY TIME YOU PLAY", "START_PLAYER2.bat", "Node.js", "Leave that window open"]) {
    assert.ok(guide.includes(text), text);
  }
});
