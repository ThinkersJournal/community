# Separating image scanning into the SafeImage crate: Community's side (STEP 1)

**Status:** PROPOSAL for the PM's gate. Docs only; no code moves in this PR. Written 2026-10-10 by the Community lane
against `origin/main` `e5916a6` and SafeImage `docs/DESIGN.md` at PR #1, head `3103242` (private repo
`ThinkersJournal/SafeImage`).

**Ruling this serves (CireSnave, 2026-10-10, verbatim as relayed by the PM):** *"Have Community and the new SafeImage
agent work together to separate out image scanning into the new crate."*

**Counterpart:** SafeImage `docs/DESIGN.md` (the crate boundary: layers 1-5, invariants I1-I9, §5 runtime, §6 order).
This document answers it from the consumer's side and does not repeat it.

**Vendor naming:** the hash-matching service is "HMS-A" / `HMS_A_*` in Community documents, and "PhotoDNA scan step" for
the second layer (upload-scan §7). SafeImage's neutral word is "hash-match provider" / `provider`; they are the same
thing, and neither repository names the vendor.

---

## 1. Fact that shapes everything: nothing is built

At `e5916a6` no scanning, matching, evidence or report code exists on `main`. The upload-scan design (rev 3 + rev-4
amendments), the D7 decoder-service design, and the CSAM/NCMEC spec and plan are documents. `main` carries only the
schema for original-upload hashes (US4, PR #161, held). So "moving" a module means **moving a design**, nothing in
production can regress, and the choice is cheap now and expensive after US1-US3 ship. Community's US1 (TypeScript PDQ
port) and US3 (provider client + mock) are therefore **not started** and stay unstarted until this settles.

## 2. (a) What moves into the crate

Mapped to SafeImage's layers, with the Community design each one replaces:

| SafeImage layer | Community design it replaces | Notes from the Community side |
|---|---|---|
| 1 hash | upload-scan §3 and US1 (TS PDQ port) | The frame rule is native size when both sides are ≤ 512, else exactly 512x512, never upscaled, no `-auto-orient` (D7 PM rulings, vps design §2.3 a/b). `normalise_geometry(w, h)` replaces Community's `hasExpectedGeometry` (the fixed 786,432-byte check is withdrawn). Quality ≤ 49 is "unscannable" (§3.2). |
| 2 matcher | upload-scan §5.4, §6.1, §9.3 and US3 | `MatchRequest` carries 1..=8 hashes: Community sends all eight dihedral variants in one call (§3.5). Whether the provider also matches rotations itself is still the US3 implementer check; the 1..=8 shape is right either way. |
| 3 evidence (pure half) | upload-scan §5.7; CSAM spec §3.3-3.6, §5, §7 | See §6 below for the exact transitions and the operations that need two distinct people. LAST in order. |
| 4 report | CSAM plan Tasks 4, 5 and the state-machine half of 7 | Request XML is built with an escaper and never parsed; the response is byte-capped, entities off, pinned parser. |
| 5 classifier seam | CSAM spec §3.1 `classifier` kind | A type boundary only; nothing today. |

**Plan-task mapping (`2026-10-01-csam-ncmec-pipeline.md`):**

| Task | Goes to |
|---|---|
| 1 media-key helper, 2 `applyAccountActionInTx`, 2a, 3 schema | stays (host) |
| 4 XML layer + pinned parser | crate layer 4 |
| 5 NCMEC client | crate layer 4 (build/parse/step function); the `fetch` stays in Community |
| 6 intake | pure decisions to layer 3; the transaction (hide content, hold account, insert case) stays |
| 7 drain | `next_step`/`apply` to layer 4; the cron, the guarded `UPDATE` and the I/O stay |
| 8 alarms | stays (host); the crate supplies the `Unavailable` reasons |
| 9, 9b, 10 admin routes, destruction, UI | stay (host); layer 3 supplies the rules |
| 11 runbook + exttest | stays (host) |
| 12 original-upload hashes (#161) | stays (schema). MD5/SHA-1 may come from layer 1's `legacy-digests` |
| 13 secure evidence storage (NIST CSF) | stays (host); layer 3 only enforces the two-person `destroy` |

## 3. (b) The interface Community will call

**Agreed with SafeImage §3.2-3.4:** a sans-I/O core. Community uses only the pure functions:

- `pdq_dihedral(frame) -> [Pdq; 8]`, `Hash256`, `hamming`, `normalise_geometry`.
- `ProviderProtocol::request()` / `interpret()`: the Worker's own `fetch` sits between them, with its own secrets.
- `strongest(outcomes)`, `RetryPolicy::decide`.
- Layer 3 transition functions, `preserve_until`, `report_may_submit`, `report_file_disposition`.
- Layer 4 `build_report_xml`, `parse_response`, `next_step`/`apply`.

**Delivery: option B (a WASM build of the pure functions)**, which is SafeImage's lean as well. Reasons from Community's
side:

1. Option A puts the provider credential on the decoder host. The hash-service terms allow one credential set, held
   only in one deployment's secrets. Today that is Worker secrets (`HMS_A_*`); a second home for it is a new exposure
   and a new rotation step. Community keeps the credential in the Worker and A is rejected for layer 2.
2. The decoder service is stateless by CireSnave's D7 ruling (nothing stored on its drive). Hashing there would be
   possible, but the Worker would then trust a hash from a service that also holds the bytes; computing the hash in
   the Worker from the signed frame keeps one verifiable step. (A remains available for layer 1 only, if the PM wants
   the hash computed beside the decoder: the contract is the same function.)
3. Option C (a TS port plus the crate as reference) is the drift the split exists to remove.

**Q6 (sans-I/O only, or with an `async` driver):** Community needs no async driver. Recommend it does not exist in
0.1.x; if Lightbulb or Fuel need it, it is added then.

**Q2:** answered in §2 above; it stays open as the US3 check and does not change `MatchRequest`.

**What Community needs from the WASM artifact (for Q7):**

- A `.wasm` plus glue that instantiates from an **imported module** (workerd does not compile WASM from bytes at
  runtime), exposing a synchronous init. No `fetch`, no `new URL(import.meta.url)`, no `node:` imports.
- Pure functions only; byte-slice in, byte-slice or JSON out; no panics across the boundary (a `Result` the glue
  turns into a thrown typed error).
- Built from a pinned toolchain; the artifact's version equals the crate's.

**Community's proof for Q7**, run once SafeImage has a pdq-only `.wasm`: (1) a vitest-pool-workers test that imports it
inside workerd and checks the reference vectors; (2) the existing `check:workerd` gate over the built web and api
bundles (no `node:` import, no runtime WASM compile); (3) the isolate memory and CPU of one `pdq_dihedral` at 512x512
under `wrangler dev`. A pass answers Q1 with B.

## 4. (c) What stays in Community

Workers/R2/Postgres bindings and every migration (0027 is #161); the D7 `MediaProcessor` / VPS HTTP contract and its
HMAC; scheduling (`*/2`, daily evidence check, drain); the intake transaction that also hides content and holds
accounts; the admin routes and UI and the authentication of the two people; account legal holds and anonymisation;
quota, sniff and the upload route; alarms U1-U11 and their delivery; rollout flags; secrets and reporter identity;
exttest-vs-production selection; privacy-policy and legal wording (drafts stay in the upload-scan design §10.3).

## 5. (d) Migration order, so Community never regresses

Nothing ships from Community until the crate step it needs exists and has passed Community's own tests.

| Step | SafeImage | Community | Gate |
|---|---|---|---|
| 0 | docs/DESIGN.md merged | this document merged | PM |
| 1 | types and traits of layers 1-2, behaviour-free, with invariant tests | none | PM |
| 2 | PDQ in layer 1, generated-image vectors, provenance and `NOTICE` | WASM load proof (§3). US1 is **replaced by this step**; the §9.2 test vectors become the cross-check | PM |
| 3 | layer 2: `MockMatcher`, `strongest`, provider protocol, `RetryPolicy` | US3 becomes a thin adapter plus the Worker's `fetch`, behind the existing §9.3/9.4 tests | PM |
| 4 | layer 4 pure half | plan Tasks 4-5 become adapters; exttest run | PM |
| 5 | layer 3 pure half, LAST | intake/confirm/clear adopt the transition functions | PM |

Rule for every adoption PR: Community's pre-existing contract tests pass unchanged; a test is never edited to follow the
crate in the same PR that adopts it. The hash self-test identity (upload-scan §3.6, vps design §2.5) gains the crate
version, because a crate upgrade can change hashes without a Worker deploy.

## 6. Where Community's designs differ from SafeImage's draft (to resolve in SafeImage's PR)

1. **Evidence transitions (layer 3).** The authoritative table is upload-scan §5.7: `pending→present`,
   `pending→failed` (inline retries exhausted, or the `*/2` tick after 10 minutes), `present→missing` (daily check),
   `failed|missing→present` (a later upload of the same bytes), `failed|missing→file_without_evidence` (**two different
   admins**), `file_without_evidence→present`. Destruction changes **no** state. The case state is *derived* from its
   files (failed/missing > pending > present). The draft's five state names match; the transitions and the derivation
   need to be copied from §5.7, not re-derived.
2. **Two-person operations.** Beyond CLEAR of a known-hash case, the same two-distinct-admins rule applies to CLEAR of
   a `removal_request` case (CSAM spec §7.2, AC-C22), the `file_without_evidence` decision (§5.7), setting and lifting
   an evidence legal hold (CSAM spec §5.3), and destruction (§5, P7). The crate's I9 should list them as one set.
3. **Kind assignment is the host's.** Whether a *near* match is `known_hash` or `classifier` is decision Q3, and the
   provider's harmful-or-abusive category maps to `kind = 'classifier'` by D5. The crate should expose
   `Exact | Near` and the classification and leave the kind to a host function, not bake either default in.
4. **`interpret` taxonomy.** upload-scan §5.4 requires "no known match" with match type exact or near, and any
   malformed body, to be `Unavailable(MalformedResponse)`, and the provider's test value to be
   `Unavailable(TestValueInProduction)`. Both are mapped in the draft; the first is easy to omit and should have a
   test.
5. **Report timing.** The CSAM spec's two switches (R1, §3.4) are separate: report-at-match and the timing of the
   filing. `ReportAtMatch` as a host parameter matches; the second switch is the host's schedule.
6. **Preservation clock** (`preserve_until`): one year from the latest of match, **every** send and every finish, per
   the PM's "every send counts" (§5.1). The draft says the same; keep the property test on "no event moves it earlier".

## 7. Open items

| # | Item | Owner |
|---|---|---|
| Q1 | B vs A for layer 1 | PM, after the §3 proof |
| Q7 | The workerd proof (§3) | Community, when a pdq `.wasm` exists |
| **Q8** | **How Community consumes the crate.** The crate is `publish = false` and the repo private, and Community's repo and CI are public. CireSnave's standing rule is that cross-repo dependencies are published versions (no path, no new `git =` dependency). A TypeScript consumer needs a published npm package built from the crate, and CI needs to install it. Which registry, public or private, and when, is open. **Until it is answered no adoption PR (§5 steps 3-5) can merge**; steps 0-2 are unaffected. | PM, CireSnave |
| Q3, Q4 | near-match kind; the licence mix for derived files | CireSnave / PM (as in SafeImage §10) |

## 8. Stop rules held in this document

No credential, hash list, real-service call or real image appears in either repository. Vendor names are absent from
this file (checked against SafeImage's `.github/forbidden-patterns.txt`).
