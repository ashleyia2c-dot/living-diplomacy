export const ACTION_TYPES = new Set([
  "reject", "declare_war", "make_peace", "alliance", "trade_agreement", "non_aggression_pact",
  "military_access", "transfer_region", "vassalize", "offer_gold", "request_gold", "favor", "betray_war"
]);

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
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 20000) throw new Error("amount must be an integer from 100 to 20000");
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
    else if (input.target !== undefined) throw new Error("target is allowed only for join_war");
  }
  return result;
}

export function validateReaction(input = {}) {
  const delta = Number(input.delta ?? 0);
  if (!Number.isSafeInteger(delta) || delta < -1 || delta > 1) throw new Error("reaction.delta must be -1, 0, or 1");
  const reason = enumValue(input.reason || "neutral", REACTION_REASONS, "reaction.reason");
  return { delta, reason };
}

export function compactAction(action) {
  const value = validateAction(action);
  switch (value.type) {
    case "alliance": return `alliance,${value.level}`;
    case "military_access": return `military_access,${value.direction}`;
    case "transfer_region": return `transfer_region,${value.region},${value.recipient}`;
    case "vassalize": return `vassalize,${value.master}`;
    case "offer_gold": case "request_gold": return `${value.type},${value.amount}`;
    case "favor": return `favor,${value.favor},${value.amount},${value.target || "none"}`;
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
  enumValue(mode, new Set(["player", "proactive"]), "mode");
  let message, state;
  try { message = decodeURIComponent(encodedMessage); state = decodeURIComponent(encodedState); }
  catch { throw new Error("REQUEST message has invalid percent encoding"); }
  if (!message.trim() || message.length > 1200) throw new Error("Message is empty or too long");
  if (state.length > 8000) throw new Error("Campaign state is too long");
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
      male: fields.ai_leader_male !== "0", traits: list("ai_leader_traits"),
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
