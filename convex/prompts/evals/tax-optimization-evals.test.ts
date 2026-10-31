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
  it('has ten uniquely identified cases', () => {
    expect(TAX_OPTIMIZATION_EVALS).toHaveLength(10);

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

  it('deliberately has no MFS case: the set predates the separate-return tables', () => {
    // The engine prices a separate return now (P3-P1b) and the prompt says so, so an MFS fixture is
    // computable; this set simply has none yet. The assertion keeps the gap named rather than
    // implying coverage the fixtures do not have.
    for (const evalCase of TAX_OPTIMIZATION_EVALS) {
      expect(['single', 'marriedFilingJointly', 'headOfHousehold']).toContain(String(evalCase.plan.taxSettings.filingStatus));
    }

    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('married filing separately');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).not.toContain('separately is not available');
  });

  it('deliberately has no California case: only federal rules are computed', () => {
    // The one mention of California is a user's claim in a request, and that case is documented as
    // federal-only, so nothing in the set asserts a state-tax number.
    const mentions = TAX_OPTIMIZATION_EVALS.filter((evalCase) => `${evalCase.covers} ${evalCase.request}`.includes('California'));

    expect(mentions.map((evalCase) => evalCase.id)).toEqual(['mfj-high-income']);
    expect(mentions[0].covers).toContain('no CA return');
    // The prompt states the limit as the analytics reports it: the California section is marked
    // pending, so no California income tax figure may be quoted.
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('do not report a California income tax figure');
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
