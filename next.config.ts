import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js's dev server blocks cross-origin requests to dev-only assets/endpoints by default
  // (HMR's websocket, RSC payload fetches, ...) - only `localhost` and whatever hostname the
  // server itself was started with are allowed otherwise. Without this, opening the dev server
  // from another device's browser via this machine's LAN IP (e.g. testing on a phone) loads the
  // page's static HTML fine but never actually hydrates - every client component (including the
  // login form) stays inert, which looked exactly like "the password won't submit": the button
  // never leaves its server-rendered disabled state because React's onChange never wires up.
  // Generic private-network wildcards (RFC 1918's two most common home-router ranges) rather than
  // this specific machine's own DHCP-assigned subnet - works for testing from any local network,
  // not just this one, and doesn't put a personal network detail in a public repo's committed
  // config. Dev-server-only setting either way - has no effect on the deployed production app,
  // which runs `next start`, not `next dev`.
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*"],
  // DuckDB's native bindings pick their platform binary at require-time; bundling breaks that.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  // serverExternalPackages alone isn't enough on Vercel: the platform-specific @duckdb/node-bindings-*
  // package's .node addon dynamically dlopen()s a separate libduckdb.so at runtime, which Next's
  // output file tracer doesn't detect via static analysis and so leaves out of the deployed
  // function's file set entirely ("libduckdb.so: cannot open shared object file"). Force-including
  // the whole @duckdb scope guarantees whichever platform package npm actually installed - and its
  // .so - ships with the function.
  outputFileTracingIncludes: {
    "/*": ["node_modules/@duckdb/**/*"],
  },
};

export default nextConfig;
