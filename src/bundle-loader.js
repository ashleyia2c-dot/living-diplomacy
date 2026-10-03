// The companion's code also travels inside the mod's .pack, so a Steam Workshop update
// updates the companion too: nobody downloads a new .exe for each release. The .pack is
// saved uncompressed, so the code sits there as plain text between two markers, with
// its version and SHA-256. The .exe (src/launcher.js) runs the newest copy it finds and
// falls back to the copy built into it when there is none, or when it is broken.
import crypto from "node:crypto";
import fs from "node:fs";

// What the launcher understands. Raise it only if a bundle ever needs something a
// launcher of today cannot give it; older launchers then keep their built-in code.
export const LOADER_API = 1;
const BEGIN = "/*LLMDIP-COMPANION-BUNDLE ";
const HEADER_END = "*/\n";
const END = "\n/*LLMDIP-COMPANION-BUNDLE-END*/";

export function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function wrapBundle(code, version) {
  const header = { api: LOADER_API, version, sha256: sha256(code), length: Buffer.byteLength(code, "utf8") };
  return `${BEGIN}${JSON.stringify(header)}${HEADER_END}${code}${END}`;
}

// The bundle inside a pack (or any buffer), checked against its own length and hash.
export function findBundle(buffer) {
  const begin = Buffer.from(BEGIN, "utf8");
  let at = buffer.indexOf(begin);
  while (at >= 0) {
    const headerStart = at + begin.length;
    const headerEnd = buffer.indexOf(HEADER_END, headerStart, "utf8");
    if (headerEnd > headerStart && headerEnd - headerStart < 2000) {
      try {
        const header = JSON.parse(buffer.subarray(headerStart, headerEnd).toString("utf8"));
        const codeStart = headerEnd + HEADER_END.length;
        const code = buffer.subarray(codeStart, codeStart + Number(header.length)).toString("utf8");
        if (Number.isInteger(header.api) && typeof header.version === "string" && sha256(code) === header.sha256) {
          return { api: header.api, version: header.version, code };
        }
      } catch { /* Not a bundle header after all: keep looking. */ }
    }
    at = buffer.indexOf(begin, at + 1);
  }
  return null;
}

// "0.43.0" < "0.43.10" < "0.44.0"; anything after a dash is ignored.
export function compareVersions(a, b) {
  const parts = value => String(value || "0").split("-")[0].split(".").map(part => Number(part) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

// The newest usable bundle among the installed packs, if it is newer than the code built
// into this launcher. `skipped` says why a newer one could not be used.
export function chooseBundle(packPaths = [], builtinVersion = "0.0.0", { read = file => fs.readFileSync(file) } = {}) {
  let best = null;
  let skipped = "";
  for (const pack of packPaths) {
    let bundle = null;
    try { bundle = findBundle(read(pack)); } catch { continue; }
    if (!bundle) continue;
    if (bundle.api > LOADER_API) {
      skipped = `the mod carries companion ${bundle.version}, which needs a newer launcher`;
      continue;
    }
    if (!best || compareVersions(bundle.version, best.version) > 0) best = { ...bundle, pack };
  }
  if (!best || compareVersions(best.version, builtinVersion) <= 0) return { bundle: null, skipped };
  return { bundle: best, skipped };
}
