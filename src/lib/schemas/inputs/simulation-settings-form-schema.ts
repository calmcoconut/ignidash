import { z } from 'zod';

import { isISODateString } from '@/lib/calc/clock';
import { coerceNumber, optionalCoerceNumber } from '@/lib/utils/zod-utils';

/**
 * The simulation modes the app understands.
 *
 * This is a data constant owned by the schema layer, not by the client store: the settings schema,
 * the store and the CLI all read it from here. Keeping the direction one-way (schemas → nothing,
 * store → schemas) is what lets a server function import `simulatorSchema` without dragging
 * `zustand`, `react` or `swr` into its bundle.
 */
export const simulationModes = [
  'fixedReturns',
  'stochasticReturns',
  'historicalReturns',
  'monteCarloStochasticReturns',
  'monteCarloHistoricalReturns',
] as const;

export type SimulationMode = (typeof simulationModes)[number];

/**
 * What a historical backtest does when its horizon reaches past the vendored data.
 *
 * `'looping'` restarts at the oldest vendored year (today's behaviour, and the default: a
 * truncated run would silently shorten the user's horizon). `'truncate'` holds at the last
 * vendored year instead of wrapping, and the result reports `truncatedAtYear` so the UI can say
 * where the data ran out.
 */
export const historicalBacktestModes = ['looping', 'truncate'] as const;

export type HistoricalBacktestMode = (typeof historicalBacktestModes)[number];

export const simulationSettingsSchema = z
  .object({
    simulationSeed: coerceNumber(z.number().positive('Seed must be greater than 0').max(99999, 'Seed must be less than or equal to 99999')),
    simulationMode: z.enum(simulationModes),
    historicalStartYearOverride: optionalCoerceNumber(
      z.number().min(1928, 'Year cannot be before 1928').max(2024, 'Year cannot be after 2024')
    ),
    historicalRetirementStartYearOverride: optionalCoerceNumber(
      z.number().min(1928, 'Year cannot be before 1928').max(2024, 'Year cannot be after 2024')
    ),
    /**
     * Pins the simulation clock (`Clock.asOf`). When omitted, the store resolves the
     * current local date once at the boundary; when set, every run starts from this date,
     * so the same plan produces the same ages and numbers on any day.
     */
    asOfDate: z.string().refine(isISODateString, { message: 'As-of date must be a valid ISO date (YYYY-MM-DD)' }).optional(),
    /**
     * Historical backtest behaviour. Absent means `{ mode: 'looping' }`, so plans saved before this
     * setting existed keep their old (wrapping) behaviour; only the historical modes read it.
     */
    historicalBacktest: z.object({ mode: z.enum(historicalBacktestModes) }).optional(),
  })
  .refine(
    (data) => {
      if (data.simulationMode !== 'historicalReturns') {
        return data.historicalStartYearOverride === undefined && data.historicalRetirementStartYearOverride === undefined;
      }

      return true;
    },
    {
      message: 'Historical start year is only valid for historical simulation mode',
    }
  );

export type SimulationSettingsInputs = z.infer<typeof simulationSettingsSchema>;
