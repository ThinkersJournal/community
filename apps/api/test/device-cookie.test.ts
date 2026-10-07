import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import worker from "../src";
import { clientCountry, deviceCookieFor, readDeviceToken, sessionAndDeviceHeaders } from "../src/security/device-cookie";

import { createVerifiedActor, deleteCreatedUsers } from "./actor";

afterEach(() => deleteCreatedUsers());

/**
 * The device cookie on the response path (security-alerting spec §4.1; plan
 * Task 16). The suite runs with TEST_ROUTES="1", so the dev name is the live
 * one here; the production string is pinned in packages/shared's tests.
 */
const GOOD = "A".repeat(43);
const req = (cookie?: string, headers: Record<string, string> = {}) =>
  new Request("https://api.test/", { headers: cookie === undefined ? headers : { ...headers, Cookie: cookie } });

describe("readDeviceToken / deviceCookieFor", () => {
  it("reuses a well-formed cookie and mints nothing", () => {
    expect(readDeviceToken(req(`tj_session=x; tj_device_dev=${GOOD}`), env)).toBe(GOOD);
    expect(deviceCookieFor(req(`tj_device_dev=${GOOD}`), env)).toEqual({ token: GOOD, setCookie: null });
  });

  it.each(["", "short", `${GOOD}A`, `${"A".repeat(42)}=`, `${"A".repeat(42)}!`])(
    "treats %j as absent and mints a fresh 43-character token",
    (value) => {
      const d = deviceCookieFor(req(`tj_device_dev=${value}`), env);
      expect(d.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(d.setCookie).toBe(`tj_device_dev=${d.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    },
  );

  it("never reads the production name in dev, nor the dev name in production", () => {
    expect(readDeviceToken(req(`__Host-tj_device=${GOOD}`), env)).toBeNull();
    expect(readDeviceToken(req(`tj_device_dev=${GOOD}`), { TEST_ROUTES: undefined })).toBeNull();
    expect(readDeviceToken(req(`__Host-tj_device=${GOOD}`), {})).toBe(GOOD);
  });

  it("the session cookie comes first, then the device cookie: two distinct Set-Cookie headers", () => {
    const h = sessionAndDeviceHeaders("tj_session=s; Path=/", { token: GOOD, setCookie: `tj_device_dev=${GOOD}` }, true);
    expect(h.getSetCookie()).toEqual(["tj_session=s; Path=/", `tj_device_dev=${GOOD}`]);
    expect(h.get("content-type")).toBe("application/json");
  });

  it("country: two capital letters from X-TJ-Client-Country, else CF-IPCountry, else null; never anything else", () => {
    expect(clientCountry(req(undefined, { "X-TJ-Client-Country": "DE" }))).toBe("DE");
    expect(clientCountry(req(undefined, { "CF-IPCountry": "FR" }))).toBe("FR");
    expect(clientCountry(req(undefined, { "X-TJ-Client-Country": "de" }))).toBeNull();
    expect(clientCountry(req(undefined, { "X-TJ-Client-Country": "203.0.113.9" }))).toBeNull();
    expect(clientCountry(req())).toBeNull();
  });
});

describe("logout and logout-all leave the device cookie alone (§4.1)", () => {
  it.each(["/auth/logout", "/auth/logout-all"])("%s's Set-Cookie list names only the session cookie", async (path) => {
    const actor = await createVerifiedActor();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: { Origin: "http://localhost:8787", Cookie: `${actor.cookie}; tj_device_dev=${GOOD}`, "X-CSRF-Token": actor.csrfToken },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const names = res.headers.getSetCookie().map((c) => c.split("=")[0]);
    expect(names).toEqual(["tj_session"]);
  });
});
