-- Player2 dialogue for WH3's bilateral diplomacy screen.
-- Editable/history controls are persistent children of the campaign UI root,
-- like Console Commands. They are positioned over vanilla diplomacy but never
-- adopted by panel_diplomacy, whose C++ hierarchy is destroyed on exit.
setfenv(1, core:get_env())

local state = {
    visible = false, target = nil, response = llmdip_t("open_conversation"),
    request_id = nil, proposal = nil, inbox = {}, history_offset = 0,
    attitude_value = nil, attitude_label = "", personality_attributes = "unknown"
}
local wanted_target = nil
local function persist_history()
    local function copy(value)
        if type(value) ~= "table" then return value end
        local result = {}; for k, v in pairs(value) do result[k] = copy(v) end
        return result
    end
    cm:set_saved_value("llmdip39_history", copy(state.inbox))
end

local CHAT_ID = "llmdip_diplomacy_chat"
local HISTORY_ID = "llmdip_diplomacy_history"
local TALK_ID = "llmdip_diplomacy_talk"
local SEND_ID = "llmdip_diplomacy_send"
local CLOSE_ID = "llmdip_diplomacy_close"
local ACCEPT_ID = "llmdip_diplomacy_accept"
local HISTORY_PREV_ID = "llmdip_diplomacy_history_prev"
local HISTORY_NEXT_ID = "llmdip_diplomacy_history_next"
local UI_WIDTH = 560
local CHAT_HEIGHT = 42
local HISTORY_HEIGHT = 350
-- Conservative width/leading budget: reserve space for arrows, header and footer.
-- The native font may be wider than font_m_size because of the game's font category.
-- Keep the Lua wrap budget in sync with the native state below.  The
-- The verified history panel reserves a right gutter for its two arrows. Keep
-- a little extra safety margin because the game's font metrics are wider than
-- the Lua estimate; otherwise the final word can still run under an arrow.
-- The native state remains 560px wide, while Lua wraps to this conservative
-- inner width and the template's Never split mode prevents a second wrap.
local HISTORY_TEXT_WIDTH = UI_WIDTH - 112
local HISTORY_TOTAL_LINES = math.floor((HISTORY_HEIGHT - 24) / 20)
local HISTORY_SCROLL_STEP = 1

local function valid_key(value)
    return type(value) == "string" and string.match(value, "^[a-z0-9_]+$") and value or nil
end
local function ui_root() return core:get_ui_root() end
local function live(component)
    if not component or not is_uicomponent(component) then return false end
    local ok, value = pcall(function() return component:IsValid() end)
    return ok and value == true
end
local function find_from(parent, id)
    if not live(parent) then return nil end
    local ok, value = pcall(function() return find_uicomponent(parent, id) end)
    return ok and live(value) and value or nil
end
local function find_root(id) return find_from(ui_root(), id) end
local function diplomacy_panel() return find_root("panel_diplomacy") end
local function topmost(component)
    if not live(component) then return end
    component:PropagatePriority(200); component:RegisterTopMost()
end
local function create_icon(parent, id, image, dock_x, tooltip)
    local button = find_from(parent, id)
    if button then return button end
    button = UIComponent(parent:CreateComponent(id, "ui/templates/square_medium_button"))
    button:SetCanResizeWidth(true); button:SetCanResizeHeight(true); button:Resize(34, 34)
    button:SetImagePath(image); button:SetTooltipText(tooltip, true)
    button:SetDockingPoint(6); button:SetDockOffset(dock_x, 0); button:SetVisible(true); topmost(button)
    return button
end

local function ensure_owned_ui()
    local root = ui_root()
    if not live(root) then return nil, nil end
    local chat = find_root(CHAT_ID)
    if not chat then
        chat = UIComponent(root:CreateComponent(CHAT_ID, "llmdip_ui/llmdip_chat"))
        chat:SetCanResizeWidth(true); chat:SetCanResizeHeight(true); chat:Resize(UI_WIDTH, CHAT_HEIGHT)
        create_icon(chat, SEND_ID, "ui/skins/default/icon_tick.png", 50, llmdip_t("send_tooltip"))
        create_icon(chat, ACCEPT_ID, "ui/skins/default/icon_diplomacy.png", 92, llmdip_t("accept_tooltip"))
        create_icon(chat, CLOSE_ID, "ui/skins/default/icon_cross.png", 134, llmdip_t("close_dialog"))
        chat:SetVisible(false); topmost(chat)
    end
    local history = find_root(HISTORY_ID)
    if not history then
        history = UIComponent(root:CreateComponent(HISTORY_ID, "llmdip_ui/llmdip_history"))
        history:SetCanResizeWidth(true); history:SetCanResizeHeight(true); history:Resize(UI_WIDTH, HISTORY_HEIGHT)
        local up = UIComponent(history:CreateComponent(HISTORY_PREV_ID, "ui/templates/square_medium_button"))
        up:SetCanResizeWidth(true); up:SetCanResizeHeight(true); up:Resize(34, 34)
        up:SetImagePath("ui/skins/default/icon_arrow_up.png"); up:SetTooltipText(llmdip_t("older_messages"), true)
        up:SetDockingPoint(3); up:SetDockOffset(-8, 2); up:SetVisible(true); topmost(up)
        local down = UIComponent(history:CreateComponent(HISTORY_NEXT_ID, "ui/templates/square_medium_button"))
        down:SetCanResizeWidth(true); down:SetCanResizeHeight(true); down:Resize(34, 34)
        down:SetImagePath("ui/skins/default/icon_arrow_down.png"); down:SetTooltipText(llmdip_t("newer_messages"), true)
        down:SetDockingPoint(3); down:SetDockOffset(-8, 39); down:SetVisible(true); topmost(down)
        history:SetVisible(false); topmost(history)
    end
    local input = find_from(chat, "entry_box")
    if input then input:SetCanResizeWidth(true); input:SetCanResizeHeight(true); input:Resize(UI_WIDTH, CHAT_HEIGHT) end
    local history_field = find_from(history, "history_text")
    if history_field then
        history_field:SetCanResizeWidth(true); history_field:SetCanResizeHeight(true)
        history_field:Resize(UI_WIDTH, HISTORY_HEIGHT)
    end
    return chat, history
end

local function position_owned_ui()
    local panel = diplomacy_panel()
    if not panel then return false end
    local chat, history = ensure_owned_ui()
    if not live(chat) or not live(history) then return false end
    local x, y = panel:Position(); local width, height = panel:Bounds()
    local left = math.floor(x + (width - UI_WIDTH) / 2); local centre_y = math.floor(y + height / 2)
    -- Keep the input in its proven position and grow the history upward.
    history:MoveTo(left, math.max(8, centre_y + 38 - HISTORY_HEIGHT - 6)); chat:MoveTo(left, centre_y + 38)
    topmost(history); topmost(chat)
    return true
end

local function faction_from_uic(component)
    if not live(component) then return nil end
    local probes = {
        {"CcoCampaignFaction", "FactionRecordContext.Key"}, {"CcoCampaignFaction", "Key"},
        {"CcoCampaignNegotiation", "TargetFactionContext.FactionRecordContext.Key"},
        {"CcoCampaignNegotiation", "TargetFactionContext.Key"}
    }
    for i = 1, #probes do
        local ok, value = pcall(function()
            local context = component:GetContextObject(probes[i][1]); return context and context:Call(probes[i][2])
        end)
        local key = ok and valid_key(value) or nil
        if key and key ~= cm:get_local_faction_name(true) then return key end
    end
    return nil
end
local function faction_in_tree(parent, budget)
    if not live(parent) then return nil end
    local visited = 0
    local function walk(node)
        if not live(node) or visited >= budget then return nil end
        visited = visited + 1
        local key = faction_from_uic(node); if key then return key end
        local ok, count = pcall(function() return node:ChildCount() end); if not ok then return nil end
        for i = 0, count - 1 do
            local child_ok, child = pcall(function() return UIComponent(node:Find(i, false)) end)
            if child_ok and live(child) then
                local found = walk(child); if found then return found end
            end
        end
        return nil
    end
    return walk(parent)
end
local function select_target(target)
    if state.target == target then return end
    state.target = target; state.history_offset = 0
    local entry = target and state.inbox[target] or nil
    state.request_id = entry and entry.request or nil
    state.proposal = entry and entry.proposal or nil
    state.response = entry and entry.response or ""
    state.attitude_value = entry and entry.attitude_value or nil
    state.attitude_label = entry and entry.attitude_label or ""
    state.personality_attributes = entry and entry.personality_attributes or "unknown"
end
local function capture_target()
    local right = find_root("faction_right_status_panel")
    local target = faction_from_uic(right) or faction_in_tree(right, 360)
    select_target(target) -- A failed lookup must never retain the previous faction.
    return target
end

-- La etiqueta "Total attitude value:" del tooltip vanilla, en los 13 idiomas del
-- juego. Sacadas de sus propios packs de localizacion, no traducidas a mano.
local ATTITUDE_LOC_KEY = "uied_component_texts_localised_string_tx_total_attitude_NewState_Text_5c0047"
local ATTITUDE_LABELS_ORDER = { "en", "es", "fr", "de", "it", "ru", "pl", "cs", "tr", "ko", "pt", "zh", "tw" }
local ATTITUDE_LABELS = {
    en = "Total attitude value:",
    es = "Valor total de actitud:",
    fr = "Valeur totale de l'attitude :",
    de = "Gesamteinstellung:",
    it = "Valore totale atteggiamento:",
    ru = "Общий уровень отношения:",
    pl = "Całkowita wartość nastawienia:",
    cs = "Celkový postoj:",
    tr = "Toplam tutum değeri:",
    ko = "총 태도 가치:",
    pt = "Valor total da postura:",
    zh = "总体态度值：",
    tw = "總態度值："
}

-- Chino y coreano usan dos puntos de ancho completo; se normalizan para poder
-- trabajar con un unico patron.
local function normalise_colons(value)
    return (string.gsub(tostring(value or ""), "\239\188\154", ":"))
end

local function escape_pattern(value)
    return (string.gsub(value, "([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1"))
end

local function attitude_from_tooltip(text)
    local normalised = normalise_colons(text)
    local candidates = {}
    -- Primero la etiqueta que el juego esta usando AHORA, sea cual sea su idioma:
    -- asi funciona incluso en un idioma que no tengamos en la tabla.
    local ok, live = pcall(function() return common.get_localised_string(ATTITUDE_LOC_KEY) end)
    if ok and type(live) == "string" and live ~= "" and live ~= ATTITUDE_LOC_KEY then
        candidates[#candidates + 1] = live
    end
    for i = 1, #ATTITUDE_LABELS_ORDER do
        candidates[#candidates + 1] = ATTITUDE_LABELS[ATTITUDE_LABELS_ORDER[i]]
    end
    for i = 1, #candidates do
        local label = escape_pattern(normalise_colons(candidates[i]))
        local value = string.match(normalised, label .. "%s*([%-]?%d+)")
        if value then return tonumber(value) end
    end
    -- Ultimo recurso para un idioma o un formato que no reconozcamos: el numero que
    -- sigue a los ultimos dos puntos del tooltip, que es donde va el total.
    local last
    for value in string.gmatch(normalised, ":%s*([%-]?%d+)") do last = value end
    if last then return tonumber(last) end
    return nil
end

local function component_attitude_score(right)
    local candidates = {}
    local paths = {
        {"header", "porthole", "attitude_frame", "dy_value"},
        {"header", "porthole", "attitude_frame", "dy_attitude"},
        {"header", "porthole", "attitude_frame", "attitude"},
        {"header", "porthole", "attitude_frame"}
    }
    for i = 1, #paths do
        local ok, component = pcall(function()
            return find_uicomponent(right, unpack(paths[i]))
        end)
        if ok and live(component) then candidates[#candidates + 1] = component end
    end
    -- The number shown beside the portrait is also repeated in the vanilla
    -- attitude tooltip. Prefer that value: dy_value's state text is the state
    -- index (e.g. 2), not the diplomatic score (e.g. -93).
    for i = 1, #candidates do
        local ok, tooltip = pcall(function() return candidates[i]:GetTooltipText() end)
        local score = ok and attitude_from_tooltip(tooltip) or nil
        if score ~= nil then return score end
    end
    return nil
end

local function capture_attitude(target)
    state.attitude_value, state.attitude_label = nil, ""
    local right = find_root("faction_right_status_panel")
    if right then state.attitude_value = component_attitude_score(right) end
    if target then
        local ok, label = pcall(function()
            return common.get_context_value("CcoCampaignFaction", target, "AttitudeTooltip")
        end)
        if ok and type(label) == "string" then state.attitude_label = string.gsub(label, "[\r\n]+", " ") end
        local entry = state.inbox[target] or {}
        entry.attitude_value, entry.attitude_label = state.attitude_value, state.attitude_label
        state.inbox[target] = entry
    end
    out("[LLMDIP UI] ATTITUDE|" .. tostring(target) .. "|" .. tostring(state.attitude_value) .. "|" .. state.attitude_label)
end

local function clean_attribute_text(value)
    value = string.gsub(tostring(value or ""), "[\r\n,;|=]+", " ")
    value = string.gsub(value, "%s+", " ")
    return string.match(value, "^%s*(.-)%s*$") or ""
end

local function capture_personality(target)
    local right = find_root("faction_right_status_panel")
    local trait_list = right and find_from(right, "trait_list") or nil
    local values, seen, visited = {}, {}, 0
    local function walk(component)
        if not live(component) or visited >= 120 or #values >= 12 then return end
        visited = visited + 1
        local ok_text, raw = pcall(function() return component:GetStateText() end)
        local value = ok_text and clean_attribute_text(raw) or ""
        if value ~= "" and #value <= 80 and not seen[value] then
            seen[value] = true; values[#values + 1] = value
        end
        local ok_count, count = pcall(function() return component:ChildCount() end)
        if not ok_count then return end
        for i = 0, count - 1 do
            local ok_child, child = pcall(function() return UIComponent(component:Find(i, false)) end)
            if ok_child and live(child) then walk(child) end
        end
    end
    if trait_list then walk(trait_list) end
    state.personality_attributes = #values > 0 and table.concat(values, ":") or "unknown"
    if target then
        local entry = state.inbox[target] or {}
        entry.personality_attributes = state.personality_attributes
        state.inbox[target] = entry
    end
    out("[LLMDIP UI] PERSONALITY|" .. tostring(target) .. "|" .. state.personality_attributes)
end

local function history_for(target)
    if not target then return {} end
    local entry = state.inbox[target] or {}; entry.history = entry.history or {}; state.inbox[target] = entry
    return entry.history
end
local function add_history(target, speaker, text)
    if not target or type(text) ~= "string" or text == "" then return end
    local history = history_for(target)
    history[#history + 1] = speaker .. ": " .. string.gsub(text, "[\r\n]+", " ")
    while #history > 30 do table.remove(history, 1) end
    if state.target == target then state.history_offset = 0 end
    persist_history()
end
local function history_char_width(char)
    -- Approximate logical glyph widths for the existing size-14 game font.
    -- The frame has padding and an arrow gutter; UI scale scales both together.
    if char == " " then return 4.5 end
    if string.match(char, "^[ilIjtfr%.,:;!'|]$") then return 5 end
    if string.match(char, "^[MWmw@%%]$") then return 13 end
    if #char >= 3 then return 16 end
    if string.match(char, "^[A-Z]$") then return 10 end
    return 8.5
end
local function wrap_history_text(text)
    local lines, current = {}, ""
    local current_length = 0
    text = string.gsub(tostring(text or ""), "[\r\n]+", " ")
    for word in string.gmatch(text, "%S+") do
        -- Lua 5.1 has no utf8 library. Never split an accented character mid-byte.
        local chars = {}
        for char in string.gmatch(word, "[%z\1-\127\194-\244][\128-\191]*") do chars[#chars + 1] = char end
        local word_width = 0
        for i = 1, #chars do word_width = word_width + history_char_width(chars[i]) end
        if word_width <= HISTORY_TEXT_WIDTH then
            -- Keep ordinary words intact.  Splitting a word merely because
            -- its last few glyphs cross the estimate is what produced rows
            -- containing just "respuesta" or another orphaned fragment.
            if current ~= "" and current_length + 4.5 + word_width > HISTORY_TEXT_WIDTH then
                lines[#lines + 1] = current; current, current_length = "", 0
            end
            if current ~= "" then current = current .. " "; current_length = current_length + 4.5 end
            current = current .. word; current_length = current_length + word_width
        else
            -- Only an unbroken token wider than the whole panel may be split;
            -- this keeps keys/URLs readable without ever emitting an empty row.
            if current ~= "" then lines[#lines + 1] = current; current, current_length = "", 0 end
            for i = 1, #chars do
                local width = history_char_width(chars[i])
                if current ~= "" and current_length + width > HISTORY_TEXT_WIDTH then
                    lines[#lines + 1] = current; current, current_length = "", 0
                end
                current = current .. chars[i]; current_length = current_length + width
            end
        end
    end
    if current ~= "" then lines[#lines + 1] = current end
    return lines
end
local function history_header(target)
    local entry = state.inbox[target] or {}
    local value = entry.attitude_value ~= nil and tostring(entry.attitude_value) or llmdip_t("unknown_value")
    local label = entry.attitude_label and entry.attitude_label ~= "" and (" — " .. entry.attitude_label) or ""
    return wrap_history_text(llmdip_t("relation") .. value .. label)
end
local function history_capacity(target)
    return math.max(1, HISTORY_TOTAL_LINES - #history_header(target) - 1)
end
local function history_body_lines(target)
    local result, history = {}, history_for(target)
    for i = 1, #history do
        local wrapped = wrap_history_text(history[i])
        for j = 1, #wrapped do result[#result + 1] = wrapped[j] end
    end
    return result
end
local function latest_history_start(target)
    local history, before = history_for(target), 0
    for i = 1, math.max(0, #history - 1) do
        before = before + #wrap_history_text(history[i])
    end
    return before + 1
end
local function history_scroll_bounds(target)
    local body = history_body_lines(target)
    if #body == 0 then return 0, 0, 1 end
    local last_start = latest_history_start(target)
    local greatest_start = math.max(1, #body - history_capacity(target) + 1)
    local base = math.min(last_start, greatest_start)
    return 1 - base, greatest_start - base, base
end
local function history_display(target)
    local body = history_body_lines(target)
    local lines = history_header(target)
    if #body == 0 then lines[#lines + 1] = llmdip_t("no_messages_yet"); return table.concat(lines, "\n") end
    local minimum, maximum, base = history_scroll_bounds(target)
    state.history_offset = math.max(minimum, math.min(maximum, state.history_offset))
    local first = base + state.history_offset
    local last = math.min(#body, first + history_capacity(target) - 1)
    for i = first, last do lines[#lines + 1] = body[i] end
    lines[#lines + 1] = llmdip_t("lines") .. first .. "–" .. last .. " / " .. #body .. llmdip_t("lines_hint")
    return table.concat(lines, "\n")
end
local function set_history_text(text)
    local _, history = ensure_owned_ui()
    local field = find_from(history, "history_text") or history
    if field then pcall(function() field:SetStateText(text or "") end); field:SetInteractive(false) end
end
local function refresh_owned_ui()
    local chat, history = ensure_owned_ui(); set_history_text(history_display(state.target))
    if not live(chat) or not live(history) then return end
    local input = find_from(chat, "entry_box")
    if input then input:SetInteractive(true); input:SetTooltipText("Player2: " .. state.response, true) end
    local accept = find_from(chat, ACCEPT_ID); if accept then accept:SetVisible(state.proposal ~= nil) end
    history:SetVisible(state.visible); chat:SetVisible(state.visible)
end
local function set_input_focus(enabled)
    local chat = find_root(CHAT_ID)
    if chat then pcall(function() chat:StealInputFocus(enabled) end) end
end
local function read_input_text()
    local chat = find_root(CHAT_ID); if not chat then return "" end
    local text = chat:GetStateText() or ""; if text ~= "" then return text end
    local input = find_from(chat, "entry_box"); return input and (input:GetStateText() or "") or ""
end
local function clear_input_text()
    local chat = find_root(CHAT_ID); if not chat then return end
    pcall(function() chat:SetStateText("") end)
    local input = find_from(chat, "entry_box"); if input then pcall(function() input:SetStateText("") end) end
    cm:real_callback(function()
        local current = find_root(CHAT_ID)
        if current then pcall(function() current:SetStateText("") end) end
    end, 200)
end
local function hide_dialog()
    state.visible = false; set_input_focus(false)
    local chat, history = find_root(CHAT_ID), find_root(HISTORY_ID)
    if chat then chat:SetVisible(false) end
    if history then history:SetVisible(false) end
    out("[LLMDIP UI] CHAT_CLOSED")
end
local function show_dialog()
    local target = capture_target()
    if target then
        capture_attitude(target)
        capture_personality(target)
        local saved = state.inbox[target]
        state.request_id = saved and saved.request or nil; state.proposal = saved and saved.proposal or nil
        state.response = saved and saved.response or llmdip_t("input_placeholder")
    else state.response = llmdip_t("no_target_yet") end
    state.visible = true; state.history_offset = 0
    if target and llmdip_mail_read then llmdip_mail_read(target) end
    position_owned_ui(); refresh_owned_ui()
    cm:real_callback(function() if state.visible then set_input_focus(true) end end, 40)
end

-- Only invoked by the player's explicit Reply click, never by message arrival.
function llmdip_ui_open_target(target)
    if not valid_key(target) or not llmdip_player_phase() then return false end
    if cm:is_processing_battle() or cm:is_pending_battle_active() then return false end
    wanted_target = target
    local ok = pcall(function() common.call_context_command("CcoCampaignFaction", target, "OpenDiplomacyWith") end)
    if not ok then wanted_target = nil; return false end
    cm:real_callback(function()
        if wanted_target ~= target or not llmdip_player_phase() then return end
        if capture_target() == target then wanted_target = nil; show_dialog()
        else wanted_target = nil; out("[LLMDIP] MAIL_OPEN_FAILED|" .. target) end
    end, 700)
    return true
end
local function toggle_dialog() if state.visible then hide_dialog() else show_dialog() end end

local function ensure_talk_button()
    local panel = diplomacy_panel(); if not panel then return nil end
    local button = find_from(panel, TALK_ID); if button then return button end
    local ok, value = pcall(function()
        local created = UIComponent(panel:CreateComponent(TALK_ID, "ui/templates/round_small_button"))
        created:SetCanResizeWidth(true); created:SetCanResizeHeight(true); created:Resize(34, 34)
        created:SetImagePath("ui/skins/default/icon_diplomacy.png")
        created:SetTooltipText(llmdip_t("talk_tooltip"), true)
        created:SetDockingPoint(3); created:SetDockOffset(-42, 8); created:SetVisible(true); topmost(created)
        return created
    end)
    if not ok then out("[LLMDIP UI] TALK_BUTTON_ERROR|" .. tostring(value)); return nil end
    return value
end

local function send_text()
    local previous_target = state.target
    local target, text = capture_target(), read_input_text()
    out("[LLMDIP UI] INPUT_LENGTH|" .. tostring(#text)); out("[LLMDIP UI] SEND_TARGET|" .. tostring(target))
    if not target then state.response = llmdip_t("no_target"); refresh_owned_ui(); return end
    if target ~= previous_target then
        state.response = llmdip_t("target_changed")
        capture_attitude(target); capture_personality(target); refresh_owned_ui(); return
    end
    if type(text) ~= "string" or #text < 1 or #text > 1200 then
        state.response = llmdip_t("message_too_long"); refresh_owned_ui(); return
    end
    out("[LLMDIP UI] SEND_BEGIN")
    local ok, sent = pcall(function() return llmdip_send_request(target, text, state.attitude_value, state.personality_attributes) end)
    out("[LLMDIP UI] SEND_END|" .. tostring(ok) .. "|" .. tostring(sent))
    if not ok or not sent then state.response = llmdip_t("send_failed"); refresh_owned_ui(); return end
    add_history(target, llmdip_t("you"), text); add_history(target, "Player2", llmdip_t("thinking"))
    state.response = llmdip_t("waiting"); clear_input_text(); set_history_text(history_display(target))
end

core:remove_listener("llmdip_contextual_clicks")
core:add_listener("llmdip_contextual_clicks", "ComponentLClickUp", true, function(context)
    local id = context.string
    if id == TALK_ID then toggle_dialog()
    elseif id == SEND_ID then send_text()
    elseif id == CLOSE_ID then hide_dialog()
    elseif id == ACCEPT_ID and state.request_id and state.proposal then
        llmdip_accept(state.request_id); state.proposal = nil
        state.response = state.response .. llmdip_t("applying_proposal"); refresh_owned_ui()
    elseif id == HISTORY_PREV_ID then
        -- Move one logical wrapped line at a time, rather than jumping to a
        -- different message.  Up is older; down (below) is newer.
        local minimum = history_scroll_bounds(state.target)
        state.history_offset = math.max(minimum, state.history_offset - HISTORY_SCROLL_STEP)
        set_history_text(history_display(state.target))
    elseif id == HISTORY_NEXT_ID then
        local _, maximum = history_scroll_bounds(state.target)
        state.history_offset = math.min(maximum, state.history_offset + HISTORY_SCROLL_STEP)
        set_history_text(history_display(state.target))
    elseif id == "entry_box" and state.visible then set_input_focus(true) end
end, true)

core:remove_listener("llmdip_contextual_diplomacy_open")
core:add_listener("llmdip_contextual_diplomacy_open", "PanelOpenedCampaign", function(context)
    return context.string == "diplomacy_dropdown"
end, function()
    out("[LLMDIP] UI_DIPLOMACY_OPEN|0.39.1")
    cm:real_callback(function()
        -- An open event is not a lifetime guarantee for this delayed callback.
        if not diplomacy_panel() then out("[LLMDIP] UI_DIPLOMACY_DEFER|panel_unavailable"); return end
        out("[LLMDIP] UI_DIPLOMACY_ATTACH_BEGIN")
        -- Do not walk CCO faction contexts while the vanilla diplomacy panel
        -- is still being assembled.  A settlement double-click can dispatch
        -- PanelOpenedCampaign before faction_right_status_panel has a stable
        -- native context; querying it here can crash outside Lua's pcall.
        -- Target capture is deferred until the player clicks Talk, when the
        -- panel is fully interactive.  Creating our root-owned controls and
        -- the small vanilla-panel button is safe at this point.
        ensure_owned_ui(); ensure_talk_button()
        if wanted_target and llmdip_player_phase() then
            -- Reply buttons already identify their target; capture it only on
            -- this explicit path, after the panel has had time to settle.
            local opened_target = capture_target()
            if opened_target == wanted_target then
                wanted_target = nil; show_dialog()
            end
        end
        if state.visible then position_owned_ui(); refresh_owned_ui() end
        out("[LLMDIP] UI_DIPLOMACY_ATTACH_DONE")
    end, 180)
end, true)
core:remove_listener("llmdip_contextual_diplomacy_closed")
core:add_listener("llmdip_contextual_diplomacy_closed", "PanelClosedCampaign", function(context)
    return context.string == "diplomacy_dropdown"
end, function()
    hide_dialog(); state.target = nil; state.history_offset = 0
    wanted_target = nil
    state.attitude_value, state.attitude_label, state.personality_attributes = nil, "", "unknown"
end, true)

function llmdip_ui_on_response(request_id, narrative, target)
    if type(target) ~= "string" then return end
    local entry = state.inbox[target] or {}; entry.request = request_id; entry.response = narrative; state.inbox[target] = entry
    local messages = history_for(target)
    local pending = messages[#messages]
    if #messages > 0 and (pending == "Player2: " .. llmdip_t("thinking") or pending == "Player2: Pensando...") then messages[#messages] = "Player2: " .. narrative
    else add_history(target, "Player2", narrative) end
    if state.target == target then state.request_id = request_id; state.response = narrative; if state.visible then refresh_owned_ui() end end
    persist_history()
end
function llmdip_ui_on_proposal(request_id, compact_action, relation_delta, relation_reason, target, deferred)
    if not valid_key(target) then return end
    local entry = state.inbox[target] or {}; entry.request = request_id
    entry.proposal = compact_action ~= "reject" and compact_action or nil
    entry.response = (entry.response or "") .. llmdip_t("proposal_prefix") .. tostring(compact_action); state.inbox[target] = entry
    local delta = tonumber(relation_delta) or 0
    if not deferred and entry.attitude_value ~= nil then entry.attitude_value = entry.attitude_value + delta end
    local reaction = delta > 0 and llmdip_t("reaction_better") or (delta < 0 and llmdip_t("reaction_worse") or llmdip_t("no_change"))
    if compact_action == "reject" then
        add_history(target, llmdip_t("speaker_result"), llmdip_t("no_deal_reaction") .. reaction .. ".")
    else
        local timing = deferred and llmdip_t("on_accept") or ""
        add_history(target, llmdip_t("speaker_proposal"), tostring(compact_action) .. llmdip_t("reaction") .. timing .. ": " .. reaction .. " (" .. tostring(relation_reason) .. ").")
    end
    if state.target == target then
        state.request_id = request_id; state.proposal = entry.proposal; state.response = entry.response
        if state.visible then refresh_owned_ui() end
    end
    persist_history()
end
function llmdip_ui_on_executed(request_id, ok, relation_delta, relation_reason)
    if state.request_id ~= request_id then return end
    state.response = state.response .. (ok and llmdip_t("deal_done_nl") or llmdip_t("deal_failed_nl"))
    local delta = tonumber(relation_delta) or 0
    local entry = state.inbox[state.target] or {}
    if ok and entry.attitude_value ~= nil then entry.attitude_value = entry.attitude_value + delta end
    local reaction = delta > 0 and (llmdip_t("diplo_improved") .. tostring(delta) .. ").") or (delta < 0 and (llmdip_t("diplo_worsened") .. tostring(delta) .. ").") or "")
    state.proposal = nil; entry.proposal = nil; add_history(state.target, llmdip_t("speaker_system"), ok and (llmdip_t("deal_done") .. reaction) or llmdip_t("deal_failed"))
    if state.visible then refresh_owned_ui() end
end

cm:add_first_tick_callback(function()
    state.inbox = cm:get_saved_value("llmdip39_history") or {}
    ensure_owned_ui(); hide_dialog()
end)
