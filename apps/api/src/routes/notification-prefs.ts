/**
 * Per-user notification email preferences (M2.3c). GET is a session read
 * (defaults when the user has no row — absent row means defaults). PUT runs the
 * mutating pipeline WITHOUT requireVerifiedEmail: an unverified user must still
 * be able to opt out (same reasoning as mark-read / logout). Both scope to
 * session.userId — the IDOR boundary is in the SQL, never a client field.
 */
import { runMutatingPipeline, readCurrentSession } from "../auth/pipeline";
import { withClient } from "../db/client";
import { errorResponse } from "../http/errors";

import { DEFAULT_NOTIFICATION_PREFS, NotificationPrefsInput } from "@thinkersjournal/shared";
import type { NotificationPrefs } from "@thinkersjournal/shared";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface PrefsRow {
  masterEnabled: boolean; direct: string; reactions: string; follows: string;
}

export async function handleGetNotificationPrefs(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const session = await readCurrentSession(env, request, () => errorResponse("LOGIN_REQUIRED", 401));
  if (session instanceof Response) return session;

  const prefs = await withClient(env.HYPERDRIVE_FRESH, ctx, async (c) => {
    const { rows } = await c.query<PrefsRow>(
      `SELECT master_enabled AS "masterEnabled", direct, reactions, follows
         FROM notification_prefs WHERE user_id = $1`,
      [session.userId],
    );
    return rows[0] ?? null;
  });
  return json((prefs ?? DEFAULT_NOTIFICATION_PREFS) as NotificationPrefs);
}

export async function handlePutNotificationPrefs(
  request: Request, env: Env, ctx: ExecutionContext,
): Promise<Response> {
  const result = await runMutatingPipeline(request, env, ctx, { requireVerifiedEmail: false });
  if (result instanceof Response) return result;
  const { userId } = result.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }
  const parsed = NotificationPrefsInput.safeParse(body);
  if (!parsed.success) {
    return errorResponse("INVALID_INPUT", 400, { fields: ["masterEnabled", "direct", "reactions", "follows"] });
  }
  const p = parsed.data;

  await withClient(env.HYPERDRIVE_FRESH, ctx, (c) =>
    c.query(
      `INSERT INTO notification_prefs (user_id, master_enabled, direct, reactions, follows, updated_at)
       VALUES ($1,$2,$3::notification_channel,$4::notification_channel,$5::notification_channel, now())
       ON CONFLICT (user_id) DO UPDATE
         SET master_enabled = EXCLUDED.master_enabled,
             direct = EXCLUDED.direct, reactions = EXCLUDED.reactions,
             follows = EXCLUDED.follows, updated_at = now()`,
      [userId, p.masterEnabled, p.direct, p.reactions, p.follows],
    ),
  );
  return json(p);
}
