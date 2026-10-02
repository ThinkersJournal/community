import { describe, expect, it } from "vitest";

import { CLIENT_IP_HEADER } from "@thinkersjournal/shared";

import { clientIp } from "../src/http/client-ip";

/**
 * `clientIp` — the fix for the confirmed production bug where
 * `CF-Connecting-IP` does not survive the web→api Service Binding
 * (`env.API.fetch()` builds a brand-new Request). See that file's header for
 * the trust boundary (`workers_dev: false`, no `routes`, so only `web` can
 * ever set `CLIENT_IP_HEADER`).
 */
describe("clientIp", () => {
  it("prefers CLIENT_IP_HEADER over CF-Connecting-IP when both are present", () => {
    const request = new Request("https://api.test/some-endpoint", {
      headers: {
        [CLIENT_IP_HEADER]: "203.0.113.7",
        "CF-Connecting-IP": "198.51.100.9",
      },
    });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("falls back to CF-Connecting-IP when CLIENT_IP_HEADER is absent", () => {
    const request = new Request("https://api.test/some-endpoint", {
      headers: { "CF-Connecting-IP": "198.51.100.9" },
    });
    expect(clientIp(request)).toBe("198.51.100.9");
  });

  it("returns null when neither header is present", () => {
    const request = new Request("https://api.test/some-endpoint");
    expect(clientIp(request)).toBeNull();
  });

  it("never falls back when CLIENT_IP_HEADER is present but empty — empty string is a valid header value, not absence", () => {
    // Headers.get never returns "" for a header set to the empty string via
    // the constructor form used here — guard against that surprising edge by
    // asserting the literal value, not just truthiness.
    const request = new Request("https://api.test/some-endpoint", {
      headers: { [CLIENT_IP_HEADER]: "", "CF-Connecting-IP": "198.51.100.9" },
    });
    // An empty string is falsy but not null/undefined — `??` does NOT skip it,
    // so clientIp() must still return "" rather than falling back.
    expect(clientIp(request)).toBe("");
  });
});
