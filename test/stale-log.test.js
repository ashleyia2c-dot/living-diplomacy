// Al arrancar con el juego cerrado, el script_log mas reciente es el de la PARTIDA
// ANTERIOR. Procesarlo entero reenviaba cada peticion vieja al LLM: joules del jugador
// quemados en cada arranque y cartas rancias. Pero el log de la partida NUEVA si debe
// leerse entero. Este test fija las dos mitades a la vez.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requestLine(id) {
  return `[LLMDIP] REQUEST|${id}|camp1|wh3_dlc20_chs_sigvald|wh3_main_dae_daemon_prince|` +
    `proactive|turn%3D5%2Cmemory_parent%3Droot%2Cmemory_head%3D${id}|Hola`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("ignora el log de la partida anterior y si lee el de la nueva", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh3-log-"));
  fs.writeFileSync(path.join(dir, "Warhammer3.exe"), "");
  fs.writeFileSync(path.join(dir, "script_log_1_1.txt"), requestLine("r1") + "\n");

  const chats = [];
  const server = http.createServer((request, response) => {
    if (request.url.includes("chat/completions")) chats.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      client_version: "mock",
      choices: [{ message: { content: "[NO_CONTACT]" } }]
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const mockPort = server.address().port;

  const child = spawn(process.execPath, ["src/companion.js"], {
    cwd: ROOT,
    env: { ...process.env,
      WH3_ROOT: dir,
      LLMDIP_DATA_DIR: path.join(dir, "data"),
      LLMDIP_PLAYER2_URL: `http://127.0.0.1:${mockPort}`,
      LLMDIP_PLAYER2_GAME_KEY: "test-attribution",
      LLMDIP_PORT: String(45100 + Math.floor(Math.random() * 400)) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.resume();
  child.stderr.resume();

  try {
    // Warhammer3.exe no esta corriendo de verdad (es un fichero vacio), asi que el
    // companion debe tratar ese log como historico y no tocarlo.
    await sleep(2500);
    assert.equal(chats.length, 0, "no debe reenviar al LLM las peticiones de la partida anterior");

    // El juego arranca y crea su propio log: eso si son peticiones vivas.
    fs.writeFileSync(path.join(dir, "script_log_2_2.txt"), requestLine("r2") + "\n");
    await sleep(3500);
    assert.ok(chats.length >= 1, "debe atender las peticiones del log nuevo");
  } finally {
    child.kill();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
