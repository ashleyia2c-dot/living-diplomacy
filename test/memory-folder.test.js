// What leaders remember used to live next to the companion. Extracting a newer
// companion somewhere else started from nothing, and the leaders forgot every
// conversation the save still showed on screen. It now lives in one fixed folder
// per Windows user, and an older folder is copied over once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyData } from "../src/data-migration.js";
import { defaultDataDir } from "../src/config.js";
import { MemoryStore } from "../src/memory-store.js";

test("la memoria vive en una carpeta fija del usuario, no junto al programa", () => {
  assert.equal(defaultDataDir("C:\\Users\\Ana\\AppData\\Roaming"), path.join("C:\\Users\\Ana\\AppData\\Roaming", "LivingDiplomacy", "data"));
  const companion = fs.readFileSync(new URL("../src/companion.js", import.meta.url), "utf8");
  assert.ok(companion.indexOf("migrateLegacyData(config.legacyDataDir, config.dataDir)") < companion.indexOf("new MemoryStore(config.dataDir)"),
    "the old memory is copied before the store opens");
});

test("la migracion copia lo que falta, nunca pisa ni borra", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llmdip-memory-"));
  try {
    const legacy = path.join(base, "old-companion", "data");
    const fixed = path.join(base, "AppData", "LivingDiplomacy", "data");
    const file = (root, rel) => path.join(root, "campaigns", "c1", rel);
    fs.mkdirSync(path.dirname(file(legacy, "katarin/timeline.json")), { recursive: true });
    fs.writeFileSync(file(legacy, "katarin/timeline.json"), "old katarin");
    fs.mkdirSync(path.dirname(file(legacy, "franz/timeline.json")), { recursive: true });
    fs.writeFileSync(file(legacy, "franz/timeline.json"), "old franz");
    fs.mkdirSync(path.dirname(file(fixed, "franz/timeline.json")), { recursive: true });
    fs.writeFileSync(file(fixed, "franz/timeline.json"), "newer franz");

    assert.equal(migrateLegacyData(legacy, fixed), 1);
    assert.equal(fs.readFileSync(file(fixed, "katarin/timeline.json"), "utf8"), "old katarin");
    assert.equal(fs.readFileSync(file(fixed, "franz/timeline.json"), "utf8"), "newer franz", "never overwrites");
    assert.ok(fs.existsSync(file(legacy, "katarin/timeline.json")), "never deletes the old folder");
    assert.equal(migrateLegacyData(legacy, fixed), 0, "running again copies nothing");
    assert.equal(migrateLegacyData(fixed, fixed), 0, "same folder is a no-op");
    assert.equal(migrateLegacyData(path.join(base, "missing"), fixed), 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("legacy timeline nodes are imported without mixing save branches or changing existing nodes", () => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"llmdip-timeline-import-"));
  try {
    const from=path.join(base,"old","data"), to=path.join(base,"stable","data");
    const relative=path.join("campaigns","c1","_timelines","player","timeline.json");
    const node=(id,parent,content,faction="ksl")=>({
      requestId:id,parent,sender:"player",interlocutor:faction,
      messages:[{role:"assistant",content,scope:{campaignId:"c1",sender:"player",interlocutor:faction}}]
    });
    const shared=node("r1","root","Original exchange");
    const legacy={version:1,nodes:{r1:shared,r2:node("r2","r1","Older save branch")}};
    const current={version:1,nodes:{r1:shared,r3:node("r3","r1","Newer save branch")}};
    for (const [dir,value] of [[from,legacy],[to,current]]) {
      const file=path.join(dir,relative);fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,JSON.stringify(value));
    }
    const warnings=[];
    assert.equal(migrateLegacyData(from,to,{warn:m=>warnings.push(m)}),1);
    const merged=JSON.parse(fs.readFileSync(path.join(to,relative),"utf8"));
    assert.deepEqual(merged.nodes.r3,current.nodes.r3);
    assert.equal(Object.keys(merged.nodes).length,3);
    assert.equal(warnings.length,0);
    assert.ok(fs.readdirSync(path.dirname(path.join(to,relative))).some(f=>f.includes("before-legacy-import")));
    const store=new MemoryStore(to);
    const request={campaignId:"c1",sender:"player",interlocutor:"ksl"};
    assert.deepEqual(store.history({...request,memoryParent:"r2"}).map(m=>m.content),["Original exchange","Older save branch"]);
    assert.deepEqual(store.history({...request,memoryParent:"r3"}).map(m=>m.content),["Original exchange","Newer save branch"]);
    assert.equal(migrateLegacyData(from,to,{warn:m=>warnings.push(m)}),0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(from,relative),"utf8")),legacy);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test("conflicting or foreign-scope legacy nodes cannot overwrite a history", () => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),"llmdip-timeline-conflict-"));
  try {
    const from=path.join(base,"old"),to=path.join(base,"new");
    const relative=path.join("campaigns","c1","_timelines","player","timeline.json");
    const current={version:1,nodes:{r1:{requestId:"r1",parent:"root",sender:"player",interlocutor:"ksl",messages:[]}}};
    const incoming={version:1,nodes:{...current.nodes,r2:{requestId:"r2",parent:"r1",sender:"player",interlocutor:"ksl",messages:[]}}};
    for (const dir of [from,to]) fs.mkdirSync(path.dirname(path.join(dir,relative)),{recursive:true});
    const original=JSON.stringify(current); fs.writeFileSync(path.join(to,relative),original);
    const warnings=[];
    const attempt=value=>{
      fs.writeFileSync(path.join(from,relative),JSON.stringify(value));
      assert.equal(migrateLegacyData(from,to,{warn:m=>warnings.push(m)}),0);
      assert.equal(fs.readFileSync(path.join(to,relative),"utf8"),original);
    };
    attempt({...incoming,nodes:{...incoming.nodes,r1:{...incoming.nodes.r1,parent:"other"}}});
    attempt({...incoming,nodes:{...incoming.nodes,r2:{...incoming.nodes.r2,sender:"other_player"}}});
    attempt({...incoming,nodes:{...incoming.nodes,r2:{...incoming.nodes.r2,messages:[{scope:{campaignId:"other_save",sender:"player",interlocutor:"ksl"}}]}}});
    assert.equal(warnings.length,3);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});

test("import refuses a destination inside the legacy source instead of recursively copying itself", () => {
  const from=fs.mkdtempSync(path.join(os.tmpdir(),"llmdip-import-recursion-"));
  try {
    const warnings=[];
    assert.equal(migrateLegacyData(from,path.join(from,"nested"),{warn:m=>warnings.push(m)}),0);
    assert.equal(warnings.length,1);
    assert.equal(fs.existsSync(path.join(from,"nested")),false);
  } finally {fs.rmSync(from,{recursive:true,force:true});}
});
