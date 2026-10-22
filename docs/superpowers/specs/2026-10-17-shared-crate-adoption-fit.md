# Adopting the shared crates in Community: what each would need to offer a TypeScript consumer

Status: NOTE for the PM (docs only, no code). Written 2026-10-17 against Community `origin/main` 2f4c263 (0.1.53).
Source: board 196, ruled 2026-10-17 (EXPECTATIONS 6.14), CireSnave, verbatim:

> "All of our projects should adopt auth-framework for authentication. All of our projects should adopt PersistAnt for persistence. All of our projects that accept image submission from users should adopt SafeImage."

Facts about the other projects were read with `git show origin/main:<path>` after a fetch of each, on 2026-10-17:
SafeImage (`docs/NPM-PACKAGE.md`, `ROADMAP.md`, `wasm/npm/index.d.ts`), auth-framework (`README.md`,
`FEATURE_FLAGS.md`, `sdks/javascript/README.md`), PersistAnt (`README.md`, `ROADMAP.md`, `docs/DESIGN-KINDS.md`).
Anything I did not establish is under "Not verified". `origin/main` of each moves; these are statements about that
day, not about the present.

## Update 2026-10-22 (board 228 ruled A)

CireSnave, verbatim: *"On decision 228: A for now but we will be transitioning all projects to our own tool stack over time.  For web-based (non-Rust) projects, that will likely require hosted services we will run."* So: **now** SafeImage via its WASM/npm package; **later** auth-framework as a separate hosted service (spike after the migrations settle), then persistence and other services; PersistAnt does not apply to Community yet. Hosting services we run is therefore expected, which softens the "we have no server" gap in section 2 but does not remove it.

Facts re-read 2026-10-22 (SafeImage `origin/main` a8e1734, 0.3.24; npm registry; CI run 39014029155):

- `@thinkersjournal/safeimage` is **not published** (`npm view`: 404). The unscoped `safeimage` on npm is an unrelated 2016 React package. Blockers (SafeImage lane, PM): the publish flip (SafeImage #15, draft) waits on F4 (board 222); the npm organisation and trusted publishing (OIDC, no stored token) are on CireSnave's board 247; no publish job is built yet; the crates.io release is the PM's (Q8).
- The typed TypeScript wrapper is **not** in the package: `index.js` exports `ABI_VERSION`, `wasmUrl` and `instantiate()` returning the raw `si_*` exports. PM ruled A: SafeImage builds the wrapper into the package. Community writes no private copy.
- The packed tarball from that run (`thinkersjournal-safeimage-0.3.24.tgz`, a CI artifact): `safeimage_wasm.wasm` is 27,158 bytes (26,943 gzipped), ABI 4, built with rustc 1.99.0; `PROVENANCE.json` names the commit and run. I did not instantiate it under workerd, so cold start and isolate memory remain unmeasured.
- Community can do nothing that merges before a published version exists: a vendored `.wasm` is ruled out (board 174 Q10), and steps 3 to 5 of `2026-10-10-safeimage-split.md` section 5 depend on the package. A prepared branch is not started.

## 0. The constraint that shapes all three answers

Community is **not a Node service**. Both Workers run on Cloudflare workerd (`compatibility_flags: ["nodejs_compat"]`,
`apps/api/wrangler.jsonc`). Persistence is Postgres through Hyperdrive with the `pg` client
(`apps/api/src/db/client.ts`), KV (sessions, caches), R2 (media) and Durable Objects. There is no process we host
ourselves. A Rust crate can reach this runtime in only three ways: compiled to WebAssembly and loaded in the Worker;
run as a separate network service that the Worker calls with `fetch`; or not at all. The three crates sit at
different points on that scale.

## 1. SafeImage: fits; the road is already laid, and the blocker is publishing

- **What exists.** Layers 1 to 4 (hashing, matching, evidence, reports) are exposed as a WASM module, ABI version 4,
  `si_*` exports with `si_alloc`/`si_free` (`wasm/npm/index.d.ts`). An npm package `@thinkersjournal/safeimage` is
  built by the `npm-package` CI job (0.3.20): the `.wasm` byte for byte, a loader, `index.d.ts`, `PROVENANCE.json`.
  Layer 5 stays Rust-only. Ruled: board 174 Q10.
- **Gaps for us.**
  1. Nothing is published. `docs/NPM-PACKAGE.md`: no npm organisation or token yet, the crates.io release is not out
     (`publish = false`, PR #15 draft), and F4 (naming the provider in public text) is open. Until then Community
     cannot depend on a published version, so its adoption steps 3 to 5 (`2026-10-10-safeimage-split.md` section 5)
     cannot merge. Steps 0 to 2 are unaffected.
  2. The package ships the raw ABI and "no logic beyond instantiating the module". Every call is numbers into linear
     memory, so someone has to write the typed TypeScript wrapper (encode request, allocate, call, decode, free).
     Option: it lives in the package (best: one place, versioned with the ABI) or in Community (faster, but each
     future consumer repeats it).
  3. Provider and destination specifics are deploy-time operator configuration (Q9) and are not in the package.
     Community must supply them from Worker secrets; the configuration format is not yet documented to a consumer.
  4. The Workers fit is claimed ("Q7 passed 2026-10-10", WASM load proof) but I did not re-run it. Workers limit
     module size and startup time; the `.wasm` size against the Worker size limit is a number to take at adoption.
- **Recommendation.** Adopt, in SafeImage's order (PDQ first, then layers 2, 4, 3). Ask SafeImage to put the typed
  wrapper in the package. The blocker is publishing (PM), not engineering.

## 2. auth-framework: a Rust server; reachable only as a service, and the largest change of the three

- **What it offers.** An Axum REST server (default features `enhanced-rbac` + `api-server`, `postgres-storage`),
  OAuth 2.x / OIDC, JWT, MFA (TOTP), passkeys, SAML, device flow; a Docker image; an OpenAPI description; and a
  TypeScript client `sdks/javascript` (`@authframework/js-sdk`, `AuthFrameworkClient` with `auth`, `users`, `mfa`,
  `oauth`, `admin` modules). It is a release candidate (0.6.0-rc*), and says so.
- **What it cannot be here.** Not a WASM module: it is built on tokio, sqlx and axum, and the feature flags document
  names no WASM feature. So the only route is a **separate service** that our Worker calls over HTTP.
- **Gaps.**
  1. *Hosting.* We have no server. A service needs a host we operate (the D7 media processor already assumes a VPS,
     so this may be one box doing two jobs; a decision for CireSnave, with a cost).
  2. *Latency and failure mode.* Every login, and unless sessions stay Worker-side every authenticated request, gains
     a network hop to a single region and a new total-outage dependency. Community's sessions today are opaque
     tokens in KV (`apps/api/src/auth/session.ts`), checked at the edge with no origin call.
  3. *Account lifecycle is Community's own and sits around the user row.* Anonymisation, legal holds, barred
     re-entry, reserved names and addresses, Turnstile and per-IP limiters, email verification and password reset all
     key on our `users` table. Splitting identity into another service splits that table; each of those features
     would have to be re-expressed across the boundary. Not verified: whether auth-framework's user model can
     reference an external user id without owning the row.
  4. *Credentials migration.* Passwords are argon2id (WASM in the Worker). auth-framework lists argon2 and bcrypt, so
     hashes may be importable, but parameters and encoding were not compared.
  5. The SDK's own publication and workerd compatibility (npm status, any Node-only API) were not checked.
- **Options.**
  - **A. Adopt as a service, staged.** Spike first: a Worker logs a test user in against a locally run server and a
    session is minted; measure the hop; import one argon2id hash. Then move one capability Community lacks and wants
    (MFA/TOTP or passkeys), keeping sessions and the account lifecycle Worker-side. Largest benefit for the least
    migration.
  - **B. Full replacement** of `apps/api/src/auth`. Highest risk: it touches the lifecycle in gap 3 and the
    launch-gating moderation features. Not before A has shown the seam holds.
  - **C. Wait** for a WASM/edge story from auth-framework. Cheap, but the 6.14 ruling is then not met.
- **Recommendation.** A, after the migrations in flight (#204, #205, #207) are applied, with a one-week spike limited
  to the checks above. B is rejected as a first step.

## 3. PersistAnt: scoped by CireSnave to Rust projects, and Community's persistence is SQL inside the Worker

- **What it offers.** A persistence layer over OpenDAL with declared capabilities, typed records with schema
  versions, and kinds (kv, blob, relational; `persistant-sqlx`, `persistant-relational`), with ranked backends. 0.7.3.
- **The earlier ruling that applies.** PersistAnt `docs/DESIGN-KINDS.md` section 0 (CireSnave, relayed by the PM,
  2026-10-11): *"At this point, I meant Rust projects. I do plan on writing cross-language support for almost all of
  our projects ... but for now that is on the eventual roadmap but not until our tools we're building actually
  work."* The 2026-10-17 ruling says "all of our projects". Whether it **widens** that scope to Community is the one
  thing to confirm with CireSnave; it is not mine to read either way.
- **Gaps if it does.**
  1. *Runtime.* The Rust crates (OpenDAL, sqlx) cannot open a Postgres connection from workerd; Community's
     connection is Hyperdrive through `pg`. I found no WASM, npm or HTTP surface for PersistAnt in its README or
     ROADMAP.
  2. *Transactions.* Core paths run several statements in one transaction (a moderation decision plus the notice
     outbox enqueue in #205; account anonymisation plus the media owner clear in #207). A remote record/KV API does
     not give a caller an open multi-statement transaction. The relational kind has `begin` with an isolation level
     (0.7.0); whether it can be served over a network to a Worker was not checked.
  3. *Migrations.* Ours are node-pg-migrate SQL files applied by a script. PersistAnt's migrations are "still to come"
     (README status).
  4. *Non-SQL stores.* KV, R2 and Durable Objects are Cloudflare bindings, not OpenDAL services we run. R2 through
     OpenDAL from workerd was not checked.
- **Options.**
  - **A. Adopt where the code is Rust**, i.e. any non-Worker component we add (for example the D7 media processor, if
    written in Rust). Nothing to change in the Worker.
  - **B. Wait for cross-language PersistAnt** (the roadmap CireSnave described) and then adopt at the repository seam
    (`apps/api/src/db/client.ts`), not per query.
  - **C. Run PersistAnt as a service in front of Postgres for Community.** Buys the rule, loses Hyperdrive and
    in-Worker transactions, and adds the same hosting and latency cost as auth. Rejected.
- **Recommendation.** B for the Worker, A for any Rust component, and ask PersistAnt what its cross-language route is
  (WASM for the blob/kv kinds, or a published TS client) so that "eventual" has an owner and a first row.

## 4. Order

1. SafeImage, now (board 228 A). Engineering waits on the typed wrapper (SafeImage) and publishing (F4, npm org with OIDC, crates.io release).
2. Later: auth-framework as a separate hosted service we run (spike A), only after the #204/#205/#207 migrations are applied, so identity work does not collide
   with them.
3. Then persistence and other services. PersistAnt: no Community work until a TypeScript route exists or CireSnave widens the scope in writing.

## 5. Not verified (each would change an answer above)

- Whether `@authframework/js-sdk` is published and runs on workerd.
- Whether auth-framework can reference an external user row; argon2id parameter compatibility.
- The cold-start cost and isolate memory of `safeimage_wasm.wasm` under workerd (its size, 27 KB, is measured; the Worker size limit was not re-fetched).
- Whether PersistAnt's relational kind can serve a transaction to a remote caller, and whether it runs on workerd.
