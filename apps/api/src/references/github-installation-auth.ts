// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * Installation token for the GitHub App (M3.3c). STUB at this commit (red-first): the real provider follows.
 * All network goes through the guarded door's `api` path (`ctx.fetch(url, { api })`); this file never names global fetch.
 */
import { ConnectorError, type ApiCredential, type FetchCtx } from "@thinkersjournal/shared";

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

export function createInstallationAuth(_opts: InstallationAuthOptions): InstallationAuth {
  return {
    credential(): Promise<ApiCredential> {
      return Promise.reject(new ConnectorError("unsupported", "installation auth not built yet"));
    },
  };
}
