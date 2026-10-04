# Scanning every new image for CSAM ourselves: options and recommendation

**Status:** Options document and recommendation for PM/founder review. It contains no code. Part of #114.
**Author:** Community research agent, 2026-10-04. Repo facts were read at `origin/main` 9a76b6f.
**Research rule:** each external claim cites a URL in §9, all read on 2026-10-04. **VERIFIED** means I read
it on the vendor's or NCMEC's own page or API document. That's a fetch-tool summary, not a byte-for-byte
quote, so recheck exact wording before relying on it legally. **UNVERIFIED** means a secondary source, a
search summary or my inference.

---

## 0. The requirement

CireSnave, verbatim (relayed by the PM on 2026-10-04): *"we should periodically run our own scans of all new
images. Relying on Cloudflare is a good first line of defense but since children's safety is at risk and thus
our legal standing is at risk, we must check all images ourselves."*

CireSnave on legal advice, verbatim: *"There is no attorney nor can I afford one so proceed with best safe
guesses."* Every legal statement below is a best safe guess, not legal advice.

## 1. Facts about our media that shape the choice

Read at 9a76b6f:

- **We store only a re-encoded WebP, never the original.** `apps/api/src/routes/media.ts` transforms each
  upload to WebP through the Images binding, capped at a 2048px edge with EXIF stripped (step 7). Only that
  output reaches R2. `media.sha256` is the hash of the **transformed** bytes, according to the
  `0002_posts_and_media.sql` comment *"Of the stored WebP, not the discarded original."*
  - **Consequence:** an exact cryptographic hash list (MD5/SHA-1 of the original file) **can never match
    anything we store.** Two things still work:
    - perceptual hashes (PDQ, PhotoDNA), which survive resizing and re-encoding;
    - an MD5/SHA-1 of the **original** bytes, but only if it is captured at upload time, because the original
      is discarded. Workers' `crypto.subtle.digest` supports MD5 and SHA-1 (VERIFIED, Cloudflare Web Crypto
      docs).
  - Existing media can never get an original-bytes hash.
- **Objects are content-addressed** (`media/post/<sha256>.webp`) and shared between uploaders. Several
  `media` rows can point at one `r2_key`. Scanning is therefore **per object**, and a match affects every
  uploader, consistent with R3 in the pipeline spec.
- **Two buckets.**
  - `MEDIA` (`tj-media`) is public through the CDN custom domain, served
    `cache-control: public, max-age=31536000, immutable`.
  - `MEDIA_RESTRICTED` (`tj-media-restricted`) is private, with no custom domain, and is streamed only by
    `media-restricted.ts`.
  - Objects move between the two buckets through the `media_moves` queue.
- **What Cloudflare's tool can't see, whatever its R2 status.** It scans "content served for your website
  through the Cloudflare cache" (VERIFIED, docs). So it never sees:
  - anything in `MEDIA_RESTRICTED`, such as author-hidden or held content;
  - an object that has never been fetched publicly, such as an orphan upload or an image in a post nobody has
    opened yet.

  These gaps exist even if R2 coverage is confirmed. **This is the concrete reason a self-scan is needed, not
  just a second opinion.**

## 2. Candidates

### 2.1 Shield by Project Arachnid (Canadian Centre for Child Protection, C3P)

- **Detects:** known images only, by hash. There's no classifier. Its classifications are `csam`,
  `harmful-abusive-material` and `no-known-match`, with a match type of `exact` or `near`, and near-match
  details carrying SHA-1/SHA-256 (VERIFIED, the live OpenAPI document `shield.projectarachnid.com/openapi.json`,
  v1.1.0).
- **Access:** an HTTP API with username/password auth, which suits a Worker's `fetch`. Endpoints:
  - `POST /v1/media` sends the image bytes;
  - `POST /v1/url` sends a URL on a domain authorised on our account;
  - **`POST /v1/pdq` takes "an array of one or more base64-encoded PDQ hashes"**, which is the hash-only
    option;
  - `GET /v1/version` returns the database's "last_updated_at", which supports the re-scan policy;
  - `POST /v1/media/submit` uploads suspected media for C3P analysts. We would not use it.
  Official SDKs exist in TypeScript and PHP.
- **Eligibility:** "No cost to using this tool" for electronic service providers and content administrators.
  You sign up at `projectarachnid.ca/en/api/accounts/register/` (VERIFIED, projectarachnid.ca home page).
  - Access is granted after review to prevent abuse. This is UNVERIFIED: it comes from a SDK/forum summary.
  - The website terms of use say nothing about the API. **The API's own terms, its rate limits, and whether
    `/v1/media` uploads are retained are all UNVERIFIED.** The schema implies only `/media/submit` retains
    media, but that's inference.
- **Cost:** $0.
- **Where it runs:** a cron Worker. We compute PDQ in the Worker (§3.2) and send only hashes.
- **What leaves us:** **only PDQ hashes** on the primary path. On the fallback (§3.3), image bytes go to C3P,
  a child-protection NGO.

### 2.2 NCMEC hash sharing

- **Detects:** known images only. NCMEC runs four initiatives: NGO CSAM, Exploitative, Industry, and
  Youth-Produced Imagery. NCMEC analysts review a file "at least three times" before its hash goes on a
  list. "As of December 31, 2025, NCMEC shared more than 12.1 million hashes with 78 ESPs" (VERIFIED,
  missingkids.org CyberTipline data).
- **Access:** a hash list we download and sync, then match ourselves. Through the Hash Sharing API:
  - Basic auth; "a username and password must be requested from and supplied by NCMEC";
  - incremental `from`/`to` queries with paging;
  - fingerprint types **MD5, SHA1, PDNA (PhotoDNA), PDQ, NetClean**, plus video types
    (VERIFIED, `hashsharing.ncmec.org/npo/v2/documentation/`).
  - ⚠️ **What share of the CSAM list carries PDQ, as opposed to only MD5/PhotoDNA, is UNVERIFIED.** The API
    supports PDQ as a type, but I found no population figure. One secondary page lists only MD5/SHA1/PhotoDNA.
- **Eligibility:** ESPs and industry partners, free. Credentials come from NCMEC. **The ESP CyberTipline
  registration CireSnave already holds is not the same credential.** Hash-sharing access must be requested
  separately (VERIFIED, API docs). Whether CyberTipline registration is a prerequisite is UNVERIFIED.
- **Legal basis:** §2258C(a) lets NCMEC share hashes with providers, and (b) leaves a provider that uses them
  "subject to reporting under section 2258A" (VERIFIED in `2026-10-01-ncmec-research-notes.md` §4).
- **Cost:** $0, plus our storage (a few tens of MB in Postgres; UNVERIFIED estimate).
- **Where it runs:** matching runs in our own Worker and Postgres:
  - exact MD5/SHA-1 lookups against original-bytes hashes we capture at upload;
  - a PDQ Hamming-distance search (`bit_count` over a 256-bit value) against our stored PDQ;
  - the PhotoDNA entries are **unusable to us** without the licensed PhotoDNA library.
- **What leaves us:** nothing. We download hashes, and nothing about our users goes out.

### 2.3 Microsoft PhotoDNA Cloud Service

- **Detects:** known images, by perceptual hash (PhotoDNA).
- **Access:** an API. We send the **image**, and Microsoft hashes it: "Images are instantly converted into
  secure hashes… Your content remains your content" (VERIFIED, PhotoDNA FAQ). The FAQ says Microsoft does
  not keep images.
  - Which hash lists it matches against is **not stated** (UNVERIFIED).
  - The on-prem PhotoDNA library is licensed by Microsoft to law enforcement and tool vendors. It isn't
    offered to small ESPs, as far as the FAQ says.
- **Eligibility:** "Intended users are trusted online service providers and businesses hosting
  user-generated content", via an application and "a third-party vetting service", at "Microsoft's sole
  discretion". Microsoft may re-verify or suspend access at any time (VERIFIED, cloud-service page, FAQ and
  terms).
- **Terms:**
  - use is limited to the stated purpose, with no reselling;
  - no SLA and no support;
  - Microsoft sends NCMEC **aggregate** match counts, which "do not relieve" us of our own reporting duty
    (VERIFIED, terms).
- **Cost:** "free for qualified customers", "with limited transactions per month". Higher volume goes
  through Azure Content Moderator transactions (VERIFIED, terms).
  - What the monthly cap is, and whether that Azure path still exists, are both UNVERIFIED. I believe Azure
    Content Moderator is being retired, but I couldn't confirm it.
- **Where it runs:** a cron Worker reads the object from R2 and POSTs it.
- **What leaves us:** **the image bytes**, to Microsoft.

### 2.4 Thorn Safer (Safer Essential / Safer Match, Safer Predict)

- **Detects:**
  - Safer Essential / Match: known images by "cryptographic and perceptual hashing", against "hash lists of
    known CSAM from trusted sources".
  - Safer Predict, the classifier: **not** included in the API product. Per the safer.io blog, it comes with
    Safer Enterprise, the self-hosted product (VERIFIED, safer.io and AWS Marketplace).
- **Access:** an API (Thorn-hosted) or self-hosted. **Whether hashing can happen on our side, sending only
  hashes, is UNVERIFIED** for the API product. A search summary mentions a free "Thorn Hashing Toolkit" for
  approved companies, but I couldn't confirm it on a Thorn page.
- **Eligibility:** "any platform with an upload button", through sales.
- **Cost:** **from $30,720 per 12 months** (1M queries/month) for Safer Essential on AWS Marketplace. Safer
  Enterprise starts at $45,384 per 12 months (VERIFIED, AWS Marketplace listing). **I found no non-profit or
  small-platform programme** on Thorn's pages. That's an absence from public pages only: ask sales.
- **Where it runs:** vendor API, or self-hosted (needs containers or VMs).
- **What leaves us:** bytes, unless local hashing is confirmed.
- Hive resells Safer Match. It hashes, then "immediately delete[s] the submitted content". Pricing is
  through sales (VERIFIED, Hive blog).

### 2.5 Meta PDQ plus ThreatExchange / Tech Coalition Lantern

- **PDQ:** Meta's open-source perceptual image hash, BSD-licensed (VERIFIED, the repo's `LICENSE`).
  - Implementations exist in C++, PHP, Python, Java and **WASM** "as of November 2025".
  - Meta's recommended match is **Hamming distance ≤ 31**, and it recommends discarding hashes with
    **quality ≤ 49** (VERIFIED, `facebook/ThreatExchange` `pdq/README.md`).
  - Its WASM build targets browsers (emscripten). Running it in a Worker is **UNVERIFIED**; a spike is
    needed (§3.2).
- **PDQ is only an algorithm.** It needs a list to match against. The lists I found that carry CSAM PDQ hashes:
  - **NCMEC hash sharing**, where PDQ is a supported type (§2.2);
  - **Arachnid Shield**, through its `/v1/pdq` endpoint (§2.1);
  - **Lantern**, the Tech Coalition's cross-platform signal-sharing programme hosted on ThreatExchange. Its
    2024 transparency report lists about 20k PDQ image hashes (UNVERIFIED: a search summary of the PDF).
    It's "open to qualifying tech companies… that demonstrate a firm commitment", through an interest form
    and an eligibility review. NGOs are excluded (VERIFIED, Lantern page).
    - Lantern is a **signal-sharing** programme for cross-platform investigations, not a detection list,
      and its cost is UNVERIFIED (a search summary says none).
    - **ThreatExchange itself is not a public CSAM list.** I found no CSAM PDQ list there open to small
      platforms.
- **Verdict:** use PDQ as **our hashing method**, and pair it with Arachnid now and NCMEC later. Lantern is
  "later, maybe".

### 2.6 Google Content Safety API

- **Detects:** a **classifier**. It prioritises "billions of images and videos for review". It finds new,
  unknown material, but its output is a priority score, not a determination. The tools page says it
  "supports both raw content bytes and embeddings" (VERIFIED, protectingchildren.google).
- **Eligibility:** "qualifying partners", "free of charge", "Applications are subject to approval". The
  interest form asks for organisation type, employee count, whether you can do manual review, country and
  product (VERIFIED). **The criteria aren't published.** Whether a pre-launch, one-person ESP qualifies is
  UNVERIFIED.
- **Where it runs:** a cron Worker calls the API.
- **What leaves us:** image bytes, or embeddings. The embedding path's details, and whether Google keeps
  anything, are UNVERIFIED.
- Google's CSAI Match is for **video** only. Not relevant: we accept images only.

### 2.7 Internet Watch Foundation (IWF) hash list

- **Detects:** known images, over "3.2 million hashes", updated daily, in PhotoDNA, MD5, SHA-1 and SHA-256
  (VERIFIED, IWF hash-list page).
- **Eligibility:** licensed IWF members only. Membership fees are by sector and size, **"between £5,000+ and
  £100,000+ GBP per year"** (VERIFIED, IWF fees page). Whether a US company may join isn't stated on those
  pages (UNVERIFIED).
- **Usability for us:**
  - its PDQ coverage isn't listed;
  - MD5/SHA-1 need original-bytes hashes;
  - PhotoDNA needs the library.
  - IWF hashes reportedly also feed NCMEC's NGO list. That's UNVERIFIED (a search summary), and if true it
    makes IWF largely redundant for us.
- **Verdict:** not now. It's cost-prohibitive and overlaps with free sources.

### 2.8 Cloudflare CSAM Scanning Tool (the existing first line)

- **Detects:** known images, by fuzzy hash, against lists "provided… by… NCMEC" and others. Scans content
  "served… through the Cloudflare cache" (VERIFIED, docs).
- **Notification:** one email a day. If possible it places a block (VERIFIED).
- **No NCMEC credentials needed** since 2025-02-04 (VERIFIED, changelog).
- **API:** configuration only, `GET`/`PATCH /zones/{zone_id}/settings/csam_scanner_third_party`. **There is
  no detections endpoint** (VERIFIED, API reference).
- **R2:** **still UNVERIFIED.** The docs never mention R2. The Cloudflare Community thread on R2 custom
  domains is HTTP 403 to my fetch tool again. A search summary claims objects are hashed "as they enter the
  Cloudflare cache", so R2 behind a proxied custom domain *is* covered on a cache miss, but not under
  `no-store`/`private`, a cache-bypass rule, or `r2.dev`. Our `cache-control: public, immutable` would
  qualify **if** that is true.
- **Gaps that remain even if R2 is covered:** see §1. The restricted bucket and never-fetched objects are
  never scanned.
- **What CireSnave must check:** see the §7 checklist.

### 2.9 Cloudflare Workers AI

- **No suitable model.** The catalogue (69 models, read 2026-10-04) has nothing built for CSAM:
  - `resnet-50` is a general ImageNet classifier;
  - `llava-1.5-7b-hf`, `llama-3.2-11b-vision-instruct` and `moondream` are general vision-language models;
  - `llama-guard-3-8b` is **text-only** (VERIFIED, model page).
- **Not appropriate as a CSAM detector:**
  - none of these models is trained, validated or measured for it;
  - their output would be noise in a legal process;
  - feeding suspected CSAM into a general model is exactly the misuse that model licences address. **I
    couldn't read the Llama 3.2 use policy** (it now sits behind a login), so its exact clause is UNVERIFIED.
- **Verdict: do not use.** It stays the moderation scorer for text, as the privacy policy already describes.

### 2.10 Something we can't build: our own classifier

Training or evaluating a CSAM classifier needs the material itself. Possessing it is a crime outside narrow
statutory roles. **Excluded.**

## 3. Design

### 3.1 Where it runs

- **Everything runs in our existing api Worker, on a cron.** No new infrastructure. Each tick:
  1. reads unscanned objects from R2, in memory only;
  2. computes PDQ in-isolate;
  3. sends hashes, or for fallbacks bytes, by `fetch`;
  4. writes results to Postgres.
- **Limits:**
  - Workers Paid gives a cron tick **30 s of CPU** when the interval is under an hour, 15 min at hourly or
    longer;
  - an isolate has **128 MB** of memory, WASM included (VERIFIED, Workers limits);
  - a 2048px image decodes to about 16 MB of RGBA, so one image at a time is fine.
- **Per-option placement:**

  | Option | Where it runs | Why |
  |---|---|---|
  | Arachnid `/v1/pdq` | cron Worker | PDQ in WASM, then a JSON POST |
  | Arachnid `/v1/media` (fallback) | cron Worker | streams the R2 object to the API |
  | NCMEC list | cron Worker plus Postgres | daily list sync; matching is SQL |
  | PhotoDNA Cloud | cron Worker | it's an image POST, and the library can't run in Workers |
  | Google CSA API | cron Worker | it's an image POST |
  | Thorn Safer self-hosted, or Meta's HMA | external container/VM | **not recommended**: cost and ops for one person |

- **If the PDQ spike fails** (§3.2): the fallback is Arachnid `/v1/media` from the Worker, which sends bytes.
  It isn't a VM. A small external job, such as a ~$5/month VM or Cloudflare Containers (pricing
  UNVERIFIED), is only worth it if both fail.

### 3.2 Computing PDQ inside a Worker (spike required)

**Steps:**
1. Read the WebP from R2.
2. Decode it to RGB, by one of:
   - a WASM WebP decoder;
   - or the Images binding producing a small JPEG (≤ 512px) plus a pure-JS JPEG decoder.
3. Compute PDQ with Meta's C++ built to WASM.
4. Keep the hash and quality.

**Notes:**
- The Images binding documents AVIF/WebP/JPEG outputs.
- Unique transformations: the first 5,000 a month are free, then $0.50 per 1,000 (VERIFIED, Images pricing).
- **UNVERIFIED, so the spike must answer:**
  - (a) the decode path works in workerd;
  - (b) CPU per image fits comfortably in the tick;
  - (c) our hash of Meta's test images equals the reference hashes in Meta's repo. That's the positive
    control.
- Animated GIF/WebP: PDQ hashes one frame. Whether our transform keeps animation is not something I
  checked. If it does, hash the first frame and flag the gap.

### 3.3 "Periodically scan all new images"

**Schema: a per-object scan table**, keyed on the object, not a column on `media`.
- Why: `media` has one row per uploader, but one shared object has one scan state. Columns on `media` would
  scan the same object N times and could disagree with themselves.
- "Not yet scanned" = a `media.r2_key` with no `media_scans` row.

```
media_scans: r2_key (PK) · sha256 · pdq (bit(256)) · pdq_quality · scanner · list_version
             · status ('pending' | 'clean' | 'match' | 'unscannable') · scanned_at
             · attempts · next_attempt_at · last_error · last_response_code
```

**Original-bytes hashes:** add `original_md5` and `original_sha1` to the **`media` row**, written at upload.
- Each uploader's original can differ even when the WebP is the same.
- It's cheap, it stores no image data, and it can't be backfilled. **Start it now,** so that the NCMEC
  exact lists are usable later.

**Cadence:** a branch in the existing `*/2` cron.
- Each tick takes up to N pending objects, oldest first, with a CPU budget of about 10 s out of the 30 s, so
  the email and move drains keep their share. Start with N = 20.
- PDQ hashes go to Arachnid in one `/v1/pdq` call per tick, since it takes an array. Its batch and rate
  limits are UNVERIFIED, so ask C3P and stay small.
- A new image is scanned within about 2–4 minutes of upload.

**Backfill:** the same loop. Existing media are simply the oldest unscanned rows. Nothing separate to build.

**Results:**
- `no-known-match` → `clean`.
- `csam` → intake as a **known-hash match** (§3.5). This covers an exact match or a near match at PDQ
  distance ≤ 31.
- `harmful-abusive-material` → intake as **review-first**. C3P's category isn't necessarily illegal CSAM, so
  it's quarantined but not auto-reported.
- PDQ quality ≤ 49 (Meta's discard threshold) → fall back to Arachnid `/v1/media` (bytes), recorded as such.
  If that also fails → `unscannable`, with an alarm.

**Retry:**
- A network error, 5xx or timeout leaves the status unchanged. Back off at 2, 4, 8 … minutes, capped at 30.
- **An object is never marked `clean` on an error.**
- 401/403 (credentials) stops the scanner for the tick and raises an immediate alarm.

**Never-silent alarms** use the pipeline spec's §6 channels: the `/admin/*` banner, the daily email, an
immediate email for hard failures, and a log line every tick. The condition holds when **any** of these is true:

| # | Condition | Email |
|---|---|---|
| S1 | an object unscanned more than **30 min** after its first `media` row | daily, plus immediate on first raise |
| S2 | the scanner answers 401/403 | immediate |
| S3 | an object is `unscannable` (decode failure, or low quality with the fallback failing) | daily |
| S4 | Arachnid's `/v1/version` is unchanged for more than 30 days, or the NCMEC sync has failed for 48 h (staleness) | daily |
| S5 | the scan cron branch hasn't completed for 1 h (a heartbeat row), which catches a dead cron and not just a failing vendor | immediate |

S1 alone catches "the scanner is down", whatever the cause. S5 is the positive control on the loop itself.

**Open question: block until scanned?**
- We could serve nothing until an image is `clean` (fail closed).
- But then a scanner outage stops all image posting.
- **My recommendation:** don't block at launch. Rely on the 2–4-minute scan plus the S1 alarm. Revisit if the
  outage risk proves low. **CireSnave's call** (§8 Q1).

### 3.4 Least contact with illegal content

- **What leaves us:**
  - on the primary path, **only PDQ hashes** (to C3P);
  - fallback, bytes go to C3P only for low-quality or undecodable images;
  - PhotoDNA, if added later: bytes to Microsoft;
  - NCMEC list matching: nothing.

  | Option | Hash-only possible? |
  |---|---|
  | Arachnid `/v1/pdq` | yes |
  | NCMEC list | yes (local) |
  | Lantern | yes (local) |
  | PhotoDNA Cloud | **no** (no library for us) |
  | Google CSA | bytes, or embeddings (UNVERIFIED) |
  | Safer API | UNVERIFIED |
  | Cloudflare | it scans in its own cache |

- **Who sees anything:** nobody, at scan time. The Worker holds the bytes in memory only for the hash. On a
  match, a moderator views the image only at review, through the existing restricted path with its
  two-person grant (#61). Previews are blurred, with an explicit Reveal (pipeline spec §7).
- **No copies:** the scanner writes no image anywhere. No temp object, no log of bytes, no cache. Stored
  hashes are fingerprints, not images. On a match, the only preserved copy is the object itself, moved to
  `MEDIA_RESTRICTED` under the CSAM legal hold, which the pipeline already does.
- **Legal basis (best safe guess, no attorney):**
  - §2258A(f): the statute doesn't **require** scanning, but nothing in it forbids voluntary scanning
    (research notes §3).
  - §2258C: hash sharing exists precisely for this purpose. Using hashes leaves the duty to report intact.
  - Hash-only matching is the lowest-risk method. **Sending suspected CSAM bytes to anyone but NCMEC is the
    riskiest step**, which is why bytes are a fallback. Even then they go only to a child-protection body
    (C3P), or to Microsoft under terms written for this purpose.
  - §2258B(c): minimise employee access. Only the moderator at review sees anything, and only through the
    two-person path.
  - ⚠️ **"Actual knowledge" timing:**
    - a known-hash match plausibly gives us the knowledge that starts the "as soon as reasonably possible"
      clock (§2258A(a));
    - NCMEC told CireSnave that filing on a match without review is acceptable (pipeline spec §0).
    - The parallel revision files only after a moderator CONFIRM. **So the urgent alarm and prompt review
      are what keep us inside "as soon as reasonably possible".** This is a timing risk the revision should
      state, not something self-scan changes.

### 3.5 Feeding the quarantine and review pipeline

Self-scan adds new detection `source` values to the parallel revision's intake: `self_scan_hash` and
`self_scan_classifier`. These are proposed names; the revision owns the enum. It uses the **same** intake
function: quarantine, case, alarm. No parallel path.

| Source | Confidence | Effect |
|---|---|---|
| `self_scan_hash` (Arachnid `csam`, an NCMEC list match, a PhotoDNA match) | high | quarantine; **priority case; urgent alarm**; CONFIRM → ban + CyberTipline report |
| `self_scan_hash` with Arachnid `harmful-abusive-material` | medium | quarantine; normal-priority case; review-first; **never auto-reported** |
| `self_scan_classifier` (Google CSA, later) | low | quarantine; normal-priority case; review-first; **never auto-reported** |

**Evidence carried on the case:**
- vendor;
- classification;
- `exact` or `near`, and the PDQ distance;
- list version;
- scan time.

The report's `fileViewedByEsp` stays false unless the moderator reveals the image.

**Idempotence:** intake is keyed by `r2_key` (UNIQUE `csam_case_files`), so a Cloudflare-email intake and a
self-scan hit on the same object make one case.

**The `media_scans` row** becomes `match` in the same transaction as intake, or retries if intake fails. It is
never `clean`.

**Re-scan policy: yes, re-check old media when a list updates.** It's cheap because we keep the hashes.
- **Arachnid:** daily, if `/v1/version`'s `last_updated_at` has moved since an object's `list_version`,
  re-send that object's stored PDQ. It's hash-only: no R2 read, no decode.
- **NCMEC list:** on each incremental sync, match only the **new** list entries against all stored PDQ and
  original hashes. The cost is the new entries, not our media.
- **PhotoDNA**, if added: re-scanning means re-sending bytes, so re-scan on demand only.

## 4. Options table

| Option | Detection | Eligibility / registration | Cost | Data that leaves us | Where it runs | Effort | Verdict |
|---|---|---|---|---|---|---|---|
| **Arachnid Shield** (C3P) | known-hash (exact + near) | ESP sign-up; reviewed access (UNVERIFIED detail) | **$0** | **PDQ hashes only**; bytes on fallback | cron Worker | **M**: PDQ-in-WASM spike + client | **Primary** |
| **NCMEC hash sharing** | known-hash (MD5, SHA1, PDQ; PhotoDNA unusable) | separate credentials from NCMEC | **$0** | nothing | cron Worker + Postgres | **M–L**: sync + matcher | **Phase 2** |
| **PhotoDNA Cloud** | known-hash (PhotoDNA) | application + third-party vetting, Microsoft's discretion | **$0** (monthly transaction cap) | **image bytes** to Microsoft | cron Worker | **S**: one POST | **Fallback / second engine**; apply now (lead time) |
| **Google Content Safety API** | **classifier** | application, approval; criteria unpublished | **$0** | bytes (or embeddings, UNVERIFIED) | cron Worker | **S–M** | **Later**: review-first only |
| **Thorn Safer** | known-hash; classifier only in Enterprise | sales contract | **≥ $30,720/yr** | bytes (local hashing UNVERIFIED) | vendor API or self-host | M (L self-host) | **No**: budget |
| **Lantern / ThreatExchange** | cross-platform signals incl. PDQ | Tech Coalition eligibility review; industry only | likely $0 (UNVERIFIED) | our shared signals, if we share | external platform | M | **Later, maybe** |
| **IWF hash list** | known-hash | IWF licensed membership | **≥ £5,000/yr** | nothing (list) | Worker + Postgres | M | **No**: cost, overlaps NCMEC |
| **Cloudflare CSAM tool** | known-hash (fuzzy) | none (email only) | $0 | n/a (in Cloudflare's cache) | Cloudflare edge | **none**: dashboard | **Keep** as first line; R2 coverage unverified; can't see restricted or unfetched |
| **Workers AI** | none suitable | n/a | n/a | n/a | n/a | n/a | **Do not use** |

## 5. Recommendation

**Primary: Arachnid Shield, hash-only.**
- PDQ is computed in our Worker from the stored WebP, sent to `/v1/pdq` from the existing `*/2` cron, with
  results in `media_scans`.
- It's free, needs no new infrastructure, sends no image bytes on the normal path, and is run by a
  child-protection body.
- It closes the two gaps Cloudflare can't: the restricted bucket and never-fetched objects.

**Fallback: Microsoft PhotoDNA Cloud Service.** It's free if approved, and a second engine against different
lists.
- Use it if Arachnid access is refused or rate-limited, or if the PDQ spike fails. Until it's approved, the
  fallback is Arachnid `/v1/media` (bytes).
- **Apply now**, because vetting lead time is unknown.

**Phased path:**

| When | Do |
|---|---|
| **Now (pre-launch)** | CireSnave: the §7 checks and applications. Engineering: the PDQ-in-Worker spike (§3.2), then a spec and plan for `media_scans`, the scan cron branch, alarms S1–S5, the original-hash columns on upload, and the `self_scan_*` sources in the parallel revision's intake. Backfill is automatic. |
| **At launch (gate on APP.live)** | Arachnid live. **Zero objects unscanned over 30 min.** Every alarm S1–S5 shown to fire, and shown not to fire with its condition removed. A known PDQ test vector (Arachnid's `test` classification) driven end to end into a quarantine case. Privacy policy updated (§6). |
| **Later** | **NCMEC list sync**: local PDQ plus original-bytes MD5/SHA-1 matching, with re-scan on each sync. **PhotoDNA** as a second engine, if approved. **Google Content Safety API** classifier, review-first, once there's volume and moderator capacity. Lantern, if we ever need cross-platform signals. Ask Thorn about non-profit pricing once TJ's non-profit status exists. |

## 6. Privacy policy

**Yes, it needs a disclosure, and it adds processors.**
- **C3P (Project Arachnid)** receives a fingerprint derived from a user's image, and on fallback the image.
  Treat it as a **new sub-processor** to be safe, even though a PDQ hash is arguably not personal data.
- **Microsoft** becomes one too if PhotoDNA is adopted, because it receives image bytes.
- C3P is in **Canada**, so this is also a cross-border transfer for the policy's transfers section.

**Proposed plain-language sentence for §2:**
> We automatically check every image uploaded to the Service against lists of known child sexual abuse
> material kept by child-protection organisations. To do this we usually send only a digital fingerprint of
> the image, not the image itself, to Project Arachnid (run by the Canadian Centre for Child Protection). In
> the rare case a fingerprint can't be made, we send the image itself. Any possible match is hidden at once,
> reviewed by our moderators, and reported to the National Center for Missing & Exploited Children where the
> law requires.

**§3 processor table additions:**
- **Canadian Centre for Child Protection (Project Arachnid / Shield)**: *Checking uploaded images against
  known-CSAM lists, by fingerprint; occasionally the image itself.*
- **Microsoft (PhotoDNA)**, if adopted: *Checking uploaded images against known-CSAM lists; images are
  converted to a fingerprint and not kept.*

**Also:** the existing Cloudflare row's `[[confirm the CSAM Scanning Tool is enabled…]]` placeholder stays
until the §7 check is done.

## 7. CireSnave's checklist

The NCMEC ESP registration is already his.

1. **Cloudflare dashboard**, on the zone serving `cdn.thinkersjournal.com`:
   - **Caching → Configuration → CSAM Scanning Tool**: is it **enabled**, and is the notification email
     set?
   - Is `cdn.thinkersjournal.com` the R2 custom domain for `tj-media`, on this zone?
   - Do no Cache Rules bypass the cache for that host?
   - Is the bucket's public `r2.dev` URL **disabled**?
   - <https://developers.cloudflare.com/cache/reference/csam-scanning/>. The setting can also be read with
     `GET /zones/{zone_id}/settings/csam_scanner_third_party`.
   - Then ask Cloudflare support directly: **"Does the CSAM Scanning Tool scan R2 objects served through a
     custom domain on this zone?"** It's the only authoritative answer, since the docs are silent.
2. **Register for Arachnid Shield** (free). Ask C3P for its API terms, its rate and batch limits for
   `/v1/pdq`, and whether `/v1/media` uploads are kept.
   <https://www.projectarachnid.ca/en/api/accounts/register/>
3. **Apply for PhotoDNA Cloud Service** (free, vetted). Ask what the monthly transaction cap is.
   <https://www.microsoft.com/en-us/photodna/cloudservice>
4. **Ask NCMEC for Hash Sharing API credentials** for the industry/NGO CSAM list. This is separate from the
   CyberTipline credentials. Ask which share of entries carry PDQ.
   <https://hashsharing.ncmec.org/npo/v2/documentation/>
5. *Optional, later:* the Google child-safety toolkit interest form, for the Content Safety API.
   <https://protectingchildren.google/toolkit-interest-form/>
6. *Optional, later:* the Tech Coalition Lantern interest form.
   <https://technologycoalition.org/programs/lantern/>

**Pay for:** nothing in the recommended path. Possible small costs:
- Images-binding transforms past 5,000 a month, at $0.50 per 1,000, only if the spike chooses that decode
  path;
- Postgres storage for the hashes.

## 8. Open questions for CireSnave

1. **Block until scanned?** Should a new image be unservable until it scans clean? That's safer, but a
   scanner outage then stops all image posting. My recommendation is not at launch (§3.3).
2. **The bytes fallback:** is sending an image's bytes to C3P acceptable for the small share of images
   whose fingerprint can't be computed? If not, those images become `unscannable` and need manual
   disposition, and would never be published.
3. **`harmful-abusive-material`:** C3P's category for material that may not meet the legal CSAM definition.
   Should it be quarantined review-first, as proposed, or ignored?
4. **The review-timing risk** (§3.4): given NCMEC's statement that filing on a match is fine, does he want a
   **time limit**? For example, a known-hash match unreviewed after N hours files automatically, so moderator
   delay can't breach "as soon as reasonably possible".
5. **Fund IWF or Thorn later?** Both are paid. This document recommends neither.

## 9. Sources (all accessed 2026-10-04)

- Arachnid Shield OpenAPI (v1.1.0): <https://shield.projectarachnid.com/openapi.json>
- Project Arachnid home (Shield, cost, sign-up): <https://www.projectarachnid.ca/en/>
- Project Arachnid terms of use (no API terms found): <https://projectarachnid.ca/en/terms-of-use/>
- Arachnid Shield TypeScript SDK: <https://github.com/CdnCentreForChildProtection/arachnid-shield-sdk-ts>
- Arachnid Shield PHP SDK: <https://github.com/CdnCentreForChildProtection/arachnid-shield-sdk-php>
- NCMEC Hash Sharing API docs: <https://hashsharing.ncmec.org/npo/v2/documentation/>
- NCMEC CyberTipline data (hash-sharing figures): <https://www.missingkids.org/gethelpnow/cybertipline/cybertiplinedata>
- NCMEC hash sharing platform (secondary, UNVERIFIED): <https://stellapolaris.childhood.se/natural-language-processing-datorlingvistik/verktyg-i-databasen-som-anvnder-ljud-ai/ncmec-hash-sharing-platform>
- PhotoDNA Cloud Service: <https://www.microsoft.com/en-us/photodna/cloudservice>
- PhotoDNA FAQ: <https://www.microsoft.com/en-us/photodna/faq>
- PhotoDNA Cloud Service terms: <https://www.microsoft.com/en-us/photodna/termsofuse>
- Thorn platform solutions: <https://www.thorn.org/solutions/for-platforms/>
- Safer Match / Essential announcement: <https://safer.io/resources/introducing-safer-essential-api-based-csam-detection/>
- Safer Essential on AWS Marketplace (pricing): <https://aws.amazon.com/marketplace/pp/prodview-dfwekn4bx4ake>
- Safer Enterprise on AWS Marketplace (pricing, via search summary): <https://aws.amazon.com/marketplace/pp/prodview-unzbqt3w6pqbg>
- Hive and Safer Match: <https://thehive.ai/blog/matching-against-csam-hives-innovative-integration-with-thorns-safer-match>
- Meta PDQ README: <https://github.com/facebook/ThreatExchange/blob/main/pdq/README.md>
- Meta PDQ WASM README: <https://github.com/facebook/ThreatExchange/tree/main/pdq/wasm>
- ThreatExchange licence (BSD): <https://github.com/facebook/ThreatExchange/blob/main/LICENSE>
- Tech Coalition Lantern: <https://technologycoalition.org/programs/lantern/>
- Lantern Transparency Report 2024 (via search summary, UNVERIFIED): <https://technologycoalition.org/wp-content/uploads/2025/06/Lantern-Transparency-Report-2024.pdf>
- Google child-safety toolkit: <https://protectingchildren.google/tools-for-partners/>
- Google toolkit interest form: <https://protectingchildren.google/toolkit-interest-form/>
- Google CSAM FAQ: <https://support.google.com/transparencyreport/answer/10330933?hl=en>
- IWF membership fees: <https://www.iwf.org.uk/membership/fees/>
- IWF image hash list: <https://www.iwf.org.uk/our-technology/our-services/image-hash-list/>
- Cloudflare CSAM Scanning Tool docs: <https://developers.cloudflare.com/cache/reference/csam-scanning/>
- Cloudflare CSAM Scanner API: <https://developers.cloudflare.com/api/resources/csam_scanner>
- Cloudflare changelog 2025-02-04 (no NCMEC credentials): <https://developers.cloudflare.com/changelog/post/2025-02-04-easier-onboarding-for-csam-scanning-tool/>
- Cloudflare Community, R2 coverage (HTTP 403 to fetch; claim via search summary, UNVERIFIED): <https://community.cloudflare.com/t/does-csam-scanning-tool-cover-r2-objects-served-via-a-proxied-custom-domain/942172>
- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Workers Web Crypto (MD5/SHA-1): <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
- Images binding: <https://developers.cloudflare.com/images/transform-images/bindings/>
- Images pricing: <https://developers.cloudflare.com/images/pricing/>
- Workers AI model catalogue: <https://developers.cloudflare.com/workers-ai/models/>
- Workers AI `llama-guard-3-8b`: <https://developers.cloudflare.com/workers-ai/models/llama-guard-3-8b/>
- Llama 3.2 acceptable use policy (behind a login, so not read): <https://www.llama.com/llama3_2/use-policy/>
- Statutes (§2258A/B/C), via `docs/superpowers/specs/2026-10-01-ncmec-research-notes.md` §3–§4, which cites
  Cornell LII and govinfo.
