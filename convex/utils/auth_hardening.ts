/**
 * Auth hardening for a single-operator, LAN-only instance (parity plan P5.3, decisions D7/F5).
 *
 * One account, reachable only on the LAN: account creation is locked once the operator has
 * created their account, and password recovery works with no mail transport — the reset link
 * is written to the container's stderr, where `docker logs ignidash` on the Unraid console
 * surfaces it.
 *
 * Everything here is pure or takes its side effect as an argument, so the policy is testable
 * without a Convex deployment. The Better-Auth wiring lives in `convex/auth.ts`.
 */

/** Only the exact string `"true"` unlocks account creation. Unset, `""`, `"1"`, `"TRUE"` all lock it. */
export const ALLOW_SIGNUP_ENV_VAR = 'ALLOW_SIGNUP';

/** Better-Auth measures `resetPasswordTokenExpiresIn` in seconds. */
export const PASSWORD_RESET_TTL_SECONDS = 15 * 60;

export const PASSWORD_RESET_TTL_MINUTES = PASSWORD_RESET_TTL_SECONDS / 60;

/** Prefix for the single break-glass log line, so an operator can grep for it. */
export const PASSWORD_RESET_LOG_PREFIX = '[ignidash-auth]';

/** Whether a new account may be created. Locked by default: the operator opts in for bootstrap. */
export function isSignUpAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env[ALLOW_SIGNUP_ENV_VAR] === 'true';
}

export interface PasswordResetLogDetails {
  email: string;
  token: string;
  /** Public app origin, e.g. `http://192.168.1.100:3030`; the link points at this app's page. */
  appUrl: string;
}

/**
 * The break-glass line: the only place the raw token is ever written.
 *
 * The link is built from the app origin rather than Better-Auth's `url` argument on purpose —
 * the operator needs a URL that lands on this app's `/reset-password` page, not on an
 * auth-internal callback path.
 *
 * One line, no newline: log collectors that split on newlines keep the URL intact, and a
 * multi-line token would be easier to leak accidentally.
 */
export function passwordResetLogLine({ email, token, appUrl }: PasswordResetLogDetails): string {
  const base = appUrl.replace(/\/+$/, '');
  return `${PASSWORD_RESET_LOG_PREFIX} password reset for ${email}: ${base}/reset-password?token=${token} (single use, expires in ${PASSWORD_RESET_TTL_MINUTES} minutes)`;
}

/** The subset of Better-Auth's `emailAndPassword` options this app sets. */
export interface EmailAndPasswordOptions {
  enabled: true;
  disableSignUp: boolean;
  resetPasswordTokenExpiresIn: number;
  revokeSessionsOnPasswordReset: true;
  sendResetPassword: (data: { user: { email: string }; url: string; token: string }) => Promise<void>;
}

/**
 * Builds the `emailAndPassword` options.
 *
 * `disableSignUp` is the server-side lock: Better-Auth's `/sign-up/email` endpoint rejects the
 * request itself, so hiding the route is cosmetic. Password *reset* keeps working while signup
 * is disabled, which is what makes the break-glass path usable on a locked instance.
 *
 * `revokeSessionsOnPasswordReset` ends every other session after a reset: with a single
 * operator, a reset is either recovery or "sign out everywhere", and both want the old
 * sessions gone.
 */
export function createEmailAndPasswordOptions(input: {
  allowSignUp: boolean;
  appUrl: string;
  write: (line: string) => void;
}): EmailAndPasswordOptions {
  return {
    enabled: true,
    disableSignUp: !input.allowSignUp,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, token }) {
      input.write(passwordResetLogLine({ email: user.email, token, appUrl: input.appUrl }));
    },
  };
}

/**
 * Backstop for providers that bypass `disableSignUp`: Better-Auth guards only the
 * email/password endpoint, so a configured Google sign-in would otherwise still create an
 * account. Returning `false` from `databaseHooks.user.create.before` stops the insert.
 *
 * `undefined` when signup is allowed, so the hook is not installed at all in that case.
 */
export function createSignUpLockHook(allowSignUp: boolean): (() => Promise<false>) | undefined {
  if (allowSignUp) return undefined;
  return async () => false as const;
}
