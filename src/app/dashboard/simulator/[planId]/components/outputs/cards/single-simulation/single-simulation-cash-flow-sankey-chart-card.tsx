'use client';

import { useMemo, useCallback } from 'react';

import type { SimulationResult } from '@/lib/calc/simulation-engine';
import { extractAnnualCashFlowLedger, ledgerEntryForAge } from '@/lib/calc/data-extractors/cash-flow-ledger';
import { Select } from '@/components/catalyst/select';

import SingleSimulationCashFlowSankeyChart from '../../charts/single-simulation/single-simulation-cash-flow-sankey-chart';
import ChartCard from '../chart-card';

interface SingleSimulationCashFlowSankeyChartCardProps {
  simulation: SimulationResult;
  selectedAge: number;
  onAgeSelect: (age: number) => void;
}

export default function SingleSimulationCashFlowSankeyChartCard({
  simulation,
  selectedAge,
  onAgeSelect,
}: SingleSimulationCashFlowSankeyChartCardProps) {
  const ledger = useMemo(() => extractAnnualCashFlowLedger(simulation.data), [simulation]);
  const activeEntry = ledgerEntryForAge(ledger, selectedAge);

  const handleYearChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onAgeSelect(Number(event.target.value));
    },
    [onAgeSelect]
  );

  return (
    <ChartCard
      title="Cash Flow"
      subtitle="Sankey"
      truncateTitle
      controls={
        <Select
          aria-label="Cash flow Sankey year"
          className="max-w-48 sm:max-w-64"
          id="cash-flow-sankey-year"
          name="cash-flow-sankey-year"
          value={activeEntry ? String(activeEntry.age) : ''}
          onChange={handleYearChange}
        >
          {ledger.map((entry) => (
            <option key={entry.age} value={entry.age}>
              {`Age ${entry.age} (${entry.yearLabel})`}
            </option>
          ))}
        </Select>
      }
    >
      <SingleSimulationCashFlowSankeyChart ledger={ledger} age={selectedAge} />
    </ChartCard>
  );
}
