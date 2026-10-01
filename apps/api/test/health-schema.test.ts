import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

/**
 * `GET /health/schema?migration=<name>` — the deploy-time migration gate's
 * data source (#116, shape A). Covers:
 *   • an applied migration -> 200 {applied:true};
 *   • an unknown name -> 200 {applied:false};
 *   • malformed/missing `migration` -> 400 INVALID_INPUT;
 *   • the no-disclosure property (PM ruling): the body for one migration must
 *     never carry another migration's name.
 *
 * Runs in the POOL project (real workerd): real Postgres via HYPERDRIVE_FRESH,
 * same as test/health-db.test.ts and test/global-setup.ts's applied schema.
 */

/** Drive the Worker through a full request lifecycle. */
async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A Hyperdrive binding whose connection always fails fast (loopback, refused). */
function unreachableHyperdrive(): Hyperdrive {
  return {
    connectionString: "postgres://baduser:badpass@127.0.0.1:59999/nonexistent_db",
  } as unknown as Hyperdrive;
}

/**
 * A migration file present in `apps/api/migrations` as of this writing,
 * guaranteed applied in this test database. ⚠️ NOT read from disk: this suite
 * runs in the POOL project, i.e. real workerd, whose filesystem is VIRTUAL
 * (rooted at `/bundle`) — the same reason test/purge-binding.node.test.ts has
 * to live in the Node project instead. global-setup.ts applies every file in
 * that directory to the test database (in Node, before either project
 * starts), so this name is guaranteed applied here as long as it stays a
 * real, present filename — it need not be any particular one on disk.
 */
const KNOWN_APPLIED_MIGRATION = "0019_account_deletion";

describe("GET /health/schema", () => {
  it("200s {applied:true} for a migration that has been applied", async () => {
    const response = await fetchWorker(
      new Request(`https://api.test/health/schema?migration=${KNOWN_APPLIED_MIGRATION}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ applied: true });
  });

  it("200s {applied:true} for a known-old migration by name (0001_users_and_profiles)", async () => {
    const response = await fetchWorker(
      new Request("https://api.test/health/schema?migration=0001_users_and_profiles"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
  });

  it("200s {applied:false} for a well-formed but nonexistent migration name", async () => {
    const response = await fetchWorker(
      new Request("https://api.test/health/schema?migration=9999_nope"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: false });
  });

  it("400 INVALID_INPUT when migration is missing entirely", async () => {
    const response = await fetchWorker(new Request("https://api.test/health/schema"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([
    ["a path segment", "../x"],
    ["digits only, no name part", "0001"],
    ["an injection attempt", "0001_X;DROP"],
    ["uppercase, which node-pg-migrate names never are", "0001_Users"],
    ["no leading 4-digit sequence", "users_and_profiles"],
    // fix round 1, item 5: the name part is capped at 100 chars; 101 trips it.
    ["a name part one char over the 100-char cap", `0001_${"a".repeat(101)}`],
  ])("400 INVALID_INPUT for a malformed migration param (%s: %s)", async (_label, value) => {
    const response = await fetchWorker(
      new Request(`https://api.test/health/schema?migration=${encodeURIComponent(value)}`),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("503 {applied:null} when the database is unreachable", async () => {
    const failingEnv = { ...env, HYPERDRIVE_FRESH: unreachableHyperdrive() } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://api.test/health/schema?migration=0001_users_and_profiles"),
      failingEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ applied: null });
  });

  it("NEVER discloses another migration's name — 0001's response body has no 0002 in it", async () => {
    const response = await fetchWorker(
      new Request("https://api.test/health/schema?migration=0001_users_and_profiles"),
    );
    const text = await response.text();

    expect(text).not.toContain("0002");
    expect(text).toEqual('{"applied":true}');
  });
});
