/**
 * The Access-gated admin surface (M4 2a).
 *
 * `GET /admin/whoami` is deliberately the whole of 2a's HTTP surface: it proves
 * the gate end to end — JWKS fetch, signature check, issuer/audience/expiry —
 * without inventing a feature the queue module has not designed yet.
 */
import { requireAdmin } from "../admin/require-admin";

export async function handleAdminWhoami(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  return new Response(JSON.stringify({ email: admin.email, sub: admin.sub }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
