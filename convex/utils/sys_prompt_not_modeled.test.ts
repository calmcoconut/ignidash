/**
 * The "Not Modeled" lists in the AI system prompts must not claim the engine lacks a feature it
 * now computes. Each list is read out of the rendered prompt, not out of the source, so an edit to
 * the template that reintroduces a false item fails here.
 *
 * Covered variants: the base chat prompt (`getSystemPrompt`) and the insights prompt
 * (`getInsightsSystemPrompt`). The tax-optimization skill is appended to the base prompt, so it
 * is covered by the base variant; the skill text itself carries no "Not Modeled" list.
 */

import { describe, expect, it } from 'vitest';

import { getInsightsSystemPrompt, getSystemPrompt } from './sys_prompt_utils';
import type { Doc } from '../_generated/dataModel';

/** A plan just complete enough for both prompt builders to render. */
function makePlanDoc(): Doc<'plans'> {
  return {
    _id: 'not-modeled-plan-id' as unknown as Doc<'plans'>['_id'],
    _creationTime: 0,
    userId: 'test-user',
    name: 'Not Modeled Plan',
    isDefault: true,
    timeline: {
      birthMonth: 1,
      birthYear: 1990,
      lifeExpectancy: 87,
      retirementStrategy: { type: 'fixedAge', retirementAge: 65 },
    },
    incomes: [],
    expenses: [],
    debts: [],
    physicalAssets: [],
    accounts: [],
    contributionRules: [],
    baseContributionRule: { type: 'save' },
    marketAssumptions: { stockReturn: 9, stockYield: 2, bondReturn: 4, bondYield: 3.5, cashReturn: 3, inflationRate: 3 },
    taxSettings: { filingStatus: 'single' },
    privacySettings: { isPrivate: true },
    simulationSettings: { simulationMode: 'fixedReturns', simulationSeed: 1 },
  } as Doc<'plans'>;
}

/** The "Not Modeled" paragraph: from its heading to the blank line after it. */
function notModeledList(prompt: string): string {
  const start = prompt.indexOf('**Not Modeled');
  expect(start).toBeGreaterThan(-1);
  const end = prompt.indexOf('\n\n', start);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

// Items the engine models (see the code citations in the PR). Naming any of them as not modelled
// is the false claim this file exists to stop.
const MODELLED_FEATURES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Roth conversions', pattern: /roth conversion/i },
  { name: 'SEPP / 72(t)', pattern: /SEPP|72\(t\)/i },
  { name: 'self-employment income', pattern: /self-employment/i },
  { name: 'itemized deductions', pattern: /itemiz/i },
  { name: 'pensions', pattern: /pension/i },
];

// Items that really are unmodelled. The list must still name them, so the paragraph cannot pass
// by being deleted or renamed.
const STILL_UNMODELLED = ['529/ABLE', 'annuities', 'estate planning', 'child-in-care', 'other than California'] as const;

// `getInsightsSystemPrompt` takes a SimulationResult and KeyMetrics; both are optional in
// practice (the builders render "none" for null), so null is passed on purpose.
const VARIANTS: readonly { name: string; prompt: string }[] = [
  { name: 'base chat prompt', prompt: getSystemPrompt(makePlanDoc(), null) },
  {
    name: 'insights prompt',
    prompt: getInsightsSystemPrompt(makePlanDoc(), null as never, null as never, undefined),
  },
];

describe.each(VARIANTS)('Not Modeled list in the $name', ({ prompt }) => {
  it('is present, and still names the items that are unmodelled', () => {
    const list = notModeledList(prompt);
    for (const item of STILL_UNMODELLED) expect(list).toContain(item);
  });

  it.each(MODELLED_FEATURES)('does not name $name as unmodelled', ({ pattern }) => {
    expect(notModeledList(prompt)).not.toMatch(pattern);
  });
});

describe('SEPP exception line in the insights prompt', () => {
  const line = getInsightsSystemPrompt(makePlanDoc(), null as never, null as never, undefined)
    .split('\n')
    .find((l) => l.includes('**SEPP/72(t):**'));

  it('exists', () => {
    expect(line).toBeDefined();
  });

  it('does not say SEPP is not modeled', () => {
    expect(line).not.toMatch(/not modeled/i);
  });

  it('says the simulator models SEPP schedules', () => {
    expect(line).toMatch(/simulator models/i);
  });
});
