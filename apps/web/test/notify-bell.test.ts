import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(readFileSync(join(__dirname, "..", "src", "scripts", "notify-bell.ts"), "utf8"));
describe("notify bell island", () => {
  it("detects logged-in via the count endpoint, staying hidden on 401 (deviation 2)", () => {
    expect(code).toContain("/api/notifications-count");
    expect(code).toContain(".status"); // branches on it (200 → show, 401 → hide)
  });
  it("builds DOM safely — textContent/createElement only", () => {
    expect(code).toContain("createElement"); // positive anchor
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
  it("links each row to its notification target via the shared notificationHref helper", () => {
    expect(code).toContain("notificationHref");
    expect(code).toContain("@thinkersjournal/shared");
  });
  it("opens a dropdown, loads items, and marks all read with CSRF", () => {
    expect(code).toContain("/api/notifications");
    expect(code).toContain("/api/notifications-read");
    expect(code).toContain('"X-CSRF-Token"');
  });
  it("polls on visibility + interval", () => {
    expect(code).toContain("visibilitychange");
  });

  // --- M2.3b: realtime WS lifecycle ---------------------------------------

  it("derives the ws URL from location and opens a WebSocket to /api/notifications-ws", () => {
    // ⚠️ ANTI-VACUITY: co-locate the protocol derivation with the endpoint
    // path inside one URL-building region — not just "these tokens appear
    // somewhere in the file" (which would stay green even if the path were
    // hardcoded to "ws://" or the endpoint moved).
    expect(code).toMatch(
      /location\.protocol === "https:" \? "wss" : "ws"[\s\S]{0,200}\/api\/notifications-ws/,
    );
    expect(code).toContain("new WebSocket(");
  });

  it("opens the socket only after the bell is signed-in-revealed (never for anonymous viewers)", () => {
    // ⚠️ ANTI-VACUITY: pin that the connect call is GATED on the bell's
    // reveal (the count-200 signal) and fires only once — a regression that
    // opens the socket unconditionally at init (which WOULD break anonymous
    // viewers against the WS proxy) would fail this.
    expect(code).toMatch(/if \(wsStarted \|\| bell\.hidden\) return;/);
    expect(code).toMatch(/refreshCount\(bell, badge\)\.then\(/);
  });

  it("refreshes on a pushed nudge (content-free — never parses event.data) and keeps the poll as fallback", () => {
    // ⚠️ ANTI-VACUITY: co-locate onmessage with the refreshCount call AND the
    // !panel.hidden-gated list reload, and assert event.data is NEVER read
    // near onmessage — a regression that rendered straight from the pushed
    // message (breaking the content-free wire contract) would fail this.
    expect(code).toMatch(/onmessage = \(\) => \{[\s\S]{0,200}refreshCount\(bell, badge\)/);
    expect(code).toMatch(/onmessage[\s\S]{0,300}!panel\.hidden[\s\S]{0,100}loadList\(panel\)/);
    expect(code).not.toMatch(/onmessage[\s\S]{0,300}event\.data/);
    expect(code).toContain("setInterval(poll, 60_000)"); // poll fallback retained, unchanged interval
  });

  it("reconnects with exponential backoff (starts ~1s, doubles, caps at 30s) and resets after a successful open", () => {
    // ⚠️ ANTI-VACUITY: pin the backoff SHAPE, not just the word "reconnect"
    // appearing somewhere (a stray comment would satisfy a bare grep).
    expect(code).toMatch(/reconnectDelay = 1000/);
    expect(code).toMatch(/Math\.min\(reconnectDelay \* 2, 30_000\)/);
    expect(code).toMatch(/onopen = \(\) => \{[\s\S]{0,80}reconnectDelay = 1000/); // reset on success
    expect(code).toContain("onclose");
    expect(code).toContain("onerror");
  });

  it("gives up reconnecting after a failure cap (a dead session must not reconnect forever)", () => {
    // ⚠️ ANTI-VACUITY: pin that the cap actually STOPS the schedule (returns
    // without setting a timer) and that a successful open clears the counter —
    // a browser WS can't see the 401 handshake status, so an expired session
    // would otherwise reconnect at the 30s cap indefinitely (whole-branch
    // review finding). Co-locate the counter check with an early return.
    expect(code).toMatch(/reconnectFailures > MAX_RECONNECT_FAILURES[\s\S]{0,40}return/);
    expect(code).toMatch(/onopen = \(\) => \{[\s\S]{0,120}reconnectFailures = 0/); // cleared on a real connection
  });

  it("degraded-mode fetch helpers swallow network errors (no unhandled rejection from a fire-and-forget refresh)", () => {
    // ⚠️ ANTI-VACUITY: the refresh/list helpers are called `void ...(...)` from
    // the WS nudge and the poll, so a fetch() REJECTION on a transient network
    // blip would surface as an unhandled rejection unless caught. Pin a `catch`
    // co-located inside each helper's body.
    expect(code).toMatch(/async function fetchUnreadCount\(\)[\s\S]{0,400}catch/);
    expect(code).toMatch(/async function loadList\([\s\S]{0,400}catch/);
  });

  it("guards a single live socket across reconnects and still builds DOM safely", () => {
    expect(code).toMatch(/if \(ws !== null\) return/); // single-socket guard
    expect(code).toMatch(/ws = null/); // cleared before the next attempt is scheduled
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
});
