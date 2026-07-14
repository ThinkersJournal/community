import { describe, expect, it } from 'vitest';
import { SignupInput, SESSION_COOKIE_NAME, COOKIE_DOMAIN } from '../src/index';

describe('cookie constants', () => {
  it('has the exact session cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('tj_session');
  });

  it('has the exact cookie domain', () => {
    expect(COOKIE_DOMAIN).toBe('.thinkersjournal.com');
  });
});

describe('SignupInput', () => {
  const validPayload = {
    email: 'reader@example.com',
    password: 'correct-horse-battery',
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
});
