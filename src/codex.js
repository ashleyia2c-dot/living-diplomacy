// The campaign codex: Living Diplomacy's version of Ashley's lorebook. Background is
// split into entries with trigger words, and an entry joins a prompt only when one of
// its words turns up in what is being said. Most entries come from the game itself:
// once a turn it sends every realm with its names as the player sees them, in the
// player's language, so the same code works in all thirteen languages. Lords' lore
// comes from lore-profiles/, peoples, gods and places from codex-data.js.
import fs from "node:fs";
import path from "node:path";
import { PEOPLES, TOPICS, GENERIC_WORDS } from "./codex-data.js";

const MARKER = "[LLMDIP] CODEX|";
const SAFE_KEY = /^[a-z0-9_]{1,160}$/;
// What anyone at court would know about a name, not a biography: a whole life story in
// the prompt crowds out the conversation and confuses the model (03-10-2026).
export const CODEX_BUDGET = 800;
export const CODEX_MAX_ENTRIES = 4;
const LINE_LIMIT = 170;

// The first sentence, cut at a word if it is still too long.
export function firstSentence(text, limit = LINE_LIMIT) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  let sentence = end >= 0 ? clean.slice(0, end + 1) : clean;
  if (sentence.length > limit) {
    sentence = sentence.slice(0, limit);
    sentence = `${sentence.slice(0, Math.max(sentence.lastIndexOf(" "), 40)).replace(/[,;:]$/, "")}…`;
  }
  return sentence;
}
// Articles a realm's name may start with ("La Corte de Hielo" is also "Corte de Hielo").
const ARTICLES = /^(the|el|la|los|las|le|les|l'|der|die|das|il|lo|gli|i|o|a|os|as)\s+/i;
// Scripts written without spaces between words: matched anywhere in the text.
const NO_SPACES = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

export function parseCodexLine(line) {
  const start = line.indexOf(MARKER);
  if (start < 0) return null;
  const parts = line.slice(start + MARKER.length).trim().split("|");
  if (parts.length !== 5) throw new Error("Incomplete CODEX line");
  const [campaignId, player, turnText, language, encoded] = parts;
  if (!SAFE_KEY.test(campaignId) || !SAFE_KEY.test(player)) throw new Error("CODEX keys are not safe");
  const turn = Number(turnText);
  if (!Number.isInteger(turn) || turn < 0) throw new Error("CODEX turn is invalid");
  let text;
  try { text = decodeURIComponent(encoded); } catch { throw new Error("CODEX is badly encoded"); }
  if (text.length > 20000) throw new Error("CODEX is too long");
  const realms = text.split("\n").map(row => row.split("\t")).filter(cells => cells.length >= 8 && SAFE_KEY.test(cells[0]))
    .map(([key, name, people, subculture, ruler, subtype, rank, settlements, player]) => ({
      key, name: name.trim(), people: people.trim(), subculture: subculture.trim(), ruler: ruler.trim(),
      subtype: subtype.trim(), rank: Number(rank) || 0, settlements: Number(settlements) || 0, player: player === "player"
    }));
  return { campaignId, player, turn, language, realms };
}

// Lower case, without accents, so "Bastión" matches "bastion" and "CORTE" matches "corte".
export function normalise(text) {
  // NFC again afterwards: NFD also splits Korean syllables into letters.
  return String(text ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").replace(/\s+/g, " ");
}

function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function mentions(haystack, key) {
  const k = normalise(key).trim();
  // Chinese and Korean names are often two characters ("恐虐"); elsewhere three at least.
  if (NO_SPACES.test(k)) return k.length >= 2 && haystack.includes(k);
  if (k.length < 3) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(k)}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

// The words that call up one realm: its full name, the name without its article (unless
// that leaves one common word, "Imperio"), and its ruler's name and first name.
// Titles are not names: "Gran Reina Khalida" must not fire on every "gran".
const TITLES = new Set(["tzarina", "zarina", "tsarina", "gran", "great", "grand", "grande", "king", "queen", "rey", "reina",
  "roi", "reine", "konig", "konigin", "re", "regina", "lord", "lady", "prince", "principe", "princess", "high", "supreme",
  "sumo", "the", "von", "van", "der", "de", "la", "el"]);

function realmKeys(realm, profileName = "") {
  const keys = new Set();
  const add = value => {
    const v = String(value || "").trim();
    if (v.length < 3) return;
    if (!v.includes(" ") && (GENERIC_WORDS.has(normalise(v)) || TITLES.has(normalise(v)))) return;
    keys.add(v);
  };
  add(realm.name);
  add(realm.name.replace(ARTICLES, ""));
  if (realm.ruler && realm.ruler !== realm.name) {
    add(realm.ruler);
    add(realm.ruler.split(",")[0]);
  }
  // The curated profile's name ("Tzarina Katarin", "Vlad von Carstein"): the whole name,
  // and its first and last words when they are names rather than titles.
  if (profileName) {
    const plain = profileName.split(",")[0].trim();
    add(profileName); add(plain);
    const words = plain.split(/\s+/);
    for (const word of [words[0], words[words.length - 1]]) if (word && word.length >= 4) add(word);
  }
  return [...keys];
}

export class Codex {
  constructor(dataDir, memory = null) {
    this.root = path.join(dataDir, "campaigns");
    this.memory = memory;
    this.cache = new Map();
  }

  file(campaignId) { return path.join(this.root, campaignId, "codex.json"); }

  store(index) {
    this.cache.set(index.campaignId, index);
    try {
      fs.mkdirSync(path.dirname(this.file(index.campaignId)), { recursive: true });
      fs.writeFileSync(this.file(index.campaignId), JSON.stringify(index), "utf8");
    } catch { /* The codex is a convenience: letters work without it. */ }
  }

  load(campaignId) {
    if (!SAFE_KEY.test(campaignId || "")) return null;
    if (this.cache.has(campaignId)) return this.cache.get(campaignId);
    try {
      const index = JSON.parse(fs.readFileSync(this.file(campaignId), "utf8"));
      this.cache.set(campaignId, index);
      return index;
    } catch { return null; }
  }

  // Every entry this campaign can offer: its realms, their rulers' lore, the peoples in
  // the game, and the gods and places everyone knows.
  entries(campaignId) {
    const index = this.load(campaignId);
    const result = [];
    for (const realm of index?.realms || []) {
      const ruler = realm.ruler && realm.ruler !== realm.name ? `, ruled by ${realm.ruler}` : "";
      const people = realm.people ? `, a realm of the ${realm.people}` : "";
      const power = realm.rank > 0 ? ` Strength rank ${realm.rank} in the world (1 is the strongest); ${realm.settlements} settlements.` : "";
      let lore = "";
      // Only the lord's own profile, never the faction file: a successor is not Karl Franz.
      const profile = SAFE_KEY.test(realm.subtype || "") ? this.memory?.curatedLore(realm.subtype, "") : null;
      const notes = profile?.canonNotes;
      if (Array.isArray(notes) && notes.length) lore = ` ${realm.ruler || "Its ruler"}: ${firstSentence(notes[0])}`;
      result.push({ id: `realm:${realm.key}`, realm: realm.key, people: realm.subculture, keys: realmKeys(realm, typeof profile?.name === "string" ? profile.name : ""),
        text: `${realm.name}${people}${ruler}.${power}${lore}`, order: 1 });
      if (realm.people && PEOPLES[realm.subculture] && !result.some(entry => entry.id === `people:${realm.subculture}`)) {
        result.push({ id: `people:${realm.subculture}`, keys: [realm.people], text: firstSentence(PEOPLES[realm.subculture], 200), order: 2 });
      }
    }
    TOPICS.forEach((topic, i) => result.push({ id: `topic:${i}`, keys: topic.keys, text: firstSentence(topic.text, 200), order: 3 }));
    return result;
  }

  // The entries called up by these texts, in order of priority (the player's words
  // first), within the budget. The lord's own realm and the player's are left out:
  // nobody needs to be told who they are.
  select(campaignId, texts = [], { exclude = [], budget = CODEX_BUDGET } = {}) {
    const entries = this.entries(campaignId).filter(entry => !exclude.includes(entry.realm));
    const chosen = [];
    let used = 0;
    for (const text of texts) {
      const haystack = normalise(text);
      if (!haystack.trim()) continue;
      const hits = entries.filter(entry => !chosen.includes(entry) && entry.keys.some(key => mentions(haystack, key)))
        .sort((a, b) => a.order - b.order);
      // A realm brings its people along: who the Host of the Triplets is says little
      // without knowing they are warriors of Chaos.
      const withPeople = [];
      for (const entry of hits) {
        withPeople.push(entry);
        const people = entry.people && entries.find(item => item.id === `people:${entry.people}`);
        if (people && !hits.includes(people)) withPeople.push(people);
      }
      for (const entry of withPeople) {
        if (chosen.length >= CODEX_MAX_ENTRIES) break;
        if (chosen.includes(entry) || used + entry.text.length > budget) continue;
        chosen.push(entry);
        used += entry.text.length;
      }
    }
    return chosen;
  }

  block(campaignId, texts, options) {
    const chosen = this.select(campaignId, texts, options);
    if (!chosen.length) return "";
    return `WHAT YOU KNOW OF THE NAMES MENTIONED (general knowledge every ruler has; treat it as something you already know, not as news; treaties and feelings come from the other blocks):
${chosen.map(entry => `- ${entry.text}`).join("\n")}

`;
  }
}
