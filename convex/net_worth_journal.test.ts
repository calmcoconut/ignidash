// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import type { FunctionReference } from 'convex/server';
import { describe, expect, it } from 'vitest';

import { api } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import schema from './schema';
import { basicTemplate } from './templates/basic';
import { netWorthOfEntry, validateJournalEntry } from '../src/lib/utils/net-worth-journal';
import type { NetWorthJournalEntry } from './validators/net_worth_journal_validator';

// SAFETY: Vitest transforms `import.meta.glob` at test time. The augmentation for it
// ships with `vite/client`, and referencing that from here would make `vite` an
// unlisted dependency, so the transform's shape is declared locally instead.
const modules = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('./**/*.ts');

const OWNER = 'test-user-123';
const OTHER = 'other-user-456';

/**
 * Addresses a function by module path rather than through `api`.
 *
 * `convex/_generated/api.d.ts` is a codegen artifact and is only regenerated against a configured
 * deployment (other modules added since, such as `chat_tools`, are missing from it too), so a new
 * module cannot be reached as `api.net_worth_journal` yet. `convex-test` resolves a `module:function`
 * string to the module (convex's `getFunctionAddress` turns the string into a function address),
 * which keeps these tests honest about the real module path.
 */
function fn<Type extends 'query' | 'mutation'>(type: Type, path: string): FunctionReference<Type, 'public'> {
  void type;
  return path as unknown as FunctionReference<Type, 'public'>;
}

const JOURNAL = {
  list: fn('query', 'net_worth_journal:list'),
  get: fn('query', 'net_worth_journal:get'),
  create: fn('mutation', 'net_worth_journal:create'),
  update: fn('mutation', 'net_worth_journal:update'),
  deleteEntry: fn('mutation', 'net_worth_journal:deleteEntry'),
} as const;

function makePlan(overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId: OWNER, name: 'Test Plan', ...overrides };
}

async function insertPlan(t: ReturnType<typeof convexTest>, overrides: Record<string, unknown> = {}) {
  return t.run(async (ctx) => ctx.db.insert('plans', makePlan(overrides)));
}

function entry(overrides: Partial<NetWorthJournalEntry> = {}): NetWorthJournalEntry {
  return {
    date: '2026-03-31',
    balances: { 'account-1': 250_000, 'account-2': 50_000 },
    note: 'Quarter end',
    ...overrides,
  };
}

async function getEntry(t: ReturnType<typeof convexTest>, entryId: unknown, asUser: string): Promise<Doc<'netWorthJournal'>> {
  const row = await t.withIdentity({ subject: asUser }).query(JOURNAL.get, { entryId });
  return row as Doc<'netWorthJournal'>;
}

describe('netWorthJournal create + list', () => {
  it('creates a snapshot and lists the plan journal oldest first', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    // Inserted out of order on purpose: the list is what orders them.
    for (const date of ['2026-05-31', '2026-01-31', '2026-03-31']) {
      await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date, note: `Snapshot ${date}` }) });
    }

    const rows = (await asOwner.query(JOURNAL.list, { planId })) as Doc<'netWorthJournal'>[];

    expect(rows.map((row) => row.effectiveDate)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(rows[1].balances).toEqual(entry().balances);
    expect(rows[1].note).toBe('Snapshot 2026-03-31');
    expect(rows[1].planId).toBe(planId);
    expect(rows[1].userId).toBe(OWNER);
  });

  it('stores a partial date as recorded and its period end as effectiveDate', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    const yearId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2026' }) });
    const monthId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2027-09' }) });

    expect(await getEntry(t, yearId, OWNER)).toMatchObject({ date: '2026', effectiveDate: '2026-12-31' });
    expect(await getEntry(t, monthId, OWNER)).toMatchObject({ date: '2027-09', effectiveDate: '2027-09-30' });
  });

  it('orders mixed precisions by the end of their period, not by their text', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    // '2026' sorts before '2026-03-31' as text, but it covers the whole of 2026, so it is later.
    for (const date of ['2026', '2026-03-31', '2025-06-15']) {
      await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date }) });
    }

    const rows = (await asOwner.query(JOURNAL.list, { planId })) as Doc<'netWorthJournal'>[];

    expect(rows.map((row) => row.effectiveDate)).toEqual(['2025-06-15', '2026-03-31', '2026-12-31']);
  });

  it('keeps the same date on different plans', async () => {
    const t = convexTest(schema, modules);
    const first = await insertPlan(t, { name: 'First' });
    const second = await insertPlan(t, { name: 'Second', isDefault: true });
    const asOwner = t.withIdentity({ subject: OWNER });

    await asOwner.mutation(JOURNAL.create, { planId: first, entry: entry() });
    await asOwner.mutation(JOURNAL.create, { planId: second, entry: entry() });

    expect(await asOwner.query(JOURNAL.list, { planId: first })).toHaveLength(1);
    expect(await asOwner.query(JOURNAL.list, { planId: second })).toHaveLength(1);
  });

  it('returns a single entry by id', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry() });

    expect(await getEntry(t, entryId, OWNER)).toMatchObject({ date: '2026-03-31', effectiveDate: '2026-03-31' });
  });
});

describe('netWorthJournal validation', () => {
  it('rejects a date that is not a real calendar date in range', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    for (const date of ['2026-02-30', '2026-13', '2026-3-31', '31/03/2026', '', '1899', '2101']) {
      await expect(asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date }) })).rejects.toThrow(/is not a real date/);
    }
  });

  it('rejects an entry with no balances', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    await expect(asOwner.mutation(JOURNAL.create, { planId, entry: entry({ balances: {} }) })).rejects.toThrow(
      /at least one account balance/
    );
  });

  it('rejects a blank account id', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    await expect(asOwner.mutation(JOURNAL.create, { planId, entry: entry({ balances: { '  ': 1 } }) })).rejects.toThrow(
      /balances key is empty/
    );
  });

  it('rejects a non-finite balance', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    // Convex stores NaN and Infinity as valid floats, and one of them in a balance would poison
    // every overlay sum, so the module refuses them before the row is written.
    for (const balance of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(asOwner.mutation(JOURNAL.create, { planId, entry: entry({ balances: { 'account-1': balance } }) })).rejects.toThrow(
        /must be a finite number/
      );
    }

    expect(await asOwner.query(JOURNAL.list, { planId })).toEqual([]);
  });

  it('rejects a note longer than the limit, and trims a short one', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    await expect(asOwner.mutation(JOURNAL.create, { planId, entry: entry({ note: 'x'.repeat(501) }) })).rejects.toThrow(
      /cannot be longer than 500 characters/
    );

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ note: '  trimmed  ' }) });
    expect(await getEntry(t, entryId, OWNER)).toMatchObject({ note: 'trimmed' });
  });

  it('refuses a second snapshot for the same plan and period end', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2026' }) });

    // '2026' and '2026-12-31' are the same snapshot day, whatever the operator typed.
    await expect(asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2026-12-31', note: 'Again' }) })).rejects.toThrow(
      /already has a journal snapshot for that date/
    );
  });
});

describe('netWorthJournal update + delete', () => {
  it('updates balances, note and date', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry() });

    await asOwner.mutation(JOURNAL.update, {
      entryId,
      entry: entry({ date: '2026-04-30', balances: { 'account-1': 275_000 }, note: 'Corrected' }),
    });

    expect(await getEntry(t, entryId, OWNER)).toMatchObject({
      date: '2026-04-30',
      effectiveDate: '2026-04-30',
      balances: { 'account-1': 275_000 },
      note: 'Corrected',
    });
  });

  it('clears a note', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry() });
    await asOwner.mutation(JOURNAL.update, { entryId, entry: entry({ note: '   ' }) });

    expect((await getEntry(t, entryId, OWNER)).note).toBeUndefined();
  });

  it('refuses to move an entry onto another entry’s snapshot day', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2026-01-31' }) });
    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2026-02-28' }) });

    // '2026-01' ends on the day the first entry already records.
    await expect(asOwner.mutation(JOURNAL.update, { entryId, entry: entry({ date: '2026-01-31' }) })).rejects.toThrow(
      /already has a journal snapshot for that date/
    );
    await expect(asOwner.mutation(JOURNAL.update, { entryId, entry: entry({ date: '2026-01' }) })).rejects.toThrow(
      /already has a journal snapshot for that date/
    );

    // Keeping (or re-saving) its own day is fine.
    await asOwner.mutation(JOURNAL.update, { entryId, entry: entry({ date: '2026-02-28', note: 'Same day' }) });
    expect((await getEntry(t, entryId, OWNER)).note).toBe('Same day');
  });

  it('deletes an entry and reports a missing one', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry() });
    await asOwner.mutation(JOURNAL.deleteEntry, { entryId });

    // The journal is the plan's, and a deleted id reads as "not found" — the same contract
    // conversations and insights use.
    expect(await asOwner.query(JOURNAL.list, { planId })).toEqual([]);
    await expect(asOwner.query(JOURNAL.get, { entryId })).rejects.toThrow(/not found/);
    await expect(asOwner.mutation(JOURNAL.deleteEntry, { entryId })).rejects.toThrow(/not found/);
  });
});

describe('netWorthJournal as P4-P7 reads it', () => {
  it('hands the overlay model a row it accepts, with the balances summing', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ date: '2026-03' }) });
    const row = await getEntry(t, entryId, OWNER);

    // The mapping P4-P7 performs: the document id is the model's entry id, and everything else is
    // already in the model's shape. If this shape ever drifts, the overlay stops accepting rows.
    const mapped = { id: row._id, date: row.date, balances: row.balances, note: row.note };

    expect(validateJournalEntry(mapped)).toEqual({ ok: true });
    expect(netWorthOfEntry(mapped)).toBe(300_000);
  });
});

describe('netWorthJournal per-user isolation', () => {
  it('refuses to list another user’s plan journal', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });
    const asOther = t.withIdentity({ subject: OTHER });

    await asOwner.mutation(JOURNAL.create, { planId, entry: entry() });

    await expect(asOther.query(JOURNAL.list, { planId })).rejects.toThrow(/Not authorized to access this plan/);
    // The owner still sees it: the other user's read changed nothing.
    expect(await asOwner.query(JOURNAL.list, { planId })).toHaveLength(1);
  });

  it('refuses to create against another user’s plan', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOther = t.withIdentity({ subject: OTHER });

    await expect(asOther.mutation(JOURNAL.create, { planId, entry: entry() })).rejects.toThrow(/Not authorized to access this plan/);

    expect(await t.run(async (ctx) => ctx.db.query('netWorthJournal').collect())).toEqual([]);
  });

  it('refuses to read, update or delete another user’s entry', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);
    const asOwner = t.withIdentity({ subject: OWNER });
    const asOther = t.withIdentity({ subject: OTHER });

    const entryId = await asOwner.mutation(JOURNAL.create, { planId, entry: entry({ note: 'Owner only' }) });

    await expect(asOther.query(JOURNAL.get, { entryId })).rejects.toThrow(/Not authorized to access this journal entry/);

    await expect(asOther.mutation(JOURNAL.update, { entryId, entry: entry({ note: 'Hijacked' }) })).rejects.toThrow(
      /Not authorized to access this journal entry/
    );

    await expect(asOther.mutation(JOURNAL.deleteEntry, { entryId })).rejects.toThrow(/Not authorized to access this journal entry/);

    // Untouched, byte for byte.
    expect(await getEntry(t, entryId, OWNER)).toMatchObject({ note: 'Owner only', balances: entry().balances });
  });

  it('requires an authenticated caller', async () => {
    const t = convexTest(schema, modules);
    const planId = await insertPlan(t);

    await expect(t.query(JOURNAL.list, { planId })).rejects.toThrow(/User not authenticated/);
    await expect(t.mutation(JOURNAL.create, { planId, entry: entry() })).rejects.toThrow(/User not authenticated/);
  });
});

describe('netWorthJournal plan lifecycle', () => {
  it('deletes a plan’s entries with the plan, and only that plan’s', async () => {
    const t = convexTest(schema, modules);
    const keptPlanId = await insertPlan(t, { name: 'Kept', isDefault: true });
    const doomedPlanId = await insertPlan(t, { name: 'Doomed', isDefault: false });
    const asOwner = t.withIdentity({ subject: OWNER });

    const keptEntryId = await asOwner.mutation(JOURNAL.create, { planId: keptPlanId, entry: entry() });
    await asOwner.mutation(JOURNAL.create, { planId: doomedPlanId, entry: entry() });
    await asOwner.mutation(JOURNAL.create, { planId: doomedPlanId, entry: entry({ date: '2026-04-30' }) });

    await asOwner.mutation(api.plans.deletePlan, { planId: doomedPlanId });

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query('netWorthJournal').collect();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]._id).toBe(keptEntryId);
    });
  });
});
