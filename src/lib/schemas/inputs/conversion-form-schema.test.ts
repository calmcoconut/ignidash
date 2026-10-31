/**
 * The shared conversion rule, pinned directly.
 *
 * `convex/conversion.test.ts` covers everything a payload can reach through the mutation, and the
 * dialog's test covers everything a row can reach through the form. This file covers the two things
 * neither can:
 *
 * 1. **The guards no write path can reach.** `conversionsValidator` is a Convex `v.union` of the amount
 *    shape and the fill-to-bracket shape, so an object carrying *both* targets — or neither — is
 *    rejected by the validator before the handler runs, and the editor's two selects cannot produce
 *    one. The rule still states them, because a total function is what makes the refusal list a
 *    property of the data rather than of whichever caller happens to exist today; the price is that
 *    they can only be falsified here, by calling the rule.
 * 2. **The bracket ladders.** `conversionFillToBracketRates` reads the vendored rulesets rather than
 *    restating them, and these pins are what says so: a new bracket in the tables moves this file,
 *    instead of leaving the editor offering a rate the engine no longer has.
 */
import { describe, expect, it } from 'vitest';

import {
  conversionFillToBracketRates,
  conversionProblem,
  conversionsProblems,
  type ConversionAccountLike,
  type ConversionRuleInput,
} from './conversion-form-schema';

const ACCOUNTS: ConversionAccountLike[] = [
  { id: 'ira-1', name: 'Traditional IRA', type: 'ira' },
  { id: 'roth-1', name: 'Roth IRA', type: 'rothIra' },
  { id: 'brokerage-1', name: 'Brokerage', type: 'taxableBrokerage' },
];

const ACCEPTED: ConversionRuleInput = {
  id: 'conversion-1',
  fromAccountId: 'ira-1',
  toAccountId: 'roth-1',
  year: 2031,
  amount: 40_000,
};

describe('conversionFillToBracketRates', () => {
  it('reads the federal ladder out of the vendored ruleset', () => {
    // 2026's IRC §1 schedule: seven bands, 10% to 37%.
    expect(conversionFillToBracketRates('federal')).toStrictEqual([0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37]);
  });

  it('reads the California ladder out of the vendored ruleset, which is not the federal one', () => {
    // FTB Schedule X/Y/Z: nine bands, 1% to 12.3%. The two ladders share almost nothing, which is why
    // the jurisdiction is part of the target rather than a display detail.
    expect(conversionFillToBracketRates('california')).toStrictEqual([0.01, 0.02, 0.04, 0.06, 0.08, 0.093, 0.103, 0.113, 0.123]);
    expect(conversionFillToBracketRates('california')).not.toContain(0.22);
    // The default is the federal set, which is what an absent `jurisdiction` means to the engine.
    expect(conversionFillToBracketRates()).toStrictEqual(conversionFillToBracketRates('federal'));
  });
});

describe('conversionProblem: the shapes no validator lets through', () => {
  it('accepts a conversion the engine can run', () => {
    expect(conversionProblem(ACCEPTED, ACCOUNTS)).toBeNull();
  });

  it('refuses both targets, which the stored union cannot even express', () => {
    // The engine reads the target to decide the amount, so one of the two would be a field nothing
    // reads — and the direction it picks (`'amount' in conversion`) is an implementation detail.
    expect(conversionProblem({ ...ACCEPTED, fillToBracket: 0.22 }, ACCOUNTS)).toMatch(
      /states both a fixed amount and a fill-to-bracket target/
    );
  });

  it('refuses a conversion with no target at all', () => {
    expect(conversionProblem({ id: 'conversion-1', fromAccountId: 'ira-1', toAccountId: 'roth-1', year: 2031 }, ACCOUNTS)).toMatch(
      /has no target/
    );
  });

  it('refuses an empty id, which the run could not remember as executed', () => {
    expect(conversionProblem({ ...ACCEPTED, id: '  ' }, ACCOUNTS)).toMatch(/has no id/);
  });

  it('refuses a custom date with no year and a year outside the stored range', () => {
    expect(conversionProblem({ ...ACCEPTED, year: undefined, timePoint: { type: 'customDate' } }, ACCOUNTS)).toMatch(
      /is a custom date with no year/
    );
    expect(conversionProblem({ ...ACCEPTED, year: undefined, timePoint: { type: 'customDate', month: 1, year: 2151 } }, ACCOUNTS)).toMatch(
      /whole year between 1900 and 2100/
    );
  });

  it('refuses a custom age outside the stored range, and a bracket rate outside 0–1', () => {
    expect(conversionProblem({ ...ACCEPTED, year: undefined, timePoint: { type: 'customAge', age: 121 } }, ACCOUNTS)).toMatch(
      /whole age between 0 and 120/
    );
    expect(conversionProblem({ ...ACCEPTED, amount: undefined, fillToBracket: 1.5 }, ACCOUNTS)).toMatch(
      /a bracket rate is a decimal between 0 and 1/
    );
  });

  it('refuses a duplicated id, which would fire once between two rows', () => {
    expect(conversionsProblems([ACCEPTED, { ...ACCEPTED, name: 'Second' }], ACCOUNTS)).toStrictEqual([
      { index: 1, problem: expect.stringMatching(/repeats the id conversion-1/) },
    ]);
    expect(conversionsProblems([ACCEPTED], ACCOUNTS)).toStrictEqual([]);
  });
});
