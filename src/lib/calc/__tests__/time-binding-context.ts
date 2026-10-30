/**
 * The time-binding context a unit test passes when it is not testing time-bound amounts.
 *
 * The entity constructors (`Income`, `Expense`, `Debt`, `PhysicalAsset` and their collections)
 * require a `TimeBindingContext`, because the context is what converts a `nominal` amount into
 * the plan's real dollars. Omitting it used to mean "treat everything as real", which is a wrong
 * number with no symptom — exactly the trap that making the argument required closes.
 *
 * Tests that never touch `amountBasis: 'nominal'` still have to say which plan start they mean.
 * This constant is the honest answer: the plan starts at age 35 on 2025-01-01 with **zero
 * inflation**, so a nominal amount converts 1:1 (the cumulative index is 1 for every year) and
 * the numbers are byte-for-byte what they were when the argument was omitted.
 *
 * A test that needs a real inflation path, or a different start date, passes its own context at
 * the call site: that context is what the test is about, so it should be visible where it is used
 * rather than defaulted somewhere else.
 */

import type { TimeBindingContext } from '../time-binding';

export const TEST_TIME_BINDING_CONTEXT: TimeBindingContext = {
  startAge: 35,
  startDate: new Date(2025, 0, 1),
  marketAssumptions: {
    stockReturn: 9,
    stockYield: 2,
    bondReturn: 4,
    bondYield: 3.5,
    cashReturn: 3,
    inflationRate: 0,
  },
};
