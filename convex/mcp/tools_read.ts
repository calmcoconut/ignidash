/**
 * Read-scope MCP tools. See `./registry.ts` for the contract.
 *
 * Every tool here reads. None writes, and none changes the plan it analyses: `analyze_plan` runs the
 * chat's engine tools against a copy of the plan's inputs, and the copy is never saved.
 */

import { ConvexError, v } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import { CHAT_TOOL_DEFINITIONS, MAX_TOOL_CALLS_PER_TURN, createChatToolkit } from '../chat_tools';
import { isISODateString } from '../../src/lib/calc/clock';
import { createPlanEnvelope, EXPORT_SCHEMA_VERSION, parseEnvelopeValue, planExportSchema } from '../../src/lib/export/plan-envelope';
import { simulatorFromConvex } from '../../src/lib/utils/data-transformers';
import { getUserIdOrThrow } from '../utils/auth_utils';
import { getAllPlansForUser, getPlanForCurrentUserOrThrow } from '../utils/plan_utils';

import { defineActionTool, defineQueryTool, type McpTool } from './types';

/** The envelope's keys, as `get_schema` describes them. Kept beside the builder it describes. */
const ENVELOPE_KEYS = {
  schemaVersion: `integer, the export schema version this file is written in (${EXPORT_SCHEMA_VERSION} is current)`,
  kind: '"ignidash-plan", the literal that marks a single-plan export',
  exportedAt: 'ISO-8601 timestamp of when the envelope was made',
  plan: 'the plan body: every property of `schema` (the plan document without its id and owner)',
  finances: 'null for a plan envelope; the net-worth tracker is a separate, user-level export',
};

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The analysis tools' descriptions, built from the chat's own definitions so the two cannot drift. */
function analyzePlanDescription(): string {
  const intro =
    "Run the engine's analysis tools on one of the caller's plans. Results are computed by the deterministic engine, never estimated, " +
    'so quote them rather than guessing. Batch related calls into ONE analyze_plan call, e.g. simulateVariant then compareToBaseline, ' +
    'because variant ids live only within a single call. Each call names a tool and its args. ' +
    `At most ${MAX_TOOL_CALLS_PER_TURN} calls per call. Variant patches are never saved to the plan.`;

  const tools = CHAT_TOOL_DEFINITIONS.map((definition) => {
    const { name, description, parameters } = definition.function;
    return `- ${name}: ${description}\n  args (JSON Schema): ${JSON.stringify(parameters)}`;
  });

  return [intro, 'Tools:', ...tools].join('\n');
}

const listPlans = defineQueryTool({
  name: 'list_plans',
  scope: 'read',
  kind: 'query',
  description:
    "List the caller's plans. Call this first: it gives the planId every other tool needs, and shows which plan is the default, " +
    'whether it has a timeline, and how many accounts, incomes, expenses, debts and physical assets each holds. Read-only.',
  args: {},
  run: async (ctx) => {
    const { userId } = await getUserIdOrThrow(ctx);
    const plans = await getAllPlansForUser(ctx, userId);

    return plans.map((plan) => ({
      planId: plan._id,
      name: plan.name,
      isDefault: plan.isDefault,
      hasTimeline: plan.timeline !== null,
      counts: {
        accounts: plan.accounts.length,
        incomes: plan.incomes.length,
        expenses: plan.expenses.length,
        debts: plan.debts?.length ?? 0,
        physicalAssets: plan.physicalAssets?.length ?? 0,
      },
    }));
  },
});

const getPlan = defineQueryTool({
  name: 'get_plan',
  scope: 'read',
  kind: 'query',
  description:
    'Read one plan in full, as a plan export envelope: the same JSON a plan export produces. ' +
    'Call it before editing a plan, to learn the ids of its incomes, accounts, expenses and other items. ' +
    'The envelope is what create_plan accepts back, so a copy of a plan can be made by editing `plan` and passing it to create_plan. ' +
    "Read-only. Fails if the plan is not one of the caller's.",
  args: { planId: v.id('plans') },
  run: async (ctx, { planId }) => {
    const plan = await getPlanForCurrentUserOrThrow(ctx, planId);

    return {
      planId: plan._id,
      envelope: createPlanEnvelope({ plan, finances: null, exportedAt: new Date().toISOString() }),
    };
  },
});

const getSchema = defineQueryTool({
  name: 'get_schema',
  scope: 'read',
  kind: 'query',
  description:
    'Describe the plan document as JSON Schema, so a plan can be written or checked before create_plan. ' +
    'Without `section`, returns the envelope keys, the list of top-level plan sections, and the whole plan schema. ' +
    'With `section` (one of the names that call lists, e.g. "incomes"), returns only that section\'s schema. ' +
    'Read-only; needs no planId.',
  args: { section: v.optional(v.string()) },
  run: async (_ctx, { section }) => {
    // `$schema` is the dialect marker. Convex refuses any object key that starts with `$` in a return value, so it is dropped.
    const { $schema: _dialect, ...schema } = z.toJSONSchema(planExportSchema(), { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;

    if (section === undefined) {
      return {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        envelope: ENVELOPE_KEYS,
        sections: Object.keys(properties),
        schema,
      };
    }

    if (!Object.prototype.hasOwnProperty.call(properties, section)) {
      throw new ConvexError(`Unknown section "${section}". Valid sections: ${Object.keys(properties).join(', ')}.`);
    }

    return { schemaVersion: EXPORT_SCHEMA_VERSION, section, schema: properties[section] };
  },
});

const validatePlan = defineQueryTool({
  name: 'validate_plan',
  scope: 'read',
  kind: 'query',
  description:
    'Check a plan export envelope (as JSON) against the importer, without saving anything. Returns { ok: true, warnings } when the ' +
    'plan would import, where warnings are advisory and listed by field path; or { ok: false, issues } naming every field that ' +
    'failed, each with its path and message. Call it on a plan you have written before create_plan. Never throws for an invalid plan. Read-only.',
  args: { planFile: v.any() },
  run: async (_ctx, { planFile }) => {
    try {
      const result = parseEnvelopeValue(planFile);
      return result.ok ? { ok: true, warnings: result.warnings } : { ok: false, issues: result.issues };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, issues: [{ path: '', message: `The file could not be read as a plan: ${detail}` }] };
    }
  },
});

const analyzePlan = defineActionTool({
  name: 'analyze_plan',
  scope: 'read',
  kind: 'action',
  description: analyzePlanDescription(),
  args: {
    planId: v.id('plans'),
    asOf: v.optional(v.string()),
    calls: v.array(v.object({ tool: v.string(), args: v.optional(v.any()) })),
  },
  run: async (ctx, { planId, asOf, calls }, userId) => {
    const resolvedAsOf = asOf ?? todayIsoDate();
    if (!ISO_DATE_SHAPE.test(resolvedAsOf) || !isISODateString(resolvedAsOf)) {
      throw new ConvexError(`asOf must be a calendar date in YYYY-MM-DD form, got "${resolvedAsOf}".`);
    }

    const validTools = CHAT_TOOL_DEFINITIONS.map((definition) => definition.function.name);
    const unknownTools = calls.filter((call) => !validTools.includes(call.tool)).map((call) => call.tool);
    if (unknownTools.length > 0) {
      throw new ConvexError(
        `Unknown tool${unknownTools.length > 1 ? 's' : ''} ${unknownTools.join(', ')}. Valid tools: ${validTools.join(', ')}.`
      );
    }

    if (calls.length > MAX_TOOL_CALLS_PER_TURN) {
      throw new ConvexError(
        `analyze_plan accepts at most ${MAX_TOOL_CALLS_PER_TURN} calls per call; got ${calls.length}. Split the batch.`
      );
    }

    const plan = await ctx.runQuery(internal.mcp.exec.planForUser, { userId, planId });

    let toolkit: ReturnType<typeof createChatToolkit>;
    try {
      toolkit = createChatToolkit({ inputs: simulatorFromConvex(plan), asOf: resolvedAsOf });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConvexError(`This plan cannot be simulated, so no analysis can run: ${detail}`);
    }

    // One toolkit for the whole batch: a variant made by one call can be compared by a later one.
    const results = calls.map((call) => ({
      tool: call.tool,
      result: JSON.parse(toolkit.execute(call.tool, call.args ?? {})) as unknown,
    }));

    return { asOf: resolvedAsOf, results };
  },
});

export const READ_TOOLS: McpTool[] = [listPlans, getPlan, getSchema, validatePlan, analyzePlan];
