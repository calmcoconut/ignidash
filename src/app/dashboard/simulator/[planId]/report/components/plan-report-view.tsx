'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { PrinterIcon } from 'lucide-react';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { useKeyMetrics, useSimulationResult } from '@/lib/stores/simulator-store';
import { buildPlanReport, type ReportColumn } from '@/lib/utils/plan-report';
import { cn } from '@/lib/utils';
import { useSelectedPlanId } from '@/hooks/use-selected-plan-id';
import { Button } from '@/components/catalyst/button';
import PageLoading from '@/components/ui/page-loading';

import FooterDisclaimer from '../../components/outputs/results-pages/footer-disclaimer';

/** Modes the report can run. A Monte Carlo fan has no single year-by-year table to print. */
type SingleRunMode = 'fixedReturns' | 'stochasticReturns' | 'historicalReturns';

const SINGLE_RUN_MODE: Readonly<Record<string, SingleRunMode>> = {
  fixedReturns: 'fixedReturns',
  stochasticReturns: 'stochasticReturns',
  historicalReturns: 'historicalReturns',
  monteCarloStochasticReturns: 'stochasticReturns',
  monteCarloHistoricalReturns: 'historicalReturns',
};

const MODE_LABELS: Readonly<Record<SingleRunMode, string>> = {
  fixedReturns: 'Fixed returns',
  stochasticReturns: 'Stochastic returns',
  historicalReturns: 'Historical returns',
};

/** One printed table: the report's columns over the rows the on-screen table uses. */
function ReportTable({ columns, rows }: { columns: readonly ReportColumn[]; rows: readonly Record<string, unknown>[] }) {
  return (
    <div className="mt-2 overflow-x-auto print:overflow-visible">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  'border-border/60 border-b py-1 pr-2 font-semibold whitespace-nowrap',
                  index < 2 ? 'text-left' : 'text-right'
                )}
              >
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={String(row.year ?? rowIndex)} className="print-avoid-break">
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={cn('border-border/25 border-b py-0.5 pr-2 tabular-nums', index < 2 ? 'text-left' : 'text-right')}
                >
                  {column.format(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A label/value pair list, two or three columns wide on screen and on paper. */
function FactList({ facts, columns = 3 }: { facts: ReadonlyArray<{ label: string; value: string }>; columns?: 2 | 3 }) {
  return (
    <dl className={cn('mt-2 grid gap-x-6 gap-y-2', columns === 3 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>
      {facts.map((fact) => (
        <div key={fact.label} className="print-avoid-break">
          <dt className="text-muted-foreground text-xs">{fact.label}</dt>
          <dd className="text-sm font-semibold tabular-nums">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface PlanReportViewProps {
  inputs: SimulatorInputs;
  planName: string;
}

/**
 * The printable report (P4-P5).
 *
 * Everything on this page is derived by `buildPlanReport` from the same simulation and the
 * same extractors the on-screen results use, so paper and screen cannot disagree. The layout
 * is deliberately report-shaped: key results, assumptions, milestones, then three
 * year-by-year tables, the last two starting on their own page.
 */
export default function PlanReportView({ inputs, planName }: PlanReportViewProps) {
  const planId = useSelectedPlanId();
  const mode = SINGLE_RUN_MODE[inputs.simulationSettings.simulationMode] ?? 'fixedReturns';
  const simulation = useSimulationResult(inputs, mode);
  const keyMetrics = useKeyMetrics(simulation);

  const report = useMemo(() => {
    if (!simulation || !keyMetrics) return null;

    const seed = inputs.simulationSettings.simulationSeed;
    const modeLabel = mode === 'fixedReturns' ? MODE_LABELS[mode] : `${MODE_LABELS[mode]} (seed ${seed})`;

    return buildPlanReport({ planName, inputs, simulation, keyMetrics, modeLabel });
  }, [inputs, keyMetrics, mode, planName, simulation]);

  if (!report) return <PageLoading message="Running simulation" />;

  return (
    <article className="mx-auto max-w-5xl px-2 py-4 sm:px-3 print:max-w-none print:px-0 print:py-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/dashboard/simulator/${planId}`}
          className="text-muted-foreground hover:text-foreground focus-outline text-sm underline underline-offset-2"
        >
          ← Back to results
        </Link>
        <Button outline onClick={() => window.print()}>
          <PrinterIcon data-slot="icon" aria-hidden="true" />
          Print / save as PDF
        </Button>
      </div>

      <header className="border-border/50 print-avoid-break border-b pb-3">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">{report.title}</p>
        <h1 className="text-2xl font-semibold">{report.planName}</h1>
        <p className="text-muted-foreground mt-1 text-xs">
          Projection starting {report.asOf}, printed from the same simulation and extractors as the on-screen results.
        </p>
      </header>

      <section className="print-avoid-break mt-4">
        <h2 className="text-sm font-semibold">Key results</h2>
        <FactList facts={report.facts} />
      </section>

      <section className="print-avoid-break mt-4">
        <h2 className="text-sm font-semibold">Assumptions</h2>
        <FactList facts={report.assumptions} columns={2} />
      </section>

      {report.events.length > 0 && (
        <section className="print-avoid-break mt-4">
          <h2 className="text-sm font-semibold">Milestones</h2>
          <ul className="mt-2 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {report.events.map((event) => (
              <li key={`${event.label}-${event.value}`} className="border-border/25 flex justify-between gap-2 border-b py-0.5 text-sm">
                <span>{event.label}</span>
                <span className="tabular-nums">{event.value}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.sections.map((section) => (
        <section key={section.id} className={cn('mt-6', section.pageBreakBefore && 'print-break-before')}>
          <h2 className="text-sm font-semibold">{section.title}</h2>
          <p className="text-muted-foreground text-xs">{section.summary}</p>
          <ReportTable columns={section.columns} rows={section.rows} />
        </section>
      ))}

      <FooterDisclaimer />
    </article>
  );
}
