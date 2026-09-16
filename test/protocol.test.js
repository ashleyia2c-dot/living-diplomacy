import test from "node:test";
import assert from "node:assert/strict";
import { parseBridgeRequest, validateAction, compactAction } from "../src/protocol.js";
import { parseDiplomacyResponse } from "../src/tag-parser.js";
import { renderInbox } from "../src/lua-renderer.js";

test("parses a bridge request", () => {
  const line = "prefix [LLMDIP] REQUEST|req_1|campaign_7|wh3_main_ksl_ice_court|wh_main_emp_empire|proactive|turn%3D7%2Cmemory_parent%3Droot%2Cmemory_head%3Dreq_1%2Cwar%3D0%2Cai_leader%3DKarl_Franz%2Cai_leader_rank%3D18%2Cai_leader_traits%3Dbrave%3Apolitician%2Cai_vanilla_personality%3DProtector%3AHonourable%2Cplayer_leader%3DKatarin%2Cplayer_leader_subtype%3Dwh3_main_ksl_katarin%2Cplayer_strength_rank%3D3|Hola%20Karl";
  const request = parseBridgeRequest(line);
  assert.equal(request.requestId, "req_1");
  assert.equal(request.mode, "proactive");
  assert.equal(request.turn, 7);
  assert.equal(request.identity.leader, "Karl_Franz");
  assert.equal(request.identity.leaderRank, 18);
  assert.deepEqual(request.identity.traits, ["brave", "politician"]);
  assert.deepEqual(request.identity.vanillaPersonality, ["Protector", "Honourable"]);
  assert.equal(request.playerIdentity.leader, "Katarin");
  assert.equal(request.memoryParent, "root");
  assert.equal(request.memoryHead, "req_1");
  assert.equal(request.message, "Hola Karl");
});

test("requires exactly one diplomacy tag", () => {
  assert.throws(() => parseDiplomacyResponse("No. [diplo:reject] [diplo:declare_war]"));
});

test("parses a region transfer", () => {
  const result = parseDiplomacyResponse("Acepto la entrega. [diplo:transfer_region:region=wh3_main_combi_region_altdorf;recipient=player]");
  assert.equal(result.narrative, "Acepto la entrega.");
  assert.deepEqual(result.action, { type: "transfer_region", region: "wh3_main_combi_region_altdorf", recipient: "player" });
});

test("rejects arbitrary keys and Lua injection", () => {
  assert.throws(() => validateAction({ type: "transfer_region", region: 'x\"); os.execute("bad")', recipient: "player" }));
});

test("renders only a whitelisted bridge call", () => {
  const lua = renderInbox({
    requestId: "req_9",
    narrative: 'Dijo "sí".\nBien.',
    action: { type: "alliance", level: "defensive" },
    reaction: { delta: 1, reason: "respect" }
  });
  assert.match(lua, /llmdip_publish_response/);
  assert.match(lua, /alliance,defensive/);
  assert.match(lua, /, 1, "respect"\)/);
  assert.doesNotMatch(lua, /cm:force_alliance/);
});

test("compacts vassal direction", () => {
  assert.equal(compactAction({ type: "vassalize", master: "interlocutor" }), "vassalize,interlocutor");
});

test("validates gold and favors", () => {
  assert.equal(compactAction({ type: "offer_gold", amount: 2500 }), "offer_gold,2500");
  assert.equal(compactAction({ type: "favor", favor: "join_war", amount: 4000, target: "wh3_main_ogr_goldtooth" }), "favor,join_war,4000,wh3_main_ogr_goldtooth");
  assert.throws(() => validateAction({ type: "offer_gold", amount: 999999 }));
});

test("parses a bounded relationship reaction", () => {
  const result = parseDiplomacyResponse("Tus palabras honran esta corte. [diplo:reject] [relation:delta=1;reason=respect]");
  assert.equal(result.narrative, "Tus palabras honran esta corte.");
  assert.deepEqual(result.reaction, { delta: 1, reason: "respect" });
  assert.throws(() => parseDiplomacyResponse("No. [diplo:reject] [relation:delta=6;reason=respect]"));
});
