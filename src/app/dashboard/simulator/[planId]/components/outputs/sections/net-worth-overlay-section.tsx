'use client';

import { useMemo } from 'react';

import SectionContainer from '@/components/ui/section-container';
import type { SimulationDataPoint } from '@/lib/calc/simulation-engine';
import { buildNetWorthOverlay, type NetWorthJournalEntry } from '@/lib/utils/net-worth-journal';
import { toOverlayChartData } from '@/lib/utils/net-worth-overlay-chart-data';

import ChartCard from '../cards/chart-card';
import SingleSimulationNetWorthOverlayChart from '../charts/single-simulation/single-simulation-net-worth-overlay-chart';
import QuietNotice from '../quiet-notice';

interface NetWorthOverlaySectionProps {
  /** The projection the journal is compared against. */
  data: readonly SimulationDataPoint[];
  /** Manual actuals (P4-P7). Empty until P5.1b passes the persisted journal in. */
  entries?: readonly NetWorthJournalEntry[];
}

/**
 * Actual-vs-projected net-worth card.
 *
 * Renders nothing at all when the journal is empty, which is what keeps today's results surface
 * byte-identical: no card, no border, no empty chart. Once there are entries, the card always
 * shows the projection, and every entry that could not be placed is listed above the chart so a
 * missing actual is explained rather than silently dropped.
 */
export default function NetWorthOverlaySection({ data, entries = [] }: NetWorthOverlaySectionProps) {
  const chart = useMemo(() => toOverlayChartData(buildNetWorthOverlay(data, entries)), [data, entries]);

  if (entries.length === 0) return null;

  return (
    <SectionContainer showBottomBorder className="mb-0">
      <ChartCard title="Actual vs Projected" subtitle="Net Worth">
        <QuietNotice notices={chart.issues} />
        <SingleSimulationNetWorthOverlayChart rows={chart.rows} markers={chart.markers} />
      </ChartCard>
    </SectionContainer>
  );
}
