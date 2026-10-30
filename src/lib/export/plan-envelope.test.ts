import { describe, expect, it } from 'vitest';

import type { Doc } from '../../../convex/_generated/dataModel';
import { planDataFields } from '../../../convex/validators/plan_data_fields';
import { basicTemplate } from '../../../convex/templates/basic';
import { earlyRetirementTemplate } from '../../../convex/templates/early_retirement';
import { type HouseholdMember, resolveHouseholdMember } from '@/lib/schemas/inputs/household-schema';
import { taxSettingsFromConvex } from '@/lib/utils/data-transformers';

import {
  EXPORT_SCHEMA_VERSION,
  MIN_EXPORT_SCHEMA_VERSION,
  PLAN_EXPORT_KIND,
  PLANS_EXPORT_KIND,
  createPlanEnvelope,
  createPlansEnvelope,
  exportFilename,
  parseEnvelope,
  planExportKeys,
  planExportSchema,
  prepareImport,
  preparePastedPlan,
  serializeEnvelope,
  toFinancesExport,
  toPlanExport,
  type ExportEnvelope,
  type ImportIssue,
  type PlanExport,
} from './plan-envelope';

const EXPORTED_AT = '2026-10-30T12:00:00.000Z';

/**
 * Keys a plan export must carry: the two document fields plus everything the
 * plans validator stores. Derived from the validator so a new plan field shows up
 * here without editing this file — which is what gives the guard its teeth.
 */
const EXPECTED_PLAN_EXPORT_KEYS = ['isDefault', 'name', ...Object.keys(planDataFields)].sort();

const GLIDE_PATH = {
  id: 'glide-path-1',
  endTimePoint: { type: 'customAge' as const, age: 65 },
  targetBondAllocation: 60,
  enabled: true,
};

/** A plan document in the shape the database returns, with every optional field set. */
function makePlanDoc(overrides: Record<string, unknown> = {}): Doc<'plans'> {
  // One of each field the bumps added, so the older-version fixtures below have something to
  // strip (see `stripFields`):
  //   v2 — incomes[0].amountBasis, incomes[0].timeframe.start.everyNYears / .recurrenceYears.
  //   v3 — incomes[0].owner, debts[0].owner / .propertyRegime, timeline.household.
  //   v4 — simulationSettings.historicalBacktest.
  //   v5 — incomes[0].socialSecurity.
  //   v6 — timeline.household.members[*].birthMonth / .birthYear / .lifeExpectancy.
  //   v7 — taxSettings.itemizedDeductions / .spouseQualifiesForSeniorDeduction.
  //   v8 — taxSettings.stateResidency.
  const [firstIncome, ...otherIncomes] = basicTemplate.incomes;
  const incomes = [
    {
      ...firstIncome,
      amountBasis: 'nominal' as const,
      owner: 'partner' as const,
      socialSecurity: { mode: 'manual' as const, pia: 2400, claimAge: 67, colaRate: 3 },
      timeframe: { ...firstIncome.timeframe, start: { ...firstIncome.timeframe.start, everyNYears: 5, recurrenceYears: 20 } },
    },
    ...otherIncomes,
  ];

  const doc = {
    ...basicTemplate,
    _id: 'plan-1',
    _creationTime: 1,
    userId: 'user-1',
    name: 'My Plan',
    isDefault: true,
    incomes,
    // A two-member household that knows both ages, so the v6 fixture has v6 fields to strip and
    // the v5 fixture below is the same household with only `id` and `role` on each member.
    timeline: {
      ...basicTemplate.timeline!,
      household: {
        members: [
          { id: 'primary', role: 'primary' as const, birthMonth: 4, birthYear: 1980, lifeExpectancy: 88 },
          { id: 'partner', role: 'partner' as const, birthMonth: 9, birthYear: 1984, lifeExpectancy: 92 },
        ],
      },
    },
    simulationSettings: { ...basicTemplate.simulationSettings, historicalBacktest: { mode: 'truncate' as const } },
    // A plan that itemizes, so the v7 fixture has the block to strip and a v6 file is the same plan
    // without it — which reads as "does not itemize", not as itemizing zeros.
    taxSettings: {
      ...basicTemplate.taxSettings,
      stateResidency: 'none' as const,
      itemizedDeductions: { mortgageInterest: 12000, charitable: 5000, stateAndLocalTaxes: 30000, medicalExpenses: 0 },
      spouseQualifiesForSeniorDeduction: true,
    },
    glidePath: GLIDE_PATH,
    debts: [
      {
        id: 'debt-1',
        name: 'Mortgage',
        balance: 250000,
        apr: 4.25,
        interestType: 'compound',
        compoundingFrequency: 'monthly',
        startDate: { type: 'now' },
        monthlyPayment: 1500,
        disabled: false,
        syncedFinanceId: 'liability-1',
        owner: 'joint' as const,
        propertyRegime: 'jointTenancy' as const,
      },
    ],
    physicalAssets: [
      {
        id: 'asset-1',
        name: 'Primary Residence',
        assetType: 'primaryResidence',
        purchaseDate: { type: 'now' },
        purchasePrice: 600000,
        marketValue: 650000,
        appreciationRate: 3,
        saleDate: { type: 'atLifeExpectancy' },
        paymentMethod: { type: 'loan', downPayment: 120000, loanBalance: 480000, apr: 5, monthlyPayment: 2500 },
        syncedAssetId: 'finance-asset-1',
        syncedLiabilityId: 'liability-1',
      },
    ],
    ...overrides,
  };
  // SAFETY: the fixture above carries exactly the plans document fields; the cast only
  // supplies Convex's branded `_id`/`_creationTime` types that JSON fixtures cannot express.
  return doc as unknown as Doc<'plans'>;
}

function makeFinancesDoc(overrides: Record<string, unknown> = {}): Doc<'finances'> {
  const doc = {
    _id: 'finances-1',
    _creationTime: 1,
    userId: 'user-1',
    assets: [{ id: 'finance-asset-1', name: 'Brokerage', value: 42000, type: 'taxableBrokerage', updatedAt: 1_700_000_000_000 }],
    liabilities: [{ id: 'liability-1', name: 'Mortgage', balance: 250000, type: 'mortgage', updatedAt: 1_700_000_000_000 }],
    ...overrides,
  };
  // SAFETY: same as makePlanDoc — a complete finances document with branded ids.
  return doc as unknown as Doc<'finances'>;
}

function parseOrThrow(text: string): ExportEnvelope {
  const parsed = parseEnvelope(text);
  if (!parsed.ok) throw new Error(`expected a valid envelope, got: ${JSON.stringify(parsed.issues)}`);
  return parsed.envelope;
}

/**
 * Parses a mutated export and returns its issues.
 *
 * Mutation is by hand on the parsed JSON, so the file — not the fixture builder — is what
 * the parser sees.
 */
function issuesFor(mutate: (envelope: Record<string, unknown>) => void): ImportIssue[] {
  const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
  const mutated = structuredClone(envelope) as unknown as Record<string, unknown>;
  mutate(mutated);
  const parsed = parseEnvelope(JSON.stringify(mutated));
  if (parsed.ok) throw new Error('expected the file to be rejected');
  return parsed.issues;
}

/**
 * Parses a mutated export that is expected to IMPORT, and returns the warnings it carries.
 * A file that is refused fails here, so a warning-class test cannot pass by being blocking.
 */
function warningsFor(mutate: (envelope: Record<string, unknown>) => void): ImportIssue[] {
  const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
  const mutated = structuredClone(envelope) as unknown as Record<string, unknown>;
  mutate(mutated);
  const parsed = parseEnvelope(JSON.stringify(mutated));
  if (!parsed.ok) throw new Error(`expected the file to import, got: ${JSON.stringify(parsed.issues)}`);
  return parsed.warnings;
}

/**
 * Fields P1-P1 added in schema version 2. A version 1 file predates all of them, so the v1
 * fixture is the current export with these keys removed wherever they appear.
 */
/** What the v2 bump (P1-P1) added. */
const VERSION_2_FIELDS = ['everyNYears', 'recurrenceYears', 'amountBasis'];

/** What the v3 bump (P1-P2) added. */
const VERSION_3_FIELDS = ['owner', 'propertyRegime', 'household'];

/** What the v4 bump (P2-P4) added. */
const VERSION_4_FIELDS = ['historicalBacktest'];

/** What the v5 bump (P1-P8) added. */
const VERSION_5_FIELDS = ['socialSecurity'];

/** What the v6 bump (P1-P3) added: a household member's own ages. */
const VERSION_6_FIELDS = ['birthMonth', 'birthYear', 'lifeExpectancy'];

/** What the v7 bump (P3-P3) added: the itemized-deduction inputs inside `taxSettings`. */
const VERSION_7_FIELDS = ['itemizedDeductions', 'spouseQualifiesForSeniorDeduction'];

/** What the v8 bump (P3-P8) added: the state-residency flag inside `taxSettings`. */
const VERSION_8_FIELDS = ['stateResidency'];

/**
 * Visits every household member in a payload, wherever the envelope keeps it.
 *
 * The v6 fields are stripped and counted through this rather than through `stripFields`, because
 * `timeline.birthMonth`, `timeline.birthYear` and `timeline.lifeExpectancy` are version-1 plan
 * fields with the same names: a blanket strip would fabricate a file no version ever wrote.
 */
function forEachHouseholdMember(value: unknown, visit: (member: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) forEachHouseholdMember(entry, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.members)) {
    for (const member of record.members) {
      if (typeof member === 'object' && member !== null) visit(member as Record<string, unknown>);
    }
  }
  for (const entry of Object.values(record)) forEachHouseholdMember(entry, visit);
}

/** How many member ages a payload carries, so a strip can be shown to have had work to do. */
function countMemberAges(value: unknown): number {
  let total = 0;
  forEachHouseholdMember(value, (member) => {
    total += VERSION_6_FIELDS.filter((field) => field in member).length;
  });

  return total;
}

/** Removes every member age, leaving the members themselves — the shape a v5 file has. */
function stripMemberAges(value: unknown): void {
  forEachHouseholdMember(value, (member) => {
    for (const field of VERSION_6_FIELDS) delete member[field];
  });
}

/** Removes every key in `fields` wherever it appears, so a payload can be turned into an older file. */
function stripFields(value: unknown, fields: readonly string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripFields(entry, fields);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  for (const field of fields) delete record[field];
  for (const entry of Object.values(record)) stripFields(entry, fields);
}

/** How many fields from `fields` a payload carries, so a strip can be shown to have had work to do. */
function countFields(value: unknown, fields: readonly string[]): number {
  if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + countFields(entry, fields), 0);
  if (typeof value !== 'object' || value === null) return 0;

  const record = value as Record<string, unknown>;
  const own = fields.filter((field) => field in record).length;

  return own + Object.values(record).reduce<number>((total, entry) => total + countFields(entry, fields), 0);
}

describe('the export guard is derived from the plans validator', () => {
  it('covers every field the plans validator stores', () => {
    expect(planExportKeys()).toEqual(EXPECTED_PLAN_EXPORT_KEYS);
  });

  it('actually copies each of those fields out of a fully populated plan', () => {
    const exported = toPlanExport(makePlanDoc());

    expect(Object.keys(exported).sort()).toEqual(EXPECTED_PLAN_EXPORT_KEYS);

    // A dropped field fails here by name rather than as a truncated message.
    for (const key of EXPECTED_PLAN_EXPORT_KEYS) {
      expect(exported, `toPlanExport dropped plan field "${key}"`).toHaveProperty(key);
    }
  });

  it('accepts its own export through the validator-derived schema', () => {
    const exported = toPlanExport(makePlanDoc());
    const result = planExportSchema().safeParse(exported);

    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });
});

describe('round trip', () => {
  it('restores a plan, its glide path and the finances byte-for-byte', () => {
    const plan = makePlanDoc();
    const finances = makeFinancesDoc();

    const envelope = createPlanEnvelope({ plan, finances: toFinancesExport(finances), exportedAt: EXPORTED_AT });
    const restored = parseOrThrow(serializeEnvelope(envelope));

    expect(restored).toStrictEqual(envelope);
    expect(restored.kind).toBe(PLAN_EXPORT_KIND);
    expect(restored.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    if (restored.kind !== PLAN_EXPORT_KIND) throw new Error('expected a plan envelope');

    expect(restored.plan).toStrictEqual(toPlanExport(plan));
    expect(restored.plan.glidePath).toStrictEqual(GLIDE_PATH);
    expect(restored.plan.debts).toStrictEqual(toPlanExport(plan).debts);
    expect(restored.plan.physicalAssets).toStrictEqual(toPlanExport(plan).physicalAssets);
    expect(restored.finances).toStrictEqual(toFinancesExport(finances));
  });

  it('round-trips every plan in a bulk export plus finances', () => {
    const plans = [makePlanDoc(), makePlanDoc({ _id: 'plan-2', name: 'Second Plan', isDefault: false, glidePath: undefined })];
    const finances = makeFinancesDoc();

    const envelope = createPlansEnvelope({ plans, finances: toFinancesExport(finances), exportedAt: EXPORTED_AT });
    const restored = parseOrThrow(serializeEnvelope(envelope));

    expect(restored).toStrictEqual(envelope);
    expect(restored.kind).toBe(PLANS_EXPORT_KIND);
    if (restored.kind !== PLANS_EXPORT_KIND) throw new Error('expected a plans envelope');
    expect(restored.plans).toHaveLength(2);
    expect(restored.plans[0]).toStrictEqual(toPlanExport(plans[0]));
    expect(restored.finances).toStrictEqual(toFinancesExport(finances));
  });

  it('round-trips a template plan (no optional fields stored)', () => {
    // SAFETY: same fixture construction as makePlanDoc.
    const templatePlan = {
      ...earlyRetirementTemplate,
      _id: 'plan-3',
      _creationTime: 2,
      userId: 'user-1',
      name: 'FIRE',
    } as unknown as Doc<'plans'>;
    const restored = parseOrThrow(serializeEnvelope(createPlanEnvelope({ plan: templatePlan, finances: null, exportedAt: EXPORTED_AT })));

    expect(restored.kind).toBe(PLAN_EXPORT_KIND);
    if (restored.kind !== PLAN_EXPORT_KIND) throw new Error('expected a plan envelope');
    expect(restored.plan).toStrictEqual(toPlanExport(templatePlan));
    expect(restored.finances).toBeNull();
  });
});

describe('malformed files report the exact field paths', () => {
  it('names a nested field path instead of truncating the message', () => {
    const issues = issuesFor((envelope) => {
      const plan = envelope.plan as Record<string, unknown>;
      const incomes = plan.incomes as Record<string, unknown>[];
      incomes[0] = { ...incomes[0], name: 123 };
    });

    expect(issues.map((issue) => issue.path)).toContain('plan.incomes[0].name');
    // The whole message list survives: no 250-character cut anywhere.
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(issue.message.length).toBeLessThan(300);
  });

  it('names a bad enum, a missing required field and an unknown field', () => {
    const badEnum = issuesFor((envelope) => {
      (envelope.plan as Record<string, unknown>).taxSettings = { filingStatus: 'bogus' };
    });
    expect(badEnum.map((issue) => issue.path)).toContain('plan.taxSettings.filingStatus');

    const missing = issuesFor((envelope) => {
      delete (envelope.plan as Record<string, unknown>).timeline;
    });
    expect(missing.map((issue) => issue.path)).toContain('plan.timeline');

    const unknown = issuesFor((envelope) => {
      (envelope.plan as Record<string, unknown>).bogusField = true;
    });
    expect(unknown).toContainEqual({ path: 'plan.bogusField', message: 'Unrecognized field' });
  });

  it('names the failing finances field', () => {
    const issues = issuesFor((envelope) => {
      (envelope.finances as Record<string, unknown>).assets = [{ id: 'a', name: 'Broken' }];
    });

    expect(issues.map((issue) => issue.path)).toContain('finances.assets[0].value');
  });

  it('rejects a file with no schemaVersion and says what to do', () => {
    const { schemaVersion: _schemaVersion, ...legacy } = createPlanEnvelope({
      plan: makePlanDoc(),
      finances: null,
      exportedAt: EXPORTED_AT,
    });
    const parsed = parseEnvelope(JSON.stringify(legacy));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].path).toBe('schemaVersion');
    expect(parsed.issues[0].message).toMatch(/no schemaVersion/i);
    expect(parsed.issues[0].message).toMatch(/Settings/i);
  });

  it('rejects a lower and a higher schemaVersion with distinct messages', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });

    const older = parseEnvelope(JSON.stringify({ ...envelope, schemaVersion: 0 }));
    const newer = parseEnvelope(JSON.stringify({ ...envelope, schemaVersion: EXPORT_SCHEMA_VERSION + 1 }));

    expect(older.ok).toBe(false);
    expect(newer.ok).toBe(false);
    if (older.ok || newer.ok) return;
    expect(older.issues[0].path).toBe('schemaVersion');
    // Derived from the constants, not a literal: a bump must not need this line edited, and the
    // message still has to name the real range.
    expect(older.issues[0].message).toContain(`reads versions ${MIN_EXPORT_SCHEMA_VERSION} through ${EXPORT_SCHEMA_VERSION}`);
    expect(newer.issues[0].message).toMatch(/newer Ignidash/i);
    expect(newer.issues[0].message).toMatch(/Upgrade/i);
  });

  it('accepts every version in the range and stamps the current one', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    expect(envelope.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);

    const at = (version: unknown) => parseEnvelope(JSON.stringify({ ...envelope, schemaVersion: version }));

    // The whole written history, named rather than implied: a bump that forgets to keep reading
    // an older file fails here, not in a support thread. Adding version 8 means adding it here.
    const writtenVersions = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(MIN_EXPORT_SCHEMA_VERSION).toBe(1);
    expect(writtenVersions).toHaveLength(EXPORT_SCHEMA_VERSION - MIN_EXPORT_SCHEMA_VERSION + 1);

    for (const version of writtenVersions) {
      const parsed = at(version);
      expect(parsed.ok, `schemaVersion ${version} should import: ${!parsed.ok ? JSON.stringify(parsed.issues) : ''}`).toBe(true);
      if (parsed.ok) expect(parsed.envelope.schemaVersion).toBe(version);
    }

    // Only the current payload shape can be written, so a non-integer or a string is refused
    // by the same gate rather than coerced into the range.
    for (const outside of [MIN_EXPORT_SCHEMA_VERSION - 1, EXPORT_SCHEMA_VERSION + 1, 1.5, '1', null]) {
      const parsed = at(outside);
      expect(parsed.ok, `schemaVersion ${JSON.stringify(outside)} should be refused`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].path).toBe('schemaVersion');
    }
  });

  it('still imports a version 1 export after the bumps to versions 2, 3, 4 and 5', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
    const v1 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v1.schemaVersion = 1;

    // The strip is guarded in both directions: the fixture really carries the fields each bump
    // added, and none survives, so "a v1 file still imports" is not vacuously true.
    expect(countFields(v1, VERSION_8_FIELDS)).toBe(1);
    stripFields(v1, VERSION_8_FIELDS);
    expect(countFields(v1, VERSION_8_FIELDS)).toBe(0);
    expect(countFields(v1, VERSION_7_FIELDS)).toBe(2);
    stripFields(v1, VERSION_7_FIELDS);
    expect(countFields(v1, VERSION_7_FIELDS)).toBe(0);
    expect(countFields(v1, VERSION_5_FIELDS)).toBe(1);
    stripFields(v1, VERSION_5_FIELDS);
    expect(countFields(v1, VERSION_5_FIELDS)).toBe(0);
    expect(countFields(v1, VERSION_4_FIELDS)).toBe(1);
    stripFields(v1, VERSION_4_FIELDS);
    expect(countFields(v1, VERSION_4_FIELDS)).toBe(0);
    expect(countFields(v1, VERSION_3_FIELDS)).toBe(4);
    stripFields(v1, VERSION_3_FIELDS);
    expect(countFields(v1, VERSION_3_FIELDS)).toBe(0);
    expect(countFields(v1, VERSION_2_FIELDS)).toBe(3);
    stripFields(v1, VERSION_2_FIELDS);
    expect(countFields(v1, VERSION_2_FIELDS)).toBe(0);

    const parsed = parseEnvelope(JSON.stringify(v1));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    // The file keeps its own version; it is not relabelled as this build's.
    expect(parsed.envelope.schemaVersion).toBe(1);
    // Nothing was dropped on the way in: the v1 payload is carried through intact.
    expect(parsed.envelope).toStrictEqual(v1);

    // And it is importable, not merely parseable.
    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;
    expect(imported.plans).toHaveLength(1);
    expect(imported.finances).toStrictEqual(toFinancesExport(makeFinancesDoc()));
    // Re-exporting a restored v1 file writes the current version (contract 3.3).
    expect(imported.snapshot.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
  });

  it('still imports a version 2 export after the bumps to versions 3, 4 and 5', () => {
    // The file a build from before P1-P2 writes: it has the v2 time-binding fields and none of
    // the v3 ownership, v4 backtest-mode or v5 Social Security ones. It must import with them
    // absent, not defaulted.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const v2 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v2.schemaVersion = 2;

    expect(countFields(v2, VERSION_8_FIELDS)).toBe(1);
    stripFields(v2, VERSION_8_FIELDS);
    expect(countFields(v2, VERSION_8_FIELDS)).toBe(0);
    expect(countFields(v2, VERSION_7_FIELDS)).toBe(2);
    stripFields(v2, VERSION_7_FIELDS);
    expect(countFields(v2, VERSION_7_FIELDS)).toBe(0);
    expect(countFields(v2, VERSION_5_FIELDS)).toBe(1);
    stripFields(v2, VERSION_5_FIELDS);
    expect(countFields(v2, VERSION_5_FIELDS)).toBe(0);
    expect(countFields(v2, VERSION_4_FIELDS)).toBe(1);
    stripFields(v2, VERSION_4_FIELDS);
    expect(countFields(v2, VERSION_4_FIELDS)).toBe(0);
    expect(countFields(v2, VERSION_3_FIELDS)).toBe(4);
    stripFields(v2, VERSION_3_FIELDS);
    expect(countFields(v2, VERSION_3_FIELDS)).toBe(0);
    // The v2 fields are still there: this is a v2 file, not a v1 one.
    expect(countFields(v2, VERSION_2_FIELDS)).toBe(3);

    const parsed = parseEnvelope(JSON.stringify(v2));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    expect(parsed.envelope.schemaVersion).toBe(2);
    expect(parsed.envelope).toStrictEqual(v2);

    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;
    expect(imported.plans).toHaveLength(1);
    // Absent in the file, absent after import: readers apply `owner ?? 'primary'` and treat a
    // missing household as one person, so the plan keeps simulating exactly as it did.
    const plan = imported.plans[0] as unknown as Record<string, unknown>;
    expect((plan.incomes as Record<string, unknown>[])[0]).not.toHaveProperty('owner');
    expect(plan).not.toHaveProperty('household');
    expect(((plan.timeline as Record<string, unknown>) ?? {}).household).toBeUndefined();
  });

  it('imports a version 3 file with the v4 field intact, because v3 builds wrote it that way', () => {
    // P2-P4 added `historicalBacktest` to the validator before the version bump landed, so this
    // build wrote v3 files that carry the field. Those files must not be stripped or refused: a v3
    // reader keeps whatever it finds, and this build understands the field.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const v3WithField = structuredClone(envelope) as unknown as Record<string, unknown>;
    v3WithField.schemaVersion = 3;

    // A v3 file cannot carry `socialSecurity` (v5), the itemized block (v7) or the member ages
    // (v6) either, so strip those and keep the v4 field — which is the accident this test is about.
    expect(countFields(v3WithField, VERSION_8_FIELDS)).toBe(1);
    stripFields(v3WithField, VERSION_8_FIELDS);
    expect(countFields(v3WithField, VERSION_8_FIELDS)).toBe(0);
    expect(countFields(v3WithField, VERSION_7_FIELDS)).toBe(2);
    stripFields(v3WithField, VERSION_7_FIELDS);
    expect(countFields(v3WithField, VERSION_7_FIELDS)).toBe(0);
    stripMemberAges(v3WithField);
    stripFields(v3WithField, VERSION_5_FIELDS);
    expect(countFields(v3WithField, VERSION_5_FIELDS)).toBe(0);
    expect(countFields(v3WithField, VERSION_4_FIELDS)).toBe(1);

    const parsed = parseEnvelope(JSON.stringify(v3WithField));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    expect(parsed.envelope.schemaVersion).toBe(3);
    // Nothing was stripped on the way in.
    expect(parsed.envelope).toStrictEqual(v3WithField);

    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;
    const plan = imported.plans[0] as unknown as Record<string, unknown>;
    expect((plan.simulationSettings as Record<string, unknown>).historicalBacktest).toEqual({ mode: 'truncate' });

    // The other v3 file, from a build before P2-P4, has no such field and still imports.
    const v3WithoutField = structuredClone(v3WithField);
    stripFields(v3WithoutField, VERSION_4_FIELDS);
    expect(countFields(v3WithoutField, VERSION_4_FIELDS)).toBe(0);
    expect(parseEnvelope(JSON.stringify(v3WithoutField)).ok).toBe(true);
  });

  it('reads a v4 file whose payload predates the v4 field (the v3 shape)', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });

    expect(envelope.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(countFields(envelope, VERSION_4_FIELDS)).toBe(1);
    expect(parseEnvelope(JSON.stringify(envelope)).ok).toBe(true);

    // A v4 file whose payload predates the field (the v3 shape) is still accepted: every bump so
    // far is additive, so the readers default rather than refuse. It cannot carry v5's field
    // either, so both are stripped and the file is stamped with its own version explicitly —
    // this fixture must not move when the current version bumps again.
    const v3Shaped = structuredClone(envelope) as unknown as Record<string, unknown>;
    stripFields(v3Shaped, [...VERSION_7_FIELDS, ...VERSION_5_FIELDS, ...VERSION_4_FIELDS]);
    v3Shaped.schemaVersion = 4;
    expect(countFields(v3Shaped, VERSION_4_FIELDS)).toBe(0);
    expect(countFields(v3Shaped, VERSION_5_FIELDS)).toBe(0);
    expect(countFields(v3Shaped, VERSION_7_FIELDS)).toBe(0);
    expect(countFields(v3Shaped, VERSION_3_FIELDS)).toBe(4); // still a v4-era payload otherwise

    const parsed = parseEnvelope(JSON.stringify(v3Shaped));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.schemaVersion).toBe(4);
  });

  it('imports a version 4 file, which cannot carry `socialSecurity`, and reads it as absent', () => {
    // v5 is the change that adds the field, so no v4 build ever wrote it: a v4 file that carries
    // `socialSecurity` would be a fabricated fixture. This one is the real shape — the v5 export
    // with the v5 field stripped — and it must import with the income's Social Security block
    // absent, which every reader treats as "this income has no estimate", not as a zero benefit.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const v4 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v4.schemaVersion = 4;

    // Non-vacuous: the fixture really has the fields, and none survives the strip.
    expect(countFields(v4, VERSION_8_FIELDS)).toBe(1);
    stripFields(v4, VERSION_8_FIELDS);
    expect(countFields(v4, VERSION_8_FIELDS)).toBe(0);
    expect(countFields(v4, VERSION_7_FIELDS)).toBe(2);
    stripFields(v4, VERSION_7_FIELDS);
    expect(countFields(v4, VERSION_7_FIELDS)).toBe(0);
    expect(countFields(v4, VERSION_5_FIELDS)).toBe(1);
    stripFields(v4, VERSION_5_FIELDS);
    expect(countFields(v4, VERSION_5_FIELDS)).toBe(0);
    // The v4 field itself is still there: this is a v4 file, not an older one.
    expect(countFields(v4, VERSION_4_FIELDS)).toBe(1);

    const parsed = parseEnvelope(JSON.stringify(v4));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    expect(parsed.envelope.schemaVersion).toBe(4);
    expect(parsed.envelope).toStrictEqual(v4);

    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;

    const income = (imported.plans[0] as unknown as { incomes: Record<string, unknown>[] }).incomes[0];
    expect(income).not.toHaveProperty('socialSecurity');
    // ...and the stored income still carries everything a v4 file does have.
    expect(income).toHaveProperty('amountBasis', 'nominal');
    expect(income).toHaveProperty('owner', 'partner');
  });

  it('imports a version 5 household without member ages as a fallback, not as an error or a zero', () => {
    // v6 is the change that adds `birthMonth`/`birthYear`/`lifeExpectancy` to a member, so this is
    // the real v5 shape: the same two-person household with only `id` and `role` on each member.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    expect(countMemberAges(envelope)).toBe(6); // two members, three ages each

    const v5 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v5.schemaVersion = 5;
    stripMemberAges(v5);
    expect(countMemberAges(v5)).toBe(0);
    expect(countFields(v5, VERSION_8_FIELDS)).toBe(1);
    stripFields(v5, VERSION_8_FIELDS);
    expect(countFields(v5, VERSION_8_FIELDS)).toBe(0);
    expect(countFields(v5, VERSION_7_FIELDS)).toBe(2);
    stripFields(v5, VERSION_7_FIELDS);
    expect(countFields(v5, VERSION_7_FIELDS)).toBe(0);

    const parsed = parseEnvelope(JSON.stringify(v5));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    expect(parsed.envelope.schemaVersion).toBe(5);
    // Nothing invented on the way in: an absent age stays absent in the parsed document, so a
    // re-export of an untouched v5 plan is still a v5-shaped household rather than a guess.
    expect(parsed.envelope).toStrictEqual(v5);

    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;

    const household = (imported.plans[0] as unknown as { timeline: { household: { members: HouseholdMember[] } } }).timeline.household;
    expect(household.members).toHaveLength(2);

    // Absence means "inherit the plan's own values" — the primary's — never an error and never a
    // zero. A zero birth year would make the member older than the calendar, the opposite of this.
    const planAges = { birthMonth: 6, birthYear: 1990, lifeExpectancy: 87 };
    for (const member of household.members) {
      for (const field of VERSION_6_FIELDS) expect(member).not.toHaveProperty(field);
      expect(resolveHouseholdMember(member, planAges)).toMatchObject({ ...planAges, hasStoredAges: false });
    }
  });

  it('imports a version 6 plan as one that does not itemize, not as one that itemized nothing', () => {
    // v7 is the change that adds `taxSettings.itemizedDeductions`, so this is the real v6 shape:
    // the same plan with the block (and the spouse flag) absent. The reader must not invent a block
    // of zeros — "absent" is the plan's statement that it does not itemize, and a block of zeros
    // would be a different claim (it itemized, and every line was zero) that happens to compute the
    // same standard deduction today but would not survive a future change to the selection rule.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    expect(countFields(envelope, VERSION_7_FIELDS)).toBe(2);

    const v6 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v6.schemaVersion = 6;
    expect(countFields(v6, VERSION_8_FIELDS)).toBe(1);
    stripFields(v6, VERSION_8_FIELDS);
    expect(countFields(v6, VERSION_8_FIELDS)).toBe(0);
    stripFields(v6, VERSION_7_FIELDS);
    expect(countFields(v6, VERSION_7_FIELDS)).toBe(0);
    // The v6 fields are still there: this is a v6 file, not an older one.
    expect(countMemberAges(v6)).toBe(6);

    const parsed = parseEnvelope(JSON.stringify(v6));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    expect(parsed.envelope.schemaVersion).toBe(6);
    // Nothing invented on the way in.
    expect(parsed.envelope).toStrictEqual(v6);

    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;

    const taxSettings = (imported.plans[0] as unknown as { taxSettings: Record<string, unknown> }).taxSettings;
    expect(taxSettings).not.toHaveProperty('itemizedDeductions');
    expect(taxSettings).not.toHaveProperty('spouseQualifiesForSeniorDeduction');
    // ...and everything a v6 plan does carry survives the import.
    expect(taxSettings).toHaveProperty('filingStatus', 'single');
  });

  it('imports a version 7 plan without a residency flag as a California plan, and keeps it absent', () => {
    // v8 is the change that adds `taxSettings.stateResidency`. A v7 file cannot carry it, and the
    // absence means **California files a return** — this is a California instance and the payroll
    // layer has charged CA SDI unconditionally since P3-P4, so the other reading would let an
    // existing plan silently stop paying a tax it has always paid. The file keeps its own shape:
    // nothing is invented on the way in, so re-exporting it writes v8 with the flag still absent.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    expect(countFields(envelope, VERSION_8_FIELDS)).toBe(1);

    const v7 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v7.schemaVersion = 7;
    stripFields(v7, VERSION_8_FIELDS);
    expect(countFields(v7, VERSION_8_FIELDS)).toBe(0);
    // The v7 fields are still there: this is a v7 file, not an older one.
    expect(countFields(v7, VERSION_7_FIELDS)).toBe(2);

    const parsed = parseEnvelope(JSON.stringify(v7));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;

    expect(parsed.envelope.schemaVersion).toBe(7);
    expect(parsed.envelope).toStrictEqual(v7);

    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;

    const taxSettings = (imported.plans[0] as unknown as { taxSettings: Record<string, unknown> }).taxSettings;
    expect(taxSettings).not.toHaveProperty('stateResidency');
    // The reader's default is California: the transformer leaves it undefined, and the tax layer
    // reads undefined as 'CA' (asserted in `taxes.test.ts`).
    expect(taxSettingsFromConvex(taxSettings as never).stateResidency).toBeUndefined();
  });

  it('warns about a plan that states no state residency, and still imports it', () => {
    // A pre-v8 file (or any plan written before the flag) carries no `stateResidency`. The tax
    // layer reads absent as California (`taxes.ts:350`), so the value is not wrong — but the
    // operator must be told, because the difference is California income tax, not a formatting
    // preference. `warningsFor` fails the test if the file is refused, so this also pins that the
    // disclosure stays a warning.
    const warnings = warningsFor((envelope) => {
      delete ((envelope.plan as Record<string, unknown>).taxSettings as Record<string, unknown>).stateResidency;
    });

    expect(warnings).toStrictEqual([
      {
        path: 'plan.taxSettings.stateResidency',
        message: 'No state residency is stated, so this plan is read as California. Set it explicitly if it is not.',
      },
    ]);
  });

  it('stays silent when the plan states California explicitly', () => {
    const warnings = warningsFor((envelope) => {
      ((envelope.plan as Record<string, unknown>).taxSettings as Record<string, unknown>).stateResidency = 'CA';
    });

    expect(warnings.filter((issue) => issue.path === 'plan.taxSettings.stateResidency')).toStrictEqual([]);
  });

  it('stays silent when the plan opts out of state tax', () => {
    // The fixture states `'none'`; assert it explicitly so the case cannot pass by accident of
    // the fixture changing.
    const warnings = warningsFor((envelope) => {
      ((envelope.plan as Record<string, unknown>).taxSettings as Record<string, unknown>).stateResidency = 'none';
    });

    expect(warnings.filter((issue) => issue.path === 'plan.taxSettings.stateResidency')).toStrictEqual([]);
  });

  it('rejects invalid JSON, non-objects and unknown kinds without throwing', () => {
    expect(parseEnvelope('{ not json').ok).toBe(false);
    expect(parseEnvelope('[]').ok).toBe(false);

    const wrongKind = parseEnvelope(
      JSON.stringify({ ...createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT }), kind: 'nope' })
    );
    expect(wrongKind.ok).toBe(false);
    if (wrongKind.ok) return;
    expect(wrongKind.issues[0].path).toBe('kind');
  });
});

describe('the semantic layer blocks only what the engine cannot run', () => {
  it('reports the failing field inside a union, from the branch that matches', () => {
    const issues = issuesFor((envelope) => {
      const plan = envelope.plan as Record<string, unknown>;
      const timeline = plan.timeline as Record<string, unknown>;
      timeline.retirementStrategy = { type: 'fixedAge' };
    });

    // `timeline` is `v.union(timelineValidator, v.null())` and the strategy is a second union
    // inside it, so the union issue alone would name only `plan.timeline`. The `swrTarget`
    // member is not the file's shape: it must not tell the operator their `type` is wrong.
    expect(issues.map((issue) => issue.path)).toEqual(['plan.timeline.retirementStrategy.retirementAge']);
    expect(issues.map((issue) => issue.message)).toEqual(['Invalid input: expected number, received undefined']);
  });

  it('refuses an as-of date the clock would throw on', () => {
    const malformed = issuesFor((envelope) => {
      (envelope.plan as Record<string, unknown>).simulationSettings = {
        simulationMode: 'fixedReturns',
        simulationSeed: 9521,
        asOfDate: 'not-a-date',
      };
    });

    // `useSimulationClock` feeds this straight into `fixedClock`, which throws.
    expect(malformed).toContainEqual({
      path: 'plan.simulationSettings.asOfDate',
      message: 'As-of date must be a valid ISO date (YYYY-MM-DD)',
    });

    const rolledOver = issuesFor((envelope) => {
      (envelope.plan as Record<string, unknown>).simulationSettings = {
        simulationMode: 'fixedReturns',
        simulationSeed: 9521,
        asOfDate: '2026-02-30',
      };
    });
    expect(rolledOver.map((issue) => issue.path)).toContain('plan.simulationSettings.asOfDate');
  });

  it('refuses a birth month the engine would read as a month index', () => {
    for (const birthMonth of [13, 0, 1.5]) {
      const issues = issuesFor((envelope) => {
        const timeline = (envelope.plan as Record<string, unknown>).timeline as Record<string, unknown>;
        timeline.birthMonth = birthMonth;
      });

      // `calculatePreciseAge` subtracts birthMonth as a month index, so 13 ages the person
      // a year younger and every retirement date shifts with it. Corrupt, not cosmetic.
      expect(
        issues.map((issue) => issue.path),
        `birthMonth ${birthMonth}`
      ).toContain('plan.timeline.birthMonth');
    }
  });

  it('refuses a compound debt with no compounding frequency, which makes the engine throw', () => {
    const issues = issuesFor((envelope) => {
      const debts = (envelope.plan as Record<string, unknown>).debts as Record<string, unknown>[];
      delete debts[0].compoundingFrequency;
    });

    expect(issues.map((issue) => issue.path)).toContain('plan.debts[0].compoundingFrequency');
  });

  it('refuses an investment account with no bond percentage, which would turn balances into NaN', () => {
    const issues = issuesFor((envelope) => {
      const accounts = (envelope.plan as Record<string, unknown>).accounts as Record<string, unknown>[];
      const firstInvestment = accounts.findIndex((account) => account.type !== 'savings');
      delete accounts[firstInvestment].percentBonds;
    });

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toMatch(/^plan\.accounts\[\d+\]\.percentBonds$/);
  });

  it('refuses a life expectancy the run cannot simulate and an inflation rate that divides by zero', () => {
    const lifeExpectancy = issuesFor((envelope) => {
      const timeline = (envelope.plan as Record<string, unknown>).timeline as Record<string, unknown>;
      timeline.lifeExpectancy = 0;
    });
    expect(lifeExpectancy.map((issue) => issue.path)).toContain('plan.timeline.lifeExpectancy');

    const inflation = issuesFor((envelope) => {
      const assumptions = (envelope.plan as Record<string, unknown>).marketAssumptions as Record<string, unknown>;
      assumptions.inflationRate = -100;
    });
    expect(inflation.map((issue) => issue.path)).toContain('plan.marketAssumptions.inflationRate');
  });

  it('refuses a life expectancy the plan holder has already reached, when the plan pins an as-of date', () => {
    const issues = issuesFor((envelope) => {
      const plan = envelope.plan as Record<string, unknown>;
      const timeline = plan.timeline as Record<string, unknown>;
      timeline.birthYear = 1960;
      timeline.lifeExpectancy = 60;
      (plan.simulationSettings as Record<string, unknown>).asOfDate = '2026-10-30';
    });

    // `yearsToSimulate = ceil(lifeExpectancy - startAge)` = ceil(60 - 66.8) <= 0: no months.
    const horizon = issues.find((issue) => issue.path === 'plan.timeline.lifeExpectancy');
    expect(horizon?.message).toBe(
      "Life expectancy (60) is at or below the plan holder's age on the as-of date (66.8), so the run has no months to simulate."
    );
  });

  it('refuses a timestamp-shaped asOfDate at the date gate, before any age is computed from it', () => {
    // `calculatePreciseAge` takes `YYYY-MM-DD` and normalises through `parseISODateString`,
    // which THROWS on a timestamp. The timeline below would fail the horizon check if the
    // timestamp reached the age arithmetic (age 66.8 vs a 60-year horizon), so the only issue
    // reported must be the date itself — and `parseEnvelope` must not throw.
    const issues = issuesFor((envelope) => {
      const plan = envelope.plan as Record<string, unknown>;
      (plan.simulationSettings as Record<string, unknown>).asOfDate = '2026-10-30T12:00:00.000Z';
      const timeline = plan.timeline as Record<string, unknown>;
      timeline.birthYear = 1960;
      timeline.lifeExpectancy = 60;
    });

    expect(issues).toEqual([{ path: 'plan.simulationSettings.asOfDate', message: 'As-of date must be a valid ISO date (YYYY-MM-DD)' }]);
  });

  it('warns instead when the file pins no as-of date to check that horizon against', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const mutated = structuredClone(envelope) as unknown as Record<string, unknown>;
    const plan = mutated.plan as Record<string, unknown>;
    const timeline = plan.timeline as Record<string, unknown>;
    timeline.birthYear = 1960;
    timeline.lifeExpectancy = 60;
    expect((plan.simulationSettings as Record<string, unknown>).asOfDate).toBeUndefined();

    const parsed = parseEnvelope(JSON.stringify(mutated));

    // The age at the file's own export date (2026-10-30) already passes the horizon, but the
    // importer refuses to invent a "today" to block on.
    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toContainEqual({
      path: 'plan.timeline.lifeExpectancy',
      message:
        "Life expectancy (60) is at or below the plan holder's age on this file's export date (66.8), so the run may have no months. This file pins no asOfDate, so the importer cannot check the horizon against today without inventing a date; set simulationSettings.asOfDate or raise the life expectancy.",
    });
  });

  it('imports a plan an older build saved: no v2 fields, no withholding the form now requires', () => {
    // The exact P1 repro, as old as such a file can be. `withholding` became a refine for
    // wage income in d9915666, while Convex still stores it as optional and the engine runs
    // `?? 0` — so refusing this file would strand the operator's own plan forever.
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
    const older = structuredClone(envelope) as unknown as Record<string, unknown>;
    older.schemaVersion = 1;
    stripFields(older, [...VERSION_3_FIELDS, ...VERSION_2_FIELDS]);
    const incomes = (older.plan as Record<string, unknown>).incomes as Record<string, unknown>[];
    delete (incomes[0].taxes as Record<string, unknown>).withholding;

    const parsed = parseEnvelope(JSON.stringify(older));

    expect(parsed.ok, !parsed.ok ? JSON.stringify(parsed.issues) : '').toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toContainEqual({ path: 'plan.incomes[0].taxes.withholding', message: 'Withholding required for wage income' });

    // The warning is advisory: the file imports.
    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: true, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
    if (!imported.ok) return;
    expect(imported.plans).toHaveLength(1);
    expect(imported.finances).toStrictEqual(toFinancesExport(makeFinancesDoc()));
  });

  it('imports a self-employment income just like any other supported type', () => {
    // PLAN-parity R8 gated `selfEmployment` until P3-P4 shipped the self-employment tax: without
    // that tax the engine would have taxed SE income as an ordinary wage, under-taxing it by about
    // 15.3%. The gate is gone, so the assertion is now the absence of one: a reinstated gate would
    // add an `incomeType` warning here and fail this test.
    const warnings = warningsFor((envelope) => {
      const incomes = (envelope.plan as Record<string, unknown>).incomes as Record<string, unknown>[];
      incomes[0] = { ...incomes[0], taxes: { incomeType: 'selfEmployment' } };
    });

    expect(warnings.filter((warning) => warning.path === 'plan.incomes[0].taxes.incomeType')).toStrictEqual([]);
    // Nothing at all is wrong with the file: the SE plan is an ordinary plan now.
    expect(warnings).toStrictEqual([]);
  });

  it('warns, without refusing, about policy values the engine copes with', () => {
    const emptyName = warningsFor((envelope) => {
      const incomes = (envelope.plan as Record<string, unknown>).incomes as Record<string, unknown>[];
      incomes[0] = { ...incomes[0], name: '' };
    });
    expect(emptyName).toContainEqual({ path: 'plan.incomes[0].name', message: 'Name must be at least 2 characters' });

    const seed = warningsFor((envelope) => {
      (envelope.plan as Record<string, unknown>).simulationSettings = { simulationMode: 'fixedReturns', simulationSeed: 1e9 };
    });
    expect(seed.map((issue) => issue.path)).toContain('plan.simulationSettings.simulationSeed');

    // A yield above the total return is arithmetically odd, not fatal.
    const yieldOffset = warningsFor((envelope) => {
      const assumptions = (envelope.plan as Record<string, unknown>).marketAssumptions as Record<string, unknown>;
      assumptions.stockYield = 99;
    });
    expect(yieldOffset.map((issue) => issue.path)).toContain('plan.marketAssumptions.stockYield');

    // The asset identity the form enforces is advice, not a precondition: the engine buys
    // the asset with the loan it is given.
    const assetIdentity = warningsFor((envelope) => {
      const assets = (envelope.plan as Record<string, unknown>).physicalAssets as Record<string, unknown>[];
      assets[0] = { ...assets[0], purchaseDate: { type: 'customAge', age: 50 }, purchasePrice: 900000 };
    });
    expect(assetIdentity).toContainEqual({
      path: 'plan.physicalAssets[0].paymentMethod.loanBalance',
      message: 'Down payment + loan balance must equal purchase price',
    });
  });

  it('warns about the finances in the file without refusing them', () => {
    const warnings = warningsFor((envelope) => {
      const financeAssets = (envelope.finances as Record<string, unknown>).assets as Record<string, unknown>[];
      financeAssets[0] = { ...financeAssets[0], name: '' };
    });

    expect(warnings).toContainEqual({ path: 'finances.assets[0].name', message: 'Name must be at least 2 characters' });
  });

  it('imports a file whose only oddities are warnings, and blocks none of it', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const mutated = structuredClone(envelope) as unknown as Record<string, unknown>;
    const incomes = (mutated.plan as Record<string, unknown>).incomes as Record<string, unknown>[];
    delete (incomes[0].taxes as Record<string, unknown>).withholding;

    const parsed = parseEnvelope(JSON.stringify(mutated));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.length).toBeGreaterThan(0);
    const imported = prepareImport(
      parsed.envelope,
      { plans: [], finances: null },
      { confirmReplaceFinances: false, exportedAt: EXPORTED_AT }
    );
    expect(imported.ok, !imported.ok ? JSON.stringify(imported.issues) : '').toBe(true);
  });

  it('reports a bulk plan by its index', () => {
    const plansEnvelope = createPlansEnvelope({
      plans: [makePlanDoc(), makePlanDoc({ _id: 'plan-2' })],
      finances: null,
      exportedAt: EXPORTED_AT,
    });
    const mutated = structuredClone(plansEnvelope) as unknown as Record<string, unknown>;
    const plans = (mutated.plans as Record<string, unknown>[])[1];
    (plans.timeline as Record<string, unknown>).birthMonth = 0;

    const parsed = parseEnvelope(JSON.stringify(mutated));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => issue.path)).toContain('plans[1].timeline.birthMonth');
  });

  it('still accepts a valid export, with nothing to warn about', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
    const restored = parseEnvelope(serializeEnvelope(envelope));

    expect(restored.ok, !restored.ok ? JSON.stringify(restored.issues) : '').toBe(true);
    if (!restored.ok) return;
    expect(restored.envelope).toStrictEqual(envelope);
    expect(restored.warnings).toEqual([]);
  });

  it('still refuses a newer file as an upgrade problem, not as a field error', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const corrupted = structuredClone(envelope) as unknown as Record<string, unknown>;
    (corrupted.plan as Record<string, unknown>).simulationSettings = {
      simulationMode: 'fixedReturns',
      simulationSeed: 1e9,
      asOfDate: 'nope',
    };

    const parsed = parseEnvelope(JSON.stringify({ ...corrupted, schemaVersion: EXPORT_SCHEMA_VERSION + 1 }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].path).toBe('schemaVersion');
    expect(parsed.issues[0].message).toMatch(/Upgrade/i);
  });

  it('still checks the kind before it validates the payload', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const corrupted = structuredClone(envelope) as unknown as Record<string, unknown>;
    (corrupted.plan as Record<string, unknown>).simulationSettings = {
      simulationMode: 'fixedReturns',
      simulationSeed: 1e9,
      asOfDate: 'nope',
    };

    const parsed = parseEnvelope(JSON.stringify({ ...corrupted, kind: 'nope' }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].path).toBe('kind');
  });
});

describe('finances import needs confirmation and produces a pre-import snapshot', () => {
  const existing = { plans: [makePlanDoc({ _id: 'existing-plan' })], finances: toFinancesExport(makeFinancesDoc()) };

  it('refuses to release finances without explicit confirmation', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });

    const plan = prepareImport(envelope, existing, { confirmReplaceFinances: false, exportedAt: EXPORTED_AT });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0].path).toBe('finances');
    expect(plan.issues[0].message).toMatch(/replaces every current asset and liability/i);
  });

  it('produces the snapshot of what is about to be overwritten once confirmed', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });

    const plan = prepareImport(envelope, existing, { confirmReplaceFinances: true, exportedAt: EXPORTED_AT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.finances).toStrictEqual(toFinancesExport(makeFinancesDoc()));
    expect(plan.snapshot.kind).toBe(PLANS_EXPORT_KIND);
    expect(plan.snapshot.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(plan.snapshot.exportedAt).toBe(EXPORTED_AT);
    expect(plan.snapshot.plans).toStrictEqual([toPlanExport(existing.plans[0])]);
    expect(plan.snapshot.finances).toStrictEqual(existing.finances);
    // The snapshot is a complete backup: it parses back as a valid envelope.
    expect(parseOrThrow(serializeEnvelope(plan.snapshot))).toStrictEqual(plan.snapshot);
  });

  it('does not require confirmation when the export carries no finances', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });

    const plan = prepareImport(envelope, existing, { confirmReplaceFinances: false, exportedAt: EXPORTED_AT });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.finances).toBeNull();
    expect(plan.snapshot.plans).toHaveLength(1);
  });

  it('refuses a bulk import that would exceed the plan limit', () => {
    const envelope = createPlansEnvelope({
      plans: Array.from({ length: 11 }, (_, index) => makePlanDoc({ _id: `plan-${index}`, name: `Plan ${index}` })),
      finances: null,
      exportedAt: EXPORTED_AT,
    });

    const plan = prepareImport(envelope, { plans: [], finances: null }, { confirmReplaceFinances: false, exportedAt: EXPORTED_AT });

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.issues[0].path).toBe('plans');
    expect(plan.issues[0].message).toMatch(/10-plan limit/);
  });
});

describe('the paste-a-plan path (dashboard → new plan → import from JSON)', () => {
  const textFor = (plan = makePlanDoc(), finances: ReturnType<typeof toFinancesExport> = null) =>
    serializeEnvelope(createPlanEnvelope({ plan, finances, exportedAt: EXPORTED_AT }));

  it('returns the plan data without the two document fields', () => {
    const { name: _name, isDefault: _isDefault, ...expected } = toPlanExport(makePlanDoc());

    const prepared = preparePastedPlan(textFor());

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.planData).toStrictEqual(expected);
    expect(prepared.planData).not.toHaveProperty('name');
    expect(prepared.planData).not.toHaveProperty('isDefault');
    expect(prepared.warnings).toEqual([]);
  });

  it('surfaces warnings instead of writing past them', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const mutated = structuredClone(envelope) as unknown as Record<string, unknown>;
    const incomes = (mutated.plan as Record<string, unknown>).incomes as Record<string, unknown>[];
    delete (incomes[0].taxes as Record<string, unknown>).withholding;

    const prepared = preparePastedPlan(JSON.stringify(mutated));

    // The dialog stashes these and asks before it calls the mutation; this is the value it
    // reads, so a warning here can never be dropped on that path again.
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.warnings).toContainEqual({
      path: 'plan.incomes[0].taxes.withholding',
      message: 'Withholding required for wage income',
    });
  });

  it('still refuses a bulk file, a file with finances and a file the engine cannot run', () => {
    const bulk = preparePastedPlan(
      serializeEnvelope(createPlansEnvelope({ plans: [makePlanDoc()], finances: null, exportedAt: EXPORTED_AT }))
    );
    expect(bulk.ok).toBe(false);
    if (bulk.ok) return;
    expect(bulk.issues).toEqual([
      { path: 'kind', message: 'This file contains several plans. Restore it from Settings → Backup & restore.' },
    ]);

    const withFinances = preparePastedPlan(textFor(makePlanDoc(), toFinancesExport(makeFinancesDoc())));
    expect(withFinances.ok).toBe(false);
    if (withFinances.ok) return;
    expect(withFinances.issues[0].path).toBe('finances');

    const broken = preparePastedPlan('{ not json');
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.issues[0].path).toBe('');

    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const unreadable = structuredClone(envelope) as unknown as Record<string, unknown>;
    ((unreadable.plan as Record<string, unknown>).simulationSettings as Record<string, unknown>).asOfDate = 'not-a-date';
    const refused = preparePastedPlan(JSON.stringify(unreadable));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.issues.map((issue) => issue.path)).toContain('plan.simulationSettings.asOfDate');
  });
});

describe('filenames', () => {
  it('derives a timestamped name per kind', () => {
    const planEnvelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    const plansEnvelope = createPlansEnvelope({ plans: [], finances: null, exportedAt: EXPORTED_AT });

    expect(exportFilename(planEnvelope)).toBe('ignidash-plan-2026-10-30T12-00-00-000Z.json');
    expect(exportFilename(plansEnvelope)).toBe('ignidash-plans-2026-10-30T12-00-00-000Z.json');
    expect(exportFilename(planEnvelope, 'snapshot')).toBe('snapshot-plan-2026-10-30T12-00-00-000Z.json');
  });
});

// Type-level check: the exported plan type is the plan document minus identity.
const _typeCheck: PlanExport = toPlanExport(makePlanDoc());
void _typeCheck;
