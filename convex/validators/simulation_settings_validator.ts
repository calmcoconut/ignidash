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
  // P2-P4 historical backtest mode. Optional so plans saved before it keep loading, and absent
  // means `'looping'` (the pre-P2-P4 behaviour). This validator is part of the export envelope's
  // shape, so the field is only writable *and* importable once it is here.
  historicalBacktest: v.optional(v.object({ mode: v.union(v.literal('looping'), v.literal('truncate')) })),
});
