import MainArea from '@/components/layout/main-area';
import { api } from '@/convex/_generated/api';
import { preloadAuthQuery } from '@/lib/auth-server';

import CompareView from './components/compare-view';

export default async function ComparePage() {
  const preloadedPlans = await preloadAuthQuery(api.plans.listPlans, {});

  return (
    <MainArea hasSecondaryColumn={false}>
      <CompareView preloadedPlans={preloadedPlans} />
    </MainArea>
  );
}
