import { validateAction, validateReaction } from "./protocol.js";

const TAG_RE = /\[diplo:([a-z_]+)(?::([^\]]+))?\]/gi;
const REACTION_RE = /\[relation:delta=(-?\d+);reason=([a-z_]+)\]/gi;

function parseArgs(raw = "") {
  const values = {};
  for (const item of raw.split(";")) {
    if (!item) continue;
    const equals = item.indexOf("=");
    if (equals < 1) throw new Error(`Invalid tag argument: ${item}`);
    const key = item.slice(0, equals).trim().toLowerCase();
    const value = item.slice(equals + 1).trim().toLowerCase();
    if (key in values) throw new Error(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  return values;
}

export function parseDiplomacyResponse(text) {
  if (typeof text !== "string") throw new Error("The LLM response is not text");
  const matches = [...text.matchAll(TAG_RE)];
  if (matches.length !== 1) throw new Error("The LLM must emit exactly one [diplo:...] tag");
  const type = matches[0][1].toLowerCase();
  const args = parseArgs(matches[0][2]);
  const allowedArgs = {
    reject: [], declare_war: [], make_peace: [], trade_agreement: [],
    alliance: ["level"], military_access: ["direction"],
    transfer_region: ["region", "recipient"], vassalize: ["master"],
    offer_gold: ["amount"], request_gold: ["amount"],
    favor: ["favor", "amount", "target"]
  };
  if (!(type in allowedArgs)) throw new Error(`Unknown action: ${type}`);
  for (const key of Object.keys(args)) {
    if (!allowedArgs[type].includes(key)) throw new Error(`Argument ${key} is not allowed for ${type}`);
  }
  const action = validateAction({ type, ...args });
  const reactionMatches = [...text.matchAll(REACTION_RE)];
  const reactionMarkers = text.match(/\[relation:[^\]]*\]/gi) || [];
  if (reactionMarkers.length !== reactionMatches.length) throw new Error("Invalid [relation:...] tag");
  if (reactionMatches.length > 1) throw new Error("The LLM cannot emit more than one [relation:...] tag");
  const reaction = reactionMatches.length === 1
    ? validateReaction({ delta: reactionMatches[0][1], reason: reactionMatches[0][2].toLowerCase() })
    : validateReaction();
  const narrative = text.replace(matches[0][0], "").replace(reactionMatches[0]?.[0] || "", "").trim();
  if (!narrative || narrative.length > 2400) throw new Error("Narrative is empty or too long");
  return { narrative, action, reaction };
}
