import { z } from 'zod';

import type { Doc } from '../../../convex/_generated/dataModel';
import { planDataFields } from '../../../convex/validators/plan_data_fields';
import { assetValidator } from '../../../convex/validators/asset_validator';
import { liabilityValidator } from '../../../convex/validators/liability_validator';

import { zodFromConvexValidator, zodObjectFromValidators, type ConvexValidatorLike } from './convex-validator-to-zod';

/**
 * Export/import envelope, version 1 (P5-P1).
 *
 * A file is a versioned JSON envelope:
 *
 *   { schemaVersion: 1, kind, exportedAt, plan, finances }          // one plan
 *   { schemaVersion: 1, kind, exportedAt, plans, finances }         // every plan
 *
 * `plan`/`plans` hold the plan document without its per-deployment identity
 * (`_id`, `_creationTime`, `userId`), and `finances` holds the net-worth tracker
 * the operator owns. Adding a field anywhere in that payload is a schema change:
 * per contract 3.3 the PR that changes the shape bumps `EXPORT_SCHEMA_VERSION`, and
 * `parseEnvelope` keeps rejecting files newer than this build with a clear message
 * instead of half-importing them.
 *
 * The payload types are derived from `Doc<'plans'>`/`Doc<'finances'>` and the
 * validation schema is derived from the same Convex validators the database
 * enforces, so there is exactly one description of the shape.
 */

export const EXPORT_SCHEMA_VERSION = 1;

export const PLAN_EXPORT_KIND = 'ignidash-plan';
export const PLANS_EXPORT_KIND = 'ignidash-plans';

/** The plan document without the fields that are specific to one deployment. */
export type PlanExport = Omit<Doc<'plans'>, '_id' | '_creationTime' | 'userId'>;

/** The user-level finances (net-worth tracker) without the owning user id. */
export type FinancesExport = Pick<Doc<'finances'>, 'assets' | 'liabilities'>;

export interface PlanExportEnvelope {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  kind: typeof PLAN_EXPORT_KIND;
  exportedAt: string;
  plan: PlanExport;
  finances: FinancesExport | null;
}

export interface PlansExportEnvelope {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
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

const planEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  kind: z.literal(PLAN_EXPORT_KIND),
  exportedAt: exportedAtSchema,
  plan: planExportSchema(),
  finances: financesExportSchema().nullable(),
});

const plansEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
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

  return { ok: true, envelope: parsed.data as ExportEnvelope };
}

function checkSchemaVersion(value: Record<string, unknown>): ImportIssue | null {
  if (!('schemaVersion' in value)) {
    return {
      path: 'schemaVersion',
      message:
        'This file has no schemaVersion, so it is not an Ignidash export (v1 files carry `schemaVersion: 1`). Re-export it from Settings.',
    };
  }

  const version = value.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { path: 'schemaVersion', message: `Unsupported schemaVersion ${JSON.stringify(version)}; this build reads version 1.` };
  }

  if (version > EXPORT_SCHEMA_VERSION) {
    return {
      path: 'schemaVersion',
      message: `This file was exported by a newer Ignidash (schemaVersion ${version}); this build reads up to ${EXPORT_SCHEMA_VERSION}. Upgrade before importing it.`,
    };
  }

  return null;
}

function issuesFromZodError(error: z.ZodError): ImportIssue[] {
  const issues: ImportIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({ path: formatPath([...issue.path, key]), message: 'Unrecognized field' });
      }
      continue;
    }
    issues.push({ path: formatPath(issue.path) || '(root)', message: issue.message });
  }
  return issues;
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
