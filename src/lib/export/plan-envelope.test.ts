import { describe, expect, it } from 'vitest';

import type { Doc } from '../../../convex/_generated/dataModel';
import { planDataFields } from '../../../convex/validators/plan_data_fields';
import { basicTemplate } from '../../../convex/templates/basic';
import { earlyRetirementTemplate } from '../../../convex/templates/early_retirement';

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
  // P1-P1's time binding, one of each v2 field, so the version-1 fixture below has something
  // to strip (see `stripVersion2Fields`):
  //   incomes[0].amountBasis, incomes[0].timeframe.start.everyNYears / .recurrenceYears.
  const [firstIncome, ...otherIncomes] = basicTemplate.incomes;
  const incomes = [
    {
      ...firstIncome,
      amountBasis: 'nominal' as const,
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
const VERSION_2_FIELDS = ['everyNYears', 'recurrenceYears', 'amountBasis'];

function stripVersion2Fields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) stripVersion2Fields(entry);
    return;
  }
  if (typeof value !== 'object' || value === null) return;

  const record = value as Record<string, unknown>;
  for (const field of VERSION_2_FIELDS) delete record[field];
  for (const entry of Object.values(record)) stripVersion2Fields(entry);
}

/** How many v2-only fields a payload carries, so the strip above can be shown to have work. */
function countVersion2Fields(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + countVersion2Fields(entry), 0);
  if (typeof value !== 'object' || value === null) return 0;

  const record = value as Record<string, unknown>;
  const own = VERSION_2_FIELDS.filter((field) => field in record).length;

  return own + Object.values(record).reduce<number>((total, entry) => total + countVersion2Fields(entry), 0);
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
    expect(older.issues[0].message).toMatch(/reads versions 1 through 2/);
    expect(newer.issues[0].message).toMatch(/newer Ignidash/i);
    expect(newer.issues[0].message).toMatch(/Upgrade/i);
  });

  it('accepts every version in the range and stamps the current one', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: null, exportedAt: EXPORTED_AT });
    expect(envelope.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);

    const at = (version: unknown) => parseEnvelope(JSON.stringify({ ...envelope, schemaVersion: version }));

    // Oldest first: a bumped build keeps reading the files the old one wrote.
    for (let version = MIN_EXPORT_SCHEMA_VERSION; version <= EXPORT_SCHEMA_VERSION; version += 1) {
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

  it('still imports a version 1 export after the bump to version 2', () => {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
    const v1 = structuredClone(envelope) as unknown as Record<string, unknown>;
    v1.schemaVersion = 1;

    // The strip is guarded in both directions: the fixture really carries one of each v2
    // field, and none survives, so "a v1 file still imports" is not vacuously true.
    expect(countVersion2Fields(v1)).toBe(3);
    stripVersion2Fields(v1);
    expect(countVersion2Fields(v1)).toBe(0);

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
    stripVersion2Fields(older);
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

  it('imports a self-employment income with a warning instead of refusing it', () => {
    // PLAN-parity R8 keeps the engine path alive and gates only the form, so this must not
    // be a refusal either.
    const warnings = warningsFor((envelope) => {
      const incomes = (envelope.plan as Record<string, unknown>).incomes as Record<string, unknown>[];
      incomes[0] = { ...incomes[0], taxes: { incomeType: 'selfEmployment' } };
    });

    expect(warnings).toContainEqual({ path: 'plan.incomes[0].taxes.incomeType', message: 'This income type is not yet supported' });
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
