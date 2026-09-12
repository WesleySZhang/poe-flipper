import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DuckDB's native bindings pick their platform binary at require-time; bundling breaks that.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
};

export default nextConfig;
