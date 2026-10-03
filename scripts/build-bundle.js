// Builds the companion as one CommonJS file for the .pack (src/bundle-loader.js): the
// same code as the .exe, with the curated lore and the version inside, wrapped between
// the markers the launcher looks for. build-pack.js runs this first, so every pack
// carries the companion of its own release.
//
//   node scripts/build-bundle.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { wrapBundle } from "../src/bundle-loader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE_OUT = path.join(ROOT, "dist", "companion_bundle.js");

export function companionVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

export function embeddedLore() {
  const lore = Object.fromEntries(fs.readdirSync(path.join(ROOT, "lore-profiles"))
    .filter(name => name.endsWith(".json"))
    .map(name => [name.slice(0, -5), JSON.parse(fs.readFileSync(path.join(ROOT, "lore-profiles", name), "utf8"))]));
  if (!Object.keys(lore).length) throw new Error("No curated leader profiles found; refusing an incomplete build.");
  return lore;
}

// The defines shared by the .exe and the bundle: they must behave the same.
export function companionDefines() {
  return {
    __LLMDIP_PACKAGED__: "true",
    __LLMDIP_EMBEDDED_LORE__: JSON.stringify(embeddedLore()),
    __LLMDIP_VERSION__: JSON.stringify(companionVersion())
  };
}

export async function buildCompanionBundle(out = BUNDLE_OUT) {
  const result = await build({
    entryPoints: [path.join(ROOT, "src", "companion.js")],
    bundle: true, platform: "node", format: "cjs", target: "node22",
    write: false, legalComments: "none", define: companionDefines()
  });
  const code = result.outputFiles[0].text;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, wrapBundle(code, companionVersion()), "utf8");
  return { out, version: companionVersion(), bytes: fs.statSync(out).size };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const built = await buildCompanionBundle();
  console.log(`Companion bundle ${built.version}: ${built.out} (${Math.round(built.bytes / 1024)} KB)`);
}
