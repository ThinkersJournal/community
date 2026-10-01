import { describe, expect, it } from "vitest";

import { evaluate, pickGateMigration } from "../../../scripts/check-migrations-applied.mjs";

/**
 * The deploy-time migration gate (#116, shape A) — `scripts/check-migrations-
 * applied.mjs` itself. Covers the two pieces exported pure so they're testable
 * without the network or a real migrations directory: `pickGateMigration`
 * (which file it gates on) and `evaluate` (pass/fail on a fetch outcome).
 *
 * ⚠️ WHY THIS IS A `*.node.test.ts`, NOT A POOL TEST. The script itself runs
 * under plain Node (it is invoked directly by Cloudflare Workers Builds, never
 * bundled into a Worker), has no `Env`/Hyperdrive dependency, and does real
 * `node:fs` reads in its non-pure half — workerd's virtual filesystem cannot
 * run it at all, same reasoning as apps/api/test/purge-binding.node.test.ts.
 */

describe("pickGateMigration", () => {
  it("picks the newest *.sql file when none are marked after-code", () => {
    const entries = ["0002_posts.sql", "0001_users.sql", "0003_tags.sql"];
    const readHead = () => ["-- Up Migration", "--"];

    expect(pickGateMigration(entries, readHead)).toBe("0003_tags");
  });

  it("ignores non-.sql entries in the directory listing", () => {
    const entries = ["0001_users.sql", "README.md", ".gitkeep"];
    const readHead = () => ["-- Up Migration"];

    expect(pickGateMigration(entries, readHead)).toBe("0001_users");
  });

  it("skips a newest file marked `-- deploy: after-code` and gates on the one before it", () => {
    const entries = ["0001_users.sql", "0002_posts.sql", "0003_drop_old_col.sql"];
    const readHead = (name: string) =>
      name === "0003_drop_old_col.sql"
        ? ["-- Up Migration", "--", "-- deploy: after-code", "--"]
        : ["-- Up Migration", "--"];

    expect(pickGateMigration(entries, readHead)).toBe("0002_posts");
  });

  it("keeps skipping through MULTIPLE trailing after-code migrations", () => {
    const entries = ["0001_users.sql", "0002_posts.sql", "0003_drop_a.sql", "0004_drop_b.sql"];
    const afterCode = new Set(["0003_drop_a.sql", "0004_drop_b.sql"]);
    const readHead = (name: string) =>
      afterCode.has(name) ? ["-- deploy: after-code"] : ["-- Up Migration"];

    expect(pickGateMigration(entries, readHead)).toBe("0002_posts");
  });

  it("only looks at the marker within the first 20 lines", () => {
    // The marker appears, but past the 20-line window `readHead` represents —
    // a real readHead never hands back more than that, so this simulates a
    // migration whose marker (if any) is further down and therefore NOT seen.
    const entries = ["0001_users.sql", "0002_late_marker.sql"];
    const readHead = (name: string) =>
      name === "0002_late_marker.sql"
        ? Array.from({ length: 20 }, (_, i) => `-- line ${i}`)
        : ["-- Up Migration"];

    expect(pickGateMigration(entries, readHead)).toBe("0002_late_marker");
  });

  it("returns null when every migration present is marked after-code", () => {
    const entries = ["0001_drop_a.sql"];
    const readHead = () => ["-- deploy: after-code"];

    expect(pickGateMigration(entries, readHead)).toBeNull();
  });
});

describe("evaluate", () => {
  it("passes on HTTP 200 with {applied:true}", async () => {
    const response = new Response(JSON.stringify({ applied: true }), { status: 200 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(true);
  });

  it("fails on HTTP 200 with {applied:false}", async () => {
    const response = new Response(JSON.stringify({ applied: false }), { status: 200 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(false);
  });

  it("fails on a 503", async () => {
    const response = new Response(JSON.stringify({ applied: null }), { status: 503 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("503");
  });

  it("fails on a non-JSON body", async () => {
    const response = new Response("not json", { status: 200 });
    const result = await evaluate(Promise.resolve(response));

    expect(result.pass).toBe(false);
  });

  it("fails on a thrown fetch (network error / our own abort timeout)", async () => {
    const result = await evaluate(Promise.reject(new Error("fetch failed")));

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("fetch failed");
  });
});
