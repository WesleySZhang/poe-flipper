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

interface SerializedCacheEntry {
  expiresAt: number;
  plainBody: string;
  /** Undefined when the payload was too small to bother gzipping - see MIN_BYTES_TO_COMPRESS. */
  gzipBody?: Buffer;
}
const serializedCache = new Map<string, SerializedCacheEntry>();

/**
 * Same as jsonResponse, but also caches the already-JSON.stringify'd (and, when worthwhile,
 * already-gzipSync'd) bytes under `key` for `ttlMs` - not just the data `compute()` produces.
 *
 * Caching `compute()`'s own result (as lib/flip-suggestions.ts's getFlipSuggestions and
 * lib/divination-flips.ts's getDivinationFlips already do internally) skips redoing the expensive
 * DB/model work, but jsonResponse's own JSON.stringify + gzipSync still ran fresh on every single
 * HTTP request regardless - and per that function's own doc, a couple of these endpoints return
 * several MB of JSON, measured taking several hundred milliseconds to stringify+compress each time.
 * That's a synchronous, main-thread-blocking cost paid on every repeat request even when the
 * underlying data hasn't changed at all - and since Node is single-threaded, it stalls every OTHER
 * concurrent request too, not just the one that triggered it. This was the remaining cause of
 * "instant" repeat navigation (e.g. between two different per-item detail pages, which both hit
 * these same big, mostly-unchanging endpoints) still feeling slow after the data-level cache alone.
 */
export async function cachedJsonResponse(
  key: string,
  ttlMs: number,
  request: Request,
  compute: () => Promise<unknown>
): Promise<Response> {
  const acceptsGzip = (request.headers.get("accept-encoding") ?? "").includes("gzip");
  const now = Date.now();
  let entry = serializedCache.get(key);
  if (!entry || entry.expiresAt <= now) {
    const data = await compute();
    const plainBody = JSON.stringify(data);
    entry = {
      expiresAt: now + ttlMs,
      plainBody,
      gzipBody: plainBody.length >= MIN_BYTES_TO_COMPRESS ? gzipSync(Buffer.from(plainBody)) : undefined,
    };
    serializedCache.set(key, entry);
  }
  const { plainBody, gzipBody } = entry;
  if (acceptsGzip && gzipBody) {
    // Wrapped in a plain Uint8Array - passing the cached Buffer directly hits a bizarre TS
    // BodyInit-overload resolution error (Buffer structurally satisfies BodyInit, and the identical
    // pattern one function up passes a freshly-computed Buffer straight through with no issue) that
    // only reproduces for the interface-stored, destructured Buffer here, not a fully inline one -
    // a Uint8Array view sidesteps it outright rather than chasing the inference quirk further.
    return new Response(new Uint8Array(gzipBody), {
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    });
  }
  return new Response(plainBody, { headers: { "Content-Type": "application/json" } });
}
