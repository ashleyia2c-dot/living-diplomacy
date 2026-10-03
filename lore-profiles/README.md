# Perfiles de lore

Un JSON por lord legendario, con el nombre de su *agent subtype* (`wh3_main_cth_miao_ying.json`).
El companion busca primero el del lord y después `<faction_key>.json`, para que un sucesor no
herede la voz del lord anterior. Al primer contacto copia el perfil a
`data/campaigns/<campaign>/<faction>/leaders/<leader-subtype>.json`, pero **el perfil de esta
carpeta manda** sobre esa copia: los lords conocidos antes de tener perfil también lo reciben.

- `canonNotes`: hechos del personaje, resumidos con palabras propias (no copiar texto del juego
  ni de libros).
- `voiceNotes`: forma de hablar, prioridades y tabúes.
- `temperament` (0-100): aggression, caution, pride, greed, honour. Sustituye a los valores
  generados al azar a partir del nombre.
- `socialStyle` (0-100): warmth, sociability, generosity, vanity, spite, opportunism.
- `voiceGender`, `ttsInstructions`, `sources`.

Los perfiles de los lords legendarios se generan con `scripts/lore/build_profiles.py` a partir de
`scripts/lore/part1-3.py`; edita allí y vuelve a ejecutarlo. Base: el lore de la unidad de cada
lord dentro de Total War: WARHAMMER III (resumido) y el trasfondo de Warhammer Fantasy; los lords
del DLC más reciente (dlc29) solo usan el texto del juego.
