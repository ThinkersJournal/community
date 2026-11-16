// SPDX-License-Identifier: MIT OR Apache-2.0
// M3.3a: the github connector's pure `identify` (spec 3: no I/O; null = not mine, so the URL falls to `web`).
import { describe, expect, it } from "vitest";

import { githubConnector } from "../src/references/connectors/github";

const id = (u: string) => githubConnector.identify(new URL(u));

describe("github connector identify", () => {
  it("an issue", () => {
    expect(id("https://github.com/Octo/Repo/issues/12")).toEqual({
      kind: "github",
      canonicalUrl: "https://github.com/octo/repo/issues/12",
      resourceKey: "github:octo/repo#issue:12",
    });
  });

  it("a pull request, www host, trailing slash, query and hash dropped", () => {
    expect(id("https://www.github.com/octo/repo/pull/7/?x=1#issuecomment-5")).toEqual({
      kind: "github",
      canonicalUrl: "https://github.com/octo/repo/pull/7",
      resourceKey: "github:octo/repo#pr:7",
    });
  });

  it("a CI check run", () => {
    expect(id("https://github.com/octo/repo/runs/987654")).toEqual({
      kind: "github",
      canonicalUrl: "https://github.com/octo/repo/runs/987654",
      resourceKey: "github:octo/repo#check:987654",
    });
  });

  it("a file with a line range keeps the ref and the range", () => {
    expect(id("https://github.com/octo/repo/blob/main/src/a.ts#L10-L20")).toEqual({
      kind: "github",
      canonicalUrl: "https://github.com/octo/repo/blob/main/src/a.ts#L10-L20",
      resourceKey: "github:octo/repo#file:main/src/a.ts#L10-L20",
    });
  });

  it("a single-line file anchor is a one-line range", () => {
    expect(id("https://github.com/octo/repo/blob/abc123/README.md#L5")?.resourceKey).toBe(
      "github:octo/repo#file:abc123/README.md#L5-L5",
    );
  });

  it("a file with no anchor is not claimed (a line range is the point of a file card)", () => {
    expect(id("https://github.com/octo/repo/blob/main/src/a.ts")).toBeNull();
  });

  // Controls: things that must fall through to `web`.
  it.each([
    "https://github.com/octo/repo",
    "https://github.com/octo/repo/issues",
    "https://github.com/octo/repo/issues/abc",
    "https://github.com/octo/repo/issues/12/extra",
    "https://github.com/octo/repo/pull/7/files",
    "https://github.com/settings/issues/1",
    "https://gist.github.com/octo/abc",
    "https://evilgithub.com/octo/repo/issues/12",
    "https://github.com.evil.test/octo/repo/issues/12",
    "https://example.com/octo/repo/issues/12",
    "http://github.com/octo/repo/issues/12",
  ])("not claimed: %s", (u) => {
    expect(id(u)).toBeNull();
  });

  it("two spellings of one issue share a resource key", () => {
    expect(id("https://github.com/OCTO/repo/issues/12")?.resourceKey).toBe(id("https://www.github.com/octo/REPO/issues/12/")?.resourceKey);
  });
});
