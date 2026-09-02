/**
 * THE API ERROR ENVELOPE — a WIRE CONTRACT shared by the `api` Worker (which
 * emits it) and the `web` Worker (which branches on it).
 *
 * ⚠️ EVERY non-2xx api response body is `{ code, message?, fields?, suggestions? }`
 * with `content-type: application/json`. Success bodies are per-route and are
 * NOT covered by this type — `POST /auth/logout` still answers 200 with an
 * empty body and `GET /health` still answers "ok".
 *
 * ⚠️ THE `code` STRINGS ARE THE CONTRACT, NOT THE `message`. `web` keys off
 * `code`; renaming one is a breaking change to both Workers at once. `message`
 * is optional, human-facing, and must NEVER be relied on programmatically —
 * and must never carry a submitted value (one of them is a password).
 *
 * This union is declared in ONE place for the same reason
 * apps/api/src/auth/encoding.ts exists: copies that must agree exactly are
 * copies that drift. Codes introduced by later M1 tasks are listed here from
 * the start so the union has a single home rather than five small edits.
 */
export type ApiErrorCode =
  // --- request shape -------------------------------------------------------
  | "INVALID_JSON"           // 400 — the body was not JSON at all
  | "INVALID_INPUT"          // 400 — zod rejected it; `fields` names the paths
  | "INVALID_TOKEN"          // 400 — a verification token is unknown/expired/used
  | "CANNOT_FOLLOW_SELF"     // 400 — a user cannot follow themselves (M2.1)
  | "INVALID_REACTION_KIND"  // 400 — kind not in the four-tone set (M2.2)
  | "CANNOT_BLOCK_SELF"      // 400 — a user cannot block themselves (M4)
  | "INVALID_REPORT_TARGET"  // 400 — zero or both of postId/commentId set (M4)
  // --- authentication ------------------------------------------------------
  | "UNAUTHORIZED"           // 401 — no usable session (pipeline)
  | "LOGIN_REQUIRED"         // 401 — this route needs a session to proceed
  | "INVALID_CREDENTIALS"    // 401 — login only; deliberately not enumerable
  // --- authorization -------------------------------------------------------
  | "FORBIDDEN"              // 403 — origin/CSRF/Turnstile rejection
  | "EMAIL_NOT_VERIFIED"     // 403 — the soft gate
  | "ALREADY_VERIFIED"       // 409 — resend-verification on a verified account (T10)
  | "QUOTA_EXCEEDED"         // 403 — per-user media quota (T8)
  | "BLOCKED"                // 403 — actor is blocked by the interaction's target (M4)
  // --- resources -----------------------------------------------------------
  | "NOT_FOUND"              // 404 — no such route, or no such visible resource
  | "EMAIL_TAKEN"            // 409 — a VERIFIED duplicate at signup
  | "SLUG_TAKEN"             // 409 — could not place a unique slug (T9)
  | "ALREADY_BLOCKED"        // 409 — reserved for future use; block is idempotent (M4)
  | "NOT_BLOCKED"            // 404 — unblock of a pair that is not blocked (M4)
  // USERNAME_TAKEN is now also signup's collision code (handle-at-signup Task
  // 3) — no longer M2.1-only. USERNAME_REQUIRED/USERNAME_ALREADY_SET, the old
  // post-signup "choose a handle" flow's codes, are RETIRED (handle-at-signup
  // Task 4): the handle is chosen once, at signup, with no separate step to
  // gate or re-choose.
  | "USERNAME_TAKEN"         // 409 — the requested handle is already in use
  | "COMMENT_NOT_FOUND"      // 404 — no such visible comment / parent (M2.2)
  | "COMMENT_DELETED"        // 409 — the target comment is tombstoned (M2.2)
  | "COMMENT_DEPTH_EXCEEDED" // 409 — reply would exceed the depth-8 cap (M2.2)
  // --- payloads ------------------------------------------------------------
  | "PAYLOAD_TOO_LARGE"      // 413 — over the streaming size cap (T8)
  | "UNSUPPORTED_MEDIA_TYPE" // 415 — failed the magic-byte allowlist (T7/T8)
  // --- limits --------------------------------------------------------------
  | "RATE_LIMITED";          // 429

export interface ApiErrorBody {
  code: ApiErrorCode;
  /** Human-facing only. Never branch on it; never put a submitted value in it. */
  message?: string;
  /** For INVALID_INPUT: the offending FIELD NAMES only — never their values. */
  fields?: string[];
  /** For USERNAME_TAKEN: a few available handle suggestions. Advisory; never branch on it. */
  suggestions?: string[];
}

/** Narrow an unknown parsed body to the envelope. Structural, not exhaustive. */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
  );
}
