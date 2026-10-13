import fs from "node:fs";
import path from "node:path";
import { buildPersonality, buildSocialStyle, applyTemperament, applySocialStyle } from "./personality.js";

const SAFE = /^[a-z0-9_]{1,160}$/;

// A long correspondence is folded into a written record (src/memory-digest.js) so a
// letter carries the record plus the last few letters instead of every old one. Fold
// when the letters since the last record pass either limit; keep the newest raw.
export const DIGEST_LIMIT_MESSAGES = 14;
export const DIGEST_LIMIT_CHARS = 3500;
export const DIGEST_KEEP_RAW = 6;
const DIGEST_MAX_FOLD = 40;
const RECENT_AFTER_DIGEST = 14;

function segment(value, field) {
  if (!SAFE.test(value || "")) throw new Error(`${field} is not a safe key`);
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

// The player's own versions of the lords (0.45). A JSON in custom/lords/ named after the
// lord's agent subtype or faction key replaces, field by field, the curated profile
// of that lord; "instructions" adds the player's own direction for him or her, and
// custom/instructions.txt applies to every lord. Nothing here can change the reply
// format or the game rules: the prompt says so.
const CUSTOM_TEXT_LIMIT = 1500;
const CUSTOM_FIELDS = ["canonNotes", "voiceNotes", "temperament", "socialStyle", "voiceGender", "voiceIds", "ttsInstructions"];
const CUSTOM_README = `LIVING DIPLOMACY - YOUR OWN LORDS

Put a JSON file in the "lords" folder to change how a lord is played. Name it after the
lord's agent subtype (for example wh3_main_ksl_katarin.json) or the faction key
(wh3_main_ksl_the_ice_court.json). Every field is optional; a field you leave out
keeps the mod's own version. See lords/_example.json.

  canonNotes      list of facts about the character
  voiceNotes      list: how the lord talks, what they care about, what they never say
  temperament     0-100 values: aggression, caution, pride, greed, honour
  socialStyle     0-100 values: warmth, sociability, generosity, vanity, spite, opportunism
  voiceGender     "male", "female" or "other"
  instructions    your own direction for this lord, up to 1500 characters

instructions.txt in this folder applies to every lord (style, length, tone...).
Changes apply to the next message; no restart needed. A broken JSON is ignored and
the companion window says so.
`;
const CUSTOM_EXAMPLE = {
  canonNotes: ["Katarin is the Ice Queen of Kislev, a powerful ice witch who rules from the Bokha Palace."],
  voiceNotes: ["Speaks coldly and briefly to strangers, warmly to proven allies.", "Never forgives an insult to Kislev."],
  temperament: { aggression: 45, caution: 70, pride: 80, greed: 30, honour: 75 },
  instructions: "Rule this lord's voice as you like, for example: answer in short, regal sentences."
};

export class MemoryStore {
  // The standalone executable carries the curated lord profiles inside it, so a fresh
  // install never loses their lore or depends on the folder it was launched from.
  constructor(dataDir, {
    loreRoot = path.resolve("lore-profiles"),
    embeddedLore = typeof __LLMDIP_EMBEDDED_LORE__ === "object" ? __LLMDIP_EMBEDDED_LORE__ : {},
    customRoot = path.join(path.dirname(path.resolve(dataDir)), "custom")
  } = {}) {
    this.root = path.join(dataDir, "campaigns");
    this.loreRoot = loreRoot;
    this.customRoot = customRoot;
    this.embeddedLore = embeddedLore;
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

  digestFile(request) {
    return path.join(this.factionDir(request), "players", segment(request.sender, "sender"), "digests.json");
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

  // Every message of this pair in the loaded save branch, oldest first, each with the
  // node it belongs to.
  pairMessages(request) {
    // memoryParent is read from cm:get_saved_value(), so it represents the
    // exact conversation head contained in the loaded WH3 save. Walking that
    // parent chain keeps alternate save branches isolated from one another.
    const timeline = this.readTimeline(request);
    // A reply the player asked to redo is replaced by the new one and leaves the
    // conversation; its node stays in the chain so later saves still connect.
    const chain = this.lineage(timeline, request.memoryParent);
    const replaced = new Set(chain.map(node => node.supersedes).filter(Boolean));
    const all = chain
      .filter(node => !replaced.has(node.requestId))
      .filter(node => node.interlocutor === request.interlocutor && (!node.sender || node.sender === request.sender))
      .flatMap(node => Array.isArray(node.messages) ? node.messages
        // Legacy nodes have no scope field. They are still safe here because
        // their parent timeline is already isolated by campaign + sender and
        // the node itself is filtered to this interlocutor above. New nodes
        // carry an explicit triple so accidental cross-conversation copies are
        // rejected instead of silently entering the prompt.
        .filter(message => !message.scope || (message.scope.campaignId === request.campaignId && message.scope.sender === request.sender && message.scope.interlocutor === request.interlocutor))
        .map(message => ({...message, mode:message.mode || node.mode, nodeId:node.requestId,
          ...(node.execution ? { execution: node.execution } : {}),
          scope:{campaignId:request.campaignId,sender:request.sender,interlocutor:node.interlocutor}})) : []);
    return all;
  }

  history(request) {
    const all = this.pairMessages(request);
    // Preserve some actual player exchanges when many unanswered letters arrive.
    // Both windows come ONLY from this save lineage, never from memory.json or a
    // cross-branch summary. Historical offers remain offers, not executed facts.
    const recentStart = Math.max(0, all.length - 12);
    const anchors = all.slice(0, recentStart).filter(message => message.mode === 'player').slice(-8);
    return [...anchors, ...all.slice(recentStart)];
  }

  readDigests(request) {
    const data = readJson(this.digestFile(request), null);
    return data && typeof data.items === "object" && data.items ? data.items : {};
  }

  // The latest record in this save branch and the letters after it. A record is keyed by
  // the last node it covers, so it only applies to branches that contain that node: an
  // older save never sees a record of letters it does not have.
  digestState(request) {
    const all = this.pairMessages(request);
    const items = this.readDigests(request);
    let cut = -1, digest = null;
    for (let i = all.length - 1; i >= 0; i--) {
      const item = items[all[i].nodeId];
      if (item && typeof item.text === "string" && item.text.trim()) {
        digest = item;
        cut = i;
        while (cut + 1 < all.length && all[cut + 1].nodeId === all[i].nodeId) cut++;
        break;
      }
    }
    return { all, digest, after: all.slice(cut + 1) };
  }

  // What a letter is built from: the record (if any) and the recent letters. Without a
  // record this is exactly history(), so nothing changes until a record exists.
  recall(request) {
    const { digest, after } = this.digestState(request);
    if (!digest) return { digest: null, recent: this.history(request) };
    return { digest: { text: digest.text, throughTurn: digest.throughTurn }, recent: after.slice(-RECENT_AFTER_DIGEST) };
  }

  // The letters to fold next, or null when the record is still short enough.
  digestPlan(request) {
    const { digest, after } = this.digestState(request);
    const chars = after.reduce((sum, message) => sum + String(message.content || "").length, 0);
    if (after.length <= DIGEST_LIMIT_MESSAGES && chars <= DIGEST_LIMIT_CHARS) return null;
    let end = Math.min(after.length - DIGEST_KEEP_RAW, DIGEST_MAX_FOLD);
    // A node (the player's words and the reply) is folded whole or not at all.
    while (end > 0 && end < after.length && after[end].nodeId === after[end - 1].nodeId) end--;
    if (end <= 0) return null;
    const fold = after.slice(0, end);
    const last = fold.at(-1);
    return { previous: digest?.text || "", fold, throughNode: last.nodeId, throughTurn: last.turn };
  }

  saveDigest(request, plan, text) {
    const file = this.digestFile(request);
    const data = readJson(file, null) || {};
    const items = data.items && typeof data.items === "object" ? data.items : {};
    items[plan.throughNode] = { text, throughTurn: plan.throughTurn, folded: plan.fold.length, createdAt: new Date().toISOString() };
    // Old branches keep their own records; only the oldest are dropped.
    const keys = Object.keys(items).sort((a, b) => String(items[a].createdAt).localeCompare(String(items[b].createdAt)));
    for (const key of keys.slice(0, Math.max(0, keys.length - 60))) delete items[key];
    writeJson(file, { version: 1, items });
  }

  append(request, narrative, action, reaction) {
    this.hasRequest(request); // Reject foreign-ID collisions before writing anything.
    const previous = this.history(request);
    const timelineFile = this.timelineFile(request);
    const timeline = this.readTimeline(request);
    const speaker = identity => ({leader:identity?.leader || 'unknown', leaderSubtype:identity?.leaderSubtype || 'unknown'});
    const answer = { role: "assistant", content: narrative, turn: request.turn, mode:request.mode,
      speakerIdentity:speaker(request.identity), action, reaction };
    // Letters and greetings are the ruler speaking first: there are no player words to keep.
    const messages = !narrative ? [] : (request.mode === 'proactive' || request.mode === 'greeting') ? [
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
      ...(/^[a-z0-9_]{1,160}$/.test(request.fields?.regenerate_of || "") ? { supersedes: request.fields.regenerate_of } : {}),
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

  // Creates custom/ with its README and an example the first time; never overwrites.
  ensureCustomFolder() {
    const lords = path.join(this.customRoot, "lords");
    fs.mkdirSync(lords, { recursive: true });
    const readme = path.join(this.customRoot, "README.txt");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, CUSTOM_README, "utf8");
    const example = path.join(lords, "_example.json");
    if (!fs.existsSync(example)) writeJson(example, CUSTOM_EXAMPLE);
    return this.customRoot;
  }

  // The player's file for this lord (subtype first, then faction), or null.
  customLord(subtype, factionKey) {
    for (const key of [subtype, factionKey]) {
      if (!SAFE.test(key || "")) continue;
      const file = path.join(this.customRoot, "lords", `${key}.json`);
      if (!fs.existsSync(file)) continue;
      try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (value && typeof value === "object" && !Array.isArray(value)) return value;
      } catch (error) {
        console.warn(`[CUSTOM] ${file} is not valid JSON and is ignored: ${error.message}`);
      }
    }
    return null;
  }

  // The curated profile with the player's fields laid over it.
  withCustom(curated, subtype, factionKey) {
    const custom = this.customLord(subtype, factionKey);
    if (!custom) return curated;
    const merged = { ...curated };
    for (const field of CUSTOM_FIELDS) if (custom[field] !== undefined) merged[field] = custom[field];
    return merged;
  }

  // The player's own direction: for every lord, and for this one.
  customInstructions(subtype, factionKey) {
    const clip = value => typeof value === "string" ? value.trim().slice(0, CUSTOM_TEXT_LIMIT) : "";
    let general = "";
    try { general = clip(fs.readFileSync(path.join(this.customRoot, "instructions.txt"), "utf8")); } catch { general = ""; }
    return { general, lord: clip(this.customLord(subtype, factionKey)?.instructions) };
  }

  // Curated lore for a lord, without creating anything: the court's adviser uses it to
  // know its own ruler.
  curatedLore(subtype, factionKey) {
    const key = SAFE.test(subtype || "") ? subtype : "";
    const curated = (key && (this.embeddedLore[key] || readJson(path.join(this.loreRoot, `${key}.json`), null))) ||
      (SAFE.test(factionKey || "") && (this.embeddedLore[factionKey] || readJson(path.join(this.loreRoot, `${factionKey}.json`), null))) || {};
    return this.withCustom(curated, key, factionKey);
  }

  ensureProfile(request, identity) {
    const leaderKey = SAFE.test(identity.leaderSubtype || "") ? identity.leaderSubtype : "unknown_leader";
    const file = path.join(this.factionDir(request), "leaders", `${leaderKey}.json`);
    const current = readJson(file, null);
    // The lord's own profile comes first: a faction file would keep speaking as Karl Franz
    // after his successor took the throne.
    const curated = this.withCustom(this.embeddedLore[leaderKey] ||
      readJson(path.join(this.loreRoot, `${leaderKey}.json`), null) ||
      this.embeddedLore[request.interlocutor] ||
      readJson(path.join(this.loreRoot, `${request.interlocutor}.json`), {}), leaderKey, request.interlocutor);
    // Curated lore wins over the copy saved at first contact. That copy used to win,
    // so every lord met before a profile existed kept empty lore forever.
    const notes = field => Array.isArray(curated[field]) && curated[field].length ? curated[field]
      : (Array.isArray(current?.[field]) ? current[field] : []);
    const generatedStyle = buildSocialStyle(identity, request.interlocutor);
    const personality = current?.personality
      ? { ...current.personality, archetype: buildPersonality(identity, request.interlocutor).archetype }
      : buildPersonality(identity, request.interlocutor);
    const profile = {
      ...(current || {}),
      faction: request.interlocutor,
      leader: identity.leader || "unknown",
      leaderSubtype: identity.leaderSubtype || "unknown",
      culture: identity.culture || "unknown",
      subculture: identity.subculture || "unknown",
      // The archetype text is refreshed on every request so improved wording reaches
      // leaders saved before it; the numeric temperament stays as stored unless the
      // curated profile fixes it.
      personality: curated.temperament ? applyTemperament(personality, curated.temperament) : personality,
      socialStyle: applySocialStyle(current?.socialStyle?.signature === generatedStyle.signature ? current.socialStyle : generatedStyle, curated.socialStyle),
      canonNotes: notes("canonNotes"),
      voiceNotes: notes("voiceNotes"),
      voiceGender: ["male", "female", "other"].includes(curated.voiceGender) ? curated.voiceGender : (["male", "female", "other"].includes(current?.voiceGender) ? current.voiceGender : undefined),
      voiceIds: Array.isArray(curated.voiceIds) && curated.voiceIds.length ? curated.voiceIds : (Array.isArray(current?.voiceIds) ? current.voiceIds : []),
      ttsInstructions: typeof curated.ttsInstructions === "string" && curated.ttsInstructions ? curated.ttsInstructions : (typeof current?.ttsInstructions === "string" ? current.ttsInstructions : ""),
      sources: notes("sources"),
      note: "Identity and traits come from the game; the stable personality comes from the lore profile or is generated per lord. canonNotes refine specific lords."
    };
    writeJson(file, profile);
    return profile;
  }
}
