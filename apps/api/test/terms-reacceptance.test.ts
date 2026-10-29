// SPDX-License-Identifier: MIT OR Apache-2.0
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";

import { SIGNUP_MINIMUM_AGE, TERMS_VERSION } from "@thinkersjournal/shared";

import worker from "../src";
import { withClient } from "../src/db/client";
import { createVerifiedActor, deleteCreatedUsers } from "./actor";

import type { Actor } from "./actor";

/**
 * ROADMAP R12: GET/POST /account/terms. A member with no acceptance of the CURRENT Terms
 * version is told so; accepting adds one row for the version (older rows stay).
 */

const ORIGIN = "http://localhost:8787";

async function call(request: Request, flag = "1"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, TERMS_NOTICE: flag }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const status = (a: Actor, flag = "1") => call(new Request("https://api.test/account/terms", { headers: { Cookie: a.cookie } }), flag);
const accept = (a: Actor, body: unknown) =>
  call(
    new Request("https://api.test/account/terms", {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: a.cookie, "X-CSRF-Token": a.csrfToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

async function rows(a: Actor) {
  const ctx = createExecutionContext();
  const out = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) =>
    (await c.query<{ terms_version: string; minimum_age: number; accepted_at: Date }>(
      `SELECT terms_version, minimum_age, accepted_at FROM terms_acceptances WHERE user_id = $1 ORDER BY accepted_at`,
      [a.userId],
    )).rows,
  );
  await waitOnExecutionContext(ctx);
  return out;
}

async function seedOld(a: Actor, version: string): Promise<void> {
  const ctx = createExecutionContext();
  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO terms_acceptances (user_id, terms_version, minimum_age, accepted_at) VALUES ($1, $2, 16, now() - interval '1 year')`,
      [a.userId, version],
    ),
  );
  await waitOnExecutionContext(ctx);
}

afterAll(deleteCreatedUsers);

describe("GET/POST /account/terms (R12)", () => {
  it("the notice is dark unless TERMS_NOTICE is \"1\" (control: the same member is told with it on)", async () => {
    const a = await createVerifiedActor();
    for (const flag of ["0", ""]) {
      const off = (await (await status(a, flag)).json()) as { needsAcceptance: boolean };
      expect(off.needsAcceptance).toBe(false);
    }
    const on = (await (await status(a, "1")).json()) as { needsAcceptance: boolean };
    expect(on.needsAcceptance).toBe(true);
  });

  it("a member with no acceptance needs to accept, and accepting records the server's version and age once", async () => {
    const a = await createVerifiedActor();
    const before = (await (await status(a)).json()) as { currentVersion: string; lastAcceptedVersion: string | null; needsAcceptance: boolean };
    expect(before).toEqual({ currentVersion: TERMS_VERSION, lastAcceptedVersion: null, needsAcceptance: true });

    expect((await accept(a, { acceptedTerms: true, confirmedAge: true })).status).toBe(200);
    const after = (await (await status(a)).json()) as { needsAcceptance: boolean; lastAcceptedVersion: string };
    expect(after.needsAcceptance).toBe(false);
    expect(after.lastAcceptedVersion).toBe(TERMS_VERSION);
    const r = await rows(a);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ terms_version: TERMS_VERSION, minimum_age: SIGNUP_MINIMUM_AGE });

    // Accepting again keeps the first time (the evidence), and adds no row.
    const firstAt = r[0]!.accepted_at.getTime();
    expect((await accept(a, { acceptedTerms: true, confirmedAge: true })).status).toBe(200);
    const again = await rows(a);
    expect(again).toHaveLength(1);
    expect(again[0]!.accepted_at.getTime()).toBe(firstAt);
  });

  it("an acceptance of an OLDER version does not count: they are told, the old row stays, and accepting adds the new one", async () => {
    const a = await createVerifiedActor();
    await seedOld(a, "2020-01-01");
    const before = (await (await status(a)).json()) as { needsAcceptance: boolean; lastAcceptedVersion: string };
    expect(before).toMatchObject({ needsAcceptance: true, lastAcceptedVersion: "2020-01-01" });

    expect((await accept(a, { acceptedTerms: true, confirmedAge: true })).status).toBe(200);
    const r = await rows(a);
    expect(r.map((x) => x.terms_version)).toEqual(["2020-01-01", TERMS_VERSION]);
    expect(((await (await status(a)).json()) as { needsAcceptance: boolean }).needsAcceptance).toBe(false);
  });

  it.each([
    [{ acceptedTerms: true }, "confirmedAge"],
    [{ confirmedAge: true }, "acceptedTerms"],
    [{ acceptedTerms: false, confirmedAge: true }, "acceptedTerms"],
    [{ acceptedTerms: "on", confirmedAge: true }, "acceptedTerms"],
  ])("400s %j naming the field, and records nothing", async (body, field) => {
    const a = await createVerifiedActor();
    const res = await accept(a, body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields?: string[] }).fields).toContain(field);
    expect(await rows(a)).toHaveLength(0);
  });

  it("401s the status without a session, and the accept without a session or a CSRF token", async () => {
    expect((await call(new Request("https://api.test/account/terms"))).status).toBe(401);
    const a = await createVerifiedActor();
    const noCsrf = await call(
      new Request("https://api.test/account/terms", {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: a.cookie, "content-type": "application/json" },
        body: JSON.stringify({ acceptedTerms: true, confirmedAge: true }),
      }),
    );
    expect(noCsrf.status).toBeGreaterThanOrEqual(400);
    expect(await rows(a)).toHaveLength(0);
  });
});
