'use client';

import { useState } from 'react';
import Link from 'next/link';

import AppLogo from '@/components/app-logo';
import { authClient } from '@/lib/auth-client';
import ErrorMessageCard from '@/components/ui/error-message-card';

import EmailInput from '../components/email-input';

/**
 * Requests a password-reset link.
 *
 * There is no mail transport on a self-hosted deployment (P5.3), so the auth server writes the
 * reset link to the container's stderr instead. The success panel tells the operator where to
 * find it rather than pretending an email was sent.
 */
export default function ForgotPasswordForm() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const email = String(new FormData(event.currentTarget).get('email') ?? '');

    await authClient.requestPasswordReset(
      { email, redirectTo: `${window.location.origin}/reset-password` },
      {
        onRequest() {
          setErrorMessage(null);
          setIsLoading(true);
        },
        onSuccess() {
          setIsLoading(false);
          setIsSubmitted(true);
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
          <h2 className="mt-6 text-center text-2xl/9 font-bold tracking-tight text-stone-900 dark:text-white">Reset your password</h2>
        </div>

        <div className="mt-10 sm:mx-auto sm:w-full sm:max-w-[480px]">
          <div className="border-border/25 from-emphasized-background to-background border-y bg-gradient-to-bl px-6 py-12 shadow-sm sm:rounded-lg sm:border sm:px-12 dark:shadow-none dark:outline dark:-outline-offset-1 dark:outline-white/10">
            {isSubmitted ? (
              <div className="space-y-4 text-sm/6 text-stone-700 dark:text-stone-300">
                <p>If an account exists for that address, a reset link was written to this deployment&apos;s log.</p>
                <p>
                  Read it on the host and open it within 15 minutes:
                  <span className="mt-2 block rounded-md bg-stone-100 px-3 py-2 font-mono text-xs text-stone-800 dark:bg-white/5 dark:text-stone-200">
                    docker logs ignidash 2&gt;&amp;1 | grep ignidash-auth
                  </span>
                </p>
                <p>The link works once, and it is a credential: keep it out of chat, tickets and screenshots.</p>
                <p>
                  <Link
                    href="/signin"
                    className="font-semibold text-rose-600 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
                  >
                    Back to sign in
                  </Link>
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} method="POST" className="space-y-6">
                <ErrorMessageCard errorMessage={errorMessage} />
                <EmailInput errorMessage={null} />
                <div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="flex w-full justify-center rounded-md bg-rose-600 px-3 py-1.5 text-sm/6 font-semibold text-white shadow-xs hover:bg-rose-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-rose-500 dark:shadow-none dark:hover:bg-rose-400 dark:focus-visible:outline-rose-500"
                  >
                    {isLoading ? 'Requesting...' : 'Request reset link'}
                  </button>
                </div>
                <p className="text-center text-sm/6 text-stone-500 dark:text-stone-400">
                  <Link
                    href="/signin"
                    className="font-semibold text-rose-600 hover:text-rose-500 dark:text-rose-400 dark:hover:text-rose-300"
                  >
                    Back to sign in
                  </Link>
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
