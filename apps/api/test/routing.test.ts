import { describe, expect, it } from "vitest";

import { findRoute, matchPattern, type RouteDef } from "../src/routing";

describe("matchPattern", () => {
  it("matches an exact literal path and yields no params", () => {
    expect(matchPattern("/health", "/health")).toEqual({});
  });

  it("rejects a different literal", () => {
    expect(matchPattern("/health", "/healthz")).toBeNull();
  });

  it("rejects a path with a different segment count", () => {
    expect(matchPattern("/posts", "/posts/abc")).toBeNull();
    expect(matchPattern("/posts/:id", "/posts")).toBeNull();
  });

  it("captures a named segment", () => {
    expect(matchPattern("/posts/:id", "/posts/abc-123")).toEqual({ id: "abc-123" });
  });

  it("percent-decodes a captured segment", () => {
    expect(matchPattern("/u/:name", "/u/a%20b")).toEqual({ name: "a b" });
  });

  it("rejects an EMPTY captured segment", () => {
    // `/posts//` must not resolve to `{ id: "" }` — an empty id would reach a
    // handler as a real value and produce a nonsense query.
    expect(matchPattern("/posts/:id", "/posts/")).toBeNull();
  });

  it("rejects an undecodable segment rather than throwing", () => {
    // decodeURIComponent throws on a lone '%'; a malformed URL is a 404, not a 500.
    expect(matchPattern("/posts/:id", "/posts/%")).toBeNull();
  });

  it("does not let a param swallow a slash", () => {
    expect(matchPattern("/posts/:id", "/posts/a/b")).toBeNull();
  });
});

describe("findRoute", () => {
  const handler = async (): Promise<Response> => new Response("x");
  const routes: readonly RouteDef[] = [
    { method: "GET", pattern: "/posts", handler },
    { method: "POST", pattern: "/posts", handler },
    { method: "GET", pattern: "/posts/:id", handler },
  ];

  it("matches on method AND path", () => {
    expect(findRoute(routes, "POST", "/posts")?.route.pattern).toBe("/posts");
    expect(findRoute(routes, "GET", "/posts/1")?.params).toEqual({ id: "1" });
  });

  it("returns null for a known path with an unregistered method", () => {
    expect(findRoute(routes, "DELETE", "/posts")).toBeNull();
  });

  it("returns null for an unknown path", () => {
    expect(findRoute(routes, "GET", "/nope")).toBeNull();
  });
});
