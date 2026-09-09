/**
 * The Access-gated admin surface (M4 2a).
 *
 * `GET /admin/whoami` is deliberately the whole of 2a's HTTP surface: it proves
 * the gate end to end — JWKS fetch, signature check, issuer/audience/expiry —
 * without inventing a feature the queue module has not designed yet.
 */
import { requireAdmin } from "../admin/require-admin";
import { withClient } from "../db/client";
import { listOpenQueue } from "../moderation/queue";

export async function handleAdminWhoami(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  return new Response(JSON.stringify({ email: admin.email, sub: admin.sub }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The moderation review queue. GET, so it does not touch the mutating pipeline.
 *
 * ⚠️ `listOpenQueue` reads HIDDEN rows by design. The gate below is the whole
 * of what keeps that safe — see the property stated in src/moderation/queue.ts.
 */
export async function handleAdminQueue(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const items = await withClient(env.HYPERDRIVE_FRESH, ctx, (c) => listOpenQueue(c));

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
