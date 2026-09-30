LIVING DIPLOMACY 0.42.2 - READABLE SOURCE ALTERNATIVE

This archive is for people who prefer not to run an unsigned EXE. It contains
the companion source and the same source used for the WARHAMMER III pack. No
game pack, compiled executable, API key or conversation history is included.

Requirements: Windows, WARHAMMER III, the matching Living Diplomacy Workshop
mod enabled, the free Player2 app open and signed in, Node.js 20 or newer,
and an internet connection. No npm install is needed to run the companion.
For new Node.js installations, choose the supported Windows LTS version from
https://nodejs.org. The Steam BAT consumer ZIP is the simpler source-based
download for players; this source archive also includes developer tools.

1. Subscribe on Steam and enable the mod in the launcher:
   https://steamcommunity.com/sharedfiles/filedetails/?id=3802515040
2. Install Player2 from https://player2.game and sign in.
3. Extract this archive to a permanent folder.
4. Double-click START_PLAYER2.bat and leave its window open while playing.
5. In a single-player campaign, open diplomacy with a faction and click the
   small hand icon beside the question mark.

The launcher checks both the Steam Workshop and manual pack locations. It
will refuse to run with the wrong pack. Do not enable two copies of the mod.
Use `node scripts/start-workshop.js --check` for a read-only compatibility test.

The companion stores its conversation data in a data/ folder beside this file.
Its Player2 Game Client ID is public and embedded in src/config.js. It is used
to attribute play time to this mod when WARHAMMER III is running.

If you use the ready-made EXE instead, Node.js is NOT required. In either
case, Player2 must still be installed, open and signed in.

DEVELOPER BUILD

Running the source companion needs no npm install. Building or testing it does:
install the package-lock.json dependencies with npm ci, then run npm test.
To rebuild the game pack, scripts/build-pack.js additionally needs RPFM Server
5.0.6 in tools/rpfm-v5.0.6. The pack sources are in mod/.
Run npm run build:pack, npm run build:exe, then npm run build:release.
The EXE build uses Node SEA and postject, and embeds the curated leader profiles
and the SHA-256 of the corresponding pack. Existing release folders are never
overwritten. Keep the exact tested pack for a paired release.
