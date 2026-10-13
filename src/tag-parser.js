import { validateAction, validateReaction } from "./protocol.js";

const TAG_RE = /\[diplo:([a-z_]+)(?::([^\]]+))?\]/gi;
const REACTION_RE = /\[relation:delta=(-?\d+);reason=([^\]\s;]+)\]/giu;
// The ruler ends the audience for the rest of the turn (0.45).
const TALK_END_RE = /\[talk:\s*end\]/gi;

// The model sometimes writes the reason in the player's language ("credibilidad",
// 03-10-2026), which used to fail the whole letter. Known words are mapped back; an
// unknown one takes the plain reason that fits the delta.
const REASON_WORDS = {
  respect: ["respect", "respeto", "respect", "respekt", "rispetto", "уважение", "szacunek", "respekt", "saygı", "respeito", "尊重", "존중"],
  insult: ["insult", "insulto", "insulte", "beleidigung", "insulto", "оскорбление", "obraza", "urážka", "hakaret", "insulto", "侮辱", "모욕"],
  threat: ["threat", "amenaza", "menace", "drohung", "minaccia", "угроза", "groźba", "hrozba", "tehdit", "ameaça", "威胁", "威脅", "위협"],
  empathy: ["empathy", "empatia", "empathie", "empatia", "эмпатия", "empatie", "empati", "共情", "同理心", "공감"],
  credibility: ["credibility", "credibilidad", "credibilite", "glaubwurdigkeit", "credibilita", "доверие", "wiarygodnosc", "duveryhodnost", "guvenilirlik", "credibilidade", "可信", "可信度", "신뢰"],
  repetition: ["repetition", "repeticion", "repetition", "wiederholung", "ripetizione", "повтор", "powtorzenie", "opakovani", "tekrar", "repeticao", "重复", "重複", "반복"],
  neutral: ["neutral", "neutro", "neutre", "neutrale", "нейтрально", "neutralny", "neutralni", "notr", "中立", "중립"]
};
function reasonFor(raw, delta) {
  const word = String(raw || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
  for (const [reason, words] of Object.entries(REASON_WORDS)) if (words.includes(word)) return reason;
  return Number(delta) > 0 ? "respect" : Number(delta) < 0 ? "insult" : "neutral";
}

function parseArgs(raw = "") {
  const values = {};
  for (const item of raw.split(";")) {
    if (!item) continue;
    const equals = item.indexOf("=");
    if (equals < 1) throw new Error(`Invalid tag argument: ${item}`);
    const key = item.slice(0, equals).trim().toLowerCase();
    const value = item.slice(equals + 1).trim().toLowerCase();
    if (key in values) throw new Error(`Repeated argument: ${key}`);
    values[key] = value;
  }
  return values;
}

export function parseDiplomacyResponse(text) {
  if (typeof text !== "string") throw new Error("LLM response is not text");
  const matches = [...text.matchAll(TAG_RE)];
  if (matches.length !== 1) throw new Error("LLM must emit exactly one [diplo:...] tag");
  const type = matches[0][1].toLowerCase();
  const args = parseArgs(matches[0][2]);
  const allowedArgs = {
    reject: [], declare_war: [], betray_war: [],
    // A treaty the player pays for carries its price on the same tag.
    make_peace: ["price"], trade_agreement: ["price"], non_aggression_pact: ["price"],
    alliance: ["level", "price"], military_access: ["direction", "price"],
    transfer_region: ["region", "recipient"], vassalize: ["master"],
    offer_gold: ["amount"], request_gold: ["amount"],
    favor: ["favor", "amount", "target"],
    broker: ["act", "target", "price"]
  };
  if (!(type in allowedArgs)) throw new Error(`Unknown action: ${type}`);
  for (const key of Object.keys(args)) {
    if (!allowedArgs[type].includes(key)) throw new Error(`Argument ${key} is not allowed for ${type}`);
  }
  const action = validateAction({ type, ...args });
  const reactionMatches = [...text.matchAll(REACTION_RE)];
  const reactionMarkers = text.match(/\[relation:[^\]]*\]/gi) || [];
  if (reactionMarkers.length !== reactionMatches.length) throw new Error("Invalid [relation:...] tag");
  if (reactionMatches.length > 1) throw new Error("LLM must not emit more than one [relation:...] tag");
  const reaction = reactionMatches.length === 1
    ? validateReaction({ delta: reactionMatches[0][1], reason: reasonFor(reactionMatches[0][2], reactionMatches[0][1]) })
    : validateReaction();
  // The game's text fields show markdown literally ("**Hueste de los Trillizos**", 03-10-2026).
  const endsTalk = TALK_END_RE.test(text);
  TALK_END_RE.lastIndex = 0;
  const narrative = text.replace(matches[0][0], "").replace(reactionMatches[0]?.[0] || "", "").replace(TALK_END_RE, "")
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/\*\*/g, "").trim();
  if (!narrative || narrative.length > 2400) throw new Error("Narrative is empty or too long");
  return { narrative, action, reaction, endsTalk };
}
