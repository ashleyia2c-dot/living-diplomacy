-- Player-turn mailbox: data arrival never opens diplomacy or an intervention.
setfenv(1, core:get_env())
local KEY = "llmdip39_mailbox"
local BUTTON, PANEL = "llmdip39_mail_button", "llmdip39_mail_panel"
local box = {rows = {}, round = -1, queries = 0, contacted = {}}
local page, shown, blocked = 1, false, {}
local invalid_root_reported = false
local blocking_panels = {diplomacy_dropdown=true, technology_panel=true, character_details=true,
    recruitment=true, building_browser=true, dilemma=true, events=true, event_message=true,
    settlement_captured=true, esc_menu=true, campaign_menu=true}
local function clone(v)
    if type(v) ~= "table" then return v end
    local r = {}; for k, x in pairs(v) do r[k] = clone(x) end; return r
end
local function save() cm:set_saved_value(KEY, clone(box)) end
local function short(value, limit)
    local chars = {}
    for ch in string.gmatch(tostring(value), "[%z\1-\127\194-\244][\128-\191]*") do
        if #chars == limit then return table.concat(chars) .. "..." end
        chars[#chars+1] = ch
    end
    return table.concat(chars)
end
local function live(u)
    if not u or not is_uicomponent(u) then return false end
    local ok, valid = pcall(function() return u:IsValid() end)
    return ok and valid == true
end
local function checked_root()
    local root = core:get_ui_root()
    if live(root) then invalid_root_reported = false; return root end
    if not invalid_root_reported then
        invalid_root_reported = true
        out("[LLMDIP] UI_UNAVAILABLE|mailbox|" .. tostring(root) .. "|prefix=" .. string.sub(tostring(root), 1, 12) .. "|typecheck=" .. tostring(is_uicomponent(root)))
    end
    return nil
end
local function find(id, parent)
    -- Never pass a rejected parent to the native helper, or silently search a
    -- different hierarchy when an explicitly supplied parent has disappeared.
    parent = parent or checked_root()
    if not live(parent) then return nil end
    local ok, u = pcall(function() return find_uicomponent(parent, id) end)
    return ok and live(u) and u or nil
end
local function allowed()
    if not llmdip_player_phase() then return false end
    if next(blocked) then return false end
    return not cm:is_processing_battle() and not cm:is_pending_battle_active()
end
local function unread()
    local n = 0; for _, row in ipairs(box.rows) do if not row.read then n = n + 1 end end; return n
end
local function text(u, value)
    -- Use the real text control, not an unrelated container's state. Some TWUI
    -- loaders return the text control itself, as in the manual chat template.
    local field = find("history_text", u) or u
    field:SetStateText(value); field:SetInteractive(false)
end
local function icon(parent, id, image, tooltip, x, y)
    local u = find(id, parent) or UIComponent(parent:CreateComponent(id, "ui/templates/square_medium_button"))
    u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:Resize(32, 32)
    u:SetImagePath(image); u:SetTooltipText(tooltip, true)
    u:SetDockingPoint(1); u:SetDockOffset(x, y); u:SetVisible(true)
    return u
end
local function panel()
    local root = checked_root(); if not root then return nil end
    local u = find(PANEL)
    if not u then
        out("[LLMDIP] MAIL_PANEL_CREATE_BEGIN|verified_history_template")
        u = UIComponent(root:CreateComponent(PANEL, "llmdip_ui/llmdip_history"))
        if not live(u) then return nil end
        out("[LLMDIP] MAIL_PANEL_CREATE_DONE")
        u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:Resize(540, 370)
        local field = find("history_text", u) or u
        field:SetCanResizeWidth(true); field:SetCanResizeHeight(true); field:Resize(540,370)
        field:SetInteractive(false); u:PropagatePriority(200)
        out("[LLMDIP] MAIL_PANEL_LAYOUT_DONE")
        icon(u, "llmdip39_mail_close", "ui/skins/default/icon_cross.png", llmdip_t("close_mailbox"), 495, 8)
        icon(u, "llmdip39_mail_prev", "ui/skins/default/icon_arrow_up.png", llmdip_t("prev_page"), 410, 325)
        icon(u, "llmdip39_mail_next", "ui/skins/default/icon_arrow_down.png", llmdip_t("next_page"), 454, 325)
        for i = 1, 3 do
            icon(u, "llmdip39_mail_reply_" .. i, "ui/skins/default/icon_diplomacy.png", llmdip_t("reply_in_diplomacy"), 490, 66 + (i-1)*83)
        end
        out("[LLMDIP] MAIL_PANEL_CONTROLS_DONE")
    end
    local sw, sh = root:Bounds()
    u:MoveTo(math.max(5, math.floor((sw-540)/2)), math.max(70, math.floor((sh-370)/2)))
    return u
end
local function refresh()
    local b = find(BUTTON)
    if b then
        b:SetTooltipText(llmdip_t("diplomatic_messages") .. unread() .. llmdip_t("unread_hint"), true)
        local label = find("button_txt", b)
        if label then label:SetStateText(llmdip_t("ai_messages_button") .. unread() .. ")"); label:SetInteractive(false) end
    end
    if not shown then return end
    local p = panel()
    if not p then shown=false; return end
    page = math.max(1, math.min(page, math.max(1, math.ceil(#box.rows/3))))
    local lines = {llmdip_t("mailbox_title") .. unread() .. ")", ""}
    if #box.rows == 0 then
        lines[#lines+1] = llmdip_t("no_letters")
        lines[#lines+1] = llmdip_t("one_per_turn")
    end
    for i = 1, 3 do
        local row = box.rows[(page-1)*3+i]
        local reply = find("llmdip39_mail_reply_" .. i, p)
        reply:SetVisible(row ~= nil)
        if row then
            local preview = string.gsub(row.text, "[\r\n]+", " ")
            lines[#lines+1] = (row.read and "" or "* ") .. short(row.faction, 36)
            lines[#lines+1] = short(row.lord, 26) .. llmdip_t("turn_sep") .. row.turn
            lines[#lines+1] = short(preview, 45)
            lines[#lines+1] = row.status .. llmdip_t("reply_suffix")
            lines[#lines+1] = ""
            reply:SetTooltipText(row.faction .. " / " .. row.lord .. "\n" .. row.text .. llmdip_t("reply_in_chat"), true)
        end
    end
    text(p, table.concat(lines, "\n")); p:SetVisible(true)
end
function llmdip_mail_hide()
    local was_shown = shown; shown = false
    if was_shown then local p = find(PANEL); if p then p:SetVisible(false) end end
    local b = find(BUTTON); if b and not llmdip_player_phase() then b:SetVisible(false) end
end
function llmdip_mail_receive(id, proposal, narrative, action)
    for _, row in ipairs(box.rows) do if row.id == id then return end end
    table.insert(box.rows, 1, {id=id, target=proposal.interlocutor,
        faction=proposal.faction_name or proposal.interlocutor, lord=proposal.leader or llmdip_t("unknown_lord"),
        turn=proposal.turn, text=narrative, read=false,
        status=action == "reject" and llmdip_t("conversation") or (action == "betray_war" and llmdip_t("betrayal_status") or llmdip_t("pending_proposal"))})
    while #box.rows > 200 do table.remove(box.rows) end
    save(); refresh()
end
function llmdip_mail_read(target)
    for _, row in ipairs(box.rows) do if row.target == target then row.read = true end end
    save(); refresh()
end
function llmdip_mail_supersede(id)
    for _, row in ipairs(box.rows) do if row.id == id then row.status = llmdip_t("open_conversation_btn") end end
    save()
end
function llmdip_mail_finished(id) out("[LLMDIP] MAIL_CHECK_DONE|" .. tostring(id)) end
function llmdip_mail_contacts_changed() box.exhausted=false; save() end
function llmdip_mail_tick()
    if not allowed() then return end
    local parent = checked_root()
    if not parent then return end
    local b = find(BUTTON)
    if not b then
        b = UIComponent(parent:CreateComponent(BUTTON, "ui/templates/square_medium_text_button"))
        if not live(b) then return end
        b:SetCanResizeWidth(true); b:SetCanResizeHeight(true); b:Resize(180,36)
        b:SetDockingPoint(1); b:SetDockOffset(190,123)
        b:PropagatePriority(200); b:SetInteractive(true)
        if not find("button_txt", b) then error("Falta button_txt en el botón de mensajes") end
        out("[LLMDIP] MAIL_BUTTON_CREATED|top_left|190|123|0.39.8")
    end
    -- Persistent root ownership, like the existing LLM contact button. Do not
    -- insert a new child in the engine-owned menu_bar/buttongroup layout.
    b:SetVisible(true); refresh()
    local round = cm:model():turn_number()
    if box.round ~= round then box.round=round; box.queries=0; box.contacted={}; box.exhausted=false; save() end
    -- Unread letters are not a rejection and do not prevent next-turn letters.
    -- contacted is saved with the campaign; the bridge also checks the last turn.
    if shown or box.exhausted then return end
    local target, exhausted = llmdip_mail_request(box.contacted)
    if target then box.contacted[target]=true; box.queries=box.queries+1
    elseif exhausted then box.exhausted=true end
    save()
end
core:add_listener("llmdip39_mail_click", "ComponentLClickUp", true, function(context)
    local id = context.string
    if id == "llmdip39_mail_close" then llmdip_mail_hide(); return end
    if not allowed() then return end
    if id == BUTTON then
        if shown then llmdip_mail_hide()
        else
            out("[LLMDIP] MAIL_OPEN_BEGIN")
            shown=true; refresh()
            if shown then out("[LLMDIP] MAIL_OPEN_DONE") end
        end
    elseif shown and id == "llmdip39_mail_prev" then page=math.max(1,page-1); refresh()
    elseif shown and id == "llmdip39_mail_next" then page=page+1; refresh()
    elseif shown then
        local slot = tonumber(string.match(id or "", "^llmdip39_mail_reply_(%d)$"))
        local row = slot and box.rows[(page-1)*3+slot]
        if row then
            local ai = cm:get_faction(row.target)
            if not ai or ai:is_null_interface() or ai:is_dead() or ai:is_human() then
                row.status=llmdip_t("faction_unavailable"); save(); refresh(); return
            end
            if llmdip_ui_open_target(row.target) then llmdip_mail_hide()
            else row.status=llmdip_t("open_diplomacy_hint"); save(); refresh() end
        end
    end
end, true)
core:add_listener("llmdip39_mail_panel_open", "PanelOpenedCampaign", true, function(context)
    local name = context.string or ""
    if blocking_panels[name] or string.match(name, "^popup_") then
        blocked[name]=true
        if shown then llmdip_mail_hide() end
    end
end, true)
core:add_listener("llmdip39_mail_panel_close", "PanelClosedCampaign", true, function(context)
    blocked[context.string]=nil
end, true)
cm:add_first_tick_callback(function()
    box=cm:get_saved_value(KEY) or box
    shown=false; blocked={}
end)
