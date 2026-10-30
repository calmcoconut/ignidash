import { betterAuth } from 'better-auth/minimal';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'vitest';

import {
  ALLOW_SIGNUP_ENV_VAR,
  PASSWORD_RESET_LOG_PREFIX,
  PASSWORD_RESET_TTL_MINUTES,
  PASSWORD_RESET_TTL_SECONDS,
  createEmailAndPasswordOptions,
  createSignUpLockHook,
  isSignUpAllowed,
  passwordResetLogLine,
} from './auth_hardening';

const APP_URL = 'http://192.168.1.100:3030';
const EMAIL = 'operator@example.com';
const PASSWORD = 'correct horse battery staple';

interface VerificationRow {
  identifier: string;
  value: string;
  expiresAt: Date | string;
}

/**
 * A real Better-Auth instance over an in-memory adapter.
 *
 * The Convex adapter cannot run here, but every rule under test — the sign-up refusal, the
 * reset token's TTL and its single use — is enforced by Better-Auth's own endpoints from the
 * `emailAndPassword` options this app passes in. So the library behaviour is real; only the
 * storage underneath is a stand-in.
 */
function createTestAuth(overrides: { allowSignUp: boolean; keepSignUpEndpoint?: boolean; write?: (line: string) => void }) {
  const db = { user: [] as unknown[], session: [] as unknown[], account: [] as unknown[], verification: [] as VerificationRow[] };
  const lines: string[] = [];
  const write = overrides.write ?? ((line: string) => lines.push(line));

  const emailAndPassword = createEmailAndPasswordOptions({ allowSignUp: overrides.allowSignUp, appUrl: APP_URL, write });
  // `keepSignUpEndpoint` isolates the database hook from `disableSignUp`, to prove the backstop
  // stops user creation on a provider that skips the email/password guard.
  if (overrides.keepSignUpEndpoint) emailAndPassword.disableSignUp = false;

  const lockHook = createSignUpLockHook(overrides.allowSignUp);

  const auth = betterAuth({
    baseURL: 'http://localhost:3030/api/auth',
    secret: 'test-secret-that-is-long-enough-for-better-auth',
    database: memoryAdapter(db),
    emailAndPassword,
    ...(lockHook ? { databaseHooks: { user: { create: { before: lockHook } } } } : {}),
  });

  return { auth, db, lines };
}

describe('the signup lock', () => {
  it('unlocks only for the exact string "true"', () => {
    expect(isSignUpAllowed({})).toBe(false);
    expect(isSignUpAllowed({ [ALLOW_SIGNUP_ENV_VAR]: '' })).toBe(false);
    expect(isSignUpAllowed({ [ALLOW_SIGNUP_ENV_VAR]: '1' })).toBe(false);
    expect(isSignUpAllowed({ [ALLOW_SIGNUP_ENV_VAR]: 'TRUE' })).toBe(false);
    expect(isSignUpAllowed({ [ALLOW_SIGNUP_ENV_VAR]: 'true ' })).toBe(false);
    expect(isSignUpAllowed({ [ALLOW_SIGNUP_ENV_VAR]: 'true' })).toBe(true);
  });

  it('maps to Better-Auth options, including the 15-minute reset TTL', () => {
    const locked = createEmailAndPasswordOptions({ allowSignUp: false, appUrl: APP_URL, write: () => {} });
    const open = createEmailAndPasswordOptions({ allowSignUp: true, appUrl: APP_URL, write: () => {} });

    expect(locked.disableSignUp).toBe(true);
    expect(open.disableSignUp).toBe(false);
    for (const options of [locked, open]) {
      expect(options.enabled).toBe(true);
      expect(options.resetPasswordTokenExpiresIn).toBe(PASSWORD_RESET_TTL_SECONDS);
      expect(PASSWORD_RESET_TTL_SECONDS).toBe(15 * 60);
      expect(PASSWORD_RESET_TTL_MINUTES).toBe(15);
      expect(options.revokeSessionsOnPasswordReset).toBe(true);
    }
  });

  it('is installed as a user-creation hook only while locked', async () => {
    expect(createSignUpLockHook(true)).toBeUndefined();

    const hook = createSignUpLockHook(false);
    expect(hook).toBeDefined();
    await expect(hook!()).resolves.toBe(false);
  });

  it('rejects sign-up on the server while locked, and accepts it while open', async () => {
    const locked = createTestAuth({ allowSignUp: false });
    await expect(locked.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } })).rejects.toThrow(
      /sign up is not enabled/i
    );
    expect(locked.db.user).toHaveLength(0);

    const open = createTestAuth({ allowSignUp: true });
    await open.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } });
    expect(open.db.user).toHaveLength(1);
  });

  it('blocks user creation through the database hook even when the endpoint is open', async () => {
    // Simulates a provider that bypasses `disableSignUp` (e.g. a configured social sign-in).
    const bypass = createTestAuth({ allowSignUp: false, keepSignUpEndpoint: true });

    await expect(bypass.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } })).rejects.toThrow();
    expect(bypass.db.user).toHaveLength(0);
  });
});

describe('the break-glass log line', () => {
  it('is one line carrying the app link, the token once, and the TTL', () => {
    const line = passwordResetLogLine({ email: EMAIL, token: 'tok_abc123', appUrl: APP_URL });

    expect(line.startsWith(PASSWORD_RESET_LOG_PREFIX)).toBe(true);
    expect(line).toContain(EMAIL);
    expect(line).toContain(`${APP_URL}/reset-password?token=tok_abc123`);
    expect(line).toContain(`expires in ${PASSWORD_RESET_TTL_MINUTES} minutes`);
    expect(line).not.toContain('\n');
    expect(line.split('tok_abc123')).toHaveLength(2);
  });

  it('normalises a trailing slash on the app URL', () => {
    const line = passwordResetLogLine({ email: EMAIL, token: 'tok', appUrl: `${APP_URL}/` });

    expect(line).toContain(`${APP_URL}/reset-password?token=tok`);
    expect(line).not.toContain('//reset-password');
  });

  it('writes the line once per request and nothing else', async () => {
    const lines: string[] = [];
    const { auth } = createTestAuth({ allowSignUp: true, write: (line) => lines.push(line) });

    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } });
    const resetLine = await requestReset(auth, lines);

    expect(lines).toHaveLength(1);
    expect(resetLine).toMatch(/^\[ignidash-auth\] password reset for /);
    expect(lines[0]).toBe(resetLine);
  });
});

/** Requests a reset and returns the single captured log line. */
async function requestReset(auth: ReturnType<typeof createTestAuth>['auth'], lines: string[]): Promise<string> {
  await auth.api.requestPasswordReset({ body: { email: EMAIL, redirectTo: `${APP_URL}/reset-password` } });

  expect(lines).toHaveLength(1);
  return lines[0];
}

function tokenFromLine(line: string): string {
  const match = /[?&]token=([^&\s]+)/.exec(line);
  if (!match) throw new Error(`no token in the reset line: ${line}`);
  return match[1];
}

describe('the reset token', () => {
  it('expires 15 minutes after it is issued', async () => {
    const lines: string[] = [];
    const { auth, db } = createTestAuth({ allowSignUp: true, write: (line) => lines.push(line) });
    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } });

    await requestReset(auth, lines);

    const row = db.verification.find((entry) => entry.identifier.startsWith('reset-password:'));
    expect(row).toBeDefined();
    const expiresAt = row!.expiresAt instanceof Date ? row!.expiresAt : new Date(row!.expiresAt);
    const ttlMs = expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(PASSWORD_RESET_TTL_SECONDS * 1000 - 5000);
    expect(ttlMs).toBeLessThanOrEqual(PASSWORD_RESET_TTL_SECONDS * 1000);
  });

  it('works once, and a second use of the same token fails', async () => {
    const lines: string[] = [];
    const { auth } = createTestAuth({ allowSignUp: true, write: (line) => lines.push(line) });
    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } });
    const token = tokenFromLine(await requestReset(auth, lines));

    await auth.api.resetPassword({ body: { newPassword: 'a brand new password', token } });

    await expect(auth.api.resetPassword({ body: { newPassword: 'another password entirely', token } })).rejects.toThrow(/invalid token/i);
  });

  it('refuses an expired token', async () => {
    const lines: string[] = [];
    const { auth, db } = createTestAuth({ allowSignUp: true, write: (line) => lines.push(line) });
    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: 'Operator' } });
    const token = tokenFromLine(await requestReset(auth, lines));

    // Age the stored verification row instead of faking the clock: the check under test is
    // Better-Auth's own `expiresAt < now` comparison.
    const row = db.verification.find((entry) => entry.identifier.startsWith('reset-password:'));
    row!.expiresAt = new Date(Date.now() - 1000);

    await expect(auth.api.resetPassword({ body: { newPassword: 'a brand new password', token } })).rejects.toThrow(/invalid token/i);
  });
});
