// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The connector registry (spec 3): `identify` is first-match over a FIXED order (github, gitlab, web), so two connectors
 * never claim one URL and `web` stays the catch-all that is asked last. The order lives here, in one table, not in the
 * order connectors were passed in. github and gitlab are not built yet, so `web` is the only one registered.
 */
import { webConnector } from "./connectors/web";

import type { Connector } from "./connector";
import type { Identified, SourceKind } from "@thinkersjournal/shared";

export const CONNECTOR_ORDER: readonly SourceKind[] = ["github", "gitlab", "web"];

export interface Registry {
  /** The first connector (in `CONNECTOR_ORDER`) that claims `url`, with its identification; null if none does. */
  identify(url: URL): { connector: Connector; id: Identified } | null;
  get(kind: SourceKind): Connector | undefined;
}

export function createRegistry(connectors: readonly Connector[]): Registry {
  const byKind = new Map<SourceKind, Connector>(connectors.map((c) => [c.kind, c]));
  const get = (kind: SourceKind): Connector | undefined => byKind.get(kind);
  return {
    get,
    identify(url) {
      for (const kind of CONNECTOR_ORDER) {
        const connector = get(kind);
        const id = connector?.identify(url) ?? null;
        if (connector !== undefined && id !== null) return { connector, id };
      }
      return null;
    },
  };
}

export const defaultRegistry: Registry = createRegistry([webConnector]);

/** The App settings the github connector needs (`GITHUB_APP_ID` is a plain var, the key a Worker secret). */
export interface GithubEnv {
  GITHUB_APP_ID?: string | undefined;
  GITHUB_APP_PRIVATE_KEY?: string | undefined;
}

/** STUB at this commit (red-first): returns the default registry; the env-aware registry follows. */
export function registryFromEnv(_env: GithubEnv): Registry {
  return defaultRegistry;
}

/** STUB at this commit (red-first). Reads of stored cards need `deepLink` for every kind, configured or not. */
export const renderRegistry: Registry = defaultRegistry;
