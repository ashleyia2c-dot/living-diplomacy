# Living Diplomacy – AI Diplomacy for Total War: WARHAMMER III

Source code for the Living Diplomacy mod and its companion program.

- **Steam Workshop:** https://steamcommunity.com/sharedfiles/filedetails/?id=3802515040
- **Companion download:** https://github.com/ashleyia2c-dot/living-diplomacy/releases/latest

## Install the Workshop edition

The Workshop subscription installs the Warhammer III `.pack` only. AI conversations also need the separate, text-only Player2 companion.

1. Subscribe to the Workshop item and enable it in the game launcher.
2. Install and sign in to [Player2](https://player2.game).
3. Install [Node.js 20 or newer](https://nodejs.org).
4. On the [latest release page](https://github.com/ashleyia2c-dot/living-diplomacy/releases/latest), download the asset named `Player2-Diplomacy-WH3-Workshop-Companion-*.zip` from **Assets**. Do not use the automatically generated "Source code" archives as the installer.
5. Extract the ZIP, run `INICIAR_PLAYER2.bat`, and leave its window open while playing. No `npm install` is needed.
6. In a single-player campaign, open diplomacy with a faction and click the small hand icon beside the question mark.

Do not install a second `llm_diplomacy.pack` manually when using Workshop. The BAT verifies that Steam has downloaded the compatible pack. This edition has text conversations only. See [`LEEME_WORKSHOP.txt`](LEEME_WORKSHOP.txt) for troubleshooting and alternative Steam library paths.

## What is in this repository

| Path | What it is |
|---|---|
| `mod/` | The game mod: campaign Lua scripts and UI templates packed into `llm_diplomacy.pack`. |
| `src/` | The companion (Node.js). The released `WH3-LLM-Diplomacy-Companion.exe` is built from this. |
| `scripts/` | Build scripts for the executable, the `.pack` and the release zip. |
| `INICIAR_PLAYER2.bat`, `LEEME_WORKSHOP.txt` | Source and instructions for the Workshop companion release. |
| `test/` | Automated tests for the companion and the Lua scripts. |
| `lore-profiles/` | Optional lore notes used to shape faction leaders. |

## What the companion does

Warhammer III scripts cannot open network connections, so the companion acts as a local bridge:

1. It reads the game's own script log to pick up diplomacy requests written by the mod.
2. It sends them to the **Player2 app running on the same computer** (`http://127.0.0.1`, default port 4315).
3. It writes the reply to a small Lua file that the mod reads back.

By default it only connects to `127.0.0.1`: the local Player2 app, and its own status page on `http://127.0.0.1:43127`. The only other destination in the code is an optional OpenAI-compatible provider that a user must configure explicitly in a `.env` file (`LLMDIP_PROVIDER=openai`); it is off by default.

Conversation memory is stored as JSON in a `data/` folder next to the companion.

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
