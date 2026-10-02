<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Load the matching skill before starting

This repo keeps its know-how in skills. Before starting a task (including one that comes up in
the middle of a long conversation), check this table and load every skill that matches with the
Skill tool. Do this even if you think you already know the area: skills hold checked facts and
past mistakes that the code doesn't show. Load them unprompted; the owner shouldn't have to ask.

| When the task touches... | Load |
| --- | --- |
| The sold listing tracker, `/sold-listings`, `sold-tracker/searches.md`, `lib/trade-api.ts`, the "Track sold listings" or "Add or remove a sold tracker search" workflows | `sold-tracker` |
| Any UI change (before calling it done) | `verify-ui` |
| A new page, or a page panel's layout | `new-page` |
| The daily precompute job, the `precompute-data` branch, stale predictions/prices | `precompute-check` |
| A league starting or ending | `new-league`, `poe-league-lifecycle` |
| Where a number comes from, or why it's missing/wrong (poe.ninja, GGG exchange or trade API, RePoE) | `poe-data-sources` |
| What a price means, spreads, liquidity, whether a flip or sale is real | `poe-economy-basics` |
| Showing or copying an item the way the game does (tooltips, mods, tiers, Ctrl+C text) | `poe-item-display` |
| Item categories, names/variants, a lookup that finds nothing | `poe-item-categories` |
| Divination cards | `poe-divination-cards` |
| Disenchanting / Thaumaturgic Dust | `poe-disenchanting` |

If a skill turns out wrong or stale, fix it in the same change (see "Keep skills and READMEs
current" below). Keep this table in step with the skills: see "Keep this skill table current" below.

## UI changes should apply everywhere they can

This app has several pages that share the same row/table pattern (`components/item-history-row.tsx`
for desktop, `components/item-history-card.tsx` for mobile - used by Flip Predictions, the Mirage
simulator, Currency Exchange Flip, and Divination Card Flips). When asked for a UI change - a fix,
a new interaction, a link, an indicator - check whether it belongs in one of these shared components
rather than one page's own panel. If it does, make the change there so every page that uses it picks
it up in one edit, instead of patching a single page and leaving the others inconsistent. Only scope
a change to one page when it's genuinely specific to that page's own data or layout.

Every UI change also needs to actually work on mobile, not just look plausible in the code - verify
it with the `run` skill/Playwright at a phone-width viewport (or an emulated touch device for
anything pointer/gesture-related), not only at desktop width. A change that works at 1280px and
silently breaks or misclicks at 390px isn't done.

## Keep on-page text short

Labels, captions, empty-state messages, tooltips - anything a user reads on a card or in a table -
should be as short as the meaning allows. State the fact, not the reasoning behind it: "No 7-day
prediction - try a shorter duration," not a sentence explaining why the data doesn't reach that far.
If you're tempted to write "because..." or a second clause justifying the first, cut it - that
belongs in a code comment (for future you) or nowhere at all, not in the UI (for the user scanning
a card at a glance). A tooltip/title attribute can carry a little more context if it's genuinely
useful, since it's opt-in, but the always-visible text next to it should stay terse.

## Keep skills and READMEs current

After finishing a task, check whether it changes anything a skill or README describes, and update
them in the same change:

- **README.md** - any new feature, page, component, script, env var or workflow step, or a change
  to how one works. Keep it as short as the meaning allows.
- **Skills** - if the task is something that will plausibly come up again (a workflow, a
  checklist, a debugging routine, a data-source quirk), add or update a skill instead of leaving
  it only in the chat. App workflow skills go in `.claude/skills/<name>/SKILL.md`. Generic Path
  of Exile knowledge goes in `poe-knowledge/skills/<name>/SKILL.md` (see `poe-knowledge/README.md`
  for the conventions and confidence tags; those are linked into `~/.claude/skills/`, so a new
  one needs a junction there too). Give each skill a description that says *when* to use it.
- Fix a skill that turns out to be wrong or stale when you notice it, rather than working around it.
- **Keep this skill table current.** Whenever you add, rename, remove or change a skill (in
  `.claude/skills/` or `poe-knowledge/skills/`), check the "Load the matching skill before
  starting" table above in the same change:
  - a new skill gets a row;
  - a renamed or removed one has its row updated or deleted;
  - a skill whose scope changed (its `description` now covers new files, symptoms or topics) has
    its row's "When the task touches..." updated to match.
  The table and the skills' `description`s should never disagree.
