---
name: verify-ui
description: Use after any UI change in this app to actually run it and check it at desktop and phone width (AGENTS.md requires this). Starts/reuses the dev server, logs in, drives it with Playwright, and screenshots.
---

# Verify a UI change

AGENTS.md: a UI change isn't done until it works at 1280px **and** ~390px.

1. **Server.** Check `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`. 307 = up (login
   redirect). If down: `npm run dev` in the background. If it hangs (single-threaded), kill the
   node process and restart.
2. **Login.** Password is `SITE_PASSWORD` in `.env.local`. API: `POST /api/login` with
   `{"password": "..."}`; keep the cookie. In Playwright, fill the password input on `/` and press Enter.
3. **Drive it.** Write a scratch Playwright script (`.cjs`) in the repo root (so `require("playwright")`
   resolves from the repo's `node_modules`) and delete it and its screenshots after. Repo eslint
   flags `require()` in `.js/.ts`, so never leave one in the repo. On Windows, give `node` a Windows
   path (`C:\...`), not a Git Bash `/c/...` one - `require` of the latter fails.
   - Desktop viewport 1280x900, then phone 390x844 (use `hasTouch`/`isMobile` for gesture changes).
   - Pages to hit for shared-row changes: `/` (Flip Predictions), Mirage simulator, Currency
     Exchange Flip, Divination Card Flips, Dust Value, and `/item/<category>/<Name_With_Underscores>`.
     Sold Listings (`/sold-listings`) needs data: use the `preview/sold-listings-mock` branch or a
     `page.route` fixture (see the `sold-tracker` skill).
   - Interact for real: click/tap the thing you changed, expand a row, drag the slider.
   - Colour changes: screenshot light **and** dark (`page.emulateMedia({ colorScheme })`, or toggle
     the theme button), and confirm the mode you weren't asked to change looks the same.
4. **Look at the screenshots.** Check for horizontal scroll, clipped text, misclicks, empty charts.
   Layout: one page title (the header's - no card title under it) and the panel's controls in one
   wrapping row (see the `new-page` skill).
5. **Also run** `npx tsc --noEmit -p .` and `npx eslint <changed files>`.
6. Report what you saw at each width. Say so if you did not verify something.

Header/search checks: the header is one fixed frame - assert the nav or title `getBoundingClientRect().top`
is identical across pages at each width. Phone: tap the search icon (`getByRole("button", {name:
"Search items"})`), type, tap an option (`getByRole("option")`), confirm the URL. Below `xl` the page
links live in the menu sheet (`getByRole("button", {name: "Pages"})`).

Shared components (`item-history-row.tsx`, `item-history-card.tsx`) change every table that uses
them - check at least two pages.
