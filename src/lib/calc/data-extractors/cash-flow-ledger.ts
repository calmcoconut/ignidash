/**
 * Annual cash-flow ledger and Sankey derivation.
 *
 * Built entirely from the existing annual `SimulationDataPoint`s. No engine change is
 * involved: every number here is a sum of fields the simulation already reports.
 *
 * HAZARD — `returns.yieldAmounts` is a TAX-REPORTING OVERLAY ONLY. Dividends and
 * interest are already inside `applyReturns`, so they never move a balance and must
 * never be treated as cash. This ledger never reads `yieldAmounts`; investment returns
 * are reported as a separate, explicitly non-cash "reinvested" node.
 */

import { sumFlows } from '@/lib/calc/asset';
import type { SimulationDataPoint } from '@/lib/calc/simulation-engine';
import { SimulationDataExtractor } from './simulation-data-extractor';

/**
 * WHY THE LEDGER CARRIES TWO NODES THE PLAN DOES NOT LIST.
 *
 * The plan's node list is incomes, asset-sale proceeds and portfolio withdrawals (in),
 * and expenses, taxes/penalties, debt payments, purchases and contributions (out). This
 * engine adds two more, and neither is optional:
 *
 * 1. `unfundedSpending` (inflow) copies `portfolio.shortfall`. The engine records a
 *    shortfall as `remainingToWithdraw` *after every account has been drained*, so it is
 *    spending the hub pays out without any cash arriving. Without this node a plan that
 *    runs out of money draws more out of the hub than it puts in, and the Sankey shows an
 *    unexplained gap.
 * 2. `shortfallRepaid` (outflow) copies `portfolio.shortfallRepaid`, which is
 *    `min(netCashFlow, outstandingShortfall)`: the surplus that went to repay an earlier
 *    shortfall instead of being contributed. It is a real quantity, not a plug.
 *
 * WARNING TO THE NEXT IMPLEMENTER - IN A SHORTFALL YEAR THE CASH IDENTITY IS DEGENERATE.
 * Because `unfundedSpending` is *defined* as the gap, `totalInflows - totalOutflows ~= 0`
 * holds BY CONSTRUCTION, in exactly the years that matter. A green conservation test on a
 * shortfall year therefore proves the plug works; it does NOT prove the ledger reconciles.
 * Do not "simplify" the plug away, and do not read a passing test as evidence that cash
 * balanced. `cash-flow-ledger.test.ts` pins the plug to the engine's own
 * `portfolio.shortfall` value and asserts that the identity *with the plug excluded*
 * equals `-shortfall`; that is the assertion that proves nothing else hides in the
 * residual.
 */

/** Cash inflows of one year. */
export interface CashFlowLedgerInflows {
  /** Gross income from every income source. */
  income: number;
  /** Employer contributions paid directly into the portfolio (not household cash). */
  employerMatch: number;
  /** Amount withdrawn from the portfolio. */
  portfolioWithdrawals: number;
  /** Proceeds from physical-asset sales. */
  assetSaleProceeds: number;
  /**
   * Spending the portfolio could not fund: the engine's `portfolio.shortfall`, copied
   * verbatim. It is an unfunded liability, not income, and it is the plug that makes the
   * cash identity degenerate in shortfall years (see the note above this interface).
   */
  unfundedSpending: number;
}

/** Cash outflows of one year. */
export interface CashFlowLedgerOutflows {
  expenses: number;
  taxesAndPenalties: number;
  /** Loan and debt payments, interest included. */
  debtPayments: number;
  /** Cash paid for physical assets. */
  assetPurchases: number;
  /** Amount contributed to the portfolio, including the employer-matched portion (which enters as an inflow). */
  contributions: number;
  /**
   * Surplus applied to repay a previously unfunded shortfall: the engine's
   * `portfolio.shortfallRepaid` (`min(netCashFlow, outstandingShortfall)`), copied
   * verbatim. A real quantity, unlike `inflows.unfundedSpending`.
   */
  shortfallRepaid: number;
}

/** One year of the cash-flow ledger. */
export interface AnnualCashFlowLedger {
  age: number;
  /** Calendar year label taken from the data point's ISO date (no clock read). */
  yearLabel: string;
  inflows: CashFlowLedgerInflows;
  outflows: CashFlowLedgerOutflows;
  /** Investment returns during the year. Never cash: they are reinvested in place. */
  returns: number;
  /** Physical-asset appreciation during the year. Not a cash flow either. */
  appreciation: number;
  /** Interest accrued on loans and debts during the year. */
  debtInterest: number;
  netWorth: number;
  netWorthChange: number;
  /** inflow total minus outflow total; ≈ 0 when the ledger is complete. */
  cashResidual: number;
  /** Operating cash net: income + employer match − expenses − taxes. */
  cashNet: number;
  /** netWorthChange − (cashNet + returns + appreciation − debtInterest + unfunded − repaid). */
  reconciliationResidual: number;
}

const totalInflows = (inflows: CashFlowLedgerInflows): number =>
  inflows.income + inflows.employerMatch + inflows.portfolioWithdrawals + inflows.assetSaleProceeds + inflows.unfundedSpending;

const totalOutflows = (outflows: CashFlowLedgerOutflows): number =>
  outflows.expenses +
  outflows.taxesAndPenalties +
  outflows.debtPayments +
  outflows.assetPurchases +
  outflows.contributions +
  outflows.shortfallRepaid;

/** Net worth of a single annual data point (portfolio + assets − debts). */
export function netWorthOf(dataPoint: SimulationDataPoint): number {
  const { netWorth } = SimulationDataExtractor.getAssetsAndLiabilitiesData(dataPoint);
  return netWorth;
}

/** Calendar year label from an ISO date string, without constructing a Date. */
const yearLabelOf = (isoDate: string): string => isoDate.slice(0, 4);

/**
 * Derives the annual cash-flow ledger from a simulation's annual data points.
 *
 * The first data point is the pre-simulation snapshot: it carries balances but no
 * flows, so it only supplies the opening net worth used by the first year's
 * reconciliation.
 *
 * @param data - Annual simulation data points
 * @returns One ledger entry per simulated year
 */
export function extractAnnualCashFlowLedger(data: readonly SimulationDataPoint[]): AnnualCashFlowLedger[] {
  const entries: AnnualCashFlowLedger[] = [];

  for (let index = 1; index < data.length; index++) {
    const dataPoint = data[index];
    const previous = data[index - 1];

    const portfolio = dataPoint.portfolio;
    const incomes = dataPoint.incomes;
    const expenses = dataPoint.expenses;
    const debts = dataPoint.debts;
    const physicalAssets = dataPoint.physicalAssets;

    const { totalTaxesAndPenalties } = SimulationDataExtractor.getTaxAmountsByType(dataPoint);

    const inflows: CashFlowLedgerInflows = {
      income: incomes?.totalIncome ?? 0,
      employerMatch: portfolio.employerMatch,
      portfolioWithdrawals: sumFlows(portfolio.withdrawals),
      assetSaleProceeds: physicalAssets?.totalSaleProceeds ?? 0,
      unfundedSpending: portfolio.shortfall,
    };

    const outflows: CashFlowLedgerOutflows = {
      expenses: expenses?.totalExpenses ?? 0,
      taxesAndPenalties: totalTaxesAndPenalties,
      debtPayments: (debts?.totalPayment ?? 0) + (physicalAssets?.totalLoanPayment ?? 0),
      assetPurchases: physicalAssets?.totalPurchaseOutlay ?? 0,
      contributions: sumFlows(portfolio.contributions),
      shortfallRepaid: portfolio.shortfallRepaid,
    };

    const returnsData = dataPoint.returns;
    const returns = returnsData ? returnsData.returnAmounts.stocks + returnsData.returnAmounts.bonds + returnsData.returnAmounts.cash : 0;

    const appreciation = physicalAssets?.totalAppreciation ?? 0;
    const debtInterest = (debts?.totalInterest ?? 0) + (physicalAssets?.totalInterest ?? 0);

    const netWorth = netWorthOf(dataPoint);
    const netWorthChange = netWorth - netWorthOf(previous);

    const cashNet = inflows.income + inflows.employerMatch - outflows.expenses - outflows.taxesAndPenalties;
    const reconciliationResidual =
      netWorthChange - (cashNet + returns + appreciation - debtInterest + inflows.unfundedSpending - outflows.shortfallRepaid);

    entries.push({
      age: Math.floor(dataPoint.age),
      yearLabel: yearLabelOf(dataPoint.date),
      inflows,
      outflows,
      returns,
      appreciation,
      debtInterest,
      netWorth,
      netWorthChange,
      cashResidual: totalInflows(inflows) - totalOutflows(outflows),
      cashNet,
      reconciliationResidual,
    });
  }

  return entries;
}

/**
 * Picks the ledger year for a selected age, falling back to the nearest year so a
 * selection outside the ledger's range still renders something truthful.
 *
 * @param ledger - Ledger entries
 * @param age - Selected age
 * @returns The matching (or nearest) entry, or `undefined` when the ledger is empty
 */
export function ledgerEntryForAge(ledger: readonly AnnualCashFlowLedger[], age: number): AnnualCashFlowLedger | undefined {
  const exact = ledger.find((entry) => entry.age === age);
  if (exact) return exact;
  return ledger.reduce<AnnualCashFlowLedger | undefined>((closest, entry) => {
    if (!closest) return entry;
    return Math.abs(entry.age - age) < Math.abs(closest.age - age) ? entry : closest;
  }, undefined);
}

// ================================
// SANKEY
// ================================

/** What a Sankey node represents. `reinvested` nodes are deliberately not cash. */
export type CashFlowSankeyNodeKind = 'inflow' | 'outflow' | 'hub' | 'reinvested';

export interface CashFlowSankeyNode {
  name: string;
  color: string;
  kind: CashFlowSankeyNodeKind;
}

/** Recharts `Sankey` link: indices into `nodes`. */
export interface CashFlowSankeyLink {
  source: number;
  target: number;
  value: number;
}

export interface CashFlowSankeyData {
  nodes: CashFlowSankeyNode[];
  links: CashFlowSankeyLink[];
}

const NODE_COLORS = {
  inflow: 'var(--chart-1)',
  withdrawal: 'var(--chart-2)',
  sale: 'var(--chart-3)',
  match: 'var(--chart-4)',
  unfunded: 'var(--chart-5)',
  hub: 'var(--foreground)',
  expenses: 'var(--chart-6)',
  taxes: 'var(--chart-7)',
  debt: 'var(--chart-8)',
  purchases: 'var(--chart-1)',
  contributions: 'var(--chart-2)',
  repayment: 'var(--chart-5)',
  returns: 'var(--chart-3)',
  reinvested: 'var(--muted-foreground)',
} as const;

interface DraftLink {
  source: CashFlowSankeyNode;
  target: CashFlowSankeyNode;
  value: number;
}

const node = (name: string, color: string, kind: CashFlowSankeyNodeKind): CashFlowSankeyNode => ({ name, color, kind });

/**
 * Builds the per-year Sankey graph.
 *
 * Inflows (income, portfolio withdrawals, asset-sale proceeds, employer match and any
 * unfunded spending) feed one hub; the hub pays expenses, taxes and penalties, debt
 * payments, asset purchases, contributions and any shortfall repayment. Investment
 * returns are a separate pair of nodes — "Investment returns" → "Reinvested returns" —
 * so a reinvested return can never be mistaken for cash.
 *
 * @param entry - One year of the cash-flow ledger
 * @returns Nodes and links, dropping every zero-valued flow
 */
export function buildCashFlowSankey(entry: AnnualCashFlowLedger): CashFlowSankeyData {
  const hub = node('Cash available', NODE_COLORS.hub, 'hub');

  const drafts: DraftLink[] = [
    { source: node('Income', NODE_COLORS.inflow, 'inflow'), target: hub, value: entry.inflows.income },
    { source: node('Portfolio withdrawals', NODE_COLORS.withdrawal, 'inflow'), target: hub, value: entry.inflows.portfolioWithdrawals },
    { source: node('Asset sale proceeds', NODE_COLORS.sale, 'inflow'), target: hub, value: entry.inflows.assetSaleProceeds },
    { source: node('Employer match', NODE_COLORS.match, 'inflow'), target: hub, value: entry.inflows.employerMatch },
    // Not in the plan's node list: the plug for spending no account could fund. It is
    // what makes the cash identity degenerate in shortfall years - see the note above
    // `CashFlowLedgerInflows` before touching or removing it.
    { source: node('Unfunded spending', NODE_COLORS.unfunded, 'inflow'), target: hub, value: entry.inflows.unfundedSpending },

    { source: hub, target: node('Expenses', NODE_COLORS.expenses, 'outflow'), value: entry.outflows.expenses },
    { source: hub, target: node('Taxes & penalties', NODE_COLORS.taxes, 'outflow'), value: entry.outflows.taxesAndPenalties },
    { source: hub, target: node('Debt payments', NODE_COLORS.debt, 'outflow'), value: entry.outflows.debtPayments },
    { source: hub, target: node('Asset purchases', NODE_COLORS.purchases, 'outflow'), value: entry.outflows.assetPurchases },
    { source: hub, target: node('Contributions', NODE_COLORS.contributions, 'outflow'), value: entry.outflows.contributions },
    // Not in the plan's node list: surplus that repaid an earlier shortfall instead of
    // being contributed. A real quantity (`min(netCashFlow, outstandingShortfall)`).
    { source: hub, target: node('Shortfall repayment', NODE_COLORS.repayment, 'outflow'), value: entry.outflows.shortfallRepaid },

    {
      source: node('Investment returns', NODE_COLORS.returns, 'inflow'),
      target: node('Reinvested returns', NODE_COLORS.reinvested, 'reinvested'),
      value: entry.returns,
    },
  ];

  const positive = drafts.filter((draft) => draft.value > 0);

  // Keep only nodes that participate in at least one surviving link, then reindex.
  const nodes: CashFlowSankeyNode[] = [];
  const indexOf = new Map<CashFlowSankeyNode, number>();
  const links: CashFlowSankeyLink[] = [];

  const indexFor = (sankeyNode: CashFlowSankeyNode): number => {
    const existing = indexOf.get(sankeyNode);
    if (existing !== undefined) return existing;
    const next = nodes.push(sankeyNode) - 1;
    indexOf.set(sankeyNode, next);
    return next;
  };

  for (const draft of positive) {
    links.push({ source: indexFor(draft.source), target: indexFor(draft.target), value: draft.value });
  }

  return { nodes, links };
}

/** Total of every inflow node of a ledger year (Sankey source side). */
export function totalLedgerInflows(entry: AnnualCashFlowLedger): number {
  return totalInflows(entry.inflows);
}

/** Total of every outflow node of a ledger year (Sankey destination side). */
export function totalLedgerOutflows(entry: AnnualCashFlowLedger): number {
  return totalOutflows(entry.outflows);
}
