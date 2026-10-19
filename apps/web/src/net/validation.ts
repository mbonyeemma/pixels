import { EMAIL_REGEX, USERNAME_REGEX } from '@pixels/shared';

/** Returns a human-friendly problem description, or null when the value is acceptable. */
export function validateUsername(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return 'Choose a username.';
  if (v.length < 3) return 'Use at least 3 characters.';
  if (v.length > 16) return 'Use at most 16 characters.';
  if (!USERNAME_REGEX.test(v)) return 'Only letters, numbers and underscores (no spaces).';
  return null;
}

export function validateEmail(raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return 'Enter your email address.';
  if (v.length > 120) return 'That email address is too long.';
  if (!EMAIL_REGEX.test(v)) return 'Enter a valid email like you@example.com.';
  return null;
}

export interface LoginFieldErrors {
  username: string | null;
  email: string | null;
}

export function validateLogin(username: string, email: string): LoginFieldErrors {
  return { username: validateUsername(username), email: validateEmail(email) };
}

export const isLoginValid = (e: LoginFieldErrors): boolean => e.username === null && e.email === null;
