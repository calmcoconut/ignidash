'use client';

import { useMemo } from 'react';
import { type Preloaded, useConvexAuth, Authenticated } from 'convex/react';
import { usePreloadedAuthQuery } from '@convex-dev/better-auth/nextjs/client';
import { api } from '@/convex/_generated/api';

import SuccessNotification from '@/components/ui/success-notification';
import { useSuccessNotification } from '@/hooks/use-success-notification';
import { useAccountsList } from '@/hooks/use-accounts-data';
import PageLoading from '@/components/ui/page-loading';

import ProfileInfoForm from './profile-info-form';
import DataSettingsForm from './data-settings-form';

interface SettingsFormsProps {
  preloadedUser: Preloaded<typeof api.auth.getCurrentUserSafe>;
}

export default function SettingsForms({ preloadedUser }: SettingsFormsProps) {
  const auth = useConvexAuth();
  const isAuthenticated = auth.isAuthenticated;
  const isAuthLoading = auth.isLoading;

  const authData = usePreloadedAuthQuery(preloadedUser);
  const { accounts: accountsData, isLoading: isAccountsDataLoading } = useAccountsList();

  const settingsCapabilities = useMemo(() => {
    const isSignedInWithSocialProvider = accountsData?.some((account) => account.providerId !== 'credential') ?? false;

    return {
      canChangePassword: isAuthenticated && !isSignedInWithSocialProvider,
      canChangeName: isAuthenticated,
    };
  }, [accountsData, isAuthenticated]);

  const { notificationState, showSuccessNotification, dismiss } = useSuccessNotification();

  if (isAccountsDataLoading || isAuthLoading || (isAuthenticated && !authData)) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-prose items-center justify-center px-2 pt-[4.25rem]">
        <PageLoading ariaLabel="Loading settings" message="Loading settings" />
      </main>
    );
  }

  const fetchedName = authData?.name ?? '';

  return (
    <>
      <main className="mx-auto min-h-dvh max-w-prose px-2 pt-[4.25rem] pb-[2.125rem] sm:px-3 lg:px-4">
        <Authenticated>
          <ProfileInfoForm userData={{ fetchedName, ...settingsCapabilities }} showSuccessNotification={showSuccessNotification} />
          <DataSettingsForm showSuccessNotification={showSuccessNotification} />
        </Authenticated>
      </main>
      <SuccessNotification {...notificationState} onDismiss={dismiss} />
    </>
  );
}
