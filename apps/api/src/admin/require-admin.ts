/**
 * The admin gate. Returns an `AdminIdentity`, or a `Response` the caller must
 * return unchanged — the same shape as `runMutatingPipeline`.
 *
 * ⚠️ FOR FUTURE MUTATING ADMIN ROUTES (module 2b): admin routes do NOT run
 * `runMutatingPipeline`, because that pipeline authenticates a MEMBER SESSION
 * and admins are Access principals. The first non-GET admin route must
 * therefore be added to `PIPELINE_EXEMPT` in test/route-protection.test.ts with
 * a written justification — and it MUST also call `checkOrigin` inline, exactly
 * as signup and login do. Cloudflare injects the Access header from the
 * `CF_Authorization` COOKIE, so a cross-site form post from a logged-in
 * moderator's browser WOULD carry a valid Access assertion. Access proves WHO;
 * it does not prove the request was intended.
 */
import { errorResponse } from "../http/errors";

import { verifyAccessJwt, type AdminIdentity } from "./access-jwt";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

export async function requireAdmin(request: Request, env: Env): Promise<AdminIdentity | Response> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token === null || token === "") return errorResponse("ADMIN_REQUIRED", 401);

  const identity = await verifyAccessJwt(token, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
  // ⚠️ One code and one status for every failure — absent, malformed, expired,
  // wrong audience. A distinguishable rejection tells an attacker which half of
  // the credential to keep working on.
  if (identity === null) return errorResponse("ADMIN_REQUIRED", 401);

  return identity;
}
