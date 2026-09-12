import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
