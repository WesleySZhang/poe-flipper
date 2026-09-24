# Path of Exile knowledge skills

Domain knowledge about Path of Exile (PoE), packaged as skills so it loads only when relevant. Kept
apart from `.claude/skills/`, which holds this app's own workflow skills (run the app, check the
precompute job, ...). Nothing here is app code.

## Layout

```
poe-knowledge/
  .claude-plugin/plugin.json   plugin manifest (makes this directory loadable as a plugin)
  TEMPLATE.md                  copy this to start a new skill
  skills/<skill-name>/SKILL.md one skill per topic
```

## Using them

Claude Code only auto-discovers skills in `.claude/skills/` or an enabled plugin. Either:

- run with the plugin: `claude --plugin-dir ./poe-knowledge` (skills appear as `poe-knowledge:<name>`), or
- copy/symlink a skill folder into `.claude/skills/` to use it in this project directly.

## Conventions

1. **One topic per skill.** A skill answers one kind of question. Split before it passes ~150 lines.
2. **The `description` is the trigger.** It says *when* to use the skill in one or two sentences,
   naming the concrete situations ("pricing a divination card flip", "a category looks wrong").
3. **Every skill has the same sections:** Facts, In this app, Sources, Owner notes, Gaps
   (see `TEMPLATE.md`).
4. **Tag every fact's confidence.** `[verified]` = confirmed in this repo's code/data or a cited source;
   `[owner]` = from the project owner's own play knowledge; `[unsure]` = plausible but unchecked.
   Never state an `[unsure]` fact as settled when answering.
5. **Date it.** Each skill records "as of" league/date. PoE changes every league, so an old fact
   is a lead to check, not an answer.
6. **Point at sources, don't copy them.** Link poewiki / RePoE / poe.ninja / GGG docs. Copy only the
   small facts needed to route a question, or that this app depends on.
7. **Short and direct.** Bullets over prose, per the repo's AGENTS.md style.
8. **Owner notes are the growth path.** Add what you know from playing under "Owner notes" with an
   `[owner]` tag; Claude treats them as authoritative unless the data contradicts them.

## Skills

| Skill | Use it for |
| --- | --- |
| `poe-economy-basics` | How PoE prices work: Currency Exchange vs stash scrape, liquidity, spreads, gold cost |
| `poe-data-sources` | Which source answers which question, and each one's quirks |
| `poe-divination-cards` | Stacks, rewards, which cards are priceable, card flips |
| `poe-league-lifecycle` | How prices move across a league; what this app's history covers |
| `poe-item-categories` | poe.ninja/GGG categories, names, variants, and the migrated-category trap |

## Ideas for next skills

- `poe-currency-crafting` - what each orb/fossil/essence does (drives value and demand)
- `poe-league-mechanics` - per-league mechanic notes (Breach, Delirium, Mirage, Allflame, ...)
- `poe-trade-etiquette-and-tools` - trade site, exchange fees, price-check habits
- `poe-unique-items` - variants, corrupted/rolled uniques, chase items
- `poe-atlas-and-maps` - map tiers, sustain, scarab/invitation economics
