/**
 * The plan-level milestone field: its expression schema and the reference rules (P1-P7).
 *
 * The evaluator and the graph are tested in `src/lib/calc/milestones/`. What is tested here is the
 * *validation*: a dangling reference and a loop are errors rather than silent no-ops, an empty group
 * is legal (and is never met — see `milestones-wiring.test.ts`), and the stored tree is bounded.
 */

import { describe, expect, it } from 'vitest';

import { simulatorSchema } from './simulator-schema';
import {
  MILESTONE_MAX_GROUP_DEPTH,
  milestoneDependencies,
  milestoneExpressionSchema,
  milestoneSchema,
  milestonesSchema,
  type MilestoneInputs,
} from './milestone-form-schema';

/** The smallest plan `simulatorSchema` accepts, so the milestone field is the only variable here. */
const minimalPlan = () => ({
  timeline: null,
  incomes: {},
  accounts: {},
  expenses: {},
  debts: {},
  physicalAssets: {},
  contributionRules: {},
  baseContributionRule: { type: 'save' as const },
  marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
  taxSettings: { filingStatus: 'single' as const },
  privacySettings: { isPrivate: true },
  simulationSettings: { simulationSeed: 12345, simulationMode: 'fixedReturns' as const },
});

const NET_WORTH = { metric: 'netWorth', operator: '>=', value: 1_000_000 } as const;

const justMet = (name: string, references: string[] = []): MilestoneInputs => ({
  id: name.toLowerCase(),
  name,
  condition: NET_WORTH,
  references,
});

/** A condition with `depth` nested `and` groups around one leaf. */
const nested = (depth: number): MilestoneInputs['condition'] => (depth === 0 ? NET_WORTH : { op: 'and', children: [nested(depth - 1)] });

describe('the expression schema', () => {
  it('accepts a leaf, a group, and a group of groups', () => {
    expect(milestoneExpressionSchema.safeParse(NET_WORTH).success).toBe(true);
    expect(milestoneExpressionSchema.safeParse({ op: 'or', children: [NET_WORTH] }).success).toBe(true);
    expect(milestoneExpressionSchema.safeParse({ op: 'and', children: [{ op: 'or', children: [NET_WORTH] }] }).success).toBe(true);
    // An empty group is legal on purpose: a half-built condition must be saveable, and the evaluator
    // answers `false` for it rather than firing it.
    expect(milestoneExpressionSchema.safeParse({ op: 'and', children: [] }).success).toBe(true);
  });

  it('rejects an unknown metric or operator, so the schema cannot drift from the evaluator', () => {
    expect(milestoneExpressionSchema.safeParse({ metric: 'aportfolio', operator: '>=', value: 1 }).success).toBe(false);
    expect(milestoneExpressionSchema.safeParse({ metric: 'netWorth', operator: '=>', value: 1 }).success).toBe(false);
    expect(milestoneExpressionSchema.safeParse({ op: 'xor', children: [] }).success).toBe(false);
  });

  it('requires an account id on an account comparison', () => {
    expect(milestoneExpressionSchema.safeParse({ metric: 'account', operator: '>=', value: 1 }).success).toBe(false);
    expect(milestoneExpressionSchema.safeParse({ metric: 'account', accountId: '', operator: '>=', value: 1 }).success).toBe(false);
    expect(milestoneExpressionSchema.safeParse({ metric: 'account', accountId: '401k', operator: '>=', value: 1 }).success).toBe(true);
    // A non-account metric carries no account at all.
    expect(milestoneExpressionSchema.safeParse({ metric: 'age', operator: '>=', value: 65 }).success).toBe(true);
  });

  it('bounds the nesting at three groups, which is what the stored shape can carry', () => {
    expect(milestoneExpressionSchema.safeParse(nested(MILESTONE_MAX_GROUP_DEPTH)).success).toBe(true);
    expect(milestoneExpressionSchema.safeParse(nested(MILESTONE_MAX_GROUP_DEPTH + 1)).success).toBe(false);
  });
});

describe('the milestone schema', () => {
  it('accepts a complete milestone and keeps its references', () => {
    const parsed = milestoneSchema.parse(justMet('Retire', ['other']));

    expect(parsed).toStrictEqual({ id: 'retire', name: 'Retire', condition: NET_WORTH, references: ['other'] });
  });

  it('requires a name of at least two characters, like its neighbours', () => {
    expect(milestoneSchema.safeParse({ id: 'a', name: 'A', condition: NET_WORTH, references: [] }).success).toBe(false);
    expect(milestoneSchema.safeParse({ id: 'a', name: 'AB', condition: NET_WORTH, references: [] }).success).toBe(true);
  });
});

describe('the plan-level reference rules', () => {
  it('accepts an acyclic plan, including one milestone that depends on another', () => {
    const parsed = milestonesSchema.safeParse([justMet('Pay off mortgage'), justMet('Sell rental', ['pay off mortgage'])]);

    expect(parsed.success).toBe(true);
  });

  it('rejects a reference to a milestone the plan does not contain', () => {
    const parsed = milestonesSchema.safeParse([justMet('Sell rental', ['nonexistent'])]);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toStrictEqual([
      {
        code: 'custom',
        path: [0, 'references', 0],
        message: 'No milestone has the id "nonexistent"; a milestone can only depend on one that exists',
      },
    ]);
  });

  it('rejects a two-milestone loop and names the loop in plan order', () => {
    const parsed = milestonesSchema.safeParse([justMet('Alpha', ['beta']), justMet('Beta', ['alpha'])]);

    expect(parsed.success).toBe(false);
    const issues = parsed.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    // The message is the loop the user has to break, closed: names, not ids, and the first name
    // repeated at the end.
    expect(issues[0].path).toStrictEqual([0, 'references']);
    expect(issues[0].message).toBe('These milestones depend on each other in a loop: Alpha → Beta → Alpha');
  });

  it('rejects a self-reference, which is a loop of one', () => {
    const parsed = milestonesSchema.safeParse([justMet('Alpha', ['alpha'])]);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe('These milestones depend on each other in a loop: Alpha → Alpha');
  });

  it('rejects a duplicate id, which would silently lose the second milestone`s edges', () => {
    const parsed = milestonesSchema.safeParse([justMet('Alpha'), justMet('Alpha')]);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toStrictEqual([{ code: 'custom', path: [1, 'id'], message: 'Two milestones share the id "alpha"' }]);
  });

  it('maps a plan`s milestones to the graph`s own shape', () => {
    expect(milestoneDependencies([justMet('Alpha', ['beta'])])).toStrictEqual([{ id: 'alpha', name: 'Alpha', references: ['beta'] }]);
  });
});

describe('the plan field', () => {
  it('is optional, so a plan written before milestones existed still parses', () => {
    expect(simulatorSchema.parse(minimalPlan())).not.toHaveProperty('milestones');
  });

  it('carries milestones through the plan schema, with the reference rules applied', () => {
    const withMilestones = { ...minimalPlan(), milestones: [justMet('Alpha', ['beta']), justMet('Beta')] };
    const parsed = simulatorSchema.safeParse(withMilestones);

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.milestones).toHaveLength(2);

    // The same plan with a loop is refused by the *plan* schema, not only by the list's own parse:
    // this is the boundary the form, the headless runner and the import path share.
    const cyclic = simulatorSchema.safeParse({ ...withMilestones, milestones: [justMet('Alpha', ['beta']), justMet('Beta', ['alpha'])] });
    expect(cyclic.success).toBe(false);
    expect(cyclic.error?.issues[0].message).toContain('Alpha → Beta → Alpha');
  });
});
