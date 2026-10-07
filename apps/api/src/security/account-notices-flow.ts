/**
 * What login, signup and a completed reset do AFTER their response is built,
 * inside one `ctx.waitUntil` (security-alerting spec §4.1 "The flow on login").
 * Never on a failed login, never on the response path, and never throws: every
 * failure is logged and the request it rides is already answered.
 *
 * There is no site-wide limiter anywhere in this flow (F1).
 *
 * ⚠️ NEVER LOGS a user id, an address, a device token or a key: only the kind,
 * the end state and an error's NAME.
 */
import {
  deviceHashes,
  isNewSignIn,
  logSecurityEvent,
  noticeNotBefore,
  resolveDeviceKeys,
  type AccountNoticeKind,
} from "@thinkersjournal/shared";

import { logNoticeEnd } from "../durable-objects/UserSecurityDO";

import { sendNotice, type NoticeFacts, type NoticeSendResult } from "./account-notice-send";

import type { NoticeEvent } from "./user-devices";

type Ctx = Pick<ExecutionContext, "waitUntil">;

export interface SignInFacts {
  readonly userId: string;
  /** The browser's device token: the one it sent, or the one minted on this response. */
  readonly token: string;
  readonly country: string | null;
  readonly nowMs: number;
}

/** A uniform draw in [0, 1) from the platform CSPRNG: the wave's spread (§4.4). */
function uniform(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** Login and signup. Signup records its browser silently: the ONE silent path (§4.1). */
export async function afterSignIn(
  env: Env,
  ctx: Ctx,
  mode: "login" | "signup",
  s: SignInFacts,
  random: () => number = uniform,
): Promise<void> {
  try {
    // No key: device notices are disabled, silently (N5). PM ruling I-3: no log
    // line per sign-in; the operator hears through the ledger's ONE config_fault
    // a day (alarm step 6), and PR 2's deploy gate sets the key first.
    const keys = resolveDeviceKeys(env);
    if (keys === null) return;
    const stub = env.USER_SECURITY.getByName(s.userId);
    const record = await stub.recordDevice(await deviceHashes(keys, s.userId, s.token), s.nowMs, mode);
    if (mode === "signup" || !isNewSignIn(record)) return;
    const event = { atMs: s.nowMs, country: s.country, listWasEmpty: record.listWasEmpty };
    await notify(env, ctx, s.userId, "new_sign_in", event, noticeNotBefore(record, s.nowMs, random));
  } catch (err) {
    console.error("account-notice: sign-in follow-up failed", err instanceof Error ? err.name : "threw");
  }
}

/**
 * A completed reset, on BOTH 200 paths. `token` is null on the barred path,
 * which mints no device cookie and forgets every browser (§4.1 m4). The reset
 * notice does not depend on the key.
 */
export async function afterPasswordReset(
  env: Env,
  ctx: Ctx,
  s: Omit<SignInFacts, "token"> & { readonly token: string | null },
): Promise<void> {
  try {
    const stub = env.USER_SECURITY.getByName(s.userId);
    const keys = resolveDeviceKeys(env);
    if (s.token === null) await stub.forgetDevices();
    else if (keys !== null) await stub.recordDevice(await deviceHashes(keys, s.userId, s.token), s.nowMs, "reset");
    await notify(env, ctx, s.userId, "password_reset", { atMs: s.nowMs, country: s.country, listWasEmpty: false }, s.nowMs);
  } catch (err) {
    console.error("account-notice: reset follow-up failed", err instanceof Error ? err.name : "threw");
  }
}

/**
 * ⚠️ CR-1 (PM): once `claimNotice` answered "now", the notice (and every sign-in
 * folded into it) is held by this call and by its `claimed_notice` row. A throw
 * anywhere in the send — the address lookup's `client.connect()` included — must
 * not drop it: it is "transient", and `settleClaim` folds it back into `retrying`.
 */
async function sendOrTransient(env: Env, ctx: Ctx, userId: string, facts: NoticeFacts): Promise<NoticeSendResult> {
  try {
    return await sendNotice(env, ctx, userId, facts);
  } catch (err) {
    logSecurityEvent({ kind: "alerting_fault", route: "account-notice", reason: "notice_send_threw", ip: null });
    console.error("account-notice: send threw; requeued", err instanceof Error ? err.name : "threw");
    return "transient";
  }
}

/** Flag off: one log line, and nothing is claimed (§4.1 step 4). Otherwise claim, then send or leave it deferred. */
async function notify(
  env: Env,
  ctx: Ctx,
  userId: string,
  kind: AccountNoticeKind,
  event: NoticeEvent,
  notBeforeMs: number,
): Promise<void> {
  if (env.ACCOUNT_NOTICES_ENABLED !== "1") {
    console.warn(`account-notice: would_send ${kind}`);
    return;
  }
  const stub = env.USER_SECURITY.getByName(userId);
  const claim = await stub.claimNotice(kind, event, event.atMs, notBeforeMs);
  if (claim.send === "deferred") return; // UserSecurityDO's alarm sends it (§4.4)
  const facts: NoticeFacts = { kind, atMs: event.atMs, country: event.country, coalesced: claim.coalesced, listWasEmpty: event.listWasEmpty };
  const result = await sendOrTransient(env, ctx, userId, facts);
  // R2-3: the claim is already on disk; this clears it, or turns it into a retry
  // (P-5, CR-1). If this call is lost, the alarm recovers the claim. Review M-4:
  // an end state is logged only by the call that took the claim, so a claim the
  // alarm already recovered is never reported twice.
  const took = await stub.settleClaim(claim.claimId, result, Date.now());
  if (!took) return;
  if (result === "gone") {
    logNoticeEnd("dropped_account_gone", kind);
  } else if (result === "permanent") {
    logNoticeEnd("dropped_permanent_refusal", kind);
    await env.SECURITY_LEDGER.getByName("ledger").noticeDropped("dropped_permanent_refusal");
  }
}
