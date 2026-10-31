'use client';

import { useState, lazy, Suspense } from 'react';
import { CalculatorIcon, TrendingUpIcon, BanknoteXIcon, HourglassIcon, CalendarClockIcon, ArrowRightLeftIcon } from 'lucide-react';

import IconButton from '@/components/ui/icon-button';
import PageLoading from '@/components/ui/page-loading';
import Drawer from '@/components/ui/drawer';
import ColumnHeader from '@/components/ui/column-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog } from '@/components/catalyst/dialog';
import {
  usePlanName,
  useMarketAssumptionsData,
  useTaxSettingsData,
  useTimelineData,
  useSeppData,
  useConversionsData,
  useAccountsData,
} from '@/hooks/use-convex-data';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { useHasOpenedTaxSettings, useUpdateHasOpenedTaxSettings } from '@/lib/stores/simulator-store';

const ExpectedReturnsDrawer = lazy(() => import('./drawers/expected-returns-drawer'));
const TaxSettingsDrawer = lazy(() => import('./drawers/tax-settings-drawer'));
const TimelineDrawer = lazy(() => import('./drawers/timeline-drawer'));
const SeppDialog = lazy(() => import('./dialogs/sepp-dialog'));
const ConversionDialog = lazy(() => import('./dialogs/conversion-dialog'));

export default function NumbersColumnHeader() {
  const planId = useSelectedPlanId();
  const { name: planName, isLoading: isPlanNameLoading } = usePlanName();

  const [expectedReturnsOpen, setExpectedReturnsOpen] = useState(false);
  const [taxSettingsOpen, setTaxSettingsOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [seppOpen, setSeppOpen] = useState(false);
  const [conversionsOpen, setConversionsOpen] = useState(false);

  const marketAssumptions = useMarketAssumptionsData();
  const taxSettings = useTaxSettingsData();
  const timeline = useTimelineData();
  const { data: sepp } = useSeppData();
  const { data: conversions } = useConversionsData();
  const { data: accounts } = useAccountsData();

  const expectedReturnsTitleComponent = (
    <div className="flex items-center gap-2">
      <TrendingUpIcon className="text-primary size-6 shrink-0" aria-hidden="true" />
      <span>Expected Returns</span>
    </div>
  );
  const taxSettingsTitleComponent = (
    <div className="flex items-center gap-2">
      <BanknoteXIcon className="text-primary size-6 shrink-0" aria-hidden="true" />
      <span>Tax Settings</span>
    </div>
  );
  const timelineTitleComponent = (
    <div className="flex items-center gap-2">
      <HourglassIcon className="text-primary size-6 shrink-0" aria-hidden="true" />
      <span>Timeline</span>
    </div>
  );

  const hasOpenedTaxSettings = useHasOpenedTaxSettings(planId);
  const updateHasOpenedTaxSettings = useUpdateHasOpenedTaxSettings();

  return (
    <>
      <ColumnHeader
        title={isPlanNameLoading ? <Skeleton className="bg-background h-8 w-32" /> : (planName ?? 'Numbers')}
        icon={CalculatorIcon}
        iconButton={
          <div className="flex items-center gap-x-1">
            <IconButton
              icon={TrendingUpIcon}
              label="Expected Returns"
              onClick={() => setExpectedReturnsOpen(true)}
              surfaceColor="emphasized"
            />
            <IconButton
              icon={BanknoteXIcon}
              label="Tax Settings"
              onClick={() => {
                if (!hasOpenedTaxSettings) updateHasOpenedTaxSettings(planId, true);
                setTaxSettingsOpen(true);
              }}
              surfaceColor="emphasized"
            />
            <IconButton icon={HourglassIcon} label="Timeline" onClick={() => setTimelineOpen(true)} surfaceColor="emphasized" />
            <IconButton icon={CalendarClockIcon} label="SEPP" onClick={() => setSeppOpen(true)} surfaceColor="emphasized" />
            <IconButton
              icon={ArrowRightLeftIcon}
              label="Roth conversions"
              onClick={() => setConversionsOpen(true)}
              surfaceColor="emphasized"
            />
          </div>
        }
        className="left-76 w-96 border-r group-data-[state=collapsed]/sidebar:left-20"
      />

      <Drawer open={expectedReturnsOpen} setOpen={setExpectedReturnsOpen} title={expectedReturnsTitleComponent}>
        <Suspense fallback={<PageLoading message="Loading Expected Returns" />}>
          <ExpectedReturnsDrawer setOpen={setExpectedReturnsOpen} marketAssumptions={marketAssumptions} />
        </Suspense>
      </Drawer>
      <Drawer open={taxSettingsOpen} setOpen={setTaxSettingsOpen} title={taxSettingsTitleComponent}>
        <Suspense fallback={<PageLoading message="Loading Tax Settings" />}>
          <TaxSettingsDrawer setOpen={setTaxSettingsOpen} taxSettings={taxSettings} />
        </Suspense>
      </Drawer>
      <Drawer open={timelineOpen} setOpen={setTimelineOpen} title={timelineTitleComponent}>
        <Suspense fallback={<PageLoading message="Loading Timeline" />}>
          <TimelineDrawer setOpen={setTimelineOpen} timeline={timeline} />
        </Suspense>
      </Drawer>
      {/* A SEPP schedule is a plan-level list saved whole, like the milestones — a dialog with one
          Save, not a drawer of fields that write as you type. */}
      <Dialog size="2xl" open={seppOpen} onClose={() => setSeppOpen(false)}>
        <Suspense fallback={<PageLoading message="Loading SEPP schedules" />}>
          <SeppDialog sepp={sepp} accounts={Object.values(accounts)} onClose={() => setSeppOpen(false)} />
        </Suspense>
      </Dialog>
      {/* A Roth conversion schedule is the same kind of value: a plan-level list saved whole, so one
          dialog with one Save. */}
      <Dialog size="2xl" open={conversionsOpen} onClose={() => setConversionsOpen(false)}>
        <Suspense fallback={<PageLoading message="Loading Roth conversions" />}>
          <ConversionDialog conversions={conversions} accounts={Object.values(accounts)} onClose={() => setConversionsOpen(false)} />
        </Suspense>
      </Dialog>
    </>
  );
}
