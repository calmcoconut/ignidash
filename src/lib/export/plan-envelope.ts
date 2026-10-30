import { z } from 'zod';

import type { Doc } from '../../../convex/_generated/dataModel';
import { planDataFields } from '../../../convex/validators/plan_data_fields';
import { assetValidator } from '../../../convex/validators/asset_validator';
import { liabilityValidator } from '../../../convex/validators/liability_validator';

import { accountFormSchema } from '@/lib/schemas/inputs/account-form-schema';
import { contributionFormSchema, baseContributionSchema } from '@/lib/schemas/inputs/contribution-form-schema';
import { debtFormSchema } from '@/lib/schemas/inputs/debt-form-schema';
import { expenseFormSchema } from '@/lib/schemas/inputs/expense-form-schema';
import { glidePathFormSchema } from '@/lib/schemas/inputs/glide-path-form-schema';
import { incomeFormSchema } from '@/lib/schemas/inputs/income-form-schema';
import { marketAssumptionsFormSchema } from '@/lib/schemas/inputs/market-assumptions-form-schema';
import { physicalAssetFormSchema } from '@/lib/schemas/inputs/physical-asset-form-schema';
import { privacySettingsFormSchema } from '@/lib/schemas/inputs/privacy-settings-form-schema';
import { simulationSettingsSchema } from '@/lib/schemas/inputs/simulation-settings-form-schema';
import { taxSettingsFormSchema } from '@/lib/schemas/inputs/tax-settings-form-schema';
import { timelineBaseSchema } from '@/lib/schemas/inputs/timeline-form-schema';
import { assetFormSchema } from '@/lib/schemas/finances/asset-form-schema';
import { liabilityFormSchema } from '@/lib/schemas/finances/liability-form-schema';
import {
  accountFromConvex,
  assetFromConvex,
  baseContributionFromConvex,
  contributionFromConvex,
  debtFromConvex,
  expenseFromConvex,
  glidePathFromConvex,
  incomeFromConvex,
  liabilityFromConvex,
  marketAssumptionsFromConvex,
  physicalAssetFromConvex,
  privacySettingsFromConvex,
  simulationSettingsFromConvex,
  taxSettingsFromConvex,
  timelineFromConvex,
} from '@/lib/utils/data-transformers';

import { zodFromConvexValidator, zodObjectFromValidators, type ConvexValidatorLike } from './convex-validator-to-zod';

/**
 * Export/import envelope, version 2 (P5-P1, bumped by P1-P1).
 *
 * A file is a versioned JSON envelope:
 *
 *   { schemaVersion: 2, kind, exportedAt, plan, finances }          // one plan
 *   { schemaVersion: 2, kind, exportedAt, plans, finances }         // every plan
 *
 * `plan`/`plans` hold the plan document without its per-deployment identity
 * (`_id`, `_creationTime`, `userId`), and `finances` holds the net-worth tracker
 * the operator owns. Adding a field anywhere in that payload is a schema change:
 * per contract 3.3 the PR that changes the shape bumps `EXPORT_SCHEMA_VERSION`, and
 * `parseEnvelope` keeps rejecting files newer than this build with a clear message
 * instead of half-importing them.
 *
 * Version history:
 *   1 — the P5-P1 envelope: plan data plus finances.
 *   2 — P1-P1 time binding: `everyNYears`/`recurrenceYears` on a time point and
 *       `amountBasis` on incomes, expenses, debts and physical assets.
 *
 * A bump is backward compatible on the reading side but never silently forward: importing
 * accepts every version from 1 up to this build's, and refuses anything newer until the
 * operator upgrades. Fields added by a bump are optional in both the validators and the
 * per-domain schemas, so a v1 file is read with those fields absent, exactly as the plan
 * read them before the bump.
 *
 * The payload types are derived from `Doc<'plans'>`/`Doc<'finances'>` and the
 * validation schema is derived from the same Convex validators the database
 * enforces, so there is exactly one description of the shape.
 */

export const EXPORT_SCHEMA_VERSION = 2;

/** The oldest file this build still reads. Whole-number range: 1..EXPORT_SCHEMA_VERSION. */
export const MIN_EXPORT_SCHEMA_VERSION = 1;

export const PLAN_EXPORT_KIND = 'ignidash-plan';
export const PLANS_EXPORT_KIND = 'ignidash-plans';

/** The plan document without the fields that are specific to one deployment. */
export type PlanExport = Omit<Doc<'plans'>, '_id' | '_creationTime' | 'userId'>;

/** The user-level finances (net-worth tracker) without the owning user id. */
export type FinancesExport = Pick<Doc<'finances'>, 'assets' | 'liabilities'>;

/**
 * An envelope, as written or as read.
 *
 * `schemaVersion` is the version that wrote THIS file, not necessarily this build's:
 * `createPlanEnvelope`/`createPlansEnvelope` stamp `EXPORT_SCHEMA_VERSION`, while
 * `parseEnvelope` accepts anything in `MIN_EXPORT_SCHEMA_VERSION..EXPORT_SCHEMA_VERSION`
 * and reports the file's own version. A restored v1 file is therefore not relabelled as v2
 * in memory; re-exporting it writes the current version through the builders.
 */
export interface PlanExportEnvelope {
  schemaVersion: number;
  kind: typeof PLAN_EXPORT_KIND;
  exportedAt: string;
  plan: PlanExport;
  finances: FinancesExport | null;
}

export interface PlansExportEnvelope {
  schemaVersion: number;
  kind: typeof PLANS_EXPORT_KIND;
  exportedAt: string;
  plans: PlanExport[];
  finances: FinancesExport | null;
}

export type ExportEnvelope = PlanExportEnvelope | PlansExportEnvelope;

/** One failed field, with the path that failed. Replaces truncating messages. */
export interface ImportIssue {
  path: string;
  message: string;
}

export type EnvelopeParseResult = { ok: true; envelope: ExportEnvelope } | { ok: false; issues: ImportIssue[] };

const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Synthetic validators for the two plan-document fields that are not plan data. */
const PLAN_DOCUMENT_FIELDS: Record<string, ConvexValidatorLike> = {
  name: { kind: 'string' },
  isDefault: { kind: 'boolean' },
};

// ---------------------------------------------------------------------------
// Derived schemas
// ---------------------------------------------------------------------------

/**
 * The plan payload schema, derived from the Convex validators.
 *
 * `planDataFields` is the single source of truth: a field added there is accepted
 * by import with no change here, and `planExportKeys()` below picks it up for the
 * export guard test.
 */
export function planExportSchema(): z.ZodObject {
  return zodObjectFromValidators({ ...PLAN_DOCUMENT_FIELDS, ...planDataFields });
}

export function financesExportSchema(): z.ZodObject {
  return z.strictObject({
    assets: z.array(zodFromConvexValidator(assetValidator)),
    liabilities: z.array(zodFromConvexValidator(liabilityValidator)),
  });
}

/**
 * Every key a `PlanExport` must carry: the two document fields plus every field in
 * the plans validator. Sorted, so tests and callers can compare sets directly.
 */
export function planExportKeys(): string[] {
  return Object.keys({ ...PLAN_DOCUMENT_FIELDS, ...planDataFields }).sort();
}

const exportedAtSchema = z.string().regex(ISO_8601_TIMESTAMP, 'Expected an ISO-8601 timestamp such as 2026-10-30T12:00:00.000Z');

/**
 * The accepted version range, not the current version.
 *
 * A literal here would reject every file written by an earlier build the moment the version
 * is bumped: `checkSchemaVersion` only refuses files NEWER than this build, so a v1 file
 * passes that gate and would then fail the literal. Backward-compatible import is a standing
 * rule (§4 of PLAN-parity.md), and `MIN_EXPORT_SCHEMA_VERSION..EXPORT_SCHEMA_VERSION` is the
 * range the payload schema can actually read: fields a bump adds are optional, so an older
 * file simply lacks them.
 */
const schemaVersionSchema = z.number().int().min(MIN_EXPORT_SCHEMA_VERSION).max(EXPORT_SCHEMA_VERSION);

const planEnvelopeSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal(PLAN_EXPORT_KIND),
  exportedAt: exportedAtSchema,
  plan: planExportSchema(),
  finances: financesExportSchema().nullable(),
});

const plansEnvelopeSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: z.literal(PLANS_EXPORT_KIND),
  exportedAt: exportedAtSchema,
  plans: z.array(planExportSchema()),
  finances: financesExportSchema().nullable(),
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Copies a plan document into its exported form.
 *
 * Iterates `planExportKeys()` (derived from the validator) instead of listing
 * fields, so a field added to the plans validator cannot be dropped here the way
 * `clonePlan` used to drop `glidePath`.
 */
export function toPlanExport(plan: Doc<'plans'>): PlanExport {
  // SAFETY: the serialized plan document is a plain record at runtime; the loop below
  // copies exactly the keys `planExportKeys()` derives from the plans validator, which
  // is the definition of `PlanExport` (name, isDefault and every `planDataFields` entry).
  const source = plan as unknown as Record<string, unknown>;
  const exported: Record<string, unknown> = {};
  for (const key of planExportKeys()) {
    // An absent value and an explicit `undefined` both mean "not stored".
    if (source[key] !== undefined) exported[key] = structuredClone(source[key]);
  }
  // SAFETY: `exported` was built from `planExportKeys()`, so every required key is
  // present unless the caller passed a document that already violated the validator.
  return exported as unknown as PlanExport;
}

export function toFinancesExport(finances: Doc<'finances'> | null): FinancesExport | null {
  if (!finances) return null;
  return financesFromParts(finances.assets, finances.liabilities);
}

/**
 * Builds the exported finances from the two arrays the settings page queries
 * separately. Both being absent means the user has no net-worth tracker yet.
 */
export function financesFromParts(
  assets: Doc<'finances'>['assets'] | null,
  liabilities: Doc<'finances'>['liabilities'] | null
): FinancesExport | null {
  if (assets === null && liabilities === null) return null;
  return { assets: structuredClone(assets ?? []), liabilities: structuredClone(liabilities ?? []) };
}

export function createPlanEnvelope(input: { plan: Doc<'plans'>; finances: FinancesExport | null; exportedAt: string }): PlanExportEnvelope {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: PLAN_EXPORT_KIND,
    exportedAt: input.exportedAt,
    plan: toPlanExport(input.plan),
    finances: input.finances,
  };
}

export function createPlansEnvelope(input: {
  plans: Doc<'plans'>[];
  finances: FinancesExport | null;
  exportedAt: string;
}): PlansExportEnvelope {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: PLANS_EXPORT_KIND,
    exportedAt: input.exportedAt,
    plans: input.plans.map(toPlanExport),
    finances: input.finances,
  };
}

export function serializeEnvelope(envelope: ExportEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parses and validates an exported file.
 *
 * Never throws: a malformed file produces a list of `{ path, message }` issues
 * naming the exact fields that failed (e.g. `plan.incomes[0].name`), so the UI can
 * show all of them instead of a truncated string. Files without a `schemaVersion`,
 * or from a newer build, are rejected with an actionable message rather than being
 * coerced.
 */
export function parseEnvelope(text: string): EnvelopeParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [{ path: '', message: `This file is not valid JSON: ${detail}` }] };
  }
  return parseEnvelopeValue(value);
}

export function parseEnvelopeValue(value: unknown): EnvelopeParseResult {
  if (!isPlainObject(value)) {
    return { ok: false, issues: [{ path: '', message: 'This file does not contain a JSON object, so it is not an Ignidash export.' }] };
  }

  const versionIssue = checkSchemaVersion(value);
  if (versionIssue) return { ok: false, issues: [versionIssue] };

  const kind = value.kind;
  if (kind !== PLAN_EXPORT_KIND && kind !== PLANS_EXPORT_KIND) {
    return {
      ok: false,
      issues: [
        {
          path: 'kind',
          message: `Unsupported export kind ${JSON.stringify(kind ?? null)}; expected "${PLAN_EXPORT_KIND}" or "${PLANS_EXPORT_KIND}".`,
        },
      ],
    };
  }

  const schema = kind === PLAN_EXPORT_KIND ? planEnvelopeSchema : plansEnvelopeSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: issuesFromZodError(parsed.error) };

  // The structural parse only proves the payload matches what Convex stores. The app's own
  // rules come next, still before the caller writes anything.
  const envelope = parsed.data as ExportEnvelope;
  const appIssues = appRuleIssues(envelope);
  if (appIssues.length > 0) return { ok: false, issues: appIssues };

  return { ok: true, envelope };
}

function checkSchemaVersion(value: Record<string, unknown>): ImportIssue | null {
  if (!('schemaVersion' in value)) {
    return {
      path: 'schemaVersion',
      message:
        'This file has no schemaVersion, so it is not an Ignidash export (v1 files carry `schemaVersion: 1`, v2 files `schemaVersion: 2`). Re-export it from Settings.',
    };
  }

  const version = value.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      path: 'schemaVersion',
      message: `Unsupported schemaVersion ${JSON.stringify(version)}; this build reads versions ${MIN_EXPORT_SCHEMA_VERSION} through ${EXPORT_SCHEMA_VERSION}.`,
    };
  }

  if (version > EXPORT_SCHEMA_VERSION) {
    return {
      path: 'schemaVersion',
      message: `This file was exported by a newer Ignidash (schemaVersion ${version}); this build reads up to ${EXPORT_SCHEMA_VERSION}. Upgrade before importing it.`,
    };
  }

  return null;
}

/** One issue while its path is still a list of keys, before it is formatted. */
interface RawIssue {
  parts: PropertyKey[];
  message: string;
}

type ZodIssue = z.ZodError['issues'][number];

/**
 * Flattens a Zod error tree into one issue per failing field, `prefix` first.
 *
 * A union does not fail at its own path: Zod reports `invalid_union` and puts the useful
 * paths one level down, in `issue.errors` (one list per member). Reporting the union issue
 * itself would say `plan.timeline :: Invalid input` where the file actually needs
 * `plan.timeline.retirementStrategy.retirementAge`, so the walk recurses into every member
 * to whatever depth the unions nest and emits the leaves.
 *
 * The `z.null()` member of a union is skipped: `timeline` is `v.union(timelineValidator,
 * v.null())`, so every failure of the object member would otherwise carry a useless
 * "expected null" companion. If nothing survives the walk (a union whose members only
 * objected to the value not being null), the union's own issue is reported instead, so a
 * failure is never dropped.
 */
function issuesFromZodError(error: z.ZodError, prefix: readonly PropertyKey[] = []): ImportIssue[] {
  const raw: RawIssue[] = [];
  collectZodIssues(error.issues, prefix, raw, new Set<string>(), false);
  return raw.map((issue) => ({ path: formatPath(issue.parts) || '(root)', message: issue.message }));
}

function collectZodIssues(
  zodIssues: readonly ZodIssue[],
  prefix: readonly PropertyKey[],
  out: RawIssue[],
  seen: Set<string>,
  skipNullMember: boolean
): void {
  for (const issue of zodIssues) {
    const parts = [...prefix, ...issue.path];

    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) pushIssue(out, seen, [...parts, key], 'Unrecognized field');
      continue;
    }

    // The null member of a union never explains the failure; the other members do.
    if (skipNullMember && issue.code === 'invalid_type' && issue.expected === 'null') continue;

    if (issue.code === 'invalid_union') {
      const branches: RawIssue[] = [];
      const branchSeen = new Set<string>();
      for (const branch of issue.errors) collectZodIssues(branch, parts, branches, branchSeen, true);
      if (branches.length === 0) {
        pushIssue(out, seen, parts, issue.message);
        continue;
      }
      for (const leaf of branches) pushIssue(out, seen, leaf.parts, leaf.message);
      continue;
    }

    pushIssue(out, seen, parts, issue.message);
  }
}

function pushIssue(out: RawIssue[], seen: Set<string>, parts: PropertyKey[], message: string): void {
  const key = `${formatPath(parts)}\u0000${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ parts, message });
}

function formatPath(parts: readonly PropertyKey[]): string {
  let path = '';
  for (const part of parts) {
    if (typeof part === 'number') {
      path += `[${part}]`;
      continue;
    }
    path = path === '' ? String(part) : `${path}.${String(part)}`;
  }
  return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// App rules
// ---------------------------------------------------------------------------

/**
 * The app's own per-domain rules, applied once the structural parse has passed.
 *
 * The derived schema above deliberately enforces Convex STRUCTURE only. The per-domain
 * schemas carry the rules the app itself relies on, and the gap is reachable: an
 * `asOfDate` of `"not-a-date"` is a valid `v.string()`, yet `useSimulationClock` passes it
 * to `fixedClock`, which throws — so one corrupt plan would put its simulator page on the
 * error boundary with no way to repair it from the UI. `birthMonth: 13`, `name: ""`,
 * `simulationSeed: 1e9` and `stockYield: 99` are the same class of accepted-but-wrong.
 *
 * Each part is checked through the transformer the app already uses to read it
 * (`xFromConvex`) and the schema the app already validates it with, so a rule added to a
 * domain schema applies to imports with no change here.
 *
 * Not covered, by design:
 *   - the plan document's own `name`/`isDefault`, which are not plan data and have no
 *     per-domain schema (`name` is a bare `v.string()` on the document);
 *   - the clock-dependent timeline rules in `createTimelineFormSchema(now)` (current age,
 *     life expectancy above current age, retirement age below life expectancy), because an
 *     import has no "today" to compare against — `timelineBaseSchema` is the clock-free
 *     part, and this module keeps taking its timestamps as parameters.
 */
function appRuleIssues(envelope: ExportEnvelope): ImportIssue[] {
  const single = envelope.kind === PLAN_EXPORT_KIND;
  const plans = single ? [envelope.plan] : envelope.plans;
  const issues: ImportIssue[] = [];

  plans.forEach((plan, index) => {
    const prefix = single ? ['plan'] : ['plans', index];
    pushDomainIssues(issues, prefix, () => planDomainChecks(plan, prefix));
  });

  if (envelope.finances) {
    const finances = envelope.finances;
    pushDomainIssues(issues, ['finances'], () => [
      ...finances.assets.map(
        (asset, index): DomainCheck => ({ parts: ['finances', 'assets', index], schema: assetFormSchema, value: assetFromConvex(asset) })
      ),
      ...finances.liabilities.map(
        (liability, index): DomainCheck => ({
          parts: ['finances', 'liabilities', index],
          schema: liabilityFormSchema,
          value: liabilityFromConvex(liability),
        })
      ),
    ]);
  }

  return issues;
}

interface DomainCheck {
  /** Path of the checked value in the file, e.g. `['plan', 'incomes', 0]`. */
  parts: PropertyKey[];
  schema: z.ZodType;
  value: unknown;
}

/** One check per part of a plan that has a per-domain schema. */
function planDomainChecks(plan: PlanExport, prefix: PropertyKey[]): DomainCheck[] {
  const checks: DomainCheck[] = [
    { parts: [...prefix, 'timeline'], schema: timelineBaseSchema.nullable(), value: timelineFromConvex(plan.timeline) },
    {
      parts: [...prefix, 'baseContributionRule'],
      schema: baseContributionSchema,
      value: baseContributionFromConvex(plan.baseContributionRule),
    },
    { parts: [...prefix, 'glidePath'], schema: glidePathFormSchema.optional(), value: glidePathFromConvex(plan.glidePath) },
    {
      parts: [...prefix, 'marketAssumptions'],
      schema: marketAssumptionsFormSchema,
      value: marketAssumptionsFromConvex(plan.marketAssumptions),
    },
    { parts: [...prefix, 'taxSettings'], schema: taxSettingsFormSchema, value: taxSettingsFromConvex(plan.taxSettings) },
    { parts: [...prefix, 'privacySettings'], schema: privacySettingsFormSchema, value: privacySettingsFromConvex(plan.privacySettings) },
    {
      parts: [...prefix, 'simulationSettings'],
      schema: simulationSettingsSchema,
      value: simulationSettingsFromConvex(plan.simulationSettings),
    },
  ];

  for (const [index, income] of plan.incomes.entries()) {
    checks.push({ parts: [...prefix, 'incomes', index], schema: incomeFormSchema, value: incomeFromConvex(income) });
  }
  for (const [index, expense] of plan.expenses.entries()) {
    checks.push({ parts: [...prefix, 'expenses', index], schema: expenseFormSchema, value: expenseFromConvex(expense) });
  }
  for (const [index, account] of plan.accounts.entries()) {
    checks.push({ parts: [...prefix, 'accounts', index], schema: accountFormSchema, value: accountFromConvex(account) });
  }
  for (const [index, debt] of (plan.debts ?? []).entries()) {
    checks.push({ parts: [...prefix, 'debts', index], schema: debtFormSchema, value: debtFromConvex(debt) });
  }
  for (const [index, physicalAsset] of (plan.physicalAssets ?? []).entries()) {
    checks.push({
      parts: [...prefix, 'physicalAssets', index],
      schema: physicalAssetFormSchema,
      value: physicalAssetFromConvex(physicalAsset),
    });
  }
  for (const [index, rule] of plan.contributionRules.entries()) {
    checks.push({ parts: [...prefix, 'contributionRules', index], schema: contributionFormSchema, value: contributionFromConvex(rule) });
  }

  return checks;
}

/**
 * Runs one group of checks and appends the failures as field issues. A transformer that
 * throws (structurally valid but unreadable data) becomes an issue at the group's path
 * rather than an exception out of `parseEnvelope`.
 */
function pushDomainIssues(issues: ImportIssue[], parts: PropertyKey[], build: () => DomainCheck[]): void {
  let checks: DomainCheck[];
  try {
    checks = build();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.push({ path: formatPath(parts) || '(root)', message: `This export could not be checked against the app's rules: ${detail}` });
    return;
  }

  for (const check of checks) {
    const parsed = check.schema.safeParse(check.value);
    if (parsed.success) continue;
    issues.push(...issuesFromZodError(parsed.error, check.parts));
  }
}

// ---------------------------------------------------------------------------
// Import planning
// ---------------------------------------------------------------------------

export interface ExistingExportState {
  plans: Doc<'plans'>[];
  finances: FinancesExport | null;
}

export interface ImportOptions {
  /** Set only after the operator explicitly accepted replacing their finances. */
  confirmReplaceFinances: boolean;
  /** Timestamp for the pre-import snapshot; supplied at the UI boundary. */
  exportedAt: string;
  /** Mirrors the server's per-user plan cap. */
  maxPlans?: number;
}

export type ImportPlan =
  | { ok: false; issues: ImportIssue[] }
  | {
      ok: true;
      plans: PlanExport[];
      /** Non-null only when the export carries finances. */
      finances: FinancesExport | null;
      /** Full backup of the current state, to download before anything is written. */
      snapshot: PlansExportEnvelope;
    };

/**
 * Turns a parsed envelope into a concrete import, or into the list of reasons it
 * cannot proceed.
 *
 * This is where the destructive part is guarded: finances are only released to the
 * caller when `confirmReplaceFinances` is set, and the returned `snapshot` is the
 * pre-import backup the caller must download before applying anything.
 */
export function prepareImport(envelope: ExportEnvelope, existing: ExistingExportState, options: ImportOptions): ImportPlan {
  const plans = envelope.kind === PLAN_EXPORT_KIND ? [envelope.plan] : envelope.plans;
  const maxPlans = options.maxPlans ?? 10;
  const planPath = envelope.kind === PLAN_EXPORT_KIND ? 'plan' : 'plans';
  const issues: ImportIssue[] = [];

  if (plans.length === 0) {
    issues.push({ path: planPath, message: 'The export contains no plans.' });
  }

  if (existing.plans.length + plans.length > maxPlans) {
    issues.push({
      path: planPath,
      message: `Importing ${plans.length} plan(s) would exceed the ${maxPlans}-plan limit (${existing.plans.length} already exist). Delete a plan first.`,
    });
  }

  if (envelope.finances && !options.confirmReplaceFinances) {
    issues.push({
      path: 'finances',
      message:
        'This export contains finances. Importing them replaces every current asset and liability, so it needs explicit confirmation.',
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    plans,
    finances: envelope.finances,
    snapshot: createPlansEnvelope({ plans: existing.plans, finances: existing.finances, exportedAt: options.exportedAt }),
  };
}

/** `ignidash-plan-2026-10-30T12-00-00-000Z.json` */
export function exportFilename(envelope: ExportEnvelope, prefix = 'ignidash'): string {
  const stamp = envelope.exportedAt.replace(/[:.]/g, '-');
  const kind = envelope.kind === PLAN_EXPORT_KIND ? 'plan' : 'plans';
  return `${prefix}-${kind}-${stamp}.json`;
}
