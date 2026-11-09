// SPDX-License-Identifier: MIT OR Apache-2.0
/** STUB (red-first commit). */
import type { Connector } from "./connector";
import type { Identified, SourceKind } from "@thinkersjournal/shared";

export const CONNECTOR_ORDER: readonly SourceKind[] = [];

export interface Registry {
  identify(url: URL): { connector: Connector; id: Identified } | null;
  get(kind: SourceKind): Connector | undefined;
}

export function createRegistry(_connectors: readonly Connector[]): Registry {
  return { identify: () => null, get: () => undefined };
}

export const defaultRegistry: Registry = createRegistry([]);
