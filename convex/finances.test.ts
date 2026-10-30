// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Infer } from 'convex/values';

import { api } from './_generated/api';
import schema from './schema';
import { basicTemplate } from './templates/basic';
import { assetValidator } from './validators/asset_validator';
import { liabilityValidator } from './validators/liability_validator';

// SAFETY: Vitest transforms `import.meta.glob` at test time. The augmentation for it
// ships with `vite/client`, and referencing that from here would make `vite` an
// unlisted dependency, so the transform's shape is declared locally instead.
const modules = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('./**/*.ts');

const TEST_USER = 'test-user-123';

type Asset = Infer<typeof assetValidator>;
type Liability = Infer<typeof liabilityValidator>;

function makePlan(overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId: TEST_USER, name: 'Test Plan', ...overrides };
}

const IMPORTED_AT = 1_700_000_000_000;

const ASSETS: Asset[] = [
  { id: 'asset-1', name: 'Brokerage', value: 5000, type: 'taxableBrokerage', updatedAt: IMPORTED_AT },
  { id: 'asset-2', name: 'Savings', value: 1200, type: 'savings', updatedAt: IMPORTED_AT },
];

const LIABILITIES: Liability[] = [{ id: 'liability-1', name: 'Mortgage', balance: 250000, type: 'mortgage', updatedAt: IMPORTED_AT }];

describe('replaceAllFinances', () => {
  it('refuses to replace anything without explicit confirmation', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('finances', {
        userId: TEST_USER,
        assets: [{ id: 'kept', name: 'Kept', value: 1, type: 'savings', updatedAt: 1 }],
        liabilities: [],
      });
    });

    const asUser = t.withIdentity({ subject: TEST_USER });
    await expect(
      asUser.mutation(api.finances.replaceAllFinances, { assets: ASSETS, liabilities: LIABILITIES, confirmReplace: false })
    ).rejects.toThrow('explicit confirmation');

    await t.run(async (ctx) => {
      const finances = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      expect(finances!.assets.map((asset) => asset.id)).toEqual(['kept']);
    });
  });

  it('replaces the tracker and preserves the stored timestamps', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert('finances', {
        userId: TEST_USER,
        assets: [{ id: 'old', name: 'Old', value: 1, type: 'savings', updatedAt: 1 }],
        liabilities: [],
      });
    });

    const asUser = t.withIdentity({ subject: TEST_USER });
    await asUser.mutation(api.finances.replaceAllFinances, { assets: ASSETS, liabilities: LIABILITIES, confirmReplace: true });

    await t.run(async (ctx) => {
      const finances = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      expect(finances!.assets.map((asset) => asset.id)).toEqual(['asset-1', 'asset-2']);
      expect(finances!.liabilities.map((liability) => liability.id)).toEqual(['liability-1']);
      // The restore keeps the exported history instead of stamping "now" on every row.
      expect(finances!.assets[0].updatedAt).toBe(IMPORTED_AT);
      expect(finances!.liabilities[0].updatedAt).toBe(IMPORTED_AT);
    });
  });

  it('creates the tracker when the user has none yet', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await asUser.mutation(api.finances.replaceAllFinances, { assets: ASSETS, liabilities: [], confirmReplace: true });

    await t.run(async (ctx) => {
      const finances = await ctx.db
        .query('finances')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      expect(finances!.assets).toHaveLength(2);
      expect(finances!.liabilities).toHaveLength(0);
    });
  });

  it('re-links plan rows by id and drops links to ids that are gone', async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // The tracker currently holds 'asset-gone'; the restore no longer contains it
      // and adds 'asset-2', while 'asset-1' survives with new values.
      await ctx.db.insert('finances', {
        userId: TEST_USER,
        assets: [{ id: 'asset-gone', name: 'Gone', value: 9, type: 'savings', updatedAt: 1 }],
        liabilities: [],
      });
      await ctx.db.insert(
        'plans',
        makePlan({
          accounts: [
            { id: 'acc-1', name: 'Old name', balance: 1, type: 'taxableBrokerage', syncedFinanceId: 'asset-1' },
            { id: 'acc-2', name: 'Vanished', balance: 2, type: 'savings', syncedFinanceId: 'asset-gone' },
          ],
          debts: [
            {
              id: 'debt-1',
              name: 'Old mortgage',
              balance: 1,
              apr: 5,
              interestType: 'compound',
              startDate: { type: 'now' },
              monthlyPayment: 100,
              syncedFinanceId: 'liability-1',
            },
          ],
        })
      );
    });

    const asUser = t.withIdentity({ subject: TEST_USER });
    await asUser.mutation(api.finances.replaceAllFinances, { assets: ASSETS, liabilities: LIABILITIES, confirmReplace: true });

    await t.run(async (ctx) => {
      const plan = await ctx.db
        .query('plans')
        .withIndex('by_userId', (q) => q.eq('userId', TEST_USER))
        .first();
      const accounts = plan!.accounts;
      expect(accounts[0]).toMatchObject({ id: 'acc-1', balance: 5000, name: 'Brokerage', syncedFinanceId: 'asset-1' });
      expect(accounts[1].syncedFinanceId).toBeUndefined();
      expect(plan!.debts![0]).toMatchObject({ id: 'debt-1', balance: 250000, name: 'Mortgage', syncedFinanceId: 'liability-1' });
    });
  });

  it('rejects duplicate ids, oversized trackers and malformed urls', async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: TEST_USER });

    await expect(
      asUser.mutation(api.finances.replaceAllFinances, {
        assets: [ASSETS[0], ASSETS[0]],
        liabilities: [],
        confirmReplace: true,
      })
    ).rejects.toThrow('Duplicate asset ids');

    await expect(
      asUser.mutation(api.finances.replaceAllFinances, {
        assets: Array.from({ length: 26 }, (_, index) => ({ ...ASSETS[0], id: `asset-${index}` })),
        liabilities: [],
        confirmReplace: true,
      })
    ).rejects.toThrow('Maximum of 25 assets');

    await expect(
      asUser.mutation(api.finances.replaceAllFinances, {
        assets: [{ ...ASSETS[0], url: 'ftp://example.com' }],
        liabilities: [],
        confirmReplace: true,
      })
    ).rejects.toThrow('http:// or https://');
  });
});
