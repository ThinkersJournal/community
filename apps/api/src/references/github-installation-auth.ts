// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Installation token for the GitHub App (M3.3c). The App JWT lists the App's installations and mints an installation
 * token; the token (an opaque `ApiCredential`) is what reads public resources.
 *
 * All network goes through the guarded door's `api` path (`ctx.fetch(url, { api })`); this file never names global fetch.
 * ⚠️ NO TEXT FROM GITHUB IS EVER CARRIED INTO AN ERROR: a status is named, a body never is (it could echo a token).
 * ⚠️ A FAILED MINT IS NOT CACHED, and two simultaneous callers share one mint (an in-flight promise).
 */
import { ApiCredential, ConnectorError, type FetchCtx, type FetchedPage, type FetchInit } from "@thinkersjournal/shared";

import { mintAppJwt } from "./github-app-auth";

const API = "https://api.github.com";
/** A cached token is replaced this many seconds before it expires, so a request never carries one about to lapse. */
const REFRESH_MARGIN_SEC = 60;

export interface InstallationAuthOptions {
  /** GITHUB_APP_ID (a plain var). */
  appId: string | undefined;
  /** GITHUB_APP_PRIVATE_KEY (a Worker secret). */
  privateKey: string | undefined;
  /** Seconds since the epoch; injected for tests. */
  now?: () => number;
}

export interface InstallationAuth {
  /** A credential good for reading public resources. Cached until shortly before it expires. */
  credential(ctx: FetchCtx): Promise<ApiCredential>;
}

interface Cached {
  credential: ApiCredential;
  expiresAtSec: number;
}

function failure(status: number): ConnectorError {
  return new ConnectorError("upstream", `github answered ${status}`, status === 429 || status >= 500);
}

function parse(page: FetchedPage): unknown {
  if (page.status < 200 || page.status >= 300) throw failure(page.status);
  try {
    return JSON.parse(page.body) as unknown;
  } catch {
    throw new ConnectorError("upstream", "github answered unreadable JSON", false);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function apiInit(jwt: string, method: "GET" | "POST"): FetchInit {
  const api: NonNullable<FetchInit["api"]> = { method, credential: new ApiCredential("Bearer", jwt) };
  if (method === "POST") api.body = "{}";
  return { api, headers: { accept: "application/vnd.github+json" }, allowedTypes: ["application/json"] };
}

export function createInstallationAuth(opts: InstallationAuthOptions): InstallationAuth {
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  let installationId: number | undefined;
  let cached: Cached | undefined;
  let inflight: Promise<ApiCredential> | undefined;

  async function findInstallation(ctx: FetchCtx, jwt: string): Promise<number> {
    const body = parse(await ctx.fetch(`${API}/app/installations`, apiInit(jwt, "GET")));
    const first = Array.isArray(body) ? (body as unknown[])[0] : undefined;
    const id = isRecord(first) ? first["id"] : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new ConnectorError("upstream", "github app has no installation", false);
    }
    return id;
  }

  async function mint(ctx: FetchCtx): Promise<ApiCredential> {
    const jwt = await mintAppJwt(opts.appId, opts.privateKey, now()); // config errors surface BEFORE any request
    installationId ??= await findInstallation(ctx, jwt);
    const body = parse(await ctx.fetch(`${API}/app/installations/${installationId}/access_tokens`, apiInit(jwt, "POST")));
    const token = isRecord(body) ? body["token"] : undefined;
    const expires = isRecord(body) && typeof body["expires_at"] === "string" ? Date.parse(body["expires_at"]) : Number.NaN;
    if (typeof token !== "string" || token === "" || Number.isNaN(expires)) {
      throw new ConnectorError("upstream", "github token answer unreadable", false);
    }
    const credential = new ApiCredential("Bearer", token);
    cached = { credential, expiresAtSec: Math.floor(expires / 1000) };
    return credential;
  }

  return {
    credential(ctx: FetchCtx): Promise<ApiCredential> {
      if (cached !== undefined && now() < cached.expiresAtSec - REFRESH_MARGIN_SEC) return Promise.resolve(cached.credential);
      inflight ??= mint(ctx).finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
