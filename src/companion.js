import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { getConfig, uiLanguageCode, wh3RootLooksValid } from "./config.js";
import { callLlm } from "./llm-client.js";
import { MemoryStore } from "./memory-store.js";
import { parseBridgeRequest } from "./protocol.js";
import { parseDiplomacyResponse } from "./tag-parser.js";
import { renderInbox, luaString } from "./lua-renderer.js";
import { connectPlayer2, player2Heartbeat, player2Speak } from "./player2-client.js";

const config = getConfig();

// Player2 asks for one health ping per minute to measure the mod's time spent.
const HEARTBEAT_MS = 60_000;
const memory = new MemoryStore(config.dataDir);
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
    console.log("WARHAMMER III has closed; shutting down Living Diplomacy Companion.");
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

function addUiEvent(type, requestId, payload) {
  uiEvents.push({ timestamp: new Date().toISOString(), type, requestId, payload });
  if (uiEvents.length > 100) uiEvents.splice(0, uiEvents.length - 100);
}

function captureBridgeEvent(line) {
  const marker = "[LLMDIP] ";
  const start = line.indexOf(marker);
  if (start < 0) return;
  const value = line.slice(start + marker.length).trim();
  const ack = /^(?:RESPONSE|RESPONSE_ACK|NO_CONTACT|RESPONSE_REJECT\|missing_request)\|([a-z0-9_]+)(?:\||$)/.exec(value);
  if (ack) {
    const quoted = luaString(ack[1]);
    inboxQueue = inboxQueue.then(() => {
      for (let i=deliveries.length-1; i>=0; i--) if (deliveries[i].includes(quoted)) deliveries.splice(i,1);
      atomicWrite(config.inboxFile, deliveries.join('\n'));
    });
  }
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
  const history = memory.history(request);
  console.log(`[MEMORY_SCOPE] ${request.campaignId}/${request.sender}/${request.interlocutor} | ${history.length} messages | parent=${request.memoryParent}`);
  const raw = await callLlm(config, request, history, profile);
  if (request.mode === 'proactive' && raw.trim() === '[NO_CONTACT]') {
    memory.append(request, '', {type:'reject'}, {delta:0,reason:'neutral'});
    await enqueueInbox(`llmdip_no_contact(${luaString(request.requestId)})\n`);
    return;
  }
  const parsed = parseDiplomacyResponse(raw);
  if (request.mode === 'proactive') parsed.reaction = {delta:0,reason:'neutral'};
  memory.append(request, parsed.narrative, parsed.action, parsed.reaction);
  await enqueueInbox(renderInbox({ requestId: request.requestId, ...parsed }));
  if (config.provider === "player2") player2Speak(config, parsed.narrative, profile).catch(error => console.warn(`Player2 TTS: ${error.message}`));
  console.log(`${request.interlocutor}: ${parsed.narrative}`);
  console.log(`Proposal: ${JSON.stringify(parsed.action)}`);
  console.log(`Diplomatic reaction: ${parsed.reaction.delta} (${parsed.reaction.reason})`);
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
      console.log(`Active log: ${activeLog}${stale ? " (previous session skipped)" : ""}`);
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
      let request;
      try { request = parseBridgeRequest(line); }
      catch (error) { console.warn(`Request ignored: ${error.message}`); continue; }
      if (request) {
        try { await handleRequest(request); }
        catch (error) {
          console.warn(`Could not answer ${request.requestId}: ${error.message}`);
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
</style></head><body><h1>Living Diplomacy — WARHAMMER III</h1>
<p class="hint">Player2 generates the dialogue and voice; WARHAMMER III handles faction portraits and diplomatic actions.</p>
<label>Faction key</label><input id="target" value="wh_main_emp_empire">
<label>Message</label><textarea id="message">Karl Franz, I would like to propose a defensive alliance.</textarea>
<button id="send">Send message</button>
<button id="toggle">Enable or disable this faction as an AI contact</button>
<label>Proposal ID to accept</label><div class="row"><input id="requestId"><button id="accept">Accept</button></div>
<div id="events">Waiting for the game...</div>
<script>
const events=document.querySelector('#events'), requestId=document.querySelector('#requestId');
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
document.querySelector('#send').onclick=async()=>{try{await post('/api/send',{target:document.querySelector('#target').value,message:document.querySelector('#message').value})}catch(e){alert(e.message)}};
document.querySelector('#toggle').onclick=async()=>{try{await post('/api/toggle-contact',{target:document.querySelector('#target').value})}catch(e){alert(e.message)}};
document.querySelector('#accept').onclick=async()=>{try{await post('/api/accept',{requestId:requestId.value})}catch(e){alert(e.message)}};
async function refresh(){try{const r=await fetch('/api/events'),j=await r.json();events.textContent=j.events.map(e=>e.timestamp+'  '+e.type.toUpperCase()+'  '+e.requestId+'\n'+e.payload).join('\n\n')||'Waiting for the game...';const p=[...j.events].reverse().find(e=>e.type==='proposal');if(p&&!requestId.value)requestId.value=p.requestId}catch{}setTimeout(refresh,900)}refresh();
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
    console.log(`The companion is already running at http://127.0.0.1:${config.port}. Do not start a second instance.`);
    process.exit(0);
  }
  throw error;
});
webServer.listen(config.port, "127.0.0.1", () => {
  console.log(`Living Diplomacy Companion v0.41.1 — separate chat for each faction — provider=${config.provider}`);
  console.log(`Watching: ${config.scriptLog || "script_log_*.txt (automatic)"}`);
  if (config.provider === "player2") {
    if (!config.player2GameKey) {
      console.warn("WARNING: the Game Client ID is missing. Player2 cannot attribute play time to this mod.");
    }
    connectPlayer2(config).then(value => console.log(`Player2 ${value.version}: ${value.apiBase}`)).catch(error => console.warn(`Player2 unavailable: ${error.message}`));
  }
  if (!wh3RootLooksValid(config.wh3Root)) {
    console.warn("WARNING: Total War: WARHAMMER III was not found at " + config.wh3Root);
    console.warn("       Set WH3_ROOT to the folder containing Warhammer3.exe, for example:");
    console.warn("       WH3_ROOT=D:/SteamLibrary/steamapps/common/Total War WARHAMMER III");
  }
  // While the inbox is being cleared, tell the mod which language the game uses.
  // If this never arrives, the Lua falls back to English instead of blank text.
  atomicWrite(config.inboxFile,
    "-- LLM Diplomacy Companion\n" +
    "llmdip_set_language(" + JSON.stringify(config.uiLanguage) + ")\n");
  console.log(`Fallback language: ${config.language} (${config.uiLanguage}). Letters follow the game's language setting.`);
  console.log(`Local chat: http://127.0.0.1:${config.port}`);
});
setInterval(poll, config.pollMs);
setInterval(stopAfterGameExit, 3000);

// Attribution: time only counts while Warhammer is open, so the idle companion
// waiting for a campaign to start does not inflate the time spent.
function heartbeat() { if (gameRunning) void player2Heartbeat(config); }
if (config.provider === "player2") { setInterval(heartbeat, HEARTBEAT_MS); heartbeat(); }

// Without top-level await, the CommonJS bundle of the packaged executable stays valid.
poll().catch(error => console.warn("Initial poll failed: " + error.message));
