# NCMEC CyberTipline / REPORT Act / Cloudflare CSAM research

Compiled 2026-10-01. Every claim marked VERIFIED was read via WebFetch directly against the cited
primary-source URL (not from model memory); VERIFIED still means "the fetch tool's summary of that
page," not a byte-for-byte quote I re-derived myself — treat exact field names/codes as needing a
final cross-check against the live XSD before coding. UNVERIFIED = secondary source, forum post, or
inference.

## 1. NCMEC CyberTipline "ISP Web Services" reporting API

Source: https://report.cybertip.org/ispws/documentation — **VERIFIED** (fetched directly)

- **Environments**: production base `https://report.cybertip.org/ispws`; test base
  `https://exttest.cybertip.org/ispws`. VERIFIED (both from the doc page and corroborated by search
  snippets).
- **API version**: no explicit version number surfaced by the fetch. UNVERIFIED-gap — need to check
  the actual XSD/doc page by hand once ESP credentials exist; do not assume a version number.
- **Auth**: HTTP Basic Auth, "username and password... requested from and supplied by NCMEC." VERIFIED.
- **Transport**: HTTPS only; endpoints are GET or POST. VERIFIED.
- **Endpoint sequence** (VERIFIED, from the doc page):
  1. `POST /submit` — opens a report with an XML `<report>` document.
  2. `POST /upload` — uploads file(s); optional, repeatable.
  3. `POST /fileinfo` — submits per-file details (`fileDetails`); optional, once per file.
  4. `POST /finish` — completes/closes the submission.
  5. `POST /retract` — cancels a report, but only before `finish`.
  6. `GET /status` — verifies connectivity/auth.
  7. `GET /xsd` — downloads the schema.
- **Schema location**: `https://report.cybertip.org/ispws/xsd` (prod) /
  `https://exttest.cybertip.org/ispws/xsd` (test). VERIFIED.
- **Format**: XML, UTF-8. Root elements seen: `<report>`, `<fileDetails>`, `<reportResponse>`,
  `<reportDoneResponse>`. VERIFIED (named on the doc page) but get the actual XSD before coding field
  order/types — the fetch only reports element *names*, not full schemas.
- **Response/result codes** (VERIFIED, as summarized from the doc page — confirm exact numbers against
  the XSD before relying on them in code):
  - `0` = success
  - `1000` = server error
  - `2000` = authentication required
  - `3100` = no submission authorization
  - `4100` = validation failed
  - `5001` = report doesn't exist
  - `5102` = report already finished
  - A `reportId` field is returned by `submit` and used on subsequent calls (`upload`, `fileinfo`,
    `finish`, `retract`). VERIFIED (referenced as a required field on `fileDetails`).
- **Required fields** (VERIFIED, high-level only — treat as a starting list, not exhaustive):
  - Report: `incidentType`, `incidentDateTime`, `reportingPerson` (with email).
  - File details: `reportId`, `fileId`.
- **Optional fields** (VERIFIED, named on the doc page):
  - Reported person: `espIdentifier`, `screenName`, `profileUrl`, `ipCaptureEvent`, `deviceId`.
  - File: `originalFileName`, `fileViewedByEsp`, `publiclyAvailable`, `originalFileHash`,
    `ipCaptureEvent`.
  - Both `fileViewedByEsp` and `publiclyAvailable` are optional booleans. VERIFIED — this directly
    answers the "wasViewed"/"viewedByEsp" and "publiclyAvailable" question: the field name is
    `fileViewedByEsp`, not `wasViewed`, and it is optional, not required.
- **File upload size limit**: doc page states "There is no limit to the size of uploaded files."
  VERIFIED (as summarized) — still worth confirming for practical/timeout reasons on the Workers side,
  since Cloudflare Workers itself imposes its own request-body limits regardless of what NCMEC accepts.
- **Rate limits**: not specified in the documentation the fetch returned. UNVERIFIED-gap — no evidence
  either way; do not assume none exist.
- **How long a report can stay open before `finish`**: VERIFIED, quoted from the doc page — "If a
  report is not finished by the reporter, the report is automatically deleted by NCMEC 24 hours after
  the date the report was opened or 1 hour after the last modification (file upload or file details
  submission), whichever is later." This matters a lot for the client's state machine: a stalled
  moderator workflow can silently lose the in-progress report.

## 2. Hash-match-without-review / "viewed" semantics / user notification

Source: https://report.cybertip.org/ispws/documentation — VERIFIED (same fetch as above)

- The documentation, as fetched, contains **no mention of filing based on automated hash match without
  human review** — no language authorizing or describing an unreviewed auto-file path. Absence noted,
  not proof of absence across the whole doc set (the fetch summarizes, it doesn't guarantee it saw
  every page/section) — UNVERIFIED-gap on completeness, but VERIFIED that this specific fetch found
  nothing.
- `fileViewedByEsp` is described as an optional boolean with no further semantic explanation surfaced
  by the fetch (e.g., no stated rule like "if false, NCMEC withholds the file from law enforcement
  until reviewed"). UNVERIFIED-gap — the practical/legal effect of setting this flag false needs a
  direct read of the field's description in the XSD/documentation, not just its existence.
- **ESP notification to the user**: the doc page states, per the fetch: "The XML notification of
  receipt of a report made to NCMEC's CyberTipline under 18 U.S.C. § 2258A shall serve as the ESP
  notification." VERIFIED as summarized — read this again directly once credentials exist; this
  sentence is doing a lot of legal work (it appears to say NCMEC's receipt acknowledgment counts as
  "notice" for some purpose, not that the ESP is instructed to notify the reported user — do not
  conflate the two).

## 3. 18 U.S.C. § 2258A (as amended by the REPORT Act, Pub. L. 118-59, 2024)

Primary sources: https://www.law.cornell.edu/uscode/text/18/2258A — VERIFIED (fetched twice);
https://www.govinfo.gov/content/pkg/PLAW-118publ59/html/PLAW-118publ59.htm — VERIFIED (fetched, the
official Public Law text)

- **Subsection structure** (VERIFIED, from Cornell):
  - (a) Duty To Report
  - (b) Contents of Report
  - (c) Forwarding of Report to Law Enforcement
  - (d) Attorney General Responsibilities
  - (e) Failure To Report (penalties)
  - (f) Protection of Privacy
  - (g) Conditions of Disclosure
  - (h) Preservation
- **Duty-to-report trigger / "as soon as reasonably possible"**: VERIFIED, quoted —
  (a)(1)(A): provider "shall, as soon as reasonably possible after obtaining actual knowledge of any
  facts or circumstances described in paragraph (2)(A), take the actions described in subparagraph
  (B)"; (a)(1)(B) requires giving NCMEC contact info and "making a report of such facts or
  circumstances to the CyberTipline."
- **Preservation (h)**: VERIFIED, quoted —
  - (h)(1): "a completed submission by a provider of a report to the CyberTipline under subsection
    (a)(1) shall be treated as a request to preserve the contents provided in the report for 1 year
    after the submission to the CyberTipline."
  - (h)(2): providers must also preserve "any visual depictions, data, or other digital files that
    are reasonably accessible and may provide context or additional information about the reported
    material or person."
  - The REPORT Act (govinfo PLAW-118publ59) amended this by "striking '90 days' and inserting '1
    year'" in § 2258A(h)(1) — VERIFIED, i.e., the 1-year period is a 2024 change from a prior 90-day
    period.
  - **"Commingled content"**: the govinfo fetch found the phrase "including any comingled content
    described in paragraph (2)" in new § 2258A(h)(5) — VERIFIED as present in the Public Law text, but
    the Cornell fetch could not find an explicit *definition* of "commingled content" in current (a)
    through (h) text as summarized. UNVERIFIED-gap — get the literal (h)(5) text (and whatever
    paragraph it cross-references for the definition) before writing preservation logic that decides
    what counts as "commingled."
  - A provider "may voluntarily preserve the contents... for longer than 1 year... for the purpose of
    reducing the proliferation of online child sexual exploitation." VERIFIED (from the Cornell fetch).
  - Preserved materials must be kept "in a secure location" with access "limited... to that access
    necessary to comply with the requirements of this subsection." VERIFIED.
- **Penalties (e)** — VERIFIED, quoted (confirm exact dollar figures against the statute text directly
  before publishing/relying on them, since two different fetches both reported the same numbers, which
  is reassuring but both derive from the same underlying amended text, not independent sources):
  - First violation: **$850,000** for providers with **≥100,000,000** monthly active users; **$600,000**
    for providers with **<100,000,000** monthly active users.
  - Subsequent violation: **$1,000,000** (≥100M MAU) / **$850,000** (<100M MAU).
  - Penalty applies to a provider that "knowingly and willfully fails to make a report required" under
    (a). VERIFIED. Thinker's Journal Community is almost certainly in the **<100,000,000 MAU** tier —
    confirm this isn't itself a determination that needs a formal basis (e.g., self-attestation vs.
    some filing), but no such requirement surfaced in these fetches. UNVERIFIED-gap.
- **(f) Protection of Privacy**: VERIFIED (summarized) — the statute "does not require" providers to
  monitor users/communications or proactively search for violations. Relevant: this confirms the duty
  is reactive (triggered by actual knowledge), not a proactive-scanning mandate — useful context for
  why human-moderator-confirmed filing (rather than auto-filing on hash match) is the correct design,
  though the statute itself doesn't say auto-filing is prohibited; it just doesn't require scanning.

## 4. 18 U.S.C. § 2258B and § 2258C

Source: https://www.law.cornell.edu/uscode/text/18/2258B and .../2258C — VERIFIED (fetched)

- **§ 2258B (liability protection)**:
  - (a) General immunity: civil/criminal claims against a provider arising from CyberTipline
    reporting/preservation duties "may not be brought in any Federal or State court." VERIFIED.
  - (b) Exception: no protection for "intentional misconduct," "actual malice," or "reckless
    disregard to a substantial risk of causing physical injury." VERIFIED.
  - (c) Access minimization: providers must "minimize the number of employees... provided access" to
    reported material and ensure "permanent destruction" when law enforcement requests it. VERIFIED —
    directly actionable: access to retained CSAM reports/evidence should be role-restricted in the
    product, and there needs to be a destruction path triggered by a law-enforcement request.
  - (d) NCMEC vendor protection requires "end-to-end encryption for data storage and transfer
    functions" for NCMEC's contracted vendors — not a requirement on the reporting ESP itself, but
    good practice to mirror. VERIFIED (summarized).
  - (e) Survivor reporting protection — not directly relevant to ESP client design. VERIFIED.
- **§ 2258C (NCMEC sharing hashes with providers)**:
  - (a)(1)-(2): NCMEC may share "hash values or other unique identifiers... Internet location and any
    other elements... that can be used to identify, prevent, curtail, or stop the transmission" of
    CSAM, for the "sole and exclusive purpose" of letting the provider stop ongoing exploitation.
    VERIFIED.
  - (a)(3): critical limit — shared elements "may not include the actual visual depictions." VERIFIED
    — i.e., this is the legal basis for a hash-matching service (e.g., consuming NCMEC/industry hash
    lists) but NCMEC will not hand over actual CSAM images through this channel.
  - (b): a provider using these elements remains "subject to reporting under section 2258A" — i.e.,
    using NCMEC's hash list doesn't substitute for the duty to file a CyberTipline report when a match
    is found. VERIFIED.

## 5. Cloudflare CSAM Scanning Tool

Source: https://developers.cloudflare.com/cache/reference/csam-scanning/ — VERIFIED (fetched directly)

- **Notification method**: "An email is sent to you once per day to inform you of any detections made
  in the past 24 hours," including matched file paths. Requires providing an email address during
  setup. VERIFIED.
- **Blocking behavior**: "If possible, a block is placed to prevent further serving of the matched
  content" — blocking is attempted, not guaranteed; the system notifies you if a block fails and
  content remains unblocked. It does **not** auto-remove/delete content — manual removal is on the
  site owner. VERIFIED.
- **Resolution/review**: to lift a block, an Admin/Super Admin/Trust & Safety role user submits a
  representation via Security Center → "Blocked Content" confirming the content is not CSAM or has
  been removed. VERIFIED.
- **NCMEC credential requirement**: per Cloudflare's 2025-02-04 changelog
  (https://developers.cloudflare.com/changelog/post/2025-02-04-easier-onboarding-for-csam-scanning-tool/,
  found via search, not independently fetched — UNVERIFIED pending direct fetch) the tool "is now
  available worldwide to any Cloudflare user, and no longer requires NCMEC credentials." The main docs
  page fetch corroborates no credential requirement is mentioned on the config page itself. Treat the
  "no credentials needed" claim as VERIFIED only for the docs page itself, UNVERIFIED for the
  changelog post specifically since that one was only seen via search summary, not fetched directly.
- **Scope — cache-only, not origin**: the docs page fetch states scanning applies to "content served
  for your website through the Cloudflare cache" — i.e., it's a cache-layer scan, not a full-origin
  scan. VERIFIED (from the docs page).
- **R2 buckets via custom domain**: the official docs page fetch found **no mention of R2** at all.
  UNVERIFIED-gap on the docs page itself.
  A secondary source — a Cloudflare Community forum thread titled "Does CSAM Scanning Tool cover R2
  objects served via a proxied custom domain?"
  (https://community.cloudflare.com/t/does-csam-scanning-tool-cover-r2-objects-served-via-a-proxied-custom-domain/942172)
  — could not be fetched directly (HTTP 403 on WebFetch). A WebSearch summary citing that thread
  claims: fuzzy hashing happens "as they enter the Cloudflare cache," independent of origin, so it
  *would* cover R2 content served over a custom proxied domain on a first cache-miss fetch; but
  scanning is skipped if `Cache-Control: no-store`/`private` is set, if cache rules bypass cache for
  the route, or if content is served via the Cloudflare-managed `r2.dev` subdomain. **Mark this entire
  R2 claim UNVERIFIED** — it is a forum post relayed through a search summary, not confirmed against
  either Cloudflare's own docs or a direct read of the forum thread. This is exactly the kind of
  claim that needs a direct, successful fetch of that community thread (or an official docs page)
  before the client design assumes R2-served media is covered by Cloudflare's CSAM scanner — if the
  platform serves user-uploaded media from R2 with explicit cache-bypass headers (common for private
  media/signed URLs), Cloudflare's scanner may not see it at all, meaning the moderator-review +
  manual-report pipeline is the only enforcement layer, not a backstop.

## Open items / do-not-assume list

- NCMEC API version number: not found; re-check once ESP credentials and real doc access exist.
- NCMEC API rate limits: not found in the docs page as fetched; absence is not evidence of no limit.
- Exact semantics of `fileViewedByEsp` (legal/procedural effect of true vs. false) beyond "it's an
  optional boolean": not found; needs a direct read of the XSD/field description.
- `commingled content` definition (§ 2258A(h)(5) cross-reference): not resolved to literal text.
- Cloudflare CSAM Scanning Tool + R2 + custom domain + cache-bypass interaction: unverified, sourced
  only through a forum post relayed via search; needs a direct fetch or an official Cloudflare answer.
- Whether NCMEC documentation anywhere authorizes or discusses auto-filing on hash match without human
  review: nothing found in this pass; given § 2258C(b) explicitly keeps the provider "subject to
  reporting under section 2258A" even when using hash lists, hash-match-triggered filing (if ever
  implemented) would still need to satisfy whatever "actual knowledge" means under (a) — worth a legal
  read, not an engineering assumption.
