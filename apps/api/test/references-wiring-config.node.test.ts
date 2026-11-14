// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

/**
 * The reference-refresh queue and its flag, read from the REAL wrangler.jsonc (M3.2c-3c; a Node test because the pool's
 * filesystem is virtual). The queue itself is created by the PM at deploy time: a Worker that names a queue that does not
 * exist fails its deploy, so this file's shape is what the PM creates the queue FROM.
 */
interface Config {
  queues?: {
    producers?: { queue: string; binding: string }[];
    consumers?: { queue: string; max_batch_size?: number; max_batch_timeout?: number; max_retries?: number }[];
  };
  vars?: Record<string, string>;
}
const api = parse(readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8")) as Config;

describe("reference refresh: wrangler.jsonc", () => {
  it("produces to the queue 'reference-refresh' as REFRESH_QUEUE (the name refresh-queue.ts exports)", () => {
    expect(api.queues?.producers).toEqual([{ queue: "reference-refresh", binding: "REFRESH_QUEUE" }]);
  });

  it("consumes the same queue in small, bounded batches with a retry cap", () => {
    const c = api.queues?.consumers ?? [];
    expect(c).toHaveLength(1);
    expect(c[0]?.queue).toBe("reference-refresh");
    expect(c[0]?.max_batch_size).toBeLessThanOrEqual(10);
    expect(c[0]?.max_retries).toBeGreaterThan(0);
    expect(c[0]?.max_retries).toBeLessThanOrEqual(5);
  });

  it("ships the sweep switch OFF: REFERENCE_REFRESH is \"0\" (anything but \"1\" is off)", () => {
    expect(api.vars?.REFERENCE_REFRESH).toBe("0");
  });
});
