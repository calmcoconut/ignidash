'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/catalyst/button';
import SectionContainer from '@/components/ui/section-container';
import type { ISODateString } from '@/lib/calc/clock';
import {
  oneAtATimeSensitivity,
  type SensitivityReport,
  type SensitivitySweepConfig,
  type SensitivityVariable,
} from '@/lib/calc/sensitivity';
import type { SingleSimulationMode } from '@/lib/calc/simulate';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { useSimulationClock } from '@/lib/stores/simulator-store';
import type { TableColumn } from '@/lib/types/table-column';
import { formatCurrency } from '@/lib/utils/number-formatters';

import ChartCard from '../cards/chart-card';
import Table from '../tables/table';

interface SensitivitySectionProps {
  /** The plan's validated inputs — the same object the page's own projection is computed from. */
  inputs: SimulatorInputs;
  /** The mode the page's headline projection used, named in the disclosure when it is not deterministic. */
  simulationMode: SingleSimulationMode;
}

/** The variables are the report's own ids; the table shows them as words. */
const VARIABLE_LABELS: Record<SensitivityVariable, string> = {
  returns: 'Returns',
  inflation: 'Inflation',
  retirementAge: 'Retirement age',
  spending: 'Spending',
};

/**
 * The disclosure this card owes its reader (AGENTS.md trap 7: two surfaces, one number).
 *
 * `oneAtATimeSensitivity()` always runs `mode: 'fixedReturns'` with `seed: 1`, whatever the plan
 * is set to, so on a stochastic or historical plan the base outcome here is NOT the page's
 * headline result. That has to be said in visible text, not a tooltip, because otherwise the two
 * numbers read as a contradiction.
 */
const DETERMINISTIC_DISCLOSURE =
  'This analysis always re-runs the plan with deterministic fixed returns and seed 1, so its numbers can differ from the projection above.';

const UNAVAILABLE_MESSAGE = 'Sensitivity is unavailable for this plan, so no assumptions table is shown.';

/** The trigger. Its label is the promise: the numbers do not exist until this is pressed. */
const TRIGGER_LABEL = 'Analyse sensitivity';

/**
 * The price, stated next to the trigger. A reader deciding whether to press it is entitled to
 * know that it is not one recalculation but a series of full runs of the whole plan.
 */
const COST_NOTE =
  'It runs up to nine full simulations of this plan — one base case plus two per variable — so it is only calculated when you ask for it.';

/** The trigger's label while the engine works; the sweep is synchronous, so this must be visible. */
const ANALYSING_LABEL = 'Analysing…';

/** What the user asked for, carried with the exact plan and clock pin it was asked for. */
interface AnalysisRequest {
  inputs: SimulatorInputs;
  asOf: ISODateString;
}

interface SensitivityAnalysis extends AnalysisRequest {
  /** `null` when the engine threw; the section then renders the unavailable line. */
  report: SensitivityReport | null;
}

/** One rendered row: the entry's two outcomes, the base, and the swing between them. */
interface SensitivityRow extends Record<string, unknown> {
  variable: string;
  low: number;
  base: number;
  high: number;
  swing: number;
}

/** Columns are props-free, so they live outside the component and keep one formatter stack. */
const COLUMNS: TableColumn<SensitivityRow>[] = [
  { key: 'variable', title: 'Variable', format: (value) => String(value) },
  { key: 'low', title: 'Low outcome', format: (value) => formatCurrency(Number(value)) },
  { key: 'base', title: 'Base outcome', format: (value) => formatCurrency(Number(value)) },
  { key: 'high', title: 'High outcome', format: (value) => formatCurrency(Number(value)) },
  { key: 'swing', title: 'Swing', format: (value) => formatCurrency(Number(value)) },
];

/** `±2 points of return` / `±1 point of inflation`, so a swept size of 1 does not read as a typo. */
function sweptAmount(count: number, singular: string, plural: string): string {
  return `±${count} ${Math.abs(count) === 1 ? singular : plural}`;
}

/** The perturbation sizes actually used, so "low"/"high" are not unexplained columns. */
function describeSweeps(sweeps: SensitivitySweepConfig): string {
  const swept = [
    sweptAmount(sweeps.returnDeltaPct, 'point of return', 'points of return'),
    sweptAmount(sweeps.inflationDeltaPct, 'point of inflation', 'points of inflation'),
    sweptAmount(sweeps.retirementAgeDeltaYears, 'year of retirement age', 'years of retirement age'),
  ];

  return `${swept.join(', ')}, ±${sweeps.spendingDeltaPct}% of spending`;
}

/** The page's headline mode, worded for the disclosure; `null` when the headline is deterministic too. */
function headlineModeLabel(simulationMode: SingleSimulationMode): string | null {
  switch (simulationMode) {
    case 'fixedReturns':
      return null;
    case 'stochasticReturns':
      return 'stochastic returns';
    case 'historicalReturns':
      return 'historical returns';
  }
}

/**
 * Card chrome every state shares.
 *
 * The disclosure qualifies the section's existence rather than its numbers, so it is rendered
 * here, above whatever the body is — a reader who has not asked for the analysis (or whose plan
 * cannot be priced) still needs to know what the section would be worth.
 */
function SensitivityCard({ modeLabel, children }: { modeLabel: string | null; children: React.ReactNode }) {
  return (
    <SectionContainer showBottomBorder className="mb-0">
      <ChartCard title="Sensitivity" subtitle="Final portfolio">
        <p className="text-muted-foreground mb-2 text-sm">
          {DETERMINISTIC_DISCLOSURE}
          {modeLabel === null ? '' : ` The projection above uses this plan's ${modeLabel} instead.`}
        </p>
        {children}
      </ChartCard>
    </SectionContainer>
  );
}

/**
 * One-at-a-time sensitivity for the selected plan: four variables, each moved on its own, ranked
 * by how much the final portfolio moves with it (R9).
 *
 * This is a bespoke section, not a chart-registry metric: the registry is age-indexed and every
 * table column has to be a declared series key, which a four-variable tornado is not. It follows
 * the net-worth overlay's precedent — a section of its own, mounted once from the results page.
 *
 * ## Why the report is computed on request
 *
 * A report is up to 9 full deterministic simulations (1 base + 2 per applicable variable; a
 * variable that does not apply, like retirement age on a `swrTarget` timeline, is skipped), and
 * on a 52-year plan that is hundreds of milliseconds of synchronous engine work. Computing it
 * during the first render made the results page wait for it: `single-simulation-results.tsx`
 * mounts this section unconditionally, and the mobile section selector remounts the sections when
 * the active section changes, so every plan and every remount paid it before anything painted.
 * The sweep now runs only once the reader presses "Analyse sensitivity" — the disclosure, the
 * trigger and its cost note are what the first paint shows, and a reader who never presses pays
 * nothing.
 *
 * The handler yields one macrotask before it sweeps, the same way the plan comparison view does,
 * so the "Analysing…" state paints before the engine blocks the thread: pressing the trigger does
 * not look like a dead button. The report is dropped when the plan or the clock pin changes, so
 * the table can never describe a plan the reader has since edited.
 *
 * `asOf` comes from the store's single clock boundary, the same `useSimulationClock` hook
 * `useSimulationResult` uses, so the plan's own `simulationSettings.asOfDate` pins this analysis
 * exactly as it pins the projection above; the host clock is read in neither place directly.
 */
export default function SensitivitySection({ inputs, simulationMode }: SensitivitySectionProps) {
  const clock = useSimulationClock(inputs);
  const [analysis, setAnalysis] = useState<SensitivityAnalysis | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);

  // A report only describes the plan on screen while it carries the same `inputs` object and clock
  // pin: editing the plan makes it stale, and the trigger comes back in place of an analysis of the
  // previous version. (Holding the old `inputs` in state costs nothing: it is dropped when the user
  // asks again, and the reference is what makes the comparison exact.)
  const liveAnalysis = analysis !== null && analysis.inputs === inputs && analysis.asOf === clock.asOf ? analysis : null;

  const runAnalysis = async () => {
    setIsAnalysing(true);
    // Yield once so the trigger's disabled state paints; the sweep itself is synchronous. This is
    // the plan comparison view's pattern, and the reason the section is usable at all on a long
    // plan: up to nine `simulate()` calls block the thread for their whole duration.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asOf = clock.asOf;
    let report: SensitivityReport | null;
    try {
      report = oneAtATimeSensitivity(inputs, { asOf });
    } catch {
      // The engine throws for a plan it cannot price. The page's own projection would already have
      // thrown in that case, but this analysis must never turn a secondary surface into a crash:
      // an unavailable report renders one explanatory line instead.
      report = null;
    }

    setAnalysis({ inputs, asOf, report });
    setIsAnalysing(false);
  };

  const report = liveAnalysis?.report ?? null;

  const rows = useMemo<SensitivityRow[]>(
    () =>
      report === null
        ? []
        : report.entries.map((entry) => ({
            variable: VARIABLE_LABELS[entry.variable],
            low: entry.low.outcome,
            base: entry.base.outcome,
            high: entry.high.outcome,
            swing: entry.effect,
          })),
    [report]
  );

  const modeLabel = headlineModeLabel(simulationMode);

  if (liveAnalysis === null) {
    return (
      <SensitivityCard modeLabel={modeLabel}>
        <p className="text-muted-foreground mb-4 text-sm">{COST_NOTE}</p>
        <Button outline type="button" onClick={runAnalysis} disabled={isAnalysing}>
          {isAnalysing ? ANALYSING_LABEL : TRIGGER_LABEL}
        </Button>
      </SensitivityCard>
    );
  }

  if (report === null || rows.length === 0) {
    return (
      <SensitivityCard modeLabel={modeLabel}>
        <p className="text-muted-foreground text-sm">{UNAVAILABLE_MESSAGE}</p>
      </SensitivityCard>
    );
  }

  return (
    <SensitivityCard modeLabel={modeLabel}>
      <p className="text-muted-foreground mb-4 text-sm">
        Base case: <span className="text-foreground font-semibold">{formatCurrency(report.baseOutcome)}</span> final portfolio. Each row
        moves one assumption at a time: {describeSweeps(report.sweeps)}.
      </p>
      <Table<SensitivityRow>
        columns={COLUMNS}
        data={rows}
        keyField="variable"
        // Four rows never paginate, and this table sits inside a card rather than at section
        // level, so it keeps its rows and drops the pagination footer.
        showPagination={false}
        exportFilename="sensitivity.csv"
        // `Table`'s root is its own Card; cancel that chrome so it reads flush inside this one,
        // exactly as `MetricTable` does for the same reason.
        className="mx-0 my-0 border-0 shadow-none sm:border-0"
      />
    </SensitivityCard>
  );
}
