LIVING DIPLOMACY 0.45.0 - STEAM WORKSHOP SETUP
============================================

SUBSCRIBE INSTALLS THE GAME MOD, NOT THE AI COMPANION.
This ZIP supplies the companion. It contains no EXE and no game pack.
Do not run it inside the ZIP: extract the entire folder first.

ONE-TIME SETUP
1. Subscribe to Living Diplomacy on Steam Workshop, let Steam finish downloading,
   and enable it in the WARHAMMER III launcher:
   https://steamcommunity.com/sharedfiles/filedetails/?id=3802515040
2. Install the free Player2 app from https://player2.game and sign in.
3. Install Node.js for Windows from https://nodejs.org. Choose the LTS version.
   The companion needs Node.js 20 or newer; a supported LTS version is recommended.
4. Extract this entire ZIP to a permanent folder, for example Documents/Living Diplomacy.
   Keep START_PLAYER2.bat, package.json, src/, scripts/ and lore-profiles/ together.
   Do NOT copy them into the game folder. Do NOT install another copy of the pack.
   Coming from 0.42? Extract this over your old folder: your leaders' memories are
   moved to their new place on the first start.

EVERY TIME YOU PLAY
1. Open Player2 and sign in.
2. Double-click START_PLAYER2.bat from the extracted folder.
3. Leave that window open, then start WARHAMMER III and load a single-player campaign.
4. Open diplomacy with a faction. Click the small hand beside the question mark.
5. Type a message in the bottom field and use the send button.

The AI Diplomacy button opens the Living Diplomacy window: Letters, Who can write
to me (the factions that may write to you and take part in the living world) and
World (your court's report, the chronicle and the rumours).
When you finish playing, the companion closes after it detects that the game has closed.
The BAT may remain at a 'Press any key' prompt; you can close that window.

UPDATES
The mod carries the companion of its own release. When Steam updates the mod and
it holds a newer companion than this folder, START_PLAYER2.bat runs that one: you
do not need to download this ZIP again for each update.

WHAT YOU DO NOT NEED
No companion EXE, API key, npm install, administrator launch, or other mod.
You still need WARHAMMER III on Windows, Player2, Node.js, and an internet connection.
The EXE download is a separate alternative, not an additional requirement.
Never run the EXE companion and this BAT companion at the same time.

IF IT DOES NOT START
- 'Node.js is not installed': install the Windows LTS version, then reopen the BAT.
- 'llm_diplomacy.pack was not found': subscribe on Steam, enable the mod and let
  Steam finish downloading.
- 'Player2 is not open' or no AI reply: open Player2, sign in, and restart the BAT.
- 'Another, different copy': disable the older duplicate in the game launcher.
- Game installed on another drive: normally detected automatically. If needed,
  create .env beside START_PLAYER2.bat with your actual path, for example:
  WH3_ROOT=D:/SteamLibrary/steamapps/common/Total War WARHAMMER III
- Keep errors visible in the BAT window and include them when reporting a bug.

CHECK WITHOUT STARTING THE COMPANION
Run START_PLAYER2.bat --check from a terminal. It checks that the mod is installed.
It does not contact Player2 or start the game.

ABOUT THE FILES
The companion reads the game's diplomatic requests, communicates with Player2's
local API, and sends validated responses back to the game. Conversations are
stored on your computer in %APPDATA%\LivingDiplomacy\data. Player2 handles the AI
service. No personal settings or conversation history are included in this download.
