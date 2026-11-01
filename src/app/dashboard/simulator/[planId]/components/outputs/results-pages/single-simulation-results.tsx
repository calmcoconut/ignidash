'use client';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { useSimulationResult, useKeyMetrics } from '@/lib/stores/simulator-store';
import { buildHistoricalBacktestNotices } from '@/lib/utils/historical-backtest-disclosure';
import type { NetWorthJournalEntry } from '@/lib/utils/net-worth-journal';
import SectionContainer from '@/components/ui/section-container';

import QuietNotice from '../quiet-notice';
import NetWorthOverlaySection from '../sections/net-worth-overlay-section';
import RentVsOwnSection from '../sections/rent-vs-own-section';
import SensitivitySection from '../sections/sensitivity-section';
import SimulationMetrics from '../simulation-metrics';
import SingleSimulationResultsContent from './single-simulation-results-content';

interface SingleSimulationResultsProps {
  inputs: SimulatorInputs;
  simulationMode: 'fixedReturns' | 'stochasticReturns' | 'historicalReturns';
  /** Manual actuals for the net-worth overlay (P4-P7). Defaults to an empty journal, which the overlay renders as nothing. */
  journalEntries?: NetWorthJournalEntry[];
}

export default function SingleSimulationResults({ inputs, simulationMode, journalEntries = [] }: SingleSimulationResultsProps) {
  const simulationResult = useSimulationResult(inputs, simulationMode);
  const keyMetrics = useKeyMetrics(simulationResult);

  if (!simulationResult || !keyMetrics) {
    return (
      <div className="text-muted-foreground text-center">
        <p>Results content will be displayed here...</p>
      </div>
    );
  }

  return (
    <>
      <SectionContainer showBottomBorder className="mb-0">
        {/* Explains a historical run that wrapped or truncated; renders nothing otherwise. */}
        <QuietNotice
          notices={buildHistoricalBacktestNotices(simulationResult.context).map(({ kind, message }) => ({ id: kind, message }))}
        />
        <SimulationMetrics keyMetrics={keyMetrics} simulationResult={simulationResult} />
      </SectionContainer>
      <NetWorthOverlaySection data={simulationResult.data} entries={journalEntries} />
      <SensitivitySection inputs={inputs} simulationMode={simulationMode} />
      <RentVsOwnSection inputs={inputs} simulationMode={simulationMode} />
      <SingleSimulationResultsContent simulation={simulationResult} keyMetrics={keyMetrics} />
    </>
  );
}
