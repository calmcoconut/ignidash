import { v } from 'convex/values';

export const simulationSettingsValidator = v.object({
  simulationSeed: v.number(),
  simulationMode: v.union(
    v.literal('fixedReturns'),
    v.literal('stochasticReturns'),
    v.literal('historicalReturns'),
    v.literal('monteCarloStochasticReturns'),
    v.literal('monteCarloHistoricalReturns')
  ),
  historicalStartYearOverride: v.optional(v.number()),
  historicalRetirementStartYearOverride: v.optional(v.number()),
  // Pins the simulation clock (`Clock.asOf`): a `YYYY-MM-DD` calendar date. Optional so
  // plans saved before clock injection keep loading; the ISO-date rule itself lives in
  // `simulationSettingsSchema` (Convex validators have no pattern check).
  asOfDate: v.optional(v.string()),
});
