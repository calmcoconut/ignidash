/**
 * Write-scope MCP tools. See `./registry.ts` for the contract.
 *
 * Each tool runs the app's own handler from its `*Def` (see `convex/utils/function_defs.ts`), so
 * the input validators, the plan ownership checks and the snapshot writes are the app's, not a copy.
 */

import { ConvexError, v, type PropertyValidators } from 'convex/values';

import type { MutationCtx } from '../_generated/server';
import { upsertAccountDef, deleteAccountDef } from '../account';
import { upsertIncomeDef, deleteIncomeDef } from '../income';
import { upsertExpenseDef, deleteExpenseDef } from '../expense';
import { upsertDebtDef, deleteDebtDef } from '../debt';
import { upsertPhysicalAssetDef, deletePhysicalAssetDef } from '../physical_asset';
import { upsertContributionRuleDef, deleteContributionRuleDef, reorderContributionRulesDef, updateBaseRuleDef } from '../contribution_rule';
import { updateDef as updateTimelineDef } from '../timeline';
import { updateDef as updateTaxSettingsDef } from '../tax_settings';
import { updateDef as updateSimulationSettingsDef } from '../simulation_settings';
import { updateDef as updateMarketAssumptionsDef } from '../market_assumptions';
import { updateDef as updateGlidePathDef } from '../glide_path';
import { updateDef as updateConversionDef } from '../conversion';
import { updateDef as updateSeppDef } from '../sepp';
import { updateDef as updateMilestonesDef } from '../milestones';
import {
  listDef as listJournalDef,
  createDef as createJournalEntryDef,
  updateDef as updateJournalEntryDef,
  deleteEntryDef as deleteJournalEntryDef,
} from '../net_worth_journal';
import { clonePlanDef, createPlanWithDataDef, updatePlanNameDef } from '../plans';
import { preparePastedPlan, type ImportIssue } from '../../src/lib/export/plan-envelope';
import type { FunctionDef } from '../utils/function_defs';

import { defineMutationTool, defineQueryTool, type McpTool } from './types';

/**
 * A write tool that runs `def`'s handler. A handler that returns nothing reports `{ ok: true }`, so
 * the AI gets a confirmation rather than `null`.
 */
function writeTool<Args extends PropertyValidators>(
  name: string,
  def: FunctionDef<MutationCtx, Args, unknown>,
  description: string
): McpTool {
  return defineMutationTool({
    kind: 'mutation',
    name,
    scope: 'write',
    description,
    args: def.args,
    run: async (ctx, args) => {
      const result = await def.handler(ctx, args);
      return result === undefined ? { ok: true } : result;
    },
  });
}

const LIMIT_ACCOUNTS = 15;
const LIMIT_RULES = 20;
const LIMIT_TEN = 10;

const ITEM_ID_NOTE =
  'Upserts add when `id` is new and replace when it matches an existing id from get_plan. For a new item, choose a fresh UUID v4 as its id.';

function formatIssues(issues: ImportIssue[]): string {
  return issues.map((issue) => `${issue.path || '(root)'}: ${issue.message}`).join('; ');
}

const createPlan = defineMutationTool({
  kind: 'mutation',
  name: 'create_plan',
  scope: 'write',
  description: [
    'Creates a new plan from a complete plan file, named `name`, and returns its planId and any warnings.',
    '`planFile` takes the envelope get_plan returns: `{ kind, schemaVersion, exportedAt, plan }` (kind "ignidash-plan"; the plan object holds the sections).',
    'Use validate_plan and get_schema while you build the file, so it is valid before you call this.',
    'A file that fails validation creates nothing and the error lists each problem by path.',
    'Warnings do not block creation; relay them to the user. Limit: 10 plans per user.',
    'To base a new plan on an existing one, use clone_plan instead.',
  ].join(' '),
  args: { name: v.string(), planFile: v.any() },
  run: async (ctx, { name, planFile }) => {
    // The same reader and guards as the "paste a plan" dialog, so an AI-built file meets the same rules.
    const prepared = preparePastedPlan(JSON.stringify(planFile) ?? '');
    if (!prepared.ok) throw new ConvexError(`The plan file is not valid: ${formatIssues(prepared.issues)}`);

    const planId = await createPlanWithDataDef.handler(ctx, { ...prepared.planData, newPlanName: name, isDefault: false });
    return { planId, warnings: prepared.warnings };
  },
});

export const WRITE_TOOLS: McpTool[] = [
  writeTool(
    'upsert_account',
    upsertAccountDef,
    [
      'Adds an account to a plan, or replaces an existing one with the same id.',
      ITEM_ID_NOTE,
      `A plan holds at most ${LIMIT_ACCOUNTS} accounts.`,
      'A new account also gets an unlimited contribution rule at the end of the rule order, as the app does.',
      'Set `owner` when the account belongs to a spouse.',
    ].join(' ')
  ),
  writeTool(
    'delete_account',
    deleteAccountDef,
    'Removes an account and every contribution rule that pointed at it, then renumbers the remaining rules.'
  ),
  writeTool(
    'upsert_income',
    upsertIncomeDef,
    [
      'Adds an income stream (for example salary, Social Security or pension) to a plan, or replaces one with the same id.',
      ITEM_ID_NOTE,
      `A plan holds at most ${LIMIT_TEN} incomes.`,
    ].join(' ')
  ),
  writeTool(
    'delete_income',
    deleteIncomeDef,
    'Removes an income stream. Contribution rules that used it keep their place but lose the link to it.'
  ),
  writeTool(
    'upsert_expense',
    upsertExpenseDef,
    ['Adds an expense to a plan, or replaces one with the same id.', ITEM_ID_NOTE, `A plan holds at most ${LIMIT_TEN} expenses.`].join(' ')
  ),
  writeTool('delete_expense', deleteExpenseDef, 'Removes an expense by its id.'),
  writeTool(
    'upsert_debt',
    upsertDebtDef,
    [
      'Adds a debt (for example a mortgage or loan) to a plan, or replaces one with the same id.',
      ITEM_ID_NOTE,
      `A plan holds at most ${LIMIT_TEN} debts.`,
    ].join(' ')
  ),
  writeTool('delete_debt', deleteDebtDef, 'Removes a debt by its id.'),
  writeTool(
    'upsert_physical_asset',
    upsertPhysicalAssetDef,
    [
      'Adds a physical asset (for example a home or vehicle, with optional loan and sale) to a plan, or replaces one with the same id.',
      ITEM_ID_NOTE,
      `A plan holds at most ${LIMIT_TEN} physical assets.`,
    ].join(' ')
  ),
  writeTool('delete_physical_asset', deletePhysicalAssetDef, 'Removes a physical asset by its id.'),
  writeTool(
    'upsert_contribution_rule',
    upsertContributionRuleDef,
    [
      'Adds a contribution rule (how much goes into which account from which income), or replaces one with the same id.',
      ITEM_ID_NOTE,
      'Rules are applied in rank order. Use reorder_contribution_rules to change the order.',
      `A plan holds at most ${LIMIT_RULES} contribution rules.`,
    ].join(' ')
  ),
  writeTool(
    'delete_contribution_rule',
    deleteContributionRuleDef,
    'Removes one contribution rule by id and renumbers the remaining rules.'
  ),
  writeTool(
    'reorder_contribution_rules',
    reorderContributionRulesDef,
    'Sets the rule order. `newOrder` lists the id of every contribution rule in rank order, first to last. A rule left out of the list is removed, so list them all.'
  ),
  writeTool(
    'update_base_contribution_rule',
    updateBaseRuleDef,
    "Sets the base contribution rule, `type` 'save' or 'spend': the fallback for money that the ranked contribution rules do not allocate. It replaces the whole base rule."
  ),
  writeTool(
    'update_timeline',
    updateTimelineDef,
    "Replaces the whole timeline: birth month and year (both spouses' birth dates if married), life expectancy and the retirement strategy. Send the complete timeline, not one field."
  ),
  writeTool(
    'update_tax_settings',
    updateTaxSettingsDef,
    'Replaces the whole tax settings section: filing status, state residency (CA or none), optional itemized deductions, and the ACA opt-in. Send the complete section.'
  ),
  writeTool(
    'update_simulation_settings',
    updateSimulationSettingsDef,
    'Replaces the whole simulation settings section: simulation mode, seed, and historical start-year overrides. Send the complete section.'
  ),
  writeTool(
    'update_market_assumptions',
    updateMarketAssumptionsDef,
    'Replaces the whole market assumptions section: expected stock, bond and cash returns and yields, and inflation, in percent. Send the complete section.'
  ),
  writeTool(
    'update_glide_path',
    updateGlidePathDef,
    'Replaces the glide path: a bond-allocation target that takes effect at an end date or age. Send the complete glide path.'
  ),
  writeTool(
    'update_roth_conversions',
    updateConversionDef,
    'Replaces the whole Roth conversion list. Each conversion starts now, at retirement, at life expectancy, or at a custom date or age, and converts either a fixed amount or up to a fill-to-bracket target. Send the complete list.'
  ),
  writeTool(
    'update_sepp',
    updateSeppDef,
    'Replaces the whole SEPP (IRC 72(t)) schedule: method (rmd, fixedAmortization or fixedAnnuitization), start year, and optional rate and stop year. Send the complete schedule.'
  ),
  writeTool(
    'update_milestones',
    updateMilestonesDef,
    "Replaces the whole list of milestones. Each milestone fires on a comparison of a metric (age, year, portfolio, income, expense, net worth, or one account's balance). Send the complete list."
  ),
  defineQueryTool({
    kind: 'query',
    name: 'list_journal',
    scope: 'read',
    description:
      "Lists a plan's net-worth journal: the dated snapshots of balances by account, oldest first. Each entry has an `_id`, which update_journal_entry and delete_journal_entry take.",
    args: listJournalDef.args,
    run: async (ctx, args) => listJournalDef.handler(ctx, args),
  }),
  writeTool(
    'add_journal_entry',
    createJournalEntryDef,
    [
      "Adds a net-worth snapshot to a plan's journal: a `date`, and `balances` keyed by account id (liabilities negative).",
      '`date` is YYYY, YYYY-MM or YYYY-MM-DD; a partial date means the end of that period.',
      'Only one snapshot per date is allowed. The account ids need not match current accounts, so history stays readable after a rename.',
      'The optional `note` is at most 500 characters.',
    ].join(' ')
  ),
  writeTool(
    'update_journal_entry',
    updateJournalEntryDef,
    'Replaces one journal snapshot. `entryId` is the `_id` from list_journal. Send the complete entry: the date, balances and note (omit `note` to clear it).'
  ),
  writeTool('delete_journal_entry', deleteJournalEntryDef, 'Removes one journal snapshot. `entryId` is the `_id` from list_journal.'),
  writeTool(
    'clone_plan',
    clonePlanDef,
    [
      'Copies a plan into a new plan owned by the user, named `newPlanName`. `planId` is an existing plan id, or "template1" (basic) or "template2" (early retirement).',
      "Before a large edit to the user's own plan, clone it and edit the copy, so the original stays as it was.",
      'Limit: 10 plans per user.',
    ].join(' ')
  ),
  writeTool('rename_plan', updatePlanNameDef, 'Renames a plan. `name` is the new name.'),
  createPlan,
];
