// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The connector registry (spec 3): `identify` is first-match over a FIXED order (github, gitlab, web), so two connectors
 * never claim one URL and `web` stays the catch-all that is asked last. The order lives here, in one table, not in the
 * order connectors were passed in. github and gitlab are not built yet, so `web` is the only one registered.
 */
import { createGithubConnector, githubConnector } from "./connectors/github";
import { webConnector } from "./connectors/web";
import { createInstallationAuth } from "./github-installation-auth";

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

let configured: { id: string; key: string; registry: Registry } | undefined;
let warnedAbout: string | undefined;

/**
 * The registry for THIS deploy's settings. The github connector is registered ONLY when the App is configured (both the ID
 * and the key set), so shipping this code changes nothing for a GitHub URL until the secret is set; unconfigured, a GitHub URL
 * is the web connector's exactly as before. A half-configured env stays off and is logged once, by the missing setting's NAME
 * (never the key). The registry, and with it the installation-token cache, is kept while the settings stay the same; a rotated
 * key builds a fresh one.
 */
export function registryFromEnv(env: GithubEnv): Registry {
  const id = env.GITHUB_APP_ID ?? "";
  const key = env.GITHUB_APP_PRIVATE_KEY ?? "";
  if (id === "" || key === "") {
    configured = undefined;
    const missing = id === "" && key === "" ? undefined : id === "" ? "GITHUB_APP_ID" : "GITHUB_APP_PRIVATE_KEY";
    if (missing !== undefined && warnedAbout !== missing) console.warn(`references: github connector disabled, ${missing} is not set`);
    warnedAbout = missing;
    return defaultRegistry;
  }
  warnedAbout = undefined;
  if (configured?.id === id && configured.key === key) return configured.registry;
  const auth = createInstallationAuth({ appId: id, privateKey: key });
  const registry = createRegistry([createGithubConnector({ auth }), webConnector]);
  configured = { id, key, registry };
  return registry;
}

/** Reads of stored cards need `deepLink` for every kind, configured or not (it is pure, no auth). */
export const renderRegistry: Registry = createRegistry([githubConnector, webConnector]);
