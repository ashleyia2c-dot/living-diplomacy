// What a ruler is willing to give away, decided by the campaign rather than by the
// model's mood. A friendly model concedes whatever it is asked for; these limits keep
// land and gold for the moments a real ruler would part with them: when far weaker,
// or when buying their way out of a war they are losing.

const list = value => typeof value === "string"
  ? value.split(":").map(key => key.trim()).filter(key => key && key !== "none" && key !== "unknown")
  : [];

const isDwarf = fields => /_dwf_/.test(`${fields.ai_culture || ""} ${fields.ai_subculture || ""}`.toLowerCase());

// player strength / ai strength, as the pack sends it.
function ratioOf(fields) {
  const ratio = Number(fields.relative_power_ratio);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

const atWar = fields => String(fields.war) === "1" || String(fields.direct_war_now) === "1";

// Why the ruler would hand over land at all, or null when it would not.
export function cessionReason(fields = {}) {
  const ratio = ratioOf(fields);
  if (ratio === null) return null;
  const regions = Number(fields.ai_settlements);
  if (Number.isFinite(regions) && regions <= 1) return null;
  const war = atWar(fields);
  // Dwarfs never sign away a hold unless the war is already lost.
  if (isDwarf(fields)) return war && ratio >= 3 ? "losing_war" : null;
  if (war && ratio >= 1.5) return "losing_war";
  if (ratio >= 3) return "far_weaker";
  return null;
}

// The ruler's own regions it could cede now: none of the key settlements.
export function cedableRegions(fields = {}) {
  if (!cessionReason(fields)) return [];
  const keys = new Set([...list(fields.ai_key_regions), ...list(fields.ai_capital)]);
  return list(fields.ai_regions).filter(key => !keys.has(key));
}

export function regionCessionAllowed(fields = {}, region = "") {
  if (!cessionReason(fields)) return false;
  const keys = new Set([...list(fields.ai_key_regions), ...list(fields.ai_capital)]);
  if (keys.has(region)) return false;
  // The region list stops at 12; a region beyond it may still be theirs, and the
  // game checks ownership when the deal is carried out.
  return true;
}

// The most gold the ruler would hand over in one deal. Gifts are small; paying for
// peace or protection when outmatched costs more.
export function goldCap(fields = {}, kind = "offer_gold") {
  const treasury = Number(fields.ai_treasury);
  if (!Number.isFinite(treasury) || treasury < 100) return 0;
  const ratio = ratioOf(fields) ?? 1;
  const pressed = ratio >= 3 || (atWar(fields) && ratio >= 1.5);
  const share = kind === "favor" ? (pressed ? 0.4 : 0.25) : (pressed ? 0.35 : 0.1);
  const cap = Math.min(20000, Math.floor((treasury * share) / 100) * 100);
  return cap >= 100 ? cap : 0;
}

// A short block for the prompt, so the model offers only what the ruler would give.
export function dealLimitsBlock(fields = {}) {
  const lines = ["WHAT YOU ARE WILLING TO GIVE (the game enforces this; an offer beyond it fails):"];
  const regions = cedableRegions(fields);
  if (regions.length) {
    const why = cessionReason(fields) === "losing_war"
      ? "you are losing this war and land may buy peace"
      : "you are far weaker and land may buy their goodwill";
    lines.push(`- Land: ${why}. Only these regions of yours could be ceded: ${regions.join(", ")}. Never your capital or a province capital.`);
  } else {
    lines.push("- Land: you cede none of your regions now. Only a ruler losing a war or far weaker parts with land, and never with its capital or a province capital.");
  }
  const gift = goldCap(fields, "offer_gold");
  const favor = goldCap(fields, "favor");
  if (gift) lines.push(`- Gold: at most ${gift} in a single offer_gold, and at most ${favor} for a paid favour. Gold is never a greeting gift: give it only for something concrete, to buy peace or protection, or as a rare gesture to a proven close friend.`);
  else lines.push("- Gold: your treasury cannot spare any gold now.");
  return lines.join("\n");
}

// Checks the action the model chose. Returns null when it is within limits, or the
// reason it is not, written for the model so it can answer again.
export function dealViolation(action = {}, fields = {}) {
  if (action.type === "transfer_region" && action.recipient === "player") {
    if (!regionCessionAllowed(fields, action.region)) {
      return cessionReason(fields)
        ? `you offered ${action.region}, which is your capital or a province capital; a ruler never signs those away`
        : "you offered one of your regions, but you are neither losing a war nor far weaker, so you would not cede land";
    }
  }
  if (action.type === "offer_gold") {
    const cap = goldCap(fields, "offer_gold");
    if (Number(action.amount) > cap) return cap ? `you offered ${action.amount} gold, more than the ${cap} you would part with` : "you offered gold your treasury cannot spare";
  }
  if (action.type === "favor") {
    const cap = goldCap(fields, "favor");
    if (Number(action.amount) > cap) return cap ? `you offered ${action.amount} gold for a favour, more than the ${cap} you would pay` : "you offered to pay gold your treasury cannot spare";
  }
  // What the player pays, as a payment or as the price of a treaty: never more than
  // they have, or the game refuses the deal when they accept it.
  const playerTreasury = Number(fields.player_treasury);
  const asked = action.type === "request_gold" ? Number(action.amount) : Number(action.price || 0);
  if (asked && Number.isFinite(playerTreasury) && asked > playerTreasury) {
    return `you asked the player for ${asked} gold, but their treasury holds only ${Math.max(0, Math.floor(playerTreasury))}`;
  }
  return null;
}
