import type { MonteCarloHistogram } from '@/lib/calc/monte-carlo';

import MultiSimulationHistogramBarChart from '../../charts/multi-simulation/multi-simulation-histogram-bar-chart';
import ChartCard from '../chart-card';

interface MultiSimulationHistogramChartCardProps {
  histogram: MonteCarloHistogram;
  trials: number;
}

export default function MultiSimulationHistogramChartCard({ histogram, trials }: MultiSimulationHistogramChartCardProps) {
  return (
    <ChartCard title="Final Portfolio Distribution" subtitle={`${trials} trials`}>
      <MultiSimulationHistogramBarChart histogram={histogram} trials={trials} />
    </ChartCard>
  );
}
