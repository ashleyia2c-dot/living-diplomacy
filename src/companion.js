import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { getConfig, uiLanguageCode, wh3RootLooksValid } from "./config.js";
import { callLlm, callMessages, languageForRequest, pairEvents, pairEventsText } from "./llm-client.js";
import { parseBriefingRequest, buildBriefingMessages, cleanBriefing, parseCouncilRequest, buildCouncilMessages } from "./court-briefing.js";
import { BetrayalStore, betrayalOpportunity, enforceBetrayal, BETRAYAL_LETTER_REQUEST } from "./betrayal.js";
import { MemoryStore } from "./memory-store.js";
import { buildDigestMessages, cleanDigest, shortName } from "./memory-digest.js";
import { Codex, parseCodexLine } from "./codex.js";
import { parseCourtsRequest, buildCourtsMessages, extractJson, validateCourts, renderCourtsInbox, renderCourtsFailed, courtGroups, COURTS_MAX_TOKENS, COURTS_TIMEOUT_MS } from "./court-council.js";
import { parseBridgeRequest, COMPANION_PROTOCOL, protocolAdvice } from "./protocol.js";
import { parseDiplomacyResponse } from "./tag-parser.js";
import { dealViolation } from "./deal-limits.js";
import { renderInbox, luaString } from "./lua-renderer.js";
import { connectPlayer2, player2Heartbeat, player2Speak } from "./player2-client.js";
import { checkInstalledPack } from "./pack-compat.js";
import { migrateLegacyData } from "./data-migration.js";

const config = getConfig();

// The executable checks that the mod is installed before it starts. It no longer
// demands one exact pack: compatibility is the protocol number (src/protocol.js),
// checked against the game's own PROTOCOL line once a campaign is running, so a
// Steam update that keeps the protocol needs no new companion.
const PACKAGED = typeof __LLMDIP_PACKAGED__ !== "undefined";
if (PACKAGED || process.argv.includes("--verify-install")) {
  const installed = checkInstalledPack(config.wh3Root);
  if (!installed.ok) {
    console.error(installed.reason);
    for (const candidate of installed.candidates) console.error(`Checked pack path: ${candidate}`);
    // A double-clicked window would vanish together with the explanation.
    if (process.stdin.isTTY) { try { execFileSync("cmd", ["/c", "pause"], { stdio: "inherit" }); } catch {} }
    process.exit(1);
  }
  console.log(`Living Diplomacy mod found: ${installed.pack}`);
  if (installed.warning) console.warn(installed.warning);
  if (process.argv.includes("--verify-install")) process.exit(0);
}

// What leaders remember lives in one fixed folder per Windows user. A companion
// before 0.43 kept it next to itself: copy that once, missing files only.
const migratedFiles = migrateLegacyData(config.legacyDataDir, config.dataDir);
if (migratedFiles > 0) console.log(`Copied ${migratedFiles} conversation files to ${config.dataDir}`);
console.log(`Conversation memory: ${config.dataDir}`);

// Player2 asks for one health ping per minute to measure the mod's time spent.
const HEARTBEAT_MS = 60_000;
const memory = new MemoryStore(config.dataDir);
// The player's own versions of the lords (0.45): created on first start, never overwritten.
try { console.log(`Your own lords and instructions: ${memory.ensureCustomFolder()}`); }
catch (error) { console.warn(`The custom lords folder could not be created: ${error.message}`); }
const betrayals = new BetrayalStore(config.dataDir);
const codex = new Codex(config.dataDir, memory);
const handled = new Set();
let offset = 0;
let remainder = "";
let busy = false;
let activeLog = "";
let inboxQueue = Promise.resolve();
const deliveries = [];
const uiEvents = [];
let campaignInitSent = false;

function isWarhammerRunning() {
  // Explicit test isolation: do not let the user's unrelated real game affect a
  // mock bridge's lifecycle. Production launches never set this variable.
  if (process.env.LLMDIP_TEST_GAME_RUNNING === "0") return false;
  if (process.env.LLMDIP_TEST_GAME_RUNNING === "1") return true;
  try {
    return /Warhammer3\.exe/i.test(execFileSync("tasklist", ["/FI", "IMAGENAME eq Warhammer3.exe", "/NH"], {
      windowsHide: true, encoding: "utf8", timeout: 1500
    }));
  } catch { return false; }
}

// It is fine to start the companion before the game. Once WH3 has appeared,
// however, it must not survive an ended game as a hidden orphan process.
let warhammerWasRunning = isWarhammerRunning();
let gameRunning = warhammerWasRunning;
function stopAfterGameExit() {
  gameRunning = isWarhammerRunning();
  if (gameRunning) { warhammerWasRunning = true; return; }
  if (warhammerWasRunning) {
    console.log("Warhammer III closed; stopping Living Diplomacy Companion.");
    process.exit(0);
  }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  fs.renameSync(temp, file);
}

function enqueueInbox(content) {
  inboxQueue = inboxQueue.then(async () => {
    // The game does not consume responses during AI turns/battles. Keep a batch
    // until explicit model acknowledgements, rather than overwriting each letter.
    deliveries.push(content);
    atomicWrite(config.inboxFile, deliveries.join('\n'));
  });
  return inboxQueue;
}

function newestScriptLog() {
  if (config.scriptLog) return config.scriptLog;
  let candidates = [];
  try {
    candidates = fs.readdirSync(config.wh3Root)
      .filter(name => /^script_log(?:_\d+_\d+)?\.txt$/i.test(name))
      .map(name => path.join(config.wh3Root, name))
      .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return ""; }
  return candidates[0]?.file || "";
}

// The game announces its protocol when a campaign starts. Only the first time a
// pair is seen is it reported, in plain words for the player reading this window.
let reportedProtocol = "";
function reportProtocol(packProtocol, minCompanion) {
  const key = `${packProtocol}|${minCompanion}`;
  if (key === reportedProtocol) return;
  reportedProtocol = key;
  const advice = protocolAdvice(packProtocol, minCompanion);
  if (advice) console.warn(advice);
  else console.log(`Game and companion understand each other (protocol ${packProtocol}).`);
}

function addUiEvent(type, requestId, payload) {
  uiEvents.push({ timestamp: new Date().toISOString(), type, requestId, payload });
  if (uiEvents.length > 100) uiEvents.splice(0, uiEvents.length - 100);
}

function captureBridgeEvent(line) {
  const marker = "[LLMDIP] ";
  const start = line.indexOf(marker);
  if (start < 0) return;
  const value = line.slice(start + marker.length).trim();
  const ack = /^(?:RESPONSE|RESPONSE_ACK|NO_CONTACT|BRIEFING_ACK|COUNCIL_ACK|COURTS_ACK|RESPONSE_REJECT\|missing_request)\|([a-z0-9_]+)(?:\||$)/.exec(value);
  if (ack) {
    const quoted = luaString(ack[1]);
    inboxQueue = inboxQueue.then(() => {
      for (let i=deliveries.length-1; i>=0; i--) if (deliveries[i].includes(quoted)) deliveries.splice(i,1);
      atomicWrite(config.inboxFile, deliveries.join('\n'));
    });
  }
  const protocolLine = /^PROTOCOL\|(\d+)\|(\d+)/.exec(value);
  if (protocolLine) reportProtocol(Number(protocolLine[1]), Number(protocolLine[2]));
  for (const type of ["RESPONSE", "PROPOSAL", "EXECUTED", "READY"]) {
    if (!value.startsWith(`${type}|`)) continue;
    const rest = value.slice(type.length + 1);
    const separator = rest.indexOf("|");
    const requestId = separator < 0 ? rest : rest.slice(0, separator);
    const payload = separator < 0 ? "" : rest.slice(separator + 1);
    addUiEvent(type.toLowerCase(), requestId, payload);
    if (type === "EXECUTED") memory.markExecution(requestId, payload === "true");
    return;
  }
}

async function handleRequest(request) {
  if (handled.has(request.requestId)) return;
  handled.add(request.requestId);
  if (memory.hasRequest(request)) {
    const node = memory.readTimeline(request).nodes[request.requestId];
    const response = node.messages?.find(item => item.role === 'assistant');
    if (response) await enqueueInbox(renderInbox({requestId:request.requestId, narrative:response.content, action:node.action, reaction:node.reaction}));
    else await enqueueInbox(`llmdip_no_contact(${luaString(request.requestId)})\n`);
    return;
  }
  console.log(`\n${request.sender} → ${request.interlocutor}: ${request.message}`);
  const profile = memory.ensureProfile(request, request.identity || {});
  // The player's lord's gender, from their curated profile (the game's flag is wrong).
  const playerLore = memory.curatedLore(request.playerIdentity?.leaderSubtype, request.sender);
  if (request.playerIdentity && ["male", "female", "other"].includes(playerLore.voiceGender)) request.playerIdentity.gender = playerLore.voiceGender;
  const { digest, recent: history } = memory.recall(request);
  console.log(`[MEMORY_SCOPE] ${request.campaignId}/${request.sender}/${request.interlocutor} | ${history.length} messages${digest ? ` + record through turn ${digest.throughTurn}` : ""} | parent=${request.memoryParent}`);
  const betrayal = betrayalOpportunity(request, profile, betrayals, { enabled: config.betrayals, test: config.betrayalTest });
  if (betrayal.offered) console.log(`[BETRAYAL] ${request.interlocutor} may betray ${request.sender} (${betrayal.motives.join("; ")})`);
  // The codex: who the realms and people named in this exchange are.
  const lastWords = history.slice(-2).map(item => String(item.content || ""));
  const codexText = codex.block(request.campaignId, [
    request.mode === "player" ? request.message : "", ...lastWords.reverse(),
    request.fields?.court_dispatch, request.fields?.court_gossip, request.fields?.world_news
  ], { exclude: [request.interlocutor, request.sender] });
  // The player's own direction for this lord (custom/ next to the data folder).
  request.custom = memory.customInstructions(profile.leaderSubtype, request.interlocutor);
  const raw = await callLlm(config, request, history, profile, betrayal, digest, codexText);
  if ((request.mode === 'proactive' || request.mode === 'greeting') && raw.trim() === '[NO_CONTACT]') {
    memory.append(request, '', {type:'reject'}, {delta:0,reason:'neutral'});
    await enqueueInbox(`llmdip_no_contact(${luaString(request.requestId)})\n`);
    return;
  }
  // A reply the game cannot read (two deal tags, a broken tag) gets one second draft
  // that says what was wrong, instead of failing the player's message (0.45).
  let parsed;
  try { parsed = enforceBetrayal(parseDiplomacyResponse(raw), betrayal); }
  catch (error) {
    console.warn(`[FORMAT] ${request.interlocutor}: ${error.message}; asking for a second draft. First draft ended: ${raw.replace(/\s+/g, " ").slice(-240)}`);
    parsed = enforceBetrayal(parseDiplomacyResponse(await callLlm(config, { ...request, formatCorrection: error.message }, history, profile, betrayal, digest, codexText)), betrayal);
  }
  // A friendly model gives away whatever it is asked for. Land and gold beyond what
  // this ruler would really give (src/deal-limits.js) get one second draft; if that is
  // still beyond it, the letter stands without the deal.
  const violation = parsed.action.type === "betray_war" ? null : dealViolation(parsed.action, request.fields || {});
  if (violation) {
    console.log(`[DEAL_LIMIT] ${request.interlocutor}: ${violation}; asking for a second draft`);
    try {
      const retry = enforceBetrayal(parseDiplomacyResponse(await callLlm(config, { ...request, dealCorrection: violation }, history, profile, betrayal, digest, codexText)), betrayal);
      parsed = dealViolation(retry.action, request.fields || {}) ? { ...retry, action: { type: "reject" } } : retry;
    } catch (error) {
      console.warn(`[DEAL_LIMIT] second draft failed: ${error.message}`);
      parsed = { ...parsed, action: { type: "reject" } };
    }
  }
  if (request.mode === 'proactive') parsed.reaction = {delta:0,reason:'neutral'};
  // A greeting is words only, and only a ruler answering the player can end the audience.
  if (request.mode === 'greeting') parsed = { ...parsed, action: { type: 'reject' }, reaction: { delta: 0, reason: 'neutral' } };
  if (request.mode !== 'player') parsed.endsTalk = false;
  if (parsed.action.type === "betray_war") {
    try {
      const letter = parseDiplomacyResponse(await callLlm(config, { ...request, message: BETRAYAL_LETTER_REQUEST }, history, profile, null, digest, codexText));
      parsed.narrative = letter.narrative;
    } catch (error) { console.warn(`[BETRAYAL] the announcement could not be rewritten: ${error.message}`); }
    betrayals.record(request);
    console.log(`[BETRAYAL] ${request.interlocutor} betrays ${request.sender} and declares war`);
  }
  memory.append(request, parsed.narrative, parsed.action, parsed.reaction);
  await enqueueInbox(renderInbox({ requestId: request.requestId, ...parsed }));
  // Voice (0.45): the player switches it on in the World tab; only the audience itself is
  // spoken, never background letters. Actions between asterisks are not read aloud.
  if (config.provider === "player2" && request.fields?.voice === "1" && (request.mode === "player" || request.mode === "greeting")) {
    const spoken = parsed.narrative.replace(/\*[^*]+\*/g, " ").replace(/\s+/g, " ").trim();
    if (spoken) player2Speak({ ...config, player2Tts: true }, spoken, profile, fetch, { language: languageForRequest(request, config) })
      .catch(error => console.warn(`Player2 TTS: ${error.message}`));
  }
  if (parsed.endsTalk) console.log(`[TALK_END] ${request.interlocutor} ends the audience for this turn`);
  console.log(`${request.interlocutor}: ${parsed.narrative}`);
  console.log(`Proposal: ${JSON.stringify(parsed.action)}`);
  console.log(`Diplomatic reaction: ${parsed.reaction.delta} (${parsed.reaction.reason})`);
  scheduleDigest(request, profile);
}

// When the letters with a lord pass the limit (src/memory-store.js), the oldest are
// folded into the written record in the background. The game and the next letters
// never wait for it; if it fails, letters keep the plain recent history.
const digesting = new Set();
// "wh3_main_combi_region_essen:..." -> "essen, ...": enough for the record to see that a
// promised settlement really changed hands.
function settlementNames(value) {
  return String(value || "").split(":").filter(key => key && key !== "none")
    .map(key => key.replace(/^wh\d?_[a-z0-9]+_combi_region_|^wh\d?_main_region_/, "").replace(/_/g, " ")).join(", ");
}
function scheduleDigest(request, profile = {}) {
  const key = `${request.campaignId}/${request.sender}/${request.interlocutor}`;
  if (digesting.has(key)) return;
  const head = { ...request, memoryParent: request.requestId };
  let plan;
  try { plan = memory.digestPlan(head); } catch (error) { console.warn(`[MEMORY] ${error.message}`); return; }
  if (!plan) return;
  digesting.add(key);
  const faction = request.identity?.factionName || request.interlocutor;
  const playerFaction = request.playerIdentity?.factionName || request.sender;
  const names = {
    lord: shortName(profile.leader || request.identity?.leader) || request.interlocutor,
    faction,
    player: shortName(request.playerIdentity?.leader) || request.sender,
    playerFaction,
    events: pairEventsText(pairEvents(request.fields, request.sender, request.interlocutor),
      { lord: request.interlocutor, lordName: faction, playerName: playerFaction }),
    holds: settlementNames(request.fields?.ai_regions)
  };
  (async () => {
    // A long old correspondence may need a few folds; each is one call.
    for (let round = 0; plan && round < 3; round++) {
      const text = cleanDigest(await callMessages(config, buildDigestMessages(plan, names)));
      if (!text) throw new Error("the record came back empty or malformed");
      memory.saveDigest(head, plan, text);
      console.log(`[MEMORY] ${names.lord}: ${plan.fold.length} older letters folded into the record (through turn ${plan.throughTurn})`);
      plan = memory.digestPlan(head);
    }
  })().catch(error => console.warn(`[MEMORY] the record of ${names.lord} was not updated: ${error.message}`))
    .finally(() => digesting.delete(key));
}

// The player's court briefing: one background call per turn. The game keeps playing;
// the answer arrives through the inbox like a letter and the game drops it if it is
// stale (another save, another turn).
const handledBriefings = new Set();
async function handleBriefing(briefing) {
  if (handledBriefings.has(briefing.id)) return;
  handledBriefings.add(briefing.id);
  const language = languageForRequest({ fields: { ui_language: briefing.language } }, config);
  try {
    const lore = memory.curatedLore(briefing.rulerSubtype, briefing.player);
    const text = cleanBriefing(await callMessages(config, buildBriefingMessages(briefing, language, lore)));
    if (!text) throw new Error("empty briefing");
    await enqueueInbox(`if llmdip_world_briefing then llmdip_world_briefing(${luaString(briefing.id)}, ${luaString(text)}) end\n`);
    console.log(`[COURT] turn ${briefing.turn}: ${text}`);
  } catch (error) {
    console.warn(`[COURT] briefing failed: ${error.message}`);
    await enqueueInbox(`if llmdip_world_briefing_failed then llmdip_world_briefing_failed(${luaString(briefing.id)}) end\n`);
  }
}

// The ruler talking to their court: one call per message, answered through the inbox.
const handledCouncil = new Set();
async function handleCouncil(council) {
  if (handledCouncil.has(council.id)) return;
  handledCouncil.add(council.id);
  const language = languageForRequest({ fields: { ui_language: council.language } }, config);
  try {
    const lore = memory.curatedLore(council.rulerSubtype, council.player);
    const known = codex.block(council.campaignId, [council.words, council.talk], { exclude: [council.player] });
    const text = cleanBriefing(await callMessages(config, buildCouncilMessages(council, language, lore, known)), 2);
    if (!text) throw new Error("empty answer");
    await enqueueInbox(`if llmdip_world_council_reply then llmdip_world_council_reply(${luaString(council.id)}, ${luaString(text)}) end\n`);
    console.log(`[COURT] you: ${council.words}\n[COURT] adviser: ${text}`);
  } catch (error) {
    console.warn(`[COURT] the adviser could not answer: ${error.message}`);
    await enqueueInbox(`if llmdip_world_council_failed then llmdip_world_council_failed(${luaString(council.id)}) end\n`);
  }
}

// The council of courts: once a turn, each enabled court's private dispatch, a few
// courts per call. It runs in the background like every other call; the game applies
// the answer only in the player's turn and only for the turn that asked.
const handledCourts = new Set();
async function handleCourts(request) {
  if (handledCourts.has(request.id)) return;
  handledCourts.add(request.id);
  const language = languageForRequest({ fields: { ui_language: request.language } }, config);
  // The groups are independent, so they are asked at the same time.
  const answers = await Promise.all(courtGroups(request.realms).map(async group => {
    try {
      const raw = await callMessages(config, buildCourtsMessages(request, group, language), { maxTokens: COURTS_MAX_TOKENS, timeoutMs: COURTS_TIMEOUT_MS });
      return validateCourts(extractJson(raw), group, request);
    } catch (error) {
      console.warn(`[COURTS] ${group.map(realm => realm.key).join(", ")}: ${error.message}`);
      return [];
    }
  }));
  const courts = answers.flat();
  if (!courts.length) { await enqueueInbox(renderCourtsFailed(request.id)); return; }
  await enqueueInbox(renderCourtsInbox(request.id, courts));
  for (const court of courts) {
    const plans = court.plans.map(plan => `${plan.d}${plan.t ? ` ${plan.t}` : ""}`).join(", ") || "none";
    console.log(`[COURTS] turn ${request.turn} ${court.f}: ${court.mood}; plans: ${plans}${court.r ? `; rumour: ${court.r.tx}` : ""}`);
  }
}

async function handleControlLine(line) {
  if (campaignInitSent || !line.includes("[LLMDIP] NEED_CAMPAIGN_ID")) return;
  campaignInitSent = true;
  const campaignId = `c${crypto.randomUUID().replaceAll("-", "")}`;
  await enqueueInbox(externalCall("llmdip_external_initialize", [campaignId]));
  console.log(`Campaign registered: ${campaignId}`);
}

async function poll() {
  const logPath = newestScriptLog();
  if (busy || !logPath || !fs.existsSync(logPath)) return;
  busy = true;
  try {
    if (logPath !== activeLog) {
      // With the game closed, the newest log belongs to the PREVIOUS session: reading it
      // in full replays old requests and spends the player's joules on every start.
      // With the game open, those same lines are live requests nobody has answered yet
      // (the companion has only just started), so they are read.
      const stale = activeLog === "" && !gameRunning;
      activeLog = logPath;
      offset = stale ? fs.statSync(logPath).size : 0;
      remainder = "";
      campaignInitSent = false;
      console.log(`Active log: ${activeLog}${stale ? " (previous historical content skipped)" : ""}`);
    }
    const stat = fs.statSync(logPath);
    if (stat.size < offset) { offset = 0; remainder = ""; }
    if (stat.size === offset) return;
    const length = stat.size - offset;
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    fs.closeSync(fd);
    offset = stat.size;
    const lines = (remainder + buffer.toString("utf8")).split(/\r?\n/);
    remainder = lines.pop() || "";
    for (const line of lines) {
      captureBridgeEvent(line);
      await handleControlLine(line);
      let briefing = null;
      try { briefing = parseBriefingRequest(line); }
      catch (error) { console.warn(`Briefing ignored: ${error.message}`); }
      if (briefing) { await handleBriefing(briefing); continue; }
      let council = null;
      try { council = parseCouncilRequest(line); }
      catch (error) { console.warn(`Court message ignored: ${error.message}`); }
      if (council) { await handleCouncil(council); continue; }
      let codexLine = null;
      try { codexLine = parseCodexLine(line); }
      catch (error) { console.warn(`Codex ignored: ${error.message}`); }
      if (codexLine) { codex.store(codexLine); continue; }
      let courts = null;
      try { courts = parseCourtsRequest(line); }
      catch (error) { console.warn(`Courts request ignored: ${error.message}`); }
      // Not awaited: letters keep flowing while the courts deliberate.
      if (courts) { handleCourts(courts).catch(error => console.warn(`[COURTS] ${error.message}`)); continue; }
      let request;
      try { request = parseBridgeRequest(line); }
      catch (error) { console.warn(`Request ignored: ${error.message}`); continue; }
      if (request) {
        // Before asking the model, tell the game someone is here. The mod waits a
        // few seconds for this signal: if it never comes, it tells the player the
        // companion is missing instead of leaving them on an endless "Thinking..."
        // The signal names the request, so the usual acknowledgement removes it
        // with the reply, and a line left in the file never passes for a later one.
        await enqueueInbox(`if llmdip_companion_alive then llmdip_companion_alive(${luaString(request.requestId)}, ${COMPANION_PROTOCOL}) end\n`);
        try { await handleRequest(request); }
        catch (error) {
          console.warn(`Could not respond to ${request.requestId}: ${error.message}`);
          memory.append(request, '', {type:'reject'}, {delta:0,reason:'neutral'});
          await enqueueInbox(`llmdip_request_failed(${luaString(request.requestId)})\n`);
        }
      }
    }
  } catch (error) {
    console.error(`Bridge: ${error.message}`);
  } finally { busy = false; }
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>WH3 LLM Diplomacy</title><style>
body{font:16px system-ui;background:#17130f;color:#f1dfbd;max-width:820px;margin:30px auto;padding:0 18px}
h1{font-family:Georgia,serif;color:#e2b866}label{display:block;margin-top:14px;color:#cdb98f}
input,textarea,button{box-sizing:border-box;width:100%;padding:11px;margin-top:5px;border:1px solid #655438;border-radius:7px;background:#241e17;color:#fff}
textarea{min-height:110px;resize:vertical}button{cursor:pointer;background:#79551d;font-weight:700}button:hover{background:#98702b}
#events{white-space:pre-wrap;background:#100d0a;border:1px solid #433722;padding:14px;min-height:220px;margin-top:18px;border-radius:7px}
.row{display:flex;gap:10px}.row button{width:auto}.hint{font-size:13px;color:#a99777}
</style></head><body><h1>Living Diplomacy — Warhammer III</h1>
<p class="hint">Player2 generates dialogue and voice; Warhammer keeps the portrait, faction and diplomatic actions.</p>
<label>Faction to speak to</label><input id="target" value="wh_main_emp_empire">
<label>Message</label><textarea id="message">Karl Franz, I would like to propose a defensive alliance.</textarea>
<button id="send">Send message</button>
<button id="toggle">Enable/disable letters from this faction</button>
<label>Proposal ID to accept</label><div class="row"><input id="requestId"><button id="accept">Accept</button></div>
<div id="events">Waiting for the game…</div>
<script>
const events=document.querySelector('#events'), requestId=document.querySelector('#requestId');
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
document.querySelector('#send').onclick=async()=>{try{await post('/api/send',{target:document.querySelector('#target').value,message:document.querySelector('#message').value})}catch(e){alert(e.message)}};
document.querySelector('#toggle').onclick=async()=>{try{await post('/api/toggle-contact',{target:document.querySelector('#target').value})}catch(e){alert(e.message)}};
document.querySelector('#accept').onclick=async()=>{try{await post('/api/accept',{requestId:requestId.value})}catch(e){alert(e.message)}};
async function refresh(){try{const r=await fetch('/api/events'),j=await r.json();events.textContent=j.events.map(e=>e.timestamp+'  '+e.type.toUpperCase()+'  '+e.requestId+'\n'+e.payload).join('\n\n')||'Waiting for the game…';const p=[...j.events].reverse().find(e=>e.type==='proposal');if(p&&!requestId.value)requestId.value=p.requestId}catch{}setTimeout(refresh,900)}refresh();
</script></body></html>`;

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 8192) request.destroy(new Error("Request is too large"));
    });
    request.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid JSON")); }
    });
    request.on("error", reject);
  });
}

function externalCall(functionName, values) {
  const nonce = `x${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const args = [nonce, ...values].map(value => {
    if (typeof value !== "string") throw new Error("Invalid external argument");
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
  });
  return `${functionName}(${args.join(", ")})\n`;
}

const webServer = http.createServer(async (request, response) => {
  const sendJson = (status, value) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(HTML); return;
    }
    if (request.method === "GET" && request.url === "/api/events") { sendJson(200, { events: uiEvents }); return; }
    if (request.method === "POST" && request.url === "/api/send") {
      const body = await readJson(request);
      if (!/^[a-z0-9_]{1,160}$/.test(body.target || "")) throw new Error("Invalid faction key");
      if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 1200) throw new Error("Message is empty or too long");
      await enqueueInbox(externalCall("llmdip_external_send", [body.target, body.message.trim()]));
      sendJson(202, { ok: true }); return;
    }
    if (request.method === "POST" && request.url === "/api/accept") {
      const body = await readJson(request);
      if (!/^[a-z0-9_]{1,160}$/.test(body.requestId || "")) throw new Error("Invalid proposal ID");
      await enqueueInbox(externalCall("llmdip_external_accept", [body.requestId]));
      sendJson(202, { ok: true }); return;
    }
    if (request.method === "POST" && request.url === "/api/toggle-contact") {
      const body = await readJson(request);
      if (!/^[a-z0-9_]{1,160}$/.test(body.target || "")) throw new Error("Invalid faction key");
      await enqueueInbox(externalCall("llmdip_external_toggle_contact", [body.target]));
      sendJson(202, { ok: true }); return;
    }
    sendJson(404, { error: "Not found" });
  } catch (error) { sendJson(400, { error: error.message }); }
});

webServer.once("error", error => {
  if (error?.code === "EADDRINUSE") {
    console.log(`A companion is already active at http://127.0.0.1:${config.port}. Close its window before switching versions.`);
    process.exit(0);
  }
  throw error;
});
webServer.listen(config.port, "127.0.0.1", () => {
  console.log(`Living Diplomacy Companion v${typeof __LLMDIP_VERSION__ === "string" ? __LLMDIP_VERSION__ : "dev"} — faction-isolated chat — provider=${config.provider}`);
  console.log(`Watching: ${config.scriptLog || "script_log_*.txt (automatic)"}`);
  if (config.provider === "player2") {
    if (!config.player2GameKey) {
      console.warn("WARNING: Game Client ID is missing. Player2 cannot attribute this play time to the mod.");
    }
    connectPlayer2(config).then(value => console.log(`Player2 ${value.version}: ${value.apiBase}`)).catch(error => console.warn(`Player2 unavailable: ${error.message}`));
  }
  if (!wh3RootLooksValid(config.wh3Root)) {
    console.warn("WARNING: Total War: WARHAMMER III was not found at " + config.wh3Root);
    console.warn("       Create a .env file beside the companion with this line:");
    console.warn("       WH3_ROOT=D:/path/to/Total War WARHAMMER III");
  }
  // While the inbox is being cleared, tell the mod which language the game uses.
  // If this never arrives, the Lua falls back to English instead of blank text.
  atomicWrite(config.inboxFile,
    "-- LLM Diplomacy Companion\n" +
    "if llmdip_companion_alive then llmdip_companion_alive() end\n" +
    "llmdip_set_language(" + JSON.stringify(config.uiLanguage) + ")\n");
  console.log(`Fallback language: ${config.language} (${config.uiLanguage}). Letters use the language reported by the game.`);
  console.log(`Local chat: http://127.0.0.1:${config.port}`);
});
setInterval(poll, config.pollMs);
setInterval(stopAfterGameExit, 3000);

// Attribution: time only counts while Warhammer is open, so the idle companion
// waiting for a campaign to start does not inflate the time spent.
function heartbeat() { if (gameRunning) void player2Heartbeat(config); }
if (config.provider === "player2") { setInterval(heartbeat, HEARTBEAT_MS); heartbeat(); }

// No top-level await, so the CommonJS bundle of the packaged executable stays valid.
poll().catch(error => console.warn("Initial poll failed: " + error.message));
