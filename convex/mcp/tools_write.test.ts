// @vitest-environment edge-runtime
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';

import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import schema from '../schema';
import { basicTemplate } from '../templates/basic';
import { createPlanEnvelope } from '../../src/lib/export/plan-envelope';
import { NOT_MODELED_LIST } from '../utils/sys_prompt_utils';

import { MCP_RESOURCES } from './prompts';

// SAFETY: Vitest transforms `import.meta.glob` at test time. The augmentation for it
// ships with `vite/client`, and referencing that from here would make `vite` an
// unlisted dependency, so the transform's shape is declared locally instead.
// The glob reaches the whole of `convex/` (from this file, that is `../**`). Its keys are relative
// to this folder, so they are rebased onto `convex/`: convex-test resolves `mcp/exec` against the
// `_generated` folder it finds, and a `../` or `./` key would not match.
const globbed = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('../**/*.ts');
const modules = Object.fromEntries(
  Object.entries(globbed).map(([path, load]) => [path.replace(/^\.\.\//, '').replace(/^\.\//, 'mcp/'), load])
);

const OWNER = 'test-user-123';
const OTHER = 'other-user-456';

/** A test instance bound to the app schema, so `ctx.db` is typed (`ReturnType<typeof convexTest>` loses the schema). */
const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

function makePlan(overrides: Record<string, unknown> = {}) {
  return { ...basicTemplate, userId: OWNER, name: 'Test Plan', ...overrides };
}

async function insertPlan(t: T, overrides: Record<string, unknown> = {}): Promise<Id<'plans'>> {
  return t.run(async (ctx) => ctx.db.insert('plans', makePlan(overrides)));
}

async function readPlan(t: T, planId: Id<'plans'>): Promise<Doc<'plans'>> {
  const plan = await t.run(async (ctx) => ctx.db.get(planId));
  if (!plan) throw new Error(`plan ${planId} not found`);
  return plan;
}

async function plansOwnedBy(t: T, userId: string): Promise<Doc<'plans'>[]> {
  return t.run(async (ctx) =>
    ctx.db
      .query('plans')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect()
  );
}

/** Calls a write tool as `userId`, exactly as `convex/http.ts` does after it authenticates a token. */
function writeTool(t: T, tool: string, input: unknown, userId: string = OWNER) {
  return t.mutation(internal.mcp.exec.runMutationTool, { userId, tool, input });
}

function readTool(t: T, tool: string, input: unknown, userId: string = OWNER) {
  return t.query(internal.mcp.exec.runQueryTool, { userId, tool, input });
}

const ACCOUNT = { id: 'acct-new-ira', name: 'New IRA', balance: 12_345, type: 'ira' as const };

describe('upsert_account', () => {
  it('adds the account to the caller plan and gives it a contribution rule, as the app does', async () => {
    const t = newTest();
    const planId = await insertPlan(t);
    const before = await readPlan(t, planId);

    await writeTool(t, 'upsert_account', { planId, account: ACCOUNT });

    const after = await readPlan(t, planId);
    expect(after.accounts).toHaveLength(before.accounts.length + 1);
    expect(after.accounts.find((a) => a.id === ACCOUNT.id)).toEqual(ACCOUNT);
    expect(after.contributionRules).toHaveLength(before.contributionRules.length + 1);
    expect(after.contributionRules.some((r) => r.accountId === ACCOUNT.id)).toBe(true);
  });

  it("throws on another user's plan and changes nothing", async () => {
    const t = newTest();
    const planId = await insertPlan(t);
    const before = await readPlan(t, planId);

    await expect(writeTool(t, 'upsert_account', { planId, account: ACCOUNT }, OTHER)).rejects.toThrow(/Not authorized/);

    const after = await readPlan(t, planId);
    expect(after.accounts).toEqual(before.accounts);
    expect(after.contributionRules).toEqual(before.contributionRules);
  });

  it('names the failing field path when an input has the wrong type, and writes nothing', async () => {
    const t = newTest();
    const planId = await insertPlan(t);
    const before = await readPlan(t, planId);

    await expect(writeTool(t, 'upsert_account', { planId, account: { ...ACCOUNT, balance: 'lots' } })).rejects.toThrow(/account\.balance/);

    expect((await readPlan(t, planId)).accounts).toEqual(before.accounts);
  });
});

describe('update_tax_settings', () => {
  it('replaces the stored taxSettings', async () => {
    const t = newTest();
    const planId = await insertPlan(t);
    const taxSettings = { filingStatus: 'marriedFilingJointly' as const, stateResidency: 'none' as const };

    await writeTool(t, 'update_tax_settings', { planId, taxSettings });

    expect((await readPlan(t, planId)).taxSettings).toEqual(taxSettings);
  });
});

describe('journal tools', () => {
  const ENTRY = { date: '2026-03-31', balances: { 'acct-1': 250_000, 'acct-2': -40_000 }, note: 'Quarter end' };

  it('lists an entry the caller added with add_journal_entry', async () => {
    const t = newTest();
    const planId = await insertPlan(t);

    await writeTool(t, 'add_journal_entry', { planId, entry: ENTRY });

    const listed = (await readTool(t, 'list_journal', { planId })) as Doc<'netWorthJournal'>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ date: ENTRY.date, balances: ENTRY.balances, note: ENTRY.note });
  });

  it('does not let another user list the journal', async () => {
    const t = newTest();
    const planId = await insertPlan(t);
    await writeTool(t, 'add_journal_entry', { planId, entry: ENTRY });

    await expect(readTool(t, 'list_journal', { planId }, OTHER)).rejects.toThrow(/Not authorized/);
  });
});

describe('create_plan', () => {
  const EXPORTED_AT = '2026-10-30T12:00:00.000Z';

  /** The basic template, as a plan document, and its export envelope. */
  function sourceAndEnvelope() {
    const source = { ...basicTemplate, _id: 'source-plan' as Id<'plans'>, _creationTime: 0, userId: OWNER, name: 'Source' } as Doc<'plans'>;
    const envelope = createPlanEnvelope({ plan: source, finances: null, exportedAt: EXPORTED_AT });
    return { source, envelope };
  }

  it('stores the same data as createPlanWithData stores for the same plan', async () => {
    const t = newTest();
    const { source, envelope } = sourceAndEnvelope();

    const planId = (await writeTool(t, 'create_plan', { name: 'Imported', planFile: envelope })) as { planId: Id<'plans'> };
    const viaTool = await readPlan(t, planId.planId);

    const { _id: _sid, _creationTime: _sct, userId: _su, name: _sn, ...planData } = source;
    const directId = await t.withIdentity({ subject: OWNER }).mutation(api.plans.createPlanWithData, {
      ...planData,
      newPlanName: 'Imported',
      isDefault: false,
    });
    const direct = await readPlan(t, directId);

    const { _id: _a, _creationTime: _b, ...toolData } = viaTool;
    const { _id: _c, _creationTime: _d, ...directData } = direct;
    expect(toolData).toEqual(directData);
  });

  it('throws listing the issues for an invalid planFile and stores nothing', async () => {
    const t = newTest();
    const { envelope } = sourceAndEnvelope();
    const broken = { ...envelope, plan: { ...envelope.plan, taxSettings: { filingStatus: 'bogus' } } };
    const before = (await plansOwnedBy(t, OWNER)).length;

    await expect(writeTool(t, 'create_plan', { name: 'Broken', planFile: broken })).rejects.toThrow(/filingStatus/);

    expect(await plansOwnedBy(t, OWNER)).toHaveLength(before);
  });
});

describe('clone_plan', () => {
  it("creates a copy owned by the caller, with the source's sections", async () => {
    const t = newTest();
    const sourceId = await insertPlan(t, { name: 'Mine' });
    const source = await readPlan(t, sourceId);

    const copyId = (await writeTool(t, 'clone_plan', { newPlanName: 'Copy', planId: sourceId })) as Id<'plans'>;

    const copy = await readPlan(t, copyId);
    expect(copy.userId).toBe(OWNER);
    expect(copy.name).toBe('Copy');
    expect(copy.accounts).toEqual(source.accounts);
    expect(copy.incomes).toEqual(source.incomes);
  });

  it("refuses to clone another user's plan", async () => {
    const t = newTest();
    const sourceId = await insertPlan(t, { name: 'Mine' });

    await expect(writeTool(t, 'clone_plan', { newPlanName: 'Copy', planId: sourceId }, OTHER)).rejects.toThrow(/not found|Not authorized/i);
  });
});

describe('limitations resource', () => {
  it('carries the not-modeled list the AI chat uses, verbatim', () => {
    const resource = MCP_RESOURCES.find((r) => r.uri === 'ignidash://help/limitations');
    expect(resource?.mimeType).toBe('text/markdown');
    expect(resource?.text).toContain(NOT_MODELED_LIST);
  });
});
