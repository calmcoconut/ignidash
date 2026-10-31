'use client';

import { Fragment } from 'react';

import type { SingleSimulationNetWorthChartDataPoint } from '@/lib/types/chart-data-points';
import type { NetWorthDataView } from '@/lib/types/chart-data-views';
import { DescriptionDetails, DescriptionList, DescriptionTerm } from '@/components/catalyst/description-list';
import { formatChartString } from '@/lib/utils';
import { formatCompactCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { useAccountData, usePhysicalAssetData, useDebtData } from '@/hooks/use-convex-data';
import { taxCategoryFromAccountTypeForDisplay } from '@/lib/schemas/inputs/account-form-schema';
import { zeroAssetAmounts, type AssetAllocation } from '@/lib/calc/asset';
import { resolveBarChart, resolvePieChart } from '@/lib/charts/metric-registry';
import { toPieChartData } from '@/lib/charts/plot-types';

import SingleSimulationNetWorthPieChart from '../../charts/single-simulation/single-simulation-net-worth-pie-chart';
import SingleSimulationNetWorthBarChart from '../../charts/single-simulation/single-simulation-net-worth-bar-chart';
import ChartCard from '../chart-card';

interface SingleSimulationNetWorthPieChartCardProps {
  rawChartData: SingleSimulationNetWorthChartDataPoint[];
  selectedAge: number;
  dataView: NetWorthDataView;
  customDataID: string;
}

export default function SingleSimulationNetWorthPieChartCard({
  rawChartData,
  selectedAge,
  dataView,
  customDataID,
}: SingleSimulationNetWorthPieChartCardProps) {
  const accountData = useAccountData(customDataID !== '' ? customDataID : null);
  const physicalAssetData = usePhysicalAssetData(customDataID !== '' ? customDataID : null);
  const debtData = useDebtData(customDataID !== '' ? customDataID : null);

  let title = '';
  let chartData: { name: string; value: number }[] = [];
  let chartType: 'pie' | 'bar' = 'pie';

  let nameForTotalValue = 'Total Value';
  let totalValue = 0;

  // P4-P6: the pie slices come from the registry; the four change views still delegate to the
  // single-age bar chart (which is itself registry-driven), and `custom` keeps its own
  // per-account/per-asset/per-debt slices below. Titles and total labels are chart furniture.
  const PIE_TITLES: Readonly<Record<string, string>> = {
    assetClass: 'By Asset Class',
    taxCategory: 'By Tax Category',
    netWorth: 'Net Worth',
    assetEquity: 'Asset Equity',
    debts: 'Debt Balance',
  };
  const PIE_TOTAL_LABELS: Readonly<Record<string, string>> = {
    assetClass: 'Total Portfolio Value',
    taxCategory: 'Total Portfolio Value',
    netWorth: 'Net Worth',
    assetEquity: 'Total Market Value',
    debts: 'Total Debt Balance',
  };
  const BAR_TITLES: Readonly<Record<string, string>> = {
    netPortfolioChange: 'Net Portfolio Change',
    netAssetChange: 'Net Asset Change',
    netDebtReduction: 'Net Debt Reduction',
    netWorthChange: 'Net Worth Change',
  };

  const pieDefinition = resolvePieChart('netWorth', dataView);
  const barDefinition = resolveBarChart('netWorth', dataView);

  if (pieDefinition) {
    const point = rawChartData.find((data) => data.age === selectedAge);

    title = PIE_TITLES[dataView] ?? '';
    nameForTotalValue = PIE_TOTAL_LABELS[dataView] ?? 'Total Value';
    chartData = point ? toPieChartData(point, pieDefinition) : [];

    // The signed net-worth view nets the debt slice out of the total; the pie itself draws
    // magnitudes, exactly as the old slices did.
    totalValue = chartData.reduce((sum, slice) => sum + slice.value, 0);
  } else if (barDefinition) {
    title = BAR_TITLES[dataView] ?? '';
    chartType = 'bar';
  } else {
    switch (dataView) {
      case 'custom':
        const perAccountData = rawChartData
          .filter((data) => data.age === selectedAge)
          .flatMap(({ perAccountData }) => perAccountData.filter((account) => account.id === customDataID));
        if (perAccountData.length > 0) {
          title = accountData ? `${accountData.name} — ${taxCategoryFromAccountTypeForDisplay(accountData.type)}` : 'Custom Account';

          chartData = perAccountData.flatMap((account) => {
            const balance = account.balance;

            const assetAllocation = account.assetAllocation ?? zeroAssetAmounts<AssetAllocation>();
            const stocksAllocation = assetAllocation.stocks;
            const bondsAllocation = assetAllocation.bonds;
            const cashAllocation = assetAllocation.cash;

            return [
              { name: formatChartString('stockHoldings'), value: balance * stocksAllocation },
              { name: formatChartString('bondHoldings'), value: balance * bondsAllocation },
              { name: formatChartString('cashHoldings'), value: balance * cashAllocation },
            ];
          });

          nameForTotalValue = 'Account Value';
          totalValue = chartData.reduce((sum, item) => sum + item.value, 0);
          break;
        }

        const perAssetData = rawChartData
          .filter((data) => data.age === selectedAge)
          .flatMap(({ perAssetData }) => perAssetData.filter((asset) => asset.id === customDataID));
        if (perAssetData.length > 0) {
          title = physicalAssetData ? `${physicalAssetData.name} — Physical Asset` : 'Custom Physical Asset';

          chartData = perAssetData.flatMap((asset) => [
            { name: formatChartString('equity'), value: asset.equity },
            { name: formatChartString('loanBalance'), value: asset.loanBalance },
          ]);

          nameForTotalValue = 'Market Value';
          totalValue = chartData.reduce((sum, item) => sum + item.value, 0);
          break;
        }

        const perDebtData = rawChartData
          .filter((data) => data.age === selectedAge)
          .flatMap(({ perDebtData }) => perDebtData.filter((debt) => debt.id === customDataID));
        if (perDebtData.length > 0) {
          title = debtData ? `${debtData.name} — Debt` : 'Custom Debt';

          chartData = perDebtData.flatMap((debt) => [{ name: formatChartString('balance'), value: debt.balance }]);

          nameForTotalValue = 'Debt Balance';
          totalValue = chartData.reduce((sum, item) => sum + item.value, 0);
          break;
        }

        break;
    }
  }

  // Magnitudes size the slices and the legend's percentages, so a liability slice still draws.
  const sliceData = chartData.map(({ name, value }) => ({ name, value: Math.abs(value) }));
  const totalAbsoluteValue = sliceData.reduce((sum, slice) => sum + slice.value, 0);

  let chart = null;
  switch (chartType) {
    case 'pie':
      chart = (
        <div className="divide-border/25 flex h-full items-center pb-4 sm:divide-x">
          <div className="flex-1 sm:pr-6">
            <SingleSimulationNetWorthPieChart chartData={sliceData} />
          </div>
          {totalAbsoluteValue > 0 && (
            <div className="hidden flex-1 sm:block sm:pl-6">
              <DescriptionList>
                {sliceData.map(({ name, value }) => (
                  <Fragment key={name}>
                    <DescriptionTerm>{name}</DescriptionTerm>
                    <DescriptionDetails>{`${formatCompactCurrency(value, 2)} (${formatPercentage(totalAbsoluteValue === 0 ? 0 : value / totalAbsoluteValue)})`}</DescriptionDetails>
                  </Fragment>
                ))}
                <DescriptionTerm className="font-bold">{nameForTotalValue}</DescriptionTerm>
                <DescriptionDetails className="font-bold">{formatCompactCurrency(totalValue, 2)}</DescriptionDetails>
              </DescriptionList>
            </div>
          )}
        </div>
      );
      break;
    case 'bar':
      chart = (
        <SingleSimulationNetWorthBarChart
          age={selectedAge}
          dataView={dataView as 'netPortfolioChange' | 'netAssetChange' | 'netDebtReduction' | 'netWorthChange'}
          rawChartData={rawChartData}
        />
      );
      break;
  }

  return (
    <ChartCard title={title} subtitle={`Age ${selectedAge}`}>
      {chart}
    </ChartCard>
  );
}
