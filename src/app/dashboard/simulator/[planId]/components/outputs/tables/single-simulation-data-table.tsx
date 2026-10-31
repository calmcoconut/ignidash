'use client';

import type { SimulationResult } from '@/lib/calc/simulation-engine';
import type {
  SingleSimulationNetWorthTableRow,
  SingleSimulationCashFlowTableRow,
  SingleSimulationTaxesTableRow,
  SingleSimulationReturnsTableRow,
  SingleSimulationContributionsTableRow,
  SingleSimulationWithdrawalsTableRow,
} from '@/lib/schemas/tables/single-simulation-table-schema';
import { SingleSimulationCategory } from '@/lib/types/simulation-category';
import {
  useSingleSimulationNetWorthTableData,
  useSingleSimulationCashFlowTableData,
  useSingleSimulationTaxesTableData,
  useSingleSimulationReturnsTableData,
  useSingleSimulationContributionsTableData,
  useSingleSimulationWithdrawalsTableData,
  useSingleSimulationCategory,
} from '@/lib/stores/simulator-store';
import {
  generateNetWorthTableColumns,
  generateCashFlowTableColumns,
  generateTaxesTableColumns,
  generateReturnsTableColumns,
  generateContributionsTableColumns,
  generateWithdrawalsTableColumns,
} from '@/lib/utils/table-formatters';

import Table from './table';

const netWorthColumns = generateNetWorthTableColumns();
const cashFlowColumns = generateCashFlowTableColumns();
const taxesColumns = generateTaxesTableColumns();
const returnsColumns = generateReturnsTableColumns();
const contributionsColumns = generateContributionsTableColumns();
const withdrawalsColumns = generateWithdrawalsTableColumns();

interface TableCategoryProps {
  simulation: SimulationResult;
}

function NetWorthTable({ simulation }: TableCategoryProps) {
  const tableData = useSingleSimulationNetWorthTableData(simulation);

  return (
    <Table<SingleSimulationNetWorthTableRow>
      columns={netWorthColumns}
      data={tableData}
      keyField="year"
      exportFilename="net-worth-data.csv"
    />
  );
}

function CashFlowTable({ simulation }: TableCategoryProps) {
  const tableData = useSingleSimulationCashFlowTableData(simulation);

  return (
    <Table<SingleSimulationCashFlowTableRow>
      columns={cashFlowColumns}
      data={tableData}
      keyField="year"
      exportFilename="cash-flow-data.csv"
    />
  );
}

function TaxesTable({ simulation }: TableCategoryProps) {
  const tableData = useSingleSimulationTaxesTableData(simulation);

  return <Table<SingleSimulationTaxesTableRow> columns={taxesColumns} data={tableData} keyField="year" exportFilename="taxes-data.csv" />;
}

function ReturnsTable({ simulation }: TableCategoryProps) {
  const tableData = useSingleSimulationReturnsTableData(simulation);

  return (
    <Table<SingleSimulationReturnsTableRow> columns={returnsColumns} data={tableData} keyField="year" exportFilename="returns-data.csv" />
  );
}

function ContributionsTable({ simulation }: TableCategoryProps) {
  const tableData = useSingleSimulationContributionsTableData(simulation);

  return (
    <Table<SingleSimulationContributionsTableRow>
      columns={contributionsColumns}
      data={tableData}
      keyField="year"
      exportFilename="contributions-data.csv"
    />
  );
}

function WithdrawalsTable({ simulation }: TableCategoryProps) {
  const tableData = useSingleSimulationWithdrawalsTableData(simulation);

  return (
    <Table<SingleSimulationWithdrawalsTableRow>
      columns={withdrawalsColumns}
      data={tableData}
      keyField="year"
      exportFilename="withdrawals-data.csv"
    />
  );
}

interface SingleSimulationDataTableProps {
  simulation: SimulationResult;
}

export default function SingleSimulationDataTable({ simulation }: SingleSimulationDataTableProps) {
  const resultsCategory = useSingleSimulationCategory();

  switch (resultsCategory) {
    case SingleSimulationCategory.NetWorth:
      return <NetWorthTable simulation={simulation} />;
    case SingleSimulationCategory.CashFlow:
      return <CashFlowTable simulation={simulation} />;
    case SingleSimulationCategory.Taxes:
      return <TaxesTable simulation={simulation} />;
    case SingleSimulationCategory.Returns:
      return <ReturnsTable simulation={simulation} />;
    case SingleSimulationCategory.Contributions:
      return <ContributionsTable simulation={simulation} />;
    case SingleSimulationCategory.Withdrawals:
      return <WithdrawalsTable simulation={simulation} />;
  }
}
