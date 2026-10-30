import { SettingsIcon, LoaderIcon } from 'lucide-react';
import { Unauthenticated, Authenticated, AuthLoading } from 'convex/react';

import { DropdownItem, DropdownMenu, DropdownDivider, DropdownLabel, DropdownHeader } from '@/components/catalyst/dropdown';

import SignInDropdownItem from './sign-in-dropdown-item';
import SignOutDropdownItem from './sign-out-dropdown-item';

interface AccountDropdownMenuProps {
  fetchedName: string | undefined;
  fetchedEmail: string | undefined;
}

export default function AccountDropdownMenu({ fetchedName, fetchedEmail }: AccountDropdownMenuProps) {
  const name = fetchedName ?? 'Anonymous';
  const email = fetchedEmail;

  return (
    <DropdownMenu className="z-[60] min-w-(--button-width)">
      <AuthLoading>
        <DropdownItem onClick={() => {}} disabled>
          <LoaderIcon data-slot="icon" />
          <DropdownLabel>Loading...</DropdownLabel>
        </DropdownItem>
      </AuthLoading>
      <Unauthenticated>
        <DropdownItem href="/settings">
          <SettingsIcon data-slot="icon" />
          <DropdownLabel>Settings</DropdownLabel>
        </DropdownItem>
        <DropdownDivider />
        <SignInDropdownItem />
      </Unauthenticated>
      <Authenticated>
        <DropdownHeader>
          <div className="pr-6">
            <div className="text-xs text-stone-500 dark:text-stone-400">Signed in as {name}</div>
            <div className="text-sm/7 font-semibold text-stone-800 dark:text-white">{email}</div>
          </div>
        </DropdownHeader>
        <DropdownDivider />
        <DropdownItem href="/settings">
          <SettingsIcon data-slot="icon" />
          <DropdownLabel>Settings</DropdownLabel>
        </DropdownItem>
        <DropdownDivider />
        <SignOutDropdownItem />
      </Authenticated>
    </DropdownMenu>
  );
}
