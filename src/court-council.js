// The council of courts (docs/PLAN_CONSEJO_DE_CORTES.md). At the start of the player's
// turn the game writes one COURTS line with what each enabled court can know. Here each
// court gets its private dispatch for the turn: its mood, how it sees things, up to two
// plans, a grievance and the rumour it wants spread. The game checks every plan before
// anything happens; this file only asks, validates and answers through the inbox.
import { luaString } from "./lua-renderer.js";

const MARKER = "[LLMDIP] COURTS|";
const SAFE_KEY = /^[a-z0-9_]{1,160}$/;
const GAME_LANGUAGE_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  ru: "Russian", pl: "Polish", cs: "Czech", tr: "Turkish", ko: "Korean",
  pt: "Brazilian Portuguese", zh: "Simplified Chinese", tw: "Traditional Chinese"
};
export const AI_PLANS = ["ally", "war", "peace", "trade", "nap"];
export const PLAYER_PLANS = ["ask_player_help", "offer_player", "threaten_player", "court_player", "warn_player", "complain_to_player"];
export const MOODS = ["confident", "worried", "furious", "grieving", "vengeful", "triumphant", "scheming", "fearful", "content", "ambitious"];
export const RUMOUR_KINDS = ["romance", "betrayal", "jealousy", "contempt", "servility", "ambition", "scheme", "praise", "warning", "scandal"];
// Three courts per call and room for the model's hidden reasoning (see player2-client.js).
export const COURTS_PER_CALL = 3;
export const COURTS_MAX_TOKENS = 8000;
export const COURTS_TIMEOUT_MS = 150000;

export function parseCourtsRequest(line) {
  const start = line.indexOf(MARKER);
  if (start < 0) return null;
  const parts = line.slice(start + MARKER.length).trim().split("|");
  if (parts.length !== 6) throw new Error("Incomplete COURTS request");
  const [id, campaignId, player, turnText, language, encoded] = parts;
  for (const [field, value] of [["id", id], ["campaignId", campaignId], ["player", player]]) {
    if (!SAFE_KEY.test(value)) throw new Error(`COURTS ${field} is not a safe key`);
  }
  if (!/^courts_\d{1,5}_\d{1,12}$/.test(id)) throw new Error("COURTS id has an unexpected form");
  const turn = Number(turnText);
  if (!Number.isInteger(turn) || turn < 0) throw new Error("COURTS turn is invalid");
  let facts;
  try { facts = decodeURIComponent(encoded); } catch { throw new Error("COURTS facts are badly encoded"); }
  if (!facts.includes("#REALM ") || facts.length > 16000) throw new Error("COURTS facts are empty or too long");
  const [header, ...rest] = facts.split(/\n(?=#REALM )/);
  const realms = rest.map(block => {
    const key = /^#REALM ([a-z0-9_]+)/.exec(block)?.[1];
    // A court may only aim at realms its own facts name: what it cannot know, it cannot plan.
    const known = new Set([...block.matchAll(/\[([a-z0-9_]{3,160})\]/g)].map(match => match[1]));
    return key && SAFE_KEY.test(key) ? { key, block, known } : null;
  }).filter(Boolean);
  if (!realms.length) throw new Error("COURTS request names no realm");
  return {
    id, campaignId, player, turn, language: GAME_LANGUAGE_NAMES[language] ? language : "en", header, realms,
    romance: /Romance rumours: allowed/.test(header)
  };
}

export function buildCourtsMessages(request, realms, languageOverride) {
  const language = languageOverride || GAME_LANGUAGE_NAMES[request.language] || "English";
  const system = `You run the private councils of several realms in Total War: WARHAMMER III, one court at a time. For each realm below, write what its court thinks and decides at the start of this turn, as its ruler would: in character with their people, their ruler's lore and personality, and the facts.
The facts come from the game and are true. You may add only feelings, intentions, plans and rumours. Never invent battles, treaties, deaths, conquests or other events that are not in the facts.
Each court knows only its own facts block: never let one court use another court's facts.

For each realm return an object with:
- "realm": the realm key.
- "mood": one of ${MOODS.join(", ")}.
- "stance": one sentence in English: how the ruler sees their situation now.
- "plans": up to two decisions, each {"do": ..., "target": ..., "why": short English reason, "announce": ...}.
  "do" is one of: ${AI_PLANS.join(", ")} (with another realm; "target" is its key in square brackets from this court's facts), ${PLAYER_PLANS.join(", ")} (with the player; "target" is "player"), or consolidate ("target" "").
  "announce" (only for ${AI_PLANS.join(", ")}): one sentence in ${language}, to be published if it really happens, naming each realm and its ruler with their realm, telling what happened and why, like a chronicler. Example of the form only: "Katarin of Kislev seals an alliance with ...".
- "grievance": optional {"against": a realm key or "player", "why": short English}.
- "rumour": what this court wants whispered about someone (every court spreads one, unless it truly has nothing to gain): {"about": [one or two realm keys from its facts, or the player's key], "kind": one of ${RUMOUR_KINDS.join(", ")}, "text": one or two sentences in ${language}, at most 220 characters, saying where it is said ("At the court of ... they say that ...") and naming every character together with their own realm, naturally, as "Katarin of the Ice Court" would be said in that language; never realm keys, brackets or the words of the facts}.

HOW A SHREWD RULER DECIDES (the game will refuse anything else):
- War only against a realm the court can plausibly beat (compare "times as strong" in its facts) and has a motive to fight: a grievance, an old hatred or rivalry, a rumour it heard, an enemy of its ally. Never against a far stronger realm, an ally or a pact partner. At most one war plan. A realm already in two or more wars looks for peace or allies instead.
- A weak or hard-pressed realm seeks allies, peace or the player's help, and consolidates.
- Alliances, pacts and trade go to realms the court is fond of, or that share its enemies.
- Peace with an enemy when the war goes badly, or when that enemy also wants it.
- Plans with the player become a letter the player may refuse: use them when the court has a real reason (needs help, has an offer, a grievance, a warning, wants the player's favour). Not every court writes every turn.
- Each court's facts list the "Moves the game would accept now". Choose among them what this ruler would really do and why; anything else is refused. When the list is not empty, at least one plan is one of those moves.
- Plans with the player are letters: only one or two courts in the whole list write to the player in a turn, those with the strongest reason. The others deal with their neighbours.
- A living court acts. Most courts take one concrete step each turn: an alliance, a pact, trade, peace, a war it can win, or a letter to the player. "consolidate" only when nothing else makes sense; the game itself refuses anything unwise, so propose what this ruler would really try.
- Keep continuity with what the court thought last turn, and react to the rumours it heard: believe them or not depending on who spread them, and let them move its plans (seek an explanation, an ally, revenge).
- Respect each people's nature: servants of Chaos never beg, Dwarfs remember every grudge, Skaven scheme, and so on.

RUMOURS are the life of the courts: love affairs, suspected betrayals, jealousy, envy, humiliation, bootlicking, ambition, secret dealings, insults, scandal, praise that hides a dagger. They are about characters and what moves them, never a plain fact anyone can see in diplomacy (not "X hates Y", not "X is at war with Y"). A rumour may be a lie the court spreads for its own interest. Each rumour is this court's own new invention, said at its own court: never repeat a rumour it heard, and never spread one that shames itself. ${request.romance ? "Romance rumours are allowed, where the peoples involved make it believable." : "No romance rumours this campaign."}

Output ONLY JSON: {"courts": [ ... one object per realm ... ]}. No markdown, no commentary.`;
  const user = `${request.header}

${realms.map(realm => realm.block).join("\n\n")}

Write the dispatch of each of these ${realms.length} courts now.`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

function clip(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

export function extractJson(raw) {
  const text = String(raw ?? "").replace(/```[a-z]*\n?/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the answer");
  return JSON.parse(text.slice(start, end + 1));
}

// "[wh_main_emp_empire]" -> "wh_main_emp_empire": models often copy the brackets of the facts.
function realmKey(value) {
  return typeof value === "string" ? value.trim().replace(/^\[|\]$/g, "") : value;
}

// Keep only what the game can use: known keys, listed choices, short texts.
export function validateCourts(json, realms, request) {
  const byKey = new Map(realms.map(realm => [realm.key, realm]));
  const result = [];
  for (const court of Array.isArray(json?.courts) ? json.courts : []) {
    const realm = byKey.get(realmKey(court?.realm));
    if (!realm || result.some(item => item.f === realm.key)) continue;
    const entry = { f: realm.key, mood: MOODS.includes(court.mood) ? court.mood : "content", stance: clip(court.stance, 200), plans: [] };
    let wars = 0;
    for (const plan of Array.isArray(court.plans) ? court.plans : []) {
      if (entry.plans.length >= 2 || !plan || typeof plan.do !== "string") continue;
      plan.target = realmKey(plan.target);
      const why = clip(plan.why, 160);
      if (AI_PLANS.includes(plan.do)) {
        const announce = clip(String(plan.announce || "").replace(/\s*\[[a-z0-9_]+\]/g, ""), 260);
        if (!realm.known.has(plan.target) || plan.target === realm.key || plan.target === request.player || announce.length < 15) continue;
        if (plan.do === "war" && ++wars > 1) continue;
        entry.plans.push({ d: plan.do, t: plan.target, why, an: announce });
      } else if (PLAYER_PLANS.includes(plan.do)) {
        entry.plans.push({ d: plan.do, t: "player", why });
      } else if (plan.do === "consolidate") {
        entry.plans.push({ d: "consolidate", t: "", why });
      }
    }
    const grievance = court.grievance && { ...court.grievance, against: realmKey(court.grievance.against) };
    if (grievance && (grievance.against === "player" || realm.known.has(grievance.against)) && grievance.against !== realm.key) {
      entry.gr = { t: grievance.against === request.player ? "player" : grievance.against, why: clip(grievance.why, 160) };
    }
    const rumour = court.rumour;
    if (rumour && RUMOUR_KINDS.includes(rumour.kind) && !(rumour.kind === "romance" && !request.romance)) {
      const about = (Array.isArray(rumour.about) ? rumour.about : []).map(realmKey)
        .filter(key => typeof key === "string" && (realm.known.has(key) || key === realm.key || key === request.player)).slice(0, 2);
      // Keys copied from the facts never reach the player.
      const text = clip(String(rumour.text || "").replace(/\s*\[[a-z0-9_]+\]/g, ""), 260);
      if (about.length && text.length >= 20) entry.r = { k: rumour.kind, about, tx: text };
    }
    result.push(entry);
  }
  return result;
}

function luaValue(value) {
  if (typeof value === "string") return luaString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `{${value.map(luaValue).join(", ")}}`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([key]) => /^[a-z][a-z0-9_]*$/.test(key))
      .map(([key, item]) => `${key} = ${luaValue(item)}`).join(", ")}}`;
  }
  return "nil";
}

export function renderCourtsInbox(id, courts) {
  return `if llmdip_world_courts then llmdip_world_courts(${luaString(id)}, ${luaValue(courts)}) end\n`;
}

export function renderCourtsFailed(id) {
  return `if llmdip_world_courts_failed then llmdip_world_courts_failed(${luaString(id)}) end\n`;
}

// The courts in groups small enough for one answer each.
export function courtGroups(realms, size = COURTS_PER_CALL) {
  const groups = [];
  for (let i = 0; i < realms.length; i += size) groups.push(realms.slice(i, i + size));
  return groups;
}
