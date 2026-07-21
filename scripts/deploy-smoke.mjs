#!/usr/bin/env node
/**
 * POST-DEPLOY SMOKE CHECK for the `api` Worker — run against a DEPLOYED URL.
 *
 * Usage:
 *   pnpm smoke:deploy https://thinkersjournal-api.<subdomain>.workers.dev \
 *     --turnstile-token <a real Turnstile token>
 *
 *   # the token may also come from the environment:
 *   SMOKE_TURNSTILE_TOKEN=<token> pnpm smoke:deploy https://…workers.dev
 *
 * Exits 0 only if every check passes; non-zero (with a named failure) otherwise.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — two gaps it closes, both of which were prose in README.md.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `TEST_ROUTES` WAS A HUMAN CHECKBOX. The deploy gate said to "assert this
 *    with a deploy check" and no such check existed. That flag now gates TWO
 *    security properties, not one — `GET /__test/last-verify-token` (which hands
 *    out a live account-takeover credential) AND the session cookie's
 *    `Secure` attribute (apps/api/src/auth/session.ts) — and it is enforced only
 *    by its ABSENCE, i.e. by nobody having typed it into the Workers Builds
 *    dashboard. Concentrating two properties on one silent, absence-enforced
 *    flag is exactly what raises the value of asserting it mechanically. Steps 1
 *    and 3 below are that assertion, from the outside, against the real deploy.
 *
 * 2. THE README'S SMOKE TEST VALIDATED NEITHER THING IT NEEDED TO. `/health` +
 *    a rendered page touch NEITHER Postgres NOR argon2 — but "run a pass on real
 *    infra" exists precisely because local dev has no real Hyperdrive, and
 *    because a real `wrangler deploy` is the FIRST true test of the argon2id
 *    `.wasm` bundling (the vitest pool bundles it differently). Step 3 drives a
 *    real signup, which is the smallest request that exercises all of it.
 *
 * ⚠️ WHY A NON-BROWSER CLIENT CAN DO THIS AT ALL, PRE-CUTOVER. The first deploy
 * lands on `*.workers.dev`, and `checkOrigin`'s allowlist contains no
 * `workers.dev` origin while the session cookie is HOST-ONLY (no `Domain`
 * attribute), scoped to exactly `community.thinkersjournal.com`. So from a
 * BROWSER on the workers.dev URL every POST 403s and the cookie is rejected —
 * the browser path simply cannot be validated before DNS cutover. But
 * `checkOrigin` reads a CLIENT-SUPPLIED header, and the api has a public URL,
 * so a script can set `Origin: https://community.thinkersjournal.com` and
 * exercise the true production path
 * end to end. That is not a bypass of anything: the Origin allowlist defends
 * BROWSERS (a page on evil.com cannot forge the header), never non-browser
 * clients, and the api's real guards against those are `TEST_ROUTES` unset,
 * CSRF, and the session/epoch checks. See README.md's deploy gate.
 *
 * ⚠️ THIS WRITES A REAL USER TO THE PRODUCTION DATABASE. That is the point — a
 * dry run would prove nothing about Hyperdrive. The address is a per-run
 * `smoke-<uuid>@example.com`, unverified (nothing ever clicks its link) and
 * inert, but it is a real row: clean these up periodically, and never point this
 * at an environment where an extra `users` row matters.
 *
 * ⚠️ NEEDS A REAL TURNSTILE TOKEN. Production runs real Turnstile keys (the
 * deploy gate requires it), so the dummy always-passes secret is not deployed
 * and signup 403s without a genuine token. Obtain one by solving the widget on
 * the real signup page and copying the `cf-turnstile-response` value. Tokens are
 * single-use and short-lived (~300s), so fetch a fresh one per run.
 */

const TEST_TOKEN_PATH = "/__test/last-verify-token";
const HEALTH_PATH = "/health";
const SIGNUP_PATH = "/auth/signup";

/**
 * The Origin the signup is sent with. A PRODUCTION origin from `checkOrigin`'s
 * allowlist (apps/api/src/auth/csrf.ts) — deliberately not the workers.dev URL
 * under test, which is not on that allowlist and never should be.
 */
const PRODUCTION_ORIGIN = "https://community.thinkersjournal.com";

/** The exact cookie attributes production MUST emit (apps/api/src/auth/session.ts). */
const REQUIRED_COOKIE_ATTRS = ["Secure"];

/** A password satisfying `SignupInput` (>= 12 chars). Never reused. */
const SMOKE_PASSWORD = "smoke-correct-horse-battery-staple";

const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";

function pass(message) {
  console.log(`${GREEN}  PASS${RESET}  ${message}`);
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
 */
async function get(url, init) {
  const response = await fetch(url, { redirect: "manual", ...init });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

function usage(message) {
  console.error(`${RED}usage error:${RESET} ${message}\n`);
  console.error(
    "  pnpm smoke:deploy <api-base-url> --turnstile-token <token>\n" +
      "\n" +
      "  <api-base-url>      the DEPLOYED api, e.g.\n" +
      "                      https://thinkersjournal-api.<subdomain>.workers.dev\n" +
      "  --turnstile-token   a real, freshly-solved Turnstile token (single-use,\n" +
      "                      ~300s TTL). May also be given as SMOKE_TURNSTILE_TOKEN.\n" +
      "                      Production runs REAL Turnstile keys, so signup 403s\n" +
      "                      without one and step 3 cannot run.\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let baseUrl;
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
    } else if (baseUrl === undefined) {
      baseUrl = arg;
    } else {
      usage(`unexpected extra argument ${arg}`);
    }
  }

  if (baseUrl === undefined) {
    usage("the deployed api's base URL is required");
  }
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
    usage(`the api URL must be https (got "${parsed.protocol}") — this checks production properties`);
  }

  // Normalize away a trailing slash so `${base}${path}` is always well-formed.
  return { baseUrl: parsed.origin, turnstileToken };
}

/**
 * STEP 1 — `TEST_ROUTES` IS UNSET IN PRODUCTION.
 *
 * The single highest-value assertion here. `GET /__test/last-verify-token`
 * returns the last RAW verification token this Worker issued, which verifies an
 * arbitrary account: if it answers in production, that is a full
 * account-takeover vector.
 *
 * The route is designed to be INDISTINGUISHABLE from a path that does not exist
 * when the flag is unset (it returns the ordinary 404, never a 403 — a 403 would
 * confirm the route is there), so a 404 is exactly what proves the gate holds.
 * Anything else means `TEST_ROUTES` leaked into the deploy.
 */
async function checkTestRoutesDisabled(baseUrl) {
  const url = `${baseUrl}${TEST_TOKEN_PATH}`;
  const response = await get(url);

  if (response.status !== 404) {
    const body = response.body.slice(0, 200);
    fail(
      `${url} answered ${response.status}, expected 404.\n` +
        `      TEST_ROUTES HAS LEAKED INTO PRODUCTION. This route hands out a live\n` +
        `      verification token (= account takeover), and the SAME flag also strips\n` +
        `      Secure from the session cookie. Unset TEST_ROUTES in the Workers\n` +
        `      Builds project vars and redeploy before doing anything else.\n` +
        `      Body: ${body}`,
    );
  }
  pass(`${TEST_TOKEN_PATH} -> 404 (TEST_ROUTES is unset)`);
}

/** STEP 2 — the Worker is up and serving. */
async function checkHealth(baseUrl) {
  const url = `${baseUrl}${HEALTH_PATH}`;
  const response = await get(url);

  if (response.status !== 200) {
    fail(`${url} answered ${response.status}, expected 200 — the api is not serving.`);
  }
  pass(`${HEALTH_PATH} -> 200`);
}

/**
 * STEP 3 — a REAL signup against REAL infra, and the production cookie shape.
 *
 * A 201 here is the load-bearing part, and it proves — on real infrastructure,
 * in one request — every piece that local dev and the vitest pool cannot:
 *
 *   • HYPERDRIVE connectivity + the dup-check/INSERT transaction (real Neon,
 *     real pooling, real TLS — locally both bindings are just a direct socket
 *     to Docker Postgres).
 *   • The argon2id `.wasm` BUNDLING through a real `wrangler deploy`. This is
 *     its first true test: workerd forbids runtime Wasm compilation, so if the
 *     static `.wasm` import did not survive bundling, `hashPassword` throws and
 *     this 500s.
 *   • The KV write (`SESSIONS`) behind `createSession`.
 *   • The DURABLE OBJECT round-trip (`USER_SECURITY.getEpoch()`).
 *   • Turnstile against the real secret.
 *
 * Then the cookie: `Secure` (the session cookie is otherwise HOST-ONLY, with no
 * `Domain` attribute) is the OTHER half of the `TEST_ROUTES` gate
 * (apps/api/src/auth/session.ts), and its failure mode is silent — session
 * tokens riding plaintext http, with every test still green. Step 1 already
 * proves the flag is unset; this proves the consequence directly, which is
 * what actually matters.
 *
 * ⚠️ `getSetCookie()`, not `headers.get("Set-Cookie")`: the latter joins
 * multiple cookies with ", " into one unparseable string.
 */
async function checkSignup(baseUrl, turnstileToken) {
  const url = `${baseUrl}${SIGNUP_PATH}`;
  const email = `smoke-${crypto.randomUUID()}@example.com`;

  const response = await get(url, {
    method: "POST",
    headers: {
      // See the file header: a non-browser client supplies its own Origin, which
      // is what makes the production path reachable from a workers.dev URL.
      Origin: PRODUCTION_ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password: SMOKE_PASSWORD, turnstileToken }),
  });

  if (response.status !== 201) {
    const body = response.body.slice(0, 400);
    const hint =
      response.status === 403
        ? "\n      403 = Turnstile rejected the token, or the Origin allowlist did.\n" +
          "      Turnstile tokens are SINGLE-USE and expire in ~300s — get a fresh one."
        : response.status === 500
          ? "\n      500 = the request reached the Worker and something inside failed.\n" +
            "      Prime suspects, in order: Hyperdrive/Neon connectivity (is the\n" +
            "      connection string the DIRECT host with sslmode=require, not the\n" +
            "      PgBouncer endpoint?), then the argon2id .wasm bundling.\n" +
            "      Check `wrangler tail` for the real error."
          : "";
    fail(`POST ${SIGNUP_PATH} answered ${response.status}, expected 201.${hint}\n      Body: ${body}`);
  }
  pass(`POST ${SIGNUP_PATH} -> 201 (Hyperdrive + argon2id wasm + KV + DO all live)`);

  const cookies = response.headers.getSetCookie();
  const session = cookies.find((c) => c.startsWith("tj_session="));
  if (session === undefined) {
    fail(
      `the signup 201'd but set no tj_session cookie.\n` +
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
    await checkTestRoutesDisabled(baseUrl);
    await checkHealth(baseUrl);
    await checkSignup(baseUrl, turnstileToken);
  } catch (err) {
    if (err instanceof CheckFailure) {
      console.error(`${RED}  FAIL${RESET}  ${err.message}`);
    } else {
      // A network/DNS error, a TLS failure, an unreachable host — report it as a
      // failed smoke check rather than an unhandled rejection stack.
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
