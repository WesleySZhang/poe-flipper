import { gzipSync } from "node:zlib";

// Below this, gzip's own fixed overhead (headers, checksum - on the order of 20-30 bytes) can
// outweigh what compression saves on a small JSON payload, so it's not worth the CPU cost - a
// single-object error/result response stays plain.
const MIN_BYTES_TO_COMPRESS = 1024;

/**
 * JSON response, gzip-compressed when the payload is worth it and the client says it accepts
 * gzip. Next.js Route Handlers (unlike rendered pages, which go through `next start`'s built-in
 * compression) don't get automatic response compression - confirmed live: a plain
 * `Response.json(...)` from a Route Handler carries no Content-Encoding header at all, even with
 * an explicit `Accept-Encoding: gzip` request. A couple of this app's endpoints return several MB
 * of JSON uncompressed as a result - flip-suggestions and mirage-simulation both return every row
 * unfiltered (by design, so the client can filter/sort instantly with no round trip) rather than a
 * paginated slice, which was measured at 6+MB each. Safe to use for every JSON response
 * regardless of size - the threshold above means calling this on a tiny error object is a no-op,
 * not a pessimization, so callers don't need to judge per-route whether it's worth it.
 */
export function jsonResponse(data: unknown, request: Request, init?: ResponseInit): Response {
  const json = JSON.stringify(data);
  const acceptEncoding = request.headers.get("accept-encoding") ?? "";
  if (json.length < MIN_BYTES_TO_COMPRESS || !acceptEncoding.includes("gzip")) {
    return new Response(json, {
      ...init,
      headers: { ...init?.headers, "Content-Type": "application/json" },
    });
  }

  const body = gzipSync(Buffer.from(json));
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Content-Encoding", "gzip");
  return new Response(body, { ...init, headers });
}
