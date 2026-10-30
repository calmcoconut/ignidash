'use client';

import { useEffect, useMemo, useState } from 'react';
import { type Preloaded } from 'convex/react';
import { usePreloadedAuthQuery } from '@convex-dev/better-auth/nextjs/client';
import { api } from '@/convex/_generated/api';
import type { Doc } from '@/convex/_generated/dataModel';

import { Button } from '@/components/catalyst/button';
import { Select } from '@/components/catalyst/select';
import { Subheading } from '@/components/catalyst/heading';
import Card from '@/components/ui/card';
import { comparePlans, type CompareMetric, type CompareReport } from '@/lib/calc/compare';
import { DEFAULT_MONTE_CARLO_TRIALS } from '@/lib/calc/monte-carlo';
import { getIsCalculationReady } from '@/lib/stores/simulator-store';
import { simulatorFromConvex } from '@/lib/utils/data-transformers';
import { formatCurrency, formatPercentage } from '@/lib/utils/number-formatters';
import { currentLocalISODate } from '@/lib/utils/system-clock';

const GROUPS: Array<{ id: CompareMetric['group']; label: string }> = [
  { id: 'projection', label: 'Projection' },
  { id: 'taxes', label: 'Lifetime taxes' },
  { id: 'monteCarlo', label: 'Monte Carlo' },
];

function formatMetric(value: number | null, format: CompareMetric['format']): string {
  if (value === null) return '—';

  switch (format) {
    case 'currency':
      return formatCurrency(value);
    case 'percentage':
      return formatPercentage(value);
    case 'age':
      return value.toFixed(1);
    case 'flag':
      return value ? 'Yes' : 'No';
  }
}

function formatDelta(metric: CompareMetric): string {
  if (metric.delta === null) return '—';
  if (metric.format === 'flag') return metric.delta === 0 ? 'Same' : 'Differs';

  const prefix = metric.delta > 0 ? '+' : '';
  const formatted = formatMetric(Math.abs(metric.delta), metric.format);

  return `${metric.delta === 0 ? '' : prefix}${metric.delta < 0 ? '-' : ''}${formatted}`;
}

const deltaClassName = (metric: CompareMetric): string => {
  if (metric.delta === null || metric.delta === 0) return 'text-stone-500 dark:text-stone-400';
  return metric.delta > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400';
};

interface PlanSelectProps {
  id: string;
  label: string;
  plans: Doc<'plans'>[];
  value: string;
  onChange: (planId: string) => void;
}

function PlanSelect({ id, label, plans, value, onChange }: PlanSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-stone-700 dark:text-stone-300">
        {label}
      </label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {plans.map((plan) => (
          <option key={plan._id} value={plan._id}>
            {plan.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

export default function CompareView({ preloadedPlans }: { preloadedPlans: Preloaded<typeof api.plans.listPlans> }) {
  const plans = usePreloadedAuthQuery(preloadedPlans);
  const planList = useMemo(() => plans ?? [], [plans]);

  const [planAId, setPlanAId] = useState<string>('');
  const [planBId, setPlanBId] = useState<string>('');
  const [report, setReport] = useState<CompareReport | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to the first two plans once the list arrives.
  useEffect(() => {
    if (planList.length === 0) return;
    setPlanAId((current) => (current === '' ? planList[0]._id : current));
    setPlanBId((current) => (current === '' ? (planList[1] ?? planList[0])._id : current));
  }, [planList]);

  const planA = planList.find((plan) => plan._id === planAId);
  const planB = planList.find((plan) => plan._id === planBId);

  const inputsA = useMemo(() => (planA ? simulatorFromConvex(planA) : null), [planA]);
  const inputsB = useMemo(() => (planB ? simulatorFromConvex(planB) : null), [planB]);

  const runComparison = async () => {
    if (!inputsA || !inputsB) return;

    setIsPending(true);
    setError(null);
    // Yield once so the button paints; the comparison itself is synchronous and pure.
    await new Promise((resolve) => setTimeout(resolve, 0));

    try {
      // One clock and one seed for both sides: the delta must be the plans, not the sampling or
      // the day. A plan may pin its own as-of date; otherwise the comparison uses today.
      const asOf = inputsA.simulationSettings.asOfDate ?? inputsB.simulationSettings.asOfDate ?? currentLocalISODate();
      const seed = inputsA.simulationSettings.simulationSeed;

      setReport(comparePlans(inputsA, inputsB, { asOf, seed }));
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : 'Comparison failed.');
    } finally {
      setIsPending(false);
    }
  };

  const readyA = getIsCalculationReady(inputsA);
  const readyB = getIsCalculationReady(inputsB);
  const asOf = report?.asOf ?? inputsA?.simulationSettings.asOfDate ?? inputsB?.simulationSettings.asOfDate ?? null;
  const noteClassName = 'text-sm text-stone-500 dark:text-stone-400';

  if (planList.length === 0) {
    return (
      <div className="px-4 py-10">
        <Card>
          <p className={noteClassName}>No plans yet. Create one in the simulator to compare plans.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-2 py-4 sm:px-3 lg:px-4">
      <Card>
        <div className="flex flex-col gap-4">
          <div>
            <Subheading level={3}>Compare plans</Subheading>
            <p className={noteClassName}>
              Both plans run through the same simulation, on the same date and with the same seed. Every difference is{' '}
              <span className="font-medium">A − B</span>: positive means plan A is larger.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
            <PlanSelect id="compare-plan-a" label="Plan A (subject)" plans={planList} value={planAId} onChange={setPlanAId} />
            <PlanSelect id="compare-plan-b" label="Plan B (reference)" plans={planList} value={planBId} onChange={setPlanBId} />
            <Button onClick={runComparison} disabled={isPending}>
              {isPending ? 'Comparing…' : 'Compare'}
            </Button>
          </div>

          <p className={noteClassName}>
            Monte Carlo: {DEFAULT_MONTE_CARLO_TRIALS} trials per plan, summary retention (no per-run results are kept). Seed:{' '}
            {report?.seed ?? inputsA?.simulationSettings.simulationSeed ?? '—'}
            {asOf ? ` · As of ${asOf}` : ''}
          </p>

          {!readyA.timelineIsReady || !readyB.timelineIsReady ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">Both plans need a timeline before they can be compared.</p>
          ) : null}
          {!readyA.accountsAreReady || !readyA.incomesAreReady || !readyA.expensesAreReady ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Plan A is missing accounts, incomes or expenses; its results will be sparse.
            </p>
          ) : null}
          {!readyB.accountsAreReady || !readyB.incomesAreReady || !readyB.expensesAreReady ? (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Plan B is missing accounts, incomes or expenses; its results will be sparse.
            </p>
          ) : null}

          {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        </div>
      </Card>

      {report ? (
        <>
          <Card>
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Subheading level={4}>Metrics</Subheading>
                <p className={noteClassName}>
                  {planA?.name} <span className="font-medium">vs</span> {planB?.name}
                </p>
              </div>

              {GROUPS.map((group) => {
                const metrics = report.metrics.filter((metric) => metric.group === group.id);
                if (metrics.length === 0) return null;

                return (
                  <div key={group.id} className="space-y-2">
                    <h3 className="text-sm font-semibold text-stone-900 dark:text-white">{group.label}</h3>
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-white/10">
                        <thead>
                          <tr className="text-left text-xs font-semibold tracking-wide text-stone-500 uppercase dark:text-stone-400">
                            <th className="py-2 pr-4 font-semibold">Metric</th>
                            <th className="py-2 pr-4 text-right font-semibold">A</th>
                            <th className="py-2 pr-4 text-right font-semibold">B</th>
                            <th className="py-2 text-right font-semibold">A − B</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100 dark:divide-white/5">
                          {metrics.map((metric) => (
                            <tr key={metric.id}>
                              <td className="py-2 pr-4 text-stone-700 dark:text-stone-300">{metric.label}</td>
                              <td className="py-2 pr-4 text-right tabular-nums">{formatMetric(metric.a, metric.format)}</td>
                              <td className="py-2 pr-4 text-right tabular-nums">{formatMetric(metric.b, metric.format)}</td>
                              <td className={`py-2 text-right font-medium tabular-nums ${deltaClassName(metric)}`}>
                                {formatDelta(metric)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-2">
              <Subheading level={4}>Portfolio value by year</Subheading>
              <p className={noteClassName}>Aligned on the simulation year index; both plans use the same start date.</p>
              <div className="max-h-96 overflow-auto">
                <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-white/10">
                  <thead className="sticky top-0 bg-white dark:bg-stone-900">
                    <tr className="text-left text-xs font-semibold tracking-wide text-stone-500 uppercase dark:text-stone-400">
                      <th className="py-2 pr-4 font-semibold">Year</th>
                      <th className="py-2 pr-4 text-right font-semibold">Age</th>
                      <th className="py-2 pr-4 text-right font-semibold">A</th>
                      <th className="py-2 pr-4 text-right font-semibold">B</th>
                      <th className="py-2 text-right font-semibold">A − B</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-white/5">
                    {report.yearly.map((row) => (
                      <tr key={row.year}>
                        <td className="py-2 pr-4 text-stone-700 dark:text-stone-300">{row.year}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{row.age}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(row.a)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(row.b)}</td>
                        <td
                          className={`py-2 text-right font-medium tabular-nums ${row.delta === 0 ? 'text-stone-500 dark:text-stone-400' : row.delta > 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}
                        >
                          {row.delta > 0 ? '+' : ''}
                          {formatCurrency(row.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
