// Betrayals. Every other action the AI takes through this mod is a proposal the player
// accepts or rejects; a betrayal is the one thing that happens without asking. The code
// decides whether a ruler CAN betray the player right now (treaty to break, a treacherous
// nature, an advantage, cooldowns, a dice roll); the model decides, in character, whether
// it DOES. Effect: the faction declares war on the player (which ends every treaty).
import fs from "node:fs";
import path from "node:path";
import { powerStance } from "./personality.js";

export const BETRAYAL_CHANCE = 0.35;
export const GLOBAL_COOLDOWN_TURNS = 10;

const TREATIES = [
  ["mil_alliance", "military alliance"], ["def_alliance", "defensive alliance"], ["allied", "alliance"],
  ["trade", "trade agreement"], ["access", "military access"], ["nap", "non-aggression pact"]
];

const count = value => typeof value === "string" ? value.split(":").filter(key => key && key !== "none").length : 0;

export class BetrayalStore {
  constructor(dataDir) { this.dataDir = dataDir; }
  file(campaignId) { return path.join(this.dataDir, "campaigns", campaignId, "betrayals.json"); }
  read(campaignId) {
    try { return JSON.parse(fs.readFileSync(this.file(campaignId), "utf8")); } catch { return { events: [] }; }
  }
  record(request) {
    const data = this.read(request.campaignId);
    data.events.push({ turn: request.turn, sender: request.sender, interlocutor: request.interlocutor, requestId: request.requestId });
    fs.mkdirSync(path.dirname(this.file(request.campaignId)), { recursive: true });
    fs.writeFileSync(this.file(request.campaignId), JSON.stringify(data, null, 2));
  }
}

// Returns { offered, hint, treaties, motives }. `offered` means the model may emit
// [diplo:betray_war] in this letter; `hint` means it may only foreshadow.
// test: LLMDIP_BETRAYAL_TEST=1 offers it to any treaty partner in every letter, so the
// system can be tried in a real campaign without waiting for the right conditions.
export function betrayalOpportunity(request, profile = {}, store, { enabled = true, random = Math.random, test = false } = {}) {
  const none = { offered: false, hint: false, treaties: [], motives: [] };
  if (!enabled || request.mode !== "proactive") return none;
  const fields = request.fields || {};
  if (fields.direct_war_now === "1" || fields.war === "1") return none;
  const treaties = [...new Set(TREATIES.filter(([key]) => fields[key] === "1").map(([, name]) => name))];
  if (!treaties.length) return none;

  const ai = request.identity || {};
  const stance = powerStance(`${profile.culture || ai.culture || ""} ${profile.subculture || ai.subculture || ""}`);
  const honour = Number(profile.personality?.axes?.honour ?? 50);
  const opportunism = Number(profile.socialStyle?.opportunism ?? 0);
  const schemer = honour <= 35 && opportunism >= 60;
  if (test) return { offered: true, hint: false, treaties, motives: ["an opening has appeared (test mode)"], nature: stance.betrays ? "culture" : "schemer" };
  if (!stance.betrays && !schemer) return none;

  const ratio = Number(fields.relative_power_ratio);
  const playerWars = count(fields.player_wars);
  const motives = [];
  if (Number.isFinite(ratio) && ratio <= 1) motives.push("your realm is now at least as strong as theirs");
  if (Number.isFinite(ratio) && ratio <= 2 && playerWars >= 3) motives.push(`they are tied down in ${playerWars} wars`);
  const nearAdvantage = Number.isFinite(ratio) && ratio <= 1.5;

  // A merely opportunistic lord of an honest culture does not stab a friend in the back.
  const category = Number(fields.attitude_category);
  const friendly = Number.isFinite(category) && category >= 4;
  const history = store ? store.read(request.campaignId).events : [];
  const alreadyBetrayed = history.some(event => event.sender === request.sender && event.interlocutor === request.interlocutor);
  const lastTurn = history.filter(event => event.sender === request.sender).reduce((last, event) => Math.max(last, Number(event.turn) || 0), -Infinity);
  const cooledDown = Number(request.turn) - lastTurn >= GLOBAL_COOLDOWN_TURNS;

  const eligible = motives.length > 0 && !alreadyBetrayed && cooledDown && (stance.betrays || !friendly);
  const offered = eligible && random() < BETRAYAL_CHANCE;
  const hint = !offered && !alreadyBetrayed && (eligible || (stance.betrays && nearAdvantage));
  return { offered, hint, treaties, motives, nature: stance.betrays ? "culture" : "schemer" };
}

export function betrayalBlock(opportunity) {
  if (opportunity.offered) {
    return `

BETRAYAL OPPORTUNITY (real, this letter only): the game will let your faction betray the player right now. Treaties between you: ${opportunity.treaties.join(", ")}. What makes it tempting: ${opportunity.motives.join("; ")}.
${opportunity.nature === "culture"
    ? "Your people betray allies whenever it pays, and this is exactly such a moment. Unless something specific in your supplied character or situation stops you, take it; a friendly surface is no reason to hold back, it only makes the knife more satisfying."
    : "You are a low-honour opportunist, and this is the kind of chance you wait for. Take it unless something specific in your supplied character or situation makes it clearly unwise."}
To betray, use [diplo:betray_war] as this letter's diplomacy tag: your faction declares war on the player IMMEDIATELY, without their acceptance, ending every treaty between you. This overrides the ordinary letter instructions above. If you betray, the whole letter is the betrayal: say plainly that you are breaking your pact and going to war with them, then gloat, justify, mock or coldly explain as your character would. Never praise the pact or wish them well in a betrayal letter, and do not present it as a proposal. If you hold back, do not mention this opportunity; you may still let slip a veiled hint of ambition.`;
  }
  if (opportunity.hint) {
    return `

SCHEMING (flavour only): betrayal of this treaty partner has crossed your mind (${opportunity.treaties.join(", ")}). You may let slip a double meaning or a veiled hint of ambition, without announcing or threatening anything, and you cannot betray them in this letter.`;
  }
  return "";
}

// The tag is only valid when the code granted the opportunity; anything else is
// downgraded to a plain letter so the model can never betray on its own.
export function enforceBetrayal(parsed, opportunity) {
  if (parsed.action?.type !== "betray_war" || opportunity.offered) return parsed;
  return { ...parsed, action: { type: "reject" } };
}

// With the choice and the letter in one call, the model often wrote a loyal-sounding
// letter and betrayed in the same breath (25-09). Once it has chosen to betray, a
// second call writes only the announcement.
export const BETRAYAL_LETTER_REQUEST = "You have just decided to betray the player: your faction is breaking every treaty with them and declaring war on them right now, this very turn. Write the letter that announces it (30-80 words), in character. Say plainly that the pact is over and that it is war, then gloat, justify, mock or coldly explain as your character would. Do not praise the pact, do not wish them well, do not claim you are still loyal, and do not propose anything. End with [diplo:betray_war] and [relation:delta=0;reason=neutral].";
