import { Suspense } from 'react';

import PageLoading from '@/components/ui/page-loading';
import { isSignUpAllowed } from '@/convex/utils/auth_hardening';

import SignInForm from './sign-in-form';

export default function SignInPage() {
  return (
    <Suspense fallback={<PageLoading ariaLabel="Loading sign in form" message="Loading" />}>
      <SignInForm signupAllowed={isSignUpAllowed(process.env)} />
    </Suspense>
  );
}
