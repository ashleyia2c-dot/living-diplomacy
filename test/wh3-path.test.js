// El companion se publica a desconocidos: la ruta del juego no puede darse por sentada.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectWh3Root, wh3RootLooksValid } from "../src/config.js";

test("WH3_ROOT manda sobre la autodeteccion", () => {
  const previous = process.env.WH3_ROOT;
  process.env.WH3_ROOT = "D:/otro/disco/Total War WARHAMMER III";
  try { assert.equal(detectWh3Root(), "D:/otro/disco/Total War WARHAMMER III"); }
  finally { if (previous === undefined) delete process.env.WH3_ROOT; else process.env.WH3_ROOT = previous; }
});

test("una carpeta sin Warhammer3.exe no se acepta como instalacion", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wh3-fake-"));
  try {
    assert.equal(wh3RootLooksValid(empty), false);
    fs.writeFileSync(path.join(empty, "Warhammer3.exe"), "");
    assert.equal(wh3RootLooksValid(empty), true);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("la autodeteccion nunca devuelve vacio", () => {
  const previous = process.env.WH3_ROOT;
  delete process.env.WH3_ROOT;
  try { assert.ok(detectWh3Root().length > 0); }
  finally { if (previous !== undefined) process.env.WH3_ROOT = previous; }
});
