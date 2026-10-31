import { v, type Infer } from 'convex/values';

import { ownerValidator, propertyRegimeValidator } from './household_validator';

const expenseTimePointValidator = v.object({
  type: v.union(
    v.literal('now'),
    v.literal('atRetirement'),
    v.literal('atLifeExpectancy'),
    v.literal('customDate'),
    v.literal('customAge')
  ),
  month: v.optional(v.number()),
  year: v.optional(v.number()),
  age: v.optional(v.number()),
  everyNYears: v.optional(v.number()),
  recurrenceYears: v.optional(v.number()),
});

export const expenseValidator = v.object({
  id: v.string(),
  name: v.string(),
  amount: v.number(),
  frequency: v.union(
    v.literal('yearly'),
    v.literal('oneTime'),
    v.literal('quarterly'),
    v.literal('monthly'),
    v.literal('biweekly'),
    v.literal('weekly')
  ),
  timeframe: v.object({
    start: expenseTimePointValidator,
    end: v.optional(expenseTimePointValidator),
  }),
  growth: v.optional(
    v.object({
      growthRate: v.optional(v.number()),
      growthLimit: v.optional(v.number()),
    })
  ),
  // real (today's dollars, default) | nominal (dollars of the event's own date)
  amountBasis: v.optional(v.union(v.literal('real'), v.literal('nominal'))),
  // Whose item this is (P1-P2). Absent means `primary`.
  owner: v.optional(ownerValidator),
  propertyRegime: v.optional(propertyRegimeValidator),
  // Essential spending (P1-P4). Optional so plans saved before it keep loading; absent means
  // `false`, which is what every expense was before the flag existed.
  essential: v.optional(v.boolean()),
  // Qualified medical expense (R5). Optional; absent means `false`.
  qualifiedMedical: v.optional(v.boolean()),
  // Qualified charitable distribution / satisfy from IRA (R6, IRC §408(d)(8)). Optional; absent means `false`.
  satisfyFromIra: v.optional(v.boolean()),
  disabled: v.boolean(),
});

export type ExpenseTimePoint = Infer<typeof expenseTimePointValidator>;

export const expenseTimeFrameForDisplay = (startTimePoint: ExpenseTimePoint, endTimePoint?: ExpenseTimePoint) => {
  function labelFromType(tp: ExpenseTimePoint) {
    switch (tp.type) {
      case 'now':
        return 'Now';
      case 'atRetirement':
        return 'Retirement';
      case 'atLifeExpectancy':
        return 'Life Expectancy';
      case 'customDate': {
        const month = tp.month;
        const year = tp.year;
        if (month !== undefined && year !== undefined) {
          const formatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
          return formatter.format(new Date(year, month - 1));
        }
        return 'Custom Date';
      }
      case 'customAge': {
        if (tp.age !== undefined) return `Age ${tp.age}`;
        return 'Custom Age';
      }
    }
  }

  // A cadence is part of the label: "Age 45" alone would read as a continuous stream.
  function withRecurrence(label: string, tp: ExpenseTimePoint): string {
    if (tp.everyNYears === undefined) return label;
    return `${label} (${tp.everyNYears === 1 ? 'every year' : `every ${tp.everyNYears} yrs`})`;
  }

  const startLabel = withRecurrence(labelFromType(startTimePoint), startTimePoint);
  const endLabel = endTimePoint ? labelFromType(endTimePoint) : undefined;

  return endLabel ? `${startLabel} → ${endLabel}` : startLabel;
};
