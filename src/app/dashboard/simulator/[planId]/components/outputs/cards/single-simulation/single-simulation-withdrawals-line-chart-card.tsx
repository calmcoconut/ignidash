'use client';

import { Select } from '@/components/catalyst/select';
import type { SingleSimulationWithdrawalsChartDataPoint } from '@/lib/types/chart-data-points';
import type { WithdrawalsDataView } from '@/lib/types/chart-data-views';
import { useShowReferenceLines } from '@/lib/stores/simulator-store';
import type { KeyMetrics } from '@/lib/types/key-metrics';
import { useUniqueChartItems } from '@/hooks/use-unique-chart-items';
import { useDataViewSelectHandler } from '@/hooks/use-data-view-select';

import SingleSimulationWithdrawalsLineChart from '../../charts/single-simulation/single-simulation-withdrawals-line-chart';
import ChartTimeFrameDropdown from '../../chart-time-frame-dropdown';
import ChartCard from '../chart-card';

const WITHDRAWALS_NON_CUSTOM_VIEWS = [
  'annualAmounts',
  'cumulativeAmounts',
  'taxCategory',
  'realizedGains',
  'requiredMinimumDistributions',
  'earlyWithdrawals',
  'shortfall',
  'withdrawalRate',
] as const satisfies readonly Exclude<WithdrawalsDataView, 'custom'>[];

const extractAccounts = (dp: SingleSimulationWithdrawalsChartDataPoint) => dp.perAccountData;

interface SingleSimulationWithdrawalsLineChartCardProps {
  onAgeSelect: (age: number) => void;
  selectedAge: number;
  setDataView: (view: WithdrawalsDataView) => void;
  dataView: WithdrawalsDataView;
  setCustomDataID: (name: string) => void;
  customDataID: string;
  rawChartData: SingleSimulationWithdrawalsChartDataPoint[];
  keyMetrics: KeyMetrics;
  startAge: number;
}

export default function SingleSimulationWithdrawalsLineChartCard({
  onAgeSelect,
  selectedAge,
  setDataView,
  dataView,
  setCustomDataID,
  customDataID,
  rawChartData,
  keyMetrics,
  startAge,
}: SingleSimulationWithdrawalsLineChartCardProps) {
  const showReferenceLines = useShowReferenceLines();

  const uniqueAccounts = useUniqueChartItems(rawChartData, extractAccounts);

  const { handleSelectChange, getSelectValue } = useDataViewSelectHandler(setDataView, setCustomDataID, WITHDRAWALS_NON_CUSTOM_VIEWS);

  return (
    <ChartCard
      title="Withdrawals"
      subtitle="Time Series"
      truncateTitle
      controls={
        <>
          <Select
            aria-label="Withdrawals data view options"
            className="max-w-48 sm:max-w-64"
            id="withdrawals-data-view"
            name="withdrawals-data-view"
            value={getSelectValue(dataView, customDataID)}
            onChange={handleSelectChange}
          >
            <option value="taxCategory">Tax Category</option>
            <option value="annualAmounts">Annual Withdrawals</option>
            <option value="cumulativeAmounts">Cumulative Withdrawals</option>
            <option value="requiredMinimumDistributions">RMDs &amp; Roth Conversions</option>
            <option value="withdrawalRate">Withdrawal Rate</option>
            <optgroup label="Taxable Brokerage">
              <option value="realizedGains">Realized Gains</option>
            </optgroup>
            <optgroup label="Issues & Penalties">
              <option value="earlyWithdrawals">Early Withdrawals</option>
              <option value="shortfall">Shortfall</option>
            </optgroup>
            <optgroup label="By Account">
              {uniqueAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </optgroup>
          </Select>
          <ChartTimeFrameDropdown timeFrameType="single" />
        </>
      }
    >
      <SingleSimulationWithdrawalsLineChart
        onAgeSelect={onAgeSelect}
        selectedAge={selectedAge}
        rawChartData={rawChartData}
        keyMetrics={keyMetrics}
        showReferenceLines={showReferenceLines}
        dataView={dataView}
        customDataID={customDataID}
        startAge={startAge}
      />
    </ChartCard>
  );
}
