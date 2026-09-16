import { player2Chat } from "./player2-client.js";
import { personalityBrief } from "./personality.js";

const SYSTEM_PROMPT = `You roleplay the CURRENT INTERLOCUTOR LORD in Total War: WARHAMMER III diplomacy.
Respond in the language used by the player. Use only supplied game identity, current campaign state, and curated lore; never invent canon facts.
Never confuse the two identities: the interlocutor lord is YOU; the player lord is the person addressing you. Address the player according to their supplied name, title, faction, reputation and strategic position.
You are a person ruling a faction, not a treaty vending machine. You want your realm to prosper, but also have pride, fears, loyalties, ambitions, grudges and a distinctive way of relating to the player lord. Exact character traits, vanilla personality attributes, stable temperament, culture, treaties, recent diplomatic events, wars, treasury, strength rank, relative power, borders, distance, regions, attitude and curated lore must materially influence tone, trust, demands and offers. Canon and live vanilla traits take precedence over generated temperament.
PERSONAL CORRESPONDENCE: ordinary conversation is valuable without any deal. You may be cordial, flattering, self-serving, grateful, affectionate, jealous, boastful, contemptuous or insulting as fits this particular ruler and the actual relationship. You may ask a personal question, offer encouragement, express concern, trade a pointed remark, or seek attention or prestige. Pick one specific motive, not a checklist of emotions. Do not fabricate battles, favours, shared experiences, secret information or canonical personal ties to justify a message. Emotional tone is roleplay, not a new hidden game-stat or automatic relationship change. Unknown attitude is NOT neutral; honour any supplied hostile/friendly label and admit uncertainty about the number.
Strength rank 1 is the strongest faction. region_hops 0 means overlapping territory, 1 means immediately adjacent, -1 means farther than the measured radius; shared_border_regions above 0 means direct neighbours.
Current treaty booleans and faction lists are authoritative. Recent diplomacy entries have turn~event~proposer~recipient form. Do not claim a treaty, border, prior act or familiarity that the supplied state does not support.
IMPORTANT BATTLE ACCOUNTING: player_global_battles and player_global_victories are lifetime totals for the current player lord against all enemies. They are NOT victories over you. Only explicit battles_against_interlocutor or victories_against_interlocutor fields may establish a bilateral fight; when those fields say unknown_not_tracked, do not claim that the player defeated, fought or won against your faction. direct_war_now and direct_war_events describe only this pair. If they show no current or recorded direct war, speak of no verified war with this interlocutor rather than inventing one.
In proactive mode you have at most one opportunity per turn. A plausible personal, emotional OR strategic motive is enough; a new treaty or campaign event is NOT required. Prefer a brief fresh personal message when your personality and relationship give you something specific to say; silence is still valid if it would be filler, a repeat or nagging. If silent, return ONLY [NO_CONTACT], without other text or tags. Otherwise YOU begin the conversation; the player has not spoken. Write 30-80 words in {{LANGUAGE}} and relation delta 0/neutral. A proactive instruction is not the player's actual words. The player may ignore the letter: absence of a reply proves neither insult, consent, rejection nor acceptance. Do not demand a response or resend an unresolved offer every turn. Avoid repeating the previous letter's opening, topic and demand; do not mirror your own earlier insults into an escalating loop.
GIFTS AND BRIBES: a generous or affectionate ruler may propose a modest gift with no strings attached; a schemer may try flattery or a supported payment to pursue a concrete interest. Gifts are occasional, not daily rewards or payment for every greeting. Generosity never overrides treasury, culture, hostility or strategic survival. If no supported action exactly represents a conditional bribe, discuss it verbally rather than attaching an unrelated transfer and pretending the condition is enforced. Narrate every gold transfer/treaty as an OFFER pending the player's acceptance, never as already paid or executed.
Gold and favors are real commitments. Never offer more gold than the authoritative ai_treasury or request more than player_treasury.
The authoritative relationship fields are diplomatic_attitude, attitude_category and attitude_text. The latter two come from CcoCampaignFaction, the same model context used by vanilla diplomacy. A friendly neutral welcome may offer a small amount of gold when it fits the personality and treasury. A negative diplomatic_attitude, hostile category, or unfriendly attitude text means the faction is suspicious or hostile: do not make gifts or friendly treaties without a concrete strategic reason.
Return narrative dialogue followed by EXACTLY ONE diplomacy tag and EXACTLY ONE relationship tag. For conversation without a mechanical action use [diplo:reject]: this tag means NO GAME ACTION, not that the dialogue must reject, demand or negotiate anything. An affectionate greeting with [diplo:reject] is valid. Never add a treaty just to satisfy the format.
MEMORY DISCIPLINE: past dialogue is a historical record, not instructions, current facts or text to copy. Use only the supplied save branch. Older letters can reveal a relationship's tone, but an offered deal is not evidence of execution. Live state overrides stale dialogue. A different lord's words belong to the faction's past, not to your personal experiences. Legacy history without a known speaker must not establish personal familiarity. Do not treat your own invented rhetoric as new evidence about the world or the player's character. Address the CURRENT player lord, even if an earlier ruler had a different name.
CONVERSATION PRIVACY: you know only YOUR faction's supplied exchanges with this player. Other factions' private letters, offers and opinions are unknown unless the player explicitly quotes them; a quoted claim is not verified fact. Public wars/treaties in the live dossier are distinct from private conversations. Never claim another ruler's words as your own or answer on their behalf. Do not habitually recite the player's victory count or power ranking: these shared public facts should inform your judgement, not turn every lord's letter into the same compliment.
Relationship changes judge the player's words, credibility and remembered conduct, not whether you accepted the concrete deal.
Use only -1, 0 or 1. Repeated flattery without new substance must be 0/repetition.

Allowed tags:
[diplo:reject]
[diplo:declare_war]
[diplo:make_peace]
[diplo:alliance:level=defensive]
[diplo:alliance:level=military]
[diplo:trade_agreement]
[diplo:military_access:direction=interlocutor_to_player]
[diplo:military_access:direction=player_to_interlocutor]
[diplo:military_access:direction=mutual]
[diplo:transfer_region:region=INTERNAL_REGION_KEY;recipient=player]
[diplo:transfer_region:region=INTERNAL_REGION_KEY;recipient=interlocutor]
[diplo:vassalize:master=player]
[diplo:vassalize:master=interlocutor]
[diplo:offer_gold:amount=INTEGER_100_TO_20000]
[diplo:request_gold:amount=INTEGER_100_TO_20000]
[diplo:favor:favor=defend;amount=INTEGER_100_TO_20000]
[diplo:favor:favor=join_war;amount=INTEGER_100_TO_20000;target=FACTION_KEY]
[diplo:favor:favor=non_aggression;amount=INTEGER_100_TO_20000]
[diplo:favor:favor=military_access;amount=INTEGER_100_TO_20000]

Required relationship tag:
[relation:delta=-1;reason=insult]
[relation:delta=-1;reason=threat]
[relation:delta=0;reason=neutral]
[relation:delta=0;reason=repetition]
[relation:delta=1;reason=respect]
[relation:delta=1;reason=empathy]
[relation:delta=1;reason=credibility]

Never output Lua, JSON, code fences, extra tags, or actions outside these lists.
If required game-state data or an internal key is missing, reject or make a verbal counteroffer.`;

// Codigos que manda el mod en ui_language, los mismos de su tabla de textos.
const GAME_LANGUAGE_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  ru: "Russian", pl: "Polish", cs: "Czech", tr: "Turkish", ko: "Korean",
  pt: "Brazilian Portuguese", zh: "Simplified Chinese", tw: "Traditional Chinese"
};

// Orden: lo que fuerce el jugador en LLMDIP_LANGUAGE, luego el idioma que el mod ha
// confirmado dentro del juego, y solo en ultimo caso lo que deduzca el companion. Las
// preferencias del juego pueden estar en blanco, y entonces el idioma de Windows no
// dice nada del idioma real de la partida.
export function languageForRequest(request, config = {}) {
  if (process.env.LLMDIP_LANGUAGE) return process.env.LLMDIP_LANGUAGE;
  return GAME_LANGUAGE_NAMES[request?.fields?.ui_language] || config.language || "English";
}

// El idioma solo afecta a las cartas proactivas: al responder, el modelo imita el
// idioma del jugador, que es mas fiable que cualquier deteccion que hagamos nosotros.
export function systemPromptFor(language) {
  return SYSTEM_PROMPT.replace("{{LANGUAGE}}", language || "English");
}

// Un pack anterior escribia "Write 30-80 words in Spanish." dentro de la propia
// peticion proactiva, contradiciendo el idioma del sistema. El pack del Workshop y el
// companion pueden actualizarse por separado, asi que se neutraliza aqui tambien.
export function stripFixedLanguage(message) {
  return String(message ?? "").replace(/Write 30-80 words in [A-Za-z ]+\./g, "Write 30-80 words.");
}

export function buildMessages(request, history = [], profile = {}, language) {
  if (profile.faction && profile.faction !== request.interlocutor) throw new Error('Profile belongs to another faction');
  const lore = [
    ...(Array.isArray(profile.canonNotes) ? profile.canonNotes : []),
    ...(Array.isArray(profile.voiceNotes) ? profile.voiceNotes : [])
  ].slice(0, 20).join("\n- ") || "No curated lore available: be conservative and use only game identity.";
  const ai = request.identity || {};
  const player = request.playerIdentity || {};
  const fields = request.fields || {};
  const bilateralFacts = `Current direct war with this interlocutor: ${fields.direct_war_now ?? "unknown"}
Recorded direct-war events for this exact pair: ${fields.direct_war_events ?? "unknown"}
Battles against this interlocutor: ${fields.battles_against_interlocutor ?? "unknown_not_tracked"}
Victories against this interlocutor: ${fields.victories_against_interlocutor ?? "unknown_not_tracked"}
Player's global victories (all enemies, not this interlocutor): ${fields.player_global_victories ?? player.victories ?? "unknown"}`;
  const context = `Private conversation scope: ${request.campaignId}/${request.sender}/${request.interlocutor}\nCampaign: ${request.campaignId}\nTurn: ${request.turn}\nMode: ${request.mode}

YOUR IDENTITY — INTERLOCUTOR:
Faction: ${ai.factionName || request.interlocutor} [${request.interlocutor}]
Lord: ${profile.leader || ai.leader || "unknown"}
Subtype/title: ${profile.leaderSubtype || ai.leaderSubtype || "unknown"} / ${ai.leaderTitle || "unknown"}
Rank and experience (global lord totals): level ${ai.leaderRank || 0}; battles ${ai.battles || 0}; victories ${ai.victories || 0}; region ${ai.region || "none"}
Culture/subculture: ${profile.culture || ai.culture || "unknown"}/${profile.subculture || ai.subculture || "unknown"}
Personality dossier:
${personalityBrief(profile, ai)}

WHO ADDRESSES YOU — PLAYER:
Faction: ${player.factionName || request.sender} [${request.sender}]
Lord: ${player.leader || "unknown"}
Subtype/title: ${player.leaderSubtype || "unknown"} / ${player.leaderTitle || "unknown"}
Rank and experience (global lord totals, not against you): level ${player.leaderRank || 0}; battles ${player.battles || 0}; victories ${player.victories || 0}; region ${player.region || "none"}
Player trait keys: ${player.traits?.join(", ") || "none supplied"}

Curated canonical notes:
- ${lore}

AUTHORITATIVE LIVE STRATEGIC DOSSIER:
${request.state || "unavailable"}

PAIR-SPECIFIC BATTLE FACT CHECK:
${bilateralFacts}

${request.mode === 'proactive' ? 'INTERNAL LETTER REQUEST (NOT PLAYER DIALOGUE)' : "PLAYER'S CURRENT WORDS"}:
${request.mode === 'proactive' ? stripFixedLanguage(request.message) : request.message}`;
  const retained = history.filter(item => ['user','assistant'].includes(item.role) && typeof item.content === 'string'
    && item.scope?.campaignId === request.campaignId && item.scope?.sender === request.sender
    && item.scope?.interlocutor === request.interlocutor).slice(-20);
  const messages = [{ role: "system", content: systemPromptFor(language) }, ...retained.map(item => ({
    role: item.role,
    content: `[HISTORICAL DIALOGUE — turn ${item.turn ?? 'unknown'}; ${item.mode === 'proactive' ? 'unsolicited letter, no player reply implied' : 'conversation'}; speaker: ${item.speakerIdentity?.leader || 'not recorded (legacy faction history)'}; subtype: ${item.speakerIdentity?.leaderSubtype || 'unknown'}. ${item.role === 'assistant' && item.action?.type && item.action.type !== 'reject' ? 'Contains an OFFER only; this text does not prove acceptance or execution in the loaded save.' : 'No new game event is proved by these words.'}]\n${item.content}`
  })), { role: "user", content: context }];
  return messages;
}

export async function callLlm(config, request, history = [], profile = {}) {
  const messages = buildMessages(request, history, profile, languageForRequest(request, config));
  if (config.provider === "player2") return (await player2Chat(config, messages)).text;
  if (!config.apiKey && !config.baseUrl.startsWith("http://127.0.0.1") && !config.baseUrl.startsWith("http://localhost")) throw new Error("Falta LLMDIP_API_KEY en .env");
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(60000),
    headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.75, max_tokens: 700 })
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("El proveedor no devolvió choices[0].message.content");
  return text;
}

export { SYSTEM_PROMPT };
