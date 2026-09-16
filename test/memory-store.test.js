import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory-store.js";

test("stores memory in campaign/faction/player folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-"));
  const store = new MemoryStore(root);
  const request = { requestId: "request_1", memoryParent: "root", memoryHead: "request_1", campaignId: "campaign_one", sender: "player_two", interlocutor: "empire", message: "Ayúdame", turn: 8, mode: "player" };
  store.ensureProfile(request, { leader: "Karl", leaderSubtype: "empire_lord", culture: "wh_main_emp_empire", subculture: "wh_main_sc_emp_empire" });
  store.append(request, "Acepto", { type: "offer_gold", amount: 1000 });
  assert.equal(store.history({ ...request, requestId: "request_2", memoryParent: "request_1", memoryHead: "request_2" }).length, 2);
  assert.ok(fs.existsSync(path.join(root, "campaigns", "campaign_one", "empire", "players", "player_two", "memory.json")));
  assert.ok(fs.existsSync(path.join(root, "campaigns", "campaign_one", "empire", "leaders", "empire_lord.json")));
  assert.ok(fs.existsSync(path.join(root, "campaigns", "campaign_one", "empire", "players", "player_two", "favor-ledger.json")));
  assert.equal(store.markExecution("request_1", true), true);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, "campaigns", "campaign_one", "empire", "players", "player_two", "favor-ledger.json"), "utf8"));
  assert.equal(ledger.entries[0].status, "executed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("restores the exact conversation branch stored by a loaded save", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-branch-"));
  const store = new MemoryStore(root);
  const base = { campaignId: "campaign_branch", sender: "player_one", interlocutor: "kislev", turn: 12, mode: "player" };

  const first = { ...base, requestId: "request_first", memoryParent: "root", memoryHead: "request_first", message: "Primer mensaje" };
  store.append(first, "Primera respuesta", { type: "reject" }, { delta: 0, reason: "neutral" });
  const future = { ...base, requestId: "request_future", memoryParent: "request_first", memoryHead: "request_future", message: "Mensaje del futuro" };
  store.append(future, "Respuesta futura", { type: "reject" }, { delta: 0, reason: "neutral" });

  const loadedOldSave = { ...base, requestId: "request_new_branch", memoryParent: "request_first", memoryHead: "request_new_branch", message: "Nueva rama" };
  assert.deepEqual(store.history(loadedOldSave).map(item => item.content), ["Primer mensaje", "Primera respuesta"]);
  store.append(loadedOldSave, "Respuesta de la nueva rama", { type: "reject" }, { delta: 0, reason: "neutral" });

  const continueNewBranch = { ...base, requestId: "request_after_branch", memoryParent: "request_new_branch", memoryHead: "request_after_branch", message: "Continuar" };
  assert.deepEqual(store.history(continueNewBranch).map(item => item.content), [
    "Primer mensaje", "Primera respuesta", "Nueva rama", "Respuesta de la nueva rama"
  ]);
  const reloadFutureSave = { ...base, requestId: "request_after_future", memoryParent: "request_future", memoryHead: "request_after_future", message: "Volver al save futuro" };
  assert.deepEqual(store.history(reloadFutureSave).map(item => item.content), [
    "Primer mensaje", "Primera respuesta", "Mensaje del futuro", "Respuesta futura"
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
