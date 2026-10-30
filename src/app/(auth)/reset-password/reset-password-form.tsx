'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import AppLogo from '@/components/app-logo';
import { authClient } from '@/lib/auth-client';
import ErrorMessageCard from '@/components/ui/error-message-card';

import PasswordInput from '../components/password-input';

/**
 * Consumes a break-glass reset token (P5.3).
 *
 * The token comes from the link the auth server wrote to the container log. Better-Auth
 * validates it, sets the password and deletes the token, so a second use fails; the server
 * config sets a 15-minute expiry and revokes other sessions after the reset.
 */
export default function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isReset, setIsReset] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;

    const newPassword = String(new FormData(event.currentTarget).get('password') ?? '');

    await authClient.resetPassword(
      { newPassword, token },
      {
        onRequest() {
          setErrorMessage(null);
          setIsLoading(true);
        },
        onSuccess() {
          setIsLoading(false);
          setIsReset(true);
        },
        onError: (ctx) => {
          setIsLoading(false);
          setErrorMessage(ctx.error.message);
        },
      }
    );
  };

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md">
          <AppLogo className="mx-auto h-10 w-auto" />
          <h2 className="mt-6 text-center text-2xl/9 font-bold tracking-tight text-stone-900 dark:text-white">Choose a new password</h2>
        </div>

        <div className="mt-10 sm:mx-auto sm:w-full sm:max-w-[480px]">
          <div className="border-border/25 from-emphasized-background to-background border-y bg-gradient-to-bl px-6 py-12 shadow-sm sm:rounded-lg sm:border sm:px-12 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            {!token ? (
              <div className="space-y-4 text-sm/6 text-stone-700 dark:text-stone-300">
                <p>This link is missing its reset token. It may have been copied incompletely, or the token may have expired.</p>
                <p>
                  <Link
                    href="/forgot-password"
                    className="font-semibold text-rose-600 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
                  >
                    Request a new reset link
                  </Link>
                </p>
              </div>
            ) : isReset ? (
              <div className="space-y-4 text-sm/6 text-stone-700 dark:text-stone-300">
                <p>Your password has been changed, and every other session was signed out.</p>
                <p>
                  <Link
                    href="/signin"
                    className="font-semibold text-rose-600 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
                  >
                    Sign in with the new password
                  </Link>
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} method="POST" className="space-y-6">
                <ErrorMessageCard errorMessage={errorMessage} />
                <PasswordInput passwordType="new" isPasswordReset />
                <div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="flex w-full justify-center rounded-md bg-rose-600 px-3 py-1.5 text-sm/6 font-semibold text-white shadow-xs hover:bg-rose-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-rose-500 dark:shadow-none dark:hover:bg-rose-400 dark:focus-visible:outline-rose-500"
                  >
                    {isLoading ? 'Saving...' : 'Set new password'}
                  </button>
                </div>
                <p className="text-sm/6 text-stone-500 dark:text-stone-400">
                  The link works once. If it has expired,{' '}
                  <Link
                    href="/forgot-password"
                    className="font-semibold text-rose-600 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
                  >
                    request a new one
                  </Link>
                  .
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
