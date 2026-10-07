/**
 * Account-holder notices (security-alerting spec §4): the spec's §4.1 block
 * followed by its §4.2 block, verbatim. PR 1 shipped only `PostmarkOutcome` and
 * `classifyPostmark`; PR 2 adds the rest.
 */
export type AccountNoticeKind = "new_sign_in" | "password_reset";

/** Why a session is being minted; it decides what happens to the device list (§4.1). */
export type DeviceRecordMode = "signup" | "login" | "reset";

/**
 * The browser's entry under the current key, and under the previous key during a
 * rotation, each with its key id (`keyId`), stored beside the entry.
 */
export interface DeviceHashes {
  readonly current: string;
  readonly currentKid: string;
  readonly prev: string | null;
  readonly prevKid: string | null;
}

/** `UserSecurityDO.recordDevice`'s answer. */
export interface SignInRecord {
  /** The browser matched an entry under either key (a `prev` match is rewritten to `current`). */
  readonly knownDevice: boolean;
  /** The list was empty before the call (first sign-in since rollout, or every entry expired). */
  readonly listWasEmpty: boolean;
  /**
   * The list was NOT empty, but no entry was under the current or previous key:
   * the key was replaced without `_PREV`. Such a sign-in is part of a wave (§4.4).
   */
  readonly unknownKeysOnly: boolean;
}

/**
 * `UserSecurityDO.claimNotice`'s answer. A notice is never dropped: it is sent now,
 * or folded into the account's one pending notice of that kind, due `dueMs`.
 */
export type NoticeClaim =
  | {
      readonly send: "now";
      /** Earlier sign-ins folded into this notice, and when the first of them happened. */
      readonly coalesced: { readonly count: number; readonly sinceMs: number } | null;
    }
  | { readonly send: "deferred"; readonly dueMs: number };

/**
 * The methods this design adds to `UserSecurityDO`.
 * - `signup`: clear the list, then record this device. The ONE silent path.
 * - `reset`: clear every device except this one, then record it.
 * - `login`: record it; the caller notifies when it was not known.
 */
export interface UserSecurityNoticeRpc {
  recordDevice(hashes: DeviceHashes, nowMs: number, mode: DeviceRecordMode): Promise<SignInRecord>;
  /**
   * `notBeforeMs` > `nowMs` defers even an under-cap notice (the wave's jitter).
   * The event's country and `listWasEmpty` are stored if the notice is deferred.
   */
  claimNotice(
    kind: AccountNoticeKind,
    event: { readonly atMs: number; readonly country: string | null; readonly listWasEmpty: boolean },
    nowMs: number,
    notBeforeMs: number,
  ): Promise<NoticeClaim>;
  forgetDevices(): Promise<void>;
  /** Both reapers call this: every pending notice ends `dropped_account_gone`, logged. */
  dropPendingNotices(): Promise<void>;
}

export const NOTICE_CAPS: Readonly<Record<AccountNoticeKind, { readonly perHour: number; readonly perDay: number }>> = {
  new_sign_in: { perHour: 3, perDay: 10 },
  password_reset: { perHour: 3, perDay: 5 },
};

/**
 * The one pending notice per account and kind (`pending_notice` in
 * `UserSecurityDO`): everything the deferred notice needs, so the alarm builds
 * it with no request in hand (G2).
 */
export interface PendingNotice {
  readonly kind: AccountNoticeKind;
  /** Events folded in, including the latest. */
  readonly count: number;
  readonly firstEventMs: number;
  /** The latest event: the time and approximate country the notice reports. */
  readonly lastEventMs: number;
  readonly lastCountry: string | null;
  /** True if ANY folded sign-in found an empty list (sign-in notices only). */
  readonly listWasEmpty: boolean;
  readonly dueMs: number;
  /** Failed send attempts so far (transient refusals). */
  readonly attempts: number;
}

/** The pending notice's states. The last three are terminal; each drop is logged. */
export type NoticeState =
  | "pending" // folded, waiting for `dueMs`
  | "retrying" // a send was refused for a transient reason; backing off
  | "sent"
  | "dropped_account_gone" // anonymised, reaped, or no live row at send time
  | "dropped_permanent_refusal" // Postmark refused the recipient for good
  | "dropped_expired"; // transient refusals for NOTICE_MAX_AGE_MS

/** What `postmarkSend` saw, before it collapses to a boolean (§4.4). */
export type PostmarkOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | null; readonly errorCode: number | null };

/**
 * Postmark's per-recipient refusals that no retry can fix: 300 (send validation,
 * e.g. an invalid address) and 406 (inactive recipient). Everything else (a
 * thrown request, a timeout, HTTP 429 or 5xx, and account-level codes such as
 * 10, 412 or 1480 that an operator must fix) is transient for this notice.
 */
export function classifyPostmark(o: PostmarkOutcome): "sent" | "permanent" | "transient" {
  if (o.ok) return "sent";
  return o.errorCode === 300 || o.errorCode === 406 ? "permanent" : "transient";
}

/** A notice still unsent this long after its first event is dropped (`dropped_expired`). */
export const NOTICE_MAX_AGE_MS = 7 * 86_400_000;

/** Retry delay after the n-th transient refusal (n ≥ 1): 15 min, doubling, at most 6 h. */
export function noticeRetryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

/**
 * Folding one more event into the pending notice (m2): the due time is the
 * EARLIER of the old one and this event's `notBeforeMs`, but never before the
 * cap reopens. Stable under repeated folds, so the 30 h bound holds.
 */
export function foldedDueMs(oldDueMs: number | null, notBeforeMs: number, capReopensAtMs: number): number {
  return Math.max(capReopensAtMs, oldDueMs === null ? notBeforeMs : Math.min(oldDueMs, notBeforeMs));
}

/** A device list entry unseen this long is pruned by `UserSecurityDO.alarm()`. */
export const DEVICE_TTL_MS = 400 * 86_400_000;

/** §4.1's definition of "new". No exception for an empty list (PM ruling on C3). */
export function isNewSignIn(r: SignInRecord): boolean {
  return !r.knownDevice;
}

/** The kind's caps, read without an index on a variable key (Codacy: object-injection sink). */
function capOf(kind: AccountNoticeKind): (typeof NOTICE_CAPS)[AccountNoticeKind] {
  return kind === "new_sign_in" ? NOTICE_CAPS.new_sign_in : NOTICE_CAPS.password_reset;
}

/** The cap test `claimNotice` runs over the kind's send times (ms). */
export function capAllows(sentAtMs: readonly number[], nowMs: number, kind: AccountNoticeKind): boolean {
  const cap = capOf(kind);
  const inLast = (ms: number) => sentAtMs.filter((t) => nowMs - t < ms).length;
  return inLast(3_600_000) < cap.perHour && inLast(86_400_000) < cap.perDay;
}

/**
 * When the cap next allows one more notice: the deferred notice's due time. At
 * most 24 h away, because every send time older than a day no longer counts.
 */
export function capReopensAt(sentAtMs: readonly number[], nowMs: number, kind: AccountNoticeKind): number {
  const cap = capOf(kind);
  const reopen = (windowMs: number, limit: number): number => {
    const inWindow = sentAtMs.filter((t) => nowMs - t < windowMs).sort((a, b) => a - b);
    const mustExpire = inWindow.length - limit; // >= 0 means this window is full
    const t = inWindow.at(mustExpire); // read only when mustExpire >= 0
    return mustExpire >= 0 && t !== undefined ? t + windowMs : nowMs;
  };
  return Math.max(nowMs, reopen(3_600_000, cap.perHour), reopen(86_400_000, cap.perDay));
}

/** A wave sign-in's notice is spread uniformly over this window, never dropped (§4.4). */
export const WAVE_SPREAD_MS = 6 * 3_600_000;

/** The earliest time this sign-in's notice may go out: now, or a random point in the wave window. */
export function noticeNotBefore(r: SignInRecord, nowMs: number, random: () => number): number {
  return r.unknownKeysOnly ? nowMs + Math.floor(random() * WAVE_SPREAD_MS) : nowMs;
}

/**
 * THE INVARIANT (§4.4): every new-browser sign-in with notices enabled and a key
 * set produces a notice within this long, plus however long Postmark refuses.
 */
export const NOTICE_MAX_DELAY_MS = WAVE_SPREAD_MS + 24 * 3_600_000;

/** Production cookie: `__Host-` forces Secure, Path=/ and no Domain, so a sibling subdomain cannot plant it. */
export const DEVICE_COOKIE = "__Host-tj_device";
/** Dev/CI only (`TEST_ROUTES === "1"`), where Secure cannot be stored; same gate as the session cookie. */
export const DEV_DEVICE_COOKIE = "tj_device_dev";

export function buildDeviceCookie(env: { readonly TEST_ROUTES?: string }, token: string): string {
  if (env.TEST_ROUTES === "1") {
    return `${DEV_DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;
  }
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`;
}

/** The device keys, or null when device notices must be DISABLED (no current key). */
export interface DeviceKeys {
  readonly current: string;
  readonly prev: string | null;
}

export function resolveDeviceKeys(env: {
  readonly DEVICE_HASH_KEY?: string;
  readonly DEVICE_HASH_KEY_PREV?: string;
}): DeviceKeys | null {
  const current = env.DEVICE_HASH_KEY ?? "";
  if (current === "") return null;
  const prev = env.DEVICE_HASH_KEY_PREV ?? "";
  return { current, prev: prev === "" ? null : prev };
}

/**
 * The stored identifier: HMAC-SHA256 keyed by a device key over the user id and
 * the token. Bound to the account, so one browser shared by two accounts yields
 * two unrelated values.
 */
export async function deviceHash(key: string, userId: string, token: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${userId}:${token}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A short, non-secret id for a key, stored beside each entry so a replaced key is detectable. */
export async function keyId(key: string): Promise<string> {
  return (await deviceHash(key, "key-id", "")).slice(0, 8);
}

export async function deviceHashes(keys: DeviceKeys, userId: string, token: string): Promise<DeviceHashes> {
  return {
    current: await deviceHash(keys.current, userId, token),
    currentKid: await keyId(keys.current),
    prev: keys.prev === null ? null : await deviceHash(keys.prev, userId, token),
    prevKid: keys.prev === null ? null : await keyId(keys.prev),
  };
}

export interface NoticeInput {
  readonly at: Date;
  /** ISO 3166-1 alpha-2 from the edge, or null. Never an IP. */
  readonly country: string | null;
  /** Earlier events of this kind folded into this notice by the cap, or null. */
  readonly coalesced: { readonly count: number; readonly since: Date } | null;
  /** `${CANONICAL_ORIGIN}/forgot-password` (`auth/email-verify.ts:38`): never derived from a request. */
  readonly forgotPasswordUrl: string;
}

export interface SignInNoticeInput extends NoticeInput {
  readonly listWasEmpty: boolean;
}

export interface NoticeText {
  readonly subject: string;
  readonly textBody: string;
}

function where(country: string | null): string {
  if (country === null || !/^[A-Z]{2}$/.test(country)) return "";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
    return ` from ${name ?? country} (approximate)`;
  } catch {
    return ` from ${country} (approximate)`;
  }
}

function more(c: NoticeInput["coalesced"], one: string, many: string): string {
  if (c === null || c.count <= 0) return "";
  return `\n\nThis notice also covers ${String(c.count)} other ${c.count === 1 ? one : many} since ` +
    `${c.since.toISOString()} (UTC), held back so this account is not sent a flood of mail.`;
}

function firstSince(i: SignInNoticeInput): string {
  return i.listWasEmpty
    ? `\n\nThis account had no browser on record. That happens on the first sign-in after we began ` +
      `recording browsers, or after the last one went unused for 400 days.`
    : "";
}

export function newSignInNotice(i: SignInNoticeInput): NoticeText {
  return {
    subject: "New sign-in to your Thinkers Journal account",
    textBody:
      `Your Thinkers Journal account was signed in to at ${i.at.toISOString()} (UTC)${where(i.country)}, ` +
      `on a browser it has not been signed in to before.` +
      firstSince(i) +
      more(i.coalesced, "new sign-in", "new sign-ins") +
      `\n\nIf this was you, you can ignore this email.` +
      `\n\nIf it was NOT you, reset your password now: ${i.forgotPasswordUrl}\n` +
      `A reset signs out every other device, including the one that just signed in.`,
  };
}

export function passwordResetNotice(i: NoticeInput): NoticeText {
  return {
    subject: "Your Thinkers Journal password was changed",
    textBody:
      `The password for your Thinkers Journal account was changed at ${i.at.toISOString()} (UTC)` +
      `${where(i.country)}, using a reset link sent to this address. Every other device was signed out, ` +
      `and every other browser was removed from the account's record.` +
      more(i.coalesced, "password change", "password changes") +
      `\n\nIf this was you, you can ignore this email.` +
      `\n\nIf it was NOT you, someone may have access to this mailbox. Secure your email account first, ` +
      `then reset your password again: ${i.forgotPasswordUrl}`,
  };
}
