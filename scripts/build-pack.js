import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// RPFM vive en tools/ del proyecto. El segundo candidato cubre las copias que aun
// estan dentro de versions/<nombre>/, dos niveles por debajo de la raiz.
const serverExe = [
  path.join(root, "tools", "rpfm-v5.0.6", "rpfm_server.exe"),
  path.resolve(root, "../../tools/rpfm-v5.0.6/rpfm_server.exe")
].find(candidate => fs.existsSync(candidate)) || path.join(root, "tools", "rpfm-v5.0.6", "rpfm_server.exe");
// LLMDIP_MOD_DIR y LLMDIP_PACK_OUT permiten construir packs de diagnostico desde otra
// carpeta de fuentes sin tocar el pack oficial.
const modDir = process.env.LLMDIP_MOD_DIR ? path.resolve(process.env.LLMDIP_MOD_DIR) : path.join(root, "mod");
const luaSource = path.join(modDir, "script", "campaign", "mod", "llm_diplomacy.lua");
const luaUiSource = path.join(modDir, "script", "campaign", "mod", "llm_diplomacy_ui.lua");
const overlayTemplate = path.join(modDir, "llmdip_ui", "llmdip_chat.twui.xml");
const historyTemplate = path.join(modDir, "llmdip_ui", "llmdip_history.twui.xml");
const bubbleTemplate = path.join(modDir, "llmdip_ui", "llmdip_bubble.twui.xml");
const shellTemplate = path.join(modDir, "llmdip_ui", "llmdip_shell.twui.xml");
const loggingMarker = path.join(modDir, "script", "enable_console_logging");
const output = process.env.LLMDIP_PACK_OUT ? path.resolve(process.env.LLMDIP_PACK_OUT) : path.join(root, "dist", "llm_diplomacy.pack");
let child;
let sessionId;
let nextId = 1;

async function serverReady() {
  try { return (await fetch("http://127.0.0.1:45127/sessions")).ok; }
  catch { return false; }
}

async function ensureServer() {
  if (await serverReady()) return;
  if (!fs.existsSync(serverExe)) throw new Error(`No se encontró RPFM Server: ${serverExe}`);
  child = spawn(serverExe, [], {
    cwd: path.dirname(serverExe), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let errorText = "";
  child.stderr.on("data", data => { errorText += data.toString(); });
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await serverReady()) return;
    if (child.exitCode !== null) throw new Error(`RPFM Server terminó: ${errorText.slice(-500)}`);
  }
  throw new Error("RPFM Server no abrió el puerto 45127");
}

function parseSse(text, wantedId) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw.startsWith("{")) continue;
    const message = JSON.parse(raw);
    if (message.id === wantedId) {
      if (message.error) throw new Error(`MCP: ${JSON.stringify(message.error)}`);
      return message.result;
    }
  }
  throw new Error(`MCP no devolvió respuesta para id=${wantedId}`);
}

async function rpc(method, params = {}, notification = false) {
  const id = notification ? undefined : nextId++;
  const payload = { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params };
  const response = await fetch("http://127.0.0.1:45127/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  if (!sessionId) sessionId = response.headers.get("mcp-session-id");
  const text = await response.text();
  return notification ? null : parseSse(text, id);
}

async function tool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result?.isError) throw new Error(`${name}: ${result.content?.map(x => x.text).join("\n")}`);
  return result;
}

async function main() {
  await ensureServer();
  await rpc("initialize", {
    protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "llmdip-pack-builder", version: "0.1.0" }
  });
  await rpc("notifications/initialized", {}, true);
  await tool("set_game_selected", { game_name: "warhammer_3", rebuild_dependencies: false });
  await tool("close_all_packs");
  await tool("new_pack");
  const opened = await tool("list_open_packs");
  const text = opened.content?.find(item => item.type === "text")?.text || "";
  const payload = JSON.parse(text);
  const list = Array.isArray(payload) ? payload : payload.VecStringContainerInfo;
  if (!Array.isArray(list) || list.length !== 1) throw new Error(`Pack nuevo no encontrado: ${text}`);
  const packKey = Array.isArray(list[0])
    ? list[0][0]
    : (list[0].key || list[0].pack_key || list[0].path || list[0].name);
  if (!packKey) throw new Error(`RPFM no devolvió pack_key: ${text}`);

  await tool("add_packed_files", {
    pack_key: packKey,
    source_paths: [luaSource, luaUiSource, overlayTemplate, historyTemplate, bubbleTemplate, shellTemplate, loggingMarker,
      path.join(modDir, "script/campaign/mod/llm_diplomacy_mailbox.lua"),
      path.join(modDir, "script/campaign/mod/llm_diplomacy_i18n.lua")],
    destination_paths: JSON.stringify([
      { File: "script/campaign/mod/llm_diplomacy.lua" },
      { File: "script/campaign/mod/llm_diplomacy_ui.lua" },
      { File: "llmdip_ui/llmdip_chat.twui.xml" },
      { File: "llmdip_ui/llmdip_history.twui.xml" },
      { File: "llmdip_ui/llmdip_bubble.twui.xml" },
      { File: "llmdip_ui/llmdip_shell.twui.xml" },
      { File: "script/enable_console_logging" },
      { File: "script/campaign/mod/llm_diplomacy_mailbox.lua" },
      { File: "script/campaign/mod/llm_diplomacy_i18n.lua" }
    ]),
    ignore_paths: null
  });
  await tool("set_pack_file_type", { pack_key: packKey, pack_file_type: JSON.stringify("Mod") });
  await tool("change_compression_format", { pack_key: packKey, format: JSON.stringify("None") });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await tool("save_pack_as", { pack_key: packKey, path: output });
  if (!fs.existsSync(output) || fs.statSync(output).size < 100) throw new Error("RPFM no produjo un PackFile válido");
  console.log(`Pack creado: ${output}`);
}

try { await main(); }
finally {
  if (child && child.exitCode === null) child.kill();
}
