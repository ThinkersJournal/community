import { z } from 'zod';

/**
 * An email address, NORMALIZED TO LOWERCASE.
 *
 * ⚠️ THE `.toLowerCase()` IS A SECURITY CONTROL, not cosmetics. `users.email`
 * is `citext`, so `WHERE email = $1` matches case-INsensitively — but the
 * auth routes build their rate-limiter key out of the PARSED email
 * (`${ip}:${email}`, see src/routes/login.ts and src/routes/signup.ts in
 * apps/api). Without normalization those two disagree: `victim@example.com`
 * and `Victim@example.com` resolve to the SAME user row but DIFFERENT limiter
 * buckets, so an attacker case-rotates the address (~2^16 variants for a
 * typical address) and harvests 10 attempts PER VARIANT from a single IP —
 * turning LOGIN_LIMITER's 10/60s ceiling into ~650k/60s against one account
 * and nullifying the only brute-force defense on the route.
 *
 * Normalizing HERE (at the schema) rather than at each call site is what makes
 * the key and the citext lookup agree BY CONSTRUCTION for every current and
 * future consumer — a route that forgets to lowercase cannot reintroduce the
 * bypass, because the parsed value is already canonical. It also canonicalizes
 * what signup STORES, which is consistent with the citext column choice.
 *
 * Order is deliberate: `z.email()` validates first (its check is
 * case-insensitive, so nothing valid is rejected), then the value is
 * lowercased. Verified against the installed zod 4.4.3: `toLowerCase()` is
 * inherited from the string base by `ZodEmail` and rewrites the OUTPUT while
 * leaving format validation intact.
 */
const NormalizedEmail = z.email().toLowerCase();

export const SignupInput = z.object({
  email: NormalizedEmail,
  password: z.string().min(12),
  turnstileToken: z.string().min(1),
});

export const LoginInput = z.object({
  email: NormalizedEmail,
  password: z.string().min(1),
});

/** Server-side session record stored alongside the session cookie. */
export type SessionData = {
  userId: string;
  roles: string[];
  securityEpoch: number;
  csrfSecret: string;
  createdAt: number;
};
