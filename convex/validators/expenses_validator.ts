import { v, type Infer } from 'convex/values';

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

  const startLabel = labelFromType(startTimePoint);
  const endLabel = endTimePoint ? labelFromType(endTimePoint) : undefined;

  return endLabel ? `${startLabel} → ${endLabel}` : startLabel;
};
