# M3.0 — the reference connector contract

**Status:** SPEC, 2026-11-09. Nothing here is built. It is the contract M3.1 (foundation + generic web unfurl) implements and
M3.3/M3.6 (GitHub, GitLab) plug into. Plan: `docs/superpowers/plans/2026-10-25-m3-reference-engine-plan.md`. Design it makes
concrete: `docs/superpowers/specs/2026-07-13-community-platform-design.md` (Pillar B; decisions 3, 6, 17, 22). It changes none of those.

## 0. Rulings this spec rests on (CireSnave, relayed by the PM, 2026-11-07)

Verbatim: *"The shrink is confirmed.  Store only the image's address for now but we will likely store the image in the future.  Go ahead and restart the Community lane."*

| Q | Answer | Consequence here |
|---|---|---|
| Q1 | Launch minimum is the foundation, generic web unfurl, GitHub, GitLab and the picker, public resources only, live refresh kept. YouTube, X and private resources are **fast-follows**. | Tasks M3.5 (private), M3.7 (YouTube), M3.8 (X) leave the launch hold. The contract still reserves their seams (sections 3.4, 8) so they add code, not a redesign. |
| Q2, Q3 | Moot for launch. | The 30-day YouTube and 24-hour X duties are specified when those connectors are taken up. |
| Q4 | The GitHub App and GitLab OAuth application are CireSnave's to register. Needed before M3.3. | Checklists: `docs/runbooks/register-github-app.md`, `register-gitlab-oauth-app.md`. |
| Q5 | Unfurl images store **only the address** for now, designed so a stored copy can be added later. | Section 4.3: the image is a typed `ImageRef`, never a bare string. |

## 1. Vocabulary

- **Reference**: one resolved external resource (`references` row). **Use**: one post's use of it (`post_references` row, carries the token).
- **Snapshot**: what we captured at post time. It always renders. **Live state**: what the last refresh saw.
- **Connector**: the per-source code behind the interface in section 3. Launch set: `web`, `github`, `gitlab`.

## 2. The token and the render

- Authored form stays what the design reserved: `{{ref:TOKEN}}` inside `posts.markdown_source`. `TOKEN` is the `post_references.token`:
  12 characters of unpadded base32 from a CSPRNG, unique per post, unguessable, **never derived from the URL**.
- Authoring (M3.4) inserts the token; M3.1 ships the *render* and a server function `attachReference(postId, url)` the picker will call.
- `packages/markdown` stays pure and offline. It does not fetch. `render(markdown, { refs })` takes a `refs: Map<token, RefCard | null>`
  prepared by the caller from Postgres/KV and renders:
  - a known token → the card component's HTML (section 6);
  - an unknown or removed token → nothing at all (never the raw `{{ref:…}}` text, never an error);
  - `{{ref:…}}` inside code spans and fenced blocks is **literal text** (so docs can talk about the syntax).
- A render never calls a source API (design, reference engine). It reads the snapshot and the last `live_state` only.

## 3. The interface

```ts
type SourceKind = "web" | "github" | "gitlab"; // later: "youtube" | "x"

interface Connector<K extends SourceKind = SourceKind> {
  readonly kind: K;
  /** Pure, no I/O. Does this URL belong to me, and what is its canonical form? null = not mine. */
  identify(url: URL): Identified | null;
  /** The one resolve at post time: fetch, bound, and return a snapshot. Throws ConnectorError, never returns partial. */
  resolve(id: Identified, ctx: FetchCtx): Promise<Resolved>;
  /** Refresh: conditional where the source allows. Returns what the source says now. */
  fetchLive(ref: StoredReference, ctx: FetchCtx): Promise<LiveResult>;
  /** The human link the card opens (always the canonical public URL; never an API URL). */
  deepLink(ref: StoredReference): string;
}

interface Identified { kind: SourceKind; canonicalUrl: string; resourceKey: string } // resourceKey = stable identity, e.g. "github:o/r#pr:12"
interface Resolved   { resourceKey: string; snapshot: Snapshot; etag?: string; lastModified?: string; contentHash: string; license?: string }
interface LiveResult { access: Access; diff: Diff; snapshot?: Snapshot; etag?: string; lastModified?: string; contentHash?: string }

/** Access and diff are kept apart (design). A change we cannot see is not "gone". */
type Access = "ok" | "not_modified" | "gone" | "forbidden" | "rate_limited" | "error";
type Diff   = "unchanged" | "changed" | "resolved" | "gone" | "unknown";
```

Rules:
- `identify` is first-match over a fixed connector order (`github`, `gitlab`, `web`); `web` is the catch-all for `http(s)`. Two connectors never claim one URL.
- **`access` ≠ `diff`.** `rate_limited`, `error` and `forbidden` give `diff: "unknown"` and leave the stored `live_state` unchanged, retried later (never a hot loop). Only `access: "gone"` (a definitive 404/410) produces `diff: "gone"`. `forbidden` on a resource we saw publicly means it turned private: the card keeps its snapshot, shows "no longer available", and **no new content is stored** (public-only launch, so we never hold private content).
- `resolved` is for a thing that has a done state (an issue closed, a PR merged or closed, a CI check completed). `changed` is any other difference in the rendered fields.
- `contentHash` is SHA-256 over the canonical JSON of the rendered fields (key-sorted, no timestamps); equal hash = `unchanged`. Public resources dedupe by `(kind, resourceKey, contentHash)`.
- A connector must not throw non-`ConnectorError` values; the engine turns any other throw into `access: "error"` and logs it.

### 3.1 `Snapshot` (bounded, typed, per kind)

```ts
type Snapshot =
  | { kind: "web";    title: string; description?: string; siteName?: string; image?: ImageRef; finalUrl: string }
  | { kind: "github" | "gitlab"; type: "issue" | "pr" | "file" | "check"; title: string; state: string; author?: string;
      excerpt?: string /* file lines or body, capped */; lines?: [number, number]; path?: string; ref?: string /* a commit SHA */; capturedAt: string };
```

- Every string field has a hard cap (title 300, description 600, excerpt 4 KB, 40 lines) enforced at capture. Total snapshot JSON ≤ 16 KB; over → truncate fields in a fixed order, never reject the post.
- All text is **untrusted** and escaped at render. Source markdown/HTML is never rendered as HTML; an excerpt is shown as plain text (file excerpts get syntax highlighting through `packages/markdown`'s highlighter, already allow-listed).
- A file reference pins a **commit SHA** at post time, so line numbers cannot drift; "changed" for a file means the branch's content at those lines now differs.

### 3.2 Errors

`ConnectorError { code: "invalid_url" | "blocked_target" | "too_large" | "timeout" | "unsupported" | "not_found" | "upstream", retryable: boolean }`.
`blocked_target` is the SSRF refusal (section 5). The user-facing text for each code is fixed copy; no upstream string is ever echoed to a user.

### 3.3 `FetchCtx`

The only door to the network: `ctx.fetch(url, init)` is the SSRF-guarded fetch of section 5, carrying the byte cap, timeout, redirect limit and the `User-Agent`. A connector may not call global `fetch`. A lint-level test (section 9) fails the build if a connector file references global `fetch`.

### 3.4 Seams reserved for fast-follows (not built)

- `StoredReference.visibility: "public"` only at launch. The column exists with a `CHECK (visibility = 'public')`; M3.5 relaxes it by a migration, with `owner_connection_id` (nullable now, always null) to key private rows per owning connection (design decision 3).
- `SourceKind` is a text column with a `CHECK` list; YouTube/X add values by migration. Their policy duties (30-day refresh-or-delete; 24-hour X deletion) attach to `references.retention_policy` (text, default `'none'`), read by the refresh sweep. Not built now.

## 4. Data (the M3.1 migration; NEW MIGRATION 0042 at time of writing, the PM numbers it)

Additive only (repo rule). Names are the contract; types are indicative.

`references` is a reserved word in Postgres: the migration and every query must double-quote it (`"references"`), or the table takes a different name (the design spec says `references`; a rename is the implementation PR's call and is recorded here if made).

```
references
  id uuid pk (UUIDv7)                kind text CHECK (kind IN ('web','github','gitlab'))
  resource_key text NOT NULL         visibility text NOT NULL DEFAULT 'public' CHECK (visibility = 'public')
  owner_connection_id uuid NULL      content_hash text NOT NULL
  snapshot jsonb NOT NULL            live_state jsonb NULL            -- {access, diff, observedAt, snapshot?}
  etag text NULL  last_modified text NULL
  retention_policy text NOT NULL DEFAULT 'none'
  last_viewed_at timestamptz NULL    next_check_at timestamptz NULL   -- NULL = dormant (M3.2 fills these in)
  created_at / updated_at / gone_at timestamptz
  UNIQUE (kind, resource_key, content_hash)   -- public dedupe; private rows can never match (visibility CHECK)

post_references
  id uuid pk   post_id uuid NOT NULL → posts ON DELETE CASCADE   reference_id uuid NOT NULL → references
  token text NOT NULL   UNIQUE (post_id, token)   position int   created_at
```

- `source_connections` is **not** created in M3.1 (no credentials yet); its envelope-encryption design stays the design spec's, built at M3.5.
- A post's removal or hide hides its cards (they live only inside the post). A reference nobody uses (no `post_references`) is garbage-collected by the existing sweep pattern (M3.2 adds the sweep; M3.1 leaves rows).
- DMCA/moderation: a takedown of a card's subject follows the DMCA flow (R9); M3.10 owns the coverage. M3.1 only guarantees `references.snapshot` can be nulled in place without breaking the render (a `null` snapshot renders the "no longer available" card).

### 4.1 Where `references` rows come from

`attachReference` → `identify` → dedupe lookup by `(kind, resource_key)` → if a fresh row exists (≤ the type's window) reuse it, otherwise `resolve` → insert/upsert → insert `post_references`. All in one transaction around the insert, **not** around the network call.

### 4.2 Limits at attach

Max 10 references per post (a `CHECK` in the write path, copy "a post can show up to 10 references"); per-user attach rate limit through the existing rate limiter (value fixed in the implementation PR, not here); a post that fails to resolve a URL still saves with the URL as an ordinary link (a reference is an enhancement, never a reason to lose a post).

### 4.3 The image seam (Q5)

```ts
type ImageRef =
  | { storage: "remote"; url: string; width?: number; height?: number; alt?: string }   // launch: the address only
  | { storage: "stored"; key: string; width: number; height: number; alt?: string };    // FUTURE: an R2 object, after the upload scan's decisions
```

- Launch writes only `storage: "remote"`. The card renders `remote` images through an **image proxy-free** path: `<img src>` pointing at the remote URL with `referrerpolicy="no-referrer"`, `loading="lazy"`, `decoding="async"`, only for `https:` URLs, and the page's CSP `img-src` must allow it (section 7).
- A later stored copy is a *new connector step* (fetch, run the upload-scan pipeline, write to R2, flip the snapshot's `ImageRef` to `stored`) plus a one-time backfill; the table, the contract and the card do not change. This is why the field is a tagged union now.
- Until a stored copy exists, an `ImageRef.remote` may break when the source moves it; the card must render fully without the image (no layout shift: a fixed aspect-ratio box that collapses on `error`).
- Copyright/CSAM exposure of hotlinked images: we store and serve no bytes, so the upload scan is not involved; the reader's browser fetches from the source. `img-src` is therefore the **privacy** surface to decide in M3.10 (readers' IPs go to third parties); `referrerpolicy="no-referrer"` is the minimum now.

## 5. SSRF controls for the generic web connector (the riskiest part of M3.1)

We fetch attacker-chosen URLs from a Worker. Every request, **including each redirect hop**, passes all of:

1. Scheme `http:` or `https:` only; no credentials in the URL (`user:pass@`); port in `{80, 443, 8080, 8443}` (anything else → `blocked_target`).
2. Hostname is not an IP literal in a blocked range, and not `localhost`, `*.localhost`, `*.local`, `*.internal`, a bare single-label name, or an IPv6 literal at all. Blocked IPv4: `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4`. Decimal/octal/hex IPv4 spellings are normalised **before** the check (`http://2130706433/` is `127.0.0.1`).
3. DNS check: resolve the hostname through DNS-over-HTTPS to a fixed public resolver and refuse if any A/AAAA record is in a blocked range. **Known limit:** a Worker cannot pin the connection to the address it checked, so a DNS-rebinding race remains. Defence in depth: Workers' outbound `fetch` runs on Cloudflare's edge, not inside a private network (**unverified for our account: confirm in the M3.1 PR before relying on it**), and the result of a fetch is never echoed raw (only parsed, capped fields).
4. Redirects: followed manually, at most **3**, each hop re-validated by rules 1–3; a scheme downgrade https→http is refused.
5. Response: `Content-Type` must be `text/html` or `application/xhtml+xml`; body read through a counting stream and **aborted at 512 KB**; total timeout **5 s**; `Accept-Encoding` is whatever the runtime negotiates (a decompression bomb is bounded by the same stream cap, counted post-decompression).
6. Politeness: `User-Agent: ThinkersJournalBot/1.0 (+https://community.thinkersjournal.com/bot)` (the `/bot` page is an M3.1 deliverable, one paragraph); fetch and honour the origin's `robots.txt` for our UA (disallowed → `blocked_target`, card falls back to the plain link); a per-origin rate limit so we cannot be used to hammer a third party (value fixed in implementation).
7. Parsing: take only `<title>`, `og:title`, `og:description`, `og:site_name`, `og:image`, `twitter:image` and `<link rel=canonical>` from the first 512 KB with a tolerant, non-executing parser; **no** script execution, no sub-resource fetches. `og:image` is resolved against the final URL and kept only if `https:` and it passes rules 1–2 (it is *not* fetched).
8. A URL pointing at our own origin or at an `api` route is `unsupported` (no self-referencing unfurl).

Egress alerting on the connector Workers is M3.10.

## 6. The card component

`apps/web` (Astro) renders `RefCard` from `refs[token]`: source icon + site/kind label, title (a link to `deepLink`, `rel="nofollow ugc noopener"`, `target` unchanged), the description or excerpt, the optional image, and a status line (`unchanged` shows nothing; `changed`, `resolved`, `gone` show a short label with "as of <relative time>"). A `null`/gone card shows "This link is no longer available" and keeps the title. **The snapshot is the single source of the text; live state only adds the status label until M3.2 lets a changed snapshot replace it.** Cards are accessible (one link per card, the status as text, not colour alone) and read-only (no scripts, no islands) in M3.1.

## 7. Security and privacy checklist for M3.1

- Public-only: there is no code path that stores content fetched with a credential. (M3.1 has no credentials.)
- All snapshot text escaped at render; no remote HTML is ever injected.
- `img-src` CSP widening for remote unfurl images is an explicit, reviewed line in the PR with the reasoning in section 4.3.
- No secret in the repo; no new Workers secret in M3.1.
- Patent re-sweep trigger (`docs/PATENT-SWEEP.md`: re-sweep when M3 adds a capability family) is M3.10's gate; M3.1 must not wait on it but the PR notes that it adds the capability.
- Vendor names stay out (the five connectors are product integrations, not the hash service).

## 8. What is deliberately not here

Refresh scheduling and the queue/budget DO (M3.2); GitHub/GitLab connectors (M3.3/M3.6); picker and paste-to-enrich (M3.4); private resources and `source_connections` (M3.5, fast-follow); YouTube and X; notifications (M3.9); stored image copies (fast-follow, hook in 4.3).

## 9. Tests M3.1 must carry (red-first, each with a named mutation)

| Area | Test | Mutation that must fail it |
|---|---|---|
| SSRF | every blocked range, the decimal/hex/octal IPv4 spellings, IPv6 literals, `localhost` variants, credentials in URL, odd ports, each rule-2 suffix | delete one range / skip normalisation |
| SSRF | a redirect to a blocked address is refused at the hop; 4th redirect refused; https→http refused | validate only the first URL |
| SSRF | body aborts at the 512 KB cap mid-stream; timeout at 5 s; wrong content-type refused | raise the cap / drop the stream counter |
| Fetch door | no connector file references global `fetch` (a source-scan test) | add a bare `fetch(` to `web` |
| Parse | OG fields extracted; hostile HTML (script, huge attribute, nested tags) yields capped plain-text fields | remove a field cap |
| Render | known token → card; unknown token → nothing; token in code span/fence is literal; escaping of `<script>` in a title | render title unescaped |
| Contract | `access` ≠ `diff`: `rate_limited` leaves `live_state` untouched and `diff: "unknown"`; only 404/410 gives `gone` | map 5xx to `gone` |
| Dedupe | same `(kind, resource_key, content_hash)` shares a `references` row; different hash does not | drop the UNIQUE |
| Image | `remote` renders `referrerpolicy="no-referrer"`, only `https:`; the card renders without the image | allow `javascript:`/`http:` |
| Attach | a failed resolve still saves the post with a plain link; 11th reference refused | let the failure throw |

Database tests use `TEST_DATABASE_URL` only. CI is the first typecheck (fresh worktrees have no `node_modules`).

## 10. Open items (none block M3.1)

1. Confirm that Workers outbound `fetch` cannot reach private addresses for our account (section 5, rule 3) — an M3.1 PR note.
2. Rate-limit values (per-user attach, per-origin fetch): set in the implementation PR from the existing limiter's conventions.
3. `img-src` and reader-IP exposure of hotlinked images: M3.10 decision; the minimum (`no-referrer`) ships in M3.1.
4. The `/bot` page copy: one paragraph, written in M3.1.
