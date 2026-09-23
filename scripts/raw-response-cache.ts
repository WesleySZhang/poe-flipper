/**
 * File-backed store for poe.ninja's raw responses, shared across the daily precompute job's
 * separate script processes (see lib/poe-ninja.ts's setRawResponseStore for why). Enabled by
 * setting POE_NINJA_DISK_CACHE to a directory (the workflow does); with it unset this does nothing,
 * so running any script by hand still fetches live every time, as before.
 *
 * The first process to need a URL fetches it and writes it here; later processes in the same run
 * read it back instead of calling poe.ninja again - ~48 requests once per run instead of once per
 * script.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setRawResponseStore } from "../lib/poe-ninja";

export function installRawResponseCache(): void {
  const dir = process.env.POE_NINJA_DISK_CACHE;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const fileFor = (url: string) => path.join(dir, crypto.createHash("sha1").update(url).digest("hex") + ".json");
  setRawResponseStore({
    get(url) {
      try {
        return JSON.parse(fs.readFileSync(fileFor(url), "utf8"));
      } catch {
        return undefined;
      }
    },
    set(url, data) {
      fs.writeFileSync(fileFor(url), JSON.stringify(data));
    },
  });
}
