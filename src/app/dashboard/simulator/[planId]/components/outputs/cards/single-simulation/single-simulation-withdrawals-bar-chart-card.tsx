'use client';

import type { SingleSimulationWithdrawalsChartDataPoint } from '@/lib/types/chart-data-points';
import type { WithdrawalsDataView } from '@/lib/types/chart-data-views';
import { useAccountData } from '@/hooks/use-convex-data';
import { taxCategoryFromAccountTypeForDisplay } from '@/lib/schemas/inputs/account-form-schema';

import SingleSimulationWithdrawalsBarChart from '../../charts/single-simulation/single-simulation-withdrawals-bar-chart';
import ChartCard from '../chart-card';

interface SingleSimulationWithdrawalsBarChartCardProps {
  selectedAge: number;
  rawChartData: SingleSimulationWithdrawalsChartDataPoint[];
  dataView: WithdrawalsDataView;
  customDataID: string;
}

export default function SingleSimulationWithdrawalsBarChartCard({
  selectedAge,
  rawChartData,
  dataView,
  customDataID,
}: SingleSimulationWithdrawalsBarChartCardProps) {
  const accountData = useAccountData(customDataID !== '' ? customDataID : null);

  let title;
  switch (dataView) {
    case 'annualAmounts':
      title = 'Annual Withdrawals';
      break;
    case 'cumulativeAmounts':
      title = 'Cumulative Withdrawals';
      break;
    case 'taxCategory':
      title = 'By Tax Category';
      break;
    case 'realizedGains':
      title = 'Realized Gains';
      break;
    case 'requiredMinimumDistributions':
      title = 'RMDs & Roth Conversions';
      break;
    case 'earlyWithdrawals':
      title = 'Early Withdrawals';
      break;
    case 'shortfall':
      title = 'Shortfall';
      break;
    case 'withdrawalRate':
      title = 'Withdrawal Rate';
      break;
    case 'custom':
      title = accountData ? `${accountData.name} — ${taxCategoryFromAccountTypeForDisplay(accountData.type)}` : 'Custom Account';
      break;
  }

  return (
    <ChartCard title={title} subtitle={`Age ${selectedAge}`}>
      <SingleSimulationWithdrawalsBarChart age={selectedAge} rawChartData={rawChartData} dataView={dataView} customDataID={customDataID} />
    </ChartCard>
  );
}
