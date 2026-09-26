# Writes lore-profiles/<agent_subtype>.json for every legendary lord in part1-3.py.
#   python scripts/lore/build_profiles.py
# The companion looks a lord up by agent subtype first, so these files follow the lord,
# not the faction.
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from part1 import LORDS as P1
from part2 import LORDS as P2
from part3 import LORDS as P3

OUT = os.path.join(HERE, "..", "..", "lore-profiles")
TEMPERAMENT = ("aggression", "caution", "pride", "greed", "honour")
SOCIAL = ("warmth", "sociability", "generosity", "vanity", "spite", "opportunism")
# Lords the game ships under a second subtype (as army general and as hero).
ALIASES = {
    "wh3_dlc29_chs_bloab_lord": "wh3_dlc29_chs_bloab",
    "wh3_dlc29_chs_morbidex_lord": "wh3_dlc29_chs_morbidex",
    "wh3_dlc29_chs_orghotts_lord": "wh3_dlc29_chs_orghotts",
    "wh3_dlc29_skv_skreech_verminking_general": "wh3_dlc29_skv_skreech_verminking",
}
SOURCES = ["Total War: WARHAMMER III, in-game unit lore (summarised, not quoted)",
           "Warhammer Fantasy Battles background"]

lords = {**P1, **P2, **P3}
assert len(lords) == len(P1) + len(P2) + len(P3), "duplicate subtype across parts"
written = 0
for subtype, (name, gender, canon, voice, temperament, social, tts) in lords.items():
    assert gender in ("male", "female", "other"), subtype
    assert len(temperament) == 5 and len(social) == 6, subtype
    assert all(0 <= v <= 100 for v in temperament + social), subtype
    profile = {
        "name": name,
        "canonNotes": canon,
        "voiceNotes": voice,
        "temperament": dict(zip(TEMPERAMENT, temperament)),
        "socialStyle": dict(zip(SOCIAL, social)),
        "voiceGender": gender,
        "ttsInstructions": tts,
        "sources": SOURCES,
    }
    for key in [subtype] + [alias for alias, base in ALIASES.items() if base == subtype]:
        with open(os.path.join(OUT, key + ".json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(profile, f, ensure_ascii=False, indent=2)
            f.write("\n")
        written += 1
print(f"{len(lords)} lords, {written} files")
