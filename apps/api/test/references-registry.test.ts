// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.1b: the connector registry's fixed order (spec 3: github, gitlab, web; first match wins).
import { describe, expect, it } from "vitest";

import { webConnector } from "../src/references/connectors/web";
import { CONNECTOR_ORDER, createRegistry, defaultRegistry } from "../src/references/registry";

import type { Connector } from "../src/references/connector";
import type { SourceKind } from "@thinkersjournal/shared";

function claimer(kind: SourceKind, hosts: string[]): Connector {
  return {
    kind,
    identify: (url) => (hosts.includes(url.hostname) ? { kind, canonicalUrl: url.href, resourceKey: `${kind}:${url.href}` } : null),
    resolve: () => Promise.reject(new Error("not used")),
    fetchLive: () => Promise.reject(new Error("not used")),
    deepLink: (ref) => ref.canonicalUrl,
  };
}

describe("connector registry", () => {
  // Mutation that must fail: reorder the table (web before github).
  it("the order table is github, gitlab, web", () => {
    expect(CONNECTOR_ORDER).toEqual(["github", "gitlab", "web"]);
  });

  it("only web is registered for now", () => {
    expect(defaultRegistry.get("web")).toBe(webConnector);
    expect(defaultRegistry.get("github")).toBeUndefined();
    expect(defaultRegistry.get("gitlab")).toBeUndefined();
  });

  it("the default registry sends an https URL to web and a non-http URL to nobody", () => {
    expect(defaultRegistry.identify(new URL("https://example.com/a"))?.connector.kind).toBe("web");
    expect(defaultRegistry.identify(new URL("ftp://example.com/a"))).toBeNull();
  });

  // Mutation that must fail: iterate in the order the connectors were passed in.
  it("first match over the FIXED order, whatever order they were registered in", () => {
    const reg = createRegistry([webConnector, claimer("github", ["github.com"])]);
    expect(reg.identify(new URL("https://github.com/o/r/issues/1"))?.connector.kind).toBe("github");
    expect(reg.identify(new URL("https://example.com/"))?.connector.kind).toBe("web");
  });

  it("two connectors never claim one URL: the earlier in the order wins and the later is never asked", () => {
    const reg = createRegistry([claimer("web", ["github.com"]), claimer("github", ["github.com"])]);
    expect(reg.identify(new URL("https://github.com/o/r"))?.connector.kind).toBe("github");
  });
});
