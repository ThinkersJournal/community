import { z } from 'zod';

import { USERNAME_PATTERN } from './social';

/**
 * An email address, NORMALIZED TO LOWERCASE.
 *
 * ⚠️ THE `.toLowerCase()` IS A SECURITY CONTROL, not cosmetics. `users.email`
 * is `citext`, so `WHERE email = $1` matches case-INsensitively — but the
 * auth routes build their rate-limiter keys out of the PARSED email
 * (`${ip}:${email}` AND `email:${email}` — see src/routes/login.ts and
 * src/routes/signup.ts in apps/api). Without normalization those disagree with
 * the lookup: `victim@example.com` and `Victim@example.com` resolve to the SAME
 * user row but DIFFERENT limiter buckets, so an attacker case-rotates the
 * address (~2^16 variants for a typical address) and harvests 10 attempts PER
 * VARIANT — turning LOGIN_LIMITER's 10/60s ceiling into ~650k/60s against one
 * account and nullifying the only brute-force defense on the route. Note this
 * bypass defeats BOTH buckets at once: they are both keyed on this value, so
 * the email-only ceiling is no more immune to case-rotation than the per-IP one.
 *
 * Normalizing HERE (at the schema) rather than at each call site is what makes
 * the key and the citext lookup agree BY CONSTRUCTION for every current and
 * future consumer — a route that forgets to lowercase cannot reintroduce the
 * bypass, because the parsed value is already canonical. It also canonicalizes
 * what signup STORES, which is consistent with the citext column choice.
 *
 * Order is deliberate: `z.email()` validates first (its check is
 * case-insensitive, so nothing valid is rejected), then the value is
 * lowercased via `.overwrite(normalizeEmail)`. Verified against the installed
 * zod 4.6.5.
 */

/**
 * THE email normaliser. `NormalizedEmail` applies it (so signup, login and
 * forgot-password all store and look up its output), and the reserved-email
 * hash (apps/api/src/auth/reserved-email.ts, account-legal-hold spec §4a)
 * hashes its output. One function, so the two can never disagree about which
 * addresses are "the same". Identical to the zod 4.6.5 `toLowerCase()` it
 * replaces, which is `_overwrite((input) => input.toLowerCase())`.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

const NormalizedEmail = z.email().overwrite(normalizeEmail);

export const SignupInput = z.object({
  email: NormalizedEmail,
  password: z.string().min(12),
  // Trim + lowercase BEFORE the pattern check so "  Ada  " → "ada" — the
  // handle is chosen here, at signup, and nowhere else (the old post-signup
  // "choose a handle" flow is gone; see docs/superpowers/specs/
  // 2026-08-13-handle-at-signup-design.md).
  username: z.string().trim().toLowerCase().regex(USERNAME_PATTERN),
  turnstileToken: z.string().min(1),
});

export const LoginInput = z.object({
  email: NormalizedEmail,
  password: z.string().min(1),
});

/**
 * `POST /auth/forgot-password` (#70) — requests a reset link. Deliberately NO
 * password field: this is the "I forgot it" entry point.
 */
export const ForgotPasswordInput = z.object({
  email: NormalizedEmail,
  turnstileToken: z.string().min(1),
});

/**
 * `POST /auth/reset-password` (#70) — redeems a reset token for a new
 * password. Same `min(12)` floor as `SignupInput.password` — a reset must
 * not let someone downgrade to a weaker password than signup would accept.
 */
export const ResetPasswordInput = z.object({
  token: z.string().min(1),
  password: z.string().min(12),
});

/** Server-side session record stored alongside the session cookie. */
export type SessionData = {
  userId: string;
  roles: string[];
  securityEpoch: number;
  csrfSecret: string;
  createdAt: number;
};
