// SPDX-License-Identifier: MIT OR Apache-2.0
/** STUB (red-first commit). */
import { ConnectorError } from "@thinkersjournal/shared";

import type { Connector } from "../connector";

export function createWebConnector(_selfHosts?: readonly string[]): Connector<"web"> {
  const notBuilt = (): never => {
    throw new ConnectorError("unsupported", "not built");
  };
  return { kind: "web", identify: () => null, resolve: notBuilt, fetchLive: notBuilt, deepLink: () => "" };
}

export const webConnector = createWebConnector();
