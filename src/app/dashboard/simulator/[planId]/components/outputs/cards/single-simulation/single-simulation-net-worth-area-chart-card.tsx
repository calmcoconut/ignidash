'use client';

import { useShowReferenceLines } from '@/lib/stores/simulator-store';
import type { KeyMetrics } from '@/lib/types/key-metrics';
import { Select } from '@/components/catalyst/select';
import type { SingleSimulationNetWorthChartDataPoint } from '@/lib/types/chart-data-points';
import type { NetWorthDataView } from '@/lib/types/chart-data-views';
import { useUniqueChartItems } from '@/hooks/use-unique-chart-items';
import { useDataViewSelectHandler } from '@/hooks/use-data-view-select';
import type { SimulationEvent } from '@/lib/calc/data-extractors/annotations-extractor';

import SingleSimulationNetWorthAreaChart from '../../charts/single-simulation/single-simulation-net-worth-area-chart';
import ChartTimeFrameDropdown from '../../chart-time-frame-dropdown';
import ChartCard from '../chart-card';

const NET_WORTH_NON_CUSTOM_VIEWS = [
  'assetClass',
  'taxCategory',
  'netPortfolioChange',
  'netWorth',
  'netWorthChange',
  'assetEquity',
  'netAssetChange',
  'debts',
  'netDebtReduction',
] as const satisfies readonly Exclude<NetWorthDataView, 'custom'>[];

const extractAccounts = (dp: SingleSimulationNetWorthChartDataPoint) => dp.perAccountData;
const extractAssets = (dp: SingleSimulationNetWorthChartDataPoint) => dp.perAssetData;
const extractDebts = (dp: SingleSimulationNetWorthChartDataPoint) => dp.perDebtData;

interface SingleSimulationNetWorthAreaChartCardProps {
  rawChartData: SingleSimulationNetWorthChartDataPoint[];
  keyMetrics: KeyMetrics;
  onAgeSelect: (age: number) => void;
  selectedAge: number;
  setDataView: (view: NetWorthDataView) => void;
  dataView: NetWorthDataView;
  setCustomDataID: (name: string) => void;
  customDataID: string;
  startAge: number;
  /** Simulation events to mark (P4-P3). */
  events?: readonly SimulationEvent[];
}

export default function SingleSimulationNetWorthAreaChartCard({
  rawChartData,
  keyMetrics,
  onAgeSelect,
  selectedAge,
  setDataView,
  dataView,
  setCustomDataID,
  customDataID,
  startAge,
  events = [],
}: SingleSimulationNetWorthAreaChartCardProps) {
  const showReferenceLines = useShowReferenceLines();

  const uniqueAccounts = useUniqueChartItems(rawChartData, extractAccounts);
  const uniquePhysicalAssets = useUniqueChartItems(rawChartData, extractAssets);
  const uniqueDebts = useUniqueChartItems(rawChartData, extractDebts);

  const { handleSelectChange, getSelectValue } = useDataViewSelectHandler(setDataView, setCustomDataID, NET_WORTH_NON_CUSTOM_VIEWS);

  return (
    <ChartCard
      title="Net Worth"
      subtitle="Time Series"
      truncateTitle
      controls={
        <>
          <Select
            aria-label="Net worth data view options"
            className="max-w-48 sm:max-w-64"
            id="net-worth-data-view"
            name="net-worth-data-view"
            value={getSelectValue(dataView, customDataID)}
            onChange={handleSelectChange}
          >
            <option value="netWorth">Net Worth</option>
            <option value="netWorthChange">Net Worth Change</option>
            <optgroup label="Investment Portfolio">
              <option value="assetClass">Asset Class</option>
              <option value="taxCategory">Tax Category</option>
              <option value="netPortfolioChange">Net Portfolio Change</option>
            </optgroup>
            <optgroup label="Physical Assets">
              <option value="assetEquity">Asset Equity</option>
              <option value="netAssetChange">Net Asset Change</option>
            </optgroup>
            <optgroup label="Debts">
              <option value="debts">Debt Balance</option>
              <option value="netDebtReduction">Net Debt Reduction</option>
            </optgroup>
            <optgroup label="By Account">
              {uniqueAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </optgroup>
            {uniquePhysicalAssets.length > 0 && (
              <optgroup label="By Physical Asset">
                {uniquePhysicalAssets.map((physicalAsset) => (
                  <option key={physicalAsset.id} value={physicalAsset.id}>
                    {physicalAsset.name}
                  </option>
                ))}
              </optgroup>
            )}
            {uniqueDebts.length > 0 && (
              <optgroup label="By Debt">
                {uniqueDebts.map((debt) => (
                  <option key={debt.id} value={debt.id}>
                    {debt.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          <ChartTimeFrameDropdown timeFrameType="single" />
        </>
      }
    >
      <SingleSimulationNetWorthAreaChart
        events={events}
        rawChartData={rawChartData}
        startAge={startAge}
        keyMetrics={keyMetrics}
        showReferenceLines={showReferenceLines}
        dataView={dataView}
        customDataID={customDataID}
        onAgeSelect={onAgeSelect}
        selectedAge={selectedAge}
      />
    </ChartCard>
  );
}
