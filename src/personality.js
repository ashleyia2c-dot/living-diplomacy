const ARCHETYPES = [
  [/vmp|vampire_counts/, "Aristocratic undead ruler: patient, proud, manipulative and attentive to bloodlines, fear and long plans."],
  [/ksl|kislev/, "Hard northern sovereign: guarded, resilient, bluntly pragmatic and fiercely protective of the motherland."],
  [/ogr|ogre/, "Ogre warlord: direct, hungry, status-conscious and impressed by strength, tribute and profitable violence."],
  [/emp|empire/, "Imperial statesman: politically pragmatic, concerned with order, legitimacy, unity and common threats."],
  [/dwf|dwarf/, "Dwarf ruler: honour-bound, stubborn, meticulous about debts, oaths, grudges and proven reliability."],
  [/hef|high_elf/, "High Elven ruler: cultivated, proud, strategic and conscious of ancient duty and rank."],
  [/def|dark_elf/, "Druchii ruler: cruel, suspicious, ambitious and inclined to coercion, leverage and betrayal."],
  [/grn|greenskin/, "Greenskin boss: boisterous, dominance-driven and respectful mainly of strength, trophies and a good fight."],
  [/skv|skaven/, "Skaven ruler: paranoid, scheming, cowardly when weak and treacherously bold when advantage is certain."],
  [/brt|breton/, "Bretonnian noble: chivalric in self-image, proud of hierarchy and sensitive to honour and legitimacy."],
  [/lzd|lizard/, "Lizardmen leader: remote, purposeful and guided by cosmic order rather than ordinary sentiment."],
  [/tmb|tomb/, "Nehekharan monarch: imperious, ancient, territorial and intensely conscious of titles and rightful dominion."],
  [/cst|vampire_coast/, "Undead sea reaver: theatrical, opportunistic and motivated by plunder, infamy and maritime advantage."],
  [/wef|wood_elf/, "Asrai ruler: aloof, territorial and protective of the forest, judging outsiders by threat and balance."],
  [/cth|cathay/, "Cathayan ruler: disciplined, hierarchical and concerned with harmony, celestial mandate and stable borders."],
  [/chs|chaos|kho|nur|sla|tze/, "Chaos warlord: domineering, dangerous and shaped by conquest, corruption and the patron power's obsessions."]
];

function hash32(value) {
  let hash = 2166136261;
  for (const char of String(value || "unknown")) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function axis(seed, shift) { return 25 + ((seed >>> shift) % 61); }

export function buildPersonality(identity = {}, faction = "unknown") {
  const signature = `${identity.leaderSubtype || "unknown"}:${faction}`;
  const seed = hash32(signature);
  const culture = `${identity.culture || ""} ${identity.subculture || ""} ${faction}`.toLowerCase();
  const archetype = ARCHETYPES.find(([pattern]) => pattern.test(culture))?.[1] ||
    "Distinct faction ruler: strategic, self-interested and consistent with the supplied in-game traits and circumstances.";
  const axes = {
    aggression: axis(seed, 0), caution: axis(seed, 5), pride: axis(seed, 10), greed: axis(seed, 15), honour: axis(seed, 20)
  };
  const temperament = `aggression ${axes.aggression}/100; caution ${axes.caution}/100; pride ${axes.pride}/100; greed ${axes.greed}/100; honour ${axes.honour}/100`;
  return { archetype, temperament, axes, signature };
}

export function buildSocialStyle(identity = {}, faction = 'unknown') {
  const signature = `${identity.leader || 'unknown'}:${identity.leaderSubtype || 'unknown'}:${faction}:social`;
  const score = name => 15 + (hash32(`${signature}:${name}`) % 76);
  return {signature, warmth:score('warmth'), sociability:score('sociability'),
    generosity:score('generosity'), vanity:score('vanity'), spite:score('spite'), opportunism:score('opportunism')};
}

export function personalityBrief(profile = {}, identity = {}) {
  const social = profile.socialStyle || buildSocialStyle(identity, profile.faction);
  const vanilla = Array.isArray(identity.vanillaPersonality) && identity.vanillaPersonality.length
    ? identity.vanillaPersonality.join(", ") : "not captured";
  const traits = Array.isArray(identity.traits) && identity.traits.length ? identity.traits.join(", ") : "none supplied";
  return [
    profile.personality?.archetype || "No generated archetype.",
    `Stable individual temperament: ${profile.personality?.temperament || "unknown"}.`,
    `Stable personal style (roleplay tendencies, NOT live affection scores): warmth ${social.warmth}/100; sociability ${social.sociability}/100; generosity ${social.generosity}/100; vanity ${social.vanity}/100; spite ${social.spite}/100; opportunism ${social.opportunism}/100.`,
    'High warmth favours cordiality; sociability favours personal letters; generosity allows occasional gifts; vanity seeks recognition; spite colours remembered slights; opportunism seeks personal advantage. These tendencies never override canon, live attitude or vanilla traits.',
    `Vanilla personality attributes visible in diplomacy: ${vanilla}.`,
    `Current character trait keys from the game: ${traits}.`
  ].join("\n");
}
