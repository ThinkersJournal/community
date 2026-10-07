import { beforeEach } from "vitest";

import { SecurityEventBuffer } from "@thinkersjournal/shared";

import { setSecurityScopeOverridesForTests } from "../../src/security/scope";

/**
 * Pool-project setup (vitest.config.ts `setupFiles`; security-alerting plan).
 * Before EVERY test, counting gets a buffer that flushes at once into
 * counter stubs that drop the batch.
 *
 * ⚠️ WHY THIS IS NOT OPTIONAL. In production the buffer flushes inside the
 * request's `waitUntil` after FLUSH_DELAY_MS (5 s). A test that awaits
 * `waitOnExecutionContext` after any `security:` event would therefore wait
 * 5 s per request, and a rate-limit burst (test/login.test.ts,
 * test/reset-password.test.ts) would straddle the emulator's wall-clock limiter
 * window and lose its count (test/helpers/limiter-window.ts). Observed in the
 * plan's full-suite run: five rate-limit burst tests failed until this existed.
 *
 * It also keeps unrelated tests from writing into the REAL counter instances.
 * A test that asserts on counting installs its own overrides; its afterEach may
 * reset them with `null`, and this hook restores the default before the next.
 */
beforeEach(() => {
  setSecurityScopeOverridesForTests({
    buffer: new SecurityEventBuffer(() => Promise.resolve()),
    stubFor: () => ({ record: () => Promise.resolve() }),
  });
});
