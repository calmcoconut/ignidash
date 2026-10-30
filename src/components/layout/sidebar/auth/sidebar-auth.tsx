'use client';

import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { MenuButton } from '@headlessui/react';

import { Avatar } from '@/components/catalyst/avatar';
import { Dropdown } from '@/components/catalyst/dropdown';
import SidebarText from '@/components/layout/sidebar/sidebar-text';
import { getInitials } from '@/lib/utils/initials';

import AccountDropdownMenu from './account-dropdown-menu';

export default function SidebarAuth() {
  const user = useQuery(api.auth.getCurrentUserSafe);

  const name = user?.name ?? 'Anonymous';
  const email = user?.email;

  return (
    <Dropdown>
      <MenuButton
        aria-label="Account options"
        className="hover:bg-background border-border/50 focus-visible:ring-primary flex w-full items-center border-t py-3 pl-4 text-base/6 font-semibold focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        suppressHydrationWarning
      >
        <Avatar initials={getInitials(name)} className="size-8 shrink-0" />
        <SidebarText className="ml-2" aria-hidden="true">
          {name}
        </SidebarText>
      </MenuButton>
      <AccountDropdownMenu fetchedName={name} fetchedEmail={email} />
    </Dropdown>
  );
}
