import { describe, expect, it } from 'vitest';
import { SignupInput, LoginInput, SESSION_COOKIE_NAME } from '../src/index';

describe('cookie constants', () => {
  it('has the exact session cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('tj_session');
  });
});

describe('SignupInput', () => {
  const validPayload = {
    email: 'reader@example.com',
    password: 'correct-horse-battery',
    username: 'reader_1',
    turnstileToken: 'a-turnstile-token',
  };

  it('accepts a valid payload', () => {
    const result = SignupInput.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('rejects a password shorter than 12 characters', () => {
    const shortPassword = 'short123456'; // 11 chars, one under the min(12) threshold
    expect(shortPassword.length).toBe(11);
    const result = SignupInput.safeParse({ ...validPayload, password: shortPassword });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email address', () => {
    const result = SignupInput.safeParse({ ...validPayload, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('normalizes a mixed-case email to lowercase', () => {
    const result = SignupInput.safeParse({ ...validPayload, email: 'Reader@Example.COM' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe('reader@example.com');
  });

  it('requires a valid normalized handle', () => {
    const ok = SignupInput.safeParse({
      email: 'A@B.com', password: 'x'.repeat(12), username: '  Ada_1  ', turnstileToken: 't',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.username).toBe('ada_1'); // trimmed + lowercased

    expect(SignupInput.safeParse({ email: 'a@b.com', password: 'x'.repeat(12), username: 'ab', turnstileToken: 't' }).success).toBe(false); // too short
    expect(SignupInput.safeParse({ email: 'a@b.com', password: 'x'.repeat(12), username: 'bad handle', turnstileToken: 't' }).success).toBe(false); // space
  });
});

/**
 * ⚠️ THESE ARE A SECURITY CONTROL, not formatting preference. The auth routes
 * key their rate limiters on the PARSED email (`${ip}:${email}`) while the
 * `users.email` column is citext (case-INsensitive). If these schemas stopped
 * lowercasing, `victim@…` and `Victim@…` would hit one user row through two
 * different limiter buckets — an attacker case-rotates the address and
 * multiplies the brute-force ceiling by the number of variants. See the
 * NormalizedEmail note in ../src/schemas.ts.
 */
describe('email normalization (rate-limiter key / citext agreement)', () => {
  it('LoginInput lowercases a mixed-case email', () => {
    const result = LoginInput.safeParse({ email: 'Victim@Example.COM', password: 'x' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe('victim@example.com');
  });

  it('LoginInput maps every case variant of one address to an identical key', () => {
    const variants = [
      'victim@example.com',
      'Victim@example.com',
      'VICTIM@EXAMPLE.COM',
      'ViCtIm@ExAmPlE.cOm',
    ];

    const parsed = variants.map((email) => {
      const result = LoginInput.safeParse({ email, password: 'x' });
      expect(result.success).toBe(true);
      return result.success ? result.data.email : null;
    });

    // One distinct value across every spelling — i.e. one limiter bucket.
    expect(new Set(parsed).size).toBe(1);
    expect(parsed[0]).toBe('victim@example.com');
  });

  it('LoginInput still rejects an invalid email and an empty password', () => {
    expect(LoginInput.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
    expect(LoginInput.safeParse({ email: 'reader@example.com', password: '' }).success).toBe(false);
  });
});
