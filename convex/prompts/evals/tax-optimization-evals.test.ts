/**
 * The eval set for the tax-optimization skill (§7-A2).
 *
 * These tests only prove the fixtures are usable: every plan validates against the plan schema,
 * every plan produces a baseline through the real toolkit the agent calls, and every rubric check
 * has a rule in the prompt that a reviewer can point at. They never call a provider — a live eval
 * run is described in `README.md` beside this file and is deliberately on demand.
 */

import { describe, expect, it } from 'vitest';

import { createChatToolkit } from '../../chat_tools';
import { simulatorSchema } from '../../../src/lib/schemas/inputs/simulator-schema';
import { TAX_OPTIMIZATION_SKILL_PROMPT } from '../tax-optimization';
import { EVAL_AS_OF, TAX_OPTIMIZATION_EVAL_CHECKS, TAX_OPTIMIZATION_EVALS, type EvalGoal } from './tax-optimization-evals';

/** Every goal the plan names (F1: the user picks one of these, never the agent). */
const GOALS: readonly EvalGoal[] = ['lifetime-taxes', 'ending-net-worth', 'success'];

/** The prompt rule each rubric check is reviewing. A check without a rule here is unenforceable. */
const RULE_FOR_CHECK: Record<string, readonly string[]> = {
  'grounded-numbers': ['**No number without a tool result.**'],
  'goal-first': ['**Settle the goal.**', 'The user ranks variants by one goal they choose'],
  'refused-patches': ['**A refused patch is a refusal, not a puzzle.**', '**Nothing is written.**'],
  'no-writes': ['**Nothing is written.**'],
  'no-recommendation': ['## Stance: rank, never recommend', 'Never say which variant you would pick.'],
  budget: ['**Budget: at most 6 variants and at most 12 tool calls per turn.**'],
  'assumptions-stated': ['**State assumptions and limits.**'],
  'monte-carlo-on-request': ['**Monte Carlo only on request.**'],
};

interface ParsedBaseline {
  error?: string;
  baseline?: { finalPortfolioValue?: unknown; lifetimeTaxesAndPenalties?: unknown };
}

describe('tax-optimization eval set', () => {
  it('has eleven uniquely identified cases', () => {
    expect(TAX_OPTIMIZATION_EVALS).toHaveLength(11);

    const ids = TAX_OPTIMIZATION_EVALS.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sets a goal on every case that the plan allows', () => {
    for (const evalCase of TAX_OPTIMIZATION_EVALS) expect(GOALS).toContain(evalCase.goal);
  });

  it.each(TAX_OPTIMIZATION_EVALS.map((evalCase) => [evalCase.id, evalCase] as const))('validates plan %s', (_id, evalCase) => {
    const parsed = simulatorSchema.safeParse(evalCase.plan);

    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it.each(TAX_OPTIMIZATION_EVALS.map((evalCase) => [evalCase.id, evalCase] as const))(
    'produces a baseline for %s through the real toolkit',
    { timeout: 60_000 },
    (_id, evalCase) => {
      const toolkit = createChatToolkit({ inputs: evalCase.plan, asOf: EVAL_AS_OF });
      const summary = JSON.parse(toolkit.execute('getPlanSummary', {})) as ParsedBaseline;

      expect(summary.error).toBeUndefined();
      expect(typeof summary.baseline?.finalPortfolioValue).toBe('number');
      expect(typeof summary.baseline?.lifetimeTaxesAndPenalties).toBe('number');
      expect(toolkit.callCount()).toBe(1);
    }
  );

  it('covers the shapes the plan requires', () => {
    const ids = TAX_OPTIMIZATION_EVALS.map((evalCase) => evalCase.id);

    expect(ids.some((id) => id.startsWith('single-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mfj-'))).toBe(true);
    expect(ids.some((id) => id.includes('early-retiree'))).toBe(true);
    expect(ids.some((id) => id.includes('high-income') || id.includes('high-earner'))).toBe(true);
  });

  it('covers the separate-return path with exactly one MFS case', () => {
    // P3-P1b prices a separate-return household as two returns, so the fixture has to exercise the
    // split — two members, incomes on their own returns and jointly held (community) accounts — and
    // not merely set the enum value.
    const mfs = TAX_OPTIMIZATION_EVALS.filter((evalCase) => evalCase.plan.taxSettings.filingStatus === 'marriedFilingSeparately');

    expect(mfs.map((evalCase) => evalCase.id)).toEqual(['mfs-couple']);
    expect(mfs[0].plan.timeline?.household?.members).toHaveLength(2);
    expect(Object.values(mfs[0].plan.incomes).map((income) => income?.owner)).toEqual(expect.arrayContaining(['primary', 'partner']));
    expect(Object.values(mfs[0].plan.accounts).map((account) => account?.owner)).toEqual(expect.arrayContaining(['joint']));
    // The lever the separate-return tables make runnable: the same household priced as one return.
    expect(mfs[0].levers.some((lever) => JSON.stringify(lever.planPatch).includes('marriedFilingJointly'))).toBe(true);

    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('married filing separately');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).not.toContain('separately is not available');
  });

  it('prices the MFS case as two returns: filing jointly is a different lifetime tax', () => {
    const mfsCase = TAX_OPTIMIZATION_EVALS.find((evalCase) => evalCase.id === 'mfs-couple');
    if (!mfsCase) throw new Error('the mfs-couple case is missing');

    const toolkit = createChatToolkit({ inputs: mfsCase.plan, asOf: EVAL_AS_OF });
    const summary = JSON.parse(toolkit.execute('getPlanSummary', {})) as {
      baseline?: { lifetimeTaxesAndPenalties?: number };
    };
    // The same household, same clock and seed, with the one setting the separate-return tables change.
    const joint = JSON.parse(
      toolkit.execute('simulateVariant', {
        variantId: 'file-jointly',
        planPatch: { taxSettings: { filingStatus: 'marriedFilingJointly' } },
      })
    ) as { lifetimeTaxes?: { total?: number } };

    const separateLifetime = summary.baseline?.lifetimeTaxesAndPenalties;
    const jointLifetime = joint.lifetimeTaxes?.total;
    expect(typeof separateLifetime).toBe('number');
    expect(typeof jointLifetime).toBe('number');
    // If the engine had ignored the filing status, these would be the same number: that is exactly
    // what a two-returns-per-year path must not do.
    expect(Math.abs((separateLifetime ?? 0) - (jointLifetime ?? 0))).toBeGreaterThan(1);

    // And the state return is settled for it, on the state's own figures rather than a zero stand-in.
    const analytics = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 2030 })) as {
      jurisdictions?: { california?: { reported?: { jurisdiction?: string; total?: number } } };
    };
    expect(analytics.jurisdictions?.california?.reported?.jurisdiction).toBe('CA');
    expect(analytics.jurisdictions?.california?.reported?.total).toBeGreaterThan(0);
  });

  it('names California in the two cases whose state return matters, and the prompt reports it', () => {
    // California is computed (P3-P8) and every plan defaults to California residency, so the state
    // return is part of the numbers in every case; these two say so in their own documents: the
    // high-income household, and the separately filing couple whose community property the state
    // return divides.
    const mentions = TAX_OPTIMIZATION_EVALS.filter((evalCase) => `${evalCase.covers} ${evalCase.request}`.includes('California'));

    expect(mentions.map((evalCase) => evalCase.id)).toEqual(['mfj-high-income', 'mfs-couple']);
    // The prompt points the agent at the settled return, and at the residency flag that separates
    // "no return filed" from "state tax of zero".
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('jurisdictions.california.reported');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('`none` the plan is not a resident');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).not.toContain('do not report a California income tax figure');
  });
});

describe('tax-optimization eval rubric', () => {
  it('has uniquely identified checks', () => {
    const ids = TAX_OPTIMIZATION_EVAL_CHECKS.map((check) => check.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(8);
  });

  it('gives every check a rule in the prompt', () => {
    const checkIds = TAX_OPTIMIZATION_EVAL_CHECKS.map((check) => check.id);

    // No check without a rule, and no rule mapped to a check that does not exist.
    expect(Object.keys(RULE_FOR_CHECK).sort()).toEqual([...checkIds].sort());

    for (const check of TAX_OPTIMIZATION_EVAL_CHECKS) {
      const rules = RULE_FOR_CHECK[check.id];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain(rule);
    }
  });
});
