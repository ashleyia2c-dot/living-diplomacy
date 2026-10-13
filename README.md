# Living Diplomacy – AI Diplomacy for Total War: WARHAMMER III

Source code for the Living Diplomacy mod and its companion program.

- **Steam Workshop:** https://steamcommunity.com/sharedfiles/filedetails/?id=3802515040
- **Companion download:** https://github.com/ashleyia2c-dot/living-diplomacy/releases/latest

## Install the Workshop edition

The mod has two parts. The Workshop subscription installs the Warhammer III `.pack`, and Steam keeps it updated. AI replies also need the companion, a small free program that runs next to the game, because Warhammer III scripts cannot connect to anything outside the game.

**Once:**

1. Subscribe to the Workshop item and enable it in the game launcher.
2. Install and sign in to [Player2](https://player2.game).
3. Download [`Living-Diplomacy-Companion.zip`](https://github.com/ashleyia2c-dot/living-diplomacy/releases/latest/download/Living-Diplomacy-Companion.zip) and extract it to a folder you keep. No Node.js needed.

**Every time you play:** open Player2, run `WH3-LLM-Diplomacy-Companion.exe` and leave its window open, then start the game. It closes itself when you quit Warhammer III.

In a single-player campaign, open diplomacy with a faction and click the small hand icon beside the question mark. If the companion is not running, the chat says so after a few seconds instead of waiting forever.

The executable is not code-signed, so Windows may show "Windows protected your PC" the first time: choose **More info** and **Run anyway**. If you prefer not to run it, the readable alternative is `Living-Diplomacy-Steam-BAT-*.zip` from the [latest release](https://github.com/ashleyia2c-dot/living-diplomacy/releases/latest): it needs [Node.js 20 or newer](https://nodejs.org) and runs `START_PLAYER2.bat` instead. Use one companion or the other, never both.

Do not install a second `llm_diplomacy.pack` manually when using Workshop. See [`README_WORKSHOP.txt`](README_WORKSHOP.txt) for troubleshooting and alternative Steam library paths.

**Updates.** Since 0.43 the mod's `.pack` also carries the companion of its own release, as plain text between two markers with its version and SHA-256 (`src/bundle-loader.js`). When Steam updates the mod, the executable (`src/launcher.js`) and `START_PLAYER2.bat` run that newer companion, so players download the companion once and Steam keeps it up to date. A missing or damaged copy falls back to the companion built into the executable. The game and the companion check compatibility by protocol number, not by one exact pack.

## What is in this repository

| Path | What it is |
|---|---|
| `mod/` | The game mod: campaign Lua scripts and UI templates packed into `llm_diplomacy.pack`. |
| `src/` | The companion (Node.js). The released `WH3-LLM-Diplomacy-Companion.exe` is built from this. |
| `scripts/` | Build scripts for the executable, the `.pack` and the release zip. |
| `START_PLAYER2.bat`, `README_WORKSHOP.txt` | Source and instructions for the Workshop companion release. |
| `test/` | Automated tests for the companion and the Lua scripts. |
| `lore-profiles/` | Optional lore notes used to shape faction leaders. |

## What the companion does

Warhammer III scripts cannot open network connections, so the companion acts as a local bridge:

1. It reads the game's own script log to pick up diplomacy requests written by the mod.
2. It sends them to the **Player2 app running on the same computer** (`http://127.0.0.1`, default port 4315).
3. It writes the reply to a small Lua file that the mod reads back.

By default it only connects to `127.0.0.1`: the local Player2 app, and its own status page on `http://127.0.0.1:43127`. The only other destination in the code is an optional OpenAI-compatible provider that a user must configure explicitly in a `.env` file (`LLMDIP_PROVIDER=openai`); it is off by default.

Conversation memory is stored as JSON in `%APPDATA%\LivingDiplomacy\data`; an older `data/` folder next to the companion is copied there on the first start.

Players can direct the leaders themselves in `%APPDATA%\LivingDiplomacy\custom` (created on the first start, with a README): `instructions.txt` for every leader, and `lords/<leader subtype or faction key>.json` to change one leader field by field (`src/memory-store.js`). These directions never change the reply tags or what the game allows.

With the optional **Voice** switch (World tab, off by default), the reply to the player's own audience is also sent to Player2's local text-to-speech (`/v1/tts/speak`) in the game's language. The game hides the switch in languages without both male and female Player2 voices.

## Building the older executable (developer reference)

Requirements: Windows and **Node.js 22 or newer**.

```bat
npm ci
npm test
npm run build:exe
```

The executable is written to `dist\WH3-LLM-Diplomacy-Companion.exe`.

It is a standard [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html):

1. `esbuild` bundles `src/companion.js` into one CommonJS file.
2. Node generates the SEA blob from it (`node --experimental-sea-config`).
3. The official `node.exe` of the build machine is copied, and `postject` injects the blob into the copy.

If the Windows SDK is installed, `signtool` removes Node's original signature before injection, because injecting would otherwise leave an invalid signature. The released executable is not code-signed.

## Building the mod pack (optional)

The Lua sources in `mod/` are plain text and can be read directly. To rebuild `llm_diplomacy.pack`, place [RPFM](https://github.com/Frodo45127/rpfm) 5.0.6 in `tools/rpfm-v5.0.6/` and run:

```bat
npm run build:pack
```

## Third-party components

- **Node.js** runtime (MIT License), embedded in the executable.
- Build-time only: esbuild, postject, luaparse and fengari (see `package.json`).
- AI is provided by [Player2](https://player2.game).

This is an unofficial fan-made mod and is not affiliated with or endorsed by Creative Assembly, SEGA, Games Workshop or Player2.

## License

Copyright (c) 2026 the Living Diplomacy author. **All rights reserved.**

This source code is published so that it can be reviewed. Being able to read it does not grant permission to use it. Copying, modifying, redistributing, re-uploading or using any part of this project, in whole or in part, requires prior written permission from the author.
