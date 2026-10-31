'use client';

import { LayoutDashboardIcon, MenuIcon } from 'lucide-react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { MenuButton } from '@headlessui/react';
import { usePathname } from 'next/navigation';

import { Avatar } from '@/components/catalyst/avatar';
import { Dropdown } from '@/components/catalyst/dropdown';
import { useNavigationItems, isCurrentPath } from '@/hooks/use-sidebar-navigation';
import { useCurrentPageTitle } from '@/hooks/use-sidebar-navigation';
import { getInitials } from '@/lib/utils/initials';

import AccountDropdownMenu from './auth/account-dropdown-menu';

function CurrentPageIcon(props: React.ComponentProps<'svg'>) {
  const currentPath = usePathname();
  const item = useNavigationItems().find((item) => isCurrentPath(currentPath, item.href));

  if (!item) return <LayoutDashboardIcon {...props} />;

  const Icon = item.icon;
  return <Icon {...props} />;
}

interface MobileHeaderProps {
  onMenuClick: () => void;
}

export default function MobileHeader({ onMenuClick }: MobileHeaderProps) {
  const currentPageTitle = useCurrentPageTitle();

  const user = useQuery(api.auth.getCurrentUserSafe);

  const name = user?.name ?? 'Anonymous';
  const email = user?.email;

  return (
    <div className="bg-emphasized-background border-border/50 fixed top-0 z-40 flex w-full items-center gap-x-6 border-b px-4 py-4 sm:px-6 lg:hidden print:hidden">
      <button type="button" onClick={onMenuClick} className="focus-outline -m-2.5 p-2.5 lg:hidden">
        <span className="sr-only">Open sidebar</span>
        <MenuIcon aria-hidden="true" className="size-6" />
      </button>
      <div className="flex flex-1 items-center gap-2 text-base/6 font-semibold">
        <CurrentPageIcon aria-hidden="true" className="text-primary size-5" />
        {currentPageTitle}
      </div>
      <Dropdown>
        <MenuButton aria-label="Account options" className="focus-outline shrink-0" suppressHydrationWarning>
          <Avatar initials={getInitials(name)} className="size-8 shrink-0" />
        </MenuButton>
        <AccountDropdownMenu fetchedName={name} fetchedEmail={email} />
      </Dropdown>
    </div>
  );
}
