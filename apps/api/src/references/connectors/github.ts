// SPDX-License-Identifier: MIT OR Apache-2.0
/**
 * The `github` connector (M3.3, spec 3): public issues, pull requests, files with a line range, and CI check runs.
 * STUB at this commit: `identify` claims nothing yet (red-first). resolve/fetchLive land in later commits.
 */
import { ConnectorError, type Identified, type LiveResult, type Resolved } from "@thinkersjournal/shared";

import type { Connector } from "../connector";

export function createGithubConnector(): Connector<"github"> {
  return {
    kind: "github",
    identify(_url: URL): Identified | null {
      return null;
    },
    resolve(): Promise<Resolved> {
      return Promise.reject(new ConnectorError("unsupported", "github resolve not built yet"));
    },
    fetchLive(): Promise<LiveResult> {
      return Promise.reject(new ConnectorError("unsupported", "github fetchLive not built yet"));
    },
    deepLink(ref): string {
      return ref.canonicalUrl;
    },
  };
}

export const githubConnector = createGithubConnector();
