-- Player-turn mailbox: data arrival never opens diplomacy or an intervention.
-- 0.43: one entry button and one framed window with three tabs, Letters, Who can
-- write to me and World, instead of two floating buttons and a column of loose buttons. The
-- frame is a second copy of the chat's proven shell and stays visual only; every
-- clickable control is a root-owned sibling placed over it, as in the chat. See
-- docs/ui/GUIA_CARTAS_Y_FACCIONES.md for the rules this file must keep.
setfenv(1, core:get_env())
local KEY = "llmdip39_mailbox"
local BUTTON, SHELL = "llmdip39_mail_button", "llmdip_hub_shell"
local CLOSE, PREV, NEXT = "llmdip39_mail_close", "llmdip39_mail_prev", "llmdip39_mail_next"
local TAB_LETTERS, TAB_CONTACTS, TAB_WORLD = "llmdip_hub_tab_letters", "llmdip_hub_tab_contacts", "llmdip_hub_tab_world"
local OPT_TREATIES, OPT_ROMANCE, OPT_VOICE = "llmdip_hub_opt_treaties", "llmdip_hub_opt_romance", "llmdip_hub_opt_voice"
local COUNCIL_OPEN, COUNCIL_INPUT, COUNCIL_SEND = "llmdip_hub_council_open", "llmdip_hub_council_input", "llmdip_hub_council_send"
local CARD_PREFIX, REPLY_PREFIX = "llmdip_hub_card_", "llmdip39_mail_reply_"
local ROW_PREFIX, MARK_PREFIX = "llmdip_hub_row_", "llmdip_hub_mark_"
local NAV, RACE_ON, RACE_OFF = "llmdip_hub_nav", "llmdip_hub_race_on", "llmdip_hub_race_off"
local HUB_WIDTH, HUB_HEIGHT, HEADER_HEIGHT = 680, 500, 60
local CONTENT_LEFT, CONTENT_TOP = 20, 108
local CARDS, CARD_WIDTH, CARD_HEIGHT, CARD_GAP = 3, 588, 96, 10
local ROWS, ROW_WIDTH, ROW_HEIGHT, ROW_GAP = 7, 560, 34, 4
local BUTTON_WIDTH, PREVIEW_LINES, NOTICE_LINES, NOTICE_HEIGHT = 210, 2, 5, 116
-- The court report card grows with its text: about 20 px per line of the chat font,
-- plus the card's own margins (a 96 px card holds four lines).
-- 16 lines is the whole first page (above the switches): the report is never cut.
local LINE_HEIGHT, REPORT_PADDING, REPORT_MAX_LINES = 20, 16, 16
-- A chronicle entry, a rumour or a deed is shown whole, up to this many lines.
local ENTRY_MAX_LINES = 7
-- Text width inside a card, in the chat's glyph units (see glyph_width).
local CARD_TEXT_WIDTH = 450
local TICK_IMAGE, CROSS_IMAGE = "ui/skins/default/icon_tick.png", "ui/skins/default/icon_cross.png"
local box = {rows = {}, round = -1, queries = 0, contacted = {}}
local page, shown, blocked = 1, false, {}
local tab, contact_race, contact_page, row_keys, letter_slots = "letters", nil, 1, {}, {}
local world_page = 1
-- A switch travels through a UITrigger and is stored a moment later. Until the game
-- confirms it, the row already shows what the player asked for, so a click is never
-- left without a visible answer.
local pending_contacts = {}
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

-- Text helpers. Letters come in any of the 13 languages: work in characters,
-- never bytes, and measure them like the chat does for its size-14 font, where
-- Chinese, Japanese and Korean characters are about twice as wide.
local function characters(value)
    local list = {}
    for ch in string.gmatch(tostring(value), "[%z\1-\127\194-\244][\128-\191]*") do list[#list+1] = ch end
    return list
end
local function glyph_width(ch)
    if ch == " " then return 4.5 end
    if string.match(ch, "^[ilIjtfr%.,:;!'|]$") then return 5 end
    if string.match(ch, "^[MWmw@%%]$") then return 13 end
    if #ch >= 3 then return 16 end
    if string.match(ch, "^[A-Z]$") then return 10 end
    return 8.5
end
local function text_width(value)
    local width = 0
    for _, ch in ipairs(characters(value)) do width = width + glyph_width(ch) end
    return width
end
local function fit_width(value, width)
    local kept, used = {}, 0
    for _, ch in ipairs(characters(value)) do
        local g = glyph_width(ch)
        if used + g > width then break end
        kept[#kept+1] = ch; used = used + g
    end
    return table.concat(kept)
end
-- Pieces no wider than the line: a word, or slices of a longer word. Chinese and
-- Japanese text has no spaces, so a whole sentence arrives as one "word".
local function pieces(word, width)
    local list, part, used = {}, {}, 0
    for _, ch in ipairs(characters(word)) do
        local g = glyph_width(ch)
        if used + g > width and #part > 0 then list[#list+1] = table.concat(part); part, used = {}, 0 end
        part[#part+1] = ch; used = used + g
    end
    if #part > 0 then list[#list+1] = table.concat(part) end
    return list
end
local function fit_lines(value, width, count)
    local text = string.gsub(tostring(value or ""), "[\r\n]+", " ")
    local lines, line, cut = {}, "", false
    for word in string.gmatch(text, "%S+") do
        for _, piece in ipairs(pieces(word, width)) do
            local candidate = line == "" and piece or (line .. " " .. piece)
            if text_width(candidate) <= width then
                line = candidate
            elseif #lines + 1 < count then
                lines[#lines+1] = line; line = piece
            else
                cut = true; break
            end
        end
        if cut then break end
    end
    if line ~= "" then lines[#lines+1] = line end
    if cut and #lines > 0 then lines[#lines] = fit_width(lines[#lines], width - 15) .. "..." end
    return lines
end
local function first_line(value, width) return fit_lines(value, width, 1)[1] or "" end
-- The bridge turns commas into "_" ("Miao Ying_ la Dragona de la Tormenta"); put them back.
local function lord_label(value) return (string.gsub(tostring(value or ""), "_ ", ", ")) end

-- Component helpers. Everything is created once from the root, kept, and only
-- shown, hidden, filled and moved afterwards.
local function topmost(u, priority)
    if not live(u) then return end
    u:PropagatePriority(priority); u:RegisterTopMost()
end
local function set_label(u, value)
    local label = find("button_txt", u)
    if label then label:SetStateText(value); label:SetInteractive(false) end
end
local function text_button(root, id, width)
    local u = find(id)
    if not u then
        u = UIComponent(root:CreateComponent(id, "ui/templates/square_medium_text_button"))
        if not live(u) then return nil end
        u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:SetInteractive(true)
        u:SetVisible(false)
    end
    u:Resize(width, ROW_HEIGHT)
    return u
end
local function icon_button(root, id, image, tooltip)
    local u = find(id)
    if not u then
        u = UIComponent(root:CreateComponent(id, "ui/templates/square_medium_button"))
        if not live(u) then return nil end
        u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:Resize(32, 32)
        u:SetVisible(false)
    end
    u:SetImagePath(image); u:SetTooltipText(tooltip, true)
    return u
end
local function letter_card(root, index)
    local id = CARD_PREFIX .. index
    local u = find(id)
    if not u then
        -- The chat's own message card: an independent read-only text template.
        u = UIComponent(root:CreateComponent(id, "llmdip_ui/llmdip_bubble"))
        if not live(u) then return nil end
        u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:SetInteractive(false)
        u:SetVisible(false)
    end
    return u
end
local function hub_shell(root)
    local u = find(SHELL)
    if not u then
        out("[LLMDIP] HUB_CREATE_BEGIN|chat_shell_template")
        u = UIComponent(root:CreateComponent(SHELL, "llmdip_ui/llmdip_shell"))
        if not live(u) then return nil end
        u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:Resize(HUB_WIDTH, HUB_HEIGHT)
        u:SetVisible(false)
        out("[LLMDIP] HUB_CREATE_DONE")
    end
    -- The chat fills these for a conversation; the window only needs the frame,
    -- the crest, the title and the subtitle.
    for _, id in ipairs({"header_attitude", "proposal_card"}) do
        local part = find(id, u); if part then part:SetVisible(false) end
    end
    for i = 1, 16 do
        local crest = find("msg_icon_" .. i, u); if crest then crest:SetVisible(false) end
        local portrait = find("msg_portrait_" .. i, u); if portrait then portrait:SetVisible(false) end
    end
    local crest = find("header_crest", u)
    if crest then pcall(function() crest:SetImagePath("ui/skins/default/icon_diplomacy.png") end) end
    return u
end
local function set_header(u, subtitle)
    local title = find("header_title", u); if title then title:SetStateText(llmdip_t("hub_title")) end
    local meta = find("header_meta", u); if meta then meta:SetStateText(subtitle) end
end
local function hide_ids(ids)
    for _, id in ipairs(ids) do local u = find(id); if u then u:SetVisible(false) end end
end
local function letter_ids()
    local ids = {}
    for i = 1, CARDS do ids[#ids+1] = CARD_PREFIX .. i; ids[#ids+1] = REPLY_PREFIX .. i end
    return ids
end
local function contact_ids()
    local ids = {NAV, RACE_ON, RACE_OFF}
    for i = 1, ROWS do ids[#ids+1] = ROW_PREFIX .. i; ids[#ids+1] = MARK_PREFIX .. i end
    return ids
end
local function safe_text(fn)
    local ok, value = pcall(fn)
    return ok and type(value) == "string" and value or ""
end
local function hide_hub()
    local u = find(SHELL); if u then u:SetVisible(false) end
    local input = find("llmdip_hub_council_input")
    if input then pcall(function() input:StealInputFocus(false) end) end
    hide_ids({"llmdip_hub_council_open", "llmdip_hub_council_input", "llmdip_hub_council_send"})
    hide_ids({CLOSE, PREV, NEXT, TAB_LETTERS, TAB_CONTACTS, TAB_WORLD, OPT_TREATIES, OPT_ROMANCE, OPT_VOICE}); hide_ids(letter_ids()); hide_ids(contact_ids())
end

-- Letters tab: three cards per page, newest first; unread names in yellow. When
-- the companion is not answering, the first card says so (and what to do after a
-- Steam update) and the letters move down one place.
local function render_letters(root, left, top, u)
    local silent = llmdip_companion_silent and llmdip_companion_silent() or false
    local outdated = not silent and llmdip_companion_outdated and llmdip_companion_outdated() or false
    local notice = silent and llmdip_t("companion_missing") or (outdated and llmdip_t("companion_outdated")) or nil
    local per_page = notice and (CARDS - 1) or CARDS
    local shift = notice and 1 or 0
    local pages = math.max(1, math.ceil(#box.rows / per_page))
    page = math.max(1, math.min(page, pages))
    set_header(u, llmdip_t("tab_letters") .. " · " .. unread() .. llmdip_t("unread_count") .. " · " .. llmdip_t("page_word") .. page .. "/" .. pages)
    letter_slots = {}
    local y = top + CONTENT_TOP
    for i = 1, CARDS do
        local lines, height, row = nil, CARD_HEIGHT, nil
        if notice and i == 1 then
            height, lines = NOTICE_HEIGHT, {}
            for _, line in ipairs(fit_lines(notice, CARD_TEXT_WIDTH, NOTICE_LINES)) do
                lines[#lines+1] = "[[col:yellow]]" .. line .. "[[/col]]"
            end
        else
            row = box.rows[(page - 1) * per_page + i - shift]
            if row then
                local colour = row.read and "grey" or "yellow"
                lines = {"[[col:" .. colour .. "]]" .. first_line(lord_label(row.lord) .. " · " .. row.faction, CARD_TEXT_WIDTH) .. "[[/col]]",
                    "[[col:grey]]" .. first_line(row.status .. llmdip_t("turn_sep") .. tostring(row.turn), CARD_TEXT_WIDTH) .. "[[/col]]"}
                for _, line in ipairs(fit_lines(row.text, CARD_TEXT_WIDTH, PREVIEW_LINES)) do lines[#lines+1] = line end
            elseif #box.rows == 0 and i == 1 + shift then
                lines = {"[[col:yellow]]" .. llmdip_t("letters_empty") .. "[[/col]]"}
                for _, line in ipairs(fit_lines(llmdip_t("one_per_turn") .. " " .. llmdip_t("letters_enable_hint"), CARD_TEXT_WIDTH, 3)) do lines[#lines+1] = line end
            end
        end
        letter_slots[i] = row
        local card = letter_card(root, i)
        if card then
            if lines then
                card:Resize(CARD_WIDTH, height); card:MoveTo(left + CONTENT_LEFT, y)
                local field = find("bubble_text", card) or card
                field:SetCanResizeWidth(true); field:SetCanResizeHeight(true)
                field:Resize(CARD_WIDTH, height); field:SetInteractive(false)
                field:SetStateText(table.concat(lines, "\n"))
                card:SetVisible(true); topmost(card, 200)
            else
                card:SetVisible(false)
            end
        end
        local reply = icon_button(root, REPLY_PREFIX .. i, "ui/skins/default/icon_diplomacy.png", llmdip_t("reply_in_diplomacy"))
        if reply then
            reply:SetVisible(row ~= nil)
            if row then
                reply:SetTooltipText(row.faction .. " / " .. lord_label(row.lord) .. "\n" .. row.text .. llmdip_t("reply_in_chat"), true)
                reply:MoveTo(left + CONTENT_LEFT + CARD_WIDTH + 12, y + math.floor((height - 32) / 2)); topmost(reply, 250)
            end
        end
        y = y + height + CARD_GAP
    end
    return page, pages
end

-- Who can write to me: races with their counts, then the factions of one race (or
-- every known faction) with a tick or a cross that turns each one on or off.
local function render_contacts(root, left, top, u)
    local groups = llmdip_contact_groups and llmdip_contact_groups() or {}
    local items, title, group = groups, llmdip_t("races"), nil
    if contact_race == "all" then
        items, title = {}, llmdip_t("all_factions")
        for _, g in ipairs(groups) do for _, f in ipairs(g.factions) do items[#items+1] = f end end
        table.sort(items, function(a, b) if a.name == b.name then return a.key < b.key end return a.name < b.name end)
    elseif contact_race then
        for _, g in ipairs(groups) do if g.key == contact_race then group = g end end
        if group then items, title = group.factions, group.name else contact_race = nil end
    end
    local pages = math.max(1, math.ceil(#items / ROWS))
    contact_page = math.max(1, math.min(contact_page, pages))
    set_header(u, title .. " · " .. llmdip_t("page_word") .. contact_page .. "/" .. pages)
    local y0 = top + CONTENT_TOP
    local nav = text_button(root, NAV, 300)
    if nav then
        set_label(nav, contact_race and llmdip_t("back_to_races") or llmdip_t("see_all_factions"))
        nav:MoveTo(left + CONTENT_LEFT, y0); nav:SetVisible(true); topmost(nav, 250)
    end
    for _, spec in ipairs({{RACE_ON, "enable_race", 310}, {RACE_OFF, "disable_race", 476}}) do
        local b = text_button(root, spec[1], 160)
        if b then
            b:SetVisible(group ~= nil)
            if group then set_label(b, llmdip_t(spec[2])); b:MoveTo(left + CONTENT_LEFT + spec[3], y0); topmost(b, 250) end
        end
    end
    row_keys = {}
    local function enabled(item)
        local wanted = pending_contacts[item.key]
        if wanted == nil then return item.enabled end
        if wanted == item.enabled then pending_contacts[item.key] = nil end
        return wanted
    end
    local first = (contact_page - 1) * ROWS + 1
    for i = 1, ROWS do
        local item = items[first + i - 1]
        local y = y0 + ROW_HEIGHT + 10 + (i - 1) * (ROW_HEIGHT + ROW_GAP)
        local b = text_button(root, ROW_PREFIX .. i, ROW_WIDTH)
        if b then
            -- A faction row says in words whether it may write to you; the tick alone
            -- (and the cross, which looked like "close") left players guessing.
            local on = item and contact_race and enabled(item)
            local label = item and (contact_race
                and fit_width(item.name .. "  [" .. (on and llmdip_t("contact_on") or llmdip_t("contact_off")) .. "]"
                    .. (item.attitude and ("  " .. item.attitude) or ""), ROW_WIDTH - 40)
                or (item.name .. " (" .. item.enabled .. "/" .. item.count .. llmdip_t("enabled_suffix")))
            if not item and i == 1 and #items == 0 then label = llmdip_t("no_known_factions") end
            b:SetVisible(label ~= nil)
            if label then
                set_label(b, label); b:MoveTo(left + CONTENT_LEFT, y)
                b:SetTooltipText(contact_race and item and (item.name .. "\n" .. (on and llmdip_t("contact_click_off") or llmdip_t("contact_click_on"))) or label, true)
                topmost(b, 250)
                row_keys[i] = item and item.key or nil
            end
        end
        local show_mark = item ~= nil and contact_race ~= nil and enabled(item)
        local mark = icon_button(root, MARK_PREFIX .. i, TICK_IMAGE, llmdip_t("contact_click_off"))
        if mark then
            mark:SetVisible(show_mark)
            if show_mark then mark:MoveTo(left + CONTENT_LEFT + ROW_WIDTH + 12, y + 1); topmost(mark, 250) end
        end
    end
    return contact_page, pages
end

-- World: the chronicle and the court gossip of llm_diplomacy_world.lua, newest
-- first, in the same read-only cards as the letters. Entries from turns the player
-- has not looked at yet are in yellow.
local function render_world(root, left, top, u)
    local ok, entries = pcall(function() return llmdip_world_entries and llmdip_world_entries() or {} end)
    if not ok or type(entries) ~= "table" then entries = {} end
    -- The player's own court report always opens the tab, in a taller card, and the
    -- chronicle moves down one place, like the companion notice in the letters.
    local ok_report, report = pcall(function() return llmdip_world_report and llmdip_world_report() or nil end)
    if not ok_report or type(report) ~= "table" then report = nil end
    -- Every card is as tall as its text (03-10-2026: rumours and deeds were cut after
    -- three lines). Pages hold as many cards as fit above the switches, three at most.
    local blocks = {}
    if report then
        local lines = {"[[col:yellow]]" .. first_line(llmdip_t("report_title") .. llmdip_t("turn_sep") .. tostring(report.turn), CARD_TEXT_WIDTH) .. "[[/col]]"}
        for _, topic in ipairs(report.lines or {report.text}) do
            for _, line in ipairs(fit_lines(topic, CARD_TEXT_WIDTH, math.max(1, REPORT_MAX_LINES - #lines))) do
                if #lines < REPORT_MAX_LINES then lines[#lines + 1] = line end
            end
        end
        blocks[#blocks + 1] = {lines = lines}
    end
    for _, item in ipairs(entries) do
        local colour = item.new and "yellow" or "grey"
        local label = item.kind == "gossip" and llmdip_t("world_gossip")
            or (item.kind == "rumour" and llmdip_t("world_rumour"))
            or (item.kind == "deed" and llmdip_t("world_deed")) or llmdip_t("world_news")
        local lines = {"[[col:" .. colour .. "]]" .. first_line(label .. llmdip_t("turn_sep") .. tostring(item.turn), CARD_TEXT_WIDTH) .. "[[/col]]"}
        for _, line in ipairs(fit_lines(item.text, CARD_TEXT_WIDTH, ENTRY_MAX_LINES)) do lines[#lines+1] = line end
        blocks[#blocks + 1] = {lines = lines}
    end
    if #entries == 0 then
        local lines = {"[[col:yellow]]" .. llmdip_t("tab_world") .. "[[/col]]"}
        for _, line in ipairs(fit_lines(llmdip_t("world_empty"), CARD_TEXT_WIDTH, 3)) do lines[#lines+1] = line end
        blocks[#blocks + 1] = {lines = lines}
    end
    local room = (HUB_HEIGHT - 56) - CONTENT_TOP
    local book, page, used = {}, {}, 0
    for _, block in ipairs(blocks) do
        block.height = math.max(CARD_HEIGHT, REPORT_PADDING + LINE_HEIGHT * #block.lines)
        local need = block.height + (#page > 0 and CARD_GAP or 0)
        if #page > 0 and (#page >= CARDS or used + need > room) then
            book[#book + 1] = page; page, used = {}, 0
            need = block.height
        end
        page[#page + 1] = block; used = used + need
    end
    if #page > 0 then book[#book + 1] = page end
    local pages = math.max(1, #book)
    world_page = math.max(1, math.min(world_page, pages))
    set_header(u, llmdip_t("tab_world") .. " · " .. llmdip_t("page_word") .. world_page .. "/" .. pages)
    letter_slots = {}
    local y = top + CONTENT_TOP
    local shown = book[world_page] or {}
    for i = 1, CARDS do
        local block = shown[i]
        local card = letter_card(root, i)
        if card then
            if block then
                card:Resize(CARD_WIDTH, block.height); card:MoveTo(left + CONTENT_LEFT, y)
                local field = find("bubble_text", card) or card
                field:SetCanResizeWidth(true); field:SetCanResizeHeight(true)
                field:Resize(CARD_WIDTH, block.height); field:SetInteractive(false)
                field:SetStateText(table.concat(block.lines, "\n"))
                card:SetVisible(true); topmost(card, 200)
            else
                card:SetVisible(false)
            end
        end
        local reply = find(REPLY_PREFIX .. i); if reply then reply:SetVisible(false) end
        if block then y = y + block.height + CARD_GAP end
    end
    -- The switches of the World, along the bottom edge, left of the page arrows.
    -- Each says its state in words; the tooltip says what it does. Three fit since 0.45.
    local ok_opt, opts = pcall(function() return llmdip_world_options and llmdip_world_options() or nil end)
    -- Widths add up to the 560px between the frame's edge and the page arrows.
    local specs = {{OPT_TREATIES, "treaties", "opt_treaties", "opt_treaties_tip", 210}, {OPT_ROMANCE, "romance", "opt_romance", "opt_romance_tip", 166},
        {OPT_VOICE, "voice", "opt_voice", "opt_voice_tip", 166}}
    -- No Voice switch in a game language Player2 cannot speak properly.
    local ok_voice, voice_ok = pcall(function() return llmdip_voice_supported and llmdip_voice_supported() end)
    local x = CONTENT_LEFT
    for i, spec in ipairs(specs) do
        local b = text_button(root, spec[1], spec[5])
        if b then
            local visible = ok_opt and type(opts) == "table"
            if spec[1] == OPT_VOICE and not (ok_voice and voice_ok) then visible = false end
            b:SetVisible(visible)
            if visible then
                set_label(b, llmdip_t(spec[3]) .. ": " .. (opts[spec[2]] and llmdip_t("opt_on") or llmdip_t("opt_off")))
                b:SetTooltipText(llmdip_t(spec[4]), true)
                b:MoveTo(left + x, top + HUB_HEIGHT - 48); topmost(b, 250)
            end
        end
        x = x + spec[5] + 8
    end
    -- Talk to your court: beside the first card, where letters keep their reply icon.
    local open = icon_button(root, COUNCIL_OPEN, "ui/skins/default/icon_diplomacy.png", llmdip_t("council_open_tip"))
    if open then
        open:MoveTo(left + CONTENT_LEFT + CARD_WIDTH + 12, top + CONTENT_TOP + 8); open:SetVisible(true); topmost(open, 250)
    end
    return world_page, pages
end

local function world_unseen()
    local ok, n = pcall(function() return llmdip_world_unseen and llmdip_world_unseen() or 0 end)
    return ok and tonumber(n) or 0
end
-- Your court: a conversation with your adviser inside this window. The input is a
-- second, root-owned copy of the chat's own editable template, like the frame is a
-- copy of the chat's shell; it steals keyboard focus only while this view is open.
local COUNCIL_INPUT_WIDTH, COUNCIL_MAX_LINES = 560, 14
local function council_focus(on)
    local u = find(COUNCIL_INPUT)
    if u then pcall(function() u:StealInputFocus(on) end) end
end
local function council_input(root)
    local u = find(COUNCIL_INPUT)
    if not u then
        u = UIComponent(root:CreateComponent(COUNCIL_INPUT, "llmdip_ui/llmdip_chat"))
        if not live(u) then return nil end
        u:SetCanResizeWidth(true); u:SetCanResizeHeight(true); u:SetVisible(false)
    end
    u:Resize(COUNCIL_INPUT_WIDTH, 42)
    return u
end
local function read_council_text()
    local u = find(COUNCIL_INPUT); if not u then return "" end
    local text = safe_text(function() return u:GetStateText() end)
    if text ~= "" then return text end
    local entry = find("entry_box", u)
    return entry and safe_text(function() return entry:GetStateText() end) or ""
end
local function clear_council_text()
    local u = find(COUNCIL_INPUT); if not u then return end
    pcall(function() u:SetStateText("") end)
    local entry = find("entry_box", u); if entry then pcall(function() entry:SetStateText("") end) end
end
local function render_council(root, left, top, u)
    set_header(u, llmdip_t("council_title"))
    letter_slots = {}
    local ok, list = pcall(function() return llmdip_council_history and llmdip_council_history() or {} end)
    if not ok or type(list) ~= "table" then list = {} end
    local waiting = false
    pcall(function() waiting = llmdip_council_waiting and llmdip_council_waiting() or false end)
    if not waiting then
        -- An expired wait adds its note to the history: read it again.
        local again, fresh = pcall(function() return llmdip_council_history and llmdip_council_history() or {} end)
        if again and type(fresh) == "table" then list = fresh end
    end
    local function block(head, colour, text)
        local lines = {"[[col:" .. colour .. "]]" .. first_line(head, CARD_TEXT_WIDTH) .. "[[/col]]"}
        for _, line in ipairs(fit_lines(text, CARD_TEXT_WIDTH, COUNCIL_MAX_LINES)) do lines[#lines + 1] = line end
        return {lines = lines, height = math.max(56, REPORT_PADDING + LINE_HEIGHT * #lines)}
    end
    -- Newest first; the newest is always shown whole, older ones while they fit.
    local blocks = {}
    if waiting then blocks[#blocks + 1] = block(llmdip_t("council_speaker"), "yellow", llmdip_t("council_thinking")) end
    for i = #list, 1, -1 do
        if #blocks >= CARDS then break end
        local m = list[i]
        if m.who == "you" then blocks[#blocks + 1] = block(llmdip_t("you"), "grey", m.text)
        elseif m.who == "note" then blocks[#blocks + 1] = block(llmdip_t("council_speaker"), "grey", llmdip_t(m.text))
        else blocks[#blocks + 1] = block(llmdip_t("council_speaker"), "yellow", m.text) end
    end
    if #blocks == 0 then blocks[1] = block(llmdip_t("council_title"), "yellow", llmdip_t("council_hint")) end
    local room, used, shown = (HUB_HEIGHT - 64) - CONTENT_TOP, 0, {}
    for _, b in ipairs(blocks) do
        local need = b.height + (#shown > 0 and CARD_GAP or 0)
        if #shown > 0 and used + need > room then break end
        table.insert(shown, 1, b); used = used + need
    end
    local y = top + CONTENT_TOP
    for i = 1, CARDS do
        local card, b = letter_card(root, i), shown[i]
        if card then
            if b then
                card:Resize(CARD_WIDTH, b.height); card:MoveTo(left + CONTENT_LEFT, y)
                local field = find("bubble_text", card) or card
                field:SetCanResizeWidth(true); field:SetCanResizeHeight(true)
                field:Resize(CARD_WIDTH, b.height); field:SetInteractive(false)
                field:SetStateText(table.concat(b.lines, "\n"))
                card:SetVisible(true); topmost(card, 200)
                y = y + b.height + CARD_GAP
            else
                card:SetVisible(false)
            end
        end
        local reply = find(REPLY_PREFIX .. i); if reply then reply:SetVisible(false) end
    end
    local input = council_input(root)
    if input then
        input:MoveTo(left + CONTENT_LEFT, top + HUB_HEIGHT - 56); input:SetVisible(true); topmost(input, 250)
        local entry = find("entry_box", input); if entry then entry:SetInteractive(true) end
    end
    local send = icon_button(root, COUNCIL_SEND, "ui/skins/default/icon_tick.png", llmdip_t("council_send"))
    if send then
        send:MoveTo(left + CONTENT_LEFT + COUNCIL_INPUT_WIDTH + 12, top + HUB_HEIGHT - 52); send:SetVisible(true); topmost(send, 250)
    end
    return 1, 1
end

local function render_tabs(root, left, top)
    for _, spec in ipairs({{TAB_LETTERS, "letters", 0, 190}, {TAB_CONTACTS, "contacts", 198, 250}, {TAB_WORLD, "world", 456, 184}}) do
        local b = text_button(root, spec[1], spec[4])
        if b then
            local label = llmdip_t("tab_contacts")
            if spec[2] == "letters" then label = llmdip_t("tab_letters") .. " (" .. unread() .. ")"
            elseif spec[2] == "world" then
                local fresh = world_unseen()
                label = llmdip_t("tab_world") .. (fresh > 0 and (" (" .. fresh .. ")") or "")
            end
            set_label(b, label)
            b:MoveTo(left + CONTENT_LEFT + spec[3], top + HEADER_HEIGHT + 6)
            -- Vanilla buttons have a selected state; if this one does not, the
            -- subtitle still names the open tab.
            pcall(function() b:SetState(tab == spec[2] and "selected" or "active") end)
            b:SetVisible(true); topmost(b, 250)
        end
    end
end
local function render_pager(root, left, top, current, pages)
    local prev = icon_button(root, PREV, "ui/skins/default/icon_arrow_up.png", llmdip_t("prev_page"))
    local next_page = icon_button(root, NEXT, "ui/skins/default/icon_arrow_down.png", llmdip_t("next_page"))
    local bottom = top + HUB_HEIGHT - 48
    if prev then
        prev:SetVisible(current > 1)
        if current > 1 then prev:MoveTo(left + HUB_WIDTH - 100, bottom); topmost(prev, 250) end
    end
    if next_page then
        next_page:SetVisible(current < pages)
        if current < pages then next_page:MoveTo(left + HUB_WIDTH - 60, bottom); topmost(next_page, 250) end
    end
end

local function refresh_button()
    local b = find(BUTTON)
    if b then
        b:SetTooltipText(llmdip_t("hub_tooltip"), true)
        set_label(b, llmdip_t("hub_button") .. " (" .. unread() .. ")")
    end
end
local function refresh()
    refresh_button()
    if not shown then return end
    local root = checked_root()
    if not root then shown = false; return end
    local ok, failure = pcall(function()
        local u = hub_shell(root)
        if not u then error("hub shell unavailable") end
        local sw, sh = root:Bounds()
        local left = math.max(5, math.floor((sw - HUB_WIDTH) / 2))
        local top = math.max(70, math.floor((sh - HUB_HEIGHT) / 2))
        -- Frame first, controls after: the order the chat proved so the buttons
        -- paint above the frame's background.
        u:MoveTo(left, top); u:SetVisible(true); u:RegisterTopMost()
        render_tabs(root, left, top)
        local close = icon_button(root, CLOSE, "ui/skins/default/icon_cross.png", llmdip_t("close_mailbox"))
        if close then close:MoveTo(left + HUB_WIDTH - 54, top + 14); close:SetVisible(true); topmost(close, 250) end
        local current, pages
        if tab ~= "world" then hide_ids({OPT_TREATIES, OPT_ROMANCE, OPT_VOICE, COUNCIL_OPEN}) end
        if tab ~= "council" then council_focus(false); hide_ids({COUNCIL_INPUT, COUNCIL_SEND}) end
        if tab == "letters" then
            hide_ids(contact_ids())
            current, pages = render_letters(root, left, top, u)
        elseif tab == "world" then
            hide_ids(contact_ids())
            current, pages = render_world(root, left, top, u)
        elseif tab == "council" then
            hide_ids(contact_ids())
            current, pages = render_council(root, left, top, u)
        else
            hide_ids(letter_ids())
            current, pages = render_contacts(root, left, top, u)
        end
        render_pager(root, left, top, current, pages)
    end)
    if not ok then
        out("[LLMDIP] HUB_RENDER_ERROR|" .. tostring(failure))
        hide_hub(); shown = false
    end
end
-- The court's report arrives while the window may be open: draw it again then.
function llmdip_mail_redraw() if shown then refresh() end end
-- The latest letters, for the court to advise on: "lord of faction (turn N): text".
function llmdip_mail_recent(count)
    local result = {}
    for _, row in ipairs(box.rows) do
        if #result >= (count or 3) then break end
        result[#result + 1] = tostring(row.lord) .. " of " .. tostring(row.faction) .. " (turn " .. tostring(row.turn) .. "): "
            .. string.sub(string.gsub(tostring(row.text or ""), "[\r\n]+", " "), 1, 300)
    end
    return table.concat(result, " / ")
end
function llmdip_mail_hide()
    local was_shown = shown; shown = false
    if was_shown then hide_hub() end
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
        b:SetCanResizeWidth(true); b:SetCanResizeHeight(true); b:Resize(BUTTON_WIDTH, 36)
        b:SetDockingPoint(1); b:SetDockOffset(20, 123)
        b:PropagatePriority(200); b:SetInteractive(true)
        if not find("button_txt", b) then error("Falta button_txt en el botón de mensajes") end
        out("[LLMDIP] MAIL_BUTTON_CREATED|top_left|20|123|0.43")
    end
    -- Persistent root ownership, like the rest of the mod's controls. Do not
    -- insert a new child in the engine-owned menu_bar/buttongroup layout.
    -- Every second only the counter is updated. The window is drawn again on
    -- events (open, tab, page, switch, new letter), the way the chat re-registers
    -- its controls, never on a timer.
    b:SetVisible(true); refresh_button()
    local round = cm:model():turn_number()
    if box.round ~= round then box.round=round; box.queries=0; box.contacted={}; box.exhausted=false; save() end
    -- Unread letters are not a rejection and do not prevent next-turn letters.
    -- contacted is saved with the campaign; the bridge also checks the last turn.
    -- No letter is requested while the window is open, as with the old menu.
    if shown or box.exhausted then return end
    local target, exhausted = llmdip_mail_request(box.contacted)
    if target then box.contacted[target]=true; box.queries=box.queries+1
    elseif exhausted then box.exhausted=true end
    save()
end
-- A contact switch travels as a UITrigger event and is applied a moment later,
-- so the list is drawn again once the game has stored it.
local function toggle_contacts(keys, wanted)
    for _, key in ipairs(keys) do
        if llmdip_toggle_contact and llmdip_toggle_contact(key) ~= false then pending_contacts[key] = wanted[key] end
    end
    refresh()
    for _, delay in ipairs({300, 1200}) do
        cm:real_callback(function() if shown and tab == "contacts" then refresh() end end, delay)
    end
end
core:add_listener("llmdip39_mail_click", "ComponentLClickUp", true, function(context)
    local id = context.string
    if id == CLOSE then llmdip_mail_hide(); return end
    if not allowed() then return end
    if id == BUTTON then
        if shown then llmdip_mail_hide()
        else
            out("[LLMDIP] MAIL_OPEN_BEGIN")
            shown=true; refresh()
            if shown then out("[LLMDIP] MAIL_OPEN_DONE") end
        end
        return
    end
    if not shown then return end
    if id == TAB_LETTERS then tab = "letters"; refresh()
    elseif id == TAB_CONTACTS then tab = "contacts"; refresh()
    elseif id == COUNCIL_OPEN and tab == "world" then
        tab = "council"; refresh()
        cm:real_callback(function() if shown and tab == "council" then council_focus(true) end end, 40)
    elseif id == COUNCIL_SEND and tab == "council" then
        local text = read_council_text()
        local ok, sent = pcall(function() return llmdip_council_send and llmdip_council_send(text) end)
        if ok and sent then clear_council_text() end
        refresh()
        cm:real_callback(function() if shown and tab == "council" then council_focus(true) end end, 40)
    elseif id == "entry_box" and tab == "council" then
        council_focus(true)
    elseif (id == OPT_TREATIES or id == OPT_ROMANCE or id == OPT_VOICE) and tab == "world" then
        local name = id == OPT_TREATIES and "treaties" or (id == OPT_ROMANCE and "romance" or "voice")
        if llmdip_world_toggle then pcall(llmdip_world_toggle, name) end
        refresh()
    elseif id == TAB_WORLD then
        tab = "world"; refresh()
        -- Seen once drawn: the yellow marks what was new when the tab was opened.
        if llmdip_world_mark_seen then pcall(llmdip_world_mark_seen) end
    elseif id == PREV then
        if tab == "letters" then page = math.max(1, page - 1)
        elseif tab == "world" then world_page = math.max(1, world_page - 1)
        else contact_page = math.max(1, contact_page - 1) end
        refresh()
    elseif id == NEXT then
        if tab == "letters" then page = page + 1
        elseif tab == "world" then world_page = world_page + 1
        else contact_page = contact_page + 1 end
        refresh()
    elseif id == NAV then
        if contact_race then contact_race = nil else contact_race = "all" end
        contact_page = 1; refresh()
    elseif id == RACE_ON or id == RACE_OFF then
        local wanted, keys, target = id == RACE_ON, {}, {}
        for _, g in ipairs(llmdip_contact_groups and llmdip_contact_groups() or {}) do
            if g.key == contact_race then
                for _, f in ipairs(g.factions) do
                    if f.enabled ~= wanted then keys[#keys+1] = f.key; target[f.key] = wanted end
                end
            end
        end
        toggle_contacts(keys, target)
    else
        local row = tonumber(string.match(id or "", "^llmdip_hub_row_(%d+)$") or string.match(id or "", "^llmdip_hub_mark_(%d+)$"))
        if row then
            local key = tab == "contacts" and row_keys[row] or nil
            if key and contact_race then
                local now = pending_contacts[key]
                if now == nil then now = llmdip_is_contact_enabled and llmdip_is_contact_enabled(key) or false end
                toggle_contacts({key}, {[key] = not now})
            elseif key then contact_race = key; contact_page = 1; refresh() end
            return
        end
        local slot = tonumber(string.match(id or "", "^llmdip39_mail_reply_(%d)$"))
        local letter = slot and tab == "letters" and letter_slots[slot]
        if letter then
            local ai = cm:get_faction(letter.target)
            if not ai or ai:is_null_interface() or ai:is_dead() or ai:is_human() then
                letter.status=llmdip_t("faction_unavailable"); save(); refresh(); return
            end
            if llmdip_ui_open_target(letter.target) then llmdip_mail_hide()
            else letter.status=llmdip_t("open_diplomacy_hint"); save(); refresh() end
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
