/**
 * THE VIEWER'S OWN PROFILE STATE. Handle selection itself now happens ONCE, at
 * signup (see apps/api/src/routes/signup.ts) — there is no more post-signup
 * "choose a handle" flow, so this module is left with only `GET /profile/me`.
 */
import { readCurrentSession } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import type { Me } from "@thinkersjournal/shared";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
    const { rows } = await c.query<{ userId: string; username: string }>(
      `SELECT user_id AS "userId", username
         FROM profiles WHERE user_id = $1`,
      [session.userId],
    );
    return rows[0] ?? null;
  });
  if (me === null) return errorResponse("NOT_FOUND", 404);
  return json(me satisfies Me);
}
