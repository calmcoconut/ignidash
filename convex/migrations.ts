import { Migrations } from '@convex-dev/migrations';

import { components, internal } from './_generated/api';
import { DataModel } from './_generated/dataModel';
import { backfillPatch } from './utils/household_backfill';

export const migrations = new Migrations<DataModel>(components.migrations);

export const run = migrations.runner();

// Runs all pending migrations in order. Called automatically during selfhost upgrades.
// Append new migrations to the end of this array — never remove entries.
export const runAll = migrations.runner([internal.migrations.migrateIncomeIdsToIncomeId, internal.migrations.backfillOwnerAndHousehold]);

export const migrateIncomeIdsToIncomeId = migrations.define({
  table: 'plans',
  migrateOne: async (ctx, plan) => {
    const updatedRules = plan.contributionRules.map((rule) => {
      const { incomeIds, ...rest } = rule;
      return {
        ...rest,
        incomeId: incomeIds?.[0],
      };
    });
    return { contributionRules: updatedRules };
  },
});

/**
 * Gives every stored plan an explicit owner and household (parity plan P1-P2).
 *
 * Additive and idempotent: `backfillPatch` returns `undefined` once a plan already carries
 * everything, so a second run writes nothing and leaves the documents byte-identical. It never
 * overwrites an existing `owner`, `propertyRegime` or `household` — a `partner` or `joint` item
 * a user already tagged survives untouched, and so does a two-member household.
 *
 * The readers already default (`owner ?? 'primary'`, missing household = one person), so this
 * migration changes no number and no behaviour; it makes the stored data say what the readers
 * assume before P1-P3 reads ownership for real.
 */
export const backfillOwnerAndHousehold = migrations.define({
  table: 'plans',
  migrateOne: async (_ctx, plan) => backfillPatch(plan),
});
