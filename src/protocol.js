// How the game and the companion talk: the inbox calls, the [LLMDIP] log lines and
// the request format. Raise COMPANION_PROTOCOL only when an older partner could no
// longer understand the other; releases that keep it work with the companion
// players already have. The game announces its own number and the oldest companion
// it accepts in a "PROTOCOL|<pack>|<min companion>" log line.
// 2 (0.45): greetings when an audience opens, [talk:end] and brokered deals.
export const COMPANION_PROTOCOL = 2;
// Packs older than the protocol line (0.42.x) understand protocol 1 as well.
export const MIN_PACK_PROTOCOL = 0;

// What to tell the player when the game announces its protocol; empty if all is well.
export function protocolAdvice(packProtocol, minCompanion) {
  if (COMPANION_PROTOCOL < minCompanion) {
    return "This companion is older than your Living Diplomacy mod. Download the new companion (your conversations are kept): https://github.com/ashleyia2c-dot/living-diplomacy/releases/latest";
  }
  if (packProtocol < MIN_PACK_PROTOCOL) return "Your Living Diplomacy mod is older than this companion. Let Steam finish updating the mod.";
  return "";
}

export const ACTION_TYPES = new Set([
  "reject", "declare_war", "make_peace", "alliance", "trade_agreement", "non_aggression_pact",
  "military_access", "transfer_region", "vassalize", "offer_gold", "request_gold", "favor", "betray_war",
  "broker"
]);

// Treaties a ruler may sell: the player pays `price` gold when the treaty is signed,
// in the same step. The game signs first, checks the treaty really exists and only
// then takes the gold, so the player never pays for a pact the game refused.
// A brokered deal (the ruler makes peace with, or goes to war against, a third realm
// at the player's request) may carry a price the same way.
export const PRICED_TREATIES = new Set(["make_peace", "alliance", "trade_agreement", "non_aggression_pact", "military_access", "broker"]);

const SAFE_KEY = /^[a-z0-9_]{1,160}$/;
const FAVOR_TYPES = new Set(["defend", "join_war", "non_aggression", "military_access"]);
const REACTION_REASONS = new Set(["respect", "insult", "threat", "empathy", "credibility", "repetition", "neutral"]);

function enumValue(value, choices, field) {
  if (!choices.has(value)) throw new Error(`Invalid ${field}: ${value}`);
  return value;
}

function safeKey(value, field) {
  if (typeof value !== "string" || !SAFE_KEY.test(value)) throw new Error(`${field} must be a safe internal game key`);
  return value;
}

function goldAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 20000) throw new Error("amount must be an integer between 100 and 20000");
  return amount;
}

export function validateAction(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Action must be an object");
  const type = enumValue(input.type, ACTION_TYPES, "type");
  const result = { type };
  if (type === "alliance") result.level = enumValue(input.level, new Set(["defensive", "military"]), "level");
  else if (type === "military_access") result.direction = enumValue(input.direction || "interlocutor_to_player", new Set(["interlocutor_to_player", "player_to_interlocutor", "mutual"]), "direction");
  else if (type === "transfer_region") {
    result.region = safeKey(input.region, "region");
    result.recipient = enumValue(input.recipient, new Set(["player", "interlocutor"]), "recipient");
  } else if (type === "vassalize") result.master = enumValue(input.master, new Set(["player", "interlocutor"]), "master");
  else if (type === "offer_gold" || type === "request_gold") result.amount = goldAmount(input.amount);
  else if (type === "favor") {
    result.favor = enumValue(input.favor, FAVOR_TYPES, "favor");
    result.amount = goldAmount(input.amount);
    if (result.favor === "join_war") result.target = safeKey(input.target, "target");
    else if (input.target !== undefined) throw new Error("target is only allowed for join_war");
  } else if (type === "broker") {
    result.act = enumValue(input.act, new Set(["peace", "war"]), "act");
    result.target = safeKey(input.target, "target");
  }
  if (input.price !== undefined) {
    if (!PRICED_TREATIES.has(type)) throw new Error(`price is not allowed for ${type}`);
    result.price = goldAmount(input.price);
  }
  return result;
}

export function validateReaction(input = {}) {
  const delta = Number(input.delta ?? 0);
  if (!Number.isSafeInteger(delta) || delta < -1 || delta > 1) throw new Error("reaction.delta must be -1, 0 or 1");
  const reason = enumValue(input.reason || "neutral", REACTION_REASONS, "reaction.reason");
  return { delta, reason };
}

export function compactAction(action) {
  const value = validateAction(action);
  // A priced treaty ends with price_N; packs older than 0.44 ignore the extra field.
  const price = value.price ? `,price_${value.price}` : "";
  switch (value.type) {
    case "alliance": return `alliance,${value.level}${price}`;
    case "military_access": return `military_access,${value.direction}${price}`;
    case "make_peace": case "trade_agreement": case "non_aggression_pact": return `${value.type}${price}`;
    case "transfer_region": return `transfer_region,${value.region},${value.recipient}`;
    case "vassalize": return `vassalize,${value.master}`;
    case "offer_gold": case "request_gold": return `${value.type},${value.amount}`;
    case "favor": return `favor,${value.favor},${value.amount},${value.target || "none"}`;
    case "broker": return `broker,${value.act},${value.target}${price}`;
    default: return value.type;
  }
}

export function parseBridgeRequest(line) {
  const marker = "[LLMDIP] REQUEST|";
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const parts = line.slice(start + marker.length).trim().split("|");
  if (parts.length !== 7) throw new Error("Incomplete bridge REQUEST v2");
  const [requestId, campaignId, sender, interlocutor, mode, encodedState, encodedMessage] = parts;
  for (const [field, value] of [["requestId", requestId], ["campaignId", campaignId], ["sender", sender], ["interlocutor", interlocutor]]) safeKey(value, field);
  // greeting: the player opened an audience; the ruler speaks first (0.45).
  enumValue(mode, new Set(["player", "proactive", "greeting"]), "mode");
  let message, state;
  try { message = decodeURIComponent(encodedMessage); state = decodeURIComponent(encodedState); }
  catch { throw new Error("REQUEST message has invalid percent-encoding"); }
  if (!message.trim() || message.length > 1200) throw new Error("Message is empty or too long");
  // 0.43 adds what the lord has heard of the wider world (world_news, court_gossip,
  // at most 1200 characters together) to a dossier that already runs to a few thousand.
  if (state.length > 12000) throw new Error("Campaign state is too long");
  const fields = Object.fromEntries(state.split(",").map(value => {
    const at = value.indexOf("="); return at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, ""];
  }));
  const memoryParent = fields.memory_parent || "root";
  const memoryHead = fields.memory_head || requestId;
  safeKey(memoryParent, "memory_parent");
  safeKey(memoryHead, "memory_head");
  if (memoryHead !== requestId) throw new Error("memory_head does not match requestId");
  const number = key => Number(fields[key] || 0);
  const flag = key => fields[key] === "1";
  const list = key => !fields[key] || fields[key] === "none" ? [] : fields[key].split(":").filter(Boolean);
  return {
    requestId, campaignId, sender, interlocutor, mode, state, fields,
    message: message.trim(), turn: number("turn"), memoryParent, memoryHead,
    identity: {
      factionName: fields.ai_faction_name || interlocutor,
      leader: fields.ai_leader, leaderSubtype: fields.ai_leader_subtype,
      leaderTitle: fields.ai_leader_title || "", leaderDescription: fields.ai_leader_description || "",
      leaderRank: number("ai_leader_rank"), unique: flag("ai_leader_unique"), immortal: flag("ai_leader_immortal"),
      // ai_leader_male is not read: the game reports 1 for every lord, women included.
      traits: list("ai_leader_traits"),
      battles: number("ai_leader_battles"), victories: number("ai_leader_victories"), region: fields.ai_leader_region || "none",
      vanillaPersonality: list("ai_vanilla_personality"), culture: fields.ai_culture, subculture: fields.ai_subculture
    },
    playerIdentity: {
      factionName: fields.player_faction_name || sender,
      leader: fields.player_leader, leaderSubtype: fields.player_leader_subtype,
      leaderTitle: fields.player_leader_title || "", leaderDescription: fields.player_leader_description || "",
      leaderRank: number("player_leader_rank"), unique: flag("player_leader_unique"), immortal: flag("player_leader_immortal"),
      traits: list("player_leader_traits"), battles: number("player_leader_battles"),
      victories: number("player_leader_victories"), region: fields.player_leader_region || "none"
    }
  };
}
