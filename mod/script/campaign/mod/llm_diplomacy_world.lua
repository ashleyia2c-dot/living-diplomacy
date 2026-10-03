-- The state of the world, phases 1-3 of docs/PLAN_ESTADO_DEL_MUNDO.md.
--
-- At the start of every player turn the game looks at the factions that matter to
-- the player, compares them with the previous turn and writes down what changed
-- (alliances, wars, conquests, rises and falls) plus a little true court gossip
-- (envy, jealousy, servility, old hatreds) taken from the same facts. Nothing here
-- changes the campaign: it only reads. The facts come from the game and the AI only
-- puts words to them, the same rule as betrayals.
--
-- Three things use the result:
--   * the World tab of the letters window (llmdip_world_entries),
--   * every conversation and letter, through two dossier fields
--     (llmdip_world_brief, read by campaign_snapshot in llm_diplomacy.lua),
--   * the log, so a real campaign can be checked turn by turn.
--
-- Everything is saved in the campaign under llmdip_world_v1, so loading an older
-- save brings back the world of that save. Every game call is protected.
setfenv(1, core:get_env())

local KEY = "llmdip_world_v1"
local MAX_ENTRIES, MAX_FACTIONS, TOP_STRONGEST = 40, 28, 12
local NEWS_PER_TURN, GOSSIP_PER_TURN, NEWS_THRESHOLD = 6, 2, 4
-- Attitude bands. The call that works (diplomatic_standing_with) is not on the scale the
-- diplomacy screen shows: the first real campaign gave -1817..588. So the bands are
-- relative to this campaign, worked out every turn from all the pairs watched: the
-- warmest 15% are friendly and the warmest 5% very friendly, the coldest likewise.
-- These fixed values are only the fallback when there are too few numbers to rank.
local DEFAULT_BANDS = {f = 50, vf = 100, h = -50, hd = -100}
local function attitude_bands(values)
    if #values < 12 then return DEFAULT_BANDS end
    table.sort(values)
    local function at(share) return values[math.max(1, math.min(#values, math.floor(#values * share + 0.5)))] end
    return {f = math.max(1, at(0.85)), vf = math.max(2, at(0.95)), h = math.min(-1, at(0.15)), hd = math.min(-2, at(0.05))}
end
local HISTORY_SCANS, TREND_SCANS = 12, 5

local world = nil
local attitude_variant = nil

local function safe(default, fn)
    local ok, value = pcall(fn)
    if ok and value ~= nil then return value end
    return default
end
local function usable(faction)
    if not faction then return false end
    if safe(true, function() return faction:is_null_interface() end) then return false end
    return not safe(true, function() return faction:is_dead() end)
end
local function clone(value)
    if type(value) ~= "table" then return value end
    local copy = {}; for k, v in pairs(value) do copy[k] = clone(v) end
    return copy
end
local function fresh() return {v = 1, turn = -1, snap = nil, e = {}, hist = {}, ah = {}, cap = {}, cd = {}, b = {},
    cr = {}, tc = {}, forced = {}, opt = {}, seen = -1} end
local function save() cm:set_saved_value(KEY, clone(world)) end
-- The player's switches, saved with the campaign. Both start ON: real AI treaties
-- (the user's choice: real consequences by default, with limits) and romance gossip.
local function option(name)
    local value = world and world.opt and world.opt[name]
    if value == nil then return true end
    return value == true
end
function llmdip_world_options() return {treaties = option("treaties"), romance = option("romance")} end
function llmdip_world_toggle(name)
    if not world or (name ~= "treaties" and name ~= "romance") then return nil end
    world.opt = world.opt or {}
    world.opt[name] = not option(name)
    -- Turning treaties off ends any talks under way: nothing gets signed later.
    if name == "treaties" and not world.opt[name] then world.cr = {} end
    save()
    out("[LLMDIP] WORLD_OPTION|" .. name .. "|" .. tostring(world.opt[name]))
    return world.opt[name]
end
local function pair_key(a, b) if a < b then return a .. "|" .. b end return b .. "|" .. a end
local function roll(max)
    if max <= 1 then return 1 end
    local value = safe(nil, function() return cm:random_number(max, 1) end)
    if type(value) == "number" and value >= 1 and value <= max then return math.floor(value) end
    return math.random(max)
end
local function skipped_key(key)
    -- Rebels, separatists and quest-battle factions are not realms anyone gossips about.
    return string.find(key, "rebel", 1) ~= nil or string.find(key, "separatist", 1) ~= nil
        or string.find(key, "_qb", 1) ~= nil or string.find(key, "_intervention", 1) ~= nil
end

-- ---------------------------------------------------------------------------
-- Reading one turn of the world
-- ---------------------------------------------------------------------------
local function strength_rank(faction)
    return safe(0, function() return cm:model():faction_strength_rank(faction) end)
end
local function army_strength(faction)
    return safe(0, function()
        local list, value = faction:military_force_list(), 0
        for i = 0, list:num_items() - 1 do
            local force = list:item_at(i)
            if not force:is_null_interface() then value = value + force:strength() end
        end
        return math.floor(value)
    end)
end

-- The attitude call has several spellings in WH3's history and some of them quietly
-- return 0. The first scan of a session tries them all on a few pairs, keeps the one
-- that gives real numbers and prints the probe, so a campaign log shows which works.
local ATTITUDE_VARIANTS = {
    {"attitude_towards_key", function(a, b) return a:diplomatic_attitude_towards(b:name()) end},
    {"standing_with_key", function(a, b) return a:diplomatic_standing_with(b:name()) end},
    {"standing_with_faction", function(a, b) return a:diplomatic_standing_with(b) end},
    {"attitude_towards_faction", function(a, b) return a:diplomatic_attitude_towards(b) end}
}
local function choose_attitude_variant(factions)
    local counts, probes = {}, 0
    for i = 1, #ATTITUDE_VARIANTS do counts[i] = 0 end
    for i = 1, #factions do
        for j = i + 1, #factions do
            if probes >= 12 then break end
            probes = probes + 1
            for v, variant in ipairs(ATTITUDE_VARIANTS) do
                local value = tonumber(safe(nil, function() return variant[2](factions[i], factions[j]) end))
                if value and value ~= 0 then counts[v] = counts[v] + 1 end
            end
        end
    end
    local best = 1
    for v = 2, #ATTITUDE_VARIANTS do if counts[v] > counts[best] then best = v end end
    attitude_variant = best
    out("[LLMDIP] WORLD_ATTITUDE|" .. ATTITUDE_VARIANTS[best][1] .. "|nonzero=" .. counts[best] .. "/" .. probes)
end
local function attitude(a, b)
    local value = tonumber(safe(nil, function() return ATTITUDE_VARIANTS[attitude_variant or 1][2](a, b) end))
    return value and math.floor(value) or 0
end

local function relevant_factions(player)
    local candidates, seen = {}, {}
    local function consider(faction, met)
        if not usable(faction) then return end
        local key = safe(nil, function() return faction:name() end)
        if not key or seen[key] or skipped_key(key) then return end
        if safe(false, function() return faction:is_human() end) then return end
        local rank = strength_rank(faction)
        if not met and (rank < 1 or rank > TOP_STRONGEST) then return end
        seen[key] = true
        local contact = met and llmdip_is_contact_enabled and safe(false, function() return llmdip_is_contact_enabled(key) end)
        candidates[#candidates + 1] = {faction = faction, key = key, rank = rank, met = met, contact = contact and true or false}
    end
    local met = safe(nil, function() return player:factions_met() end)
    if met then for i = 0, safe(0, function() return met:num_items() end) - 1 do consider(safe(nil, function() return met:item_at(i) end), true) end end
    local all = safe(nil, function() return cm:model():world():faction_list() end)
    if all then for i = 0, safe(0, function() return all:num_items() end) - 1 do consider(safe(nil, function() return all:item_at(i) end), false) end end
    -- Factions the player can hear from first, then the strongest.
    table.sort(candidates, function(x, y)
        if x.contact ~= y.contact then return x.contact end
        local rx, ry = x.rank > 0 and x.rank or 999, y.rank > 0 and y.rank or 999
        if rx ~= ry then return rx < ry end
        return x.key < y.key
    end)
    local result = {player}
    for i = 1, math.min(#candidates, MAX_FACTIONS) do result[#result + 1] = candidates[i].faction end
    return result, candidates
end

local function read_faction(faction, met_keys)
    local key = faction:name()
    local info = {r = strength_rank(faction), n = 0, s = army_strength(faction),
        sc = safe("unknown", function() return faction:subculture() end),
        h = safe(false, function() return faction:is_human() end) and 1 or nil,
        m = met_keys[key] and 1 or nil}
    local leader = safe(nil, function() return faction:faction_leader() end)
    if leader and not safe(true, function() return leader:is_null_interface() end) then
        info.l = safe(nil, function() return leader:character_subtype_key() end)
        info.fn = safe(nil, function() return leader:get_forename() end)
        info.sn = safe(nil, function() return leader:get_surname() end)
    end
    return info
end

local function read_pair(a, b)
    local p = {}
    if safe(false, function() return a:at_war_with(b) end) then p.w = 1 end
    if safe(false, function() return a:military_allies_with(b) end) then p.m = 1 end
    if safe(false, function() return a:defensive_allies_with(b) end) then p.d = 1 end
    if safe(false, function() return a:non_aggression_pact_with(b) end) then p.n = 1 end
    if safe(false, function() return a:trade_agreement_with(b) end) then p.t = 1 end
    if safe(false, function() return a:is_vassal_of(b) end) then p.v = 1
    elseif safe(false, function() return b:is_vassal_of(a) end) then p.v = 2 end
    local ab, ba = attitude(a, b), attitude(b, a)
    if a:name() > b:name() then ab, ba = ba, ab; if p.v then p.v = 3 - p.v end end
    if ab ~= 0 then p.ab = ab end
    if ba ~= 0 then p.ba = ba end
    return p
end

local function scan(player)
    local factions, candidates = relevant_factions(player)
    local met_keys = {}
    for _, c in ipairs(candidates) do if c.met then met_keys[c.key] = true end end
    local snap = {turn = cm:model():turn_number(), player = player:name(), f = {}, p = {}, o = {}}
    for _, faction in ipairs(factions) do
        local key = faction:name()
        local info = read_faction(faction, met_keys)
        local regions = safe(nil, function() return faction:region_list() end)
        local count = regions and safe(0, function() return regions:num_items() end) or 0
        for i = 0, count - 1 do
            local name = safe(nil, function() return regions:item_at(i):name() end)
            if name then snap.o[name] = key; info.n = info.n + 1 end
        end
        snap.f[key] = info
    end
    local others = {}
    for i = 2, #factions do others[#others + 1] = factions[i] end
    if not attitude_variant then choose_attitude_variant(others) end
    local low, high, values, all = 0, 0, {}, {}
    for i = 1, #factions do
        for j = i + 1, #factions do
            local p = read_pair(factions[i], factions[j])
            for _, value in ipairs({p.ab or 0, p.ba or 0}) do
                if value ~= 0 then values[#values + 1] = value end
                if value < low then low = value end
                if value > high then high = value end
            end
            all[pair_key(factions[i]:name(), factions[j]:name())] = p
        end
    end
    snap.th = attitude_bands(values)
    local th = snap.th
    for key, p in pairs(all) do
        local strong = (p.ab and (p.ab >= th.f or p.ab <= th.h)) or (p.ba and (p.ba >= th.f or p.ba <= th.h))
        if p.w or p.m or p.d or p.n or p.t or p.v or strong then snap.p[key] = p end
    end
    return snap, #factions, low, high
end

-- ---------------------------------------------------------------------------
-- Helpers over a snapshot
-- ---------------------------------------------------------------------------
local function pair(snap, a, b) return snap and snap.p[pair_key(a, b)] or nil end
local function att(snap, from, to)
    local p = pair(snap, from, to)
    if not p then return 0 end
    if from < to then return p.ab or 0 end
    return p.ba or 0
end
local function allied(p) return p and (p.m or p.d) and true or false end
local function vassal_of(snap, vassal, master)
    local p = pair(snap, vassal, master)
    if not p or not p.v then return false end
    return (vassal < master and p.v == 1) or (vassal > master and p.v == 2)
end
local function split_pair(key) return string.match(key, "^([^|]+)|([^|]+)$") end
local function is_player(snap, key) return snap and snap.f[key] and snap.f[key].h == 1 or false end
local function leader_of(snap, key)
    local info = snap and snap.f[key]
    return info and {fn = info.fn, sn = info.sn} or nil
end
local function on_cooldown(kind, a, b, turn, length)
    local last = world.cd[kind .. "|" .. pair_key(a, b or "")]
    return last ~= nil and turn - last < length
end
local function set_cooldown(kind, a, b, turn) world.cd[kind .. "|" .. pair_key(a, b or "")] = turn end

-- ---------------------------------------------------------------------------
-- What changed: news
-- ---------------------------------------------------------------------------
-- Wars and truces between minor realms are constant noise; they only make the
-- chronicle when a great power, the player or the player's friends are involved.
local NEWS_WEIGHT = {betrayal = 7, destroyed = 6, alliance_military = 5, war = 3, alliance_defensive = 4,
    vassal = 4, capture = 3, peace = 2, alliance_broken = 3, nap = 2, rise = 3, fall = 3, army_destroyed = 4}

local function importance(snap, kind, a, b, n)
    local value = NEWS_WEIGHT[kind] or 2
    if kind == "capture" then
        if (n or 0) >= 2 then value = value + 1 end
        if (n or 0) >= 4 then value = value + 1 end
    end
    local best = 999
    for _, key in ipairs({a, b}) do
        local info = key and snap.f[key]
        if info and info.r and info.r > 0 and info.r < best then best = info.r end
    end
    if best <= 5 then value = value + 2 elseif best <= 10 then value = value + 1 end
    local player = snap.player
    for _, key in ipairs({a, b}) do
        if key and key == player then value = value + 3
        elseif key and player then
            local p = pair(snap, player, key)
            if p and (allied(p) or p.w) then value = value + 1 end
        end
    end
    local met = 0
    for _, key in ipairs({a, b}) do if key and snap.f[key] and (snap.f[key].m or snap.f[key].h) then met = met + 1 end end
    if met == 0 then value = value - 1 end
    return value
end

local function news(prev, cur)
    local found = {}
    local function add(kind, a, b, n)
        found[#found + 1] = {t = cur.turn, c = "news", k = kind, a = a, b = b, n = n,
            la = leader_of(cur, a) or leader_of(prev, a), lb = b and (leader_of(cur, b) or leader_of(prev, b)) or nil,
            i = importance(cur, kind, a, b, n)}
    end
    local keys = {}
    for key in pairs(prev.p) do keys[key] = true end
    for key in pairs(cur.p) do keys[key] = true end
    for key in pairs(keys) do
        local a, b = split_pair(key)
        if a and prev.f[a] and prev.f[b] and cur.f[a] and cur.f[b] then
            local old, new = prev.p[key] or {}, cur.p[key] or {}
            if new.w and not old.w then
                if allied(old) then add("betrayal", a, b) else add("war", a, b) end
            elseif old.w and not new.w then add("peace", a, b) end
            if new.m and not old.m then add("alliance_military", a, b)
            elseif new.d and not old.d and not new.m and not old.m then add("alliance_defensive", a, b) end
            if allied(old) and not allied(new) and not new.w then add("alliance_broken", a, b) end
            if new.n and not old.n and not allied(new) and not new.w then add("nap", a, b) end
            if new.v and new.v ~= old.v then
                if new.v == 1 then add("vassal", a, b) else add("vassal", b, a) end
            end
        end
    end
    for key in pairs(prev.f) do
        if not cur.f[key] then
            local faction = safe(nil, function() return cm:get_faction(key) end)
            if faction and safe(false, function() return faction:is_dead() end) then add("destroyed", key) end
        end
    end
    -- Conquests: every settlement that changed hands between two watched realms.
    local taken = {}
    for region, loser in pairs(prev.o) do
        local taker = cur.o[region]
        if not taker then
            local r = safe(nil, function() return cm:get_region(region) end)
            local owner = r and safe(nil, function() return r:owning_faction() end)
            if owner and not safe(true, function() return owner:is_null_interface() end) then taker = safe(nil, function() return owner:name() end) end
        end
        if taker and taker ~= loser and cur.f[taker] then
            local k = taker .. ">" .. loser
            taken[k] = (taken[k] or 0) + 1
        end
    end
    for k, n in pairs(taken) do
        local taker, loser = string.match(k, "^([^>]+)>(.+)$")
        add("capture", taker, loser, n)
        local record = world.cap[k] or {n = 0}
        record.n = record.n + n; record.t = cur.turn; world.cap[k] = record
    end
    -- Rise and fall, against the size a few scans ago.
    for key, info in pairs(cur.f) do
        local hist = world.hist[key]
        local before = hist and hist[#hist - TREND_SCANS + 1]
        if before and not info.h then
            if info.n >= math.max(before * 1.3, before + 3) and not on_cooldown("rise", key, nil, cur.turn, 8) then
                add("rise", key, nil, info.n); set_cooldown("rise", key, nil, cur.turn)
            elseif before - info.n >= 3 and info.n <= before * 0.7 and not on_cooldown("fall", key, nil, cur.turn, 8) then
                add("fall", key, nil, info.n); set_cooldown("fall", key, nil, cur.turn)
            end
        end
    end
    local kept = {}
    for _, item in ipairs(found) do if item.i >= NEWS_THRESHOLD then kept[#kept + 1] = item end end
    table.sort(kept, function(x, y) if x.i ~= y.i then return x.i > y.i end return (x.k .. x.a) < (y.k .. y.a) end)
    while #kept > NEWS_PER_TURN do table.remove(kept) end
    return kept, found
end

-- ---------------------------------------------------------------------------
-- Court gossip: true facts with a human face (plan, section 3.7)
-- ---------------------------------------------------------------------------
-- Canon relationships between legendary lords, keyed by agent subtype (the same keys
-- as lore-profiles/). Used only while both lead their factions.
-- Checked on 02-10-2026 against lore-profiles/ and the background: only pairs whose
-- bond is personal and canonical. Removed then: rivalries that were only between their
-- gods (Skarbrand/N'Kari, Kairos/Ku'gath) or their peoples (Thorgrim/Tyrion), and pairs
-- the background does not support (Grimgor/Azhag, Malus/Malekith, Morathi/Alarielle,
-- the Vampire Coast captains).
local LORE_PAIRS = {
    {"wh2_main_hef_tyrion", "wh2_dlc10_hef_alarielle", "affection"},
    {"wh_dlc04_vmp_vlad_con_carstein", "wh_pro02_vmp_isabella_von_carstein", "affection"},
    {"wh2_main_hef_tyrion", "wh2_main_hef_teclis", "family"},
    {"wh2_main_def_malekith", "wh2_main_def_morathi", "family"},
    {"wh3_main_cth_miao_ying", "wh3_main_cth_zhao_ming", "family"},
    {"wh2_main_def_malekith", "wh2_main_hef_tyrion", "hatred"},
    {"wh2_main_def_malekith", "wh2_dlc10_hef_alith_anar", "hatred"},
    {"wh3_main_sla_nkari", "wh2_main_hef_tyrion", "hatred"},
    {"wh3_main_sla_nkari", "wh2_dlc10_hef_alarielle", "hatred"},
    {"wh3_dlc29_nag_nagash", "wh2_dlc09_tmb_settra", "hatred"},
    {"wh2_dlc09_tmb_settra", "wh2_dlc09_tmb_arkhan", "hatred"},
    {"wh2_dlc09_tmb_khalida", "wh3_dlc29_vmp_neferata", "hatred"},
    {"wh_dlc06_dwf_belegar", "wh_dlc06_grn_skarsnik", "hatred"},
    {"wh_dlc06_dwf_belegar", "wh2_main_skv_queek_headtaker", "hatred"},
    {"wh2_dlc15_hef_eltharion", "wh2_dlc15_grn_grom_the_paunch", "hatred"},
    {"wh2_main_def_morathi", "wh2_dlc10_def_crone_hellebron", "rivalry"},
    {"wh3_main_ksl_katarin", "wh3_main_ksl_kostaltyn", "rivalry"},
    {"wh3_main_ksl_katarin", "wh3_main_ksl_boris", "family"},
    {"wh_main_vmp_mannfred_von_carstein", "wh_dlc04_vmp_vlad_con_carstein", "rivalry"},
    {"wh3_dlc29_nag_nagash", "wh3_dlc29_vmp_neferata", "rivalry"},
    {"wh_dlc06_grn_skarsnik", "wh2_main_skv_queek_headtaker", "rivalry"},
    {"wh_main_chs_archaon", "wh3_main_dae_belakor", "rivalry"},
    {"wh_main_emp_karl_franz", "wh_dlc04_emp_volkmar", "loyalty"},
    {"wh_main_emp_karl_franz", "wh_main_emp_balthasar_gelt", "loyalty"},
    {"wh_main_brt_louen_leoncouer", "wh_dlc07_brt_fay_enchantress", "loyalty"},
    {"wh_main_brt_louen_leoncouer", "wh2_dlc14_brt_repanse", "loyalty"},
    {"wh_main_dwf_thorgrim_grudgebearer", "wh_main_dwf_ungrim_ironfist", "loyalty"}
}
-- Peoples for whom "too many letters between two courts" makes no sense.
local NO_AFFECTION = {"_skv_", "_kho_", "_nur_", "_tze_", "_dae_", "_bst_", "_chs_", "_grn_", "_tmb_", "_lzd_"}
local function affection_fits(info)
    local sc = info and info.sc or ""
    for _, part in ipairs(NO_AFFECTION) do if string.find(sc, part, 1) then return false end end
    return true
end
-- Some sentences hinge on a feeling the game cannot measure: the facts behind them
-- are true, the motive is what the courts make of them.
local INTERPRETED = {jealousy = true, envy = true, humiliation = true, ambition = true, affection = true,
    crisis_meeting = true,
    army_lost = true, victory = true,
    ally_dispute = true, lore_affection = true, lore_rivalry = true, lore_family = true, servility = true}
local COOLDOWN = {hatred = 10, rivalry = 10, lore_affection = 12, lore_hatred = 12, lore_rivalry = 12,
    lore_family = 12, lore_loyalty = 12, loyalty = 10, affection = 10}

local function gossip(prev, cur, fresh_news)
    local candidates = {}
    local th = cur.th or DEFAULT_BANDS
    local function add(kind, a, b, c, n, weight)
        if on_cooldown(kind, a, b, cur.turn, COOLDOWN[kind] or 6) then return end
        if (kind == "affection" or kind == "lore_affection") and not option("romance") then return end
        local f = cur.f
        if f[a] and f[a].h or (b and f[b] and f[b].h) or (c and f[c] and f[c].h) then return end
        local w = weight
        for _, key in ipairs({a, b}) do if key and f[key] and f[key].m then w = w + 1 end end
        candidates[#candidates + 1] = {t = cur.turn, c = "gossip", k = kind, a = a, b = b, x = c, n = n,
            la = leader_of(cur, a), lb = b and leader_of(cur, b) or nil, w = w,
            tr = INTERPRETED[kind] and "interp" or "fact"}
    end
    local keys = {}
    for key in pairs(cur.f) do if not cur.f[key].h then keys[#keys + 1] = key end end
    table.sort(keys)
    for _, a in ipairs(keys) do
        local fa = cur.f[a]
        for _, b in ipairs(keys) do
            if a ~= b then
                local fb, p = cur.f[b], pair(cur, a, b)
                local a_to_b = att(cur, a, b)
                -- Servility: far weaker, adoring, and bound to the stronger one.
                if fa.s > 0 and fb.s >= fa.s * 2.5 and a_to_b >= th.vf
                    and (allied(p) or vassal_of(cur, a, b) or (p and p.t)) then
                    add("servility", a, b, nil, nil, 3)
                end
                -- Envy: matched ten scans ago, now clearly outgrown.
                local ha, hb = world.hist[a], world.hist[b]
                local then_a, then_b = ha and ha[1], hb and hb[1]
                if then_a and then_b and #ha >= 6 and math.abs(then_a - then_b) <= math.max(2, then_a * 0.2)
                    and fb.n >= fa.n * 1.4 and fb.n - fa.n >= 4 and a_to_b < th.f and not allied(p) then
                    add("envy", a, b, nil, nil, 2)
                end
                if a < b then
                    local b_to_a = att(cur, b, a)
                    -- Allies whose letters grow cold.
                    local trend = world.ah[pair_key(a, b)]
                    if allied(p) and trend and #trend >= 3 and trend[1] - trend[#trend] >= math.max(15, math.floor((th.f - th.h) * 0.1)) then
                        add("ally_dispute", a, b, nil, nil, 3)
                    end
                    -- Old hatred.
                    if (a_to_b <= th.hd or b_to_a <= th.hd) and (p and p.w or world.cap[a .. ">" .. b] or world.cap[b .. ">" .. a]) then
                        if a_to_b <= b_to_a then add("hatred", a, b, nil, nil, 2) else add("hatred", b, a, nil, nil, 2) end
                    end
                    -- Two great houses of one people, both claiming to lead it.
                    if fa.sc == fb.sc and fa.r > 0 and fb.r > 0 and fa.r <= 15 and fb.r <= 15 and not allied(p) then
                        add("rivalry", a, b, nil, nil, 2)
                    end
                    -- Something more than politics, where the people allow it.
                    if a_to_b >= th.vf and b_to_a >= th.vf and (allied(p) or (p and p.t))
                        and fa.sc ~= fb.sc and affection_fits(fa) and affection_fits(fb) then
                        add("affection", a, b, nil, nil, 1)
                    end
                    -- Long friendship.
                    if allied(p) and p.since and cur.turn - p.since >= 10 and a_to_b >= th.f and b_to_a >= th.f then
                        add("loyalty", a, b, nil, nil, 1)
                    end
                end
                -- An ally trading with your enemy: B resents A.
                if allied(p) then
                    for _, c in ipairs(keys) do
                        if c ~= a and c ~= b then
                            local bc, ac = pair(cur, b, c), pair(cur, a, c)
                            if bc and bc.w and ac and ac.t and not ac.w then add("ally_trade_enemy", a, b, c, nil, 2) end
                        end
                    end
                end
                -- Humiliation: settlements lost to b recently.
                local lost = world.cap[b .. ">" .. a]
                if lost and lost.n >= 2 and cur.turn - (lost.t or -99) <= 3 then add("humiliation", a, b, nil, lost.n, 3) end
            end
        end
        -- Ambition: growing fast while fighting on several fronts.
        local hist = world.hist[a]
        local before = hist and hist[#hist - TREND_SCANS + 1]
        if before and fa.n - before >= 3 and fa.n >= before * 1.3 then
            local wars = 0
            for _, other in ipairs(keys) do local p = pair(cur, a, other); if p and p.w then wars = wars + 1 end end
            if wars >= 2 then add("ambition", a, nil, nil, nil, 2) end
        end
    end
    -- Emotional interpretations use confirmed losses, never legacy disappearance
    -- guesses. Reinforcing factions are not credited with each other's armies.
    for _, b in ipairs(world.b or {}) do
        if b.w ~= "draw" and cur.turn >= b.t and cur.turn - b.t <= 2 then
            local winning, losing = b.w == "a" and b.a or b.d, b.w == "a" and b.d or b.a
            if #winning == 1 then
                for loser, count in pairs(b.destroyed or {}) do
                    if count > 0 then add("army_lost", loser, winning[1], nil, nil, 4) end
                end
            end
            local result = b.w == "a" and b.ar or b.dr
            if #winning == 1 and #losing == 1 and (result == "heroic_victory" or result == "decisive_victory") then
                add("victory", winning[1], losing[1], nil, nil, 2)
            end
        end
    end
    -- Events of this turn: jealousy and dishonour.
    for _, item in ipairs(fresh_news) do
        if item.k == "alliance_military" or item.k == "alliance_defensive" then
            for _, side in ipairs({{item.a, item.b}, {item.b, item.a}}) do
                local partner, newcomer = side[1], side[2]
                for _, jealous in ipairs(keys) do
                    if jealous ~= partner and jealous ~= newcomer and allied(pair(prev, jealous, partner)) and allied(pair(cur, jealous, partner)) then
                        add("jealousy", jealous, partner, newcomer, nil, 4)
                    end
                end
            end
        elseif item.k == "betrayal" and item.b then
            add("dishonour", item.a, item.b, nil, nil, 3)
        end
    end
    -- Canon pairs, while both lords still lead their realms.
    local led = {}
    for _, key in ipairs(keys) do if cur.f[key].l then led[cur.f[key].l] = key end end
    for _, lore in ipairs(LORE_PAIRS) do
        local a, b = led[lore[1]], led[lore[2]]
        if a and b and a ~= b then
            local p = pair(cur, a, b)
            local at_war = p and p.w
            if not ((lore[3] == "affection" or lore[3] == "loyalty") and at_war) then
                add("lore_" .. lore[3], a, b, nil, nil, 2)
            end
        end
    end
    -- One or two per turn, weighted, never two about the same pair.
    local chosen, used = {}, {}
    while #chosen < GOSSIP_PER_TURN and #candidates > 0 do
        local total = 0
        for _, item in ipairs(candidates) do total = total + item.w end
        local pick, acc, index = roll(total), 0, #candidates
        for i, item in ipairs(candidates) do acc = acc + item.w; if pick <= acc then index = i; break end end
        local item = table.remove(candidates, index)
        local id = pair_key(item.a, item.b or "")
        if not used[id] then
            used[id] = true; item.w = nil; chosen[#chosen + 1] = item
            set_cooldown(item.k, item.a, item.b, cur.turn)
        end
    end
    return chosen
end

-- ---------------------------------------------------------------------------
-- Battles: who fought whom, who won, and (checked a turn later) whether the losing
-- army still exists. Feeds the court reports, the chronicle and the gossip.
-- ---------------------------------------------------------------------------
local MAX_BATTLES = 120
local function contains(list, key)
    for _, value in ipairs(list or {}) do if value == key then return true end end
    return false
end
local function winners(b) return b.w == "a" and b.a or b.d end
local function losers(b) return b.w == "a" and b.d or b.a end
-- Armies are rarely wiped out: most of a beaten army escapes. What tells a ruler the
-- war is going badly is how often and how hard they are beaten. A heavy defeat is the
-- game's decisive or crushing defeat, or most of the losing side killed.
local HEAVY_RESULTS = {decisive_defeat = true, crushing_defeat = true}
local function heavy_defeat(b, side)
    if b.w == "draw" or b.w == side then return false end
    local result = side == "a" and b.ar or b.dr
    if type(result) == "string" and HEAVY_RESULTS[result] then return true end
    return type(b.lk) == "number" and b.lk >= 60
end
-- One record per realm and enemy for as long as their war lasts (pruned at peace),
-- so five defeats spread over ten turns still read as a war going badly.
local function record_war(battle)
    if battle.w == "draw" then return end
    world.wl = world.wl or {}
    for _, side in ipairs({"a", "d"}) do
        local mine, theirs = battle[side], side == "a" and battle.d or battle.a
        for _, me in ipairs(mine) do
            for _, foe in ipairs(theirs) do
                local key = me .. ">" .. foe
                local r = world.wl[key] or {w = 0, l = 0, h = 0, since = battle.t}
                if battle.w == side then r.w = r.w + 1
                else
                    r.l = r.l + 1
                    if heavy_defeat(battle, side) then r.h = r.h + 1 end
                end
                r.last = battle.t
                world.wl[key] = r
            end
        end
    end
end
local function war_verdict(r)
    local lost, won = r.l + r.h, r.w
    if r.l >= 3 and lost >= won + 3 then return "badly" end
    if r.w >= 3 and won >= lost + 3 then return "well" end
    return "undecided"
end
local function battle_side(count, getter, before)
    local factions, forces, seen = {}, {}, {}
    for i = 1, count do
        local ok, character, force, faction = pcall(getter, i)
        if ok and type(faction) == "string" and faction ~= "" then
            if not contains(factions, faction) then factions[#factions + 1] = faction end
            -- Classify BEFORE combat, never default a destroyed/unknown army to
            -- garrison. Preserve each reinforcing force's owner.
            local garrison = nil
            if before and force then garrison = safe(nil, function()
                local f = cm:model():military_force_for_command_queue_index(force)
                if not f or f:is_null_interface() then return nil end
                return f:is_armed_citizenry()
            end) end
            if force and not seen[force] then
                seen[force] = true
                forces[#forces + 1] = {q = force, owner = faction, character = character,
                    field = garrison == false and 1 or nil}
            end
        end
    end
    return factions, forces
end
local function watched(key)
    if world.snap and world.snap.f[key] then return true end
    if llmdip_is_contact_enabled and safe(false, function() return llmdip_is_contact_enabled(key) end) then return true end
    local faction = safe(nil, function() return cm:get_faction(key) end)
    return faction ~= nil and safe(false, function() return faction:is_human() end)
end
-- 03-10-2026: the game crashed twice at the same AI battle (Ice Court against Glottkin),
-- right as it started, while this capture was asking the engine about the armies. During
-- the AI's turns nothing of ours queries the engine or saves the world any more: when a
-- battle ends, who fought and who won are copied from the game's own battle cache into a
-- small queue, read at the start of the player's turn. On the player's own turn battles
-- are recorded fully, as before.
local player_phase, multiplayer = false, true
local BATTLE_QUEUE_KEY = "llmdip_world_bq"
local battle_queue = {}
local function capture_battle()
    if not world or multiplayer or not player_phase then return end
    local attackers, attacker_forces = battle_side(safe(0, function() return cm:pending_battle_cache_num_attackers() end),
        function(i) return cm:pending_battle_cache_get_attacker(i) end, true)
    local defenders, defender_forces = battle_side(safe(0, function() return cm:pending_battle_cache_num_defenders() end),
        function(i) return cm:pending_battle_cache_get_defender(i) end, true)
    if #attackers == 0 or #defenders == 0 then return end
    world.bseq = (tonumber(world.bseq) or 0) + 1
    world.pending = {id = tostring(cm:model():turn_number()) .. "_" .. world.bseq,
        t = cm:model():turn_number(), a = attackers, d = defenders, af = attacker_forces, df = defender_forces}
    save()
end
-- Outside the player's turn: the battle cache and its winner only, no engine queries.
local function queue_battle()
    local attackers, attacker_forces = battle_side(safe(0, function() return cm:pending_battle_cache_num_attackers() end),
        function(i) return cm:pending_battle_cache_get_attacker(i) end, false)
    local defenders, defender_forces = battle_side(safe(0, function() return cm:pending_battle_cache_num_defenders() end),
        function(i) return cm:pending_battle_cache_get_defender(i) end, false)
    if #attackers == 0 or #defenders == 0 then return end
    local attacker_won = safe(false, function() return cm:pending_battle_cache_attacker_victory() end) == true
    local defender_won = safe(false, function() return cm:pending_battle_cache_defender_victory() end) == true
    if attacker_won == defender_won then return end
    local ids = {}
    for _, row in ipairs(attacker_forces) do ids[#ids + 1] = "a" .. tostring(row.q) .. ":" .. row.owner end
    for _, row in ipairs(defender_forces) do ids[#ids + 1] = "d" .. tostring(row.q) .. ":" .. row.owner end
    table.sort(ids)
    local turn = tonumber(world.turn) or 0
    local id = tostring(turn) .. "_" .. table.concat(ids, "/")
    for _, item in ipairs(battle_queue) do if item.id == id then return end end
    if #battle_queue >= 60 then return end
    battle_queue[#battle_queue + 1] = {id = id, t = turn, a = attackers, d = defenders, w = attacker_won and "a" or "d"}
    -- A small table of its own, so a manual battle later in the same AI turn (which
    -- reloads the campaign scripts) does not lose it.
    cm:set_saved_value(BATTLE_QUEUE_KEY, battle_queue)
end

-- At the start of the player's turn (and on their turn), the queued battles become
-- ordinary records. Their losses stay unknown: an annihilation is only ever confirmed
-- for a battle recorded on the player's own turn.
function llmdip_world_flush_battles()
    if not world or #battle_queue == 0 then return 0 end
    local count = 0
    for _, item in ipairs(battle_queue) do
        if world.last_battle_id ~= item.id and not contains(world.qids, item.id) then
            local relevant = false
            for _, key in ipairs(item.a) do if watched(key) then relevant = true end end
            for _, key in ipairs(item.d) do if watched(key) then relevant = true end end
            if relevant then
                local battle = {id = item.id, t = item.t, a = item.a, d = item.d, w = item.w, destroyed = {}, loss_status = "unknown"}
                record_war(battle)
                table.insert(world.b, 1, battle)
                while #world.b > MAX_BATTLES do table.remove(world.b) end
                count = count + 1
                out("[LLMDIP] WORLD_BATTLE|" .. table.concat(item.a, ":") .. "|" .. table.concat(item.d, ":")
                    .. "|winner=" .. item.w .. "|siege=unknown|losses=unknown|id=" .. item.id .. "|queued")
            end
            world.qids = world.qids or {}
            world.qids[#world.qids + 1] = item.id
            while #world.qids > 60 do table.remove(world.qids, 1) end
        end
    end
    battle_queue = {}
    cm:set_saved_value(BATTLE_QUEUE_KEY, battle_queue)
    save()
    return count
end

local function record_battle()
    if not world or multiplayer then return end
    if not player_phase then queue_battle(); return end
    local attackers, attacker_forces = battle_side(safe(0, function() return cm:pending_battle_cache_num_attackers() end),
        function(i) return cm:pending_battle_cache_get_attacker(i) end, false)
    local defenders, defender_forces = battle_side(safe(0, function() return cm:pending_battle_cache_num_defenders() end),
        function(i) return cm:pending_battle_cache_get_defender(i) end, false)
    if #attackers == 0 or #defenders == 0 then return end
    local relevant = false
    for _, key in ipairs(attackers) do if watched(key) then relevant = true end end
    for _, key in ipairs(defenders) do if watched(key) then relevant = true end end
    if not relevant then return end
    local attacker_won = safe(false, function() return cm:pending_battle_cache_attacker_victory() end) == true
    local defender_won = safe(false, function() return cm:pending_battle_cache_defender_victory() end) == true
    local pb = safe(nil, function() return cm:model():pending_battle() end)
    local draw = pb and safe(false, function() return pb:is_draw() end) == true
    if attacker_won == defender_won and not draw then return end
    local function signature(a, d)
        local ids = {}
        for _, row in ipairs(a) do ids[#ids + 1] = "a" .. tostring(row.q) .. ":" .. row.owner end
        for _, row in ipairs(d) do ids[#ids + 1] = "d" .. tostring(row.q) .. ":" .. row.owner end
        table.sort(ids)
        return table.concat(ids, "/")
    end
    local pending = world.pending
    local matched = pending and pending.t == cm:model():turn_number()
        and signature(pending.af, pending.df) == signature(attacker_forces, defender_forces)
    local id = matched and pending.id or (tostring(cm:model():turn_number()) .. "_" .. signature(attacker_forces, defender_forces))
    if world.last_battle_id == id then return end
    -- WH3's pending battle interface spells it "seige_battle"; try both spellings.
    local siege = pb and (safe(false, function() return pb:seige_battle() end) == true
        or safe(false, function() return pb:siege_battle() end) == true)
    local ar = pb and safe(nil, function() return pb:attacker_battle_result() end)
    local dr = pb and safe(nil, function() return pb:defender_battle_result() end)
    local auto = pb and safe(nil, function() return pb:is_auto_resolved() end)
    local battle = {id = id, t = cm:model():turn_number(), a = attackers, d = defenders,
        w = draw and "draw" or (attacker_won and "a" or "d"), ar = ar, dr = dr,
        s = siege and 1 or nil, auto = auto, destroyed = {}, loss_status = "unknown"}
    -- Missing force + query failure alone proves NOTHING. Confirm annihilation
    -- only with a preclassified field force, a successful immediate null query,
    -- and the losing side's documented 100% killed result. Other losses stay unknown.
    local losing_forces = matched and (attacker_won and pending.df or pending.af) or {}
    local killed = pb and safe(nil, function()
        if attacker_won then return pb:percentage_of_defender_killed() end
        return pb:percentage_of_attacker_killed()
    end)
    if not draw then
        for _, row in ipairs(losing_forces) do
            local null = safe(nil, function()
                local f = cm:model():military_force_for_command_queue_index(row.q)
                if f then return f:is_null_interface() end
            end)
            if row.field == 1 and null == true and type(killed) == "number" and killed >= 100 then
                battle.destroyed[row.owner] = (battle.destroyed[row.owner] or 0) + 1
            end
        end
    end
    if next(battle.destroyed) then battle.loss_status = "confirmed" end
    battle.news_pending = next(battle.destroyed) ~= nil and 1 or nil
    if not draw and type(killed) == "number" then battle.lk = math.floor(killed) end
    record_war(battle)
    table.insert(world.b, 1, battle)
    while #world.b > MAX_BATTLES do table.remove(world.b) end
    world.last_battle_id = id
    save()
    out("[LLMDIP] WORLD_BATTLE|" .. table.concat(attackers, ":") .. "|" .. table.concat(defenders, ":")
        .. "|winner=" .. battle.w .. "|siege=" .. tostring(siege) .. "|losses=" .. battle.loss_status .. "|id=" .. id)
end
core:remove_listener("llmdip_world_player_end")
core:add_listener("llmdip_world_player_end", "ScriptEventPlayerFactionTurnEnd", true, function() player_phase = false end, true)
core:remove_listener("llmdip_world_prebattle")
core:add_listener("llmdip_world_prebattle", "ScriptEventPendingBattle", true, function()
    local ok, err = pcall(capture_battle)
    if not ok then out("[LLMDIP] WORLD_PREBATTLE_ERROR|" .. tostring(err)) end
end, true)
core:remove_listener("llmdip_world_battle")
core:add_listener("llmdip_world_battle", "BattleCompleted", true, function()
    local ok, err = pcall(record_battle)
    if not ok then out("[LLMDIP] WORLD_BATTLE_ERROR|" .. tostring(err)) end
end, true)

-- Only publish losses already confirmed at battle resolution. Never retroactively
-- turn a disappearance several turns later into an annihilation by an old opponent.
local function resolve_battles(cur)
    local found = {}
    for _, b in ipairs(world.b) do
        if b.news_pending then
            if cur.turn - b.t <= 1 then
                for loser, count in pairs(b.destroyed or {}) do
                    -- Do not credit one particular reinforcing enemy with the kill
                    -- unless there was exactly one opposing faction.
                    local enemies = winners(b)
                    if #enemies == 1 then
                        local winner = enemies[1]
                        found[#found + 1] = {t = b.t, c = "news", k = "army_destroyed", a = loser, b = winner,
                            n = count, la = leader_of(cur, loser), lb = leader_of(cur, winner),
                            i = importance(cur, "army_destroyed", loser, winner)}
                    end
                end
            end
            b.news_pending = nil
        end
        -- Retain old records as historical battle outcomes, not trusted evidence
        -- of destruction inferred by the interrupted patch.
        b.lost, b.wiped = nil, nil
    end
    return found
end

-- What the player's own court tells them: who is fond of them, who loathes them, who
-- fears them and who is fighting their enemies. Names are resolved when drawn.
-- The game's own attitude of a faction toward the player: 0 hostile .. 3 neutral ..
-- 6 trusted friends, the category the diplomacy screen shows (checked in campaign:
-- 4 Amistosa, 5 Muy amistosa, 6 Amigos de confianza, 1 Very Unfriendly, 0 Hostile).
local function player_attitude_category(key)
    local value = tonumber(safe(nil, function()
        return common.get_context_value("CcoCampaignFaction", key, "AttitudeCategory")
    end))
    if value and value >= 0 and value <= 6 then return value end
    return nil
end
local function player_attitude_label(key)
    local label = safe(nil, function() return common.get_context_value("CcoCampaignFaction", key, "AttitudeTooltip") end)
    if type(label) ~= "string" then return nil end
    label = string.gsub(label, "[\r\n]+", " ")
    if label == "" or #label > 40 then return nil end
    return label
end

local function player_report(snap)
    local player, th = snap.player, snap.th or DEFAULT_BANDS
    local me = snap.f[player]
    local likes, hates, fear, common, enemies = {}, {}, {}, {}, {}
    local keys = {}
    for key in pairs(snap.f) do if key ~= player then keys[#keys + 1] = key end end
    table.sort(keys)
    for _, key in ipairs(keys) do local p = pair(snap, player, key); if p and p.w then enemies[#enemies + 1] = key end end
    for _, key in ipairs(keys) do
        local info = snap.f[key]
        if info.m then
            local p, feeling = pair(snap, player, key), att(snap, key, player)
            local at_war = p and p.w
            local category = player_attitude_category(key)
            -- Without the game's category, nobody is listed as fond or hateful: the
            -- relative bands are not good enough to tell the player who likes them.
            local friendly = category ~= nil and category >= 4
            local hostile = category ~= nil and category <= 1
            local cold = category ~= nil and category <= 2 or (category == nil and feeling <= th.h)
            if friendly and not at_war then likes[#likes + 1] = {key = key, v = category * 10000 + feeling} end
            if hostile then hates[#hates + 1] = {key = key, v = (6 - category) * 10000 - feeling} end
            if me and me.s > 0 and info.s > 0 and me.s >= info.s * 1.5 and (at_war or cold) then
                fear[#fear + 1] = {key = key, v = me.s / info.s}
            end
            if not at_war and not cold then
                for _, enemy in ipairs(enemies) do
                    local q = pair(snap, key, enemy)
                    if enemy ~= key and q and q.w then common[#common + 1] = {key = key, b = enemy, v = feeling}; break end
                end
            end
        end
    end
    local function top(list, n)
        table.sort(list, function(x, y) if x.v ~= y.v then return x.v > y.v end return x.key < y.key end)
        local result = {}
        for i = 1, math.min(n, #list) do result[i] = list[i].b and {a = list[i].key, b = list[i].b} or list[i].key end
        return result
    end
    return {t = snap.turn, likes = top(likes, 3), hates = top(hates, 3), fear = top(fear, 3), common = top(common, 2)}
end

-- ---------------------------------------------------------------------------
-- Optional real diplomacy between AI realms. When two great powers ally, two of the
-- realms they threaten that like each other may meet in secret (a rumour this turn)
-- and next turn sign a real defensive alliance, or fail. The game decides who, the
-- dice decide whether; the result is checked in the game before it is announced.
-- At most one such treaty a turn, eight turns' rest per realm, never the player.
-- ---------------------------------------------------------------------------
local MAX_CRISES, TREATY_COOLDOWN, CRISIS_LIFE, CRISIS_CHANCE = 2, 8, 3, 60
local function in_crisis(key)
    for _, c in ipairs(world.cr) do if c.a == key or c.b == key then return true end end
    return false
end
local function treaty_ready(key, turn)
    local last = world.tc[key]
    return not last or turn - last >= TREATY_COOLDOWN
end
-- Two realms threatened by the bloc, friendly to each other, at peace and not yet allied.
local function pick_coalition(cur, bloc)
    local th = cur.th or DEFAULT_BANDS
    local power = 0
    for _, key in ipairs(bloc) do power = power + ((cur.f[key] and cur.f[key].s) or 0) end
    local threatened = {}
    for key, info in pairs(cur.f) do
        if not info.h and not contains(bloc, key) and info.s < power and treaty_ready(key, cur.turn) and not in_crisis(key) then
            local menaced, bound = false, false
            for _, member in ipairs(bloc) do
                local p = pair(cur, key, member)
                if allied(p) or (p and p.v) then bound = true end
                if (p and p.w) or att(cur, key, member) <= th.h then menaced = true end
            end
            if menaced and not bound then threatened[#threatened + 1] = key end
        end
    end
    table.sort(threatened)
    local best, score = nil, nil
    for i = 1, #threatened do
        for j = i + 1, #threatened do
            local a, b = threatened[i], threatened[j]
            local p = pair(cur, a, b)
            local ab, ba = att(cur, a, b), att(cur, b, a)
            if not (p and (p.w or allied(p) or p.v)) and ab >= th.f and ba >= th.f then
                if not score or ab + ba > score then best, score = {a, b}, ab + ba end
            end
        end
    end
    return best
end
local function open_crises(cur, changes)
    local opened = {}
    if not option("treaties") then return opened end
    for _, item in ipairs(changes) do
        if #world.cr >= MAX_CRISES then break end
        if (item.k == "alliance_military" or item.k == "alliance_defensive") and item.b
            and not world.forced[pair_key(item.a, item.b)] then
            local fa, fb = cur.f[item.a], cur.f[item.b]
            local great = (fa and fa.r > 0 and fa.r <= 10) or (fb and fb.r > 0 and fb.r <= 10)
            local found = great and pick_coalition(cur, {item.a, item.b}) or nil
            if found then
                local lead = item.a
                if fb and fb.r > 0 and (not fa or fa.r <= 0 or fb.r < fa.r) then lead = item.b end
                world.cr[#world.cr + 1] = {a = found[1], b = found[2], x = lead, t = cur.turn}
                opened[#opened + 1] = {t = cur.turn, c = "gossip", k = "crisis_meeting", a = found[1], b = found[2], x = lead,
                    la = leader_of(cur, found[1]), lb = leader_of(cur, found[2]), tr = "interp", i = 4}
                out("[LLMDIP] WORLD_CRISIS_OPEN|" .. found[1] .. "|" .. found[2] .. "|against=" .. lead)
            end
        end
    end
    return opened
end
local function close_crises(cur)
    local results, keep, signed = {}, {}, false
    local function allied_now(fa, fb)
        return safe(false, function() return fa:defensive_allies_with(fb) or fa:military_allies_with(fb) end) == true
    end
    local function announce(c, success)
        results[#results + 1] = {t = cur.turn, c = "news", k = success and "coalition" or "talks_failed",
            a = c.a, b = c.b, x = c.x, la = leader_of(cur, c.a), lb = leader_of(cur, c.b), i = success and 6 or 4}
    end
    for _, c in ipairs(world.cr) do
        local fa = safe(nil, function() return cm:get_faction(c.a) end)
        local fb = safe(nil, function() return cm:get_faction(c.b) end)
        if c.called then
            -- Signed last turn but not yet visible then: say what the game shows now.
            announce(c, usable(fa) and usable(fb) and allied_now(fa, fb))
        elseif cur.turn <= c.t then
            keep[#keep + 1] = c
        elseif option("treaties") and cur.turn - c.t <= CRISIS_LIFE then
            local valid = usable(fa) and usable(fb)
                and not safe(true, function() return fa:is_human() or fb:is_human() end)
                and not safe(true, function() return fa:at_war_with(fb) end)
                and not allied_now(fa, fb)
            if valid and signed then
                keep[#keep + 1] = c
            elseif valid then
                local th, chance = cur.th or DEFAULT_BANDS, CRISIS_CHANCE
                if att(cur, c.a, c.b) >= th.vf and att(cur, c.b, c.a) >= th.vf then chance = chance + 20 end
                local called = false
                if roll(100) <= chance then
                    called = pcall(function() cm:force_alliance(c.a, c.b, false) end)
                end
                if called then
                    signed = true
                    world.forced[pair_key(c.a, c.b)] = cur.turn
                    world.tc[c.a], world.tc[c.b] = cur.turn, cur.turn
                    if allied_now(fa, fb) then announce(c, true)
                    else c.called = cur.turn; keep[#keep + 1] = c end
                else
                    announce(c, false)
                end
                out("[LLMDIP] WORLD_CRISIS_CLOSE|" .. c.a .. "|" .. c.b .. "|called=" .. tostring(called))
            end
        end
    end
    world.cr = keep
    return results
end

-- ---------------------------------------------------------------------------
-- The turn
-- ---------------------------------------------------------------------------
-- How long each alliance has lasted, carried over from the previous turn.
local function carry_alliances(prev, snap)
    for key, p in pairs(snap.p) do
        local old = prev and prev.p[key]
        if allied(p) then p.since = old and allied(old) and old.since or snap.turn end
    end
end

local function remember(snap)
    for key, info in pairs(snap.f) do
        local hist = world.hist[key] or {}
        hist[#hist + 1] = info.n
        while #hist > HISTORY_SCANS do table.remove(hist, 1) end
        world.hist[key] = hist
    end
    for key, p in pairs(snap.p) do
        if allied(p) then
            local trend = world.ah[key] or {}
            trend[#trend + 1] = math.floor(((p.ab or 0) + (p.ba or 0)) / 2)
            while #trend > 4 do table.remove(trend, 1) end
            world.ah[key] = trend
        else
            world.ah[key] = nil
        end
    end
    for key, record in pairs(world.cap) do
        if snap.turn - (record.t or -99) > 12 then world.cap[key] = nil end
    end
    for key, turn in pairs(world.cd) do
        if snap.turn - turn > 20 then world.cd[key] = nil end
    end
    for key, turn in pairs(world.forced) do
        if snap.turn - turn > 5 then world.forced[key] = nil end
    end
    -- A war record ends with the war (or after a long silence).
    for key, r in pairs(world.wl or {}) do
        local me, foe = string.match(key, "^([^>]+)>(.+)$")
        local a = me and safe(nil, function() return cm:get_faction(me) end)
        local b = foe and safe(nil, function() return cm:get_faction(foe) end)
        local fighting = usable(a) and usable(b) and safe(true, function() return a:at_war_with(b) end)
        if not fighting or snap.turn - (r.last or -99) > 30 then world.wl[key] = nil end
    end
    world.snap = snap
end

local function run_scan()
    if not world or cm:is_multiplayer() then return end
    local player = cm:get_local_faction(true)
    if not player or safe(true, function() return player:is_null_interface() end) then return end
    local turn = cm:model():turn_number()
    if world.turn == turn then return end
    local started = os.clock()
    local snap, count, low, high = scan(player)
    carry_alliances(world.snap, snap)
    local fresh_news, all_changes, fresh_gossip = {}, {}, {}
    local fallen = resolve_battles(snap)
    if world.snap and world.snap.turn < turn then
        fresh_news, all_changes = news(world.snap, snap)
        for _, item in ipairs(fallen) do
            all_changes[#all_changes + 1] = item
            if item.i >= NEWS_THRESHOLD then fresh_news[#fresh_news + 1] = item end
        end
        if llmdip_world_check_deeds then
            local ok, deeds = pcall(llmdip_world_check_deeds, turn)
            if ok then for _, item in ipairs(deeds) do fresh_news[#fresh_news + 1] = item end end
        end
        -- An alliance this mod signed is announced as a coalition, not again as news.
        local OURS = {alliance_defensive = true, alliance_military = true, war = true, peace = true, nap = true}
        local function ours(item)
            if not OURS[item.k] or not item.b then return false end
            local signed = world.forced[pair_key(item.a, item.b)]
            return signed ~= nil and turn - signed <= 2
        end
        for _, list in ipairs({fresh_news, all_changes}) do
            for i = #list, 1, -1 do if ours(list[i]) then table.remove(list, i) end end
        end
        fresh_gossip = gossip(world.snap, snap, all_changes)
        for _, item in ipairs(close_crises(snap)) do fresh_news[#fresh_news + 1] = item end
        for _, item in ipairs(open_crises(snap, all_changes)) do fresh_gossip[#fresh_gossip + 1] = item end
    else
        -- First look at this campaign (or a save from before 0.43): no news, since
        -- there is nothing to compare with, but standing gossip can start at once.
        fresh_gossip = gossip(snap, snap, {})
    end
    remember(snap)
    world.turn = turn
    world.rep = player_report(snap)
    local added = {}
    for _, item in ipairs(fresh_news) do added[#added + 1] = item end
    for _, item in ipairs(fresh_gossip) do added[#added + 1] = item end
    for i = #added, 1, -1 do table.insert(world.e, 1, added[i]) end
    while #world.e > MAX_ENTRIES do table.remove(world.e) end
    -- Asked once the turn's news are written down, so the court can tell them.
    local asked = llmdip_world_start_turn_requests and pcall(llmdip_world_start_turn_requests, snap)
    if not asked then out("[LLMDIP] BRIEFING_REQUEST_ERROR") end
    save()
    local pairs_kept = 0
    for _ in pairs(snap.p) do pairs_kept = pairs_kept + 1 end
    out("[LLMDIP] WORLD_SCAN|turn=" .. turn .. "|factions=" .. count .. "|pairs=" .. pairs_kept
        .. "|news=" .. #fresh_news .. "/" .. #all_changes .. "|gossip=" .. #fresh_gossip
        .. "|attitude=" .. low .. ".." .. high
        .. "|bands=" .. snap.th.hd .. "/" .. snap.th.h .. "/" .. snap.th.f .. "/" .. snap.th.vf .. "|ms=" .. math.floor((os.clock() - started) * 1000))
    for _, item in ipairs(added) do
        out("[LLMDIP] WORLD_" .. string.upper(item.c) .. "|" .. item.k .. "|" .. tostring(item.a) .. "|" .. tostring(item.b) .. "|" .. tostring(item.x) .. "|" .. tostring(item.n))
    end
end

function llmdip_world_scan()
    local ok, err = pcall(run_scan)
    if not ok then out("[LLMDIP] WORLD_SCAN_ERROR|" .. tostring(err)) end
    return ok
end

-- ---------------------------------------------------------------------------
-- Words: the World tab and the conversations
-- ---------------------------------------------------------------------------
local function localised(value)
    if type(value) ~= "string" or value == "" then return "" end
    local ok, text = pcall(function() return common.get_localised_string(value) end)
    if ok and type(text) == "string" and text ~= "" and text ~= value then return text end
    return value
end
local function faction_name(key)
    if not key then return "" end
    local loc = "factions_screen_name_" .. key
    local name = localised(loc)
    if name == loc or name == "" then return key end
    return name
end
local function leader_name(leader, key)
    if leader and leader.fn then
        local name = localised(leader.fn)
        local surname = leader.sn and localised(leader.sn) or ""
        if surname ~= "" and surname ~= leader.sn then name = name .. " " .. surname end
        if name ~= "" and name ~= leader.fn then return name end
    end
    return faction_name(key)
end
local function fill(template, vars)
    return (string.gsub(template, "{(%a+)}", function(name)
        local value = vars[name]
        if value == nil then return "" end
        return tostring(value)
    end))
end
local function template_key(item)
    if item.c == "news" then
        if item.k == "capture" then return (item.n or 0) > 1 and "w_capture_many" or "w_capture_one" end
        return "w_" .. item.k
    end
    return "g_" .. item.k
end
-- A character always comes with their realm: the player may not know who Grom is,
-- but knows the Broken Axe.
local function person(leader, key)
    local who, realm = leader_name(leader, key), faction_name(key)
    if realm == "" or who == realm then return who end
    return who .. " (" .. realm .. ")"
end
local function entry_text(item, lookup, mark)
    mark = mark or function(key, name) return name end
    return fill(lookup(template_key(item)), {
        a = mark(item.a, faction_name(item.a)), b = mark(item.b, faction_name(item.b)),
        c = mark(item.x, faction_name(item.x)), n = item.n,
        la = mark(item.a, person(item.la, item.a)), lb = mark(item.b, person(item.lb, item.b))})
end

-- Knowledge is observer-specific. Discovery permits public diplomatic news,
-- not hidden battles, conquered regions, army totals or private correspondence.
local function known_factions(observer)
    local known = {[observer] = true}
    local f = safe(nil, function() return cm:get_faction(observer) end)
    if not usable(f) then return known end
    local list = safe(nil, function() return f:factions_met() end)
    local count = list and safe(0, function() return list:num_items() end) or 0
    for i = 0, count - 1 do
        local key = safe(nil, function() return list:item_at(i):name() end)
        if key then known[key] = true end
    end
    return known
end
local PRIVATE_EVENT = {capture = true, army_destroyed = true, army_lost = true, victory = true,
    humiliation = true, rise = true, fall = true}
local function entry_known(item, observer, known)
    if PRIVATE_EVENT[item.k] then
        return item.a == observer or item.b == observer
    end
    for _, key in ipairs({item.a, item.b, item.x}) do
        if key and not known[key] then return false end
    end
    return true
end

-- Gossip written from attitude numbers only repeats the diplomacy screen. Once the
-- courts' own rumours arrive (world.cok), it is no longer shown or passed on; a coalition
-- meeting is kept, since it announces something the courts really do.
local function template_gossip_hidden(item)
    return world.cok ~= nil and item.c == "gossip" and item.k ~= "crisis_meeting"
end

-- Entries for the World tab, newest first, in the player's language.
function llmdip_world_entries()
    local result = {}
    if not world then return result end
    local observer = world.snap and world.snap.player
    local known = observer and known_factions(observer) or {}
    for _, item in ipairs(world.e) do
        local ok, text = true, item.tx
        if not text then ok, text = pcall(entry_text, item, llmdip_t) end
        if ok and observer and not template_gossip_hidden(item) and entry_known(item, observer, known) then
            result[#result + 1] = {turn = item.t, kind = item.c, text = text, new = item.t > (world.seen or -1)}
        end
    end
    return result
end
function llmdip_world_unseen()
    local n = 0
    for _, entry in ipairs(llmdip_world_entries()) do if entry.new then n = n + 1 end end
    return n
end
function llmdip_world_mark_seen()
    if not world or world.seen == world.turn then return end
    world.seen = world.turn; save()
end

-- Two dossier fields for one conversation: the news and the gossip that matter most to
-- this lord, in English (the companion and the model read English), with the lord's own
-- position toward each name, so their opinion follows the real relationships.
local function english(key) return llmdip_t_lang and llmdip_t_lang("en", key) or llmdip_t(key) end
function llmdip_world_brief(interlocutor, player)
    if not world or not world.snap then return "none", "none" end
    local snap = world.snap
    local known = known_factions(interlocutor)
    local function mark(key, name)
        if not key or name == "" then return name end
        if key == interlocutor then return name .. " (this is you)" end
        if key == player then return name .. " (the player you write to)" end
        local p, feeling = pair(snap, interlocutor, key), att(snap, interlocutor, key)
        if p and p.w then return name .. " (your enemy)" end
        if allied(p) then return name .. " (your ally)" end
        local th = snap.th or DEFAULT_BANDS
        if feeling >= th.f then return name .. " (you like them)" end
        if feeling <= th.h then return name .. " (you dislike them)" end
        return name
    end
    local scored = {}
    for _, item in ipairs(world.e) do
        local age = snap.turn - item.t
        if age >= 0 and age <= 10 and not template_gossip_hidden(item) and entry_known(item, interlocutor, known) then
            local score = (item.i or 3) - age * 0.5
            for _, key in ipairs({item.a, item.b, item.x}) do
                if key == interlocutor then score = score + 6
                elseif key == player then score = score + 2
                elseif key then
                    local p = pair(snap, interlocutor, key)
                    if p and (p.w or allied(p)) then score = score + 3 end
                end
            end
            scored[#scored + 1] = {item = item, score = score}
        end
    end
    table.sort(scored, function(x, y) return x.score > y.score end)
    local news_lines, gossip_lines = {}, {}
    for _, entry in ipairs(scored) do
        local item = entry.item
        local text = item.tx or entry_text(item, english, mark)
        text = "turn " .. item.t .. ": " .. string.gsub(text, "[,;|=]", "")
        if (item.c == "news" or item.c == "deed") and #news_lines < 3 then
            news_lines[#news_lines + 1] = text
        elseif item.c == "rumour" and #gossip_lines < 2 then
            gossip_lines[#gossip_lines + 1] = text .. " [a rumour spread by " .. mark(item.a, faction_name(item.a)) .. " - it may be false]"
        elseif item.c == "gossip" and #gossip_lines < 2 then
            local note = item.tr == "interp" and " [the facts are true - the motive is court talk]" or " [true]"
            gossip_lines[#gossip_lines + 1] = text .. note
        end
    end
    local function joined(lines) return #lines > 0 and table.concat(lines, " / ") or "none" end
    return joined(news_lines), joined(gossip_lines)
end

-- The report a lord's court gives them on foreign affairs, for every conversation and
-- letter: their wars and allies right now, their recent battles and losses, who
-- threatens them, where the player stands, and what is being said about them. Facts
-- only; how the lord feels about them is for the model and the character.
function llmdip_world_court_report(interlocutor, player)
    if not world then return "none" end
    local me = safe(nil, function() return cm:get_faction(interlocutor) end)
    if not usable(me) then return "none" end
    local snap, parts = world.snap, {}
    local known = known_factions(interlocutor)
    local th = snap and snap.th or DEFAULT_BANDS
    -- Each realm with its people ("Host of the Triplets (Warriors of Chaos)"): a lord
    -- should know at least who a realm is when their court names it (03-10-2026).
    local function named(key)
        if key == interlocutor then return "you" end
        if key == player then return faction_name(key) .. " (the player)" end
        local info = snap and snap.f[key]
        local sc = info and info.sc or safe(nil, function() return cm:get_faction(key):subculture() end)
        local people = type(sc) == "string" and localised("cultures_subcultures_name_" .. sc) or ""
        if people == "" or people == "cultures_subcultures_name_" .. tostring(sc) then return faction_name(key) end
        return faction_name(key) .. " (" .. people .. ")"
    end
    local function names_of(list, limit)
        local result = {}
        local count = list and safe(0, function() return list:num_items() end) or 0
        for i = 0, count - 1 do
            if #result >= limit then result[#result + 1] = "others"; break end
            local key = safe(nil, function() return list:item_at(i):name() end)
            if key then result[#result + 1] = named(key) end
        end
        return result
    end
    local war_list = safe(nil, function() return me:factions_at_war_with() end)
    local wars = names_of(war_list, 6)
    parts[#parts + 1] = not war_list and "Current wars: unavailable" or
        (#wars > 0 and ("At war with: " .. table.concat(wars, " / ")) or "At war with nobody")
    local ally_list = safe(nil, function() return me:factions_allied_with() end)
    local allies = names_of(ally_list, 4)
    if not ally_list then parts[#parts + 1] = "Current allies: unavailable" end
    if #allies > 0 then parts[#parts + 1] = "Allies: " .. table.concat(allies, " / ") end
    local now = safe(world.turn, function() return cm:model():turn_number() end)
    local fought, campaigns = {}, {}
    for _, b in ipairs(world.b) do
        if now - b.t > 3 then break end
        local side = contains(b.a, interlocutor) and "a" or (contains(b.d, interlocutor) and "d" or nil)
        if side and now >= b.t then
            local won = side == b.w
            local foes, names = (side == "a" and b.d or b.a), {}
            for _, key in ipairs(foes) do names[#names + 1] = named(key) end
            local outcome = b.w == "draw" and "drew" or (won and "won" or "lost")
            local line = "turn " .. b.t .. " you " .. outcome .. " a battle against " .. table.concat(names, " and ")
            if b.s then line = line .. (side == "d" and " defending a settlement" or " attacking a settlement") end
            local result = side == "a" and b.ar or b.dr
            if type(result) == "string" then line = line .. " (" .. string.gsub(result, "_", " ") .. ")" end
            local lost = b.destroyed and b.destroyed[interlocutor] or 0
            if lost > 0 then line = line .. " and " .. lost .. " of your field armies were confirmed destroyed" end
            if #fought < 3 then fought[#fought + 1] = line end
            for _, key in ipairs(foes) do
                local score = campaigns[key] or {won = 0, lost = 0, drawn = 0}
                if b.w == "draw" then score.drawn = score.drawn + 1
                elseif won then score.won = score.won + 1 else score.lost = score.lost + 1 end
                campaigns[key] = score
            end
        end
    end
    -- The course of each war, from the court's own record since it began.
    local wars_course = {}
    for key, r in pairs(world.wl or {}) do
        local me, foe = string.match(key, "^([^>]+)>(.+)$")
        if me == interlocutor then wars_course[#wars_course + 1] = {foe = foe, r = r} end
    end
    table.sort(wars_course, function(x, y)
        local nx, ny = x.r.w + x.r.l, y.r.w + y.r.l
        if nx ~= ny then return nx > ny end
        return x.foe < y.foe
    end)
    local course = {}
    for i = 1, math.min(3, #wars_course) do
        local foe, r = wars_course[i].foe, wars_course[i].r
        local line = "against " .. named(foe) .. " since turn " .. r.since .. ": " .. r.w .. " battles won and " .. r.l .. " lost"
        if r.h > 0 then line = line .. " (" .. r.h .. " of them heavy defeats)" end
        local taken = world.cap[foe .. ">" .. interlocutor]
        if taken and taken.n > 0 then line = line .. " and " .. taken.n .. " settlements lost to them recently" end
        local verdict = war_verdict(r)
        line = line .. (verdict == "badly" and " - the war is going badly for you"
            or (verdict == "well" and " - the war is going well for you" or " - the war is undecided"))
        course[#course + 1] = line
    end
    if #course > 0 then
        parts[#parts + 1] = "How your wars are going (your court's record since each began; beaten armies usually escape but are bled): " .. table.concat(course, " / ")
    end
    if #fought > 0 then parts[#parts + 1] = "Recent battles: " .. table.concat(fought, " / ") end
    local campaign_keys, balances = {}, {}
    for key in pairs(campaigns) do campaign_keys[#campaign_keys + 1] = key end
    table.sort(campaign_keys)
    for i = 1, math.min(3, #campaign_keys) do
        local key = campaign_keys[i]; local score = campaigns[key]
        balances[#balances + 1] = named(key) .. ": won " .. score.won .. " lost " .. score.lost .. " drew " .. score.drawn
    end
    if #balances > 0 then
        parts[#parts + 1] = "Observed battle balance in the last four turns (partial record not the whole war): " .. table.concat(balances, " / ")
    end
    local function you(key, name)
        if key == interlocutor then return name .. " (you)" end
        if key == player then return name .. " (the player)" end
        return name
    end
    local changes, talk = {}, {}
    for _, item in ipairs(world.e) do
        if now >= item.t and now - item.t <= 3 and entry_known(item, interlocutor, known)
            and (item.a == interlocutor or item.b == interlocutor or item.x == interlocutor) then
            local text = "turn " .. item.t .. " " .. entry_text(item, english, you)
            if item.c == "news" and #changes < 3 then changes[#changes + 1] = text
            elseif item.c == "gossip" and #talk < 1 then talk[#talk + 1] = text end
        end
    end
    if #changes > 0 then parts[#parts + 1] = "Recent events: " .. table.concat(changes, " / ") end
    if snap then
        local threats = {}
        for key, info in pairs(snap.f) do
            if key ~= interlocutor and key ~= player then
                local p = pair(snap, interlocutor, key)
                -- Hidden aggregate army strength is not intelligence available
                -- to this court. A known enemy is a pressure, not a measured ratio.
                if known[key] and p and p.w then threats[#threats + 1] = {key = key, r = 1, w = true} end
            end
        end
        table.sort(threats, function(x, y) return x.key < y.key end)
        local listed = {}
        for i = 1, math.min(2, #threats) do
            local t = threats[i]
            listed[#listed + 1] = faction_name(t.key) .. " (known enemy; hidden army strength unknown)"
        end
        if #listed > 0 then parts[#parts + 1] = "Threats: " .. table.concat(listed, " / ") end
        local them = snap.f[player]
        if them then
            local facts = {}
            local mine_wars, theirs = {}, {}
            for key in pairs(snap.f) do
                local p, q = pair(snap, interlocutor, key), pair(snap, player, key)
                if key ~= interlocutor and key ~= player and known[key] then
                    if p and p.w and q and q.w then mine_wars[#mine_wars + 1] = faction_name(key) end
                    if allied(p) and q and q.w then theirs[#theirs + 1] = faction_name(key) end
                end
            end
            if #mine_wars > 0 then facts[#facts + 1] = "they are fighting your enemies " .. table.concat(mine_wars, " and ") end
            if #theirs > 0 then facts[#facts + 1] = "they are at war with your allies " .. table.concat(theirs, " and ") end
            if #facts > 0 then parts[#parts + 1] = "About the player: " .. table.concat(facts, " / ") end
        end
    end
    if #talk > 0 then parts[#parts + 1] = "What the courts say about you: " .. talk[1] end
    local text = table.concat(parts, ". ")
    return (string.gsub(text, "[,;|=]", ""))
end

-- Compact, typed evidence for the companion's temporary character mood. Empty
-- history means no OBSERVED battles, never proof of peace or a complete war record.
-- The course of this realm's wars for the companion's mood: heavy defeats in the last
-- four turns, and the overall verdict across all its current wars.
function llmdip_world_war_course(interlocutor)
    if not world then return "none" end
    local turn = safe(nil, function() return cm:model():turn_number() end)
    if not turn then return "none" end
    local heavy = 0
    for _, b in ipairs(world.b) do
        if b.t <= turn and turn - b.t <= 3 then
            local side = contains(b.a, interlocutor) and "a" or (contains(b.d, interlocutor) and "d" or nil)
            if side and heavy_defeat(b, side) then heavy = heavy + 1 end
        end
    end
    local won, lost, bad, good = 0, 0, 0, 0
    for key, r in pairs(world.wl or {}) do
        local me = string.match(key, "^([^>]+)>")
        if me == interlocutor then
            won, lost = won + r.w, lost + r.l
            local verdict = war_verdict(r)
            if verdict == "badly" then bad = bad + 1 elseif verdict == "well" then good = good + 1 end
        end
    end
    local trend = 0
    if bad > good then trend = -1 elseif good > bad then trend = 1 end
    return "heavy:" .. heavy .. "/won:" .. won .. "/lost:" .. lost .. "/trend:" .. trend
end

function llmdip_world_court_signals(interlocutor)
    if not world then return "none" end
    local turn = safe(nil, function() return cm:model():turn_number() end)
    if not turn then return "none" end
    local wins, losses, armies, latest = 0, 0, 0, -1
    for _, b in ipairs(world.b) do
        if b.t <= turn and turn - b.t <= 3 then
            local side = contains(b.a, interlocutor) and "a" or (contains(b.d, interlocutor) and "d" or nil)
            if side and b.w ~= "draw" then
                if side == b.w then wins = wins + 1 else losses = losses + 1 end
                armies = armies + (b.destroyed and b.destroyed[interlocutor] or 0)
                latest = math.max(latest, b.t)
            end
        end
    end
    return "turn:" .. turn .. "/wins:" .. wins .. "/losses:" .. losses .. "/armies:" .. armies
        .. "/latest:" .. latest .. "/window:4"
end

-- ---------------------------------------------------------------------------
-- The player's court report, written by a member of their court (one background
-- call per turn). The game writes a BRIEFING line with the facts; the companion
-- answers through the inbox with llmdip_world_briefing(id, text), the same path and
-- the same wall-clock polling as the letters, so nothing ever waits for the model.
-- ---------------------------------------------------------------------------
local BRIEF_WAIT_SECONDS = 150
local function encode(value)
    return (string.gsub(tostring(value or ""), "([^%w%-%_%.%~ ])", function(c) return string.format("%%%02X", string.byte(c)) end))
end
-- What the ruler's own court knows of the realm, so its advice fits how the realm
-- really stands: treasury, income, lands, field armies, place among the powers, and
-- who the ruler is (the companion adds the curated lore for that ruler).
local function realm_lines(player)
    local me = safe(nil, function() return cm:get_faction(player) end)
    if not usable(me) then return {} end
    local lines = {}
    local leader = safe(nil, function() return me:faction_leader() end)
    if leader and not safe(true, function() return leader:is_null_interface() end) then
        local subtype = safe(nil, function() return leader:character_subtype_key() end)
        local level = safe(nil, function() return leader:rank() end)
        if subtype then lines[#lines + 1] = "Ruler subtype: " .. subtype end
        if level then lines[#lines + 1] = "Ruler level: " .. tostring(level) end
    end
    local treasury = safe(nil, function() return me:treasury() end)
    local income = safe(nil, function() return me:net_income() end)
    if type(treasury) == "number" then
        lines[#lines + 1] = "Treasury: " .. math.floor(treasury) .. " gold"
            .. (type(income) == "number" and (" (net income " .. math.floor(income) .. " a turn)") or "")
    end
    local regions = safe(nil, function() return me:region_list():num_items() end)
    local armies = safe(nil, function()
        local list, n = me:military_force_list(), 0
        for i = 0, list:num_items() - 1 do
            local force = list:item_at(i)
            if not force:is_null_interface() and not force:is_armed_citizenry() then n = n + 1 end
        end
        return n
    end)
    local rank = strength_rank(me)
    lines[#lines + 1] = "Settlements held: " .. tostring(regions or "unknown") .. ". Field armies: " .. tostring(armies or "unknown")
        .. ". Military strength rank: " .. (rank > 0 and tostring(rank) or "unknown") .. " (1 is the strongest power in the world)"
    return lines
end
-- "Disciples of Hashut (a Chaos Dwarfs realm)": the ruler may not know every faction,
-- so the court's facts always say which people a realm belongs to.
local function people_of(key)
    local info = world.snap and world.snap.f[key]
    local sc = info and info.sc or safe(nil, function() return cm:get_faction(key):subculture() end)
    if type(sc) ~= "string" then return nil end
    local loc = "cultures_subcultures_name_" .. sc
    local name = localised(loc)
    if name == loc or name == "" then return nil end
    return name
end
local function realm_with_people(key, name)
    local people = key and people_of(key)
    if not people or name == "" then return name end
    return name .. " (a realm of the " .. people .. ")"
end
local function briefing_facts(snap, player)
    local lines = {}
    local me = safe(nil, function() return cm:get_faction(player) end)
    local leader = me and safe(nil, function() return me:faction_leader() end)
    local ruler = leader and safe(nil, function()
        return localised(leader:get_forename()) .. " " .. localised(leader:get_surname())
    end) or ""
    lines[#lines + 1] = "Ruler: " .. ruler .. " of " .. faction_name(player)
    lines[#lines + 1] = "People: " .. tostring(snap.f[player] and snap.f[player].sc or (me and safe("unknown", function() return me:subculture() end)) or "unknown")
    lines[#lines + 1] = "Turn: " .. tostring(snap.turn)
    for _, line in ipairs(realm_lines(player)) do lines[#lines + 1] = line end
    -- The ruler's own situation, from the same court report the lords get. The fake
    -- second key keeps out the section a lord writes about the player.
    local own = llmdip_world_court_report(player, "")
    if own and own ~= "none" then lines[#lines + 1] = "Your realm: " .. own end
    local known = known_factions(player)
    local recent, talk = {}, {}
    for _, item in ipairs(world.e) do
        if snap.turn - item.t <= 1 and not template_gossip_hidden(item) and entry_known(item, player, known) then
            local text = item.tx or entry_text(item, english, function(key, name)
                if key == player then return name .. " (your realm)" end
                return realm_with_people(key, name)
            end)
            if (item.c == "news" or item.c == "deed") and #recent < 6 then recent[#recent + 1] = text
            elseif item.c == "rumour" and #talk < 4 then
                talk[#talk + 1] = text .. " (spread by " .. realm_with_people(item.a, faction_name(item.a)) .. "; may be false)"
            elseif item.c == "gossip" and #talk < 3 then talk[#talk + 1] = text end
        end
    end
    if #recent > 0 then lines[#lines + 1] = "News your court has learned: " .. table.concat(recent, " / ") end
    if #talk > 0 then lines[#lines + 1] = "Gossip heard at other courts: " .. table.concat(talk, " / ") end
    local rep = world.rep
    if rep then
        local function labelled(list)
            local result = {}
            for _, key in ipairs(list or {}) do
                local label = player_attitude_label(key)
                result[#result + 1] = realm_with_people(key, faction_name(key)) .. (label and (" (" .. label .. ")") or "")
            end
            return table.concat(result, ", ")
        end
        if #(rep.likes or {}) > 0 then lines[#lines + 1] = "Courts that are fond of you (the ruler can already see this in diplomacy): " .. labelled(rep.likes) end
        if #(rep.hates or {}) > 0 then lines[#lines + 1] = "Courts that loathe you (also visible in diplomacy): " .. labelled(rep.hates) end
        if #(rep.fear or {}) > 0 then
            local names = {}
            for _, key in ipairs(rep.fear) do names[#names + 1] = realm_with_people(key, faction_name(key)) end
            lines[#lines + 1] = "Weaker realms hostile to you or at war with you (they have reason to fear your strength): " .. table.concat(names, ", ")
        end
        for _, c in ipairs(rep.common or {}) do
            lines[#lines + 1] = realm_with_people(c.a, faction_name(c.a)) .. " is also at war with your enemy " .. realm_with_people(c.b, faction_name(c.b))
        end
    end
    return table.concat(lines, "\n")
end
function llmdip_world_request_briefing(snap)
    local player = snap.player
    local campaign = cm:get_saved_value("llmdip_campaign_id")
    if not player or type(campaign) ~= "string" or not string.match(campaign, "^[a-z0-9_]+$") then return end
    local id = "brief_" .. snap.turn .. "_" .. tostring(os.time())
    local language = (llmdip_game_language and llmdip_game_language()) or (llmdip_language and llmdip_language()) or "en"
    world.brief = {id = id, t = snap.turn, status = "pending", sent = os.time()}
    out("[LLMDIP] BRIEFING|" .. id .. "|" .. campaign .. "|" .. player .. "|" .. snap.turn .. "|" .. tostring(language)
        .. "|" .. encode(briefing_facts(snap, player)))
end
-- Called from the companion's inbox. Only the briefing this turn asked for is kept; an
-- old answer (another save, an earlier turn) is acknowledged and dropped.
function llmdip_world_briefing(id, text)
    if type(id) ~= "string" then return false end
    out("[LLMDIP] BRIEFING_ACK|" .. id)
    local brief = world and world.brief
    if not brief or brief.id ~= id or type(text) ~= "string" then return false end
    -- The inbox runs every second until the companion reads the acknowledgement, which
    -- can take a few seconds while it writes a letter: a second delivery changes nothing
    -- (it used to add the same report to the court conversation again, 03-10-2026).
    if brief.status == "ready" then return true end
    text = string.gsub(text, "[\r\n]+", " ")
    if #text < 20 or #text > 2400 then brief.status = "failed"; save(); return false end
    brief.text, brief.status = text, "ready"
    -- It is also the court's first word in the conversation with it, so the ruler can
    -- ask about what they were told.
    world.council = world.council or {}
    world.council[#world.council + 1] = {w = "court", x = text, t = brief.t}
    while #world.council > 30 do table.remove(world.council, 1) end
    save()
    if llmdip_mail_redraw then pcall(llmdip_mail_redraw) end
    return true
end
function llmdip_world_briefing_failed(id)
    if type(id) ~= "string" then return false end
    out("[LLMDIP] BRIEFING_ACK|" .. id)
    local brief = world and world.brief
    if brief and brief.id == id and brief.status == "pending" then brief.status = "failed"; save() end
    return true
end

-- ---------------------------------------------------------------------------
-- Talking to your court. The ruler writes in the World tab; the game logs a COUNCIL
-- line with the facts, the last few exchanges and the words; the companion answers
-- as the court's adviser through the inbox. Same path as letters: nothing waits.
-- ---------------------------------------------------------------------------
local MAX_COUNCIL, COUNCIL_WAIT_SECONDS = 30, 150
local council_serial = 0
local function council_add(who, text)
    world.council = world.council or {}
    world.council[#world.council + 1] = {w = who, x = text, t = world.turn}
    while #world.council > MAX_COUNCIL do table.remove(world.council, 1) end
end
function llmdip_council_waiting()
    local wait = world and world.cwait
    if not wait then return false end
    if os.time() - (wait.sent or 0) <= COUNCIL_WAIT_SECONDS then return true end
    -- Nobody answered: say so once, and let the ruler speak again.
    world.cwait = nil
    council_add("note", "council_no_answer")
    save()
    return false
end
function llmdip_council_history()
    local list = {}
    for _, m in ipairs(world and world.council or {}) do list[#list + 1] = {who = m.w, text = m.x, turn = m.t} end
    return list
end
function llmdip_council_send(text)
    if not world or not world.snap or cm:is_multiplayer() or type(text) ~= "string" then return false end
    text = string.gsub(text, "[\r\n]+", " ")
    text = string.match(text, "^%s*(.-)%s*$") or ""
    if #text < 1 or #text > 800 or llmdip_council_waiting() then return false end
    local campaign = cm:get_saved_value("llmdip_campaign_id")
    if type(campaign) ~= "string" or not string.match(campaign, "^[a-z0-9_]+$") then return false end
    local player = world.snap.player
    local turn = safe(world.turn, function() return cm:model():turn_number() end)
    council_serial = council_serial + 1
    local id = "council_" .. turn .. "_" .. tostring(os.time()) .. "_" .. council_serial
    local talk, list = {}, world.council or {}
    for i = math.max(1, #list - 5), #list do
        local m = list[i]
        if m.w == "you" then talk[#talk + 1] = "Ruler: " .. string.sub(m.x, 1, 400)
        elseif m.w == "court" then talk[#talk + 1] = "You: " .. string.sub(m.x, 1, 400) end
    end
    local facts = briefing_facts(world.snap, player)
    local brief = world.brief
    if brief and brief.status == "ready" and type(brief.text) == "string" then
        facts = facts .. "\nYour briefing to the ruler this turn: " .. brief.text
    end
    local letters = llmdip_mail_recent and safe(nil, function() return llmdip_mail_recent(3) end)
    if type(letters) == "string" and letters ~= "" then facts = facts .. "\nRecent letters to the ruler: " .. letters end
    council_add("you", text)
    world.cwait = {id = id, sent = os.time()}
    save()
    local language = (llmdip_game_language and llmdip_game_language()) or (llmdip_language and llmdip_language()) or "en"
    out("[LLMDIP] COUNCIL|" .. id .. "|" .. campaign .. "|" .. player .. "|" .. turn .. "|" .. tostring(language)
        .. "|" .. encode(facts) .. "|" .. encode(table.concat(talk, "\n")) .. "|" .. encode(text))
    return true
end
function llmdip_world_council_reply(id, text)
    if type(id) ~= "string" then return false end
    out("[LLMDIP] COUNCIL_ACK|" .. id)
    local wait = world and world.cwait
    if not wait or wait.id ~= id or type(text) ~= "string" then return false end
    world.cwait = nil
    text = string.gsub(text, "[\r\n]+", " ")
    if #text < 2 or #text > 3000 then council_add("note", "council_no_answer")
    else council_add("court", text) end
    save()
    if llmdip_mail_redraw then pcall(llmdip_mail_redraw) end
    return true
end
function llmdip_world_council_failed(id)
    if type(id) ~= "string" then return false end
    out("[LLMDIP] COUNCIL_ACK|" .. id)
    local wait = world and world.cwait
    if wait and wait.id == id then
        world.cwait = nil; council_add("note", "council_no_answer"); save()
        if llmdip_mail_redraw then pcall(llmdip_mail_redraw) end
    end
    return true
end

-- The player's own court report for the World tab: what a member of their court wrote
-- this turn. While it is being written, a short notice; without a companion, nothing.
-- The attitudes the game already shows are not repeated here (they sit next to each
-- name in 'Who can write to me').
function llmdip_world_report()
    local brief = world and world.brief
    if not brief or brief.t ~= world.turn then return nil end
    if brief.status == "ready" and type(brief.text) == "string" then
        return {turn = brief.t, lines = {brief.text}, text = brief.text}
    end
    if brief.status == "pending" and os.time() - (brief.sent or 0) <= BRIEF_WAIT_SECONDS then
        return {turn = brief.t, lines = {llmdip_t("brief_pending")}, text = llmdip_t("brief_pending"), pending = true}
    end
    return nil
end

-- The old data-only report, kept for the tests and the briefing facts.
function llmdip_world_report_data()
    local rep = world and world.rep
    if not rep then return nil end
    -- Fond and hateful realms carry the label the game itself shows for their
    -- attitude toward you ("Muy amistosa", "Hostile"), in your language.
    local function names(list, labelled)
        local result = {}
        for _, key in ipairs(list or {}) do
            local label = labelled and player_attitude_label(key) or nil
            result[#result + 1] = label and (faction_name(key) .. " (" .. label .. ")") or faction_name(key)
        end
        return table.concat(result, ", ")
    end
    local lines = {}
    if #(rep.likes or {}) > 0 then lines[#lines + 1] = fill(llmdip_t("report_likes"), {list = names(rep.likes, true)}) end
    if #(rep.hates or {}) > 0 then lines[#lines + 1] = fill(llmdip_t("report_hates"), {list = names(rep.hates, true)}) end
    if #(rep.fear or {}) > 0 then lines[#lines + 1] = fill(llmdip_t("report_fear"), {list = names(rep.fear)}) end
    for _, c in ipairs(rep.common or {}) do lines[#lines + 1] = fill(llmdip_t("report_common"), {a = faction_name(c.a), b = faction_name(c.b)}) end
    if #lines == 0 then lines[1] = llmdip_t("report_quiet") end
    return {turn = rep.t, lines = lines, text = table.concat(lines, " ")}
end

-- ---------------------------------------------------------------------------
-- The council of courts (docs/PLAN_CONSEJO_DE_CORTES.md). At the start of the
-- player's turn the game sends one COURTS line with what each enabled court can know;
-- the companion answers with each court's private dispatch: its mood, its plans, a
-- grievance and the rumour it wants spread. Back here, still in the player's turn
-- (the inbox is only read then), the rumours are published and whispered to the
-- courts that would hear them, and up to two plans between AI realms become real
-- treaties or wars, checked against the game first. Plans aimed at the player turn
-- into the reason for that lord's next letter. Nothing here runs in the AI's turns.
-- ---------------------------------------------------------------------------
local MAX_COURTS, COURTS_WAIT_SECONDS, MAX_FACTS = 8, 180, 11000
local MAX_DEEDS, DEED_COOLDOWN = 2, 8
local AI_PLAN = {ally = true, war = true, peace = true, trade = true, nap = true}
local PLAYER_PLAN = {ask_player_help = true, offer_player = true, threaten_player = true,
    court_player = true, warn_player = true, complain_to_player = true}
local OTHER_PLAN = {consolidate = true}
local MOODS = {confident = true, worried = true, furious = true, grieving = true, vengeful = true,
    triumphant = true, scheming = true, fearful = true, content = true, ambitious = true}
local RUMOUR_KINDS = {romance = true, betrayal = true, jealousy = true, contempt = true, servility = true,
    ambition = true, scheme = true, praise = true, warning = true, scandal = true}
local PLAN_WORDS = {
    ally = "seek an alliance with %s", war = "prepare war against %s", peace = "seek peace with %s",
    trade = "seek a trade agreement with %s", nap = "seek a non-aggression pact with %s",
    ask_player_help = "ask the player for help", offer_player = "make the player an offer",
    threaten_player = "press or threaten the player", court_player = "win the player's favour",
    warn_player = "warn the player", complain_to_player = "complain to the player",
    consolidate = "consolidate and rebuild"}

local function clip(value, limit)
    if type(value) ~= "string" then return nil end
    value = string.gsub(value, "[\r\n]+", " ")
    value = string.match(value, "^%s*(.-)%s*$") or ""
    if value == "" then return nil end
    if #value > limit then value = string.sub(value, 1, limit) end
    return value
end
local function tagged(key) return faction_name(key) .. " [" .. key .. "]" end
-- Other realms with their rulers, so a rumour never gives a character the wrong realm.
local function ruled(snap, key)
    local realm, ruler = faction_name(key), leader_name(leader_of(snap, key), key)
    if ruler == "" or ruler == realm then return tagged(key) end
    return ruler .. " of " .. tagged(key)
end

-- The enabled courts this turn: at war with the player first, then allies, then the
-- strongest. Only realms the player has met and can hear from.
local function council_realms(snap)
    local list = {}
    for key, info in pairs(snap.f) do
        if key ~= snap.player and info.m and not info.h
            and llmdip_is_contact_enabled and safe(false, function() return llmdip_is_contact_enabled(key) end) then
            local p = pair(snap, snap.player, key)
            local weight = (p and p.w) and 3 or (allied(p) and 2 or 1)
            list[#list + 1] = {key = key, w = weight, r = (info.r and info.r > 0) and info.r or 999}
        end
    end
    table.sort(list, function(x, y)
        if x.w ~= y.w then return x.w > y.w end
        if x.r ~= y.r then return x.r < y.r end
        return x.key < y.key
    end)
    local result = {}
    for i = 1, math.min(#list, MAX_COURTS) do result[i] = list[i].key end
    return result
end

local function power_words(snap, a, b)
    local sa, sb = snap.f[a] and snap.f[a].s or 0, snap.f[b] and snap.f[b].s or 0
    if sa <= 0 or sb <= 0 then return "strength unknown" end
    local ratio = sb / sa
    if ratio >= 1.2 then return string.format("about %.1f times as strong as you", ratio) end
    if ratio <= 1 / 1.2 then return string.format("you are about %.1f times as strong", 1 / ratio) end
    return "roughly your equal"
end

local function live_relation(fa, fb)
    return {
        war = safe(false, function() return fa:at_war_with(fb) end) == true,
        allied = safe(false, function() return fa:military_allies_with(fb) or fa:defensive_allies_with(fb) end) == true,
        nap = safe(false, function() return fa:non_aggression_pact_with(fb) end) == true,
        trade = safe(false, function() return fa:trade_agreement_with(fb) end) == true,
        vassal = safe(false, function() return fa:is_vassal_of(fb) or fb:is_vassal_of(fa) end) == true}
end
local function wants(key, kind, target)
    local d = world.dsp and world.dsp[key]
    for _, plan in ipairs(d and d.plans or {}) do if plan.d == kind and plan.t == target then return true end end
    return false
end
local function at_war_count(snap, key)
    local n = 0
    for other in pairs(snap.f) do local p = pair(snap, key, other); if p and p.w then n = n + 1 end end
    return n
end
local function lore_enemies(snap, a, b)
    local la, lb = snap.f[a] and snap.f[a].l, snap.f[b] and snap.f[b].l
    for _, tie in ipairs(LORE_PAIRS) do
        if (tie[1] == la and tie[2] == lb) or (tie[1] == lb and tie[2] == la) then
            return tie[3] == "hatred" or tie[3] == "rivalry"
        end
    end
    return false
end

-- Is this plan sane right now? The game decides, not the model: the treaty must not
-- exist yet, the war must be winnable and have a motive, the other side must be willing.
local function plan_allowed(snap, kind, a, b, rel)
    local th = snap.th or DEFAULT_BANDS
    local ab, ba = att(snap, a, b), att(snap, b, a)
    if kind == "war" then
        if rel.war or rel.allied or rel.nap or rel.vassal then return false end
        -- Never a war that would drag in the player: not against their allies or vassals.
        local with_player = pair(snap, snap.player, b)
        if with_player and (allied(with_player) or with_player.v) then return false end
        local sa, sb = snap.f[a].s or 0, snap.f[b].s or 0
        if sa <= 0 or sa < sb * 0.8 or at_war_count(snap, a) > 2 then return false end
        local grievance = world.dsp[a] and world.dsp[a].gr and world.dsp[a].gr.t == b
        return ab <= th.h or grievance or lore_enemies(snap, a, b)
    elseif kind == "peace" then
        if not rel.war then return false end
        local r = world.wl and world.wl[a .. ">" .. b]
        return wants(b, "peace", a) or (r ~= nil and war_verdict(r) == "badly" and ba > th.hd)
    elseif kind == "ally" then
        if rel.war or rel.allied or rel.vassal then return false end
        return (ab >= th.f and ba >= th.f) or (wants(b, "ally", a) and ab >= 0 and ba >= 0)
    elseif kind == "trade" then
        return not rel.war and not rel.trade and ab > th.h and ba > th.h
    elseif kind == "nap" then
        return not rel.war and not rel.nap and not rel.allied and ab > th.h and ba > th.h
    end
    return false
end
-- What one court can know, in English: its realm, power, treaties, feelings, how its
-- wars go, the player, its old personal ties, what it thought last turn and what it heard.
local function realm_facts(snap, key)
    local info, player = snap.f[key], snap.player
    local known = known_factions(key)
    local th = snap.th or DEFAULT_BANDS
    local lines = {"#REALM " .. key}
    lines[#lines + 1] = "Realm: " .. realm_with_people(key, faction_name(key)) .. " [" .. key .. "]. Ruler: "
        .. leader_name(leader_of(snap, key), key) .. (info.l and (" (" .. info.l .. ")") or "")
    lines[#lines + 1] = "Power: strength rank " .. ((info.r or 0) > 0 and tostring(info.r) or "unknown")
        .. " (1 is the strongest in the world); " .. tostring(info.n or 0) .. " settlements."
    local wars, allies, pacts, trades, fond, dislike = {}, {}, {}, {}, {}, {}
    local others = {}
    for other in pairs(snap.f) do if other ~= key and other ~= player and known[other] then others[#others + 1] = other end end
    table.sort(others)
    for _, other in ipairs(others) do
        local p = pair(snap, key, other)
        local label = ruled(snap, other) .. " (" .. power_words(snap, key, other) .. ")"
        if p and p.w then wars[#wars + 1] = label
        elseif allied(p) then allies[#allies + 1] = label
        else
            if p and p.n then pacts[#pacts + 1] = tagged(other) end
            local feeling = att(snap, key, other)
            if feeling >= th.f then fond[#fond + 1] = label
            elseif feeling <= th.h then dislike[#dislike + 1] = label end
        end
        if p and p.t then trades[#trades + 1] = tagged(other) end
    end
    local function list_or(items, none) return #items > 0 and table.concat(items, ", ") or none end
    lines[#lines + 1] = "At war with: " .. list_or(wars, "nobody") .. "."
    lines[#lines + 1] = "Allies: " .. list_or(allies, "none") .. ". Non-aggression pacts: " .. list_or(pacts, "none")
        .. ". Trade with: " .. list_or(trades, "none") .. "."
    if #fond > 0 then lines[#lines + 1] = "Fond of: " .. table.concat(fond, ", ") .. "." end
    if #dislike > 0 then lines[#lines + 1] = "Dislikes: " .. table.concat(dislike, ", ") .. "." end
    local p = pair(snap, key, player)
    local relation = (p and p.w) and "at war with you" or (allied(p) and "allied with you")
        or ((p and p.n) and "bound by a non-aggression pact" or "at peace")
    local label = player_attitude_label(key)
    lines[#lines + 1] = "The player, " .. ruled(snap, player) .. ": " .. relation .. "; your attitude toward them: "
        .. (label or "unknown") .. "; the player is " .. power_words(snap, key, player) .. "."
    if option("treaties") then
        local moves = {ally = {}, war = {}, peace = {}, trade = {}, nap = {}}
        for _, other in ipairs(others) do
            local q = pair(snap, key, other) or {}
            local rel = {war = q.w == 1, allied = allied(q), nap = q.n == 1, trade = q.t == 1, vassal = q.v ~= nil}
            for kind in pairs(moves) do
                if #moves[kind] < 4 and plan_allowed(snap, kind, key, other, rel) then moves[kind][#moves[kind] + 1] = other end
            end
        end
        local offered = {}
        for _, kind in ipairs({"ally", "nap", "trade", "peace", "war"}) do
            if #moves[kind] > 0 then offered[#offered + 1] = kind .. " with " .. table.concat(moves[kind], ", ") end
        end
        lines[#lines + 1] = "Moves the game would accept now (realm keys): " .. (#offered > 0 and table.concat(offered, "; ") or "none") .. "."
    end
    for war_key, r in pairs(world.wl or {}) do
        local me, foe = string.match(war_key, "^([^>]+)>(.+)$")
        if me == key and foe and known[foe] then
            local verdict = war_verdict(r)
            lines[#lines + 1] = "War against " .. faction_name(foe) .. ": " .. r.w .. " battles won, " .. r.l .. " lost"
                .. (verdict == "badly" and " - going badly for you" or (verdict == "well" and " - going well for you" or ""))
        end
    end
    local recent = {}
    for _, item in ipairs(world.e) do
        if #recent >= 2 then break end
        if snap.turn - item.t <= 3 and (item.a == key or item.b == key) and item.c ~= "rumour" then
            local ok, text = pcall(function() return item.tx or entry_text(item, english) end)
            if ok and text then recent[#recent + 1] = "turn " .. item.t .. ": " .. text end
        end
    end
    if #recent > 0 then lines[#lines + 1] = "Recent: " .. table.concat(recent, " / ") end
    if info.l then
        for _, tie in ipairs(LORE_PAIRS) do
            local partner = tie[1] == info.l and tie[2] or (tie[2] == info.l and tie[1] or nil)
            if partner then
                for other, o in pairs(snap.f) do
                    if o.l == partner and other ~= key then
                        lines[#lines + 1] = "Old personal tie (" .. tie[3] .. "): " .. person(leader_of(snap, other), other) .. " [" .. other .. "]"
                    end
                end
            end
        end
    end
    local last = world.dsp and world.dsp[key]
    if last and snap.turn - (last.t or -99) <= 3 then
        local plans = {}
        for _, plan in ipairs(last.plans or {}) do
            local target = plan.t == "player" and "the player" or faction_name(plan.t or "")
            plans[#plans + 1] = string.format(PLAN_WORDS[plan.d] or plan.d, target)
        end
        lines[#lines + 1] = "Your court on turn " .. last.t .. ": " .. tostring(last.mood or "?") .. "; "
            .. tostring(last.stance or "") .. (#plans > 0 and (" Plans: " .. table.concat(plans, "; ") .. ".") or "")
    end
    for _, heard in ipairs(world.heard and world.heard[key] or {}) do
        lines[#lines + 1] = "Heard (a rumour spread by " .. tagged(heard.by) .. ", may be false): " .. heard.x
    end
    return table.concat(lines, "\n")
end

function llmdip_world_request_courts(snap)
    local campaign = cm:get_saved_value("llmdip_campaign_id")
    if not snap or not snap.player or type(campaign) ~= "string" or not string.match(campaign, "^[a-z0-9_]+$") then return false end
    local realms = council_realms(snap)
    if #realms == 0 then return false end
    local header = {
        "Player: " .. tagged(snap.player) .. ", ruled by " .. leader_name(leader_of(snap, snap.player), snap.player),
        "Turn: " .. snap.turn,
        "Romance rumours: " .. (option("romance") and "allowed" or "not allowed"),
        "Treaties and wars between AI realms: " .. (option("treaties") and "allowed" or "not allowed")}
    local blocks, size, used = {}, #table.concat(header, "\n"), {}
    for _, key in ipairs(realms) do
        local ok, text = pcall(realm_facts, snap, key)
        if ok and type(text) == "string" and size + #text + 1 <= MAX_FACTS then
            blocks[#blocks + 1] = text; size = size + #text + 1; used[#used + 1] = key
        end
    end
    if #used == 0 then return false end
    local id = "courts_" .. snap.turn .. "_" .. tostring(os.time())
    local language = (llmdip_game_language and llmdip_game_language()) or (llmdip_language and llmdip_language()) or "en"
    world.courts = {id = id, t = snap.turn, status = "pending", sent = os.time(), realms = used}
    -- The ruler's briefing waits for the courts, so it can tell what they did.
    world.brief = {t = snap.turn, status = "pending", sent = os.time(), courts = true}
    out("[LLMDIP] COURTS|" .. id .. "|" .. campaign .. "|" .. snap.player .. "|" .. snap.turn .. "|" .. tostring(language)
        .. "|" .. encode(table.concat(header, "\n") .. "\n" .. table.concat(blocks, "\n")))
    return true
end

-- The campaign codex (src/codex.js): once a turn the companion gets every realm of the
-- scan with its names as this game shows them, in the player's language, so a name in
-- a conversation can bring in who that realm and its ruler are. Public facts only.
function llmdip_world_send_codex(snap)
    local campaign = cm:get_saved_value("llmdip_campaign_id")
    if not snap or type(campaign) ~= "string" or not string.match(campaign, "^[a-z0-9_]+$") then return false end
    local rows = {}
    local keys = {}
    for key in pairs(snap.f) do keys[#keys + 1] = key end
    table.sort(keys)
    local function field(value) return (string.gsub(tostring(value or ""), "[\t\n\r]", " ")) end
    for _, key in ipairs(keys) do
        local info = snap.f[key]
        rows[#rows + 1] = table.concat({key, field(faction_name(key)), field(people_of(key) or ""), field(info.sc or ""),
            field(leader_name(leader_of(snap, key), key)), field(info.l or ""), tostring(info.r or 0), tostring(info.n or 0),
            info.h and "player" or ""}, "\t")
    end
    local language = (llmdip_game_language and llmdip_game_language()) or (llmdip_language and llmdip_language()) or "en"
    out("[LLMDIP] CODEX|" .. campaign .. "|" .. snap.player .. "|" .. snap.turn .. "|" .. tostring(language)
        .. "|" .. encode(table.concat(rows, "\n")))
    return true
end

-- The turn's requests: the council first (it asks for the briefing when it is done),
-- or the briefing alone when no court can be asked.
function llmdip_world_start_turn_requests(snap)
    pcall(llmdip_world_send_codex, snap)
    local asked = llmdip_world_request_courts(snap)
    if not asked then pcall(llmdip_world_request_briefing, snap) end
    return asked
end

-- Who hears each rumour: the courts asked this turn that know its author and are its
-- subject, or are at war or allied with one of its subjects. Three at most per court.
local function whispers(snap, rumours, realms)
    local heard, known = {}, {}
    for _, key in ipairs(realms) do known[key] = known_factions(key) end
    for _, r in ipairs(rumours) do
        for _, key in ipairs(realms) do
            if key ~= r.by and known[key][r.by] then
                local reaches = false
                for _, subject in ipairs(r.about) do
                    local p = pair(snap, key, subject)
                    if subject == key or (p and (p.w or allied(p))) then reaches = true end
                end
                heard[key] = heard[key] or {}
                if reaches and #heard[key] < 3 then heard[key][#heard[key] + 1] = {x = r.x, by = r.by, t = r.t} end
            end
        end
    end
    return heard
end

local function perform(kind, a, b)
    return pcall(function()
        if kind == "war" then cm:force_declare_war(a, b, false, false)
        elseif kind == "peace" then cm:force_make_peace(a, b)
        elseif kind == "ally" then cm:force_alliance(a, b, false)
        elseif kind == "trade" then cm:force_make_trade_agreement(a, b)
        elseif kind == "nap" then cm:force_non_aggression_pact(a, b) end
    end)
end
local function deed_visible(kind, rel)
    if kind == "war" then return rel.war end
    if kind == "peace" then return not rel.war end
    if kind == "ally" then return rel.allied end
    if kind == "trade" then return rel.trade end
    if kind == "nap" then return rel.nap end
    return false
end

-- Up to two plans between AI realms become real this turn. Never against or for the
-- player: plans about the player become letters, which the player can always refuse.
local function act_on_plans(snap, turn)
    local entries = {}
    if not option("treaties") then return entries end
    local candidates = {}
    for key, d in pairs(world.dsp or {}) do
        if d.t == turn then
            for _, plan in ipairs(d.plans or {}) do
                if AI_PLAN[plan.d] then candidates[#candidates + 1] = {a = key, plan = plan} end
            end
        end
    end
    -- Peace and alliances before wars; the order is stable for the same dispatches.
    local ORDER = {peace = 1, ally = 2, nap = 3, trade = 4, war = 5}
    table.sort(candidates, function(x, y)
        if x.plan.d ~= y.plan.d then return ORDER[x.plan.d] < ORDER[y.plan.d] end
        return x.a < y.a
    end)
    local acted, wars = {}, 0
    for _, c in ipairs(candidates) do
        if #entries >= MAX_DEEDS then break end
        local a, b, kind = c.a, c.plan.t, c.plan.d
        local fa = safe(nil, function() return cm:get_faction(a) end)
        local fb = b and safe(nil, function() return cm:get_faction(b) end)
        local ok = b and b ~= a and not acted[a] and snap.f[b] and not is_player(snap, a) and not is_player(snap, b)
            and usable(fa) and usable(fb)
            and not safe(true, function() return fa:is_human() or fb:is_human() end)
            and not (kind == "war" and wars >= 1)
            and not on_cooldown("deed", a, b, turn, DEED_COOLDOWN)
            and known_factions(a)[b]
        local rel = ok and live_relation(fa, fb)
        if ok and plan_allowed(snap, kind, a, b, rel) then
            local called = perform(kind, a, b)
            local visible = called and deed_visible(kind, live_relation(fa, fb))
            out("[LLMDIP] COURT_DEED|" .. kind .. "|" .. a .. "|" .. b .. "|called=" .. tostring(called) .. "|visible=" .. tostring(visible))
            if called then
                acted[a] = true
                if kind == "war" then wars = wars + 1 end
                set_cooldown("deed", a, b, turn)
                world.forced[pair_key(a, b)] = turn
                world.tc[a], world.tc[b] = turn, turn
                local entry = {t = turn, c = "deed", k = kind, a = a, b = b, tx = c.plan.an, i = kind == "war" and 6 or 5}
                if visible then entries[#entries + 1] = entry
                else world.pdeed = world.pdeed or {}; world.pdeed[#world.pdeed + 1] = entry end
            end
        end
    end
    return entries
end

-- A deed the game had not shown yet when it was done: announced once it is real.
function llmdip_world_check_deeds(turn)
    local found, keep = {}, {}
    for _, entry in ipairs(world.pdeed or {}) do
        local fa = safe(nil, function() return cm:get_faction(entry.a) end)
        local fb = safe(nil, function() return cm:get_faction(entry.b) end)
        if usable(fa) and usable(fb) and deed_visible(entry.k, live_relation(fa, fb)) then
            found[#found + 1] = entry
        elseif turn - entry.t < 1 then
            keep[#keep + 1] = entry
        end
    end
    world.pdeed = keep
    return found
end

-- The companion's answer. Only the request of this very turn is used; anything else is
-- acknowledged and dropped.
function llmdip_world_courts(id, list)
    if type(id) ~= "string" then return false end
    out("[LLMDIP] COURTS_ACK|" .. id)
    local req = world and world.courts
    if not req or req.id ~= id or req.status ~= "pending" or type(list) ~= "table" or not world.snap then return false end
    local snap = world.snap
    local turn = safe(nil, function() return cm:model():turn_number() end)
    if turn ~= req.t then req.status = "stale"; save(); return false end
    req.status = "ready"
    local allowed = {}
    for _, key in ipairs(req.realms or {}) do allowed[key] = true end
    world.dsp = world.dsp or {}
    local rumours, added = {}, {}
    local rank, writers = {}, 0
    for i, key in ipairs(req.realms or {}) do rank[key] = i end
    table.sort(list, function(x, y) return (rank[x.f] or 99) < (rank[y.f] or 99) end)
    for _, d in ipairs(list) do
        if type(d) == "table" and type(d.f) == "string" and allowed[d.f] then
            local entry = {t = turn, mood = MOODS[d.mood] and d.mood or "content", stance = clip(d.stance, 200) or "", plans = {}}
            for _, plan in ipairs(type(d.plans) == "table" and d.plans or {}) do
                if #entry.plans < 2 and type(plan) == "table" and type(plan.d) == "string" then
                    local target = plan.t
                    local good = (AI_PLAN[plan.d] and type(target) == "string" and snap.f[target] ~= nil and target ~= d.f)
                        or (PLAYER_PLAN[plan.d] and target == "player" and writers < 2) or OTHER_PLAN[plan.d]
                    if good then
                        if PLAYER_PLAN[plan.d] then writers = writers + 1 end
                        entry.plans[#entry.plans + 1] = {d = plan.d, t = target, why = clip(plan.why, 160), an = clip(plan.an, 260)}
                    end
                end
            end
            if type(d.gr) == "table" and (d.gr.t == "player" or (type(d.gr.t) == "string" and snap.f[d.gr.t])) then
                entry.gr = {t = d.gr.t, why = clip(d.gr.why, 160)}
            end
            world.dsp[d.f] = entry
            local r = d.r
            if type(r) == "table" and RUMOUR_KINDS[r.k] and not (r.k == "romance" and not option("romance")) then
                local text, about = clip(r.tx, 260), {}
                for _, key in ipairs(type(r.about) == "table" and r.about or {}) do
                    if #about < 2 and type(key) == "string" and snap.f[key] then about[#about + 1] = key end
                end
                if text and #text >= 20 and #about > 0 then
                    rumours[#rumours + 1] = {by = d.f, about = about, x = text, t = turn}
                    added[#added + 1] = {t = turn, c = "rumour", k = r.k, a = d.f, b = about[1], x = about[2], tx = text, i = 4}
                end
            end
        end
    end
    world.heard = whispers(snap, rumours, req.realms or {})
    for _, entry in ipairs(act_on_plans(snap, turn)) do table.insert(added, 1, entry) end
    for i = #added, 1, -1 do table.insert(world.e, 1, added[i]) end
    while #world.e > MAX_ENTRIES do table.remove(world.e) end
    world.cok = turn
    save()
    out("[LLMDIP] COURTS_DONE|" .. id .. "|dispatches=" .. #list .. "|rumours=" .. #rumours .. "|entries=" .. #added)
    pcall(llmdip_world_request_briefing, snap)
    save()
    if llmdip_mail_redraw then pcall(llmdip_mail_redraw) end
    return true
end
function llmdip_world_courts_failed(id)
    if type(id) ~= "string" then return false end
    out("[LLMDIP] COURTS_ACK|" .. id)
    local req = world and world.courts
    if req and req.id == id and req.status == "pending" then
        req.status = "failed"
        pcall(llmdip_world_request_briefing, world.snap)
        save()
    end
    return true
end
-- Called every second from the inbox poll, which only runs in the player's turn.
function llmdip_world_tick()
    local req = world and world.courts
    if req and req.status == "pending" and os.time() - (req.sent or 0) > COURTS_WAIT_SECONDS then
        req.status = "timeout"
        out("[LLMDIP] COURTS_TIMEOUT|" .. tostring(req.id))
        if world.snap then pcall(llmdip_world_request_briefing, world.snap) end
        save()
    end
end

-- What a lord's court thought this turn, for their letters and conversations (English).
function llmdip_world_dispatch(interlocutor)
    local d = world and world.dsp and world.dsp[interlocutor]
    if not d or (world.turn or 0) - (d.t or -99) > 1 then return "none" end
    local parts = {"mood " .. tostring(d.mood)}
    if d.stance and d.stance ~= "" then parts[#parts + 1] = "how you see things: " .. d.stance end
    for _, plan in ipairs(d.plans or {}) do
        local target = plan.t == "player" and "the player" or faction_name(plan.t or "")
        parts[#parts + 1] = "you decided to " .. string.format(PLAN_WORDS[plan.d] or plan.d, target)
            .. (plan.why and (" (" .. plan.why .. ")") or "")
    end
    if d.gr then
        parts[#parts + 1] = "grievance against " .. (d.gr.t == "player" and "the player" or faction_name(d.gr.t)) .. (d.gr.why and (": " .. d.gr.why) or "")
    end
    for _, item in ipairs(world.e) do
        if item.c == "deed" and item.a == interlocutor and item.t == d.t and item.tx then
            parts[#parts + 1] = "this turn your realm did it: " .. item.tx
        end
    end
    for _, heard in ipairs(world.heard and world.heard[interlocutor] or {}) do
        parts[#parts + 1] = "you heard a rumour spread by " .. faction_name(heard.by) .. " (may be false): " .. heard.x
    end
    return table.concat(parts, " / ")
end

-- A plan aimed at the player becomes the reason for that lord's next letter, once.
function llmdip_world_letter_motive(key)
    local d = world and world.dsp and world.dsp[key]
    if not d or d.t ~= world.turn or d.used then return nil end
    for _, plan in ipairs(d.plans or {}) do
        if PLAYER_PLAN[plan.d] then
            return "YOUR COURT DECIDED THIS TURN to " .. string.format(PLAN_WORDS[plan.d], "the player")
                .. (plan.why and (" because " .. plan.why) or "") .. ". This is a real reason to write: write about it, in character and within your power."
        end
    end
    return nil
end
function llmdip_world_motive_used(key)
    local d = world and world.dsp and world.dsp[key]
    if d then d.used = true; save() end
end

cm:add_first_tick_callback(function()
    local stored = cm:get_saved_value(KEY)
    world = type(stored) == "table" and stored.v == 1 and stored or fresh()
    for _, field in ipairs({"e", "hist", "ah", "cap", "cd", "b", "cr", "tc", "forced", "opt", "wl", "qids", "dsp", "heard", "pdeed"}) do if type(world[field]) ~= "table" then world[field] = {} end end
    -- Saves from before the fix kept the same court report several times in a row.
    if type(world.council) == "table" then
        local kept = {}
        for _, m in ipairs(world.council) do
            local last = kept[#kept]
            if not (last and last.w == m.w and last.x == m.x) then kept[#kept + 1] = m end
        end
        world.council = kept
    end
    local queued = cm:get_saved_value(BATTLE_QUEUE_KEY)
    battle_queue = {}
    if type(queued) == "table" then for _, item in ipairs(queued) do battle_queue[#battle_queue + 1] = item end end
    multiplayer = cm:is_multiplayer()
    player_phase = false
    if multiplayer then return end
    local player = cm:get_local_faction(true)
    if not player or safe(true, function() return player:is_null_interface() end) then return end
    cm:add_faction_turn_start_listener_by_name("llmdip_world_turn", player:name(), function()
        player_phase = true
        pcall(llmdip_world_flush_battles)
        llmdip_world_scan()
    end, true)
    if safe(false, function() return cm:is_local_players_turn() end) then
        player_phase = true
        pcall(llmdip_world_flush_battles)
        local scanned_before = world.turn
        llmdip_world_scan()
        -- Loaded mid-turn with no briefing yet (say the companion was started late):
        -- ask the court again; the game keeps playing meanwhile.
        local brief, turn = world.brief, safe(nil, function() return cm:model():turn_number() end)
        if scanned_before == turn and world.snap and world.snap.turn == turn
            and not (brief and brief.t == turn and brief.status == "ready") then
            -- The council first if it was not asked this turn; a council still pending
            -- is left to answer (or time out) on its own.
            local courts = world.courts
            local asked
            if not (courts and courts.t == turn) then asked = pcall(llmdip_world_start_turn_requests, world.snap)
            elseif courts.status ~= "pending" then asked = pcall(llmdip_world_request_briefing, world.snap) end
            if asked then save() end
        end
    end
end)
