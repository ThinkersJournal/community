/**
 * The generic Postmark transport (M2.3c). Extracted from email-verify.ts so both
 * the verification email (stream "outbound") and notification email (stream
 * "broadcast") share ONE sender with ONE log discipline.
 *
 * NEVER THROWS — a failed send must not fail its caller. Returns true ONLY on a
 * confirmed accept (2xx AND ErrorCode 0); false on every failure, so the outbox
 * drain can leave emailed_at NULL and retry.
 *
 * ⚠️ NEVER logs `to`, subject, body, or any header value — those can carry the
 * recipient address and (for notifications) an unsubscribe token. Logs only
 * status / ErrorCode / Message, exactly as the verification send always has.
 */
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

export async function postmarkSend(
  env: Env,
  msg: PostmarkMessage,
): Promise<boolean> {
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
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

    if (!res.ok) {
      console.error("postmark send failed", {
        status: res.status,
        stream: msg.stream,
      });
      return false;
    }

    const { ErrorCode, Message } = (await res.json()) as PostmarkResponse;
    if (ErrorCode !== 0) {
      console.error("postmark rejected send", {
        ErrorCode,
        Message,
        stream: msg.stream,
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("postmark request threw", err);
    return false;
  }
}
