// What every ruler of the Warhammer world knows about its peoples, gods and famous
// places, for the campaign codex (src/codex.js). The text is English, like the rest of
// the instructions; the keys are written in the game's languages. A people's keys come
// from the game itself (its localised name), so only gods and places list them here.
// Keys that do not match the official translation simply never fire.

// By subculture key: who a people is, in one or two sentences.
export const PEOPLES = {
  wh_main_sc_emp_empire: "The Empire of Sigmar: the largest human realm of the Old World, a quarrelsome confederation of provinces ruled by an elected Emperor. Its people worship Sigmar, field state troops with gunpowder, and train battle wizards in the Colleges of Magic.",
  wh_main_sc_brt_bretonnia: "Bretonnia: a chivalric human kingdom west of the Empire, ruled by knights sworn to the Lady of the Lake while their peasants toil. Honour, oaths and the quest for the Grail matter above all.",
  wh_main_sc_dwf_dwarfs: "The Dwarfs (dawi) of the mountain holds of the Karaz Ankor: master smiths and engineers, proud, stubborn and long-lived. They record every wrong done to them in the Book of Grudges and never forget a debt.",
  wh_main_sc_grn_greenskins: "Greenskins: orcs and goblins who live to fight. The biggest boss leads, and a great Waaagh! sweeps whole tribes to war. They worship Gork and Mork.",
  wh_main_sc_grn_savage_orcs: "Savage orcs: primitive greenskin tribes of the southlands and the Badlands, painted with warpaint and led by wild shamans of Gork and Mork.",
  wh_main_sc_vmp_vampire_counts: "The Vampire Counts: vampire lords who rule Sylvania and other cursed lands, raising the dead as their armies. The von Carstein bloodline has tried more than once to seize the Empire.",
  wh_main_sc_nor_norsca: "Norsca: the frozen northern land of raiders and marauder tribes who worship the Chaos Gods, sail south to plunder and tame monsters.",
  wh_main_sc_chs_chaos: "The Warriors of Chaos: mortal champions in black armour who serve the Dark Gods and seek their favour through conquest. Archaon the Everchosen would lead them to end the world.",
  wh_dlc03_sc_bst_beastmen: "The Beastmen: goat-headed children of Chaos who lurk in the deep forests in warherds and hate every work of civilisation.",
  wh_dlc05_sc_wef_wood_elves: "The Wood Elves (Asrai) of Athel Loren, the enchanted forest, which they guard without mercy. The Everqueen Ariel and the King in the Woods, Orion, rule them with the forest spirits.",
  wh2_main_sc_hef_high_elves: "The High Elves (Asur) of Ulthuan: an ancient, proud and refined people, masters of magic and the sea, ruled by the Phoenix King and the Everqueen. They guard the Great Vortex that drains the winds of magic.",
  wh2_main_sc_def_dark_elves: "The Dark Elves (Druchii) of Naggaroth: exiled elves led by Malekith, the Witch King, and his mother Morathi. Cruel slavers and corsairs who worship Khaine, the god of murder.",
  wh2_main_sc_lzd_lizardmen: "The Lizardmen of Lustria: servants of the vanished Old Ones. The ancient Slann mage-priests follow the Great Plan, and their saurus and skinks fight to restore the world's order.",
  wh2_main_sc_skv_skaven: "The Skaven: ratmen of the Under-Empire who worship the Horned Rat. They are ruled by the scheming Council of Thirteen, use warpstone sorcery and machines, and betray each other constantly.",
  wh2_dlc09_sc_tmb_tomb_kings: "The Tomb Kings of Nehekhara: dead kings and their legions, woken from their tombs by Nagash's great ritual. Proud, ancient and bound by old law, they seek to restore their lost glory.",
  wh2_dlc11_sc_cst_vampire_coast: "The Vampire Coast: undead pirates of the Lustrian shore led by vampire captains, with cannons, zombie crews and sea monsters.",
  wh3_main_sc_ksl_kislev: "Kislev: the hardy northern human realm on the edge of the Chaos Wastes, which has always stood first against Chaos. They worship the bear god Ursun; their Ice Witches command winter. Tzarina Katarin and Patriarch Kostaltyn of the Great Orthodoxy dispute how Kislev should be led.",
  wh3_main_sc_cth_cathay: "Grand Cathay: the great empire of the far east, ruled by the Dragon Emperor and his dragon children. It seeks harmony between Yin and Yang, and its Great Bastion holds back the Chaos hordes of the north.",
  wh3_main_sc_ogr_ogre_kingdoms: "The Ogre Kingdoms of the Mountains of Mourn: huge, hungry ogres who live to eat and worship the Great Maw. Tribes follow the strongest Tyrant, and many hire themselves out as mercenaries.",
  wh3_main_sc_kho_khorne: "Khorne: the Blood God of slaughter and martial pride. His daemons and berserkers want only skulls and blood; he despises sorcery.",
  wh3_main_sc_nur_nurgle: "Nurgle: the Plague God of disease, decay and stubborn endurance. His followers are cheerful in their rot and spread his gifts as a blessing.",
  wh3_main_sc_sla_slaanesh: "Slaanesh: the Dark Prince of excess, pleasure, pride and perfection. Its followers chase every sensation and seduce rather than conquer.",
  wh3_main_sc_tze_tzeentch: "Tzeentch: the Changer of Ways, god of sorcery, change and endless schemes. Its followers plot within plots.",
  wh3_main_sc_dae_daemons: "The Daemons of Chaos: hosts of daemons and daemon princes of all the Dark Gods, Chaos Undivided.",
  wh3_dlc23_sc_chd_chaos_dwarfs: "The Chaos Dwarfs (Dawi Zharr) of Zharr-Naggrund in the Dark Lands: dwarfs who turned to Hashut, the Father of Darkness. Brutal slavers and industrialists ruled by sorcerer-prophets, enemies of their western kin."
};

// Gods, powers and famous places: keys in the game's languages (es, fr, de, it, ru, pl,
// cs, tr, ko, pt, zh, tw) plus English.
export const TOPICS = [
  { keys: ["sigmar", "зигмар", "西格玛", "西格瑪", "지그마"], text: "Sigmar: the founder of the Empire, raised to godhood; the Empire's chief god and patron of its warriors and witch hunters." },
  { keys: ["ursun", "урсун", "乌尔孙", "烏爾孫", "우르순"], text: "Ursun: the great bear god of Kislev, father of the land; the Great Orthodoxy preaches his faith." },
  { keys: ["khorne", "кхорн", "恐虐", "코른"], text: "Khorne: the Chaos god of blood, slaughter and martial pride." },
  { keys: ["nurgle", "нургл", "纳垢", "納垢", "너글"], text: "Nurgle: the Chaos god of plague, decay and despairing endurance, called Grandfather by his followers." },
  { keys: ["slaanesh", "слаанеш", "色孽", "슬라네쉬"], text: "Slaanesh: the Chaos god of excess, pleasure and perfection, who once devoured most of the elven gods' power." },
  { keys: ["tzeentch", "тзинч", "奸奇", "젠치"], text: "Tzeentch: the Chaos god of change, sorcery and endless schemes." },
  { keys: ["hashut", "хашут", "哈苏特", "哈蘇特", "하슈트"], text: "Hashut: the bull god of darkness, fire and slavery, worshipped by the Chaos Dwarfs." },
  { keys: ["lady of the lake", "dama del lago", "dame du lac", "herrin vom see", "владычица озера", "pani jeziora", "paní jezera", "göl hanımı", "dama do lago", "湖中女神", "호수의 여신"], text: "The Lady of the Lake: the goddess of Bretonnia; her knights drink from the Grail, and the Fay Enchantress is her voice." },
  { keys: ["horned rat", "rata cornuda", "rat cornu", "gehörnte ratte", "ratto cornuto", "рогатая крыса", "rogaty szczur", "rohatá krysa", "boynuzlu sıçan", "rato chifrudo", "大角鼠", "뿔 달린 쥐"], text: "The Horned Rat: the Skaven's god of ruin and treachery." },
  { keys: ["great maw", "gran fauce", "grande gueule", "großer schlund", "grande fauci", "великая пасть", "wielka paszcza", "velký chřtán", "büyük ağız", "grande bocarra", "大胃", "위대한 아가리"], text: "The Great Maw: the hungry god of the ogres, who once devoured their homeland; to eat is to worship it." },
  { keys: ["gork", "mork", "горк", "морк", "高格", "莫格", "고크", "모크"], text: "Gork and Mork: the twin brutal-and-cunning gods of the greenskins." },
  { keys: ["khaine", "кхаин", "凯恩", "凱恩", "카인"], text: "Khaine: the elven god of murder and war, worshipped above all by the Dark Elves." },
  { keys: ["nagash", "нагаш", "纳迦什", "納迦什", "나가쉬"], text: "Nagash: the Great Necromancer, first and greatest of the undead, whose ritual woke the Tomb Kings and who claims dominion over all the dead." },
  { keys: ["dragon emperor", "emperador dragón", "empereur-dragon", "empereur dragon", "drachenkaiser", "imperatore drago", "император-дракон", "smoczy cesarz", "dračí císař", "ejderha imparator", "imperador dragão", "龙帝", "龍帝", "용황제"], text: "The Dragon Emperor: the ancient ruler of Grand Cathay, father of Miao Ying and Zhao Ming." },
  { keys: ["great bastion", "gran bastión", "grand bastion", "große bastion", "grande bastione", "великий бастион", "wielki bastion", "velký bastion", "büyük burç", "grande bastião", "巨龙城墙", "巨龍城牆", "대방벽"], text: "The Great Bastion: the immense wall on Cathay's northern frontier that holds back the hordes of the Chaos Wastes." },
  { keys: ["praag", "прааг", "布拉格", "프라그"], text: "Praag: Kislev's second city, nearest the Chaos Wastes, besieged and ravaged by Chaos again and again." },
  { keys: ["altdorf", "альтдорф", "阿尔道夫", "阿爾道夫", "알트도르프"], text: "Altdorf: the capital of the Empire, seat of the Emperor and of the Colleges of Magic." },
  { keys: ["karaz-a-karak", "караз-а-карак", "卡拉萨卡拉克", "카라즈아카라크"], text: "Karaz-a-Karak: the everlasting peak, capital of the Dwarfs and seat of the High King." },
  { keys: ["ulthuan", "ультуан", "奥苏安", "奧蘇安", "울수안"], text: "Ulthuan: the island kingdom of the High Elves." },
  { keys: ["naggaroth", "наггарот", "纳迦罗斯", "納迦羅斯", "나가로스"], text: "Naggaroth: the cold, cruel land of the Dark Elves in the New World." },
  { keys: ["lustria", "люстрия", "露丝契亚", "露絲契亞", "러스트리아"], text: "Lustria: the jungle continent of the Lizardmen and their temple cities." },
  { keys: ["athel loren", "атель лорен", "阿瑟洛伦", "阿瑟洛倫", "아셀 로렌"], text: "Athel Loren: the enchanted forest of the Wood Elves, alive and hostile to intruders." },
  { keys: ["zharr-naggrund", "жарр-наггрунд", "扎尔纳格隆德", "자르나그룬드"], text: "Zharr-Naggrund: the ziggurat-city of the Chaos Dwarfs in the Dark Lands, a furnace of slaves and industry." },
  { keys: ["chaos wastes", "desiertos del caos", "désolations du chaos", "chaoswüste", "desolazione del caos", "пустоши хаоса", "pustkowia chaosu", "pustiny chaosu", "kaos çorakları", "ermos do caos", "混沌荒原", "혼돈의 황무지"], text: "The Chaos Wastes: the frozen, warped lands at the top of the world, where the Chaos Gods' realm bleeds into the mortal one." },
  { keys: ["mountains of mourn", "montañas del luto", "montagnes du deuil", "berge der trauer", "montagne del lutto", "горы скорби", "góry żałoby", "hory smutku", "matem dağları", "montanhas do luto", "哀悼山脉", "哀悼山脈", "애도의 산맥"], text: "The Mountains of Mourn: the harsh mountain homeland of the ogres, between the Dark Lands and Cathay." }
];

// Words too common to fire an entry on their own, in the game's languages.
export const GENERIC_WORDS = new Set([
  "empire", "imperio", "empire", "reich", "impero", "империя", "imperium", "říše", "imparatorluk", "império",
  "chaos", "caos", "хаос", "chaosu", "kaos",
  "court", "corte", "cour", "hof", "двор", "dwór", "dvůr", "saray",
  "kingdom", "reino", "royaume", "königreich", "regno", "королевство", "królestwo", "království", "krallık",
  "north", "norte", "nord", "север", "północ", "sever", "kuzey",
  "lord", "señor", "seigneur", "herr", "signore", "лорд", "pan", "efendi", "senhor"
]);
