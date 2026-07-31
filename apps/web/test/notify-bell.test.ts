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
  it("opens a dropdown, loads items, advances SEEN on open and marks a group read on click-through (M2.3c)", () => {
    expect(code).toContain("/api/notifications");
    // Opening the bell advances the SEEN watermark (clears the badge) — it no
    // longer marks everything read.
    expect(code).toContain("/api/notifications-seen");
    expect(code).not.toContain("{ all: true }"); // the old mark-all-read-on-open is gone
    // Click-through on a rendered group is the ONLY thing that marks read, and it
    // posts that group's ids.
    expect(code).toMatch(/addEventListener\("click"[\s\S]{0,300}\/api\/notifications-read/);
    expect(code).toMatch(/\/api\/notifications-read[\s\S]{0,200}ids: group\.ids/);
    expect(code).toContain('"X-CSRF-Token"');
    // ⚠️ The click-through mark-read must survive the anchor's navigation tearing
    // down the document (Task 8's email suppression depends on read_at getting
    // written), so its fetch carries keepalive: true.
    expect(code).toMatch(/addEventListener\("click"[\s\S]{0,300}\/api\/notifications-read[\s\S]{0,120}keepalive: true/);
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

  it("arms the socket only on a FRESH signed-in count (never for anonymous, never off historical state)", () => {
    // ⚠️ ANTI-VACUITY: the poll gates connect() on refreshCount's FRESH boolean
    // (200 = signed in) — NOT a latched flag or the historical bell.hidden. A
    // regression that armed unconditionally (breaking anonymous viewers against
    // the WS proxy) or off a stale flag (never re-arming a recovered session)
    // fails this.
    expect(code).toMatch(
      /refreshCount\(bell, badge\)\.then\(\(signedIn\) => \{[\s\S]{0,200}if \(signedIn\) connect\(\)/,
    );
    expect(code).not.toContain("wsStarted"); // the historical/latched trigger is gone
  });

  it("refreshes on a pushed nudge (content-free — never parses event.data) and keeps the poll as fallback", () => {
    // ⚠️ ANTI-VACUITY: co-locate onmessage with the refreshCount call AND the
    // !panel.hidden-gated list reload, and assert event.data is NEVER read
    // near onmessage — a regression that rendered straight from the pushed
    // message (breaking the content-free wire contract) would fail this.
    expect(code).toMatch(/onmessage = \(\) => \{[\s\S]{0,200}refreshCount\(bell, badge\)/);
    // ⚠️ The live-nudge reload threads the REAL memoized CSRF token (M2.3c fix):
    // a nudge re-renders an OPEN panel, RE-WIRING each row's click-through
    // mark-read, so it must carry an authenticatable token — passing null would
    // 403 every re-rendered row's mark-read and drop read_at (Task 8 depends on
    // it). getCsrfToken() is memoized, so no extra /api/me hop.
    expect(code).toMatch(
      /onmessage[\s\S]{0,300}!panel\.hidden[\s\S]{0,200}getCsrfToken\(\)[\s\S]{0,160}loadList\(panel, t\)/,
    );
    expect(code).not.toMatch(/loadList\(panel, null\)/); // the un-authenticatable null path is gone
    expect(code).not.toMatch(/onmessage[\s\S]{0,300}event\.data/);
    expect(code).toContain("setInterval(poll, 60_000)"); // poll fallback retained, unchanged interval
  });

  it("re-arms via the poll on close/error — no bespoke backoff/cap/latch (two reviews found bugs in it)", () => {
    // ⚠️ The poll is the SINGLE (re)connect trigger; on close/error the socket
    // ref is just dropped (identity-guarded) so the next signed-in poll re-arms.
    // Pin that the error-prone reconnect machinery is GONE: a self-scheduled
    // backoff could pin at its cap forever (whole-branch finding) OR a failure
    // cap + latch could strand the WS on a recovered session (Copilot finding).
    expect(code).toMatch(/if \(ws === socket\) ws = null/); // drop → allows re-arm
    expect(code).toMatch(/onclose = drop/);
    expect(code).toMatch(/onerror = drop/);
    expect(code).not.toContain("reconnectDelay");
    expect(code).not.toContain("MAX_RECONNECT_FAILURES");
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
    expect(code).toMatch(/if \(ws !== null\) return/); // single-socket guard in connect()
    expect(code).toMatch(/ws = null/); // dropped on close/error so the poll can re-arm
    expect(code).not.toContain("innerHTML");
    expect(code).not.toContain("insertAdjacentHTML");
  });
});
