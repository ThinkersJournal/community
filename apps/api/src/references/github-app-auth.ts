// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * GitHub App authentication (M3.3b). STUB at this commit (red-first): the real `mintAppJwt` follows.
 * No I/O in this file: it only signs. The network call that trades the JWT for an installation token goes through the
 * guarded door, never from here.
 */
export class GithubAppConfigError extends Error {
  constructor(readonly missing: string) {
    super(`github app config missing: ${missing}`);
    this.name = "GithubAppConfigError";
  }
}

export function mintAppJwt(_appId: string | undefined, _privateKeyPem: string | undefined, _nowSec: number): Promise<string> {
  return Promise.reject(new Error("mintAppJwt not built yet"));
}
