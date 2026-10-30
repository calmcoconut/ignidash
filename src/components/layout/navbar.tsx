'use client';

import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { LogInIcon, LogOutIcon, LoaderIcon, LayoutDashboardIcon } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { Unauthenticated, Authenticated, AuthLoading } from 'convex/react';

import { authClient } from '@/lib/auth-client';
import {
  Dropdown,
  DropdownButton,
  DropdownItem,
  DropdownMenu,
  DropdownDivider,
  DropdownLabel,
  DropdownHeader,
} from '@/components/catalyst/dropdown';
import { Avatar } from '@/components/catalyst/avatar';
import { Navbar as CatalystNavbar, NavbarItem, NavbarSection, NavbarSpacer, NavbarDivider } from '@/components/catalyst/navbar';
import AppLogo from '@/components/app-logo';
import { useThemeSwitcher } from '@/hooks/use-theme-switcher';
import { getInitials } from '@/lib/utils/initials';

function NavbarModeToggle() {
  const themeSwitcher = useThemeSwitcher();
  if (!themeSwitcher) return null;

  const { newTheme, label, icon: Icon, setTheme } = themeSwitcher;

  return (
    <NavbarItem aria-label={label} onClick={() => setTheme(newTheme)}>
      <Icon data-slot="icon" />
    </NavbarItem>
  );
}

export default function Navbar() {
  const router = useRouter();
  const pathname = usePathname();
  const user = useQuery(api.auth.getCurrentUserSafe);

  const signInUrlWithRedirect = `/signin?redirect=${encodeURIComponent(pathname)}`;

  const name = user?.name ?? 'Anonymous';
  const email = user?.email;

  const signOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push(signInUrlWithRedirect);
        },
      },
    });
  };

  return (
    <CatalystNavbar className="border-border/50 from-emphasized-background to-background fixed top-0 z-40 w-full border-b bg-gradient-to-r shadow-sm">
      <Link href="/" aria-label="Home" className="pl-4">
        <AppLogo className="size-10 shrink-0 sm:size-8" />
      </Link>
      <NavbarDivider className="max-lg:hidden" />
      <NavbarSection className="max-lg:hidden">
        <NavbarItem href="/settings" current={pathname === '/settings'}>
          Settings
        </NavbarItem>
        <NavbarItem href="/help" current={pathname === '/help'}>
          Help
        </NavbarItem>
      </NavbarSection>
      <NavbarSpacer />
      <NavbarSection className="pr-4">
        <NavbarModeToggle />
        <Dropdown>
          <DropdownButton as={NavbarItem} aria-label="Account options">
            <Avatar initials={getInitials(name)} square />
          </DropdownButton>
          <DropdownMenu className="z-[60] min-w-(--button-width)">
            <AuthLoading>
              <DropdownItem onClick={() => {}} disabled>
                <LoaderIcon data-slot="icon" />
                <DropdownLabel>Loading...</DropdownLabel>
              </DropdownItem>
            </AuthLoading>
            <Unauthenticated>
              <DropdownItem href="/dashboard">
                <LayoutDashboardIcon data-slot="icon" />
                <DropdownLabel>Dashboard</DropdownLabel>
              </DropdownItem>
              <DropdownItem href={signInUrlWithRedirect}>
                <LogInIcon data-slot="icon" />
                <DropdownLabel>Sign in</DropdownLabel>
              </DropdownItem>
            </Unauthenticated>
            <Authenticated>
              <DropdownHeader>
                <div className="pr-6">
                  <div className="text-xs text-stone-500 dark:text-stone-400">Signed in as {name}</div>
                  <div className="text-sm/7 font-semibold text-stone-800 dark:text-white">{email}</div>
                </div>
              </DropdownHeader>
              <DropdownDivider />
              <DropdownItem href="/dashboard">
                <LayoutDashboardIcon data-slot="icon" />
                <DropdownLabel>Dashboard</DropdownLabel>
              </DropdownItem>
              <DropdownItem onClick={() => signOut()}>
                <LogOutIcon data-slot="icon" />
                <DropdownLabel>Sign out</DropdownLabel>
              </DropdownItem>
            </Authenticated>
          </DropdownMenu>
        </Dropdown>
      </NavbarSection>
    </CatalystNavbar>
  );
}
