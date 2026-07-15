import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src";

/**
 * THE ERROR-ENVELOPE INVENTORY.
 *
 * ⚠️ WHY THIS FILE EXISTS. Before M1 the api answered errors in FOUR dialects
 * ({error}, {code}, plain text, empty), and apps/web/src/lib/api.ts had to
 * carry a comment warning that a null body is not an error signal. M1 roughly
 * triples the route count; each new route would inherit whichever dialect its
 * neighbour happened to use. This suite makes "every non-2xx is
 * {code, message?}" checkable rather than remembered.
 *
 * It asserts the SHAPE, not the code strings — the individual route suites
 * already pin those (they are a wire contract the web app branches on).
 */
const ALLOWED_ORIGIN = "http://localhost:8787";

async function fetchWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** One request per distinct error path the Worker can reach without setup. */
const CASES: ReadonlyArray<readonly [string, () => Request]> = [
  ["404 unmatched path", () => new Request("https://api.test/nope")],
  [
    "400 malformed JSON",
    () =>
      new Request("https://api.test/auth/signup", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: "{",
      }),
  ],
  [
    "400 zod rejection",
    () =>
      new Request("https://api.test/auth/signup", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ email: "nope", password: "x", turnstileToken: "t" }),
      }),
  ],
  [
    "403 rejected origin",
    () =>
      new Request("https://api.test/auth/login", {
        method: "POST",
        headers: { Origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "x" }),
      }),
  ],
  [
    "401 no session (pipeline step 2)",
    () =>
      new Request("https://api.test/posts", {
        method: "POST",
        headers: { Origin: ALLOWED_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ title: "t", markdownSource: "b" }),
      }),
  ],
  ["400 verify-email with no token", () => new Request("https://api.test/verify-email")],
  [
    "401 csrf route with no session",
    () => new Request("https://api.test/auth/csrf"),
  ],
];

describe("every non-2xx carries the {code, message?} envelope", () => {
  it.each(CASES)("%s", async (_name, build) => {
    const response = await fetchWorker(build());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("content-type")).toBe("application/json");

    const body: unknown = await response.json();
    expect(
      body,
      "a non-2xx body must be an object carrying a string `code` — see apps/api/src/http/errors.ts. If you are here because you added a route: return errorResponse(...), never a bare string or {error}.",
    ).toEqual(expect.objectContaining({ code: expect.any(String) }));
    // Nothing may smuggle the old dialect back in alongside the new one.
    expect(body).not.toHaveProperty("error");
  });
});
