// A single shared password gate for the whole app - not real user auth (no accounts, no per-user
// anything), just a speed bump since this is a small unofficial tool shared with a handful of
// people rather than something meant to be publicly indexed/crawled. Comes from an env var only
// (set in .env.local for dev, in the Vercel project's Environment Variables for deployment) -
// nothing is hardcoded here, so the password never appears in the repo or the deployed bundle.
export const SITE_PASSWORD = process.env.SITE_PASSWORD;

if (!SITE_PASSWORD) {
  // Fails closed: app/api/login/route.ts compares against this with `!==`, and a real password
  // string can never strictly equal `undefined`, so login just always rejects rather than
  // silently accepting anything - but warn loudly, since that's an easy thing to forget to set.
  console.warn(
    "SITE_PASSWORD is not set - the login page will reject every attempt until it's added " +
      "(see .env.local.example for local dev; set it in the Vercel project's Environment Variables for deployment)."
  );
}

export const AUTH_COOKIE_NAME = "poe_flipper_auth";

// Not a secret in itself - the login route only ever sets this fixed marker after checking
// SITE_PASSWORD server-side, so the real password never ships in the client bundle or ends up
// readable in a cookie. Proxy just checks the cookie equals this.
export const AUTH_COOKIE_VALUE = "granted";

export const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year - avoid re-prompting often
