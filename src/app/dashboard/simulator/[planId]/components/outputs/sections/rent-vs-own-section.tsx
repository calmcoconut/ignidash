'use client';

import { useMemo, useState } from 'react';
import { Legend, Line, LineChart, Tooltip, XAxis } from 'recharts';

import { Button } from '@/components/catalyst/button';
import { Input } from '@/components/catalyst/input';
import { Description, Field, FieldGroup, Fieldset, Label, Legend as FieldLegend } from '@/components/catalyst/fieldset';
import SectionContainer from '@/components/ui/section-container';
import { type ISODateString } from '@/lib/calc/clock';
import { buildHousingChoice, type BuildHousingChoiceArgs } from '@/lib/calc/housing-choice';
import { compareHousing, type HousingComparisonReport, type HousingYear } from '@/lib/calc/housing-comparison';
import type { SingleSimulationMode } from '@/lib/calc/simulate';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';
import { useSimulationClock } from '@/lib/stores/simulator-store';
import type { TableColumn } from '@/lib/types/table-column';
import { useChartTheme } from '@/hooks/use-chart-theme';
import { useChartInterval } from '@/hooks/use-chart-interval';
import { formatCompactCurrency, formatCurrency } from '@/lib/utils/number-formatters';

import ChartCard from '../cards/chart-card';
import { ChartEmptyState, ChartGrid, TimeSeriesChartContainer, TimeSeriesYAxis, TooltipEntryRow } from '../charts/chart-primitives';
import Table from '../tables/table';

interface RentVsOwnSectionProps {
  /** The plan's validated inputs — the same object the page's own projection is computed from. */
  inputs: SimulatorInputs;
  /** The mode the page's headline projection used, named in the disclosure when it is not deterministic. */
  simulationMode: SingleSimulationMode;
}

/**
 * The disclosure this card owes its reader (AGENTS.md trap 7: two surfaces, one number).
 *
 * `compareHousing()` is called with `mode: 'fixedReturns'` and `seed: 1` here, whatever the plan is
 * set to, so on a stochastic or historical plan the numbers are NOT the page's headline result.
 */
const DETERMINISTIC_DISCLOSURE =
  'This comparison always re-runs the plan with deterministic fixed returns and seed 1, so its numbers can differ from the projection above.';

/**
 * The base plan must not already own the home being compared (`compareHousing` documents this).
 * The section cannot remove it, so it says so whenever the plan has one.
 */
const PRIMARY_RESIDENCE_WARNING =
  'This plan already has a primary residence. The comparison adds a second home on top of it, so the owning path holds both.';

/** The trigger's label while the engine works; the comparison is synchronous, so this must be visible. */
const RUNNING_LABEL = 'Comparing…';

const TRIGGER_LABEL = 'Compare renting and owning';

/**
 * The price, stated next to the trigger: pressing it is two full runs of the whole plan, one per
 * path, so it is only calculated when asked for.
 */
const COST_NOTE =
  'It runs two full simulations of this plan, one owning the home and one renting. It is only calculated when you ask for it.';

const REQUIRED_MESSAGE = 'Enter the home price and the monthly rent to run the comparison.';

/**
 * The form as the reader types it. Strings, because a half-typed number is not a number yet. Blank
 * optional fields take the builder's defaults; the two required fields must be numbers.
 */
interface HousingForm {
  residencePrice: string;
  monthlyRent: string;
  downPaymentPercent: string;
  interestRatePercent: string;
  termYears: string;
  appreciationRatePercent: string;
  propertyTaxRatePercent: string;
  maintenanceRatePercent: string;
  rentRealGrowthRatePercent: string;
}

const INITIAL_FORM: HousingForm = {
  residencePrice: '500000',
  monthlyRent: '2500',
  downPaymentPercent: '20',
  interestRatePercent: '6.5',
  termYears: '30',
  appreciationRatePercent: '3',
  propertyTaxRatePercent: '',
  maintenanceRatePercent: '',
  rentRealGrowthRatePercent: '',
};

/** A blank or non-numeric field is `undefined`, which the builder reads as "use the default". */
function parseOptional(text: string): number | undefined {
  if (text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
}

/** Builds the arguments the builder takes from the form, or `null` when a required field is not a number. */
function toBuildArgs(form: HousingForm): BuildHousingChoiceArgs | null {
  const residencePrice = parseOptional(form.residencePrice);
  const monthlyRent = parseOptional(form.monthlyRent);
  if (residencePrice === undefined || monthlyRent === undefined || Number.isNaN(residencePrice) || Number.isNaN(monthlyRent)) {
    return null;
  }

  const termYears = parseOptional(form.termYears);
  const downPaymentPercent = parseOptional(form.downPaymentPercent);
  const interestRatePercent = parseOptional(form.interestRatePercent);
  const appreciationRatePercent = parseOptional(form.appreciationRatePercent);
  const propertyTaxRatePercent = parseOptional(form.propertyTaxRatePercent);
  const maintenanceRatePercent = parseOptional(form.maintenanceRatePercent);
  const rentRealGrowthRatePercent = parseOptional(form.rentRealGrowthRatePercent);

  return {
    residencePrice,
    monthlyRent,
    downPaymentPercent,
    interestRatePercent,
    termMonths: termYears === undefined ? undefined : termYears * 12,
    appreciationRatePercent,
    propertyTaxRatePercent,
    maintenanceRatePercent,
    rentRealGrowthRatePercent,
  };
}

/** What the reader asked for, carried with the exact plan, clock pin and form it was asked for. */
interface RentVsOwnAnalysis {
  inputs: SimulatorInputs;
  asOf: ISODateString;
  form: HousingForm;
  /** `null` when the comparison could not be made; `error` then says why. */
  report: HousingComparisonReport | null;
  error: string | null;
}

/** One rendered row of the table, one per year of the comparison. */
interface RentVsOwnRow extends Record<string, unknown> {
  yearIndex: number;
  age: number;
  calendarYear: number;
  owningNetWorth: number;
  rentingNetWorth: number;
  difference: number;
}

/** One point of the chart: the two net worth paths by age. */
interface RentVsOwnChartPoint extends Record<string, unknown> {
  age: number;
  owningNetWorth: number;
  rentingNetWorth: number;
}

/** Columns are props-free, so they live outside the component and keep one formatter stack. */
const COLUMNS: TableColumn<RentVsOwnRow>[] = [
  { key: 'age', title: 'Age', format: (value) => String(Math.round(Number(value))) },
  { key: 'calendarYear', title: 'Year', format: (value) => String(value) },
  { key: 'owningNetWorth', title: 'Owning net worth', format: (value) => formatCurrency(Number(value)) },
  { key: 'rentingNetWorth', title: 'Renting net worth', format: (value) => formatCurrency(Number(value)) },
  { key: 'difference', title: 'Owning minus renting', format: (value) => formatCurrency(Number(value)) },
];

const OWNING_COLOR = 'var(--chart-1)';
const RENTING_COLOR = 'var(--chart-2)';

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

const formatAge = (age: number): string => String(Math.round(age));

/**
 * The one-sentence answer, from the report's winner and its two break-even fields.
 *
 * `breakEven` is the year owning is ahead and stays ahead; `firstAhead` is the first year owning is
 * ahead at all. A lead that was given back is reported as such, not as a break-even.
 */
function headlineSentence(report: HousingComparisonReport): string {
  const { finalWinner, breakEven, firstAhead } = report;

  if (finalWinner === 'tie') return 'Owning and renting finish level at the end of the plan.';

  if (finalWinner === 'owning' && breakEven !== null) {
    return `Owning pulls ahead at age ${formatAge(breakEven.age)} (${breakEven.calendarYear}) and stays ahead.`;
  }

  if (firstAhead !== null) {
    return `Owning was ahead from age ${formatAge(firstAhead.age)} (${firstAhead.calendarYear}), but renting is ahead again by the end of the plan.`;
  }

  return 'Renting stays ahead through the plan.';
}

const toTableRow = (year: HousingYear): RentVsOwnRow => ({
  yearIndex: year.yearIndex,
  age: year.age,
  calendarYear: year.calendarYear,
  owningNetWorth: year.owning.netWorth,
  rentingNetWorth: year.renting.netWorth,
  difference: year.deltaNetWorth,
});

const toChartPoint = (year: HousingYear): RentVsOwnChartPoint => ({
  age: year.age,
  owningNetWorth: year.owning.netWorth,
  rentingNetWorth: year.renting.netWorth,
});

interface HousingTooltipProps {
  active?: boolean;
  label?: number;
  payload?: ReadonlyArray<{ name?: string; value?: number; dataKey?: string | number; color?: string }>;
}

/** Ages, values and the two series' names, with no calendar year: the year would need the wall clock. */
function HousingTooltip({ active, label, payload }: HousingTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className="text-foreground bg-background rounded-lg border p-2 shadow-md">
      <p className="mx-1 mb-2 text-sm font-semibold">Age {formatAge(Number(label))}</p>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => (
          <TooltipEntryRow
            key={String(entry.dataKey)}
            dataKey={entry.name ?? String(entry.dataKey)}
            color={entry.color ?? 'var(--foreground)'}
            formattedValue={formatCurrency(Number(entry.value))}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Owning and renting net worth by age, two lines on one axis.
 *
 * The table beside it carries the same rows: a chart without a table is an accessibility regression
 * (AGENTS.md §3, "Add a chart"). The chart is kept deliberately plain: the same grid, axes and
 * containers as the other single-simulation charts, with a legend and a tooltip that reads the
 * same values as the table.
 */
function RentVsOwnChart({ data }: { data: RentVsOwnChartPoint[] }) {
  const { foregroundMutedColor, foregroundColor } = useChartTheme();
  const interval = useChartInterval(data.length);

  if (data.length === 0) return <ChartEmptyState message="No years to compare." />;

  return (
    <TimeSeriesChartContainer>
      <LineChart
        responsive
        width="100%"
        height="100%"
        data={data}
        className="text-xs"
        margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
        tabIndex={-1}
      >
        <ChartGrid />
        <XAxis
          dataKey="age"
          type="number"
          domain={['dataMin', 'dataMax']}
          allowDecimals={false}
          interval={interval}
          tick={{ fill: foregroundMutedColor }}
          axisLine={false}
          tickLine={false}
        />
        <TimeSeriesYAxis formatter={(value: number) => formatCompactCurrency(value, 1)} />
        <Line type="monotone" dataKey="owningNetWorth" name="Owning" stroke={OWNING_COLOR} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="rentingNetWorth" name="Renting" stroke={RENTING_COLOR} strokeWidth={2} dot={false} />
        <Legend />
        <Tooltip content={<HousingTooltip />} cursor={{ stroke: foregroundColor }} />
      </LineChart>
    </TimeSeriesChartContainer>
  );
}

/** Card chrome every state shares: the disclosure and the primary-residence caveat sit above whatever the body is. */
function RentVsOwnCard({
  modeLabel,
  hasPrimaryResidence,
  children,
}: {
  modeLabel: string | null;
  hasPrimaryResidence: boolean;
  children: React.ReactNode;
}) {
  return (
    <SectionContainer showBottomBorder className="mb-0">
      <ChartCard title="Rent vs Own" subtitle="Net worth">
        <p className="text-muted-foreground mb-2 text-sm">
          {DETERMINISTIC_DISCLOSURE}
          {modeLabel === null ? '' : ` The projection above uses this plan's ${modeLabel} instead.`}
        </p>
        {hasPrimaryResidence && <p className="text-foreground mb-4 text-sm font-semibold">{PRIMARY_RESIDENCE_WARNING}</p>}
        {children}
      </ChartCard>
    </SectionContainer>
  );
}

/**
 * Rent versus own for the selected plan: one home bought with a mortgage against renting a similar
 * home, both paths run through the same plan, with the break-even year and the net worth by age.
 *
 * This is a bespoke section, like the sensitivity section: the comparison is two full simulations
 * and a table of its own rows, which the age-indexed chart registry does not describe.
 *
 * ## Why the comparison runs on request
 *
 * `compareHousing()` is two synchronous full simulations, and the results page mounts this section
 * unconditionally, so computing it on mount would make the page wait for it. It runs only once the
 * reader presses the trigger. The handler yields one macrotask first so the "Comparing…" state
 * paints before the engine blocks the thread.
 *
 * The result is dropped when the plan or the clock pin changes, so the headline and table can never
 * describe a plan the reader has since edited. The form itself is local state and is not part of
 * that check: editing a field keeps the last result on screen until the comparison is run again.
 *
 * `asOf` comes from the store's single clock boundary, `useSimulationClock`, as the sensitivity
 * section's does.
 */
export default function RentVsOwnSection({ inputs, simulationMode }: RentVsOwnSectionProps) {
  const clock = useSimulationClock(inputs);
  const [form, setForm] = useState<HousingForm>(INITIAL_FORM);
  const [analysis, setAnalysis] = useState<RentVsOwnAnalysis | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  // A result only describes the screen while it carries the same `inputs` object, clock pin and form:
  // an edited field would otherwise leave a headline describing assumptions no longer shown.
  const liveAnalysis =
    analysis !== null && analysis.inputs === inputs && analysis.asOf === clock.asOf && analysis.form === form ? analysis : null;

  const hasPrimaryResidence = useMemo(
    () => Object.values(inputs.physicalAssets).some((asset) => asset.assetType === 'primaryResidence'),
    [inputs.physicalAssets]
  );

  const setField = (field: keyof HousingForm) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [field]: event.target.value }));

  const runAnalysis = async () => {
    setIsRunning(true);
    // Yield once so the disabled trigger paints; the comparison itself is synchronous.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const asOf = clock.asOf;
    const args = toBuildArgs(form);

    if (args === null) {
      setAnalysis({ inputs, asOf, form, report: null, error: REQUIRED_MESSAGE });
      setIsRunning(false);
      return;
    }

    try {
      const choice = buildHousingChoice(args);
      const report = compareHousing(inputs, choice, { asOf, seed: 1, mode: 'fixedReturns' });
      setAnalysis({ inputs, asOf, form, report, error: null });
    } catch (error) {
      // The engine throws for a choice it cannot fund or a term it cannot price. The message is the
      // engine's own and says what to change, so it is shown rather than replaced with a generic one.
      setAnalysis({
        inputs,
        asOf,
        form,
        report: null,
        error: error instanceof Error ? error.message : 'The comparison could not be calculated for this plan.',
      });
    }
    setIsRunning(false);
  };

  const modeLabel = headlineModeLabel(simulationMode);
  const report = liveAnalysis?.report ?? null;

  const rows = useMemo<RentVsOwnRow[]>(() => (report === null ? [] : report.years.map(toTableRow)), [report]);
  const chartData = useMemo<RentVsOwnChartPoint[]>(() => (report === null ? [] : report.years.map(toChartPoint)), [report]);

  const formElement = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void runAnalysis();
      }}
      className="mb-4"
    >
      <Fieldset>
        <FieldLegend className="sr-only">Home and rent</FieldLegend>
        <FieldGroup>
          <Field>
            <Label htmlFor="rvo-residence-price">Home price</Label>
            <Input
              id="rvo-residence-price"
              name="residencePrice"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={form.residencePrice}
              onChange={setField('residencePrice')}
            />
          </Field>
          <Field>
            <Label htmlFor="rvo-monthly-rent">Monthly rent</Label>
            <Input
              id="rvo-monthly-rent"
              name="monthlyRent"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={form.monthlyRent}
              onChange={setField('monthlyRent')}
            />
          </Field>
          <Field>
            <Label htmlFor="rvo-down-payment">Down payment (%)</Label>
            <Input
              id="rvo-down-payment"
              name="downPaymentPercent"
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="any"
              value={form.downPaymentPercent}
              onChange={setField('downPaymentPercent')}
            />
          </Field>
          <Field>
            <Label htmlFor="rvo-interest-rate">Mortgage rate (%)</Label>
            <Input
              id="rvo-interest-rate"
              name="interestRatePercent"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={form.interestRatePercent}
              onChange={setField('interestRatePercent')}
            />
          </Field>
          <Field>
            <Label htmlFor="rvo-term-years">Mortgage term (years)</Label>
            <Input
              id="rvo-term-years"
              name="termYears"
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={form.termYears}
              onChange={setField('termYears')}
            />
          </Field>
          <Field>
            <Label htmlFor="rvo-appreciation">Home appreciation (% a year, real)</Label>
            <Input
              id="rvo-appreciation"
              name="appreciationRatePercent"
              type="number"
              inputMode="decimal"
              step="any"
              value={form.appreciationRatePercent}
              onChange={setField('appreciationRatePercent')}
            />
          </Field>
        </FieldGroup>
      </Fieldset>

      <details className="mt-4">
        <summary className="text-muted-foreground cursor-pointer text-sm font-semibold">Optional assumptions</summary>
        <Fieldset className="mt-3">
          <FieldGroup>
            <Field>
              <Label htmlFor="rvo-property-tax">Property tax (% of assessed value)</Label>
              <Description>Blank uses Prop 13&apos;s default rate.</Description>
              <Input
                id="rvo-property-tax"
                name="propertyTaxRatePercent"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={form.propertyTaxRatePercent}
                onChange={setField('propertyTaxRatePercent')}
              />
            </Field>
            <Field>
              <Label htmlFor="rvo-maintenance">Maintenance and insurance (% of value a year)</Label>
              <Description>Blank uses 1%.</Description>
              <Input
                id="rvo-maintenance"
                name="maintenanceRatePercent"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={form.maintenanceRatePercent}
                onChange={setField('maintenanceRatePercent')}
              />
            </Field>
            <Field>
              <Label htmlFor="rvo-rent-growth">Rent real growth (% a year)</Label>
              <Description>Blank keeps rent flat in real terms.</Description>
              <Input
                id="rvo-rent-growth"
                name="rentRealGrowthRatePercent"
                type="number"
                inputMode="decimal"
                step="any"
                value={form.rentRealGrowthRatePercent}
                onChange={setField('rentRealGrowthRatePercent')}
              />
            </Field>
          </FieldGroup>
        </Fieldset>
      </details>

      <div className="mt-4">
        <p className="text-muted-foreground mb-4 text-sm">{COST_NOTE}</p>
        <Button outline type="submit" disabled={isRunning}>
          {isRunning ? RUNNING_LABEL : TRIGGER_LABEL}
        </Button>
      </div>
    </form>
  );

  if (liveAnalysis === null) {
    return (
      <RentVsOwnCard modeLabel={modeLabel} hasPrimaryResidence={hasPrimaryResidence}>
        {formElement}
      </RentVsOwnCard>
    );
  }

  if (report === null) {
    return (
      <RentVsOwnCard modeLabel={modeLabel} hasPrimaryResidence={hasPrimaryResidence}>
        {formElement}
        <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-400">
          {liveAnalysis.error}
        </p>
      </RentVsOwnCard>
    );
  }

  return (
    <RentVsOwnCard modeLabel={modeLabel} hasPrimaryResidence={hasPrimaryResidence}>
      {formElement}
      <p className="text-foreground mb-4 text-base font-semibold">{headlineSentence(report)}</p>
      <div className="mb-4 h-72">
        <RentVsOwnChart data={chartData} />
      </div>
      <Table<RentVsOwnRow>
        columns={COLUMNS}
        data={rows}
        keyField="yearIndex"
        // The table is the chart's own rows, so it shows every year rather than a page of them: the
        // reader compares the whole horizon, and the pager would pad the last page with empty rows.
        showPagination={false}
        exportFilename="rent-vs-own.csv"
        className="mx-0 my-0 border-0 shadow-none sm:border-0"
      />
    </RentVsOwnCard>
  );
}
