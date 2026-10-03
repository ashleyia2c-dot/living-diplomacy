import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Which copies of the mod are installed. Since 0.43 the companion no longer insists
// on one exact pack: the game and the companion agree on a protocol number instead
// (see src/protocol.js). A Steam update that keeps the protocol works with the
// companion the player already has, so nobody re-downloads it for every release.
export function checkInstalledPack(wh3Root, workshopRootOverride = process.env.STEAM_WORKSHOP_ROOT) {
  const game = path.resolve(wh3Root);
  const workshopRoot = workshopRootOverride || path.join(path.resolve(game, "..", ".."), "workshop", "content", "1142710");
  const workshopPack = path.join(workshopRoot, "3802515040", "llm_diplomacy.pack");
  const manualPack = path.join(game, "data", "llm_diplomacy.pack");
  const candidates = [workshopPack, manualPack];
  const found = [];
  for (const pack of candidates) {
    if (!fs.existsSync(pack)) continue;
    try {
      found.push({ pack, actual: crypto.createHash("sha256").update(fs.readFileSync(pack)).digest("hex") });
    } catch (error) {
      return { ok: false, candidates, reason: `Could not read the installed pack: ${error.message}` };
    }
  }
  if (found.length === 0) {
    return { ok: false, candidates, reason: "llm_diplomacy.pack was not found. Subscribe on Steam, enable the mod in the launcher, and let it finish downloading." };
  }
  const warning = found.length > 1 && found[0].actual !== found[1].actual
    ? "Two different copies of the mod are installed (Steam Workshop and the game's data folder). Enable only one in the game launcher."
    : "";
  return { ok: true, ...found[0], found, warning };
}
