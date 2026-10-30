import { describe, it, expect } from 'vitest';

import {
  buildCashFlowSankey,
  extractAnnualCashFlowLedger,
  ledgerEntryForAge,
  netWorthOf,
  totalLedgerInflows,
  totalLedgerOutflows,
  type AnnualCashFlowLedger,
} from './cash-flow-ledger';
import { ChartDataExtractor } from './chart-data-extractor';
import { FinancialSimulationEngine } from '../simulation-engine';
import { FixedReturnsProvider } from '../returns-providers/fixed-returns-provider';
import {
  TEST_CLOCK,
  create401kAccount,
  createContributionRule,
  createDebtInput,
  createFinancedAssetInput,
  createLivingExpense,
  createSavingsAccount,
  createSimulatorInputs,
  createWageIncome,
} from '../__tests__/test-utils';
import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

/**
 * The plan's tolerance for both identities. The engine's own tax loop converges to
 * within $1 (`TAX_CONVERGENCE_THRESHOLD`), so small residuals are expected and are
 * asserted to stay below it rather than to be exactly zero.
 */
const TOLERANCE = 1;

function runSimulation(inputs: SimulatorInputs) {
  return new FinancialSimulationEngine(inputs, TEST_CLOCK).runSimulation(new FixedReturnsProvider(inputs), inputs.timeline!);
}

/** Wage earner with savings, a 401k match, a mortgaged house, a rental bought and sold, and a credit card. */
function buildRichSimulation() {
  return runSimulation(
    createSimulatorInputs({
      incomes: { salary: createWageIncome({ amount: 150000 }) },
      expenses: { living: createLivingExpense({ amount: 60000 }) },
      accounts: {
        savings: createSavingsAccount({ balance: 50000 }),
        retirement: create401kAccount({ balance: 200000 }),
      },
      contributionRules: {
        rule: createContributionRule({
          accountId: '401k-1',
          contributionType: 'percentRemaining',
          percentRemaining: 20,
          employerMatch: 5000,
        }),
      },
      physicalAssets: {
        residence: createFinancedAssetInput({}),
        rental: createFinancedAssetInput({
          id: 'asset-2',
          name: 'Rental',
          purchaseDate: { type: 'customAge', age: 45 },
          purchasePrice: 300000,
          marketValue: 300000,
          saleDate: { type: 'customAge', age: 50 },
          paymentMethod: { type: 'loan', downPayment: 60000, loanBalance: 240000, apr: 5, monthlyPayment: 1400 },
        }),
      },
      debts: { card: createDebtInput({}) },
    })
  );
}

/** Spending far above income: the portfolio runs dry and the engine records unfunded shortfalls. */
function buildShortfallSimulation() {
  return runSimulation(
    createSimulatorInputs({
      incomes: { salary: createWageIncome({ amount: 30000 }) },
      expenses: { living: createLivingExpense({ amount: 90000 }) },
      accounts: { savings: createSavingsAccount({ balance: 20000 }) },
      contributionRules: { rule: createContributionRule({ accountId: 'savings-1', contributionType: 'unlimited' }) },
      debts: { card: createDebtInput({}) },
    })
  );
}

/**
 * Runs a shortfall for years and then recovers with a windfall, so the real
 * `shortfallRepaid` path (`min(netCashFlow, outstandingShortfall)`) is exercised at scale
 * and not just left at zero by the never-recovers fixture.
 */
function buildRecoverThenRepaySimulation() {
  return runSimulation(
    createSimulatorInputs({
      incomes: {
        salary: createWageIncome({ amount: 20000 }),
        windfall: createWageIncome({
          id: 'income-2',
          name: 'Windfall',
          amount: 600000,
          frequency: 'oneTime',
          timeframe: { start: { type: 'customAge', age: 41 }, end: undefined },
        }),
      },
      expenses: { living: createLivingExpense({ amount: 90000 }) },
      accounts: { savings: createSavingsAccount({ balance: 10000 }), retirement: create401kAccount({ balance: 100000 }) },
      contributionRules: { rule: createContributionRule({ accountId: '401k-1', contributionType: 'unlimited' }) },
      debts: { card: createDebtInput({}) },
    })
  );
}

/** Retiree living off withdrawals, including RMDs and a sale at life expectancy. */
function buildRetirementSimulation() {
  return runSimulation(
    createSimulatorInputs({
      timeline: { lifeExpectancy: 87, birthMonth: 1, birthYear: 1990, retirementStrategy: { type: 'fixedAge', retirementAge: 55 } },
      incomes: { salary: createWageIncome({ amount: 120000 }) },
      expenses: { living: createLivingExpense({ amount: 50000 }) },
      accounts: {
        retirement: create401kAccount({ balance: 900000 }),
        savings: createSavingsAccount({ balance: 100000 }),
      },
      contributionRules: { rule: createContributionRule({ accountId: '401k-1', contributionType: 'unlimited' }) },
    })
  );
}

describe('annual cash-flow ledger', () => {
  it('derives one entry per simulated year, skipping the pre-simulation snapshot', () => {
    const simulation = buildRichSimulation();
    const ledger = extractAnnualCashFlowLedger(simulation.data);

    expect(ledger).toHaveLength(simulation.data.length - 1);
    expect(ledger[0].age).toBe(Math.floor(simulation.data[1].age));
    expect(ledger[0].yearLabel).toMatch(/^\d{4}$/);
  });

  it('returns nothing for a result with no completed year', () => {
    const simulation = buildRichSimulation();
    expect(extractAnnualCashFlowLedger(simulation.data.slice(0, 1))).toEqual([]);
  });

  it('picks the exact ledger year, or the nearest one', () => {
    const ledger = extractAnnualCashFlowLedger(buildRichSimulation().data);
    const target = ledger[3];

    expect(ledgerEntryForAge(ledger, target.age)).toBe(target);
    expect(ledgerEntryForAge(ledger, ledger[0].age - 5)).toBe(ledger[0]);
    expect(ledgerEntryForAge([], 40)).toBeUndefined();
  });
});

describe('cash conservation', () => {
  it('balances inflows against outflows every year for an accumulating household', () => {
    const ledger = extractAnnualCashFlowLedger(buildRichSimulation().data);
    expect(ledger.length).toBeGreaterThan(0);

    for (const entry of ledger) {
      expect(Math.abs(entry.cashResidual), `age ${entry.age} residual ${entry.cashResidual}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('balances inflows against outflows every year for a household living off withdrawals', () => {
    const ledger = extractAnnualCashFlowLedger(buildRetirementSimulation().data);

    for (const entry of ledger) {
      expect(Math.abs(entry.cashResidual), `age ${entry.age} residual ${entry.cashResidual}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('books unfunded spending as an explicit inflow so a bankrupt plan still balances', () => {
    const ledger = extractAnnualCashFlowLedger(buildShortfallSimulation().data);
    const withShortfall = ledger.filter((entry) => entry.inflows.unfundedSpending > 0);
    expect(withShortfall.length).toBeGreaterThan(0);

    for (const entry of ledger) {
      expect(Math.abs(entry.cashResidual), `age ${entry.age} residual ${entry.cashResidual}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('uses the same line items the cash-flow chart already reports', () => {
    // Parity guard: the ledger must not invent its own definitions of expenses, taxes,
    // debt payments, purchases or sale proceeds.
    const simulation = buildRichSimulation();
    const ledger = extractAnnualCashFlowLedger(simulation.data);
    const chartData = ChartDataExtractor.extractSingleSimulationCashFlowData(simulation);

    expect(chartData).toHaveLength(ledger.length);
    for (const [index, entry] of ledger.entries()) {
      const point = chartData[index];
      expect(entry.outflows.expenses).toBeCloseTo(point.expenses, 6);
      expect(entry.outflows.taxesAndPenalties).toBeCloseTo(point.taxesAndPenalties, 6);
      expect(entry.outflows.debtPayments).toBeCloseTo(point.debtPayments, 6);
      expect(entry.outflows.assetPurchases).toBeCloseTo(point.assetPurchaseOutlay, 6);
      expect(entry.inflows.assetSaleProceeds).toBeCloseTo(point.assetSaleProceeds, 6);
      expect(entry.inflows.income).toBeCloseTo(point.income, 6);
    }
  });
});

// ============================================================================
// THE UNFUNDED-SPENDING PLUG (test integrity, not behaviour)
// ============================================================================

/**
 * Ledger totals with the emergency plugs left OUT, spelled out field by field.
 *
 * `inflows.unfundedSpending` is the engine's `portfolio.shortfall` — the gap itself — so
 * including it makes `totalInflows - totalOutflows ~= 0` true BY CONSTRUCTION in every
 * shortfall year. These helpers measure the ledger without that plug, which is the only
 * way to show the plug absorbs the whole gap and nothing else hides in the residual.
 * `outflows.shortfallRepaid` stays in: it is a real quantity, not a plug.
 */
const cashInflowsWithoutPlug = (entry: AnnualCashFlowLedger): number =>
  entry.inflows.income + entry.inflows.employerMatch + entry.inflows.portfolioWithdrawals + entry.inflows.assetSaleProceeds;

/** Net worth change with both plug terms (`+ unfunded - repaid`) left out. */
const reconciliationWithoutPlugs = (entry: AnnualCashFlowLedger): number =>
  entry.netWorthChange - (entry.cashNet + entry.returns + entry.appreciation - entry.debtInterest);

describe('unfunded spending plug', () => {
  // A plan that never recovers, plus one that recovers and repays, so both the plug and
  // the real repayment path are exercised.
  const fixtures = () => [buildShortfallSimulation(), buildRecoverThenRepaySimulation()];

  it('copies the plug verbatim from the engine shortfall, in every year', () => {
    for (const simulation of fixtures()) {
      const ledger = extractAnnualCashFlowLedger(simulation.data);
      expect(ledger).toHaveLength(simulation.data.length - 1);

      for (const [index, entry] of ledger.entries()) {
        const dataPoint = simulation.data[index + 1];
        // Same quantity, not merely a similar one: the plug may not drift onto another field.
        expect(entry.inflows.unfundedSpending, `age ${entry.age}`).toBe(dataPoint.portfolio.shortfall);
        expect(entry.outflows.shortfallRepaid, `age ${entry.age}`).toBe(dataPoint.portfolio.shortfallRepaid);
      }

      expect(ledger.some((entry) => entry.inflows.unfundedSpending > 0)).toBe(true);
      expect(ledger.some((entry) => entry.outflows.shortfallRepaid > 0)).toBe(true);
    }
  });

  it('is the only thing absorbing the gap: without it the cash identity equals -shortfall', () => {
    for (const simulation of fixtures()) {
      const ledger = extractAnnualCashFlowLedger(simulation.data);
      let shortfallYears = 0;

      for (const entry of ledger) {
        const residualWithoutPlug = cashInflowsWithoutPlug(entry) - totalLedgerOutflows(entry);

        // residual_without_plug + shortfall === 0, i.e. residual_without_plug === -shortfall
        expect(
          Math.abs(residualWithoutPlug + entry.inflows.unfundedSpending),
          `age ${entry.age}: unplugged residual ${residualWithoutPlug}, shortfall ${entry.inflows.unfundedSpending}`
        ).toBeLessThanOrEqual(TOLERANCE);

        if (entry.inflows.unfundedSpending > TOLERANCE) {
          shortfallYears += 1;
          // The plugged identity closes here; the unplugged one must genuinely fail. Both
          // must hold at once, or a passing test would mean the plug is doing nothing.
          expect(Math.abs(residualWithoutPlug), `age ${entry.age}`).toBeGreaterThan(TOLERANCE);
          expect(Math.abs(entry.cashResidual), `age ${entry.age}`).toBeLessThanOrEqual(TOLERANCE);
        }
      }

      expect(shortfallYears).toBeGreaterThan(0);
    }
  });

  it('is the only thing absorbing the gap in the net-worth reconciliation too', () => {
    for (const simulation of fixtures()) {
      const ledger = extractAnnualCashFlowLedger(simulation.data);

      for (const entry of ledger) {
        const plugTerms = entry.inflows.unfundedSpending - entry.outflows.shortfallRepaid;

        // Everything the reconciliation gains from the plug is exactly the plug: the
        // unplugged reconciliation residual equals (+unfunded - repaid).
        expect(
          Math.abs(reconciliationWithoutPlugs(entry) - plugTerms),
          `age ${entry.age}: unplugged reconciliation ${reconciliationWithoutPlugs(entry)}, plugs ${plugTerms}`
        ).toBeLessThanOrEqual(TOLERANCE);

        if (Math.abs(plugTerms) > TOLERANCE) {
          expect(Math.abs(reconciliationWithoutPlugs(entry)), `age ${entry.age}`).toBeGreaterThan(TOLERANCE);
          expect(Math.abs(entry.reconciliationResidual), `age ${entry.age}`).toBeLessThanOrEqual(TOLERANCE);
        }
      }
    }
  });

  it('keeps the identity genuine when nothing is unfunded', () => {
    // Contrast case: with no plug in play the unplugged identity is the real one, and it
    // still closes on its own.
    const ledger = extractAnnualCashFlowLedger(buildRichSimulation().data);
    expect(ledger.every((entry) => entry.inflows.unfundedSpending === 0 && entry.outflows.shortfallRepaid === 0)).toBe(true);

    for (const entry of ledger) {
      expect(Math.abs(cashInflowsWithoutPlug(entry) - totalLedgerOutflows(entry)), `age ${entry.age}`).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});

describe('net-worth reconciliation', () => {
  it('reconciles net worth as cash net plus returns, appreciation and interest, every year', () => {
    const ledger = extractAnnualCashFlowLedger(buildRichSimulation().data);

    for (const entry of ledger) {
      expect(
        Math.abs(entry.reconciliationResidual),
        `age ${entry.age} residual ${entry.reconciliationResidual} (ΔNW ${entry.netWorthChange}, cash net ${entry.cashNet}, returns ${entry.returns}, appreciation ${entry.appreciation}, interest ${entry.debtInterest})`
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('reconciles net worth through retirement withdrawals too', () => {
    const ledger = extractAnnualCashFlowLedger(buildRetirementSimulation().data);

    for (const entry of ledger) {
      expect(Math.abs(entry.reconciliationResidual), `age ${entry.age} residual ${entry.reconciliationResidual}`).toBeLessThanOrEqual(
        TOLERANCE
      );
    }
  });

  it('reconciles a plan whose shortfalls are never repaid', () => {
    const ledger = extractAnnualCashFlowLedger(buildShortfallSimulation().data);
    expect(ledger.some((entry) => entry.inflows.unfundedSpending > 0)).toBe(true);

    for (const entry of ledger) {
      expect(Math.abs(entry.reconciliationResidual), `age ${entry.age} residual ${entry.reconciliationResidual}`).toBeLessThanOrEqual(
        TOLERANCE
      );
    }
  });

  it('shows the inflow/outflow identity alone is insufficient when interest accrues', () => {
    // Guards the plan's R14 note: the reconciliation needs its own assertion because
    // interest and appreciation are not flows in the ledger's cash nodes.
    const ledger = extractAnnualCashFlowLedger(buildRichSimulation().data);
    const entry = ledger.find((candidate) => candidate.debtInterest > 0 && candidate.appreciation > 0);
    expect(entry).toBeDefined();
    if (!entry) return;

    const naiveNetWorthIdentity = entry.cashResidual + entry.returns + entry.appreciation;
    expect(Math.abs(naiveNetWorthIdentity - entry.netWorthChange)).toBeGreaterThan(TOLERANCE);
    expect(netWorthOf(buildRichSimulation().data[1])).toBeGreaterThan(0);
  });
});

describe('yields are never cash', () => {
  it('ignores returns.yieldAmounts entirely: inflating them leaves the ledger unchanged', () => {
    const simulation = buildRichSimulation();
    const baseline = extractAnnualCashFlowLedger(simulation.data);

    // Dividend and interest yields are a tax-reporting overlay; dividends and interest are
    // already inside applyReturns. Treating them as cash would double count them, so the
    // ledger must not read them at all.
    const inflated = structuredClone(simulation);
    let inflatedYieldTotal = 0;
    for (const dataPoint of inflated.data) {
      if (!dataPoint.returns) continue;
      for (const category of ['taxable', 'taxDeferred', 'taxFree', 'cashSavings'] as const) {
        dataPoint.returns.yieldAmounts[category].stocks *= 1000;
        dataPoint.returns.yieldAmounts[category].bonds *= 1000;
        dataPoint.returns.yieldAmounts[category].cash *= 1000;
        inflatedYieldTotal +=
          dataPoint.returns.yieldAmounts[category].stocks +
          dataPoint.returns.yieldAmounts[category].bonds +
          dataPoint.returns.yieldAmounts[category].cash;
      }
    }
    expect(inflatedYieldTotal).toBeGreaterThan(0);

    const afterInflation = extractAnnualCashFlowLedger(inflated.data);
    expect(afterInflation).toEqual(baseline);
  });

  it('reports investment returns as their own non-cash figure, not as an inflow', () => {
    const simulation = buildRichSimulation();
    const ledger = extractAnnualCashFlowLedger(simulation.data);
    const entry = ledger.find((candidate) => candidate.returns !== 0);
    expect(entry).toBeDefined();
    if (!entry) return;

    const inflowTotal = totalLedgerInflows(entry);
    expect(inflowTotal).toBeGreaterThan(0);

    // The inflow total is built from income, match, withdrawals, sale proceeds and
    // unfunded spending only; returns are reported separately.
    expect(inflowTotal).toBeCloseTo(
      entry.inflows.income +
        entry.inflows.employerMatch +
        entry.inflows.portfolioWithdrawals +
        entry.inflows.assetSaleProceeds +
        entry.inflows.unfundedSpending,
      6
    );
    expect(entry.cashNet).toBeCloseTo(
      entry.inflows.income + entry.inflows.employerMatch - entry.outflows.expenses - entry.outflows.taxesAndPenalties,
      6
    );
  });

  it('keeps returns out of the Sankey cash nodes and in a separate reinvested node', () => {
    const entry = extractAnnualCashFlowLedger(buildRichSimulation().data).find((candidate) => candidate.returns > 0);
    expect(entry).toBeDefined();
    if (!entry) return;

    const { nodes, links } = buildCashFlowSankey(entry);
    const returnsSource = nodes.findIndex((sankeyNode) => sankeyNode.name === 'Investment returns');
    const returnsSink = nodes.findIndex((sankeyNode) => sankeyNode.name === 'Reinvested returns');
    expect(returnsSource).toBeGreaterThanOrEqual(0);
    expect(returnsSink).toBeGreaterThanOrEqual(0);
    expect(nodes[returnsSink].kind).toBe('reinvested');

    const returnsLink = links.find((link) => link.source === returnsSource && link.target === returnsSink);
    expect(returnsLink?.value).toBeCloseTo(entry.returns, 6);

    // The reinvested node has no link into the cash hub, and no node is named after a yield.
    expect(links.some((link) => link.source === returnsSink)).toBe(false);
    expect(nodes.some((sankeyNode) => /yield/i.test(sankeyNode.name))).toBe(false);
  });
});

describe('Sankey graph', () => {
  const entry = extractAnnualCashFlowLedger(buildRichSimulation().data).find((candidate) => candidate.outflows.contributions > 0);
  if (!entry) throw new Error('fixture produced no contributions');

  it('builds links that reference valid nodes with positive values', () => {
    const { nodes, links } = buildCashFlowSankey(entry);
    expect(nodes.length).toBeGreaterThan(0);
    expect(links.length).toBeGreaterThan(0);

    for (const link of links) {
      expect(link.source).toBeGreaterThanOrEqual(0);
      expect(link.source).toBeLessThan(nodes.length);
      expect(link.target).toBeGreaterThanOrEqual(0);
      expect(link.target).toBeLessThan(nodes.length);
      expect(link.value).toBeGreaterThan(0);
    }
  });

  it('feeds the hub with every cash inflow except reinvested returns', () => {
    const { nodes, links } = buildCashFlowSankey(entry);
    const hubIndex = nodes.findIndex((sankeyNode) => sankeyNode.name === 'Cash available');
    expect(hubIndex).toBeGreaterThanOrEqual(0);

    const hubInflow = links.filter((link) => link.target === hubIndex).reduce((sum, link) => sum + link.value, 0);
    const expected = totalLedgerInflows(entry) - entry.inflows.unfundedSpending;
    expect(hubInflow).toBeCloseTo(expected, 6);
  });

  it('pays every cash outflow from the hub', () => {
    const { nodes, links } = buildCashFlowSankey(entry);
    const hubIndex = nodes.findIndex((sankeyNode) => sankeyNode.name === 'Cash available');
    expect(hubIndex).toBeGreaterThanOrEqual(0);

    const hubOutflow = links.filter((link) => link.source === hubIndex).reduce((sum, link) => sum + link.value, 0);
    expect(hubOutflow).toBeCloseTo(totalLedgerOutflows(entry) - entry.outflows.shortfallRepaid, 6);
  });

  it('omits zero-value flows instead of drawing empty nodes', () => {
    const { nodes, links } = buildCashFlowSankey(entry);
    for (let index = 0; index < nodes.length; index++) {
      expect(links.some((link) => link.source === index || link.target === index)).toBe(true);
    }
  });
});
