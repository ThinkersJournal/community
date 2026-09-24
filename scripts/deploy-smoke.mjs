#!/usr/bin/env node
/**
 * POST-DEPLOY SMOKE CHECK — run against a DEPLOYED, PUBLIC hostname.
 *
 * Usage:
 *   pnpm smoke:deploy --turnstile-token <a real Turnstile token>
 *   pnpm smoke:deploy https://community.thinkersjournal.com --turnstile-token <token>
 *
 *   # the host and token may also come from the environment:
 *   SMOKE_BASE_URL=https://community.thinkersjournal.com \
 *   SMOKE_TURNSTILE_TOKEN=<token> pnpm smoke:deploy
 *
 * Exits 0 only if every check passes; non-zero (with a named failure) otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ RETARGETED 2026-09-24 — READ THIS BEFORE TRUSTING ANYTHING BELOW.
 * ─────────────────────────────────────────────────────────────────────────────
 * The PREVIOUS version of this script hit the `api` Worker's OWN
 * `*.workers.dev` URL directly. That URL no longer answers at all —
 * `apps/api/wrangler.jsonc` sets `workers_dev: false` (the post-DNS-cutover
 * deploy-gate item), and the host now returns Cloudflare's own edge error
 * 1042, `text/plain`, NOT this app's JSON 404 handler. VERIFIED, not
 * assumed: the two look identical at the status-code level (both can be a
 * 404) and only differ in body/content-type — check BOTH if this ever needs
 * re-diagnosing.
 *
 * So this script had been SILENTLY UNRUNNABLE against production since the
 * cutover, and nobody noticed — a verification tool that cannot run reports
 * nothing, which is indistinguishable from a verification that passed. It
 * is retargeted at the topology that actually exists: the api has NO public
 * route at all now, reachable only via the `web` Worker's Service Binding,
 * so `web`'s own public hostname is the only path in. `--turnstile-token`'s
 * requirement, and WHY (a real, human-solved, single-use ~300s-TTL token,
 * production runs real Turnstile keys), is UNCHANGED — see the bottom of
 * this header. Do not add a bypass, a test-key path, or a "skip in
 * production" flag for it: a fallback that makes verification easy is
 * exactly what made bot defense silently absent in #89.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — two gaps it closes, both of which were prose in README.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `TEST_ROUTES` WAS A HUMAN CHECKBOX, meant to be asserted mechanically —
 *    see the ⚠️ NOT VERIFIABLE ANYMORE note on `checkTestRoutesDisabled`
 *    below for what changed and why this script can no longer close that
 *    gap on its own.
 *
 * 2. THE README'S SMOKE TEST VALIDATED NEITHER THING IT NEEDED TO. `/health`
 *    + a rendered page touch NEITHER Postgres NOR argon2 — but "run a pass
 *    on real infra" exists precisely because local dev has no real
 *    Hyperdrive, and because a real `wrangler deploy` is the FIRST true
 *    test of the argon2id `.wasm` bundling (the vitest pool bundles it
 *    differently). The signup check drives a real signup, which is the
 *    smallest request that exercises all of it.
 *
 * ⚠️ THIS EXERCISES THE REAL BROWSER PATH NOW, WHICH IS STRICTER AND MORE
 * FAITHFUL THAN THE OLD DIRECT-TO-API JSON POST. `web`'s `/signup` page is a
 * server-rendered FORM, not a JSON endpoint — a real browser posting
 * form-urlencoded data to `web`'s own origin, which forwards to the api
 * over the Service Binding. The `Origin` header this script sends is
 * DERIVED FROM `baseUrl` itself (never hardcoded separately from it): that
 * is exactly what a real browser on that exact host would send, and it is
 * what actually exercises `checkOrigin`'s allowlist rather than assuming a
 * fixed value stays on it forever.
 *
 * ⚠️ THIS WRITES A REAL USER TO THE PRODUCTION DATABASE. That is the point —
 * a dry run would prove nothing about Hyperdrive. The address is a per-run
 * `smoke-<uuid>@example.com`, unverified (nothing ever clicks its link) and
 * inert, but it is a real row: clean these up periodically, and never point
 * this at an environment where an extra `users` row matters.
 *
 * ⚠️ NEEDS A REAL TURNSTILE TOKEN, PERMANENTLY — NOT A TODO. Production runs
 * real Turnstile keys (the deploy gate requires it), so the real widget must
 * be solved by a human and its `cf-turnstile-response` value copied in;
 * tokens are single-use and short-lived (~300s), so fetch a fresh one per
 * run. There is no way to automate this that does not reintroduce the exact
 * fallback #89 was about, and none is planned.
 */

const HEALTH_PATH = "/health/db";
const SIGNUP_PATH = "/signup";

/** The default target — the one public hostname the whole app is reachable through. */
const DEFAULT_BASE_URL = "https://community.thinkersjournal.com";

/** The exact cookie attributes production MUST emit (apps/api/src/auth/session.ts). */
const REQUIRED_COOKIE_ATTRS = ["Secure"];

/** A password satisfying `SignupInput` (>= 12 chars). Never reused. */
const SMOKE_PASSWORD = "smoke-correct-horse-battery-staple";

const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";

function pass(message) {
  console.log(`${GREEN}  PASS${RESET}  ${message}`);
}

function notice(message) {
  console.log(`${YELLOW}NOTICE${RESET}  ${message}`);
}

/** A check failure — distinct from a usage error, which exits 2. */
class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message);
}

/**
 * `fetch`, with the response body ALWAYS consumed.
 *
 * ⚠️ CONSUMING THE BODY IS NOT OPTIONAL HERE, even where the body is unused. An
 * undici response whose body is never read holds its socket open, and this
 * script is deliberately short-lived: a lingering handle at exit crashes the
 * process on Windows with a libuv assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`), which replaces the intended exit
 * code with a spurious one — turning a clean, scriptable "check failed" into a
 * crash. Reading the text also gives every failure path something to quote.
 *
 * ⚠️ NETWORK/DNS/TLS FAILURES PROPAGATE AS A REJECTED PROMISE, deliberately —
 * an unreachable target must FAIL the check that calls this, never be
 * silently treated as "nothing to report" (the exact bug that let this whole
 * script go unrunnable for two days without anyone finding out). `main()`'s
 * catch block turns that rejection into the same loud FAIL every other
 * failure gets.
 */
async function get(url, init) {
  const response = await fetch(url, { redirect: "manual", ...init });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

function usage(message) {
  console.error(`${RED}usage error:${RESET} ${message}\n`);
  console.error(
    "  pnpm smoke:deploy [base-url] --turnstile-token <token>\n" +
      "\n" +
      `  [base-url]          the deployed PUBLIC hostname, default ${DEFAULT_BASE_URL}\n` +
      "                      (or SMOKE_BASE_URL). This is the `web` Worker's own\n" +
      "                      origin — the `api` Worker has no public route at all\n" +
      "                      and cannot be targeted directly; see this file's header.\n" +
      "  --turnstile-token   a real, freshly-solved Turnstile token (single-use,\n" +
      "                      ~300s TTL). May also be given as SMOKE_TURNSTILE_TOKEN.\n" +
      "                      Production runs REAL Turnstile keys, so signup fails\n" +
      "                      without one and the signup check cannot run. This is a\n" +
      "                      permanent limitation, not a TODO — see this file's header.\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let baseUrl;
  // Tracks whether a POSITIONAL arg has already set baseUrl, distinct from
  // baseUrl being undefined — needed so a second positional arg is correctly
  // rejected as "unexpected extra argument" rather than silently accepted
  // (baseUrl itself may still get a value below from SMOKE_BASE_URL or the
  // default before this function returns, which must not count as "already
  // given positionally" for that rejection to work).
  let baseUrlFromPositional = false;
  let turnstileToken = process.env.SMOKE_TURNSTILE_TOKEN;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--turnstile-token") {
      turnstileToken = argv[++i];
      if (turnstileToken === undefined) {
        usage("--turnstile-token needs a value");
      }
    } else if (arg.startsWith("--")) {
      usage(`unknown flag ${arg}`);
    } else if (!baseUrlFromPositional) {
      // Explicit positional arg always wins over SMOKE_BASE_URL — explicit
      // beats environment, same precedence as --turnstile-token.
      baseUrl = arg;
      baseUrlFromPositional = true;
    } else {
      usage(`unexpected extra argument ${arg}`);
    }
  }

  baseUrl ??= process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL;
  if (turnstileToken === undefined || turnstileToken === "") {
    usage("a real Turnstile token is required (--turnstile-token or SMOKE_TURNSTILE_TOKEN)");
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    usage(`"${baseUrl}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    usage(`the base URL must be https (got "${parsed.protocol}") — this checks production properties`);
  }

  // Normalize away a trailing slash so `${base}${path}` is always well-formed.
  return { baseUrl: parsed.origin, turnstileToken };
}

/**
 * ⚠️ NOT VERIFIABLE ANYMORE — READ BEFORE "FIXING" THIS.
 *
 * `TEST_ROUTES` used to be checkable from outside via `GET
 * /__test/last-verify-token` directly on the api's own public URL — a 404
 * proved the flag was unset (the route is designed to be indistinguishable
 * from one that doesn't exist), anything else meant it had leaked into
 * production (a live account-takeover credential handed to anyone who asks).
 *
 * That path is GONE. The api has no public route at all post-cutover, and
 * `__test/*` is deliberately NOT proxied through `web` — proxying a
 * dev/test-only credential-leak seam through the public Worker would be a
 * worse hole than the one this check exists to catch. There is currently no
 * public path from which this property can be verified at all.
 *
 * ⚠️ DO NOT invent one (a new `web`-hosted proxy to `/__test/*`, a special
 * "is TEST_ROUTES set" endpoint, anything reachable from outside) just to
 * make this script whole again — that trades a real, if currently
 * unautomatable, security check for a new public attack surface whose only
 * job is answering "is a security flag misconfigured", which is itself
 * useful reconnaissance to hand an attacker for free. If this needs
 * automating again, it should be done INSIDE Cloudflare (a scheduled check
 * with direct access to the Worker, or reading the deployed var list via
 * the API with an authenticated token), not as a new public HTTP route.
 *
 * So: print a loud, impossible-to-miss NOTICE instead of a PASS, and instruct
 * the manual check. This function does NOT throw — a missing automated check
 * is not itself a check failure, and conflating the two would make a real
 * future regression here harder to see under the noise.
 */
function noticeTestRoutesUnverifiable() {
  notice(
    "TEST_ROUTES cannot be verified by this script anymore — no public path exists post-cutover\n" +
      "        (the api Worker has no public route; __test/* is deliberately not proxied through\n" +
      "        web). CONFIRM MANUALLY: the Cloudflare dashboard's Workers Builds project vars for\n" +
      "        thinkersjournal-api must NOT have TEST_ROUTES set. If it is set, that is a live\n" +
      "        account-takeover vector (GET /__test/last-verify-token hands out a real\n" +
      "        verification token) AND strips `Secure` from the session cookie — see the signup\n" +
      "        check below, which verifies the cookie consequence directly even though it cannot\n" +
      "        verify the flag itself.",
  );
}

/** The `web`/`api` pair is up and the Service Binding between them is live. */
async function checkHealth(baseUrl) {
  const url = `${baseUrl}${HEALTH_PATH}`;
  const response = await get(url);

  if (response.status !== 200) {
    fail(`${url} answered ${response.status}, expected 200 — web and/or api is not serving.`);
  }
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    fail(`${url} returned a 200 with a non-JSON body — expected {"status":"ok",...}.\n      Body: ${response.body.slice(0, 200)}`);
  }
  if (data.status !== "ok") {
    fail(
      `${url} reports status="${data.status}", expected "ok" — the api is reachable but its own` +
        ` health probe is unhappy.\n      Body: ${response.body.slice(0, 200)}`,
    );
  }
  pass(`${HEALTH_PATH} -> 200, status:"ok" (web reachable, and web -> api Service Binding live)`);
}

/**
 * A REAL signup against REAL infra, through the real browser-facing page —
 * and the production cookie shape.
 *
 * A successful render here is the load-bearing part, and it proves — on real
 * infrastructure, in one request — every piece that local dev and the vitest
 * pool cannot:
 *
 *   • checkOrigin's allowlist actually recognizing this exact host's Origin.
 *   • HYPERDRIVE connectivity + the dup-check/INSERT transaction (real Neon,
 *     real pooling, real TLS — locally both bindings are just a direct socket
 *     to Docker Postgres).
 *   • The argon2id `.wasm` BUNDLING through a real `wrangler deploy`. This is
 *     its first true test: workerd forbids runtime Wasm compilation, so if the
 *     static `.wasm` import did not survive bundling, `hashPassword` throws and
 *     this fails.
 *   • The KV write (`SESSIONS`) behind `createSession`.
 *   • The DURABLE OBJECT round-trip (`USER_SECURITY.getEpoch()`).
 *   • Turnstile against the real secret AND the real site key's widget.
 *
 * Then the cookie: `Secure` (the session cookie is otherwise HOST-ONLY, with no
 * `Domain` attribute) is the OTHER half of the `TEST_ROUTES` gate
 * (apps/api/src/auth/session.ts), and its failure mode is silent — session
 * tokens riding plaintext http, with every test still green. This is now the
 * ONLY externally-observable proof that flag is unset (see
 * `noticeTestRoutesUnverifiable` above) — it was always the more direct
 * consequence, and post-cutover it is the only one left reachable.
 *
 * ⚠️ SUCCESS IS DETECTED FROM THE RENDERED PAGE, NOT A STATUS CODE — this hits
 * `web`'s own `/signup` page (a server-rendered FORM POST target), which
 * ALWAYS renders 200 whether the signup succeeded or not (see
 * apps/web/src/pages/signup.astro). The page marks success with
 * `id="check-email"`; failure is `id="error"` with the shown message.
 *
 * ⚠️ `getSetCookie()`, not `headers.get("Set-Cookie")`: the latter joins
 * multiple cookies with ", " into one unparseable string.
 */
async function checkSignup(baseUrl, turnstileToken) {
  const url = `${baseUrl}${SIGNUP_PATH}`;
  const uuid = crypto.randomUUID();
  const email = `smoke-${uuid}@example.com`;
  // handle-at-signup: signup REQUIRES `username` and rejects without it.
  // Derived from the same uuid as `email` (hyphens stripped — the api's
  // handle format is `[a-z0-9_]{3,30}`, no hyphens) so a run's row is
  // identifiable from either field; `smoke_` (6 chars) + 24 of the uuid's
  // 32 hex chars lands exactly at the 30-char cap.
  const username = `smoke_${uuid.replace(/-/g, "")}`.slice(0, 30);

  const form = new URLSearchParams({ username, email, password: SMOKE_PASSWORD, turnstileToken });

  const response = await get(url, {
    method: "POST",
    headers: {
      // A real browser on THIS exact host sends exactly this — derived from
      // baseUrl, never a separately-hardcoded value that could drift from
      // whatever `checkOrigin`'s allowlist actually contains. See this
      // file's header for why this is stricter than the old direct-to-api
      // JSON approach.
      Origin: baseUrl,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (response.status !== 200) {
    fail(`POST ${SIGNUP_PATH} answered ${response.status}, expected 200 (the page itself always 200s).\n      Body: ${response.body.slice(0, 400)}`);
  }

  if (!response.body.includes('id="check-email"')) {
    const errorMatch = /id="error"[^>]*>([^<]*)</.exec(response.body);
    const shown = errorMatch ? errorMatch[1] : "(no #error message found — check the raw body)";
    fail(
      `signup did not succeed — the page did not render its "check email" success state.\n` +
        `      Shown to the user: ${shown}\n` +
        `      Common causes: an expired/already-used Turnstile token (get a fresh one, they are\n` +
        `      single-use and expire in ~300s), a rejected Origin, or a real infra failure — check\n` +
        `      \`wrangler tail\` for thinkersjournal-api for the underlying error.`,
    );
  }
  pass(`POST ${SIGNUP_PATH} -> signup succeeded (Origin allowlist + Hyperdrive + argon2id wasm + KV + DO + Turnstile all live)`);

  const cookies = response.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith("tj_session="));
  if (session === undefined) {
    fail(
      `signup succeeded but set no tj_session cookie.\n` +
        `      Set-Cookie headers seen: ${cookies.length === 0 ? "(none)" : cookies.join(" | ")}`,
    );
  }

  const missing = REQUIRED_COOKIE_ATTRS.filter((attr) => !session.includes(attr));
  if (missing.length > 0) {
    fail(
      `the session cookie is MISSING ${missing.join(" and ")}.\n` +
        `      TEST_ROUTES has leaked into production (apps/api/src/auth/session.ts\n` +
        `      strips this attribute when it is "1"), which means session\n` +
        `      tokens are riding plaintext http. Unset it and redeploy.\n` +
        `      Cookie: ${session}`,
    );
  }
  pass(`the session cookie carries ${REQUIRED_COOKIE_ATTRS.join(" + ")}`);

  console.log(`        (wrote a real, unverified user: ${email})`);
}

async function main() {
  const { baseUrl, turnstileToken } = parseArgs(process.argv.slice(2));

  console.log(`\nPost-deploy smoke check against ${baseUrl}\n`);

  try {
    noticeTestRoutesUnverifiable();
    await checkHealth(baseUrl);
    await checkSignup(baseUrl, turnstileToken);
  } catch (err) {
    if (err instanceof CheckFailure) {
      console.error(`${RED}  FAIL${RESET}  ${err.message}`);
    } else {
      // A network/DNS error, a TLS failure, an unreachable host — report it as a
      // failed smoke check rather than an unhandled rejection stack. This is the
      // exact failure shape that went unnoticed for two days when the target
      // stopped existing: it must be loud, never silent.
      console.error(`${RED}  FAIL${RESET}  the check could not complete: ${err}`);
    }
    console.error(`\n${RED}Smoke check FAILED — do not proceed with the cutover.${RESET}\n`);
    // `exitCode`, NOT `process.exit(1)`: the latter tears the process down while
    // undici's TLS socket is still closing, which on Windows aborts with a libuv
    // assertion and reports 127 instead of 1 — a crash where a clean, scriptable
    // failure was intended. Setting the code and returning lets node exit
    // normally, and `get()` above has already drained every body.
    process.exitCode = 1;
    return;
  }

  console.log(`\n${GREEN}All smoke checks passed.${RESET}\n`);
}

await main();
