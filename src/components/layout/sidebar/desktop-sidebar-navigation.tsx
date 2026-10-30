'use client';

import { useNavigationItems, useSecondaryNavigationItems } from '@/hooks/use-sidebar-navigation';

import SidebarLink from './sidebar-link';
import SidebarText from './sidebar-text';

export default function DesktopSidebarNavigation() {
  const navigation = useNavigationItems();

  return (
    <ul role="list" className="space-y-2">
      {navigation.map(({ name, href, icon: Icon, current, ...other }) => (
        <li key={name}>
          <SidebarLink href={href} current={current} tooltipLabel={name} {...other}>
            <div className="p-2">
              <Icon aria-hidden="true" className="size-6 shrink-0" />
            </div>
            <SidebarText>{name}</SidebarText>
          </SidebarLink>
        </li>
      ))}
    </ul>
  );
}

export function DesktopSidebarSecondaryNavigation() {
  const secondaryNavigation = useSecondaryNavigationItems();

  return (
    <>
      {secondaryNavigation.map(({ name, href, icon: Icon, current }) => (
        <li key={name}>
          <SidebarLink href={href} current={current} tooltipLabel={name}>
            <div className="p-2">
              <Icon aria-hidden="true" className="size-6 shrink-0" />
            </div>
            <SidebarText>{name}</SidebarText>
          </SidebarLink>
        </li>
      ))}
    </>
  );
}
