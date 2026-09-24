<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI changes should apply everywhere they can

This app has several pages that share the same row/table pattern (`components/item-history-row.tsx`
for desktop, `components/item-history-card.tsx` for mobile - used by Flip Suggestions, the Mirage
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
