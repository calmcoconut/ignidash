/**
 * Simulation event annotations (P4-P3).
 *
 * Derives the life events a chart can mark from the annual `SimulationDataPoint`s and
 * nothing else: no plan inputs are read, no simulation number is computed, and the engine
 * is untouched. Every field used here is one the simulation already reports, so a
 * display-only change like this one cannot move the frozen golden corpus.
 *
 * An annotation marks a CHANGE. A wage that is active from the first simulated year, or
 * an expense that never stops, produces no start/end event: nothing about it changes on
 * the chart, so there is nothing to point at. An event that never happens (no debt, no
 * asset sale) produces nothing at all rather than a zero or an `undefined` age.
 *
 * Determinism: ages come from the data points, never from a clock.
 */

import type { SimulationDataPoint } from '@/lib/calc/simulation-engine';

/** What happened. Charts style and filter by this; it is the annotation taxonomy. */
export type SimulationEventKind =
  | 'retirement'
  | 'rmdStart'
  | 'incomeStart'
  | 'incomeEnd'
  | 'expenseStart'
  | 'expenseEnd'
  | 'debtPayoff'
  | 'assetPurchase'
  | 'assetSale';

/**
 * `plan` events shape the whole plan (retirement, RMDs, income and expense boundaries) and
 * survive the density caps first; `instrument` events belong to one debt or asset and are
 * dropped first when a chart would get crowded.
 */
export type SimulationEventScope = 'plan' | 'instrument';

/** One annotation: when it happened, what to call it, and what kind it is. */
export interface SimulationEvent {
  /** Stable, content-derived id (safe as a React key and for de-duplication). */
  id: string;
  kind: SimulationEventKind;
  /** Floored age at which the event happens, matching the chart's x axis. */
  age: number;
  /** Short axis label, e.g. `Retire`. Never a sentence: it is rendered vertically. */
  label: string;
  scope: SimulationEventScope;
  /** Subject name for drill-down text (debt or asset name); never rendered on the axis. */
  detail?: string;
}

/** Short axis labels, one per kind. */
const EVENT_LABELS: Readonly<Record<SimulationEventKind, string>> = {
  retirement: 'Retire',
  rmdStart: 'RMDs',
  incomeStart: 'Income starts',
  incomeEnd: 'Income ends',
  expenseStart: 'Expenses start',
  expenseEnd: 'Expenses end',
  debtPayoff: 'Debt paid off',
  assetPurchase: 'Asset purchase',
  assetSale: 'Asset sale',
};

/** Selection order when events land on the same age (lower wins). */
const KIND_ORDER: readonly SimulationEventKind[] = [
  'retirement',
  'rmdStart',
  'incomeStart',
  'incomeEnd',
  'expenseStart',
  'expenseEnd',
  'debtPayoff',
  'assetSale',
  'assetPurchase',
];

const ageOf = (dataPoint: SimulationDataPoint): number => Math.floor(dataPoint.age);

const hasActiveIncome = (dataPoint: SimulationDataPoint): boolean =>
  Object.values(dataPoint.incomes?.perIncomeData ?? {}).some((income) => income.income !== 0);

const hasActiveExpense = (dataPoint: SimulationDataPoint): boolean =>
  Object.values(dataPoint.expenses?.perExpenseData ?? {}).some((expense) => expense.expense !== 0);

/**
 * Derives the annotatable events of a simulation.
 *
 * @param data - Annual simulation data points, in order (index 0 is the opening snapshot)
 * @returns Events sorted by age, then by kind; empty when nothing happened
 */
export function extractSimulationEvents(data: readonly SimulationDataPoint[]): SimulationEvent[] {
  if (data.length === 0) return [];

  const events: SimulationEvent[] = [];
  const seen = new Set<string>();

  const push = (kind: SimulationEventKind, age: number, subjectId?: string, detail?: string): void => {
    const id = `${kind}:${age}:${subjectId ?? 'plan'}`;
    if (seen.has(id)) return;
    seen.add(id);

    events.push({
      id,
      kind,
      age,
      label: EVENT_LABELS[kind],
      scope: subjectId === undefined ? 'plan' : 'instrument',
      ...(detail === undefined ? {} : { detail }),
    });
  };

  // Index 0 is the opening snapshot: it carries balances but no flows, and its age can floor
  // one year below the first simulated year (ages are fractional). Boundary events therefore
  // compare against the first year that actually has flows.
  const firstFlowAge = ageOf(data[Math.min(1, data.length - 1)]);
  const lastAge = ageOf(data[data.length - 1]);

  // Retirement: the first year the phase changes to retirement.
  const retirement = data.find((dataPoint) => dataPoint.phase?.name === 'retirement');
  if (retirement) push('retirement', ageOf(retirement));

  // RMD start: the first year the engine actually reports required distributions.
  const firstRmd = data.find((dataPoint) => (dataPoint.portfolio.rmds ?? 0) > 0);
  if (firstRmd) push('rmdStart', ageOf(firstRmd));

  // Income / expense windows. A boundary only counts when it changes inside the plan.
  const incomeAges = data.filter(hasActiveIncome).map(ageOf);
  if (incomeAges.length > 0) {
    if (incomeAges[0] > firstFlowAge) push('incomeStart', incomeAges[0]);
    if (incomeAges[incomeAges.length - 1] < lastAge) push('incomeEnd', incomeAges[incomeAges.length - 1]);
  }

  const expenseAges = data.filter(hasActiveExpense).map(ageOf);
  if (expenseAges.length > 0) {
    if (expenseAges[0] > firstFlowAge) push('expenseStart', expenseAges[0]);
    if (expenseAges[expenseAges.length - 1] < lastAge) push('expenseEnd', expenseAges[expenseAges.length - 1]);
  }

  // Debt payoff and asset lifecycle: flows only appear in the year they happen, so a
  // positive value identifies the year. Index 0 is the opening snapshot and is skipped, so
  // something already owned or already paid off before the plan is not an event.
  const purchaseSeen = new Set<string>();
  const saleSeen = new Set<string>();
  const debtPayoffSeen = new Set<string>();
  const openAssetLoans = new Set<string>();

  for (let index = 1; index < data.length; index++) {
    const dataPoint = data[index];
    const age = ageOf(dataPoint);

    for (const debt of Object.values(dataPoint.debts?.perDebtData ?? {})) {
      if (!debt.isPaidOff || debtPayoffSeen.has(debt.id)) continue;
      debtPayoffSeen.add(debt.id);
      push('debtPayoff', age, debt.id, debt.name);
    }

    for (const asset of Object.values(dataPoint.physicalAssets?.perAssetData ?? {})) {
      if (asset.loanBalance > 0) openAssetLoans.add(asset.id);

      if (asset.loanBalance === 0 && openAssetLoans.has(asset.id) && !debtPayoffSeen.has(asset.id)) {
        openAssetLoans.delete(asset.id);
        debtPayoffSeen.add(asset.id);
        push('debtPayoff', age, asset.id, asset.name);
      }

      if ((asset.purchaseOutlay > 0 || asset.purchaseMarketValue > 0) && !purchaseSeen.has(asset.id)) {
        purchaseSeen.add(asset.id);
        push('assetPurchase', age, asset.id, asset.name);
      }

      if ((asset.saleProceeds > 0 || asset.saleMarketValue > 0) && !saleSeen.has(asset.id)) {
        saleSeen.add(asset.id);
        push('assetSale', age, asset.id, asset.name);
      }
    }
  }

  const rank = (kind: SimulationEventKind): number => KIND_ORDER.indexOf(kind);

  return events.sort((a, b) => a.age - b.age || rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id));
}

// ================================
// DENSITY
// ================================

/** One event as a chart should draw it. */
export interface AnnotatedEvent {
  readonly event: SimulationEvent;
  /** Whether this event earns a (vertical) axis label. */
  readonly showLabel: boolean;
}

export interface AnnotationLayoutOptions {
  readonly isSmallScreen: boolean;
}

/**
 * Density limits. Vertical lines are cheap to read; text is not, especially on a phone, so
 * the caps are asymmetric: every relevant event may draw a faint line, only a couple earn
 * a rotated label, and labels are spaced out so two never collide.
 */
const LAYOUT = {
  small: { maxVisible: 7, maxLabels: 2, labelSpacing: 10 },
  large: { maxVisible: 12, maxLabels: 5, labelSpacing: 4 },
} as const;

/**
 * Chooses which events a chart draws and which of them get a label.
 *
 * Pure and deterministic: the same events and the same screen class give the same result.
 * Plan-scope events are kept before instrument-scope ones, so a crowded chart loses a
 * second mortgage payoff before it loses retirement. Instrument events are re-sorted back
 * into age order for drawing.
 *
 * @param events - Events from {@link extractSimulationEvents}
 * @param options - Screen class that sets the density caps
 * @returns The events to draw, in age order, each flagged for labelling or not
 */
export function selectAnnotatedEvents(events: readonly SimulationEvent[], options: AnnotationLayoutOptions): AnnotatedEvent[] {
  const limits = options.isSmallScreen ? LAYOUT.small : LAYOUT.large;

  const planEvents = events.filter((event) => event.scope === 'plan');
  const instrumentEvents = events.filter((event) => event.scope === 'instrument');
  const visible = [...planEvents, ...instrumentEvents].slice(0, limits.maxVisible);
  visible.sort((a, b) => a.age - b.age || a.id.localeCompare(b.id));

  let labelled = 0;
  let lastLabelledAge: number | null = null;

  return visible.map((event) => {
    const spaced = lastLabelledAge === null || event.age - lastLabelledAge >= limits.labelSpacing;
    const showLabel = spaced && labelled < limits.maxLabels;

    if (showLabel) {
      labelled += 1;
      lastLabelledAge = event.age;
    }

    return { event, showLabel };
  });
}
