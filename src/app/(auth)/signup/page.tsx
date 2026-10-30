import { Suspense } from 'react';
import { redirect } from 'next/navigation';

import PageLoading from '@/components/ui/page-loading';
import { isSignUpAllowed } from '@/convex/utils/auth_hardening';

import SignUpForm from './sign-up-form';

export default function SignUpPage() {
  // Locked by default: with one operator on a LAN, account creation is a bootstrap step.
  // This hides the route; the real enforcement is Better-Auth's server-side `disableSignUp`,
  // which rejects /sign-up/email even if someone posts to it directly.
  if (!isSignUpAllowed(process.env)) redirect('/signin');

  return (
    <Suspense fallback={<PageLoading ariaLabel="Loading sign up form" message="Loading" />}>
      <SignUpForm />
    </Suspense>
  );
}
