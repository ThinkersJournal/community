import { z } from 'zod';

export const SignupInput = z.object({
  email: z.email(),
  password: z.string().min(12),
  turnstileToken: z.string().min(1),
});

export const LoginInput = z.object({
  email: z.email(),
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
