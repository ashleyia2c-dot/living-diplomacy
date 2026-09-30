import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The packaged companion and Workshop pack are released as a matched pair.
// A wrong pack can silently break the bridge protocol, so fail before polling.
export function checkInstalledPack(wh3Root, expectedSha256, workshopRootOverride = process.env.STEAM_WORKSHOP_ROOT) {
  const game = path.resolve(wh3Root);
  const workshopRoot = workshopRootOverride || path.join(path.resolve(game, "..", ".."), "workshop", "content", "1142710");
  const workshopPack = path.join(workshopRoot, "3802515040", "llm_diplomacy.pack");
  const manualPack = path.join(game, "data", "llm_diplomacy.pack");
  const candidates = [workshopPack, manualPack];
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 || "")) {
    return { ok: false, candidates, reason: "This companion has no valid pack fingerprint. Download this version again." };
  }
  const found = [];
  for (const pack of candidates) {
    if (!fs.existsSync(pack)) continue;
    try {
      found.push({ pack, actual: crypto.createHash("sha256").update(fs.readFileSync(pack)).digest("hex") });
    } catch (error) {
      return { ok: false, candidates, reason: `Could not read the installed pack: ${error.message}` };
    }
  }
  const matching = found.find(item => item.actual.toLowerCase() === expectedSha256.toLowerCase());
  if (matching) return { ok: true, ...matching, warning: found.length > 1 && found.some(item => item.actual !== matching.actual)
    ? "Another, different copy of the pack is also installed. Enable only the matching version in the game launcher." : "" };
  if (found.length === 0) return { ok: false, candidates, reason: "llm_diplomacy.pack was not found. Subscribe on Steam, enable the mod in the launcher, and let it finish downloading." };
  return { ok: false, candidates, found, reason: "This companion does not match any installed pack. Update the Workshop mod and download the matching companion version." };
}
