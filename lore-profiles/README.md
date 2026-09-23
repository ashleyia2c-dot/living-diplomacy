# Lore profiles

The companion checks `<faction_key>.json` first, then `<leader_subtype_key>.json`.
On first contact, it copies the profile to `data/campaigns/<campaign>/<faction>/leaders/<leader-subtype>.json`.
This lets a new leader have a distinct voice without erasing the faction's diplomatic memories.

Use brief summaries and canonical sources. Do not copy entire pages or protected text.
`canonNotes` contains facts; `voiceNotes` describes speaking style, priorities, and taboos.
