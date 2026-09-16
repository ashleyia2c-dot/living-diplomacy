import fs from "node:fs";
import path from "node:path";
import { buildPersonality, buildSocialStyle } from "./personality.js";

const SAFE = /^[a-z0-9_]{1,160}$/;

function segment(value, field) {
  if (!SAFE.test(value || "")) throw new Error(`${field} no es una key segura`);
  return value;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

export class MemoryStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, "campaigns");
    this.loreRoot = path.resolve("lore-profiles");
    this.pendingLedgerFiles = new Map();
    fs.mkdirSync(this.root, { recursive: true });
  }

  factionDir(request) {
    return path.join(this.root, segment(request.campaignId, "campaignId"), segment(request.interlocutor, "interlocutor"));
  }

  campaignDir(request) {
    return path.join(this.root, segment(request.campaignId, "campaignId"));
  }

  timelineFile(request) {
    return path.join(this.campaignDir(request), "_timelines", segment(request.sender, "sender"), "timeline.json");
  }

  memoryFile(request) {
    return path.join(this.factionDir(request), "players", segment(request.sender, "sender"), "memory.json");
  }

  ledgerFile(request) {
    return path.join(this.factionDir(request), "players", segment(request.sender, "sender"), "favor-ledger.json");
  }

  readTimeline(request) {
    return readJson(this.timelineFile(request), { version: 1, nodes: {} });
  }

  lineage(timeline, head) {
    const nodes = timeline?.nodes && typeof timeline.nodes === "object" ? timeline.nodes : {};
    const result = [];
    const seen = new Set();
    let cursor = head || "root";
    while (cursor !== "root" && result.length < 500 && !seen.has(cursor)) {
      seen.add(cursor);
      const node = nodes[cursor];
      if (!node) break;
      result.push(node);
      cursor = node.parent || "root";
    }
    return result.reverse();
  }

  hasRequest(request) {
    const node = this.readTimeline(request).nodes?.[request.requestId];
    if (node && (node.interlocutor !== request.interlocutor || (node.sender && node.sender !== request.sender))) {
      throw new Error('Request ID belongs to another conversation; refusing replay');
    }
    return Boolean(node);
  }

  history(request) {
    // memoryParent is read from cm:get_saved_value(), so it represents the
    // exact conversation head contained in the loaded WH3 save. Walking that
    // parent chain keeps alternate save branches isolated from one another.
    const timeline = this.readTimeline(request);
    const all = this.lineage(timeline, request.memoryParent)
      .filter(node => node.interlocutor === request.interlocutor && (!node.sender || node.sender === request.sender))
      .flatMap(node => Array.isArray(node.messages) ? node.messages
        // Legacy nodes have no scope field. They are still safe here because
        // their parent timeline is already isolated by campaign + sender and
        // the node itself is filtered to this interlocutor above. New nodes
        // carry an explicit triple so accidental cross-conversation copies are
        // rejected instead of silently entering the prompt.
        .filter(message => !message.scope || (message.scope.campaignId === request.campaignId && message.scope.sender === request.sender && message.scope.interlocutor === request.interlocutor))
        .map(message => ({...message, mode:message.mode || node.mode,
          scope:{campaignId:request.campaignId,sender:request.sender,interlocutor:node.interlocutor}})) : []);
    // Preserve some actual player exchanges when many unanswered letters arrive.
    // Both windows come ONLY from this save lineage, never from memory.json or a
    // cross-branch summary. Historical offers remain offers, not executed facts.
    const recentStart = Math.max(0, all.length - 12);
    const anchors = all.slice(0, recentStart).filter(message => message.mode === 'player').slice(-8);
    return [...anchors, ...all.slice(recentStart)];
  }

  append(request, narrative, action, reaction) {
    this.hasRequest(request); // Reject foreign-ID collisions before writing anything.
    const previous = this.history(request);
    const timelineFile = this.timelineFile(request);
    const timeline = this.readTimeline(request);
    const speaker = identity => ({leader:identity?.leader || 'unknown', leaderSubtype:identity?.leaderSubtype || 'unknown'});
    const answer = { role: "assistant", content: narrative, turn: request.turn, mode:request.mode,
      speakerIdentity:speaker(request.identity), action, reaction };
    const messages = !narrative ? [] : request.mode === 'proactive' ? [
      answer
    ] : [
      { role: "user", content: request.message, turn: request.turn, mode: request.mode, speakerIdentity:speaker(request.playerIdentity) },
      answer
    ];
    for (const message of messages) message.scope = {campaignId:request.campaignId,sender:request.sender,interlocutor:request.interlocutor};
    timeline.version = 1;
    timeline.nodes ||= {};
    timeline.nodes[request.requestId] = {
      requestId: request.requestId,
      parent: request.memoryParent || "root",
      interlocutor: request.interlocutor,
      sender: request.sender,
      turn: request.turn,
      mode: request.mode,
      action,
      reaction,
      messages,
      createdAt: new Date().toISOString()
    };
    timeline.updatedAt = new Date().toISOString();
    writeJson(timelineFile, timeline);

    const file = this.memoryFile(request);
    const data = readJson(file, { faction: request.interlocutor, player: request.sender, messages: [] });
    // memory.json is a readable materialisation of the currently active
    // branch. The timeline graph above remains the authoritative source.
    data.messages = [...previous, ...messages].slice(-30);
    data.activeHead = request.requestId;
    data.timelineVersion = 1;
    data.updatedAt = new Date().toISOString();
    writeJson(file, data);

    // The favor ledger is materialised from the same save branch, so deals
    // made after an older save do not survive when that save is loaded.
    const entries = this.lineage(timeline, request.requestId)
      .filter(node => node.interlocutor === request.interlocutor && ["offer_gold", "request_gold", "favor"].includes(node.action?.type))
      .map(node => ({
        requestId: node.requestId,
        memoryParent: node.parent || "root",
        turn: node.turn,
        mode: node.mode,
        action: node.action,
        status: node.execution ? (node.execution.ok ? "executed" : "failed") : "proposed",
        ...(node.execution?.at ? { executedAt: node.execution.at } : {})
      }))
      .slice(-50);
    writeJson(this.ledgerFile(request), { activeHead: request.requestId, entries });
    if (["offer_gold", "request_gold", "favor"].includes(action?.type) && request.requestId) {
      this.pendingLedgerFiles.set(request.requestId, { ledgerFile: this.ledgerFile(request), timelineFile });
    }
  }

  markExecution(requestId, ok) {
    const pending = this.pendingLedgerFiles.get(requestId);
    if (!pending) return false;
    const ledger = readJson(pending.ledgerFile, { entries: [] });
    const entry = [...ledger.entries].reverse().find(item => item.requestId === requestId);
    if (!entry) return false;
    entry.status = ok ? "executed" : "failed";
    entry.executedAt = new Date().toISOString();
    writeJson(pending.ledgerFile, ledger);
    const timeline = readJson(pending.timelineFile, { version: 1, nodes: {} });
    if (timeline.nodes?.[requestId]) {
      timeline.nodes[requestId].execution = { ok, at: entry.executedAt };
      writeJson(pending.timelineFile, timeline);
    }
    this.pendingLedgerFiles.delete(requestId);
    return true;
  }

  ensureProfile(request, identity) {
    const leaderKey = SAFE.test(identity.leaderSubtype || "") ? identity.leaderSubtype : "unknown_leader";
    const file = path.join(this.factionDir(request), "leaders", `${leaderKey}.json`);
    const current = readJson(file, null);
    const curated = readJson(path.join(this.loreRoot, `${request.interlocutor}.json`), null) ||
      readJson(path.join(this.loreRoot, `${leaderKey}.json`), {});
    const profile = {
      ...(current || {}),
      faction: request.interlocutor,
      leader: identity.leader || "unknown",
      leaderSubtype: identity.leaderSubtype || "unknown",
      culture: identity.culture || "unknown",
      subculture: identity.subculture || "unknown",
      personality: current?.personality || buildPersonality(identity, request.interlocutor),
      socialStyle: current?.socialStyle?.signature === buildSocialStyle(identity, request.interlocutor).signature
        ? current.socialStyle : buildSocialStyle(identity, request.interlocutor),
      canonNotes: Array.isArray(current?.canonNotes) ? current.canonNotes : (Array.isArray(curated.canonNotes) ? curated.canonNotes : []),
      voiceNotes: Array.isArray(current?.voiceNotes) ? current.voiceNotes : (Array.isArray(curated.voiceNotes) ? curated.voiceNotes : []),
      voiceGender: ["male", "female", "other"].includes(current?.voiceGender) ? current.voiceGender : (["male", "female", "other"].includes(curated.voiceGender) ? curated.voiceGender : undefined),
      voiceIds: Array.isArray(current?.voiceIds) ? current.voiceIds : (Array.isArray(curated.voiceIds) ? curated.voiceIds : []),
      ttsInstructions: typeof current?.ttsInstructions === "string" ? current.ttsInstructions : (typeof curated.ttsInstructions === "string" ? curated.ttsInstructions : ""),
      sources: Array.isArray(current?.sources) ? current.sources : (Array.isArray(curated.sources) ? curated.sources : []),
      note: "La identidad y los rasgos vienen del juego; la personalidad estable se genera por lord. canonNotes permite refinar lords concretos."
    };
    writeJson(file, profile);
    return profile;
  }
}
