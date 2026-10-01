/**
 * #50 Q2 — what the login page tells a banned or suspended user.
 *
 * The api answers 403 ACCOUNT_BARRED only after the password checked out, so
 * this text is only ever shown to the account's own holder. Anything else
 * returns null and the page keeps its generic "Invalid email or password."
 *
 * The suspension end is rendered in UTC: the server has no idea of the
 * reader's timezone, and a bare local-looking time would be wrong for most.
 */
import { isApiErrorBody } from "@thinkersjournal/shared";

export function barredMessage(body: unknown): string | null {
  if (!isApiErrorBody(body) || body.code !== "ACCOUNT_BARRED") return null;

  const barred = body.barred;
  let base: string;
  if (barred?.kind === "banned") {
    base = "This account has been banned.";
  } else if (barred?.kind === "suspended" && !Number.isNaN(new Date(barred.until).getTime())) {
    base = `This account is suspended until ${new Date(barred.until).toUTCString()}.`;
  } else {
    // A bar we cannot describe is still a bar: say so, and invent nothing.
    base = "This account is currently barred.";
  }

  const reason = typeof barred?.reason === "string" && barred.reason.trim() !== "" ? barred.reason.trim() : null;
  return reason === null ? base : `${base} Reason given by the moderator: ${reason}`;
}
