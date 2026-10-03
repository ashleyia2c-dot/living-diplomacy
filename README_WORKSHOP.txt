LIVING DIPLOMACY - STEAM WORKSHOP COMPANION

Steam Workshop installs the WARHAMMER III game pack. The companion provides
the local Player2 bridge. There are two ways to run it:

  - EASIEST: Living-Diplomacy-Companion.zip contains WH3-LLM-Diplomacy-Companion.exe.
    No Node.js needed. Extract it and run the .exe every time you play.
  - READABLE ALTERNATIVE (these instructions): Living-Diplomacy-Steam-BAT-*.zip
    runs the same companion from source with START_PLAYER2.bat and Node.js.

Neither ZIP contains a second game pack.

Requirements: WARHAMMER III on Windows, a single-player campaign, the
Workshop mod enabled, Player2 open and signed in, Node.js 20 or newer,
and an internet connection for AI responses. No other mods are required.

1. Download Living-Diplomacy-Steam-BAT-*.zip from the latest GitHub release.
2. Extract the entire ZIP to a permanent folder.
3. Open Player2 and sign in.
4. Run START_PLAYER2.bat and leave its window open while playing.
5. In a single-player campaign, open diplomacy with a faction and click
   the small hand icon next to the question mark.

Do not install another llm_diplomacy.pack manually if using Workshop.

UPDATES: since 0.43 the mod carries the companion of its own release. When Steam
updates the mod, the companion (the EXE or START_PLAYER2.bat) runs the newer code
from it, so you do not download the companion again for each update. Only if the
companion itself says that it needs a newer version, download it again.

Read-only check: node scripts\start-workshop.js --check

The companion stores conversations in %APPDATA%\LivingDiplomacy\data. Player2
processes AI requests. Review Player2's privacy settings and terms before
using it. The source code is available in src/ and scripts/.
