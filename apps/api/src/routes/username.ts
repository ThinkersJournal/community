/**
 * USER-CHOSEN HANDLES. A handle is picked ONCE and is then immutable — that
 * keeps profile URLs (`/@handle`) durable without rename→301/handle-history/SEO
 * complexity. Uniqueness and immutability are enforced against the DB, not by a
 * pre-check (a transaction-mode pooler makes check-then-act a race): we attempt
 * the write and translate the constraint outcome into the wire envelope.
 */
import { readCurrentSession, runMutatingPipeline } from "../auth/pipeline";
import { withClient } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { errorResponse } from "../http/errors";

import { ChooseUsernameInput } from "@thinkersjournal/shared";

import type { Me } from "@thinkersjournal/shared";

/**
 * Handles that would let an account impersonate the platform or a role. Route
 * collisions are NOT the concern (handles live under `/@`); impersonation is.
 * All entries are already lowercase — the input is lowercased before this check.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin", "administrator", "support", "help", "official", "staff", "team",
  "moderator", "mod", "root", "system", "security", "abuse", "billing",
  "thinkersjournal", "thinkers_journal", "tj", "api", "www", "mail",
  "about", "login", "logout", "signup", "settings", "me", "feed", "authors",
]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleChooseUsername(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: true });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const parsed = ChooseUsernameInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["username"] });
  }
  const { username } = parsed.data;

  if (RESERVED_USERNAMES.has(username)) {
    return errorResponse("INVALID_INPUT", 400, {
      message: "That handle is reserved.",
      fields: ["username"],
    });
  }

  try {
    return await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
      // Immutable: only flip when it has NOT already been chosen. The WHERE guard
      // makes a second attempt a no-op we can distinguish from "wrote it".
      const { rowCount } = await c.query(
        `UPDATE profiles
            SET username = $2, username_chosen = true
          WHERE user_id = $1 AND username_chosen = false`,
        [userId, username],
      );
      if (rowCount === 0) {
        // Either already chosen (immutable) — the only reason the guard fails,
        // since the row always exists for a session user.
        return errorResponse("USERNAME_ALREADY_SET", 409);
      }
      return json({ userId, username, usernameChosen: true } satisfies Me);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return errorResponse("USERNAME_TAKEN", 409);
    throw err;
  }
}

export async function handleGetMe(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () =>
    errorResponse("LOGIN_REQUIRED", 401),
  );
  if (session instanceof Response) return session;

  const ctx = _ctx;
  const me = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<{ userId: string; username: string; usernameChosen: boolean }>(
      `SELECT user_id AS "userId", username, username_chosen AS "usernameChosen"
         FROM profiles WHERE user_id = $1`,
      [session.userId],
    );
    return rows[0] ?? null;
  });
  if (me === null) return errorResponse("NOT_FOUND", 404);
  return json(me satisfies Me);
}
