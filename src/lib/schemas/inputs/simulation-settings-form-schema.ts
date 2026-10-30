import { z } from 'zod';

import { isISODateString } from '@/lib/calc/clock';
import { simulationModes } from '@/lib/stores/simulator-store';
import { coerceNumber, optionalCoerceNumber } from '@/lib/utils/zod-utils';

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
