# License

Copyright (c) 2026 Thinker's Journal

> **The holder is the organization, deliberately — not an oversight.** The founder's
> reason, in his words: *"The copyright is under Thinker's Journal because the non-profit
> organization should be the one owning its own items so that if I ever step down, sell
> it, etc. everything transfers to whoever takes it over."*
>
> ⚠️ **Do not "correct" this to a personal name.** An organization-held copyright survives
> a change of founder; a personal one does not. The transfer property is the point.

This repository is the **community platform** — a component of
[ThinkersJournal.com](https://thinkersjournal.com), and its licensing deliberately mirrors
that repository's. Three different kinds of material sit here under three different terms.

⚠️ Where code and prose share a file — page copy written inside an `.astro` component, for
example — **the split is by subject matter, not by file path**. You may reuse the markup,
styles and logic; you may not lift the sentences.

## 1. Code — MIT OR Apache-2.0

Dual-licensed under **either** of:

- **Apache License, Version 2.0** — see [LICENSE-APACHE](LICENSE-APACHE)
  ([apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0))
- **MIT License** — see [LICENSE-MIT](LICENSE-MIT)
  ([opensource.org/licenses/MIT](https://opensource.org/licenses/MIT))

at your option. SPDX: `MIT OR Apache-2.0`.

Covers the work in both Workers (`apps/api`, `apps/web`) — routes, components, layouts,
styles, client scripts, Durable Objects, database migrations, build tooling and tests —
together with the repository's engineering documentation under `docs/` — **except
`docs/legal/`, which Section 2 routes to Section 3 and which this grant does not reach.**

⚠️ **Except the generated Workers type definitions, which are not ours to license.**
`apps/api/src/worker-configuration.d.ts` and `apps/web/worker-configuration.d.ts` are emitted
by `wrangler types` and carry **Copyright (c) Cloudflare** and **Copyright (c) Microsoft
Corporation**, licensed **Apache-2.0 only**. They are checked in so the build reproduces
without a `wrangler` run; they remain under their own terms, and the dual grant above does
**not** reach them. Relicensing them under MIT would be asserting a grant nobody here holds.

## 2. User Content — not ours to license, and not covered by this file

⚠️ **The posts, comments, reactions and uploaded media that people publish on the running
service are NOT licensed by this file, because they are not ours to license.** Authors keep
ownership of what they write and upload. The platform holds only the operating licence they
grant when they accept the [Terms of Service](docs/legal/terms-of-service.md) — a licence to
host, store, reproduce and display that content **for the purpose of operating the Service**,
which ends when they delete the content or their account (see ToS §3).

Nothing in the MIT or Apache grant above reaches User Content. **Running this code gives you
no rights whatsoever in anybody's posts**, and the presence of an open-source licence on the
software must not be read as one — this is the single most likely misreading of a file named
`LICENSE` in a repository whose product is other people's writing, which is why it is stated
here rather than left to inference.

The legal policy drafts under `docs/legal/` are governance documents for this service, not
templates offered for reuse; they are Section 3 material. ⚠️ **Section 1's `docs/` grant
excludes them, and says so — if either sentence is ever edited, edit both.** A licence that
grants and reserves the same path leaves a reader no way to tell which clause governs, and
ambiguity is the entire cost of this document.

## 3. Site copy and brand — all rights reserved

The marketing and policy prose (wherever it appears, including inside `.astro` files),
together with the **"Thinker's Journal" name, wordmark, logo, favicon and social card**, are
**not licensed** and remain the property of Thinker's Journal.

Neither the MIT nor the Apache license grants trademark rights — Apache-2.0 §6 withholds
them explicitly and MIT grants none — and nothing in this file should be read as permission
to use the name or the marks.

## Contributions

Unless you explicitly state otherwise:

- **Code** you contribute is licensed under `MIT OR Apache-2.0` — matching its outbound terms.
- **Site copy and brand material** you contribute has *no* outbound terms to match, because
  the project publishes it all rights reserved. You instead grant Thinker's Journal a
  perpetual, worldwide, non-exclusive, irrevocable, royalty-free licence to use, reproduce,
  modify, publish and distribute that contribution under whatever terms the project chooses.
  You keep your own copyright in it.

⚠️ Section 3 material is **outbound** unlicensed, not **inbound** unlicensed. Without the
grant above, the project would have no right to publish prose that somebody contributed to
it — the reserved-rights notice would lock out the project itself.

⚠️ **Posting on the service is not "contributing" in this sense.** A user's post is User
Content under Section 2 and is governed by the Terms of Service, never by this file.
