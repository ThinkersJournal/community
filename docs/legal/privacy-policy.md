# Privacy Policy — DRAFT (not in force; not reviewed by an attorney)

> ⚠️ DRAFT. Not in force. See `README.md`. `[[BRACKETED]]` = to be filled. Data
> practices below are grounded in the current code and are the operator's
> best-effort description of it.

**Effective:** [[EFFECTIVE_DATE]] · Controller: [[LEGAL_ENTITY]]

This policy explains what we collect, why, who processes it, and your choices.

## 1. What we collect

**You give us:**
- **Account data** — email address, your chosen public handle, and a password
  (stored only as a salted **argon2id hash**; we never store the password itself).
- **Content** — your posts, comments, reactions, follows, profile, and any images
  you upload.

**Collected automatically:**
- **Security/technical data** — IP address and request metadata, used for abuse
  prevention, rate limiting, and bot detection (Cloudflare Turnstile / WAF). We do
  not use this for advertising.
- **A session cookie** — an opaque identifier that keeps you logged in. It is
  strictly necessary for the Service; we do not use advertising or cross-site
  tracking cookies.

**DSA notices (legal complaints):**
- If you report illegal content via the `/dsa-notice` form, we collect your name,
  email address, the category of the violation you are reporting, a statement
  describing it, and a confirmation that you are acting in good faith. This is
  required by DSA Article 16(2)(c)–(d) to process and respond to your report.
  Your email is verified by a confirmation link before the report is reviewed.
  Unconfirmed reports are deleted after 7 days.

**We deliberately minimize:**
- Uploaded images are converted to WebP and **EXIF metadata is stripped**, so
  location and camera data embedded in your photos are removed before storage.
- We do not knowingly collect data from children below the minimum age in §7.

## 2. Why we use it

- To operate the Service — create your account, publish your content, run the feed,
  search, notifications, and email verification.
- To secure the Service — authentication, rate limiting, bot and abuse detection,
  and content moderation (including scanning uploaded images for known CSAM).
- To communicate — verification and notification emails you've opted into.
- To comply with law and enforce our Terms and Guidelines.

We rely on the legal bases of **performing our contract** with you (operating your
account), our **legitimate interests** (security, moderation, improving the
Service), **consent** (optional notification emails), and **legal obligation**
(e.g. mandatory CSAM reporting).

## 3. Who processes it (sub-processors)

We host on infrastructure operated by service providers who process data on our
behalf under contract:

| Provider | Purpose |
|---|---|
| **Cloudflare** | Application runtime (Workers), image/object storage (R2), database connection pooling, session storage, bot detection (Turnstile), and CSAM scanning [[confirm the CSAM Scanning Tool is enabled on the production zone; not verifiable from the repository — #114]]. |
| **Neon** | The PostgreSQL database holding accounts and content. |
| **Postmark** | Sending verification and notification emails. |
| **[[MODERATION_SCORER]]** | Machine scoring of new posts/comments to prioritize moderation review. *(If Cloudflare Workers AI is used, content is scored in-platform and is not sent to a separate vendor — the recommended option.)* |

We do not sell your personal information.

## 4. Sharing

We share personal data only: with the sub-processors above; when **required by law**
or to respond to lawful requests; to **report CSAM** to NCMEC as legally mandated;
to protect the rights, safety, and security of the Service, our users, or the
public; and in a business transfer, subject to this policy.
[[NOT YET TRUE — status 2026-10-01, issue #114: no NCMEC reporting path exists
yet, automated or manual. It is required before the Community opens to users
officially. The data a CyberTipline report shares must be listed here once the
report's contents are designed.]]

**DSA notice reporter information** — your name and email from a legal complaint
you file — is shown to moderators reviewing the report, so they can respond to
you. It is **never** disclosed to the author of the content you are reporting.

**How long we keep DSA notices.** A notice you never confirm is deleted
automatically: once a day, we delete unconfirmed notices that are more than 7
days old. A confirmed notice is not deleted automatically: there is no
retention period for confirmed notices today, and we keep them in the notice
record. That record holds your name, email address, the category, your
statement, the title of the reported post or the first 120 characters of the
reported comment (captured when you filed the notice), and, once a moderator
has resolved it, a record of how it was resolved. If the reported content is
later deleted, the notice and that captured title or excerpt are kept.

## 5. Retention

- **Unverified accounts** are automatically deleted after [[REAPER_WINDOW]] if the
  email is never verified.
- **Individual content you delete** (a post or comment) is removed from the live
  Service, and any images that become unreferenced as a result are
  garbage-collected from storage. **Exception:** if our moderators had hidden or
  removed that content when you deleted it, we keep a private copy of it (and
  the images it contains) for legal purposes, such as appeals and legal
  obligations, for at least one year, and until we are advised it may be
  deleted. It is not shown to anyone on the Service.
  If someone filed a DSA notice naming that
  content, its title (for a post) or the first 120 characters (for a comment)
  is kept in that notice's own record, as described above.
- **An account you delete is not erased.** After a 30-day grace period (during
  which you can cancel the deletion), we anonymise it: your email, password,
  and profile details are scrubbed and your handle is released for reuse on
  the Service (the moderation log may still record it; see below). Your posts and
  comments remain hosted and displayed, attributed to a generic "deleted user"
  rather than your identity, so that conversations other people are part of
  are not broken. Reasonable backup and legal-compliance copies of the
  anonymised account may persist for a limited period.
  **Legal holds.** While an account is under a legal hold (for example,
  during a legal or safety investigation), its deletion is delayed, not
  refused: the request stays recorded, and the deletion goes ahead after the
  hold is released. An account under a legal hold for child sexual abuse
  material is never anonymised or deleted, because that kind of hold is never
  released.
  **Banned accounts.** If an account was banned when its deletion took
  effect, its email address is replaced like any other account's, and we keep
  a fingerprint of the address so that it can't be used to create a new
  account while the ban stands. The fingerprint is a keyed hash
  (HMAC-SHA-256) made with a secret key that is stored separately from our
  database, so someone who has the fingerprint but not the key can't use it
  to find out or confirm the address.
  **Moderation log.** Our moderation log is append-only and is kept as the
  legal record of moderation actions. Deleting an account does not remove
  from it the email address recorded at the time of any moderation decision
  about that account's content, or the email address recorded each time the
  account's owner hid or unhid one of their own posts. Nor does it remove the
  account's handle as recorded at any moderation action on the account itself
  (a warning, suspension, ban or termination, or a legal hold being imposed or
  released). The log is not used to contact you.
- **Security logs** are retained only as long as needed for abuse prevention.

## 6. Your choices and rights

- **Access / correction** — view and edit your profile and content in-product.
- **Deletion** — delete individual content or your entire account at any time.
- **Email** — manage notification emails in your settings; verification email is
  required to activate an account.
- Depending on where you live (e.g. EEA/UK, California), you may have additional
  rights to access, port, correct, or delete personal data, and to object to
  certain processing. To exercise them, contact [[CONTACT_EMAIL]].

## 7. Children

You must be at least 13 years old, or older if the minimum age for consenting
to online services where you live is higher, to use the Service (Terms of
Service §1). The Service is not directed to anyone below that age, and we do not
knowingly collect their personal information. We do not ask for your date of
birth and do not verify ages: signing up asks only for an email address, a
handle and a password. If we learn that an account belongs to someone below that
age, we will delete the account and the personal information it holds.

## 8. Security

We use industry-standard measures — password hashing (argon2id), encrypted
transport (HTTPS), scoped access, and a least-privilege database role — to protect
your data. No system is perfectly secure, and we cannot guarantee absolute security.

## 9. International transfers

The Service is operated from the United States. If you use it from outside the
United States, including from the EEA or the UK, your personal data is
transferred to and processed in the United States and in other countries where
the providers listed in §3 operate, under those providers' standard
data-processing terms. For example, Cloudflare runs the Service on its network
of data centres in many countries, so a request you make may be handled in a
data centre outside the United States.
We have not put in place any other transfer mechanism: we have not signed
standard contractual clauses of our own, and we do not rely on an adequacy
decision.

## 10. Changes

We may update this policy; material changes will be announced with a new effective
date.

**Contact:** [[CONTACT_EMAIL]] · [[CONTACT_ADDRESS]]
