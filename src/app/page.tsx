import { redirect } from 'next/navigation';

import { isSignUpAllowed } from '@/convex/utils/auth_hardening';

export default function Home() {
  // No dead end when signup is locked: a first-time visitor lands on sign-in, and the sign-in
  // page never advertises a signup route that would only redirect them back.
  redirect(isSignUpAllowed(process.env) ? '/signup' : '/signin');
}
