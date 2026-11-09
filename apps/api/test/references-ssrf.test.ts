// SPDX-License-Identifier: MIT OR Apache-2.0
import { ConnectorError } from "@thinkersjournal/shared";
import { describe, expect, it } from "vitest";

import { assertPublicHttpUrl, isBlockedIpAddress, normaliseIPv4 } from "../src/references/ssrf";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConnectorError) return e.code;
    throw e;
  }
  return "no-throw";
}

// Both edges of every range in spec section 5 rule 2.
const BLOCKED_V4 = [
  "0.0.0.0", "0.255.255.255",
  "10.0.0.0", "10.255.255.255",
  "100.64.0.0", "100.127.255.255",
  "127.0.0.1", "127.255.255.254",
  "169.254.0.0", "169.254.169.254", "169.254.255.255",
  "172.16.0.0", "172.31.255.255",
  "192.0.0.0", "192.0.0.255",
  "192.168.0.0", "192.168.255.255",
  "198.18.0.0", "198.19.255.255",
  "224.0.0.0", "239.255.255.255",
  "240.0.0.0", "255.255.255.255",
];
// Just outside each range: must stay allowed (a range widened by mutation fails here).
const PUBLIC_V4 = [
  "1.1.1.1", "8.8.8.8", "93.184.216.34", "9.255.255.255", "11.0.0.0",
  "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
  "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0",
  "192.0.1.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255",
];

describe("assertPublicHttpUrl: IPv4 ranges", () => {
  // Mutation that must fail this: delete any one range from the blocked list (its edges go "no-throw").
  it.each(BLOCKED_V4)("blocks http://%s/", (ip) => {
    expect(codeOf(() => assertPublicHttpUrl(`http://${ip}/`))).toBe("blocked_target");
  });

  // Mutation that must fail this: widen a range (e.g. 100.64/10 -> 100/8).
  it.each(PUBLIC_V4)("allows http://%s/", (ip) => {
    expect(assertPublicHttpUrl(`http://${ip}/x`).hostname).toBe(ip);
  });
});

describe("assertPublicHttpUrl: alternative IPv4 spellings", () => {
  const SPELLINGS: Array<[string, string]> = [
    ["http://2130706433/", "127.0.0.1 decimal"],
    ["http://0x7f000001/", "127.0.0.1 hex"],
    ["http://0x7f.0.0.1/", "127.0.0.1 dotted hex"],
    ["http://0177.0.0.1/", "127.0.0.1 octal"],
    ["http://017700000001/", "127.0.0.1 octal whole"],
    ["http://127.1/", "127.0.0.1 shorthand"],
    ["http://127.0.1/", "127.0.0.1 shorthand 3"],
    ["http://0/", "0.0.0.0"],
    ["http://0x0/", "0.0.0.0 hex"],
    ["http://0300.0250.0.1/", "192.168.0.1 octal"],
    ["http://0xc0a80001/", "192.168.0.1 hex"],
    ["http://3232235777/", "192.168.1.1 decimal"],
    ["http://2852039166/", "169.254.169.254 decimal"],
    ["http://127.0.0.1./", "trailing dot"],
    ["http://0xA9.0xFE.0xA9.0xFE/", "169.254.169.254 hex case"],
  ];
  // Mutation that must fail this: skip normalisation (and the runtime's own canonicalisation does not cover it).
  it.each(SPELLINGS)("blocks %s (%s)", (url) => {
    expect(codeOf(() => assertPublicHttpUrl(url))).toBe("blocked_target");
  });

  // The WHATWG parser canonicalises most of these already; normaliseIPv4 is the defensive layer and must
  // stand on its own, because a runtime that left a spelling alone would otherwise open the door.
  // Mutation that must fail this: make normaliseIPv4 return null for non-dotted-decimal input.
  it.each([
    ["2130706433", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["3232235777", "192.168.1.1"],
    ["8.8.8.8", "8.8.8.8"],
  ])("normaliseIPv4(%s) = %s", (input, expected) => {
    expect(normaliseIPv4(input)).toBe(expected);
  });

  it.each(["example.com", "1.2.3.4.5", "256.1.1.1", "0xZZ", "", "a.1"])("normaliseIPv4(%j) is null", (input) => {
    expect(normaliseIPv4(input)).toBeNull();
  });
});

describe("assertPublicHttpUrl: hostnames", () => {
  // Mutation that must fail this: drop one suffix from the rule-2 list.
  it.each([
    "http://localhost/", "http://LOCALHOST/", "http://localhost./", "http://foo.localhost/", "http://a.b.localhost/",
    "http://printer.local/", "http://x.y.local/", "http://db.internal/", "http://a.b.internal/",
    "http://intranet/", "http://metadata/", "http://local/",
  ])("blocks %s", (url) => {
    expect(codeOf(() => assertPublicHttpUrl(url))).toBe("blocked_target");
  });

  // Mutation that must fail this: allow a public-looking IPv6 literal.
  it.each([
    "http://[::1]/", "http://[::]/", "http://[2606:4700:4700::1111]/", "http://[::ffff:127.0.0.1]/", "http://[fe80::1]/",
    "https://[2001:db8::1]:8443/",
  ])("blocks any IPv6 literal %s", (url) => {
    expect(codeOf(() => assertPublicHttpUrl(url))).toBe("blocked_target");
  });

  it("does not treat names that merely contain a blocked word as blocked", () => {
    for (const url of [
      "http://notlocalhost.com/",
      "https://localhost.example.com/",
      "https://my-local.dev/",
      "https://internal.example.org/",
    ]) {
      expect(assertPublicHttpUrl(url).href).toBe(new URL(url).href);
    }
  });
});

describe("assertPublicHttpUrl: scheme, credentials, ports", () => {
  // Mutation that must fail this: accept any scheme.
  it.each(["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "gopher://example.com/"])(
    "rejects scheme %s",
    (url) => {
      expect(codeOf(() => assertPublicHttpUrl(url))).toBe("invalid_url");
    },
  );

  it.each(["not a url", "", "http://", "//example.com"])("rejects unparsable %j", (url) => {
    expect(codeOf(() => assertPublicHttpUrl(url))).toBe("invalid_url");
  });

  // Mutation that must fail this: ignore url.username / url.password.
  it.each(["http://user:pass@example.com/", "https://user@example.com/", "https://:pw@example.com/"])(
    "blocks credentials in %s",
    (url) => {
      expect(codeOf(() => assertPublicHttpUrl(url))).toBe("blocked_target");
    },
  );

  // Mutation that must fail this: allow every port.
  it.each([21, 22, 25, 81, 3000, 5432, 6379, 8000, 9200, 65535])("blocks port %i", (port) => {
    expect(codeOf(() => assertPublicHttpUrl(`http://example.com:${port}/`))).toBe("blocked_target");
  });

  it.each([
    "http://example.com/", "https://example.com/", "http://example.com:80/", "https://example.com:443/",
    "http://example.com:8080/", "https://example.com:8443/", "https://example.com:80/", "http://example.com:443/",
  ])("allows %s", (url) => {
    expect(assertPublicHttpUrl(url)).toBeInstanceOf(URL);
  });

  it("accepts a URL object and returns the parsed URL", () => {
    const u = assertPublicHttpUrl(new URL("https://example.com/a?b=1#c"));
    expect(u.pathname).toBe("/a");
  });
});

describe("isBlockedIpAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1"])(
    "blocks %s",
    (ip) => {
      expect(isBlockedIpAddress(ip)).toBe(true);
    },
  );
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"])("allows %s", (ip) => {
    expect(isBlockedIpAddress(ip)).toBe(false);
  });
});
