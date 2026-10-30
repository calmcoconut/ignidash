'use client';

import type { SingleSimulationCashFlowChartDataPoint } from '@/lib/types/chart-data-points';
import type { CashFlowDataView } from '@/lib/types/chart-data-views';
import { useIncomeData, useExpenseData, usePhysicalAssetData, useDebtData } from '@/hooks/use-convex-data';

import SingleSimulationCashFlowBarChart from '../../charts/single-simulation/single-simulation-cash-flow-bar-chart';
import ChartCard from '../chart-card';

interface SingleSimulationCashFlowBarChartCardProps {
  selectedAge: number;
  rawChartData: SingleSimulationCashFlowChartDataPoint[];
  dataView: CashFlowDataView;
  customDataID: string;
}

export default function SingleSimulationCashFlowBarChartCard({
  selectedAge,
  rawChartData,
  dataView,
  customDataID,
}: SingleSimulationCashFlowBarChartCardProps) {
  const incomeData = useIncomeData(customDataID !== '' ? customDataID : null);
  const expenseData = useExpenseData(customDataID !== '' ? customDataID : null);
  const physicalAssetData = usePhysicalAssetData(customDataID !== '' ? customDataID : null);
  const debtData = useDebtData(customDataID !== '' ? customDataID : null);

  let title;
  switch (dataView) {
    case 'surplusDeficit':
      title = 'Surplus/Deficit';
      break;
    case 'cashFlow':
      title = 'Cash Flow';
      break;
    case 'incomes':
      title = 'Incomes';
      break;
    case 'expenses':
      title = 'Expenses';
      break;
    case 'custom':
      if (incomeData) {
        title = `${incomeData.name} — Income`;
      } else if (expenseData) {
        title = `${expenseData.name} — Expense`;
      } else if (physicalAssetData) {
        title = `${physicalAssetData.name} — Loan`;
      } else if (debtData) {
        title = `${debtData.name} — Debt`;
      } else {
        title = 'Custom';
      }
      break;
    case 'savingsRate':
      title = 'Savings Rate';
      break;
  }

  // No chart/table toggle here: this card is a single-age decomposition (one row), and the
  // same numbers are already a row of the simulation data table below.
  return (
    <ChartCard title={title} subtitle={`Age ${selectedAge}`}>
      <SingleSimulationCashFlowBarChart age={selectedAge} rawChartData={rawChartData} dataView={dataView} customDataID={customDataID} />
    </ChartCard>
  );
}
