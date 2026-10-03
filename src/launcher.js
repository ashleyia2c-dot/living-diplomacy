// The .exe's entry point. Before starting, it looks inside the installed mod for a newer
// companion (src/bundle-loader.js): Steam keeps the mod up to date, so the companion
// updates with it. Without one, or if it fails before starting, the companion built
// into the .exe runs, exactly as before.
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { getConfig } from "./config.js";
import { checkInstalledPack } from "./pack-compat.js";
import { chooseBundle } from "./bundle-loader.js";

const BUILTIN_VERSION = typeof __LLMDIP_VERSION__ === "string" ? __LLMDIP_VERSION__ : "0.0.0";

function runBundle(bundle) {
  // Only Node's own modules are needed: the bundle carries everything else.
  const requireBuiltin = createRequire(process.execPath);
  const wrapper = vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${bundle.code}\n})`,
    { filename: `living-diplomacy-companion-${bundle.version}.cjs` });
  const module = { exports: {} };
  wrapper(requireBuiltin, module, module.exports, bundle.pack, path.dirname(bundle.pack));
}

function startFromMod() {
  if (process.env.LLMDIP_NO_PACK_BUNDLE === "1") return false;
  let choice;
  try {
    const installed = checkInstalledPack(getConfig().wh3Root);
    if (!installed.ok) return false;
    choice = chooseBundle(installed.found.map(item => item.pack), BUILTIN_VERSION);
  } catch (error) {
    console.warn(`Could not look inside the mod for a newer companion (${error.message}).`);
    return false;
  }
  if (choice.skipped) console.warn(`Note: ${choice.skipped}. Download the latest companion when you can; this one keeps working.`);
  if (!choice.bundle) return false;
  try {
    console.log(`Companion ${choice.bundle.version}, updated through the mod (this launcher: ${BUILTIN_VERSION}).`);
    runBundle(choice.bundle);
    return true;
  } catch (error) {
    // A failure this early happens before anything has started, so the built-in
    // companion can take over cleanly.
    console.warn(`The companion inside the mod could not start (${error.message}); using the built-in one.`);
    return false;
  }
}

if (!startFromMod()) import("./companion.js");
