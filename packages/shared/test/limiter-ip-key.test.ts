import { describe, expect, it } from "vitest";

import { limiterIpKey } from "../src/limiter-ip-key";

/**
 * `limiterIpKey` — the IP part of a per-IP rate-limit key (review 1, I1).
 *
 * An IPv6 subscriber gets at least a /64, i.e. 2^64 source addresses, so a key
 * on the FULL address lets one host take a fresh bucket per request. The key is
 * therefore the /64 prefix. IPv4 stays whole. Anything that does not parse as
 * an IP passes through unchanged, so a malformed header can never collapse
 * unrelated callers into one bucket.
 */
describe("limiterIpKey", () => {
  it("keeps an IPv4 address whole", () => {
    expect(limiterIpKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("collapses an IPv6 address to its /64", () => {
    expect(limiterIpKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
  });

  it("gives two addresses in the SAME /64 the same key", () => {
    expect(limiterIpKey("2001:db8:1:2::a")).toBe(limiterIpKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  });

  it("CONTROL: addresses in DIFFERENT /64s get different keys", () => {
    expect(limiterIpKey("2001:db8:1:2::a")).not.toBe(limiterIpKey("2001:db8:1:3::a"));
  });

  it("expands `::` compression wherever it sits", () => {
    expect(limiterIpKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(limiterIpKey("::1")).toBe("0:0:0:0::/64");
    expect(limiterIpKey("::")).toBe("0:0:0:0::/64");
    expect(limiterIpKey("fe80::")).toBe("fe80:0:0:0::/64");
    expect(limiterIpKey("2001:db8:1:2:3::")).toBe("2001:db8:1:2::/64");
  });

  it("canonicalises spelling: case and leading zeros do not make a new bucket", () => {
    expect(limiterIpKey("2001:0DB8:0001:0002::A")).toBe("2001:db8:1:2::/64");
  });

  it("treats an IPv4-mapped address as the IPv4 address it maps", () => {
    expect(limiterIpKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(limiterIpKey("::FFFF:203.0.113.7")).toBe("203.0.113.7");
  });

  it("drops a zone id", () => {
    expect(limiterIpKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("passes garbage through unchanged", () => {
    for (const junk of ["", "not-an-ip", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "12345::1", "2001:db8::1::2", "999.1.1.1x"]) {
      expect(limiterIpKey(junk), junk).toBe(junk);
    }
  });
});
