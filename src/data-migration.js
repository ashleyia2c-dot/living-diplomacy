import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const KEY = /^[a-z0-9_]{1,160}$/;
function validTimeline(value, campaign, sender) {
  if (value?.version !== 1 || !value.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes)) return false;
  return Object.entries(value.nodes).every(([id, node]) =>
    KEY.test(id) && node?.requestId === id && KEY.test(node.interlocutor || "") &&
    KEY.test(node.parent || "root") && (!node.sender || node.sender === sender) &&
    Array.isArray(node.messages) && node.messages.every(message =>
      !message.scope || (message.scope.campaignId === campaign && message.scope.sender === sender &&
        message.scope.interlocutor === node.interlocutor)));
}

// Union immutable request nodes only. A conflicting node can change the meaning
// of every descendant, so it blocks this whole timeline rather than mixing branches.
function importTimeline(source, target, relative, warn) {
  const parts = relative.split(path.sep);
  if (parts.length !== 5 || parts[0] !== "campaigns" || parts[2] !== "_timelines" || parts[4] !== "timeline.json") return false;
  const [, campaign, , sender] = parts;
  if (!KEY.test(campaign) || !KEY.test(sender)) return false;
  try {
    const incoming = JSON.parse(fs.readFileSync(source, "utf8"));
    const original = fs.readFileSync(target, "utf8");
    const current = JSON.parse(original);
    if (!validTimeline(incoming, campaign, sender) || !validTimeline(current, campaign, sender)) {
      warn("Legacy timeline was not imported because its identity/schema is invalid: " + source);
      return false;
    }
    const additions = [];
    for (const [id, node] of Object.entries(incoming.nodes)) {
      if (Object.hasOwn(current.nodes, id)) {
        if (!isDeepStrictEqual(current.nodes[id], node)) {
          warn("Legacy timeline conflict; both histories were kept unchanged. Review: " + source);
          return false;
        }
      } else additions.push([id, node]);
    }
    if (!additions.length) return false;
    const hash = crypto.createHash("sha256").update(original).digest("hex").slice(0, 16);
    const backup = target + ".before-legacy-import-" + hash + ".json";
    if (!fs.existsSync(backup)) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    const nodes = { ...current.nodes };
    for (const [id, node] of additions) Object.defineProperty(nodes, id, {value:node, enumerable:true, configurable:true, writable:true});
    const temporary = target + "." + process.pid + ".import.tmp";
    fs.writeFileSync(temporary, JSON.stringify({...current, nodes}, null, 2) + "\n", {encoding:"utf8", flag:"wx"});
    fs.renameSync(temporary, target);
    return true;
  } catch (error) {
    warn("Could not import legacy timeline; existing history was retained: " + error.message);
    return false;
  }
}

// Before 0.43 the companion kept what leaders remember in a "data" folder next to
// itself, so extracting a newer companion somewhere else started from nothing.
// Memory now lives in one fixed folder per Windows user. This copies an older
// Missing files are copied. Existing timelines may gain verified, nonconflicting
// nodes with a backup; other existing files are never overwritten or deleted.
export function migrateLegacyData(from, to, {warn = message => console.warn(message)} = {}) {
  if (!from || !to || !fs.existsSync(from)) return 0;
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return 0;
  const descendant = path.relative(path.resolve(from), path.resolve(to));
  if (descendant && !descendant.startsWith(".." + path.sep) && descendant !== ".." && !path.isAbsolute(descendant)) {
    warn("Legacy import refused: the destination is inside the source folder.");
    return 0;
  }
  let copied = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      const target = path.join(to, path.relative(from, source));
      if (entry.isDirectory()) walk(source);
      else if (entry.isFile()) {
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          copied += 1;
        } else if (importTimeline(source, target, path.relative(from, source), warn)) copied += 1;
      }
    }
  };
  walk(from);
  return copied;
}
