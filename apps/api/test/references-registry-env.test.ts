// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3f: wiring. The github connector is registered ONLY when the App is configured (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY),
// so deploying this code changes nothing for a GitHub URL until the PM sets the secret; a half-configured env is logged by name.
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultRegistry, registryFromEnv, renderRegistry } from "../src/references/registry";

const ISSUE = new URL("https://github.com/octo/repo/issues/12");
const BLOB_NO_ANCHOR = new URL("https://github.com/octo/repo/blob/main/a.ts");
const PEM = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";

afterEach(() => vi.restoreAllMocks());

describe("registryFromEnv", () => {
  it("unconfigured: github is not registered and a github URL is the web connector's, exactly as before", () => {
    const reg = registryFromEnv({});
    expect(reg.get("github")).toBeUndefined();
    expect(reg.identify(ISSUE)?.connector.kind).toBe("web");
  });

  it("configured: github is registered and claims an issue URL first; a URL it does not claim still falls to web", () => {
    const reg = registryFromEnv({ GITHUB_APP_ID: "5732881", GITHUB_APP_PRIVATE_KEY: PEM });
    expect(reg.get("github")?.kind).toBe("github");
    expect(reg.identify(ISSUE)?.connector.kind).toBe("github");
    expect(reg.identify(BLOB_NO_ANCHOR)?.connector.kind).toBe("web");
    expect(reg.get("web")).toBeDefined();
  });

  it.each([
    ["only the ID", { GITHUB_APP_ID: "5732881" }, "GITHUB_APP_PRIVATE_KEY"],
    ["only the key", { GITHUB_APP_PRIVATE_KEY: PEM }, "GITHUB_APP_ID"],
    ["an empty key", { GITHUB_APP_ID: "5732881", GITHUB_APP_PRIVATE_KEY: "" }, "GITHUB_APP_PRIVATE_KEY"],
  ])("%s: github stays off and the missing setting is named in one warning that never contains the key", (_n, env, missing) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reg = registryFromEnv(env);
    expect(reg.get("github")).toBeUndefined();
    expect(reg.identify(ISSUE)?.connector.kind).toBe("web");
    const text = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(text).toContain(missing);
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });

  it("fully unconfigured logs nothing (the normal state before the secret is set)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registryFromEnv({});
    expect(warn).not.toHaveBeenCalled();
  });

  it("the same settings give the same registry, so the installation-token cache survives between calls", () => {
    const env = { GITHUB_APP_ID: "5732881", GITHUB_APP_PRIVATE_KEY: PEM };
    expect(registryFromEnv(env)).toBe(registryFromEnv({ ...env }));
  });

  it("a changed key gives a fresh registry (a rotated secret is picked up, not served from a stale cache)", () => {
    const a = registryFromEnv({ GITHUB_APP_ID: "5732881", GITHUB_APP_PRIVATE_KEY: PEM });
    const b = registryFromEnv({ GITHUB_APP_ID: "5732881", GITHUB_APP_PRIVATE_KEY: PEM + "\n#rotated" });
    expect(b).not.toBe(a);
  });

  it("defaultRegistry itself is unchanged: web only", () => {
    expect(defaultRegistry.get("github")).toBeUndefined();
  });
});

describe("renderRegistry", () => {
  it("knows github (for a stored card's deep link) whether or not the App is configured, and still web", () => {
    expect(renderRegistry.get("github")?.deepLink({ kind: "github", resourceKey: "k", canonicalUrl: "https://github.com/octo/repo/issues/12", snapshot: null, contentHash: "h" })).toBe(
      "https://github.com/octo/repo/issues/12",
    );
    expect(renderRegistry.get("web")).toBeDefined();
  });
});
