import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import luaparse from "luaparse";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("campaign bridge and diplomacy UI parse as Lua 5.1", () => {
  for (const name of ["llm_diplomacy.lua", "llm_diplomacy_ui.lua"]) {
    const file = path.join(projectRoot, "mod", "script", "campaign", "mod", name);
    const source = fs.readFileSync(file, "utf8");
    const ast = luaparse.parse(source, { luaVersion: "5.1", locations: true });
    assert.equal(ast.type, "Chunk");
    assert.ok(ast.body.length > 5);
  }
});

test("campaign UI and generated inbox use WH3's shared global environment", () => {
  const main = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy.lua"), "utf8");
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  const renderer = fs.readFileSync(path.join(projectRoot, "src", "lua-renderer.js"), "utf8");
  assert.match(main, /setfenv\(1, core:get_env\(\)\)/);
  assert.match(main, /setfenv\(loader, core:get_env\(\)\)/);
  assert.match(main, /function llmdip_toggle_contact/);
  assert.match(main, /cm:real_callback\(function\(\)\s*local delivered = broadcast\(event\)/);
  assert.doesNotMatch(main, /cm:callback\(function\(\) broadcast\(event\)/);
  assert.match(main, /out\("\[LLMDIP\] REQUEST\|"/);
  assert.match(main, /pending\[request_id\] = \{player = player:name\(\)/);
  assert.match(main, /RESPONSE_REJECT\|missing_request/);
  assert.match(ui, /setfenv\(1, core:get_env\(\)\)/);
  assert.match(ui, /llmdip_send_request/);
  assert.match(ui, /llmdip_ui\/llmdip_chat/);
  assert.match(ui, /llmdip_ui\/llmdip_history/);
  assert.match(ui, /root:CreateComponent\(CHAT_ID/);
  assert.match(ui, /root:CreateComponent\(HISTORY_ID/);
  assert.doesNotMatch(ui, /panel:CreateComponent\(CHAT_ID/);
  assert.doesNotMatch(ui, /panel:CreateComponent\(HISTORY_ID/);
  assert.match(ui, /RegisterTopMost/);
  assert.match(ui, /PanelClosedCampaign/);
  assert.doesNotMatch(ui, /cm:repeat_callback\(refresh, 0\.8/);
  assert.match(ui, /GetContextObject\(probes\[i\]\[1\]\)/);
  assert.match(ui, /FactionRecordContext\.Key/);
  assert.doesNotMatch(ui, /CopyComponent/);
  assert.doesNotMatch(ui, /:Adopt\(/);
  assert.match(ui, /panel_diplomacy/);
  assert.match(ui, /SetDockingPoint/);
  assert.match(ui, /SetDockOffset/);
  assert.match(ui, /chat:StealInputFocus\(enabled\)/);
  assert.match(ui, /set_input_focus\(true\)/);
  assert.match(ui, /set_input_focus\(false\)/);
  assert.match(ui, /local text = chat:GetStateText\(\) or ""/);
  assert.match(ui, /local input = find_from\(chat, "entry_box"\)/);
  assert.match(ui, /pcall\(function\(\) return llmdip_send_request\(target, text, state\.attitude_value, state\.personality_attributes\) end\)/);
  assert.match(ui, /id == "entry_box"/);
  assert.match(ui, /input:SetInteractive\(true\)/);
  assert.match(ui, /\[LLMDIP UI\] SEND_TARGET/);
  assert.match(ui, /\[LLMDIP UI\] SEND_END/);
  assert.match(ui, /history:MoveTo/);
  assert.match(ui, /chat:MoveTo/);
  assert.doesNotMatch(ui, /local chat_uic|local history_uic/);
  assert.match(ui, /icon_diplomacy\.png/);
  assert.match(ui, /id == TALK_ID/);
  assert.match(ui, /id == SEND_ID/);
  assert.match(ui, /context\.string == "diplomacy_dropdown"/);
  assert.match(main, /CcoCampaignFaction.*AttitudeCategory/);
  assert.match(main, /subject:diplomatic_standing_with\(other\)/);
  assert.match(main, /model_attitude_value\(ai, player\) > 75/);
  assert.match(main, /campaign_snapshot\(player, interlocutor, ui_attitude, ui_personality, memory_parent, request_id\)/);
  assert.match(main, /cm:get_saved_value\(memory_key\) or "root"/);
  assert.match(main, /cm:set_saved_value\(memory_key, request_id\)/);
  assert.match(main, /"memory_parent=" \.\. clean_value\(memory_parent\)/);
  assert.match(main, /"player_leader=" \.\. player_leader\.name/);
  assert.match(main, /"relative_power=" \.\. relative_power/);
  assert.match(main, /"shared_border_regions="/);
  assert.match(main, /local function direct_diplomacy_events/);
  assert.match(main, /"direct_war_now="/);
  assert.match(main, /"direct_war_events=" \.\. direct_diplomacy_events/);
  assert.match(main, /"battles_against_interlocutor=unknown_not_tracked"/);
  assert.match(main, /"victories_against_interlocutor=unknown_not_tracked"/);
  assert.match(main, /PositiveDiplomaticEvent/);
  assert.match(main, /NegativeDiplomaticEvent/);
  assert.match(ui, /local function capture_personality/);
  assert.match(ui, /find_from\(right, "trait_list"\)/);
  assert.match(main, /local applied_delta = deferred and 0 or apply_relation_reaction/);
  assert.match(main, /return applied\s*\nend\s*\n\s*local function receive_chunk/);
  assert.match(ui, /"header", "porthole", "attitude_frame", "dy_value"/);
  assert.match(ui, /llmdip_t\("relation"\)/);
  assert.match(ui, /llmdip_t\("no_deal_reaction"\)/);
  assert.match(main, /cm:real_callback\(poll_inbox, 1000\)/);
  assert.doesNotMatch(main, /cm:callback\(poll_inbox/);
  const snapshot = main.slice(main.indexOf("local function campaign_snapshot"), main.indexOf("local function emit_chunks"));
  assert.doesNotMatch(snapshot, /llmdip_ui_/);
  assert.doesNotMatch(snapshot, /find_uicomponent|GetContextObject/);
  assert.match(renderer, /llmdip_publish_response/);
});

test("send and close paths avoid the transient diplomacy hierarchy", () => {
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  const send = ui.slice(ui.indexOf("local function send_text"), ui.indexOf('core:remove_listener("llmdip_contextual_clicks")'));
  const close = ui.slice(ui.indexOf("local function hide_dialog"), ui.indexOf("local function show_dialog"));
  assert.match(send, /local target, text = capture_target\(\), read_input_text\(\)/);
  assert.doesNotMatch(send, /:CreateComponent\(|Adopt\(|CopyComponent\(|Destroy\(/);
  assert.match(send, /pcall\(function\(\) return llmdip_send_request\(target, text, state\.attitude_value, state\.personality_attributes\) end\)/);
  assert.match(send, /clear_input_text\(\)/);
  assert.doesNotMatch(close, /diplomacy_panel|find_uicomponent|Destroy/);
  assert.match(close, /find_root\(CHAT_ID\), find_root\(HISTORY_ID\)/);
  assert.match(close, /set_input_focus\(false\)/);
  assert.match(close, /chat:SetVisible\(false\)/);
  assert.match(close, /history:SetVisible\(false\)/);
});

test("ships an independent Player2 chat template", () => {
  const template = fs.readFileSync(path.join(projectRoot, "mod", "llmdip_ui", "llmdip_chat.twui.xml"), "utf8");
  const history = fs.readFileSync(path.join(projectRoot, "mod", "llmdip_ui", "llmdip_history.twui.xml"), "utf8");
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  assert.match(template, /<entry_box[^>]+id="entry_box"/);
  assert.match(template, /callback_id="TextInput"/);
  assert.match(template, /id="entry_box" offset="0\.00,0\.00"/);
  assert.match(template, /uniqueguid="AB51E207/);
  assert.doesNotMatch(template, /history_box/);
  assert.match(history, /id="history_text"/);
  assert.match(history, /callback_id="TextInput"/);
  assert.match(history, /interactive="true"/);
  assert.match(history, /width="640" height="380"/);
  assert.match(history, /textxoffset="12\.00,60\.00"/);
  assert.match(history, /texthbehaviour="Never split"/);
  assert.match(history, /font_m_size="14"/);
  assert.match(history, /imagepath="ui\/skins\/default\/frame_text\.png"/);
  assert.doesNotMatch(history, /id="history_caption"/);
  assert.match(history, /textyoffset="10\.00,8\.00"/);
  assert.match(ui, /local lines = \{ "\[\[col:yellow\]\]" \.\. llmdip_t\("conversation"\)/);
  assert.match(template, /width="510" height="42"/);
  assert.match(template, /texthbehaviour="Never split"/);
  assert.match(ui, /^local INPUT_WIDTH = 510$/m);
  assert.match(ui, /^local CHAT_HEIGHT = 42$/m);
  assert.match(template, /font_m_size="14"/);
});

test("everything in the shell hangs from panel_frame, the component CreateComponent keeps", () => {
  const shell = fs.readFileSync(path.join(projectRoot, "mod", "llmdip_ui", "llmdip_shell.twui.xml"), "utf8");
  const hierarchy = shell.slice(shell.indexOf("<hierarchy>"), shell.indexOf("</hierarchy>"));
  const frame = hierarchy.slice(hierarchy.indexOf("<panel_frame"), hierarchy.indexOf("</panel_frame>"));
  const slots = Array.from({ length: 16 }, (_, i) => ["msg_icon_" + (i + 1), "msg_portrait_" + (i + 1)]).flat();
  // Portrait slots crop a wide porthole like vanilla agent_options dy_portrait.
  assert.equal((shell.match(/id="msg_portrait_\d+"[^>]*clipimagestocomponent="true"/g) || []).length, 16);
  assert.equal((shell.match(/offset="-33\.00,-8\.00" width="110" height="60"/g) || []).length, 16);
  // Layout v137 ignored dockpoint="Center" on these images (24-09): centre them by offset.
  const portraitBlocks = shell.split("<msg_portrait_").slice(1).filter(block => block.includes('id="msg_portrait_'));
  assert.equal(portraitBlocks.length, 16);
  assert.equal(portraitBlocks.filter(block => block.split("</msg_portrait_")[0].includes("dockpoint")).length, 0);
  for (const id of ["header_crest", ...slots, "header_title", "header_meta", "header_attitude", "proposal_card", "proposal_title", "proposal_detail"]) {
    assert.ok(frame.includes("<" + id + " "), id + " must be inside panel_frame");
  }
  assert.equal((hierarchy.match(/^      <[a-z_]+ /gm) || []).length, 1, "root must have a single child");
});

test("0.40 shell is visual-only, root-owned and keeps proven controls independent", () => {
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  const shell = fs.readFileSync(path.join(projectRoot, "mod", "llmdip_ui", "llmdip_shell.twui.xml"), "utf8");
  assert.match(ui, /root:CreateComponent\(SHELL_ID, "llmdip_ui\/llmdip_shell"\)/);
  assert.doesNotMatch(ui, /shell:CreateComponent\((?:CHAT_ID|HISTORY_ID)/);
  assert.match(ui, /history:MoveTo\(shell_left \+ 20, shell_top \+ SHELL_HEADER_HEIGHT\)/);
  assert.match(ui, /chat:MoveTo\(shell_left \+ 20, shell_top \+ SHELL_HEADER_HEIGHT \+ HISTORY_HEIGHT \+ 6\)/);
  assert.match(shell, /imagepath="ui\/skins\/default\/panel_back_tile\.png"/);
  assert.match(shell, /imagepath="ui\/skins\/default\/panel_back_border\.png"/);
  assert.match(shell, /id="panel_frame"[^>]+priority="20"/);
  assert.match(shell, /id="header_title"[^>]+priority="80"/);
  assert.match(ui, /shell:RegisterTopMost\(\); topmost\(history\); topmost\(chat\)/);
  assert.doesNotMatch(ui, /topmost\(shell\)/);
  assert.match(shell, /id="header_title"/);
  assert.match(shell, /id="header_meta"/);
  assert.match(shell, /id="header_attitude"[^>]+priority="80"/);
  assert.match(shell, /id="proposal_card"/);
  assert.match(shell, /height="60"[^>]+interactive="false"/);
  assert.match(shell, /id="proposal_title"/);
  assert.match(shell, /id="proposal_detail"/);
  assert.match(shell, /id="proposal_icon"/);
  assert.match(shell, /imagepath="ui\/skins\/default\/icon_diplomacy\.png"/);
  assert.match(ui, /proposal_card:SetVisible\(state\.proposal ~= nil\)/);
  assert.match(ui, /llmdip_action_label\(state\.proposal\)/);
  assert.match(ui, /attitude:SetStateText\(state\.header_attitude or ""\)/);
  assert.doesNotMatch(shell, /callback_id="TextInput"/);
});

test("history arrows scroll wrapped lines instead of skipping whole messages", () => {
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  assert.match(ui, /local HISTORY_TOTAL_LINES = math.floor\(\(HISTORY_HEIGHT - 24\) \/ 20\)/);
  assert.match(ui, /local HISTORY_SCROLL_STEP = 1/);
  assert.match(ui, /state\.proposal and math\.floor\(\(PROPOSAL_HISTORY_HEIGHT - 24\) \/ 20\) or HISTORY_TOTAL_LINES/);
  assert.match(ui, /return math\.max\(1, total - 2\)/);
  assert.doesNotMatch(ui, /local function history_header/);
  assert.match(ui, /local function wrap_history_text/);
  assert.match(ui, /local function latest_history_start/);
  assert.match(ui, /local function history_scroll_bounds/);
  assert.match(ui, /state\.history_offset - HISTORY_SCROLL_STEP/);
  assert.match(ui, /state\.history_offset \+ HISTORY_SCROLL_STEP/);
  assert.doesNotMatch(ui, /#history_for\(state\.target\) - 1/);
});

test("gold transfers are auditable and deal reactions wait for acceptance", () => {
  const main = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy.lua"), "utf8");
  assert.match(main, /\[LLMDIP\] GOLD_TRANSFER\|/);
  assert.match(main, /proposal\.relation_delta = relation_delta/);
  assert.match(main, /local deferred = proposal\.action\[1\] ~= "reject"/);
  assert.match(main, /if ok and proposal\.action\[1\] ~= "reject" then applied_delta = apply_relation_reaction/);
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  assert.match(ui, /llmdip_t\("reaction"\) \.\. timing/);
  assert.match(ui, /llmdip_t\("diplo_improved"\)/);
  assert.match(ui, /entry\.proposal = compact_action ~= "reject" and compact_action or nil/);
});

test("attitude capture reads the vanilla tooltip value, not dy_value state index", () => {
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  assert.match(ui, /local function attitude_from_tooltip/);
  assert.match(ui, /ATTITUDE_LOC_KEY/);
  assert.match(ui, /Valor total de actitud:/);
  assert.match(ui, /Gesamteinstellung:/);
  assert.match(ui, /GetTooltipText\(\)/);
  const capture = ui.slice(ui.indexOf("local function capture_attitude"), ui.indexOf("local function clean_attribute_text"));
  assert.match(capture, /component_attitude_score\(right\)/);
  assert.doesNotMatch(capture, /GetStateText/);
});

test("message icons use a proven vanilla button template, never a custom image-only layout", () => {
  // A custom image-only layout broke components on load and crashed diplomacy (24-09).
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8");
  assert.doesNotMatch(ui, /CreateComponent\(id, ICON_TEMPLATE\)/, "icons must come from the shell layout, not be created");
  assert.equal(fs.existsSync(path.join(projectRoot, "mod", "llmdip_ui", "llmdip_icon.twui.xml")), false);
});

test("every UI constant is declared before any function that reads it", () => {
  // MESSAGE_ICONS was declared below capture_header, which then read a nil
  // global: the portrait was never requested in game (24-09).
  // Comments may name a constant before it exists; only code counts.
  const ui = fs.readFileSync(path.join(projectRoot, "mod", "script", "campaign", "mod", "llm_diplomacy_ui.lua"), "utf8")
    .replace(/--.*$/gm, "");
  for (const [, name] of ui.matchAll(/^local ([A-Z][A-Z0-9_]+) = /gm)) {
    const declared = ui.search(new RegExp("^local " + name + " = ", "m"));
    const firstUse = ui.search(new RegExp("(^|[^A-Za-z0-9_])" + name + "(?![A-Za-z0-9_])", "m")) + 1;
    assert.equal(firstUse, declared + "local ".length, name + " is used before its declaration");
  }
});
