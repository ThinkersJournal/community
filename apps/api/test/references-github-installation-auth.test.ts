// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3c: the installation-token provider. A stub FetchCtx stands in for the guarded door; the key is a generated throwaway.
import { ApiCredential, ConnectorError, type FetchCtx, type FetchedPage, type FetchInit } from "@thinkersjournal/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { GithubAppConfigError } from "../src/references/github-app-auth";
import { createInstallationAuth } from "../src/references/github-installation-auth";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;
let pem = "";
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let s = "";
  for (const b of der) s += String.fromCharCode(b);
  const label = "PRIVATE " + "KEY"; // assembled so no secret scanner mistakes a throwaway test key for a real one
  pem = `-----BEGIN ${label}-----\n${btoa(s).replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
});

const NOW = 1_800_000_000;
const iso = (sec: number): string => new Date(sec * 1000).toISOString().replace(".000Z", "Z");

function reply(status: number, body: unknown): FetchedPage {
  return { status, finalUrl: "https://api.github.com/", contentType: "application/json", headers: {}, body: JSON.stringify(body), truncated: false };
}

interface Call {
  url: string;
  init: FetchInit | undefined;
}
/** Routes by method+path. `expires` is the token's expiry in epoch seconds. */
function stubCtx(opts: { installations?: unknown; mint?: (n: number) => FetchedPage; installationsStatus?: number } = {}) {
  const calls: Call[] = [];
  let mints = 0;
  const ctx: FetchCtx = {
    async fetch(url, init) {
      const u = String(url);
      calls.push({ url: u, init });
      if (u === "https://api.github.com/app/installations") {
        return reply(opts.installationsStatus ?? 200, opts.installations ?? [{ id: 77, account: { login: "someone" } }]);
      }
      if (u === "https://api.github.com/app/installations/77/access_tokens") {
        mints += 1;
        return (opts.mint ?? ((n) => reply(201, { token: `ghs_TOKEN${n}`, expires_at: iso(NOW + 3600) })))(mints);
      }
      throw new Error(`unexpected call ${u}`);
    },
  };
  return { ctx, calls, mints: () => mints };
}

const revealed = (c: ApiCredential): string => c.reveal();

describe("installation auth", () => {
  it("lists installations with the App JWT, mints a token for the first one, returns it as an opaque credential", async () => {
    const { ctx, calls } = stubCtx();
    const auth = createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW });
    const cred = await auth.credential(ctx);
    expect(cred).toBeInstanceOf(ApiCredential);
    expect(revealed(cred)).toBe("Bearer ghs_TOKEN1");
    expect(calls.map((c) => `${c.init?.api?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET https://api.github.com/app/installations",
      "POST https://api.github.com/app/installations/77/access_tokens",
    ]);
    // both calls authenticate with the App JWT (three dot-separated parts), not the installation token
    for (const c of calls) expect(revealed(c.init?.api?.credential as ApiCredential)).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    // JSON accepted, GitHub's versioned media type requested
    expect(calls[0]?.init?.allowedTypes).toContain("application/json");
    expect(calls[0]?.init?.headers?.accept).toBe("application/vnd.github+json");
  });

  it("caches the token while it is fresh (one mint, one installation lookup for two calls)", async () => {
    const { ctx, calls } = stubCtx();
    const auth = createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW });
    await auth.credential(ctx);
    await auth.credential(ctx);
    expect(calls).toHaveLength(2);
  });

  it("mints a new token once the cached one is within a minute of expiring, without a new installation lookup", async () => {
    let t = NOW;
    const { ctx, calls, mints } = stubCtx();
    const auth = createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => t });
    await auth.credential(ctx);
    t = NOW + 3600 - 59;
    const again = await auth.credential(ctx);
    expect(mints()).toBe(2);
    expect(revealed(again)).toBe("Bearer ghs_TOKEN2");
    expect(calls.filter((c) => c.url.endsWith("/app/installations"))).toHaveLength(1);
  });

  it("two calls at once share one mint", async () => {
    const { ctx, mints } = stubCtx();
    const auth = createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW });
    await Promise.all([auth.credential(ctx), auth.credential(ctx)]);
    expect(mints()).toBe(1);
  });

  it("a missing App ID or key is the named config error and makes no request", async () => {
    const { ctx, calls } = stubCtx();
    const noId = await createInstallationAuth({ appId: undefined, privateKey: pem, now: () => NOW }).credential(ctx).catch((e: unknown) => e);
    expect((noId as GithubAppConfigError).missing).toBe("GITHUB_APP_ID");
    const noKey = await createInstallationAuth({ appId: "5732881", privateKey: undefined, now: () => NOW }).credential(ctx).catch((e: unknown) => e);
    expect((noKey as GithubAppConfigError).missing).toBe("GITHUB_APP_PRIVATE_KEY");
    expect(calls).toHaveLength(0);
  });

  it("an app with no installation is an upstream ConnectorError, not retryable", async () => {
    const { ctx } = stubCtx({ installations: [] });
    const err = await createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW }).credential(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("upstream");
    expect((err as ConnectorError).retryable).toBe(false);
  });

  it.each([
    [401, false],
    [403, false],
    [429, true],
    [500, true],
    [503, true],
  ])("the token mint answering %i is an upstream error (retryable=%s) that names no token", async (status, retryable) => {
    const { ctx } = stubCtx({ mint: () => reply(status, { message: "nope ghs_LEAK" }) });
    const err = await createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW }).credential(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("upstream");
    expect((err as ConnectorError).retryable).toBe(retryable);
    expect(String((err as Error).message)).not.toContain("ghs_LEAK");
  });

  it("a failed mint is not cached: the next call tries again", async () => {
    let first = true;
    const { ctx, mints } = stubCtx({
      mint: (n) => {
        if (first) {
          first = false;
          return reply(500, {});
        }
        return reply(201, { token: `ghs_TOKEN${n}`, expires_at: iso(NOW + 3600) });
      },
    });
    const auth = createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW });
    await auth.credential(ctx).catch(() => undefined);
    const cred = await auth.credential(ctx);
    expect(revealed(cred)).toBe("Bearer ghs_TOKEN2");
    expect(mints()).toBe(2);
  });

  it("a malformed mint answer is an upstream error", async () => {
    const { ctx } = stubCtx({ mint: () => reply(201, { nope: true }) });
    const err = await createInstallationAuth({ appId: "5732881", privateKey: pem, now: () => NOW }).credential(ctx).catch((e: unknown) => e);
    expect((err as ConnectorError).code).toBe("upstream");
  });
});
