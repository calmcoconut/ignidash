import { describe, expect, it } from 'vitest';

import type { Doc } from '../../../convex/_generated/dataModel';
import { planDataFields } from '../../../convex/validators/plan_data_fields';
import { basicTemplate } from '../../../convex/templates/basic';
import { earlyRetirementTemplate } from '../../../convex/templates/early_retirement';

import {
  EXPORT_SCHEMA_VERSION,
  PLAN_EXPORT_KIND,
  PLANS_EXPORT_KIND,
  createPlanEnvelope,
  createPlansEnvelope,
  exportFilename,
  parseEnvelope,
  planExportKeys,
  planExportSchema,
  prepareImport,
  serializeEnvelope,
  toFinancesExport,
  toPlanExport,
  type ExportEnvelope,
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
  const doc = {
    ...basicTemplate,
    _id: 'plan-1',
    _creationTime: 1,
    userId: 'user-1',
    name: 'My Plan',
    isDefault: true,
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
  function issuesFor(mutate: (envelope: PlanExportEnvelopeBuilder) => void) {
    const envelope = createPlanEnvelope({ plan: makePlanDoc(), finances: toFinancesExport(makeFinancesDoc()), exportedAt: EXPORTED_AT });
    const mutated = structuredClone(envelope) as unknown as Record<string, unknown>;
    mutate({ envelope: mutated });
    const parsed = parseEnvelope(JSON.stringify(mutated));
    if (parsed.ok) throw new Error('expected the file to be rejected');
    return parsed.issues;
  }

  interface PlanExportEnvelopeBuilder {
    envelope: Record<string, unknown>;
  }

  it('names a nested field path instead of truncating the message', () => {
    const issues = issuesFor(({ envelope }) => {
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
    const badEnum = issuesFor(({ envelope }) => {
      (envelope.plan as Record<string, unknown>).taxSettings = { filingStatus: 'bogus' };
    });
    expect(badEnum.map((issue) => issue.path)).toContain('plan.taxSettings.filingStatus');

    const missing = issuesFor(({ envelope }) => {
      delete (envelope.plan as Record<string, unknown>).timeline;
    });
    expect(missing.map((issue) => issue.path)).toContain('plan.timeline');

    const unknown = issuesFor(({ envelope }) => {
      (envelope.plan as Record<string, unknown>).bogusField = true;
    });
    expect(unknown).toContainEqual({ path: 'plan.bogusField', message: 'Unrecognized field' });
  });

  it('names the failing finances field', () => {
    const issues = issuesFor(({ envelope }) => {
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
    const newer = parseEnvelope(JSON.stringify({ ...envelope, schemaVersion: 2 }));

    expect(older.ok).toBe(false);
    expect(newer.ok).toBe(false);
    if (older.ok || newer.ok) return;
    expect(older.issues[0].path).toBe('schemaVersion');
    expect(newer.issues[0].message).toMatch(/newer Ignidash/i);
    expect(newer.issues[0].message).toMatch(/Upgrade/i);
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
