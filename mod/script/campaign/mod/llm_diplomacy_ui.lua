-- Player2 dialogue for WH3's bilateral diplomacy screen.
-- Editable/history controls are persistent children of the campaign UI root,
-- like Console Commands. They are positioned over vanilla diplomacy but never
-- adopted by panel_diplomacy, whose C++ hierarchy is destroyed on exit.
setfenv(1, core:get_env())

local state = {
    visible = false, target = nil, response = llmdip_t("open_conversation"),
    request_id = nil, proposal = nil, inbox = {}, history_offset = 0,
    attitude_value = nil, attitude_label = "", personality_attributes = "unknown",
    header_title = "Player2", header_meta = "", header_attitude = "",
    header_ai_speaker = "Player2", header_flag = "", header_crest_image = "", header_portrait = "", header_has_portrait = false, header_player_flag = "",
    header_player_speaker = ""
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
local SHELL_ID = "llmdip_diplomacy_shell"
local TALK_ID = "llmdip_diplomacy_talk"
local SEND_ID = "llmdip_diplomacy_send"
local CLOSE_ID = "llmdip_diplomacy_close"
local REDO_ID = "llmdip_diplomacy_redo"
local ACCEPT_ID = "llmdip_diplomacy_accept"
local CARD_ACCEPT_ID = "llmdip_proposal_accept"
local CARD_DECLINE_ID = "llmdip_proposal_decline"
local HISTORY_PREV_ID = "llmdip_diplomacy_history_prev"
local HISTORY_NEXT_ID = "llmdip_diplomacy_history_next"
local BUBBLE_ID_PREFIX = "llmdip_diplomacy_bubble_"
local BUBBLE_LIMIT = 16
-- CreateComponent(id, layout) returns the layout's first real component
-- renamed to id; the XML "root" is only a wrapper. So a card IS its text
-- field and has no bubble_text child in game (24-09 logs: "children=0"),
-- exactly like the history and the input (chat IS the entry box, which is
-- why read_input_text asks the chat first). The child lookup is kept for
-- the test harness, which models the wrapper.
local BUBBLE_TEMPLATE = "llmdip_ui/llmdip_bubble"
local BUBBLE_TEXT_ID = "bubble_text"
-- Creating 16 icon components at the UI root (custom image layout, then the
-- vanilla button template) made vanilla listeners log "is not a ui component"
-- right after the first tick and crashed the game when diplomacy opened
-- (24-09, twice). The slots now ship inside the shell layout, under
-- panel_frame, exactly like header_crest, which has never logged an error:
-- they are built with the shell and only moved and re-imaged here.
-- Declared up here: capture_header, far above the card code, reads it too.
-- Declared later, it was a nil global there and the portrait was never asked.
local MESSAGE_ICONS = true
local UI_WIDTH = 640
local INPUT_WIDTH = 510
local INPUT_WIDTH_WITHOUT_PROPOSAL = 552
local CHAT_HEIGHT = 42
local HISTORY_HEIGHT = 380
local PROPOSAL_HISTORY_HEIGHT = 310
local SHELL_WIDTH = 680
local SHELL_HEIGHT = 500
local SHELL_HEADER_HEIGHT = 60
-- Conservative width/leading budget: reserve space for arrows, header and footer.
-- The native font may be wider than font_m_size because of the game's font category.
-- Keep the Lua wrap budget in sync with the native state below.  The
-- The verified history panel reserves a right gutter for its two arrows. Keep
-- a little extra safety margin because the game's font metrics are wider than
-- the Lua estimate; otherwise the final word can still run under an arrow.
-- The native state is UI_WIDTH wide, while Lua wraps to this conservative
-- inner width and the template's Never split mode prevents a second wrap.
-- 460 estimated px renders at up to ~530 real px (see BUBBLE_TEXT_SCALE), which
-- still fits the widest card (8..590; with the icon column it must drop to 430).
-- It was 528 before the cards: the plain text had a 60px gutter of slack.
local HISTORY_TEXT_WIDTH = 430
local PLAYER_INDENT = 12
-- The first displayed line is the section title, rendered by the same native
-- text field as the dialogue. A separate TWUI label was hidden behind that
-- field in game and left an empty strip above the messages.
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
    local shell = find_root(SHELL_ID)
    if not shell then
        shell = UIComponent(root:CreateComponent(SHELL_ID, "llmdip_ui/llmdip_shell"))
        shell:SetCanResizeWidth(true); shell:SetCanResizeHeight(true); shell:Resize(SHELL_WIDTH, SHELL_HEIGHT)
        shell:SetVisible(false)
    end
    local chat = find_root(CHAT_ID)
    if not chat then
        chat = UIComponent(root:CreateComponent(CHAT_ID, "llmdip_ui/llmdip_chat"))
        chat:SetCanResizeWidth(true); chat:SetCanResizeHeight(true); chat:Resize(UI_WIDTH, CHAT_HEIGHT)
        create_icon(chat, SEND_ID, "ui/skins/default/icon_tick.png", -84, llmdip_t("send_tooltip"))
        create_icon(chat, ACCEPT_ID, "ui/skins/default/icon_diplomacy.png", -42, llmdip_t("accept_tooltip"))
        create_icon(chat, CLOSE_ID, "ui/skins/default/icon_cross.png", 0, llmdip_t("close_dialog"))
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
    -- Redo sits under the two arrows, in the same gutter and built the same way.
    if not find_from(history, REDO_ID) then
        local redo = UIComponent(history:CreateComponent(REDO_ID, "ui/templates/square_medium_button"))
        redo:SetCanResizeWidth(true); redo:SetCanResizeHeight(true); redo:Resize(34, 34)
        redo:SetImagePath("ui/skins/default/icon_reset.png"); redo:SetTooltipText(llmdip_t("redo_tooltip"), true)
        redo:SetDockingPoint(3); redo:SetDockOffset(-8, 76); redo:SetVisible(true); topmost(redo)
    end
    local history_height = state.proposal and PROPOSAL_HISTORY_HEIGHT or HISTORY_HEIGHT
    history:Resize(UI_WIDTH, history_height)
    -- The chat component IS the editable box (see BUBBLE_TEMPLATE), so its
    -- width is the text wrap width. It stops short of the buttons, which are
    -- docked outside its right edge: [accept] [send] [close] end at the row's
    -- right edge (UI_WIDTH - 4), 42px apart.
    -- With the proposal card's own buttons the row keeps send/close only; the
    -- row accept button (and the narrower box) is the fallback if they failed.
    local row_accept = state.proposal ~= nil and not state.card_buttons_ok
    local input_width = row_accept and INPUT_WIDTH or INPUT_WIDTH_WITHOUT_PROPOSAL
    chat:Resize(input_width, CHAT_HEIGHT)
    local close = find_from(chat, CLOSE_ID)
    if close then close:SetDockOffset(UI_WIDTH - 4 - input_width, 0) end
    local send = find_from(chat, SEND_ID)
    if send then send:SetDockOffset(UI_WIDTH - 46 - input_width, 0) end
    local accept = find_from(chat, ACCEPT_ID)
    if accept then accept:SetDockOffset(UI_WIDTH - 88 - input_width, 0) end
    local history_field = find_from(history, "history_text")
    if history_field then
        history_field:SetCanResizeWidth(true); history_field:SetCanResizeHeight(true)
        history_field:Resize(UI_WIDTH, history_height)
    end
    return chat, history, shell
end

local function position_owned_ui()
    local panel = diplomacy_panel()
    if not panel then return false end
    local chat, history, shell = ensure_owned_ui()
    if not live(chat) or not live(history) or not live(shell) then return false end
    local x, y = panel:Position(); local width, height = panel:Bounds()
    local shell_left = math.floor(x + (width - SHELL_WIDTH) / 2); local centre_y = math.floor(y + height / 2)
    -- Preserve the proven input position. The new shell grows around it and is
    -- only a visual sibling, never a parent of the working controls.
    local shell_top = math.max(8, centre_y + 38 - HISTORY_HEIGHT - 6 - SHELL_HEADER_HEIGHT)
    shell:MoveTo(shell_left, shell_top)
    history:MoveTo(shell_left + 20, shell_top + SHELL_HEADER_HEIGHT)
    chat:MoveTo(shell_left + 20, shell_top + SHELL_HEADER_HEIGHT + HISTORY_HEIGHT + 6)
    -- Register the frame in the overlay layer without propagating the content
    -- priority into its large background. The history/input children use
    -- priority 100 and must always paint above the shell's priority-20 frame.
    shell:RegisterTopMost(); topmost(history); topmost(chat)
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
    state.header_title = entry and entry.header_title or "Player2"
    state.header_meta = entry and entry.header_meta or ""
    state.header_attitude = entry and entry.header_attitude or ""
    state.header_ai_speaker = entry and entry.header_ai_speaker or "Player2"
    state.header_flag = entry and entry.header_flag or ""
    state.header_crest_image = entry and entry.header_crest_image or ""
    state.header_portrait = entry and entry.header_portrait or ""
    state.header_has_portrait = entry and entry.header_has_portrait or false
    state.header_player_flag = entry and entry.header_player_flag or ""
    state.header_player_speaker = entry and entry.header_player_speaker or ""
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

local function localised_ui_value(value)
    if type(value) ~= "string" or value == "" then return "" end
    local ok, translated = pcall(function() return common.get_localised_string(value) end)
    if ok and type(translated) == "string" and translated ~= "" and translated ~= value then return translated end
    return value
end

local function leader_name_for_faction(faction)
    if not faction or faction:is_null_interface() then return "" end
    local ok_leader, leader = pcall(function() return faction:faction_leader() end)
    if not ok_leader or not leader or leader:is_null_interface() then return "" end
    local ok_identity, identity = pcall(function()
        local forename = localised_ui_value(leader:get_forename())
        local surname = localised_ui_value(leader:get_surname())
        return string.match(forename .. " " .. surname, "^%s*(.-)%s*$") or ""
    end)
    return ok_identity and identity or ""
end

-- Captured only after the player explicitly opens the conversation, alongside
-- the already proven attitude/personality probes. Rendering the shell itself
-- never queries transient diplomacy components.
local function capture_header(target)
    local faction_name, leader_name = tostring(target or "Player2"), ""
    local ok_name, shown_name = pcall(function()
        return common.get_context_value("CcoCampaignFaction", target, "Name")
    end)
    if ok_name and type(shown_name) == "string" and shown_name ~= "" then faction_name = shown_name end
    local ok_faction, faction = pcall(function() return cm:get_faction(target) end)
    if ok_faction and faction and not faction:is_null_interface() then
        leader_name = leader_name_for_faction(faction)
    end
    state.header_title = leader_name ~= "" and (leader_name .. " — " .. faction_name) or faction_name
    local relation = state.attitude_value ~= nil and tostring(state.attitude_value) or llmdip_t("unknown_value")
    local traits = string.gsub(state.personality_attributes or "", ":", " · ")
    if traits == "unknown" then traits = "" end
    if #traits > 72 then traits = string.sub(traits, 1, 69) .. "..." end
    state.header_meta = traits
    local attitude = state.attitude_label or ""
    if state.attitude_value ~= nil then
        attitude = attitude ~= "" and (attitude .. " · " .. relation) or (llmdip_t("relation") .. relation)
    end
    state.header_attitude = attitude ~= "" and attitude or (llmdip_t("relation") .. relation)
    state.header_ai_speaker = leader_name ~= "" and leader_name or faction_name
    -- Image paths straight from CcoCampaignFaction, with the expressions vanilla
    -- layouts use: FactionFlagMedium for crests and FactionLeaderContext for the
    -- leader (CcoCampaignCharacter.PortraitPath, as in the dungeon commander
    -- portrait). Flag folders are NOT always ui/flags/<key>: Sylvania's is
    -- ui/flags/wh_dlc07_vmp_von_carstein. FactionFlagDir and the character CQI
    -- id both returned nil in game (24-09).
    local function faction_image(key, expressions)
        for i = 1, #expressions do
            local ok, value = pcall(function()
                return common.get_context_value("CcoCampaignFaction", key, expressions[i])
            end)
            if ok and type(value) == "string" and value ~= "" then return value, expressions[i] end
        end
        return nil, "none"
    end
    local flags = {"FactionFlagMedium", "FactionRecordContext.FlagPathMedium"}
    local crest, crest_from = faction_image(target, flags)
    state.header_flag = "ui/flags/" .. tostring(target)
    state.header_crest_image = crest or (state.header_flag .. "/mon_64.png")
    local portrait, portrait_from = nil, "off"
    if MESSAGE_ICONS then
        portrait, portrait_from = faction_image(target, {"FactionLeaderContext.PortraitPath"})
    end
    state.header_portrait = portrait or state.header_crest_image
    state.header_has_portrait = portrait ~= nil
    local ok_key, player_key = pcall(function() return cm:get_local_faction_name(true) end)
    if not ok_key then player_key = nil end
    local player_crest, player_from = nil, "off"
    if MESSAGE_ICONS then player_crest, player_from = faction_image(player_key, flags) end
    state.header_player_flag = player_crest or ("ui/flags/" .. tostring(player_key) .. "/mon_64.png")
    out("[LLMDIP UI] PORTRAIT|crest=" .. crest_from .. ":" .. tostring(crest)
        .. "|portrait=" .. portrait_from .. ":" .. tostring(portrait)
        .. "|player=" .. player_from .. ":" .. tostring(player_crest))
    local ok_player, player = pcall(function() return cm:get_local_faction(true) end)
    state.header_player_speaker = ok_player and leader_name_for_faction(player) or ""
    local entry = state.inbox[target] or {}
    entry.header_title, entry.header_meta = state.header_title, state.header_meta
    entry.header_attitude = state.header_attitude
    entry.header_ai_speaker, entry.header_player_speaker = state.header_ai_speaker, state.header_player_speaker
    entry.header_flag, entry.header_crest_image = state.header_flag, state.header_crest_image
    entry.header_portrait, entry.header_player_flag = state.header_portrait, state.header_player_flag
    entry.header_has_portrait = state.header_has_portrait
    state.inbox[target] = entry
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
local function wrap_history_text(text, max_width)
    local lines, current = {}, ""
    local current_length = 0
    max_width = max_width or HISTORY_TEXT_WIDTH
    text = string.gsub(tostring(text or ""), "[\r\n]+", " ")
    for word in string.gmatch(text, "%S+") do
        -- Lua 5.1 has no utf8 library. Never split an accented character mid-byte.
        local chars = {}
        for char in string.gmatch(word, "[%z\1-\127\194-\244][\128-\191]*") do chars[#chars + 1] = char end
        local word_width = 0
        for i = 1, #chars do word_width = word_width + history_char_width(chars[i]) end
        if word_width <= max_width then
            -- Keep ordinary words intact.  Splitting a word merely because
            -- its last few glyphs cross the estimate is what produced rows
            -- containing just "respuesta" or another orphaned fragment.
            if current ~= "" and current_length + 4.5 + word_width > max_width then
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
                if current ~= "" and current_length + width > max_width then
                    lines[#lines + 1] = current; current, current_length = "", 0
                end
                current = current .. chars[i]; current_length = current_length + width
            end
        end
    end
    if current ~= "" then lines[#lines + 1] = current end
    return lines
end
local function history_capacity()
    -- Current attitude already has its own badge in the shell header.
    local total = state.proposal and math.floor((PROPOSAL_HISTORY_HEIGHT - 24) / 20) or HISTORY_TOTAL_LINES
    -- Reserve one line each for the visible title and the compact page range.
    return math.max(1, total - 2)
end
local function readable_proposal_line(text)
    local compact = string.match(text, "^([a-z_][a-z_0-9,]*)")
    if not compact then return text end
    return llmdip_action_label(compact) .. string.sub(text, #compact + 1)
end
-- WH3 replaces some string functions; comparing string.sub(text, 1, #prefix)
-- failed for any prefix with an accent, so "Tú: " lines were never recognised
-- as the player's and showed up as system text. A pattern match is exact.
local function after_prefix(text, prefix)
    return string.match(text, "^" .. escape_pattern(prefix) .. "(.*)$")
end
local function history_body_lines(target)
    local result, history = {}, history_for(target)
    local latest_start = 1
    local entry = state.inbox[target] or {}
    local ai_name = entry.header_ai_speaker or "Player2"
    local player_name = entry.header_player_speaker or ""
    for i = 1, #history do
        if i > 1 then result[#result + 1] = " " end
        if i == #history then latest_start = #result + 1 end
        local text, speaker, colour = history[i], nil, nil
        local rest = after_prefix(text, "Player2: ")
        if rest then
            speaker, text, colour = ai_name, rest, "yellow"
        else
            rest = after_prefix(text, llmdip_t("you") .. ": ")
            if rest then
                speaker = llmdip_t("you")
                if player_name ~= "" then speaker = speaker .. " · " .. player_name end
                text, colour = rest, "green"
            else
                local system_rest = after_prefix(text, llmdip_t("speaker_system") .. ": ")
                local proposal_rest = after_prefix(text, llmdip_t("speaker_proposal") .. ": ")
                local result_rest = after_prefix(text, llmdip_t("speaker_result") .. ": ")
                if system_rest then
                    speaker, text, colour = llmdip_t("speaker_system"), system_rest, "grey"
                elseif proposal_rest then
                    speaker, text, colour = llmdip_t("speaker_proposal"), readable_proposal_line(proposal_rest), "yellow"
                elseif result_rest then
                    speaker, text, colour = llmdip_t("speaker_result"), result_rest, "grey"
                end
            end
        end
        local block_indent = colour == "green" and string.rep(" ", PLAYER_INDENT) or ""
        if speaker then result[#result + 1] = block_indent .. "[[col:" .. colour .. "]]" .. speaker .. ":[[/col]]" end
        -- Outgoing messages sit in their own inset column. Reserve every
        -- leading space in the wrap budget so long player text stays inside
        -- the viewport at larger game UI scales.
        local leading_width = (speaker and 12 or 0) + (colour == "green" and PLAYER_INDENT * 4.5 or 0)
        local wrapped = wrap_history_text(text, HISTORY_TEXT_WIDTH - leading_width)
        for j = 1, #wrapped do
            local line = speaker and ("  " .. wrapped[j]) or wrapped[j]
            result[#result + 1] = block_indent .. ((colour == "grey" or colour == "green" or (speaker == llmdip_t("speaker_proposal")))
                and ("[[col:" .. colour .. "]]" .. line .. "[[/col]]") or line)
        end
    end
    return result, latest_start
end
local function latest_history_start(target)
    local _, latest_start = history_body_lines(target)
    return latest_start
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
    local lines = { "[[col:yellow]]" .. llmdip_t("conversation") .. "[[/col]]" }
    if #body == 0 then lines[#lines + 1] = llmdip_t("no_messages_yet"); return table.concat(lines, "\n") end
    local minimum, maximum, base = history_scroll_bounds(target)
    state.history_offset = math.max(minimum, math.min(maximum, state.history_offset))
    local first = base + state.history_offset
    local last = math.min(#body, first + history_capacity(target) - 1)
    for i = first, last do lines[#lines + 1] = body[i] end
    lines[#lines + 1] = "[[col:grey]]" .. first .. "–" .. last .. " / " .. #body .. "[[/col]]"
    return table.concat(lines, "\n")
end
local function set_history_text(text)
    local _, history = ensure_owned_ui()
    local field = find_from(history, "history_text") or history
    if field then pcall(function() field:SetStateText(text or "") end); field:SetInteractive(false) end
end
local function hide_history_bubbles()
    for i = 1, BUBBLE_LIMIT do
        local bubble = find_root(BUBBLE_ID_PREFIX .. i)
        if bubble then bubble:SetVisible(false) end
        -- message_icon() is defined below; look the slots up directly here.
        local shell = find_root(SHELL_ID)
        local icon = find_from(shell, "msg_icon_" .. i)
        if icon then icon:SetVisible(false) end
        local portrait = find_from(shell, "msg_portrait_" .. i)
        if portrait then portrait:SetVisible(false) end
    end
end
local function message_icon(index)
    return find_from(find_root(SHELL_ID), "msg_icon_" .. index)
end
-- Cropped slot for the leader's porthole (a wide 300x164 image): the crest
-- slots are square and squeezed it into a tiny figure (24-09).
local function message_portrait(index)
    return find_from(find_root(SHELL_ID), "msg_portrait_" .. index)
end
local function history_bubble(index)
    local id = BUBBLE_ID_PREFIX .. index
    local bubble = find_root(id)
    if bubble then return bubble end
    -- Root-owned, like the shell, history and input; reused and hidden,
    -- never destroyed, so it survives the vanilla panel teardown.
    bubble = UIComponent(ui_root():CreateComponent(id, BUBBLE_TEMPLATE))
    bubble:SetCanResizeWidth(true); bubble:SetCanResizeHeight(true)
    bubble:SetInteractive(false); bubble:SetVisible(false)
    return bubble
end
-- Built on the first tick, like the history and input, so a card is never
-- created and filled in the same click.
local function ensure_bubble_pool()
    for i = 1, BUBBLE_LIMIT do
        history_bubble(i)
    end
end
local function bubble_children(bubble)
    local ids = {}
    local ok, count = pcall(function() return bubble:ChildCount() end)
    if not ok then return "count_failed" end
    for i = 0, count - 1 do
        local ok_child, child = pcall(function() return UIComponent(bubble:Find(i, false)) end)
        local ok_id, id = pcall(function() return child:Id() end)
        ids[#ids + 1] = ok_child and ok_id and tostring(id) or "?"
    end
    return tostring(count) .. ":" .. table.concat(ids, ",")
end
-- Cards stay left of the arrow gutter: the arrows start 42px from the
-- history's right edge (640 - 8 - 34 = 598).
local BUBBLE_LEFT = 8
local BUBBLE_RIGHT = 590
-- A 40px portrait/crest column sits outside each speaker's cards: the rival's
-- on the left (cards start at 56), the player's on the right (cards end at 542).
local ICON_SIZE = 44
local ICON_GAP = 8
local RIVAL_CARD_LEFT = MESSAGE_ICONS and (BUBBLE_LEFT + ICON_SIZE + ICON_GAP) or BUBBLE_LEFT
local PLAYER_CARD_RIGHT = MESSAGE_ICONS and (BUBBLE_RIGHT - ICON_SIZE - ICON_GAP) or BUBBLE_RIGHT
local BUBBLE_MAX_WIDTH = PLAYER_CARD_RIGHT - BUBBLE_LEFT
local BUBBLE_MIN_WIDTH = 150
-- history_char_width underestimates the game font: in the 24-09 screenshot the
-- cards clipped lines rendered 7-11% wider than estimated. Measure with margin.
local BUBBLE_TEXT_SCALE = 1.18
-- The card's text state pads 12px on each side and 6px above and below.
local BUBBLE_PADDING = 24
local BUBBLE_LINE_HEIGHT = 20
local BUBBLE_VERTICAL_PADDING = 12
local BUBBLE_GAP = 6
local BUBBLE_TOP = 34
local function markup_free(line)
    return (string.gsub(line, "%[%[/?col[^%]]*%]%]", ""))
end
local function line_width(line)
    local width = 0
    for char in string.gmatch(markup_free(line), "[%z\1-\127\194-\244][\128-\191]*") do
        width = width + history_char_width(char)
    end
    return width
end
local function bubble_height(lines) return #lines * BUBBLE_LINE_HEIGHT + BUBBLE_VERTICAL_PADDING end
-- Cards with a portrait/crest are at least as tall as it, so icons never overlap.
local function group_height(item)
    local height = bubble_height(item.lines)
    if MESSAGE_ICONS and item.kind ~= "system" then height = math.max(height, ICON_SIZE) end
    return height
end
local function bubble_geometry(item)
    local widest = 0
    for i = 1, #item.lines do widest = math.max(widest, line_width(item.lines[i]) * BUBBLE_TEXT_SCALE) end
    local width = math.floor(math.max(BUBBLE_MIN_WIDTH, math.min(BUBBLE_MAX_WIDTH, widest + BUBBLE_PADDING + 8)))
    local x = RIVAL_CARD_LEFT
    if item.kind == "player" then x = PLAYER_CARD_RIGHT - width
    elseif item.kind == "system" then x = math.floor((BUBBLE_LEFT + BUBBLE_RIGHT - width) / 2) end
    return x, width, group_height(item)
end
local function history_line_kind(line, previous)
    if string.match(line, "%[%[col:green%]%]") then return "player" end
    if string.match(line, "%[%[col:grey%]%]") then return "system" end
    if string.match(line, "%[%[col:yellow%]%]") then return "rival" end
    return previous
end
-- If a card's text child is still missing, show plain text now and retry a
-- few times shortly after, instead of staying on plain text all session.
local bubble_retries = 0
local function render_history_bubbles(target)
    local display = history_display(target)
    local history = find_root(HISTORY_ID)
    if not live(history) then set_history_text(display); return end
    -- Root-owned cards are not hidden with the history, so never show them
    -- while the dialog is closed (responses can arrive in the background).
    if not state.visible then hide_history_bubbles(); set_history_text(display); return end
    local body = history_body_lines(target)
    if #body == 0 then
        hide_history_bubbles(); set_history_text(display); return
    end
    local minimum, maximum, base = history_scroll_bounds(target)
    state.history_offset = math.max(minimum, math.min(maximum, state.history_offset))
    local first = base + state.history_offset
    local last = math.min(#body, first + history_capacity(target) - 1)
    local caption = "[[col:yellow]]" .. llmdip_t("conversation") .. "[[/col]]"
        .. "  [[col:grey]]" .. first .. "–" .. last .. " / " .. #body .. "[[/col]]"
    local ok, failure = pcall(function()
        local groups, group, kind = {}, nil, "rival"
        for i = 1, last do
            local line = body[i]
            if line ~= " " then kind = history_line_kind(line, kind) end
            if i >= first then
                if line == " " then
                    group = nil
                else
                    if not group or group.kind ~= kind then
                        group = {kind = kind, lines = {}}
                        groups[#groups + 1] = group
                    end
                    group.lines[#group.lines + 1] = string.gsub(line, "^%s+", "")
                end
            end
        end
        -- Line pagination does not count each card's padding and gap, so a
        -- page of many short messages is taller than the viewport. Keep the
        -- newest part of the page and trim from the top instead of failing.
        local viewport_height = state.proposal and PROPOSAL_HISTORY_HEIGHT or HISTORY_HEIGHT
        local available = viewport_height - 8 - BUBBLE_TOP
        local function page_height()
            local total = 0
            for i = 1, #groups do total = total + group_height(groups[i]) + BUBBLE_GAP end
            return total
        end
        while #groups > 0 and (#groups > BUBBLE_LIMIT or page_height() > available) do
            table.remove(groups[1].lines, 1)
            if #groups[1].lines == 0 then table.remove(groups, 1) end
        end
        local history_x, history_y = history:Position()
        local y = BUBBLE_TOP
        for i = 1, #groups do
            local item = groups[i]
            local x, width, height = bubble_geometry(item)
            local bubble = history_bubble(i)
            bubble:Resize(width, height)
            bubble:MoveTo(history_x + x, history_y + y)
            local field = find_from(bubble, BUBBLE_TEXT_ID) or bubble
            field:SetCanResizeWidth(true); field:SetCanResizeHeight(true)
            field:Resize(width, height); field:SetInteractive(false)
            field:SetStateText(table.concat(item.lines, "\n"))
            bubble:SetVisible(true)
            -- Re-register on every render: opening the dialog registers the
            -- history as top-most again, which would otherwise cover the cards.
            bubble:PropagatePriority(250); bubble:RegisterTopMost()
            -- Rival: leader portrait (or its faction crest) on the left.
            -- Player: the player's crest on the right. System lines: none.
            -- The rival shows its leader's porthole in the cropped slot when the
            -- game gave one, else its crest; the player always shows the crest.
            local crest_slot = MESSAGE_ICONS and message_icon(i) or nil
            local portrait_slot = MESSAGE_ICONS and message_portrait(i) or nil
            local use_portrait = item.kind == "rival" and state.header_has_portrait and portrait_slot ~= nil
            local icon = use_portrait and portrait_slot or crest_slot
            local other = use_portrait and crest_slot or portrait_slot
            if other then other:SetVisible(false) end
            local image = item.kind == "rival" and state.header_portrait
                or (item.kind == "player" and state.header_player_flag) or ""
            if not icon then
                -- icons off
            elseif image ~= "" then
                local icon_x = item.kind == "player" and (PLAYER_CARD_RIGHT + ICON_GAP) or BUBBLE_LEFT
                pcall(function() icon:SetImagePath(image) end)
                if not use_portrait then
                    icon:SetCanResizeWidth(true); icon:SetCanResizeHeight(true); icon:Resize(ICON_SIZE, ICON_SIZE)
                end
                icon:MoveTo(history_x + icon_x, history_y + y)
                icon:SetVisible(true); icon:PropagatePriority(250); icon:RegisterTopMost()
            else
                icon:SetVisible(false)
            end
            y = y + height + BUBBLE_GAP
        end
        for i = #groups + 1, BUBBLE_LIMIT do
            local bubble = find_root(BUBBLE_ID_PREFIX .. i)
            if bubble then bubble:SetVisible(false) end
            local icon = message_icon(i)
            if icon then icon:SetVisible(false) end
            local portrait = message_portrait(i)
            if portrait then portrait:SetVisible(false) end
        end
        set_history_text(caption)
    end)
    if ok then bubble_retries = 0; return end
    hide_history_bubbles()
    set_history_text(display)
    out("[LLMDIP UI] BUBBLE_FALLBACK|" .. tostring(failure) .. "|retry=" .. tostring(bubble_retries))
    if bubble_retries < 3 then
        bubble_retries = bubble_retries + 1
        cm:real_callback(function()
            if state.visible and state.target == target then render_history_bubbles(target) end
        end, 150)
    end
end
-- Accept/Reject live on the proposal card, like the reference mockup. Vanilla
-- text buttons, created once under the card and hidden with it. On any
-- failure the old accept button in the input row is used instead.
local CARD_BUTTON_WIDTH = 124
local function ensure_card_buttons(card)
    if state.card_buttons_ok ~= nil then return state.card_buttons_ok end
    local ok, failure = pcall(function()
        local specs = {
            {CARD_ACCEPT_ID, "accept_button", -(10 + CARD_BUTTON_WIDTH + 8)},
            {CARD_DECLINE_ID, "decline_button", -10}
        }
        for i = 1, #specs do
            local id, key, offset = specs[i][1], specs[i][2], specs[i][3]
            local button = find_from(card, id)
            if not button then
                button = UIComponent(card:CreateComponent(id, "ui/templates/square_medium_text_button"))
            end
            if not live(button) then error("no " .. id) end
            button:SetCanResizeWidth(true); button:SetCanResizeHeight(true); button:Resize(CARD_BUTTON_WIDTH, 34)
            button:SetDockingPoint(6); button:SetDockOffset(offset, 0)
            local label = find_from(button, "button_txt")
            if not label then error("no label on " .. id) end
            label:SetStateText(llmdip_t(key)); label:SetInteractive(false)
            button:SetInteractive(true); button:SetVisible(true); topmost(button)
        end
    end)
    state.card_buttons_ok = ok
    out("[LLMDIP UI] CARD_BUTTONS|" .. tostring(ok) .. "|" .. tostring(failure or ""))
    return ok
end
local function set_shell_text(shell)
    if not live(shell) then return end
    local crest = find_from(shell, "header_crest")
    local crest_image = state.header_crest_image ~= "" and state.header_crest_image
        or (state.header_flag ~= "" and (state.header_flag .. "/mon_64.png")) or ""
    if crest and crest_image ~= "" then
        pcall(function() crest:SetImagePath(crest_image); crest:SetInteractive(false) end)
    end
    local title = find_from(shell, "header_title")
    local meta = find_from(shell, "header_meta")
    local attitude = find_from(shell, "header_attitude")
    local proposal_card = find_from(shell, "proposal_card")
    if title then pcall(function() title:SetStateText(state.header_title or "Player2") end) end
    if meta then pcall(function() meta:SetStateText(state.header_meta or "") end) end
    if attitude then pcall(function() attitude:SetStateText(state.header_attitude or "") end) end
    if proposal_card then
        proposal_card:SetVisible(state.proposal ~= nil)
        if state.proposal then
            -- Agreement first, "pending proposal" underneath, as in the mockup.
            -- The text stops before the two buttons on the right.
            local text_width = ensure_card_buttons(proposal_card) and (640 - 54 - 2 * CARD_BUTTON_WIDTH - 30) or 572
            local title = find_from(proposal_card, "proposal_title")
            local detail = find_from(proposal_card, "proposal_detail")
            if title then
                title:SetCanResizeWidth(true); title:Resize(text_width, 21)
                title:SetStateText(llmdip_action_label(state.proposal))
            end
            if detail then
                detail:SetCanResizeWidth(true); detail:Resize(text_width, 27)
                detail:SetStateText(llmdip_t("pending_proposal"))
            end
        end
    end
end
local function refresh_owned_ui()
    local chat, history, shell = ensure_owned_ui(); render_history_bubbles(state.target)
    if not live(chat) or not live(history) or not live(shell) then return end
    local buttons_before = state.card_buttons_ok
    set_shell_text(shell)
    -- The card buttons are created on the first proposal; re-apply the row
    -- geometry once their outcome is known.
    if buttons_before ~= state.card_buttons_ok then ensure_owned_ui() end
    local input = find_from(chat, "entry_box")
    if input then input:SetInteractive(true); input:SetTooltipText("Player2: " .. state.response, true) end
    local accept = find_from(chat, ACCEPT_ID)
    if accept then accept:SetVisible(state.proposal ~= nil and not state.card_buttons_ok) end
    shell:SetVisible(state.visible); history:SetVisible(state.visible); chat:SetVisible(state.visible)
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
    local shell = find_root(SHELL_ID)
    if chat then chat:SetVisible(false) end
    if history then history:SetVisible(false) end
    if shell then shell:SetVisible(false) end
    hide_history_bubbles()
    out("[LLMDIP UI] CHAT_CLOSED")
end
local function show_dialog()
    local target = capture_target()
    if target then
        capture_attitude(target)
        capture_personality(target)
        capture_header(target)
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
    state.response = llmdip_t("waiting"); clear_input_text(); render_history_bubbles(target)
end

local function regenerate_last()
    local target = state.target
    local entry = valid_key(target) and state.inbox[target] or nil
    local messages = history_for(target)
    out("[LLMDIP UI] REDO_CLICK|" .. tostring(target) .. "|" .. tostring(entry and entry.request) .. "|" .. tostring(#messages))
    -- state.response only reaches the input's tooltip, so a refusal said there looked
    -- like a dead button (26-09). Refusals are written into the chat instead.
    local function refuse(reason, key)
        out("[LLMDIP UI] REDO_SKIP|" .. reason)
        if valid_key(target) then add_history(target, llmdip_t("speaker_system"), llmdip_t(key)); render_history_bubbles(target) end
    end
    if not valid_key(target) then out("[LLMDIP UI] REDO_SKIP|no_target"); return end
    -- While a reply is being written the click is simply ignored: a line added now
    -- would stop the reply from replacing the "thinking" line.
    if messages[#messages] == "Player2: " .. llmdip_t("thinking") then out("[LLMDIP UI] REDO_SKIP|waiting"); return end
    if entry and entry.request and entry.executed_request == entry.request then return refuse("deal_executed", "redo_blocked_deal") end
    -- WH3's string.sub counts characters while # counts bytes, so "Tú: " (5 bytes,
    -- 4 characters) never matched with string.sub(line, 1, #prefix) (26-09). A pattern
    -- match does not depend on either count.
    local pattern = "^" .. string.gsub(llmdip_t("you") .. ": ", "[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0") .. "(.*)$"
    local index, text = nil, nil
    for i = #messages, 1, -1 do
        local said = string.match(messages[i], pattern)
        if said then index, text = i, said; break end
    end
    if not index or index == #messages or text == "" then return refuse("no_reply", "redo_nothing") end
    -- Replies saved before this version may carry no request id; they are redone
    -- all the same, only the companion cannot drop the old one from its memory.
    local previous = entry and valid_key(entry.request) or nil
    local ok, sent = pcall(function() return llmdip_regenerate(target, previous, text, entry and entry.applied_delta or 0, state.attitude_value, state.personality_attributes) end)
    out("[LLMDIP UI] REDO|" .. tostring(ok) .. "|" .. tostring(sent))
    if not ok or not sent then return refuse("send_failed|" .. tostring(sent), "send_failed") end
    entry = state.inbox[target]
    while #messages > index do table.remove(messages) end
    if entry.attitude_value ~= nil and entry.applied_delta then entry.attitude_value = entry.attitude_value - entry.applied_delta end
    entry.proposal = nil; entry.request = nil; entry.applied_delta = 0
    state.proposal = nil; state.request_id = nil
    add_history(target, "Player2", llmdip_t("thinking"))
    state.response = llmdip_t("waiting"); render_history_bubbles(target)
end

core:remove_listener("llmdip_contextual_clicks")
core:add_listener("llmdip_contextual_clicks", "ComponentLClickUp", true, function(context)
    local id = context.string
    if id == TALK_ID then toggle_dialog()
    elseif id == SEND_ID then send_text()
    elseif id == CLOSE_ID then hide_dialog()
    elseif id == REDO_ID then regenerate_last()
    elseif (id == ACCEPT_ID or id == CARD_ACCEPT_ID) and state.request_id and state.proposal then
        llmdip_accept(state.request_id); state.proposal = nil
        state.response = state.response .. llmdip_t("applying_proposal"); refresh_owned_ui()
    elseif id == CARD_DECLINE_ID and state.request_id and state.proposal then
        local target = state.target
        if llmdip_decline and llmdip_decline(state.request_id) then
            local entry = state.inbox[target] or {}
            entry.proposal = nil; state.inbox[target] = entry; state.proposal = nil
            add_history(target, llmdip_t("speaker_system"), llmdip_t("proposal_declined"))
        end
        refresh_owned_ui()
    elseif id == HISTORY_PREV_ID then
        -- Move one logical wrapped line at a time, rather than jumping to a
        -- different message.  Up is older; down (below) is newer.
        local minimum = history_scroll_bounds(state.target)
        state.history_offset = math.max(minimum, state.history_offset - HISTORY_SCROLL_STEP)
        render_history_bubbles(state.target)
    elseif id == HISTORY_NEXT_ID then
        local _, maximum = history_scroll_bounds(state.target)
        state.history_offset = math.min(maximum, state.history_offset + HISTORY_SCROLL_STEP)
        render_history_bubbles(state.target)
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
        ensure_owned_ui(); ensure_bubble_pool(); ensure_talk_button()
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
    entry.applied_delta = deferred and 0 or delta
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
function llmdip_ui_on_betrayal(request_id, target, ok)
    if not valid_key(target) or not ok then return end
    local entry = state.inbox[target] or {}; entry.request = request_id; entry.proposal = nil; state.inbox[target] = entry
    add_history(target, llmdip_t("speaker_system"), llmdip_t("betrayal_done"))
    if state.target == target then
        state.request_id = request_id; state.proposal = nil
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
    if ok then entry.executed_request = request_id end
    state.proposal = nil; entry.proposal = nil; add_history(state.target, llmdip_t("speaker_system"), ok and (llmdip_t("deal_done") .. reaction) or llmdip_t("deal_failed"))
    if state.visible then refresh_owned_ui() end
end

cm:add_first_tick_callback(function()
    state.inbox = cm:get_saved_value("llmdip39_history") or {}
    ensure_owned_ui(); ensure_bubble_pool(); hide_dialog()
end)
