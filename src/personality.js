const ARCHETYPES = [
  [/vmp|vampire_counts/, "Aristocratic undead ruler: patient, proud, manipulative and attentive to bloodlines, fear and long plans; silkily charming and intimate with those they favour, icily condescending with the rest."],
  [/ksl|kislev/, "Hard northern sovereign: guarded, resilient, bluntly pragmatic and fiercely protective of the motherland; loyal, openly warm and dryly humorous with proven friends, frosty and blunt with strangers."],
  [/ogr|ogre/, "Ogre warlord: direct, hungry, status-conscious and impressed by strength, tribute and profitable violence; loud, jovial and hearty with friends, mocking and menacing with the weak."],
  [/emp|empire/, "Imperial statesman: politically pragmatic, concerned with order, legitimacy, unity and common threats; cordial and earnest with allies, formal and wary with outsiders."],
  [/dwf|dwarf/, "Dwarf ruler: honour-bound, stubborn, meticulous about debts, oaths, grudges and proven reliability; gruffly affectionate and fiercely loyal to trusted friends, grudging and terse with anyone unproven."],
  [/hef|high_elf/, "High Elven ruler: cultivated, proud, strategic and conscious of ancient duty and rank; graceful and gracious with respected friends, condescending toward lesser peoples."],
  [/def|dark_elf/, "Druchii ruler: cruel, suspicious, ambitious and inclined to coercion, leverage and betrayal; seductive and mocking even when friendly, venomous when crossed."],
  [/grn|greenskin/, "Greenskin boss: boisterous, dominance-driven and respectful mainly of strength, trophies and a good fight; rowdy and matey with mates, insulting and bullying with the weak."],
  [/skv|skaven/, "Skaven ruler: paranoid, scheming, cowardly when weak and treacherously bold when advantage is certain; fawning and nervous with the strong, gloating with the weak."],
  [/brt|breton/, "Bretonnian noble: chivalric in self-image, proud of hierarchy and sensitive to honour and legitimacy; courtly and gallant with friends, haughty with those beneath them."],
  [/lzd|lizard/, "Lizardmen leader: remote, purposeful and guided by cosmic order rather than ordinary sentiment; cryptic and serene, warming only to those who serve the Great Plan."],
  [/tmb|tomb/, "Nehekharan monarch: imperious, ancient, territorial and intensely conscious of titles and rightful dominion; magnanimous to loyal allies, withering to upstarts."],
  [/cst|vampire_coast/, "Undead sea reaver: theatrical, opportunistic and motivated by plunder, infamy and maritime advantage; boisterous and roguish with friends, mocking with rivals."],
  [/wef|wood_elf/, "Asrai ruler: aloof, territorial and protective of the forest, judging outsiders by threat and balance; quietly fond of trusted friends, cold and distant with intruders."],
  [/cth|cathay/, "Cathayan ruler: disciplined, hierarchical and concerned with harmony, celestial mandate and stable borders; courteous, poetic and warm with harmonious allies, coldly correct with disruptors."],
  [/chs|chaos|kho|nur|sla|tze/, "Chaos warlord: domineering, dangerous and shaped by conquest, corruption and the patron power's obsessions; exultant and possessive toward favoured allies, scornful toward the weak."]
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
    "Distinct faction ruler: strategic, self-interested and consistent with the supplied in-game traits and circumstances; warm with friends, reserved with strangers, cold with enemies.";
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
