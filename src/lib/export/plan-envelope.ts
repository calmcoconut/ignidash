import { z } from 'zod';

import type { Doc } from '../../../convex/_generated/dataModel';
import { planDataFields } from '../../../convex/validators/plan_data_fields';
import { assetValidator } from '../../../convex/validators/asset_validator';
import { liabilityValidator } from '../../../convex/validators/liability_validator';

import { accountFormSchema } from '@/lib/schemas/inputs/account-form-schema';
import { contributionFormSchema, baseContributionSchema } from '@/lib/schemas/inputs/contribution-form-schema';
import { isISODateString } from '@/lib/calc/clock';
import { debtFormSchema } from '@/lib/schemas/inputs/debt-form-schema';
import { expenseFormSchema } from '@/lib/schemas/inputs/expense-form-schema';
import { glidePathFormSchema } from '@/lib/schemas/inputs/glide-path-form-schema';
import { incomeFormSchema } from '@/lib/schemas/inputs/income-form-schema';
import { marketAssumptionsFormSchema } from '@/lib/schemas/inputs/market-assumptions-form-schema';
import { physicalAssetFormSchema } from '@/lib/schemas/inputs/physical-asset-form-schema';
import { privacySettingsFormSchema } from '@/lib/schemas/inputs/privacy-settings-form-schema';
import { simulationSettingsSchema } from '@/lib/schemas/inputs/simulation-settings-form-schema';
import { taxSettingsFormSchema } from '@/lib/schemas/inputs/tax-settings-form-schema';
import { calculatePreciseAge, timelineBaseSchema } from '@/lib/schemas/inputs/timeline-form-schema';
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
import { formatPath, issuesFromZodError, type ImportIssue } from '@/lib/utils/zod-issues';

export type { ImportIssue };

import { zodFromConvexValidator, zodObjectFromValidators, type ConvexValidatorLike } from './convex-validator-to-zod';

/**
 * Export/import envelope, version 12 (P5-P1, bumped by P1-P1, P1-P2, P2-P4, P1-P8, P1-P3, P3-P3, P3-P8,
 * P3-P1b, P1-P4, P1-P5 and P1-P7).
 *
 * A file is a versioned JSON envelope:
 *
 *   { schemaVersion: 12, kind, exportedAt, plan, finances }          // one plan
 *   { schemaVersion: 12, kind, exportedAt, plans, finances }         // every plan
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
 *   3 — P1-P2 couples foundation: `owner`/`propertyRegime` on accounts, incomes, expenses,
 *       debts and physical assets, and `household` inside `timeline`.
 *   4 — P2-P4 historical backtest mode: `historicalBacktest` inside `simulationSettings`.
 *       A version 3 file may already carry it (the build that shipped P2-P4 wrote v3 files
 *       with the field, before the bump landed), so a v3 import keeps it intact rather than
 *       stripping it; only v4 guarantees the field is understood.
 *   5 — P1-P8 Social Security: `socialSecurity` on an income. Unlike the version 3 accident
 *       above, a version 4 file **cannot** carry this field: the bump lands in the change that
 *       adds it, so no build ever wrote `socialSecurity` into a v4 file. A v4 file therefore
 *       imports with the field absent, and every reader treats that income as having no Social
 *       Security estimate (`income.socialSecurity === undefined`) — not as a zero benefit, and
 *       not as an error. The same holds for v1–v3 files, which cannot carry it either.
 *   6 — P1-P3 household behaviour: optional `birthMonth`/`birthYear`/`lifeExpectancy` on a
 *       `household` member. A version 5 file cannot carry them: it holds the same household with
 *       `id` and `role` only, and every one of the three fields is optional on both sides, so a
 *       v5 household **imports unchanged** and is read through the same fallback — an absent
 *       member age means "inherit the plan-level timeline value" (the primary's own), never an
 *       error and never zero. Nothing is written back on import; the file keeps what it had.
 *
 *   7 — P3-P3 itemized deductions: optional `taxSettings.itemizedDeductions`
 *       (`mortgageInterest`, `charitable`, `stateAndLocalTaxes`, `medicalExpenses`) and
 *       `taxSettings.spouseQualifiesForSeniorDeduction`. A version 6 file **cannot** carry the
 *       block: no build ever wrote it into a v6 file. In a v6 file the absence means *the plan does
 *       not itemize* — the return takes the standard deduction — and emphatically **not** "itemized
 *       deductions of zero": a file that itemized nothing and a file that never knew about
 *       itemizing are the same arithmetic but different data, and the reader must not invent a
 *       block the file did not have. Nothing is written back on import, so re-exporting a v6 plan
 *       unchanged writes a v7 file with the block still absent, which reads the same way.
 *
 *   8 — P3-P8 California: optional `taxSettings.stateResidency` (`'CA' | 'none'`), and a change of
 *       meaning for `taxSettings.itemizedDeductions.stateAndLocalTaxes`, which is now read as
 *       **property and local taxes** because the engine computes the California income tax and adds
 *       it to the federal SALT line itself. A version 7 file cannot carry the flag: no build ever
 *       wrote it. In a v7 file the absence means **California files a return**, not "no state tax":
 *       the instance is a California one, the payroll layer has charged CA SDI unconditionally since
 *       P3-P4, and defaulting the other way would let an existing plan silently drop a tax it has
 *       been paying all along. A plan that is not a California resident says `'none'` explicitly.
 *       Nothing is written back on import, so re-exporting a v7 plan unchanged writes a v8 file with
 *       the flag still absent.
 *
 *       What absence means therefore depends on the version, and the importer says so: **before v8**
 *       it is a statement the user never made, so it is disclosed as a warning
 *       (`No state residency is stated, …`) while still importing; **at v8 and later** it is this
 *       build's own normal output — `taxSettingsToConvex` stores only the explicit opt-out, so every
 *       California plan has no flag — and it is read as California silently, because warning about
 *       correct input would train the operator to dismiss warnings.
 *
 *   9 — P3-P1b married filing separately: `taxSettings.filingStatus` gains a fourth value,
 *       `marriedFilingSeparately`. This is an **enum widening**, so it is a version bump by contract
 *       3.3 even though no key is added: a v9 file may state a status a v8 build would reject.
 *       Read the other way, and this is the whole compatibility statement: a v8 file's status keeps
 *       exactly today's meaning. `single`, `marriedFilingJointly` and `headOfHousehold` are unchanged
 *       in name and in arithmetic — the ruleset rows for those three statuses are the same rows a v8
 *       build used — and a v8 file cannot carry the new value, because no build ever wrote it. There
 *       is **no absent/implicit case to interpret**: `filingStatus` is required by the payload schema
 *       and has been carried since version 1, so every v1-v8 file states a status and that statement
 *       is preserved verbatim on import. The
 *       older-version fixtures below therefore make a v8 file by *substituting* a known status for the
 *       new one rather than by deleting the key — see `substituteFilingStatus`.
 *
 *   10 — P1-P4 withdrawal strategies: optional `simulationSettings.withdrawalStrategy`
 *        (`'ordered' | 'vpw' | 'xPercentRule' | 'guytonKlinger'`) and optional `expenses[*].essential`.
 *        A version 9 file cannot carry either, because the bump lands in the change that adds them.
 *
 *        Absent `withdrawalStrategy` means **`ordered`**: the tax-optimised sequence every earlier
 *        build ran, with no annual ceiling. A v9 plan therefore re-simulates to exactly the numbers it
 *        had, and the importer preserves the absence rather than writing `'ordered'` into the file —
 *        `getWithdrawalStrategy(undefined)` is the same object as `getWithdrawalStrategy('ordered')`,
 *        and `withdrawal-strategies.test.ts` asserts the two runs deep-equal. Stating `'ordered'`
 *        explicitly is a stored preference, not a second behaviour.
 *
 *        Absent `essential` means **`false`**: before the flag existed no expense was essential, so a
 *        v9 expense is one a withdrawal cap may cut, exactly as it was. `expenseFromConvex` applies
 *        that default, and `expenseToConvex` stores the flag only when it is `true`.
 *
 *        Neither field is a new top-level block: the strategy sits inside `simulationSettings` and the
 *        flag on each expense, so a v9 file is made by *deleting* those two keys, and the v9 fixture
 *        in `plan-envelope.test.ts` counts them before and after so the strip cannot pass vacuously.
 *
 *   11 — P1-P5 real estate II: optional `physicalAssets[*].paymentMethod.termMonths`, optional
 *        `physicalAssets[*].paymentMethod.offsetAccountId`, and optional
 *        `physicalAssets[*].propertyTax` (`ratePercent` and/or `annualAmount`). A version 10 file
 *        cannot carry any of the three, because the bump lands in the change that adds them, and
 *        the importer invents no default for any of them:
 *
 *        - Absent `termMonths` means **the monthly payment drives the loan**, which is the
 *          convention every earlier build ran: interest on the principal, the stored payment applied
 *          and deflated by inflation month by month. A v10 mortgage therefore amortises to exactly
 *          the numbers it had, and the importer keeps the absence rather than deriving a term from
 *          the payment. Stating a term is a different, explicit instruction — the engine derives the
 *          payment from the term and the APR (`amortization-schedule.ts`) — not a normalisation.
 *        - Absent `offsetAccountId` means **no offset account**: interest is charged on the whole
 *          loan principal, exactly as every earlier build did. Naming an account is a stored
 *          preference, not a second loan convention, so its absence cannot move a number.
 *        - Absent `propertyTax` means **no property tax through the engine**: the residence is
 *          charged none, which is what every earlier build did (a plan that pays property tax did it
 *          with a plain expense row, and still does). It is emphatically **not** a stated rate of
 *          zero: the block charges a bill only when it states a `ratePercent` or an `annualAmount`,
 *          so `propertyTax: {}` — what the mortgage dialog leaves behind after both inputs are
 *          cleared — also states no bill, and no build ever writes a block with no number in it.
 *          Nothing is written back, so re-exporting a v10 plan unchanged writes a v11 file with all
 *          three still absent, which reads the same way.
 *
 *        All three sit inside a physical asset's existing blocks, so a v10 file is made by
 *        *deleting* them, and the v10 fixture in `plan-envelope.test.ts` counts them before and
 *        after so the strip cannot pass vacuously.
 *
 *   12 — P1-P7 milestones: optional plan-level `milestones`, a list of
 *        `{ id, name, condition, references }`. `condition` is the milestone evaluator's own
 *        expression (`and`/`or` groups over `age`, `year`, `portfolio`, `account`, `income`,
 *        `expense` and `netWorth`), and `references` holds the ids of milestones it depends on. A
 *        version 11 file cannot carry the field, because the bump lands in the change that adds it.
 *
 *        Absent `milestones` means **no milestones**, and that is every earlier build's behaviour
 *        exactly: the engine evaluates nothing, adds no `milestones` key to its result, and the run
 *        is byte-identical to what a v11 build produced — the golden corpus, whose fixtures state no
 *        milestones, did not move. It is emphatically **not** "one milestone with no condition": a
 *        milestone whose group is empty is never met (`evaluate.ts`), so reading absence that way
 *        would invent a condition nobody wrote. The importer preserves the absence rather than
 *        writing `[]`, and `simulatorFromConvex` hands the engine `undefined`, never an empty list.
 *        A v11 file is made by *deleting* the key, and the v11 fixture in `plan-envelope.test.ts`
 *        counts it before and after so the strip cannot pass vacuously.
 *
 *   13 — R3 IRA basis: optional `accounts[*].nondeductibleBasis` on a traditional IRA. The field is
 *        the after-tax money in the account (Form 8606 lines 2 and 5) and the engine apportions a
 *        withdrawal with IRC §408(d)(2)'s fraction — basis / (year-end balance + distributions) —
 *        so part of a distribution is tax-free instead of all of it being ordinary income. A
 *        version 12 file cannot carry the field, because the bump lands in the change that adds it.
 *
 *        Absent `nondeductibleBasis` means **no after-tax basis**: every IRA dollar distributed is
 *        taxable, which is exactly what every earlier build computed. A v12 plan therefore
 *        re-simulates to the numbers it had, and the golden corpus — whose plans state no basis —
 *        did not move. It is emphatically **not** a stated zero basis: the importer preserves the
 *        absence rather than writing `0`, because "no after-tax money" and "after-tax money nobody
 *        recorded" are different statements about the file even though both tax the whole
 *        distribution. The field exists on the `ira` variant alone: a 401(k) balance follows §72,
 *        not §408(d)(2), so offering the field there would store a number nothing reads.
 *
 *        A v12 file is made by *deleting* the key. The v12 fixture in `plan-envelope.test.ts` counts
 *        it before and after so the strip cannot pass vacuously, and asserts the same plan *with* a
 *        basis runs to a different number — a bump whose field moves nothing should not exist.
 *
 *   14 — R4 Roth conversions: optional plan-level `conversions`, a list of
 *        `{ id, fromAccountId, toAccountId, year | timePoint, amount | fillToBracket }`.
 *        A version 13 file cannot carry the field, because the bump lands in the change that adds it.
 *
 *        Absent `conversions` means **no conversions**: all accounts evolve via standard
 *        contributions, growth, and withdrawals, exactly what every earlier build computed. A v13
 *        plan therefore re-simulates to the numbers it had, and the golden corpus — whose plans state
 *        no conversions — did not move. The importer preserves the absence rather than writing `[]`.
 *
 *        A v13 file is made by *deleting* the key. The v13 fixture in `plan-envelope.test.ts` counts
 *        it before and after so the strip cannot pass vacuously.
 *
 *   15 — R5 HSA qualified medical expenses: optional `expenses[*].qualifiedMedical`.
 *        A version 14 file cannot carry the field, because the bump lands in the change that adds it.
 *
 *        Absent `qualifiedMedical` means **false**: the expense is a standard non-qualified expense,
 *        which is what every expense was before the flag existed. An HSA withdrawal is not paired with
 *        it and remains subject to ordinary income tax and early-withdrawal penalties.
 *
 *        A v14 file is made by deleting the key. The upgrade test in `plan-envelope.test.ts` asserts
 *        the key is stripped.
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

export const EXPORT_SCHEMA_VERSION = 15;

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

/**
 * `ok` means the file can be imported. `warnings` lists what the app's forms would prefer
 * otherwise — the caller must show them and let the operator proceed, because a plan the
 * engine simulates is not refused for a form-level rule (see `appRuleFindings`).
 */
export type EnvelopeParseResult = { ok: true; envelope: ExportEnvelope; warnings: ImportIssue[] } | { ok: false; issues: ImportIssue[] };

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
 * Never throws: a malformed file produces a list of `{ path, message }` issues naming the
 * exact fields that failed (e.g. `plan.incomes[0].name`), so the UI can show all of them
 * instead of a truncated string. Files without a `schemaVersion`, or from a newer build, are
 * rejected with an actionable message rather than being coerced.
 *
 * A file that parses also carries `warnings` — field paths where the app's FORM rules would
 * have written something else but the engine runs the plan as it is. The caller must show
 * them (Settings → Backup & restore does, and asks before continuing) and they never change
 * the payload: a warning is not a silent drop and not a refusal.
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

  // The structural parse only proves the payload matches what Convex stores. After it: the
  // engine contract blocks, and everything the app's forms merely prefer becomes a warning
  // the operator sees and acknowledges before anything is written.
  const envelope = parsed.data as ExportEnvelope;
  const findings = appRuleFindings(envelope);
  if (findings.blocking.length > 0) return { ok: false, issues: findings.blocking };

  return { ok: true, envelope, warnings: findings.warnings };
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

// The Zod walker (`issuesFromZodError`, `formatPath`) is shared with the headless CLI:
// `src/lib/utils/zod-issues.ts`. The import path's union-discriminator behaviour is canonical,
// so `npm run headless:simulate` reports a malformed union the same way an import does.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// App rules
// ---------------------------------------------------------------------------

/**
 * Two severities, because the file is the operator's own data.
 *
 * Import/export is the only migration path a self-hosted instance has, and the app's FORM
 * rules keep tightening (the `withholding` refine, the self-employment gate, return/yield
 * ordering, the down-payment identity). If a form rule could refuse a file, every future
 * refine would retroactively make today's exports unimportable — a plan the engine simulates
 * perfectly well would be stuck outside the app. So the semantic layer is split by what the
 * ENGINE needs, not by what the forms prefer.
 *
 * BLOCKING (`engineContractIssues`) — a value the engine would throw on, turn into NaN, run
 * with no months, or silently shift into different numbers. The fourth clause matters:
 * `birthMonth: 13` crashes nothing and NaNs nothing, it makes `calculatePreciseAge` return an
 * age a year off, which moves every number in the plan. A plan that renders is not the same
 * as a plan whose figures mean what the file says, so silent corruption blocks too. Each rule
 * cites the code path that makes it blocking, beside the rule in `engineContractIssues`.
 *
 * WARNING (`planDomainChecks` below, i.e. the app's own per-domain schemas) — anything the
 * engine runs fine without: a wage income with no withholding (the engine applies `?? 0`),
 * a self-employment income (the engine path is alive; the form gate is policy — PLAN-parity
 * R8), `stockYield > stockReturn`, a loan whose down payment plus balance is not the
 * purchase price, short names, out-of-policy percentages/seeds/growth limits, and a plan that
 * states no state residency in a file older than v8 (read as California — `stateResidencyWarnings`).
 * Those are reported with their field paths and the operator decides whether to import anyway.
 *
 * Not covered, by design:
 *   - the plan document's own `name`/`isDefault`, which are not plan data and have no
 *     per-domain schema (`name` is a bare `v.string()` on the document);
 *   - the clock-dependent timeline rules in `createTimelineFormSchema(now)` (current age,
 *     life expectancy above current age, retirement age below life expectancy): an import has
 *     no "today", so `timelineBaseSchema` is the clock-free part and those comparisons only
 *     surface as warnings when a static bound catches them.
 */
interface AppRuleFindings {
  /** Would crash, corrupt or produce nothing: the import stops. */
  blocking: ImportIssue[];
  /** The app's forms prefer otherwise; the engine copes. Shown to the operator. */
  warnings: ImportIssue[];
}

function appRuleFindings(envelope: ExportEnvelope): AppRuleFindings {
  const single = envelope.kind === PLAN_EXPORT_KIND;
  const plans = single ? [envelope.plan] : envelope.plans;
  const blocking: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];

  plans.forEach((plan, index) => {
    const prefix: PropertyKey[] = single ? ['plan'] : ['plans', index];
    const contract = engineContractIssues(plan, prefix, envelope.exportedAt);
    blocking.push(...contract.blocking);
    warnings.push(...contract.warnings);
  });

  // A path the engine needs is reported once, as a blocker: drop the form schema's echo.
  const blockedPaths = new Set(blocking.map((issue) => issue.path));

  plans.forEach((plan, index) => {
    const prefix: PropertyKey[] = single ? ['plan'] : ['plans', index];
    warnings.push(...stateResidencyWarnings(plan, prefix, envelope.schemaVersion));
    pushDomainIssues(warnings, prefix, () => planDomainChecks(plan, prefix));
  });

  if (envelope.finances) {
    const finances = envelope.finances;
    pushDomainIssues(warnings, ['finances'], () => [
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

  return { blocking, warnings: warnings.filter((issue) => !blockedPaths.has(issue.path)) };
}

/** The version that introduced `taxSettings.stateResidency`; see the version history above. */
const STATE_RESIDENCY_SCHEMA_VERSION = 8;

/**
 * A plan that states no state residency is read as California (D2).
 *
 * Only files older than v8 are told about it. At v8 and later, absence is this build's normal
 * output — `taxSettingsToConvex` stores only the explicit opt-out (`'none'`), so every California
 * plan has no flag — and warning about correct input would teach the operator to dismiss warnings.
 * A pre-v8 file never had the chance to state it, so the absence is a statement the user never
 * made, and `TaxProcessor`'s default (`'CA'`, `taxes.ts:350`) is then what the reader assumes.
 *
 * It stays a WARNING, not a block: the plan runs correctly under the default, the instance is a
 * California one, and refusing the file would make every pre-v8 export unimportable for a value the
 * engine already answers. The difference is real money, though (California income tax, plus SDI
 * that is withheld whatever the flag says), which is why it is disclosed rather than kept silent.
 */
function stateResidencyWarnings(plan: PlanExport, prefix: PropertyKey[], schemaVersion: number): ImportIssue[] {
  if (schemaVersion >= STATE_RESIDENCY_SCHEMA_VERSION) return [];
  if (plan.taxSettings.stateResidency !== undefined) return [];

  return [
    {
      path: formatPath([...prefix, 'taxSettings', 'stateResidency']),
      message: 'No state residency is stated, so this plan is read as California. Set it explicitly if it is not.',
    },
  ];
}

/**
 * The engine contract: values whose absence or impossibility makes the engine throw, produce
 * NaN, simulate no months, or silently shift the computed numbers. Everything else is a form
 * preference (a warning).
 */
function engineContractIssues(plan: PlanExport, prefix: PropertyKey[], exportedAt: string): AppRuleFindings {
  const blocking: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const block = (parts: PropertyKey[], message: string) => blocking.push({ path: formatPath(parts), message });
  const warn = (parts: PropertyKey[], message: string) => warnings.push({ path: formatPath(parts), message });

  // `useSimulationClock` hands this to `fixedClock`, and `parseISODateString` (clock.ts)
  // THROWS on anything that is not a real calendar date, which puts that plan's simulator
  // page on the error boundary with no in-page way to repair it.
  const asOfDate = plan.simulationSettings.asOfDate;
  const asOfDateIsValid = asOfDate !== undefined && isISODateString(asOfDate);
  if (asOfDate !== undefined && !asOfDateIsValid) {
    block([...prefix, 'simulationSettings', 'asOfDate'], 'As-of date must be a valid ISO date (YYYY-MM-DD)');
  }

  const timeline = plan.timeline;
  if (timeline) {
    const { birthMonth, birthYear, lifeExpectancy } = timeline;

    // `calculatePreciseAge` (timeline-form-schema.ts) computes `currentMonth - birthMonth`
    // over 12, so a month outside 1..12 shifts the age by up to a year and every dated number
    // in the plan with it. No throw, no NaN: silent corruption.
    const birthMonthIsValid = isIntegerWithin(birthMonth, 1, 12);
    if (!birthMonthIsValid) {
      block(
        [...prefix, 'timeline', 'birthMonth'],
        'Birth month must be a whole month from 1 to 12; the age arithmetic reads it as a month index.'
      );
    }

    // The same arithmetic: a year outside 1900..2100 gives a nonsense starting age, and
    // `initSimulationContext` also derives the RMD age from `birthYear >= 1960`.
    const birthYearIsValid = isIntegerWithin(birthYear, 1900, 2100);
    if (!birthYearIsValid) {
      block(
        [...prefix, 'timeline', 'birthYear'],
        'Birth year must be a whole year from 1900 to 2100; the ages and the RMD age are derived from it.'
      );
    }

    // `SimulationEngine.initSimulationContext` computes
    // `yearsToSimulate = Math.ceil(lifeExpectancy - startAge)` and the month loop runs
    // `yearsToSimulate * 12` times: zero or negative means no months at all, so every readout
    // is empty.
    if (!(lifeExpectancy > 0)) {
      block(
        [...prefix, 'timeline', 'lifeExpectancy'],
        'Life expectancy must be a positive number of years; otherwise the run has no months to simulate.'
      );
    } else if (birthMonthIsValid && birthYearIsValid) {
      // The same empty-run arm when the horizon is already behind the plan holder. The
      // current age needs a date, and there are only two the file carries: its own
      // `asOfDate` (exact, so it can block) and its `exportedAt`. Ages only grow from the
      // export date, so that is a sound lower bound for today — never an invented "today".
      const ageAtAsOf = asOfDateIsValid ? calculatePreciseAge(birthMonth, birthYear, asOfDate) : undefined;
      if (ageAtAsOf !== undefined && lifeExpectancy <= ageAtAsOf) {
        block(
          [...prefix, 'timeline', 'lifeExpectancy'],
          `Life expectancy (${lifeExpectancy}) is at or below the plan holder's age on the as-of date (${formatAge(ageAtAsOf)}), so the run has no months to simulate.`
        );
      } else if (asOfDate === undefined) {
        // `exportedAt` is a full timestamp; `calculatePreciseAge` takes `YYYY-MM-DD`, so use
        // the timestamp's own calendar date and only when that date is real.
        const exportedOn = exportedAt.slice(0, 10);
        const ageAtExport = isISODateString(exportedOn) ? calculatePreciseAge(birthMonth, birthYear, exportedOn) : Number.NaN;
        if (lifeExpectancy <= ageAtExport) {
          warn(
            [...prefix, 'timeline', 'lifeExpectancy'],
            `Life expectancy (${lifeExpectancy}) is at or below the plan holder's age on this file's export date (${formatAge(ageAtExport)}), so the run may have no months. This file pins no asOfDate, so the importer cannot check the horizon against today without inventing a date; set simulationSettings.asOfDate or raise the life expectancy.`
          );
        }
      }
    }
  }

  // `TimeBinding.amountScale` (time-binding.ts) divides by
  // `cumulativeInflationIndex` = `Math.pow(1 + rate / 100, years)`. At exactly -100% that
  // divisor is 0, so a nominal amount becomes Infinity; below -100% the base is negative, so
  // a fractional-year event yields NaN and an integer-year one flips the amount's sign.
  const inflationRate = plan.marketAssumptions.inflationRate;
  if (!Number.isFinite(inflationRate) || inflationRate <= -100) {
    block(
      [...prefix, 'marketAssumptions', 'inflationRate'],
      'Inflation rate must be above -100%; the real/nominal conversion divides by the cumulative index.'
    );
  }

  for (const [index, account] of plan.accounts.entries()) {
    // `Account` (account.ts) sets `currPercentBonds = percentBonds / 100` and derives the
    // stock share from it, so an absent value turns every balance in the plan into NaN.
    // Savings hold cash only and carry no percentage.
    if (account.type === 'savings') continue;
    if (typeof account.percentBonds !== 'number' || !Number.isFinite(account.percentBonds)) {
      block(
        [...prefix, 'accounts', index, 'percentBonds'],
        `A ${account.type} account needs a bond percentage; without it every balance becomes NaN.`
      );
    }
  }

  for (const [index, debt] of (plan.debts ?? []).entries()) {
    // `Debt.calculateMonthlyInterest` (debts.ts) throws "Missing compoundingFrequency" for a
    // compound debt that has none.
    if (debt.interestType === 'compound' && debt.compoundingFrequency === undefined) {
      block(
        [...prefix, 'debts', index, 'compoundingFrequency'],
        'A compound-interest debt needs a compounding frequency; the debt processor throws without one.'
      );
    }
  }

  // `timePointProgress` (time-binding.ts) reads the end point's age/month/year directly and
  // returns a NaN fraction without them, which makes the glide path's bond allocation NaN.
  const glidePath = plan.glidePath;
  if (glidePath?.enabled && !hasResolvableEndPoint(glidePath.endTimePoint)) {
    block(
      [...prefix, 'glidePath', 'endTimePoint'],
      'An enabled glide path needs a real end point (an age, or a month and year); otherwise the bond allocation becomes NaN.'
    );
  }

  return { blocking, warnings };
}

/** Ages are fractional; one decimal is enough to show why a horizon failed. */
function formatAge(age: number): string {
  return String(Math.round(age * 10) / 10);
}

function isIntegerWithin(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** A glide-path end point can be resolved when the value the engine reads is there. */
function hasResolvableEndPoint(endTimePoint: {
  type: string;
  age?: number | undefined;
  month?: number | undefined;
  year?: number | undefined;
}): boolean {
  if (endTimePoint.type === 'customAge') return typeof endTimePoint.age === 'number';
  if (endTimePoint.type === 'customDate')
    return isIntegerWithin(endTimePoint.month ?? Number.NaN, 1, 12) && typeof endTimePoint.year === 'number';

  return false;
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
/** The plan-data half of an export, in the shape `createPlanWithData` takes it. */
export type PastedPlanData = Omit<PlanExport, 'name' | 'isDefault'>;

export type PastedPlanImport = { ok: false; issues: ImportIssue[] } | { ok: true; planData: PastedPlanData; warnings: ImportIssue[] };

/**
 * The "paste a plan" path (Dashboard → New plan → Import from JSON).
 *
 * Uses the same envelope reader and the same guards as the Settings restore, minus the two
 * things this path cannot do: a bulk file has nowhere to go (one dialog, one plan), and
 * finances must be replaced with an explicit confirmation (Settings). What it must NOT drop
 * is `warnings` — a pasted plan the engine can run is not refused for a form-level rule, and
 * a warning nobody sees is the same bug as a refusal. The caller shows them and continues.
 */
export function preparePastedPlan(text: string): PastedPlanImport {
  const parsed = parseEnvelope(text);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  if (parsed.envelope.kind !== PLAN_EXPORT_KIND) {
    return {
      ok: false,
      issues: [{ path: 'kind', message: 'This file contains several plans. Restore it from Settings → Backup & restore.' }],
    };
  }

  if (parsed.envelope.finances) {
    return {
      ok: false,
      issues: [
        {
          path: 'finances',
          message: 'This file also contains finances. Restore it from Settings → Backup & restore so replacing them can be confirmed.',
        },
      ],
    };
  }

  const { name: _name, isDefault: _isDefault, ...planData } = parsed.envelope.plan;

  return { ok: true, planData, warnings: parsed.warnings };
}

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
