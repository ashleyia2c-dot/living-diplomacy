-- Player2 Diplomacy v0.37 bridge, strategic dossiers, save-aware memories and vanilla-HUD chat.
-- Model mutations originating in UI always pass through TriggerCampaignScriptEvent.

-- WH3 loads mod chunks with a private environment. Use the documented campaign global
-- environment so this file, the UI file and the generated inbox can call one another.
setfenv(1, core:get_env())

local PREFIX = "LLMDIP2"
local COOLDOWN_TURNS = 1

local request_chunks, response_chunks, pending, published, consumed_external = {}, {}, {}, {}, {}
local execute_action, apply_relation_reaction, execute_betrayal
local campaign_id = nil
local menu_open, menu_page, menu_components = false, 1, {}
local menu_race = nil -- nil: races; all: every known living AI faction.
local request_serial = 0
local runtime_nonce = tostring(math.floor(os.clock() * 1000000))
local player_phase = false
local function copy_data(value)
    if type(value) ~= "table" then return value end
    local result = {}; for k, v in pairs(value) do result[k] = copy_data(v) end
    return result
end
local function save_pending() cm:set_saved_value("llmdip39_pending", copy_data(pending)) end
function llmdip_player_phase() return player_phase end

local function split(value, separator)
    local result = {}
    local pattern = "([^" .. separator .. "]+)"
    string.gsub(value or "", pattern, function(part) result[#result + 1] = part end)
    return result
end

local function percent_encode(value)
    value = string.gsub(tostring(value or ""), "\n", " ")
    return string.gsub(value, "([^%w%-%_%.%~])", function(c) return string.format("%%%02X", string.byte(c)) end)
end

local function percent_decode(value)
    return string.gsub(value or "", "%%(%x%x)", function(hex) return string.char(tonumber(hex, 16)) end)
end

local function clean_value(value)
    return string.gsub(tostring(value or "unknown"), "[,;|=\r\n]", "_")
end

local function localised_value(value)
    if type(value) ~= "string" or value == "" then return "" end
    local ok, translated = pcall(function() return common.get_localised_string(value) end)
    if ok and type(translated) == "string" and translated ~= "" and translated ~= value then return translated end
    return value
end

local function chunk(value, size)
    local result = {}
    for i = 1, #value, size do result[#result + 1] = string.sub(value, i, i + size - 1) end
    return result
end

local function local_faction() return cm:get_local_faction(true) end

local function broadcast(trigger)
    local faction = local_faction()
    if not faction or faction:is_null_interface() then return false end
    CampaignUI.TriggerCampaignScriptEvent(faction:command_queue_index(), trigger)
    return true
end

local function valid_key(value)
    return type(value) == "string" and #value > 0 and #value <= 160 and string.match(value, "^[a-z0-9_]+$") ~= nil
end

local function valid_relation_reason(value)
    return value == "respect" or value == "insult" or value == "threat" or value == "empathy" or value == "credibility" or value == "repetition" or value == "neutral"
end

local function bool_number(value) return value and "1" or "0" end

local function safe_value(default, callback)
    local ok, value = pcall(callback)
    if ok and value ~= nil then return value end
    return default
end

local function list_keys(list, limit)
    local result = {}
    if not list then return "none" end
    local count = safe_value(0, function() return list:num_items() end)
    if count < 1 then return "none" end
    for i = 0, math.min(count, limit) - 1 do
        local item = safe_value(nil, function() return list:item_at(i) end)
        if item and not item:is_null_interface() then result[#result + 1] = clean_value(item:name()) end
    end
    return #result > 0 and table.concat(result, ":") or "none"
end

local function region_keys(faction, limit)
    local list, values = faction:region_list(), {}
    for i = 0, math.min(list:num_items(), limit) - 1 do values[#values + 1] = list:item_at(i):name() end
    return table.concat(values, ":")
end

local function total_force_strength(faction)
    local list, value = faction:military_force_list(), 0
    for i = 0, list:num_items() - 1 do
        local force = list:item_at(i)
        if not force:is_null_interface() then value = value + force:strength() end
    end
    return math.floor(value)
end

local function leader_identity(faction)
    local result = {
        name = "unknown", subtype = "unknown", rank = 0, unique = false,
        immortal = false, male = true, traits = "none", battles = 0, victories = 0,
        region = "none", subtype_title = "", subtype_description = ""
    }
    local ok, leader = pcall(function() return faction:faction_leader() end)
    if ok and leader and not leader:is_null_interface() then
        local ok_name, value = pcall(function()
            return localised_value(leader:get_forename()) .. " " .. localised_value(leader:get_surname())
        end)
        if ok_name then result.name = value end
        local ok_subtype, sub = pcall(function() return leader:character_subtype_key() end)
        if ok_subtype then result.subtype = sub end
        result.rank = safe_value(0, function() return leader:rank() end)
        result.battles = safe_value(0, function() return leader:battles_fought() end)
        result.victories = safe_value(0, function() return leader:battles_won() end)
        local details = safe_value(nil, function() return leader:character_details() end)
        if details and not details:is_null_interface() then
            result.unique = safe_value(false, function() return details:is_unique() end)
            result.immortal = safe_value(false, function() return details:is_immortal() end)
            result.male = safe_value(true, function() return details:is_male() end)
            local traits = safe_value({}, function() return details:all_traits() end)
            local cleaned = {}
            if type(traits) == "table" then
                for i = 1, math.min(#traits, 12) do cleaned[#cleaned + 1] = clean_value(traits[i]) end
            end
            if #cleaned > 0 then result.traits = table.concat(cleaned, ":") end
        end
        local region = safe_value(nil, function() return leader:region() end)
        if region and not region:is_null_interface() then result.region = clean_value(region:name()) end
        result.subtype_title = clean_value(safe_value("", function()
            return common.get_context_value("CcoAgentSubtypeRecord", result.subtype, "OnscreenNameOverride")
        end))
        result.subtype_description = clean_value(safe_value("", function()
            return common.get_context_value("CcoAgentSubtypeRecord", result.subtype, "DescriptionTextOverride")
        end))
    end
    result.name, result.subtype = clean_value(result.name), clean_value(result.subtype)
    return result
end

local function faction_strength_rank(faction)
    return safe_value(0, function() return cm:model():faction_strength_rank(faction) end)
end

local function region_distance(first, second, maximum)
    local first_regions, second_regions = first:region_list(), second:region_list()
    local targets, visited, queue, head = {}, {}, {}, 1
    for i = 0, second_regions:num_items() - 1 do targets[second_regions:item_at(i):name()] = true end
    for i = 0, first_regions:num_items() - 1 do
        local region = first_regions:item_at(i); local key = region:name()
        if targets[key] then return 0 end
        visited[key] = true; queue[#queue + 1] = {region = region, depth = 0}
    end
    while head <= #queue do
        local current = queue[head]; head = head + 1
        if current.depth < maximum then
            local adjacent = safe_value(nil, function() return current.region:adjacent_region_list() end)
            local count = adjacent and adjacent:num_items() or 0
            for i = 0, count - 1 do
                local region = adjacent:item_at(i); local key = region:name()
                if targets[key] then return current.depth + 1 end
                if not visited[key] then
                    visited[key] = true; queue[#queue + 1] = {region = region, depth = current.depth + 1}
                end
            end
        end
    end
    return -1
end

local function shared_border_count(first, second)
    local second_key, seen, count = second:name(), {}, 0
    local regions = first:region_list()
    for i = 0, regions:num_items() - 1 do
        local adjacent = safe_value(nil, function() return regions:item_at(i):adjacent_region_list() end)
        local adjacent_count = adjacent and adjacent:num_items() or 0
        for j = 0, adjacent_count - 1 do
            local region = adjacent:item_at(j)
            local owner = safe_value(nil, function() return region:owning_faction() end)
            if owner and not owner:is_null_interface() and owner:name() == second_key and not seen[region:name()] then
                seen[region:name()] = true; count = count + 1
            end
        end
    end
    return count
end

local function diplomacy_history_key(faction_key) return "llmdip_recent_diplomacy_" .. faction_key end

local function append_diplomacy_history(faction, event)
    if not faction or faction:is_null_interface() then return end
    local key, entries = diplomacy_history_key(faction:name()), split(cm:get_saved_value(diplomacy_history_key(faction:name())) or "", ";")
    entries[#entries + 1] = event
    while #entries > 10 do table.remove(entries, 1) end
    cm:set_saved_value(key, table.concat(entries, ";"))
end

local function record_diplomatic_event(kind, proposer, recipient)
    if not proposer or proposer:is_null_interface() or not recipient or recipient:is_null_interface() then return end
    local event = table.concat({tostring(cm:model():turn_number()), clean_value(kind), proposer:name(), recipient:name()}, "~")
    append_diplomacy_history(proposer, event); append_diplomacy_history(recipient, event)
    out("[LLMDIP] DIPLOMACY_EVENT|" .. event)
end

-- Return only saved diplomacy events whose two parties are this player and
-- this interlocutor.  The normal faction history contains events involving
-- many other neighbours; passing that whole list to the model made it easy
-- to mistake another war for a war with the current lord.  Battle victories
-- are deliberately not fabricated here: WH3 exposes each lord's global
-- battles_won(), not a reliable bilateral battle counter.
local function direct_diplomacy_events(first_key, second_key)
    local entries = split(tostring(cm:get_saved_value(diplomacy_history_key(first_key)) or ""), ";")
    local result, seen = {}, {}
    for i = 1, #entries do
        local turn, kind, proposer, recipient = string.match(entries[i], "^([^~]+)~([^~]+)~([^~]+)~([^~]+)$")
        if turn and kind and proposer and recipient and
            ((proposer == first_key and recipient == second_key) or
             (proposer == second_key and recipient == first_key)) then
            -- Keep who started it. Without it the model read "52~military_alliance_broken"
            -- as the player's betrayal when the game recorded Kislev ending the treaty.
            local item = turn .. "~" .. kind .. "~by_" .. (proposer == first_key and "player" or "interlocutor")
            if not seen[item] then seen[item] = true; result[#result + 1] = item end
        end
    end
    return #result > 0 and table.concat(result, ":") or "none_recorded"
end

local function event_flag(context, method)
    return safe_value(false, function() return context[method](context) end) == true
end

local function positive_event_kind(context)
    if event_flag(context, "is_military_alliance") then return "military_alliance_signed" end
    if event_flag(context, "is_defensive_alliance") then return "defensive_alliance_signed" end
    if event_flag(context, "is_alliance") then return "alliance_signed" end
    if event_flag(context, "is_peace_treaty") then return "peace_signed" end
    if event_flag(context, "is_trade_agreement") then return "trade_signed" end
    if event_flag(context, "is_non_aggression_pact") then return "non_aggression_signed" end
    if event_flag(context, "is_military_access") then return "military_access_signed" end
    if event_flag(context, "is_vassalage") then return "vassalage_signed" end
    if event_flag(context, "is_state_gift") then return "state_gift" end
    return "positive_treaty"
end

local function negative_event_kind(context)
    if event_flag(context, "is_war") then return "war_declared" end
    if event_flag(context, "was_military_alliance") then return "military_alliance_broken" end
    if event_flag(context, "was_defensive_alliance") then return "defensive_alliance_broken" end
    if event_flag(context, "was_alliance") then return "alliance_broken" end
    if event_flag(context, "was_trade_agreement") then return "trade_broken" end
    if event_flag(context, "was_non_aggression_pact") then return "non_aggression_broken" end
    if event_flag(context, "was_military_access") then return "military_access_broken" end
    if event_flag(context, "was_vassalage") then return "vassalage_broken" end
    return "negative_treaty"
end

local function model_attitude_value(subject, other)
    local standing_ok, standing = pcall(function() return subject:diplomatic_standing_with(other) end)
    if standing_ok and tonumber(standing) then return tonumber(standing) end
    local attitude_ok, attitude = pcall(function() return subject:diplomatic_attitude_towards(other) end)
    if attitude_ok and tonumber(attitude) then return tonumber(attitude) end
    return 0
end

local function campaign_snapshot(player, interlocutor, ui_attitude, ui_personality, memory_parent, memory_head)
    local ok, value = pcall(function()
        local ai_leader, player_leader = leader_identity(interlocutor), leader_identity(player)
        -- Never traverse UIComponents from the request pipeline. Diplomacy is
        -- allowed to destroy/rebuild its tree during a click; a stale C++ UIC
        -- cannot be made safe with pcall and used to abort requests/crash exit.
        -- CcoCampaignFaction exposes the same vanilla attitude category/text
        -- without touching that transient UI hierarchy.
        local attitude_category = common.get_context_value("CcoCampaignFaction", interlocutor:name(), "AttitudeCategory") or ""
        local attitude_text = common.get_context_value("CcoCampaignFaction", interlocutor:name(), "AttitudeTooltip") or ""
        -- In WH3 the bilateral UI's dy_value is the exact number displayed to
        -- the player. diplomatic_attitude_towards() returned 0 for a verified
        -- vanilla value of -93, so a value captured when opening diplomacy is
        -- authoritative. Proactive conversations fall back to standing, then
        -- attitude, without ever traversing UI from this request pipeline.
        local attitude = math.floor(tonumber(ui_attitude) or model_attitude_value(interlocutor, player))
        local player_strength, ai_strength = total_force_strength(player), total_force_strength(interlocutor)
        local ratio = player_strength / math.max(ai_strength, 1)
        local relative_power = ratio >= 1.8 and "player_overwhelming" or (ratio >= 1.2 and "player_stronger" or (ratio <= 0.55 and "ai_overwhelming" or (ratio <= 0.83 and "ai_stronger" or "similar")))
        return table.concat({
            "turn=" .. tostring(cm:model():turn_number()),
            "memory_parent=" .. clean_value(memory_parent),
            "memory_head=" .. clean_value(memory_head),
            "player_faction_name=" .. clean_value(safe_value(player:name(), function() return common.get_context_value("CcoCampaignFaction", player:name(), "Name") end)),
            "ai_faction_name=" .. clean_value(safe_value(interlocutor:name(), function() return common.get_context_value("CcoCampaignFaction", interlocutor:name(), "Name") end)),
            "player_leader=" .. player_leader.name,
            "player_leader_subtype=" .. player_leader.subtype,
            "player_leader_rank=" .. tostring(player_leader.rank),
            "player_leader_unique=" .. bool_number(player_leader.unique),
            "player_leader_immortal=" .. bool_number(player_leader.immortal),
            "player_leader_traits=" .. player_leader.traits,
            "player_leader_battles=" .. tostring(player_leader.battles),
            "player_leader_victories=" .. tostring(player_leader.victories),
            "player_global_battles=" .. tostring(player_leader.battles),
            "player_global_victories=" .. tostring(player_leader.victories),
            "player_leader_region=" .. player_leader.region,
            "player_leader_title=" .. player_leader.subtype_title,
            "player_leader_description=" .. player_leader.subtype_description,
            "diplomatic_attitude=" .. tostring(attitude),
            "attitude_category=" .. clean_value(attitude_category),
            "attitude_text=" .. clean_value(attitude_text),
            "war=" .. bool_number(interlocutor:at_war_with(player)),
            "direct_war_now=" .. bool_number(interlocutor:at_war_with(player)),
            "direct_war_events=" .. direct_diplomacy_events(player:name(), interlocutor:name()),
            "battles_against_interlocutor=unknown_not_tracked",
            "victories_against_interlocutor=unknown_not_tracked",
            "allied=" .. bool_number(interlocutor:allied_with(player)),
            "def_alliance=" .. bool_number(interlocutor:defensive_allies_with(player)),
            "mil_alliance=" .. bool_number(interlocutor:military_allies_with(player)),
            "trade=" .. bool_number(interlocutor:trade_agreement_with(player)),
            "nap=" .. bool_number(interlocutor:non_aggression_pact_with(player)),
            "access=" .. bool_number(interlocutor:military_access_pact_with(player)),
            "player_treasury=" .. tostring(player:treasury()),
            "ai_treasury=" .. tostring(interlocutor:treasury()),
            "player_income=" .. tostring(safe_value(0, function() return player:income() end)),
            "ai_income=" .. tostring(safe_value(0, function() return interlocutor:income() end)),
            "player_net_income=" .. tostring(safe_value(0, function() return player:net_income() end)),
            "ai_net_income=" .. tostring(safe_value(0, function() return interlocutor:net_income() end)),
            "player_strength=" .. tostring(player_strength),
            "ai_strength=" .. tostring(ai_strength),
            "player_strength_rank=" .. tostring(faction_strength_rank(player)),
            "ai_strength_rank=" .. tostring(faction_strength_rank(interlocutor)),
            "relative_power=" .. relative_power,
            "relative_power_ratio=" .. string.format("%.2f", ratio),
            "region_hops=" .. tostring(region_distance(player, interlocutor, 8)),
            "shared_border_regions=" .. tostring(shared_border_count(player, interlocutor)),
            "player_regions=" .. region_keys(player, 12),
            "ai_regions=" .. region_keys(interlocutor, 12),
            "player_allies=" .. list_keys(player:factions_allied_with(), 10),
            "player_trades=" .. list_keys(player:factions_trading_with(), 10),
            "player_wars=" .. list_keys(player:factions_at_war_with(), 10),
            "ai_allies=" .. list_keys(interlocutor:factions_allied_with(), 10),
            "ai_trades=" .. list_keys(interlocutor:factions_trading_with(), 10),
            "ai_war_factions=" .. list_keys(interlocutor:factions_at_war_with(), 10),
            "player_started_war_this_turn=" .. bool_number(safe_value(false, function() return player:started_war_this_turn() end)),
            "player_ended_war_this_turn=" .. bool_number(safe_value(false, function() return player:ended_war_this_turn() end)),
            "ai_started_war_this_turn=" .. bool_number(safe_value(false, function() return interlocutor:started_war_this_turn() end)),
            "ai_ended_war_this_turn=" .. bool_number(safe_value(false, function() return interlocutor:ended_war_this_turn() end)),
            "player_recent_diplomacy=" .. clean_value(string.gsub(cm:get_saved_value(diplomacy_history_key(player:name())) or "none", ";", ":")),
            "ai_recent_diplomacy=" .. clean_value(string.gsub(cm:get_saved_value(diplomacy_history_key(interlocutor:name())) or "none", ";", ":")),
            "ai_leader=" .. ai_leader.name,
            "ai_leader_subtype=" .. ai_leader.subtype,
            "ai_leader_rank=" .. tostring(ai_leader.rank),
            "ai_leader_unique=" .. bool_number(ai_leader.unique),
            "ai_leader_immortal=" .. bool_number(ai_leader.immortal),
            "ai_leader_male=" .. bool_number(ai_leader.male),
            "ai_leader_traits=" .. ai_leader.traits,
            "ai_leader_battles=" .. tostring(ai_leader.battles),
            "ai_leader_victories=" .. tostring(ai_leader.victories),
            "ai_leader_region=" .. ai_leader.region,
            "ai_leader_title=" .. ai_leader.subtype_title,
            "ai_leader_description=" .. ai_leader.subtype_description,
            "ai_vanilla_personality=" .. clean_value(ui_personality or "unknown"),
            "ai_culture=" .. clean_value(interlocutor:culture()),
            "ai_subculture=" .. clean_value(interlocutor:subculture()),
            "ai_wars=" .. tostring(interlocutor:factions_at_war_with():num_items()),
            -- Las preferencias del juego pueden estar en blanco (idioma por defecto de Steam),
            -- asi que el companion no puede deducirlo: se lo decimos desde dentro del juego.
            "ui_language=" .. clean_value((llmdip_game_language and llmdip_game_language()) or "unknown")
        }, ",")
    end)
    return ok and value or "turn=0,snapshot_unavailable=1"
end

local function emit_chunks(kind, request_id, payload)
    local pieces = chunk(percent_encode(payload), 140)
    if #pieces > 80 then out("[LLMDIP] payload rejected: too many chunks") return false end
    for i = 1, #pieces do
        local event = table.concat({PREFIX, kind, request_id, tostring(i), tostring(#pieces), pieces[i]}, "|")
        -- Diplomacy pauses campaign time. cm:callback therefore never fires
        -- while this UI is open; the bridge must use wall-clock callbacks.
        cm:real_callback(function()
            local delivered = broadcast(event)
            out("[LLMDIP] CHUNK|" .. kind .. "|" .. request_id .. "|" .. tostring(i) .. "/" .. tostring(#pieces) .. "|" .. tostring(delivered))
        end, (i - 1) * 120)
    end
    return true
end

local function contact_key(player_key) return "llmdip_contacts_" .. player_key end
local function contact_blob(player_key) return cm:get_saved_value(contact_key(player_key)) or "," end
-- WH3's campaign string.find is a native replacement, NOT standard Lua's
-- four-argument function. A fourth boolean poisons its shared argument reader:
-- string.sub/type checks then fail and SettlementSelected can crash in C++.
-- Keys contain only a-z/0-9/underscore; these tokens need no pattern escaping.
local function contact_enabled(player_key, ai_key) return string.find(contact_blob(player_key), "," .. ai_key .. ",", 1) ~= nil end

function llmdip_is_contact_enabled(ai_key)
    local player = local_faction()
    return player and not player:is_null_interface() and valid_key(ai_key) and contact_enabled(player:name(), ai_key)
end

local function set_contact(player_key, ai_key)
    local blob, token = contact_blob(player_key), "," .. ai_key .. ","
    if string.find(blob, token, 1) then
        blob = string.gsub(blob, token, ",", 1)
        out("[LLMDIP] CONTACT_REMOVED|" .. player_key .. "|" .. ai_key)
    else
        blob = blob .. ai_key .. ","
        out("[LLMDIP] CONTACT_ADDED|" .. player_key .. "|" .. ai_key)
    end
    cm:set_saved_value(contact_key(player_key), blob)
    if llmdip_mail_contacts_changed then llmdip_mail_contacts_changed() end
end

local function tracked_diplomacy_faction(faction)
    if not faction or faction:is_null_interface() then return false end
    if faction:is_human() then return true end
    local humans = cm:get_human_factions()
    for i = 1, #humans do
        if contact_enabled(humans[i], faction:name()) then return true end
    end
    return false
end

local function diplomatic_parties(context)
    local proposer = safe_value(nil, function() return context:proposer() end)
    local recipient = safe_value(nil, function() return context:recipient() end)
    return proposer, recipient
end

core:remove_listener("llmdip_positive_diplomacy_history")
core:add_listener("llmdip_positive_diplomacy_history", "PositiveDiplomaticEvent", function(context)
    local proposer, recipient = diplomatic_parties(context)
    return tracked_diplomacy_faction(proposer) or tracked_diplomacy_faction(recipient)
end, function(context)
    local proposer, recipient = diplomatic_parties(context)
    record_diplomatic_event(positive_event_kind(context), proposer, recipient)
end, true)

core:remove_listener("llmdip_negative_diplomacy_history")
core:add_listener("llmdip_negative_diplomacy_history", "NegativeDiplomaticEvent", function(context)
    local proposer, recipient = diplomatic_parties(context)
    return tracked_diplomacy_faction(proposer) or tracked_diplomacy_faction(recipient)
end, function(context)
    local proposer, recipient = diplomatic_parties(context)
    record_diplomatic_event(negative_event_kind(context), proposer, recipient)
end, true)

core:remove_listener("llmdip_rejected_diplomacy_history")
core:add_listener("llmdip_rejected_diplomacy_history", "DiplomaticOfferRejected", function(context)
    local proposer, recipient = diplomatic_parties(context)
    return tracked_diplomacy_faction(proposer) or tracked_diplomacy_faction(recipient)
end, function(context)
    local proposer, recipient = diplomatic_parties(context)
    record_diplomatic_event("offer_rejected", proposer, recipient)
end, true)

local function faction_from_cqi(cqi)
    local humans = cm:get_human_factions()
    for i = 1, #humans do
        local faction = cm:get_faction(humans[i])
        if faction and not faction:is_null_interface() and faction:command_queue_index() == cqi then return faction end
    end
    return nil
end

local function new_request(player, interlocutor, mode, seed, ui_attitude, ui_personality, regenerate_of)
    out("[LLMDIP] REQUEST_PREPARE|" .. tostring(mode) .. "|" .. interlocutor:name())
    if not campaign_id or not valid_key(campaign_id) then out("[LLMDIP] NEED_CAMPAIGN_ID") return false end
    request_serial = request_serial + 1
    local request_id = "r" .. tostring(cm:model():turn_number()) .. "_" .. tostring(player:command_queue_index()) .. "_" .. tostring(os.time()) .. "_" .. runtime_nonce .. "_" .. tostring(request_serial)
    -- The head lives inside the WH3 save. Every request becomes a node whose
    -- parent is the exact conversation head stored by that save. Loading an
    -- older save therefore restores an older parent instead of leaking later
    -- conversations from the companion's files into the LLM context.
    local memory_key = "llmdip_memory_head_" .. player:name()
    local memory_parent = cm:get_saved_value(memory_key) or "root"
    if not valid_key(memory_parent) then memory_parent = "root" end
    cm:set_saved_value(memory_key, request_id)
    local state = campaign_snapshot(player, interlocutor, ui_attitude, ui_personality, memory_parent, request_id)
    -- A redone reply names the request it replaces, so the companion drops the old one.
    if valid_key(regenerate_of) then state = state .. ",regenerate_of=" .. regenerate_of end
    if mode == "player" then cm:set_saved_value("llmdip_last_player_request_" .. player:name() .. "_" .. interlocutor:name(), request_id) end
    pending[request_id] = {player = player:name(), interlocutor = interlocutor:name(), sender_cqi = player:command_queue_index()}
    local proposal = pending[request_id]
    proposal.mode = mode; proposal.turn = cm:model():turn_number()
    proposal.leader = leader_identity(interlocutor).name
    proposal.faction_name = localised_value("factions_screen_name_" .. interlocutor:name())
    if mode == "player" then
        for id, older in pairs(pending) do
            if id ~= request_id and older.interlocutor == interlocutor:name() then
                pending[id] = nil
                if llmdip_mail_supersede then llmdip_mail_supersede(id) end
            end
        end
    end
    save_pending()
    if mode == "proactive" then cm:set_saved_value("llmdip_last_" .. player:name() .. "_" .. interlocutor:name(), cm:model():turn_number()) end
    -- Local Player2 companion tails script_log directly. Do not round-trip the
    -- request through UITrigger: that queue stops advancing while diplomacy
    -- pauses the campaign.
    out("[LLMDIP] REQUEST|" .. request_id .. "|" .. campaign_id .. "|" .. player:name() .. "|" .. interlocutor:name() .. "|" .. mode .. "|" .. percent_encode(state) .. "|" .. percent_encode(seed))
    return true
end

function llmdip_send_request(interlocutor_key, player_text, ui_attitude, ui_personality)
    if not player_phase then return false end
    if not valid_key(interlocutor_key) or type(player_text) ~= "string" or #player_text < 1 or #player_text > 1200 then
        out("[LLMDIP] SEND_REJECT|invalid_input|" .. tostring(interlocutor_key)); return false
    end
    local sender, interlocutor = local_faction(), cm:get_faction(interlocutor_key)
    if not sender or sender:is_null_interface() then out("[LLMDIP] SEND_REJECT|invalid_sender|" .. interlocutor_key); return false end
    if not interlocutor or interlocutor:is_null_interface() then out("[LLMDIP] SEND_REJECT|missing_target|" .. interlocutor_key); return false end
    if interlocutor:is_human() then out("[LLMDIP] SEND_REJECT|human_target|" .. interlocutor_key); return false end
    if interlocutor:is_dead() then out("[LLMDIP] SEND_REJECT|dead_target|" .. interlocutor_key); return false end
    local sent = new_request(sender, interlocutor, "player", player_text, ui_attitude, ui_personality)
    out("[LLMDIP] SEND_RESULT|" .. interlocutor_key .. "|" .. tostring(sent))
    return sent
end

-- The player can ask for a reply to be redone when the model wrote nonsense. Only the
-- latest reply to the player's own words qualifies; background letters never do, and the
-- UI refuses once a deal from that reply was carried out. The relation change that reply
-- applied this turn is taken back first.
local function undo_relation(player, ai, applied)
    applied = tonumber(applied) or 0
    if applied == 0 then return 0 end
    local key = "llmdip_relation_" .. player:name() .. "_" .. ai:name()
    local saved = split(cm:get_saved_value(key) or "-1,0", ",")
    local turn = cm:model():turn_number()
    if tonumber(saved[1]) ~= turn then return 0 end
    cm:set_saved_value(key, tostring(turn) .. "," .. tostring((tonumber(saved[2]) or 0) - applied))
    cm:apply_dilemma_diplomatic_bonus(player:name(), ai:name(), -applied)
    out("[LLMDIP] RELATION_UNDONE|" .. player:name() .. "|" .. ai:name() .. "|" .. tostring(-applied))
    return -applied
end

function llmdip_regenerate(interlocutor_key, previous_id, player_text, applied_delta, ui_attitude, ui_personality)
    if not player_phase then return false end
    -- previous_id is nil for replies saved before redo existed; they are resent without one.
    if not valid_key(interlocutor_key) or (previous_id ~= nil and not valid_key(previous_id)) or type(player_text) ~= "string" or #player_text < 1 or #player_text > 1200 then return false end
    local sender, interlocutor = local_faction(), cm:get_faction(interlocutor_key)
    if not sender or sender:is_null_interface() or not interlocutor or interlocutor:is_null_interface() or interlocutor:is_human() or interlocutor:is_dead() then return false end
    local latest = cm:get_saved_value("llmdip_last_player_request_" .. sender:name() .. "_" .. interlocutor_key)
    -- Saves from before this feature have no record; the UI already checked the history.
    if previous_id and latest and latest ~= previous_id then out("[LLMDIP] REGENERATE_REJECT|not_latest|" .. previous_id); return false end
    if previous_id and pending[previous_id] then
        pending[previous_id] = nil; save_pending()
        if llmdip_mail_supersede then llmdip_mail_supersede(previous_id) end
    end
    undo_relation(sender, interlocutor, applied_delta)
    local sent = new_request(sender, interlocutor, "player", player_text, ui_attitude, ui_personality, previous_id)
    out("[LLMDIP] REGENERATE|" .. tostring(previous_id) .. "|" .. tostring(sent))
    return sent
end

function llmdip_publish_response(request_id, narrative, compact_action, relation_delta, relation_reason)
    if not player_phase then return false end
    if published[request_id] then out("[LLMDIP] RESPONSE_ACK|" .. request_id); return false end
    relation_delta = tonumber(relation_delta)
    if published[request_id] or not valid_key(request_id) or type(narrative) ~= "string" or type(compact_action) ~= "string" then return false end
    if not relation_delta or math.floor(relation_delta) ~= relation_delta or relation_delta < -1 or relation_delta > 1 or not valid_relation_reason(relation_reason) then return false end
    if #narrative > 2400 or #compact_action > 220 then return false end
    local proposal = pending[request_id]
    if not proposal then
        -- A stale inbox can survive a campaign reload. Mark it consumed so the
        -- real-time poller does not print the same harmless rejection forever.
        published[request_id] = true
        out("[LLMDIP] RESPONSE_REJECT|missing_request|" .. request_id)
        return false
    end
    published[request_id] = true
    if proposal.mode == "proactive" then relation_delta = 0; relation_reason = "neutral" end
    proposal.action = split(compact_action, ",")
    proposal.relation_delta = relation_delta
    proposal.relation_reason = relation_reason
    save_pending()
    out("[LLMDIP] RESPONSE|" .. request_id .. "|" .. narrative)
    if llmdip_ui_on_response then llmdip_ui_on_response(request_id, narrative, proposal.interlocutor) end
    -- A betrayal is the only action that is not a proposal: it happens at once.
    -- The companion only grants it in background letters; anything else is a plain letter.
    if proposal.action[1] == "betray_war" then
        if proposal.mode == "proactive" then return execute_betrayal(request_id, proposal, narrative) end
        proposal.action = {"reject"}; compact_action = "reject"
    end
    -- A verbal rejection changes relations immediately. For a real deal, the
    -- credibility change only becomes real after the player fulfils it.
    local deferred = proposal.action[1] ~= "reject"
    local applied_delta = deferred and 0 or apply_relation_reaction(proposal, relation_delta, relation_reason)
    if type(applied_delta) ~= "number" then applied_delta = 0 end
    local shown_delta = deferred and relation_delta or applied_delta
    out("[LLMDIP] PROPOSAL|" .. request_id .. "|" .. compact_action .. "|" .. tostring(shown_delta) .. "|" .. relation_reason .. "|" .. (deferred and "deferred" or "applied"))
    if llmdip_ui_on_proposal then llmdip_ui_on_proposal(request_id, compact_action, shown_delta, relation_reason, proposal.interlocutor, deferred) end
    if proposal.mode == "proactive" and llmdip_mail_receive then
        -- A delayed letter arriving next turn consumes that turn's opportunity,
        -- so the same ruler cannot deliver old + new letters in one player turn.
        cm:set_saved_value("llmdip_last_" .. proposal.player .. "_" .. proposal.interlocutor, cm:model():turn_number())
        llmdip_mail_receive(request_id, proposal, narrative, compact_action)
    end
    return true
end

function llmdip_no_contact(request_id)
    if not player_phase or not valid_key(request_id) then return false end
    if not pending[request_id] then out("[LLMDIP] RESPONSE_ACK|" .. request_id); return false end
    local proposal = pending[request_id]
    pending[request_id] = nil; published[request_id] = true; save_pending()
    if llmdip_mail_finished then llmdip_mail_finished(request_id) end
    out("[LLMDIP] NO_CONTACT|" .. request_id)
    return true
end

function llmdip_request_failed(request_id)
    if not player_phase then return false end
    if not pending[request_id] then return llmdip_no_contact(request_id) end
    local proposal = pending[request_id]
    if proposal.mode == "player" and llmdip_ui_on_response then
        llmdip_ui_on_response(request_id, llmdip_t("no_response"), proposal.interlocutor)
    end
    return llmdip_no_contact(request_id)
end

-- Compatibility with inbox files generated before the Player2 provider correction.
llmdip_host_publish_response = llmdip_publish_response

function llmdip_accept(request_id)
    if not player_phase then return false end
    if not valid_key(request_id) then return false end
    local proposal = pending[request_id]
    if not proposal or not proposal.action then return false end
    if proposal.mode == "proactive" and cm:model():turn_number() > proposal.turn + 2 then
        pending[request_id] = nil; save_pending(); return false
    end
    local ok = execute_action(proposal)
    if ok and proposal.action[1] ~= "reject" then
        record_diplomatic_event("llm_deal_" .. proposal.action[1], cm:get_faction(proposal.player), cm:get_faction(proposal.interlocutor))
    end
    local applied_delta = 0
    if ok and proposal.action[1] ~= "reject" then applied_delta = apply_relation_reaction(proposal, proposal.relation_delta or 0, proposal.relation_reason or "neutral") or 0 end
    out("[LLMDIP] EXECUTED|" .. request_id .. "|" .. tostring(ok))
    if llmdip_ui_on_executed then llmdip_ui_on_executed(request_id, ok, applied_delta, proposal.relation_reason or "neutral") end
    pending[request_id] = nil
    save_pending()
    if llmdip_mail_supersede then llmdip_mail_supersede(request_id) end
    return ok
end

-- The player turns an offer down from the proposal card. Until now a pending
-- offer just waited to be superseded or to expire. Nothing is executed, but
-- the save records it like vanilla's offer_rejected (proposer first), so the
-- lord's later prompts know the offer was refused.
function llmdip_decline(request_id)
    if not player_phase then return false end
    if not valid_key(request_id) then return false end
    local proposal = pending[request_id]
    if not proposal or not proposal.action or proposal.action[1] == "reject" then return false end
    record_diplomatic_event("llm_offer_declined", cm:get_faction(proposal.interlocutor), cm:get_faction(proposal.player))
    out("[LLMDIP] DECLINED|" .. request_id)
    pending[request_id] = nil
    save_pending()
    if llmdip_mail_supersede then llmdip_mail_supersede(request_id) end
    return true
end

function llmdip_external_initialize(nonce, id)
    if not valid_key(nonce) or consumed_external[nonce] or not valid_key(id) then return false end
    consumed_external[nonce] = true
    campaign_id = id; cm:set_saved_value("llmdip_campaign_id", id); out("[LLMDIP] CAMPAIGN_ID|" .. id)
    return true
end

function llmdip_external_send(nonce, interlocutor_key, player_text)
    if not valid_key(nonce) or consumed_external[nonce] then return false end
    consumed_external[nonce] = true
    return llmdip_send_request(interlocutor_key, player_text)
end

function llmdip_external_accept(nonce, request_id)
    if not valid_key(nonce) or consumed_external[nonce] then return false end
    consumed_external[nonce] = true
    return llmdip_accept(request_id)
end

function llmdip_external_toggle_contact(nonce, ai_key)
    if not valid_key(nonce) or consumed_external[nonce] or not valid_key(ai_key) then return false end
    consumed_external[nonce] = true
    return broadcast(table.concat({PREFIX, "T", ai_key}, "|"))
end

function llmdip_toggle_contact(ai_key)
    if not valid_key(ai_key) then return false end
    return broadcast(table.concat({PREFIX, "T", ai_key}, "|"))
end

local function transfer_gold(source, target, amount)
    amount = tonumber(amount)
    if not amount or amount < 100 or amount > 20000 or math.floor(amount) ~= amount or source:treasury() < amount then return false end
    local source_before, target_before = source:treasury(), target:treasury()
    cm:treasury_mod(source:name(), -amount)
    cm:treasury_mod(target:name(), amount)
    out("[LLMDIP] GOLD_TRANSFER|" .. source:name() .. "|" .. tostring(source_before) .. "|" .. tostring(source:treasury()) .. "|" .. target:name() .. "|" .. tostring(target_before) .. "|" .. tostring(target:treasury()) .. "|" .. tostring(amount))
    return true
end

execute_action = function(proposal)
    local player, ai = cm:get_faction(proposal.player), cm:get_faction(proposal.interlocutor)
    local action = proposal.action
    if not player or player:is_null_interface() or not player:is_human() or not ai or ai:is_null_interface() or ai:is_human() then return false end
    if action[1] == "reject" then return true
    elseif action[1] == "declare_war" then cm:force_declare_war(ai:name(), player:name(), false, false)
    elseif action[1] == "make_peace" then cm:force_make_peace(ai:name(), player:name())
    elseif action[1] == "alliance" and (action[2] == "defensive" or action[2] == "military") then cm:force_alliance(ai:name(), player:name(), action[2] == "military")
    elseif action[1] == "trade_agreement" then cm:force_make_trade_agreement(ai:name(), player:name())
    elseif action[1] == "non_aggression_pact" then cm:force_non_aggression_pact(ai:name(), player:name())
    elseif action[1] == "military_access" then
        if action[2] == "interlocutor_to_player" or action[2] == "mutual" then cm:force_grant_military_access(ai:name(), player:name(), false) end
        if action[2] == "player_to_interlocutor" or action[2] == "mutual" then cm:force_grant_military_access(player:name(), ai:name(), false) end
    elseif action[1] == "transfer_region" and valid_key(action[2]) then
        local recipient = action[3] == "player" and player:name() or (action[3] == "interlocutor" and ai:name() or nil)
        local region = cm:get_region(action[2])
        if not recipient or not region or region:is_null_interface() then return false end
        local owner = region:owning_faction():name()
        if owner ~= player:name() and owner ~= ai:name() then return false end
        cm:transfer_region_to_faction(action[2], recipient)
    elseif action[1] == "vassalize" then
        if action[2] == "player" then cm:force_make_vassal(player:name(), ai:name())
        elseif action[2] == "interlocutor" then cm:force_make_vassal(ai:name(), player:name()) else return false end
    elseif action[1] == "offer_gold" then return transfer_gold(ai, player, tonumber(action[2]))
    elseif action[1] == "request_gold" then return transfer_gold(player, ai, tonumber(action[2]))
    elseif action[1] == "favor" then
        local war_target = nil
        if action[2] == "join_war" then
            if not valid_key(action[4]) then return false end
            war_target = cm:get_faction(action[4])
            if not war_target or war_target:is_null_interface() or war_target:is_human() or war_target:name() == player:name() or war_target:name() == ai:name() then return false end
        end
        if not transfer_gold(ai, player, tonumber(action[3])) then return false end
        cm:set_saved_value("llmdip_favor_" .. player:name() .. "_" .. ai:name(), table.concat({action[2] or "unknown", action[4] or "none", tostring(cm:model():turn_number()), "open"}, ","))
        if war_target then cm:force_declare_war(player:name(), war_target:name(), false, false) end
    else return false end
    return true
end

execute_betrayal = function(request_id, proposal, narrative)
    local player, ai = cm:get_faction(proposal.player), cm:get_faction(proposal.interlocutor)
    local ok = player and not player:is_null_interface() and player:is_human()
        and ai and not ai:is_null_interface() and not ai:is_human() and not ai:is_dead()
        and not ai:at_war_with(player)
    ok = ok and true or false
    if ok then
        cm:force_declare_war(ai:name(), player:name(), false, false)
        record_diplomatic_event("llm_betrayal", ai, player)
    end
    out("[LLMDIP] BETRAYAL|" .. request_id .. "|" .. proposal.interlocutor .. "|" .. tostring(ok))
    out("[LLMDIP] EXECUTED|" .. request_id .. "|" .. tostring(ok))
    if llmdip_ui_on_betrayal then llmdip_ui_on_betrayal(request_id, proposal.interlocutor, ok) end
    pending[request_id] = nil
    save_pending()
    if llmdip_mail_receive then
        cm:set_saved_value("llmdip_last_" .. proposal.player .. "_" .. proposal.interlocutor, cm:model():turn_number())
        llmdip_mail_receive(request_id, proposal, narrative, ok and "betray_war" or "reject")
    end
    return ok
end

apply_relation_reaction = function(proposal, delta, reason)
    delta = tonumber(delta)
    if not delta or math.floor(delta) ~= delta or delta < -1 or delta > 1 or not valid_relation_reason(reason) then return false end
    local player, ai = cm:get_faction(proposal.player), cm:get_faction(proposal.interlocutor)
    if not player or player:is_null_interface() or not player:is_human() or not ai or ai:is_null_interface() or ai:is_human() then return false end
    local turn = cm:model():turn_number()
    local key = "llmdip_relation_" .. player:name() .. "_" .. ai:name()
    local saved = split(cm:get_saved_value(key) or "-1,0", ",")
    local used = tonumber(saved[1]) == turn and tonumber(saved[2]) or 0
    local desired = math.max(-2, math.min(2, used + delta))
    local applied = desired - used
    cm:set_saved_value(key, tostring(turn) .. "," .. tostring(desired))
    if applied ~= 0 then cm:apply_dilemma_diplomatic_bonus(player:name(), ai:name(), applied) end
    out("[LLMDIP] RELATION|" .. proposal.player .. "|" .. proposal.interlocutor .. "|" .. tostring(applied) .. "|" .. reason)
    return applied
end

local function receive_chunk(store, parts)
    local id, index, total, payload = parts[3], tonumber(parts[4]), tonumber(parts[5]), parts[6]
    if not valid_key(id) or not index or not total or total < 1 or total > 80 or index < 1 or index > total then return nil end
    store[id] = store[id] or {total = total, parts = {}}
    if store[id].total ~= total then store[id] = nil return nil end
    store[id].parts[index] = payload
    for i = 1, total do if not store[id].parts[i] then return nil end end
    local complete = percent_decode(table.concat(store[id].parts, ""))
    store[id] = nil
    return complete
end

core:add_listener("llmdip_mp_events", "UITrigger", function(context) return string.sub(context:trigger(), 1, #PREFIX + 1) == PREFIX .. "|" end, function(context)
    local parts, kind, id = split(context:trigger(), "|"), nil, nil
    kind, id = parts[2], parts[3]
    if kind == "I" and valid_key(id) then
        campaign_id = id; cm:set_saved_value("llmdip_campaign_id", id); out("[LLMDIP] CAMPAIGN_ID|" .. id)
    elseif kind == "T" and valid_key(id) then
        local player = faction_from_cqi(context:faction_cqi())
        local ai = cm:get_faction(id)
        if player and ai and not ai:is_null_interface() and not ai:is_human() then set_contact(player:name(), id) end
    elseif kind == "Q" then
        local complete = receive_chunk(request_chunks, parts)
        if complete then
            local fields = split(complete, ";")
            if #fields == 6 and valid_key(fields[1]) and valid_key(fields[2]) and valid_key(fields[3]) and (fields[4] == "player" or fields[4] == "proactive") then
                local state, message = percent_decode(fields[5]), percent_decode(fields[6])
                pending[id] = {player = fields[1], interlocutor = fields[2], sender_cqi = context:faction_cqi()}
                if fields[4] == "proactive" then cm:set_saved_value("llmdip_last_" .. fields[1] .. "_" .. fields[2], cm:model():turn_number()) end
                out("[LLMDIP] REQUEST|" .. id .. "|" .. fields[3] .. "|" .. fields[1] .. "|" .. fields[2] .. "|" .. fields[4] .. "|" .. percent_encode(state) .. "|" .. percent_encode(message))
            end
        end
    elseif kind == "R" then
        local complete = receive_chunk(response_chunks, parts)
        if complete then
            out("[LLMDIP] RESPONSE|" .. id .. "|" .. complete)
            if llmdip_ui_on_response and pending[id] then llmdip_ui_on_response(id, complete, pending[id].interlocutor) end
        end
    elseif kind == "P" and pending[id] then
        pending[id].action = split(parts[4] or "", ",")
        pending[id].relation_delta = tonumber(parts[5]) or 0
        pending[id].relation_reason = parts[6] or "neutral"
        local deferred = pending[id].action[1] ~= "reject"
        local applied_delta = deferred and 0 or (apply_relation_reaction(pending[id], parts[5], parts[6]) or 0)
        local shown_delta = deferred and pending[id].relation_delta or applied_delta
        out("[LLMDIP] PROPOSAL|" .. id .. "|" .. (parts[4] or "") .. "|" .. tostring(shown_delta) .. "|" .. pending[id].relation_reason .. "|" .. (deferred and "deferred" or "applied"))
        if llmdip_ui_on_proposal then llmdip_ui_on_proposal(id, parts[4] or "reject", shown_delta, pending[id].relation_reason, pending[id].interlocutor, deferred) end
    elseif kind == "A" and pending[id] and pending[id].action and pending[id].sender_cqi == context:faction_cqi() then
        local ok = execute_action(pending[id])
        if ok and pending[id].action[1] ~= "reject" then
            record_diplomatic_event("llm_deal_" .. pending[id].action[1], cm:get_faction(pending[id].player), cm:get_faction(pending[id].interlocutor))
        end
        local applied_delta = 0
        if ok and pending[id].action[1] ~= "reject" then applied_delta = apply_relation_reaction(pending[id], pending[id].relation_delta or 0, pending[id].relation_reason or "neutral") or 0 end
        out("[LLMDIP] EXECUTED|" .. id .. "|" .. tostring(ok))
        if llmdip_ui_on_executed then llmdip_ui_on_executed(id, ok, applied_delta, pending[id].relation_reason or "neutral") end
        pending[id] = nil
    end
end, true)

local function initiative_score(player, ai)
    local score = 0
    if ai:at_war_with(player) then score = score + 100 end
    if ai:allied_with(player) then score = score + 25 end
    if ai:region_list():num_items() <= 2 then score = score + 55 end
    if ai:factions_at_war_with():num_items() >= 2 then score = score + 35 end
    if ai:treasury() < 2000 then score = score + 15 end
    if total_force_strength(ai) * 4 < total_force_strength(player) * 3 then score = score + 30 end
    if model_attitude_value(ai, player) > 75 then score = score + 20 end
    return score
end

function llmdip_mail_request(excluded)
    if not player_phase or not campaign_id or menu_open or cm:is_multiplayer() then return false end
    if cm:is_processing_battle() or cm:is_pending_battle_active() then return false end
    -- Only one unfinished background generation at a time. A completed proposal
    -- does not block other letters; the player remains free to ignore it.
    for _, proposal in pairs(pending) do
        if not proposal.action then return false end
    end
    local player, best, best_score = local_faction(), nil, -1
    local met = player:factions_met()
    for i = 0, met:num_items() - 1 do
        local ai = met:item_at(i)
        if not ai:is_human() and not ai:is_dead() and not excluded[ai:name()] and contact_enabled(player:name(), ai:name()) then
            local last = tonumber(cm:get_saved_value("llmdip_last_" .. player:name() .. "_" .. ai:name()) or -999)
            if cm:model():turn_number() - last >= COOLDOWN_TURNS then
                -- Fair rotation: social letters need not compete against wars.
                -- Avoid rescanning every army merely to choose the next sender.
                local score = cm:model():turn_number() - last
                if score > best_score then best, best_score = ai, score end
            end
        end
    end
    if best then
        cm:set_saved_value("llmdip_last_" .. player:name() .. "_" .. best:name(), cm:model():turn_number())
        local sent = new_request(player, best, "proactive", "You may send one brief personal letter this turn. Speak as the current lord, not an abstract faction. A social or emotional motive is sufficient: warmth, admiration, vanity, rivalry, spite, ambition, concern, generosity or self-interest, grounded in identity, attitude and saved history. A treaty is NOT required. Prefer a fresh, specific personal message when appropriate; otherwise return [NO_CONTACT]. Avoid repeating greetings, demands or gifts. Write 30-80 words. The player has not spoken and may ignore you; silence is not rejection or consent. Propose transfers only with supported tags; never claim they already happened.")
        return sent and best:name() or false
    end
    return false, true -- Completed selection: no eligible contacts this round.
end

local function destroy_menu()
    for i = 1, #menu_components do pcall(function() menu_components[i]:Destroy() end) end
    menu_components, menu_open = {}, false
end

local function make_button(id, text, x, y, width)
    local ok, component = pcall(function()
        local root = core:get_ui_root()
        local uic = core:get_or_create_component(id, "ui/templates/square_medium_text_button", root)
        uic:SetCanResizeWidth(true); uic:SetCanResizeHeight(true); uic:Resize(width or 360, 34)
        uic:SetDockingPoint(1); uic:SetDockOffset(x, y)
        uic:PropagatePriority(200); uic:SetInteractive(true)
        local label = find_uicomponent(uic, "button_txt")
        if label then label:SetStateText(text); label:SetInteractive(false) end
        uic:SetVisible(true)
        return uic
    end)
    if ok and component then menu_components[#menu_components + 1] = component return component end
    return nil
end

local race_names = {
    wh_main_sc_brt_bretonnia="Bretonia", wh_main_sc_chs_chaos="Guerreros del Caos",
    wh_main_sc_dwf_dwarfs="Enanos", wh_main_sc_emp_empire="El Imperio",
    wh_main_sc_grn_greenskins="Pieles Verdes", wh_main_sc_grn_savage_orcs="Orcos salvajes",
    wh_main_sc_nor_norsca="Norsca", wh_main_sc_vmp_vampire_counts="Condes Vampiro",
    wh_dlc03_sc_bst_beastmen="Hombres Bestia", wh_dlc05_sc_wef_wood_elves="Elfos Silvanos",
    wh2_main_sc_def_dark_elves="Elfos Oscuros", wh2_main_sc_hef_high_elves="Altos Elfos",
    wh2_main_sc_lzd_lizardmen="Hombres Lagarto", wh2_main_sc_skv_skaven="Skaven",
    wh2_dlc09_sc_tmb_tomb_kings="Reyes Funerarios", wh2_dlc11_sc_cst_vampire_coast="Costa del Vampiro",
    wh3_main_sc_cth_cathay="Gran Catay", wh3_main_sc_ksl_kislev="Kislev",
    wh3_main_sc_ogr_ogre_kingdoms="Reinos Ogros", wh3_main_sc_kho_khorne="Khorne",
    wh3_main_sc_nur_nurgle="Nurgle", wh3_main_sc_sla_slaanesh="Slaanesh",
    wh3_main_sc_tze_tzeentch="Tzeentch", wh3_main_sc_dae_daemons="Demonios del Caos",
    wh3_dlc23_sc_chd_chaos_dwarfs="Enanos del Caos", unknown="Otras razas"
}
local function contact_race(faction)
    local ok, key = pcall(function() return faction:subculture() end)
    if not ok or not valid_key(key) then return "unknown", llmdip_t("other_races") end
    -- El juego ya traduce los nombres de raza a sus 13 idiomas, con la terminologia
    -- oficial de CA. La clave real es cultures_subcultures_name_<raza> (comprobado en
    -- sus packs de localizacion). La tabla de abajo solo cubre que no resuelva, y las
    -- razas moddeadas sin traduccion caen al key.
    local loc_key = "cultures_subcultures_name_" .. key
    local name = localised_value(loc_key)
    if name == loc_key or name == "" then name = race_names[key] end
    if not name then name = string.gsub(key, "_", " ") end
    return key, name
end

local function show_contact_menu()
    destroy_menu(); menu_open = true
    local player = local_faction()
    -- Keep the filter list beside the left diplomacy portrait, not across it.
    local x, y, width, per_page = 270, 170, 325, 8
    make_button("llmdip_close", llmdip_t("menu_close"), x, y, width)
    local met, candidates, groups = player:factions_met(), {}, {}
    for i = 0, met:num_items() - 1 do
        local faction = met:item_at(i)
        if not faction:is_human() and not faction:is_dead() then
            local key = faction:name()
            local name = localised_value("factions_screen_name_" .. key)
            if name == "factions_screen_name_" .. key or name == "" then name = key end
            local race, race_name = contact_race(faction)
            local group = groups[race] or {key=race, name=race_name, count=0, enabled=0}
            group.count = group.count + 1
            if contact_enabled(player:name(), key) then group.enabled = group.enabled + 1 end
            groups[race] = group
            if menu_race == "all" or menu_race == race then
                candidates[#candidates + 1] = {key=key, name=name}
            end
        end
    end
    if not menu_race then
        for _, group in pairs(groups) do candidates[#candidates + 1] = group end
        make_button("llmdip_all_races", llmdip_t("see_all_factions"), x, y + 42, width)
    else
        make_button("llmdip_races_back", llmdip_t("back_to_races"), x, y + 42, width)
    end
    table.sort(candidates, function(a,b) if a.name == b.name then return a.key < b.key end return a.name < b.name end)
    local pages = math.max(1, math.ceil(#candidates / per_page))
    menu_page = math.max(1, math.min(menu_page, pages))
    local title = not menu_race and llmdip_t("races") or (menu_race == "all" and llmdip_t("all_factions") or (groups[menu_race] and groups[menu_race].name or llmdip_t("no_factions")))
    local heading = make_button("llmdip_filter_title", title .. " — " .. menu_page .. "/" .. pages, x, y + 84, width)
    if heading then heading:SetInteractive(false) end
    local first = (menu_page - 1) * per_page + 1
    for i = first, math.min(#candidates, first + per_page - 1) do
        local key, name = candidates[i].key, candidates[i].name
        if not menu_race then
            local group = candidates[i]
            make_button("llmdip_race_" .. key, name .. " (" .. group.enabled .. "/" .. group.count .. llmdip_t("enabled_suffix"), x, y + 126 + 38 * (i - first), width)
        else
            local mark = contact_enabled(player:name(), key) and llmdip_t("contact_on") or llmdip_t("contact_off")
            local button = make_button("llmdip_contact_" .. key, mark .. name, x, y + 126 + 38 * (i - first), width)
            if button then button:SetTooltipText(name .. "\n" .. key, true) end
        end
    end
    if #candidates == 0 then
        local empty = make_button("llmdip_filter_empty", llmdip_t("no_known_factions"), x, y + 126, width)
        if empty then empty:SetInteractive(false) end
    end
    if first > 1 then make_button("llmdip_prev", llmdip_t("prev_page_btn"), x, y + 462, 155) end
    if first + per_page <= #candidates then make_button("llmdip_next", llmdip_t("next_page_btn"), x + 170, y + 462, 155) end
end

local function create_menu_button()
    local ok, err = pcall(function()
        local root = core:get_ui_root()
        local button = core:get_or_create_component("llmdip_menu_button", "ui/templates/square_medium_text_button", root)
        button:SetCanResizeWidth(true); button:SetCanResizeHeight(true); button:Resize(160, 36)
        button:SetDockingPoint(1); button:SetDockOffset(20, 123)
        button:PropagatePriority(200); button:SetInteractive(true)
        local label = find_uicomponent(button, "button_txt")
        if not label then error("Falta button_txt en el botón de facciones") end
        label:SetStateText(llmdip_t("ai_factions_button")); label:SetInteractive(false)
        button:SetTooltipText(llmdip_t("toggle_factions"), true); button:SetVisible(true)
        out("[LLMDIP] CONTACT_BUTTON_READY|top_left|20|123|0.39.8")
    end)
    if not ok then out("[LLMDIP] CONTACT_BUTTON_ERROR|" .. tostring(err)) end
end

core:add_listener("llmdip_ui_clicks", "ComponentLClickUp", true, function(context)
    local id = context.string
    if id == "llmdip_menu_button" then if menu_open then destroy_menu() else menu_race=nil; menu_page=1; show_contact_menu() end
    elseif id == "llmdip_close" then destroy_menu()
    elseif id == "llmdip_all_races" then menu_race="all"; menu_page=1; show_contact_menu()
    elseif id == "llmdip_races_back" then menu_race=nil; menu_page=1; show_contact_menu()
    elseif string.sub(id or "", 1, 12) == "llmdip_race_" then
        local key = string.sub(id, 13)
        if valid_key(key) then menu_race=key; menu_page=1; show_contact_menu() end
    elseif id == "llmdip_prev" then menu_page = math.max(1, menu_page - 1); show_contact_menu()
    elseif id == "llmdip_next" then menu_page = menu_page + 1; show_contact_menu()
    elseif string.sub(id or "", 1, 15) == "llmdip_contact_" then
        local ai_key = string.sub(id, 16)
        if valid_key(ai_key) then
            broadcast(table.concat({PREFIX, "T", ai_key}, "|"))
            cm:callback(function() if menu_open then show_contact_menu() end end, 0.2)
        end
    end
end, true)

local function poll_inbox()
    if not player_phase then cm:real_callback(poll_inbox, 1000); return end
    if cm:is_processing_battle() or cm:is_pending_battle_active() then cm:real_callback(poll_inbox, 1000); return end
    local loader = loadfile("exec/llm_diplomacy_inbox.lua")
    if loader then
        -- The default loadfile environment has no campaign API. core:get_env() is the
        -- documented global campaign environment used by WH3 mod script loaders.
        setfenv(loader, core:get_env())
        local ok, err = pcall(loader)
        if not ok then out("[LLMDIP] inbox error: " .. tostring(err)) end
    end
    if llmdip_mail_tick then
        local ok, err = pcall(llmdip_mail_tick)
        if not ok then out("[LLMDIP] MAIL_TICK_ERROR|" .. tostring(err)) end
    end
    -- Bilateral diplomacy pauses campaign time. A normal cm:callback stops
    -- here, leaving Player2's response unread until the player exits the
    -- screen. By then the vanilla C++ panel may already be destroyed. Poll
    -- against wall-clock time so history updates during the conversation.
    cm:real_callback(poll_inbox, 1000)
end

cm:add_first_tick_callback(function()
    pending = cm:get_saved_value("llmdip39_pending") or {}
    for id, proposal in pairs(pending) do
        if not proposal.action then pending[id] = nil else published[id] = true end
    end
    save_pending()
    player_phase = not cm:is_multiplayer() and cm:is_local_players_turn()
    cm:add_faction_turn_start_listener_by_name("llmdip39_player_start", local_faction():name(), function()
        player_phase = true
    end, true)
    core:add_listener("llmdip39_player_end", "ScriptEventPlayerFactionTurnEnd", true, function()
        player_phase = false
        if llmdip_mail_hide then llmdip_mail_hide() end
    end, true)
    campaign_id = cm:get_saved_value("llmdip_campaign_id")
    out("[LLMDIP] BUILD|0.39.8-inbox")
    out("[LLMDIP] READY|" .. tostring(cm:is_multiplayer()) .. "|" .. local_faction():name())
    if campaign_id then out("[LLMDIP] CAMPAIGN_ID|" .. campaign_id) else out("[LLMDIP] NEED_CAMPAIGN_ID") end
    create_menu_button()
    poll_inbox()
end)
