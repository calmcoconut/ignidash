'use client';

import { memo } from 'react';

import { useMultiSimulationCategory } from '@/lib/stores/simulator-store';
import SectionContainer from '@/components/ui/section-container';
import { MultiSimulationCategory } from '@/lib/types/simulation-category';
import type { MultiSimulationChartData } from '@/lib/types/chart-data-points';
import type { MonteCarloHistogram } from '@/lib/calc/monte-carlo';
import type { KeyMetrics } from '@/lib/types/key-metrics';

import MultiSimulationPortfolioAreaChartCard from '../cards/multi-simulation/multi-simulation-portfolio-area-chart-card';
import MultiSimulationPortfolioBarChartCard from '../cards/multi-simulation/multi-simulation-portfolio-bar-chart-card';
import MultiSimulationPhasesAreaChartCard from '../cards/multi-simulation/multi-simulation-phases-area-chart-card';
import MultiSimulationPhasesBarChartCard from '../cards/multi-simulation/multi-simulation-phases-bar-chart-card';
import MultiSimulationHistogramChartCard from '../cards/multi-simulation/multi-simulation-histogram-chart-card';
import MultiSimulationDataListSection from './multi-simulation-data-list-section';

interface ChartsCategoryProps {
  startAge: number;
  chartData: MultiSimulationChartData;
  keyMetrics: KeyMetrics;
  histogram: MonteCarloHistogram;
  trials: number;
  onAgeSelect: (age: number) => void;
  selectedAge: number;
}

function PortfolioCharts({ chartData, histogram, trials, onAgeSelect, keyMetrics, selectedAge, startAge }: ChartsCategoryProps) {
  return (
    <>
      <MultiSimulationPortfolioAreaChartCard
        rawChartData={chartData.portfolioData}
        keyMetrics={keyMetrics}
        onAgeSelect={onAgeSelect}
        selectedAge={selectedAge}
        startAge={startAge}
      />
      <MultiSimulationPortfolioBarChartCard selectedAge={selectedAge} rawChartData={chartData.portfolioData} />
      <div className="@[120rem]:col-span-2">
        <MultiSimulationHistogramChartCard histogram={histogram} trials={trials} />
      </div>
    </>
  );
}

function PhasesCharts({ chartData, onAgeSelect, keyMetrics, selectedAge, startAge }: ChartsCategoryProps) {
  return (
    <>
      <MultiSimulationPhasesAreaChartCard
        rawChartData={chartData.phasesData}
        keyMetrics={keyMetrics}
        onAgeSelect={onAgeSelect}
        selectedAge={selectedAge}
        startAge={startAge}
      />
      <MultiSimulationPhasesBarChartCard selectedAge={selectedAge} rawChartData={chartData.phasesData} />
    </>
  );
}

interface MultiSimulationChartsSectionProps {
  startAge: number;
  chartData: MultiSimulationChartData;
  keyMetrics: KeyMetrics;
  histogram: MonteCarloHistogram;
  trials: number;
  onAgeSelect: (age: number) => void;
  selectedAge: number;
}

function MultiSimulationChartsSection({
  startAge,
  chartData,
  histogram,
  trials,
  keyMetrics,
  onAgeSelect,
  selectedAge,
}: MultiSimulationChartsSectionProps) {
  const resultsCategory = useMultiSimulationCategory();

  const props: ChartsCategoryProps = { chartData, histogram, trials, keyMetrics, onAgeSelect, selectedAge, startAge };

  let chartsComponents = null;
  switch (resultsCategory) {
    case MultiSimulationCategory.Portfolio:
      chartsComponents = <PortfolioCharts {...props} />;
      break;
    case MultiSimulationCategory.Phases:
      chartsComponents = <PhasesCharts {...props} />;
      break;
    default:
      chartsComponents = (
        <div className="text-muted-foreground ml-2 py-10 text-center font-semibold italic">
          <p>Coming soon...</p>
        </div>
      );
      break;
  }

  return (
    <SectionContainer showBottomBorder>
      <div className="grid grid-cols-1 gap-2 @[120rem]:grid-cols-2">
        {chartsComponents}
        <div className="@[120rem]:col-span-2">
          <MultiSimulationDataListSection chartData={chartData} selectedAge={selectedAge} />
        </div>
      </div>
    </SectionContainer>
  );
}

// Memoize the entire section to prevent re-renders when props haven't changed
export default memo(MultiSimulationChartsSection);
