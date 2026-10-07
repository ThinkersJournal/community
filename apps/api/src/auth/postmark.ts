/**
 * The generic Postmark transport (M2.3c). Extracted from email-verify.ts so both
 * the verification email (stream "outbound") and notification email (stream
 * "broadcast") share ONE sender with ONE log discipline.
 *
 * NEVER THROWS — a failed send must not fail its caller. Returns true ONLY on a
 * confirmed accept (2xx AND ErrorCode 0); false on every failure, so the outbox
 * drain can leave emailed_at NULL and retry.
 *
 * A 10s request timeout (`AbortSignal.timeout`) bounds a hung Postmark request
 * so it cannot keep an outbox-drain pass alive past its single-flight lease (see
 * notifications/email-drain.ts) — the resulting AbortError is just another throw
 * the outer try/catch turns into `false`, so the row stays unsent and retries.
 *
 * ⚠️ NEVER logs `to`, subject, body, or any header value — those can carry the
 * recipient address and (for notifications) an unsubscribe token. Logs only
 * status / ErrorCode / Message, exactly as the verification send always has.
 */
import type { PostmarkOutcome } from "@thinkersjournal/shared";

interface PostmarkResponse {
  ErrorCode?: number;
  Message?: string;
}

export interface PostmarkMessage {
  from: string;
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  stream: string;
  headers?: { Name: string; Value: string }[];
}

/**
 * The body as Postmark's JSON shape, or null. Read on EVERY status: Postmark
 * reports per-recipient refusals (ErrorCode 300, 406) as HTTP 422 WITH a JSON
 * body (security-alerting spec §4.4), and a 401 may carry plain text.
 */
async function readPostmarkBody(res: Response): Promise<PostmarkResponse | null> {
  try {
    const parsed: unknown = JSON.parse(await res.text());
    return typeof parsed === "object" && parsed !== null ? (parsed as PostmarkResponse) : null;
  } catch {
    return null;
  }
}

/**
 * The boolean view, kept for every existing caller: true ONLY on a confirmed
 * accept. See `postmarkSendOutcome` for what a refusal was.
 */
export async function postmarkSend(env: Env, msg: PostmarkMessage): Promise<boolean> {
  return (await postmarkSendOutcome(env, msg)).ok;
}

/**
 * The same send, answering WHAT happened (status and `ErrorCode`), so a deferred
 * account notice can tell a permanent refusal from a transient one
 * (`classifyPostmark`, packages/shared). Never throws.
 *
 * ⚠️ NEVER LOGS `Message` ON A NON-2xx. Postmark's 406 message names the
 * inactive recipient's address; this file never logs a recipient (header).
 */
export async function postmarkSendOutcome(env: Env, msg: PostmarkMessage): Promise<PostmarkOutcome> {
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      // Bounds a hung send so it can't outlive the drain's lease (see the doc).
      signal: AbortSignal.timeout(10_000),
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        From: msg.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.textBody,
        HtmlBody: msg.htmlBody,
        MessageStream: msg.stream,
        ...(msg.headers !== undefined && { Headers: msg.headers }),
      }),
    });

    const body = await readPostmarkBody(res);
    const errorCode = typeof body?.ErrorCode === "number" ? body.ErrorCode : null;
    if (!res.ok) {
      console.error("postmark send failed", {
        status: res.status,
        ErrorCode: errorCode,
        stream: msg.stream,
      });
      return { ok: false, status: res.status, errorCode };
    }
    if (errorCode !== 0) {
      console.error("postmark rejected send", {
        ErrorCode: errorCode,
        Message: body?.Message,
        stream: msg.stream,
      });
      return { ok: false, status: res.status, errorCode };
    }
    return { ok: true };
  } catch (err) {
    console.error("postmark request threw", err);
    return { ok: false, status: null, errorCode: null };
  }
}
