import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioural regression test for #85: the open latch must not be held while
 * the `/api/notifications-seen` POST is pending. Plain-node vitest has no DOM,
 * so initNotifyBell runs against a minimal hand-rolled DOM stub + controllable
 * fetch. LIMITATION: the stub models only what the island touches; real
 * browser behaviour is covered by e2e/notifications.spec.ts.
 */
class El {
  hidden = false;
  textContent = "";
  className = "";
  href = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(e: unknown) => void>>();
  children: El[] = [];
  parent: El | null = null;
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  addEventListener(t: string, f: (e: unknown) => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), f]);
  }
  appendChild(c: El): El {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  replaceChildren(): void {
    this.children = [];
  }
  focus(): void {}
  contains(n: El): boolean {
    for (let c: El | null = n; c !== null; c = c.parent) if (c === this) return true;
    return false;
  }
  fire(t: string): void {
    for (const f of this.listeners.get(t) ?? []) f({ target: this });
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("notify bell re-open while the seen POST is pending (#85)", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a click after close starts a second open even though the first seen POST has not settled", async () => {
    const bell = new El();
    const toggle = new El();
    const badge = new El();
    const panel = new El();
    panel.hidden = true;
    badge.hidden = true;
    bell.hidden = true;
    for (const c of [toggle, badge, panel]) bell.appendChild(c);
    const bySel: Record<string, El> = {
      "[data-notify-bell]": bell,
      "[data-notify-toggle]": toggle,
      "[data-notify-badge]": badge,
      "[data-notify-panel]": panel,
    };
    const docListeners = new Map<string, Array<(e: unknown) => void>>();
    vi.stubGlobal("Node", El);
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      querySelector: (s: string) => bySel[s] ?? null,
      createElement: () => new El(),
      createTextNode: () => new El(),
      addEventListener: (t: string, f: (e: unknown) => void) => {
        docListeners.set(t, [...(docListeners.get(t) ?? []), f]);
      },
    });
    vi.stubGlobal("location", { protocol: "https:", host: "x.test" });
    vi.stubGlobal("setInterval", () => 0);
    vi.stubGlobal(
      "WebSocket",
      class {
        onmessage: unknown;
        onclose: unknown;
        onerror: unknown;
      },
    );

    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
    let listLoads = 0;
    let seenPosts = 0;
    let releaseSeen: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/me") return Promise.resolve(json({ loggedIn: true, csrfToken: "tok" }));
        if (url === "/api/notifications-count") return Promise.resolve(json({ count: 2 }));
        if (url === "/api/notifications") {
          listLoads++;
          return Promise.resolve(json({ notifications: [] }));
        }
        if (url === "/api/notifications-seen") {
          seenPosts++;
          return new Promise<Response>((res) => {
            releaseSeen = res;
          });
        }
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }),
    );

    const { initNotifyBell } = await import("../src/scripts/notify-bell");
    initNotifyBell();
    await flush();

    toggle.fire("click"); // open #1
    await flush();
    expect(panel.hidden).toBe(false);
    expect(listLoads).toBe(1);
    expect(seenPosts).toBe(1); // seen POST is now PENDING (never resolved yet)

    toggle.fire("click"); // close
    expect(panel.hidden).toBe(true);
    expect(toggle.attrs.get("aria-expanded")).toBe("false");

    toggle.fire("click"); // re-open while the seen POST is still pending
    await flush();
    expect(listLoads).toBe(2); // old code: latch swallowed this click
    expect(panel.hidden).toBe(false);
    expect(toggle.attrs.get("aria-expanded")).toBe("true");

    // The pending seen POST still lands afterwards and clears the badge.
    releaseSeen(json({}));
    await flush();
    expect(badge.hidden).toBe(true);
  });
});
