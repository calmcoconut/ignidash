/**
 * The eval set for the tax-optimization skill (§7-A2).
 *
 * These tests only prove the fixtures are usable: every plan validates against the plan schema,
 * every plan produces a baseline through the real toolkit the agent calls, and every rubric check
 * has a rule in the prompt that a reviewer can point at. They never call a provider — a live eval
 * run is described in `README.md` beside this file and is deliberately on demand.
 *
 * The rest pins what the set says the engine *cannot* do, in `README.md` and in this directory's
 * module header: a lever the engine computes must not reappear on the "deliberately omits" list,
 * because that list is what makes "the lever is not modelled" a passing answer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createChatToolkit } from '../../chat_tools';
import { simulatorSchema, type SimulatorInputs } from '../../../src/lib/schemas/inputs/simulator-schema';
import { TAX_OPTIMIZATION_SKILL_PROMPT } from '../tax_optimization';
import { EVAL_AS_OF, TAX_OPTIMIZATION_EVAL_CHECKS, TAX_OPTIMIZATION_EVALS, type EvalGoal } from './tax_optimization_evals';

/** Every goal the plan names (F1: the user picks one of these, never the agent). */
const GOALS: readonly EvalGoal[] = ['lifetime-taxes', 'ending-net-worth', 'success'];

/** The prompt rule each rubric check is reviewing. A check without a rule here is unenforceable. */
const RULE_FOR_CHECK: Record<string, readonly string[]> = {
  'grounded-numbers': ['**No number without a tool result.**'],
  'goal-first': ['**Settle the goal.**', 'The user ranks variants by one goal they choose'],
  'refused-patches': ['**A refused patch is a refusal, not a puzzle.**', '**Nothing is written.**'],
  'no-writes': ['**Nothing is written.**'],
  'no-recommendation': ['## Stance: rank, never recommend', 'Never say which variant you would pick.'],
  budget: ['**Budget: at most 6 variants and at most 12 tool calls per turn.**'],
  'assumptions-stated': ['**State assumptions and limits.**'],
  'monte-carlo-on-request': ['**Monte Carlo only on request.**'],
};

interface ParsedBaseline {
  error?: string;
  baseline?: { finalPortfolioValue?: unknown; lifetimeTaxesAndPenalties?: unknown };
}

describe('tax-optimization eval set', () => {
  it('has twelve uniquely identified cases', () => {
    expect(TAX_OPTIMIZATION_EVALS).toHaveLength(12);

    const ids = TAX_OPTIMIZATION_EVALS.map((evalCase) => evalCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sets a goal on every case that the plan allows', () => {
    for (const evalCase of TAX_OPTIMIZATION_EVALS) expect(GOALS).toContain(evalCase.goal);
  });

  it.each(TAX_OPTIMIZATION_EVALS.map((evalCase) => [evalCase.id, evalCase] as const))('validates plan %s', (_id, evalCase) => {
    const parsed = simulatorSchema.safeParse(evalCase.plan);

    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  it.each(TAX_OPTIMIZATION_EVALS.map((evalCase) => [evalCase.id, evalCase] as const))(
    'produces a baseline for %s through the real toolkit',
    { timeout: 60_000 },
    (_id, evalCase) => {
      const toolkit = createChatToolkit({ inputs: evalCase.plan, asOf: EVAL_AS_OF });
      const summary = JSON.parse(toolkit.execute('getPlanSummary', {})) as ParsedBaseline;

      expect(summary.error).toBeUndefined();
      expect(typeof summary.baseline?.finalPortfolioValue).toBe('number');
      expect(typeof summary.baseline?.lifetimeTaxesAndPenalties).toBe('number');
      expect(toolkit.callCount()).toBe(1);
    }
  );

  it('covers the shapes the plan requires', () => {
    const ids = TAX_OPTIMIZATION_EVALS.map((evalCase) => evalCase.id);

    expect(ids.some((id) => id.startsWith('single-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('mfj-'))).toBe(true);
    expect(ids.some((id) => id.includes('early-retiree'))).toBe(true);
    expect(ids.some((id) => id.includes('high-income') || id.includes('high-earner'))).toBe(true);
  });

  it('covers the separate-return path with exactly one MFS case', () => {
    // P3-P1b prices a separate-return household as two returns, so the fixture has to exercise the
    // split — two members, incomes on their own returns and jointly held (community) accounts — and
    // not merely set the enum value.
    const mfs = TAX_OPTIMIZATION_EVALS.filter((evalCase) => evalCase.plan.taxSettings.filingStatus === 'marriedFilingSeparately');

    expect(mfs.map((evalCase) => evalCase.id)).toEqual(['mfs-couple']);
    expect(mfs[0].plan.timeline?.household?.members).toHaveLength(2);
    expect(Object.values(mfs[0].plan.incomes).map((income) => income?.owner)).toEqual(expect.arrayContaining(['primary', 'partner']));
    expect(Object.values(mfs[0].plan.accounts).map((account) => account?.owner)).toEqual(expect.arrayContaining(['joint']));
    // The lever the separate-return tables make runnable: the same household priced as one return.
    expect(mfs[0].levers.some((lever) => JSON.stringify(lever.planPatch).includes('marriedFilingJointly'))).toBe(true);

    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('married filing separately');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).not.toContain('separately is not available');
  });

  it('prices the MFS case as two returns: filing jointly is a different lifetime tax', () => {
    const mfsCase = TAX_OPTIMIZATION_EVALS.find((evalCase) => evalCase.id === 'mfs-couple');
    if (!mfsCase) throw new Error('the mfs-couple case is missing');

    const toolkit = createChatToolkit({ inputs: mfsCase.plan, asOf: EVAL_AS_OF });
    const summary = JSON.parse(toolkit.execute('getPlanSummary', {})) as {
      baseline?: { lifetimeTaxesAndPenalties?: number };
    };
    // The same household, same clock and seed, with the one setting the separate-return tables change.
    const joint = JSON.parse(
      toolkit.execute('simulateVariant', {
        variantId: 'file-jointly',
        planPatch: { taxSettings: { filingStatus: 'marriedFilingJointly' } },
      })
    ) as { lifetimeTaxes?: { total?: number } };

    const separateLifetime = summary.baseline?.lifetimeTaxesAndPenalties;
    const jointLifetime = joint.lifetimeTaxes?.total;
    expect(typeof separateLifetime).toBe('number');
    expect(typeof jointLifetime).toBe('number');
    // If the engine had ignored the filing status, these would be the same number: that is exactly
    // what a two-returns-per-year path must not do.
    expect(Math.abs((separateLifetime ?? 0) - (jointLifetime ?? 0))).toBeGreaterThan(1);

    // And the state return is settled for it, on the state's own figures rather than a zero stand-in.
    const analytics = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 2030 })) as {
      jurisdictions?: { california?: { reported?: { jurisdiction?: string; total?: number } } };
    };
    expect(analytics.jurisdictions?.california?.reported?.jurisdiction).toBe('CA');
    expect(analytics.jurisdictions?.california?.reported?.total).toBeGreaterThan(0);
  });

  it('names California in the two cases whose state return matters, and the prompt reports it', () => {
    // California is computed (P3-P8) and every plan defaults to California residency, so the state
    // return is part of the numbers in every case; these two say so in their own documents: the
    // high-income household, and the separately filing couple whose community property the state
    // return divides.
    const mentions = TAX_OPTIMIZATION_EVALS.filter((evalCase) => `${evalCase.covers} ${evalCase.request}`.includes('California'));

    expect(mentions.map((evalCase) => evalCase.id)).toEqual(['mfj-high-income', 'mfs-couple']);
    // The prompt points the agent at the settled return, and at the residency flag that separates
    // "no return filed" from "state tax of zero".
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('jurisdictions.california.reported');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain('`none` the plan is not a resident');
    expect(TAX_OPTIMIZATION_SKILL_PROMPT).not.toContain('do not report a California income tax figure');
  });
});

// ============================================================================
// The conversion ladder, worked by hand: conversion-ladder-hand-worked
// ============================================================================

/*
 * Hand-worked reasoning. Single filer, born 1970, federal only, zero returns and zero inflation, so
 * every figure is in 2026 dollars and the 2026 federal table in `src/lib/calc/tax-data/years/2026.ts`
 * applies unchanged. The IRMAA figures are the 2026 table's `medicareIrmaa`.
 *
 * Other ordinary income in the ladder years: none. Before 59½ the engine pays expenses and tax from
 * the brokerage first, and the brokerage is all basis, so those withdrawals are not income. The
 * conversion is therefore the only ordinary income, and its bracket headroom is
 *   standard deduction ($16,100) + top of the target bracket − other ordinary income ($0).
 *
 * 1. Fill to 12%: headroom 16,100 + 50,400 = 66,500. Taxable income 50,400. Federal tax
 *    10% × 12,400 + 12% × 38,000 = 1,240 + 4,560 = 5,800 a year. MAGI 66,500, under the 109,000
 *    IRMAA floor, so no surcharge.
 * 2. Fill to 22%: headroom 16,100 + 105,700 = 121,800. Taxable income 105,700. Federal tax
 *    5,800 + 22% × 55,300 = 5,800 + 12,166 = 17,966 a year. MAGI 121,800 is past the 109,000 floor
 *    (tier 1) with 15,200 to the 137,000 floor. Tier 1 is (81.20 + 14.50) × 12 = 1,148.40 a year.
 *
 * What the extra 55,300 of the 22% fill costs and returns. Now it costs 12,166 a year at 22%, plus the
 * surcharge in each premium year it sets: 3 × 1,148.40 = 3,445.20. Later it saves tax only on the dollars
 * the RMD years would otherwise have taxed, and the baseline shows that rate. Its drawdown years (ages
 * 60 to 75, funded from the IRA) sit in the 12% band: MAGI 42,977, taxable 26,877, tax
 * 1,240 + 12% × 14,477 = 2,977. Its RMD years sit in the 22% band: MAGI 115,090, taxable 98,990, tax
 * 5,800 + 22% × 48,590 = 16,490 (the no-conversion plan at age 76). Only part of the displaced IRA is
 * likely to come back at 22%: a balance left at age 100 is never taxed. That is an inference, since the
 * tools do not expose the final IRA balance. The engine's later figures net the 22% fill's extra 36,498 of tax in 2026 to 2028 against
 * about 31,200 saved later, which leaves the 22% fill 9,020 worse than the 12% fill once the surcharge is
 * counted (5,575 of federal tax and 3,445 of IRMAA).
 *
 * 3. Hand-worked best by lifetime taxes: fill to 12%. It converts every dollar at 12%, and each of
 *    those dollars would otherwise come out at 12% in a drawdown year or 22% in an RMD year. The 22%
 *    fill adds dollars that come back only at 22% and only partly, and it crosses the IRMAA floor.
 *
 * `getTaxAnalytics` names each row by its date. The conversion dated 2026 fires in the row dated
 * 1 January 2027, so that row is the one this test reads as "2027".
 */
const HAND = {
  /** IRC §63 basic standard deduction, single, 2026. */
  standardDeduction: 16_100,
  /** Top of the 12% bracket, taxable ordinary income, single, 2026. */
  bracket12Top: 50_400,
  /** Top of the 22% bracket, taxable ordinary income, single, 2026. */
  bracket22Top: 105_700,
  /** Federal tax on the 12% bracket top: 10% × 12,400 + 12% × 38,000. */
  taxAtBracket12Top: 5_800,
  /** IRMAA tier 1 floor (single, MAGI), 2026 table. */
  irmaaTier1Floor: 109_000,
  /** IRMAA tier 2 floor (single, MAGI), 2026 table. */
  irmaaTier2Floor: 137_000,
  /** Part B + Part D tier-1 adjustment per month: 81.20 + 14.50, times 12 months. */
  irmaaTier1Annual: (81.2 + 14.5) * 12,
};

const LADDER_CASE_ID = 'conversion-ladder-hand-worked';
const LADDER_12 = 'fill the 12% bracket, 2026-2028';
const LADDER_22 = 'fill the 22% bracket, 2026-2028';

describe('conversion-ladder-hand-worked', () => {
  const evalCase = TAX_OPTIMIZATION_EVALS.find((entry) => entry.id === LADDER_CASE_ID);
  if (!evalCase) throw new Error(`the ${LADDER_CASE_ID} case is missing`);

  const leverPatch = (label: string): Record<string, unknown> => {
    const lever = evalCase.levers.find((entry) => entry.label === label);
    if (!lever) throw new Error(`the ${label} lever is missing`);

    return lever.planPatch;
  };

  /** The case's plan with a lever's conversions already in the baseline, for the analytics tools. */
  const planWithLever = (label: string): SimulatorInputs =>
    ({ ...evalCase.plan, conversions: leverPatch(label).conversions }) as SimulatorInputs;

  it('ranks the 12% fill best by lifetime taxes, as the hand-worked comparison does', () => {
    const toolkit = createChatToolkit({ inputs: evalCase.plan, asOf: EVAL_AS_OF });
    const summary = JSON.parse(toolkit.execute('getPlanSummary', {})) as {
      baseline?: { lifetimeTaxesAndPenalties?: number };
    };

    const ranked = [
      { label: 'no conversion', total: summary.baseline?.lifetimeTaxesAndPenalties },
      ...evalCase.levers.map((lever) => {
        const result = JSON.parse(toolkit.execute('simulateVariant', { variantId: lever.label, planPatch: lever.planPatch })) as {
          lifetimeTaxes?: { total?: number };
        };

        return { label: lever.label, total: result.lifetimeTaxes?.total };
      }),
    ];

    for (const entry of ranked) expect(typeof entry.total).toBe('number');
    const best = ranked.reduce((lowest, entry) => ((entry.total ?? Infinity) < (lowest.total ?? Infinity) ? entry : lowest));

    expect(best.label).toBe(LADDER_12);
    // The 22% fill is worse than the 12% fill by more than the lifetime total's own rounding.
    const total = (label: string) => ranked.find((entry) => entry.label === label)?.total ?? NaN;
    expect(total(LADDER_22) - total(LADDER_12)).toBeGreaterThan(1);
  });

  it('converts exactly the 12% bracket headroom in the first conversion year', () => {
    const toolkit = createChatToolkit({ inputs: planWithLever(LADDER_12), asOf: EVAL_AS_OF });
    const headroom = HAND.standardDeduction + HAND.bracket12Top;

    // MAGI is the conversion here, because the year carries no other income.
    const analytics = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 2027 })) as {
      bracketFill?: { ordinary?: { taxableIncome?: number } };
      cliffs?: { irmaa?: { projected?: { magi?: number } } };
    };
    const magi = analytics.cliffs?.irmaa?.projected?.magi ?? NaN;
    expect(Math.abs(magi - headroom)).toBeLessThanOrEqual(1);

    const taxable = analytics.bracketFill?.ordinary?.taxableIncome ?? NaN;
    expect(Math.abs(taxable - HAND.bracket12Top)).toBeLessThanOrEqual(1);

    // The federal tax on that year is the hand figure too, so the conversion is priced at the 12% fill.
    // perYearTaxes[1] is the row dated 1 January 2027, which settles the 2026 conversion.
    const simulated = JSON.parse(toolkit.execute('simulateVariant', { variantId: 'as-planned', planPatch: {} })) as {
      perYearTaxes?: Array<{ year: number; federalIncomeTax: number }>;
    };
    const firstConversionYear = simulated.perYearTaxes?.[1];
    expect(Math.abs((firstConversionYear?.federalIncomeTax ?? NaN) - HAND.taxAtBracket12Top)).toBeLessThanOrEqual(1);
  });

  it('reports the IRMAA tier the 22% fill crosses, and leaves the ACA cliff unevaluated', () => {
    const toolkit = createChatToolkit({ inputs: planWithLever(LADDER_22), asOf: EVAL_AS_OF });

    const analytics = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 2027 })) as {
      cliffs?: {
        irmaa?: {
          projected?: {
            magi?: number;
            headroomToNextTier?: number | null;
            tier?: { tier?: number; min?: number; annualSurcharge?: number };
            nextTier?: { tier?: number } | null;
          };
        };
        aca?: { supported?: boolean; prerequisites?: string[] };
      };
    };
    const irmaa = analytics.cliffs?.irmaa?.projected;

    // The fill puts MAGI at 121,800: tier 1, with 15,200 of room before tier 2.
    expect(Math.abs((irmaa?.magi ?? NaN) - (HAND.standardDeduction + HAND.bracket22Top))).toBeLessThanOrEqual(1);
    expect(irmaa?.tier?.tier).toBe(1);
    expect(irmaa?.tier?.min).toBe(HAND.irmaaTier1Floor);
    expect(irmaa?.nextTier?.tier).toBe(2);
    expect(
      Math.abs((irmaa?.headroomToNextTier ?? NaN) - (HAND.irmaaTier2Floor - (HAND.standardDeduction + HAND.bracket22Top)))
    ).toBeLessThanOrEqual(1);
    expect(Math.abs((irmaa?.tier?.annualSurcharge ?? NaN) - HAND.irmaaTier1Annual)).toBeLessThan(0.01);

    // The plan did not opt in to the ACA credit, so the analytics say so and name what it would need.
    expect(analytics.cliffs?.aca?.supported).toBe(false);
    expect(analytics.cliffs?.aca?.prerequisites?.some((line) => line.includes('taxSettings.aca.optIn'))).toBe(true);
  });

  it('charges the IRMAA surcharge over the lifetime for the 22% fill, and none for the 12% fill', () => {
    // The lifetime total is every tax line plus the IRMAA surcharge (the extractor adds it), and the
    // tool does not return the surcharge on its own. Subtracting the lines it does return leaves the
    // surcharge: three conversion years, each setting tier 1 two premium years later.
    const lifetimeIrmaa = (label: string): number => {
      const toolkit = createChatToolkit({ inputs: planWithLever(label), asOf: EVAL_AS_OF });
      const result = JSON.parse(toolkit.execute('simulateVariant', { variantId: 'lever', planPatch: {} })) as {
        lifetimeTaxes?: Record<string, number>;
      };
      const lines = result.lifetimeTaxes ?? {};
      const listed =
        (lines.federalIncomeTax ?? 0) +
        (lines.ficaTax ?? 0) +
        (lines.capitalGainsTax ?? 0) +
        (lines.niit ?? 0) +
        (lines.earlyWithdrawalPenalties ?? 0);

      return (lines.total ?? NaN) - listed;
    };

    expect(Math.abs(lifetimeIrmaa(LADDER_22) - 3 * HAND.irmaaTier1Annual)).toBeLessThanOrEqual(1);
    expect(Math.abs(lifetimeIrmaa(LADDER_12))).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// The set's own statement of what it leaves out
// ============================================================================

const readme = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8');
const evalSetSource = readFileSync(fileURLToPath(new URL('./tax_optimization_evals.ts', import.meta.url)), 'utf8');

const OMISSIONS_HEADING = '## What the set deliberately omits';

/** The section from its heading to the next one: the passage that decides what a refusal may claim. */
const omissionsSection = ((): string => {
  const start = readme.indexOf(OMISSIONS_HEADING);
  if (start < 0) throw new Error(`README.md no longer has a "${OMISSIONS_HEADING}" section`);
  const end = readme.indexOf('\n## ', start + OMISSIONS_HEADING.length);

  return end < 0 ? readme.slice(start) : readme.slice(start, end);
})();

/**
 * The bullets of that section, each with its wrapped continuation folded in. Only the bullets carry
 * the list; the prose around them names California's own unmodelled questions, which is a different
 * statement (the state's AMT, not the federal one).
 */
const omissionBullets = ((): string[] => {
  const bullets: string[] = [];
  let open = false;

  for (const line of omissionsSection.split('\n')) {
    if (line.startsWith('- ')) {
      bullets.push(line);
      open = true;
    } else if (open && line.startsWith('  ')) {
      bullets[bullets.length - 1] += ` ${line.trim()}`;
    } else {
      open = false;
    }
  }

  return bullets;
})();

const omittedBullets = omissionBullets.join('\n');

/**
 * The levers the engine computes, as the words that name them. California's AMT is a different tax
 * (it is not computed) and is removed from a sentence before these are matched, so the state
 * question cannot stand in for the federal one.
 */
const MODELLED_LEVER_PATTERNS = [/itemized deduction/i, /\bSALT\b/, /\bAMT\b/, /\bIRMAA\b/] as const;

const withoutCaliforniaAmt = (text: string): string => text.replace(/California'?s?\s+AMT/gi, 'STATE-MINIMUM-TAX');

/**
 * Every list-shaped line of the section: a bullet, a numbered item or a markdown table row.
 *
 * `omissionBullets` above reads one list syntax only, and that is the hole: a rewrite that keeps the
 * ACA bullet and moves the modelled levers into a table row inside the same section passes those
 * pins while the section still says the levers are omitted. Being a list item under "What the set
 * deliberately omits" *is* the denial, so the shape is what this check reads.
 */
const omissionListLines = ((): string[] => {
  const lines = omissionsSection.split('\n').filter((line) => /^ {0,3}(?:[-*+]|\d+\.)\s/.test(line) || line.trimStart().startsWith('|'));

  return lines.map(withoutCaliforniaAmt);
})();

/**
 * The words that deny a lever is computed. Deliberately narrow: the section's own prose says the
 * levers are "**not on this list**", which is the opposite claim and must not trip this.
 */
const LEVER_DENIAL = /\bnot\s+(?:modell?ed|computed|supported|available)\b|\bunmodell?ed\b|\bcannot\s+compute\b|\bomits?\b|\bomitted\b/i;

/**
 * The section's claims, one per block: a list item, a table row, or a sentence of prose. Wrapped
 * prose lines are joined first, so a denial cannot hide by breaking across a line.
 */
const omissionClaims = ((): string[] => {
  const blocks: string[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length > 0) blocks.push(prose.join(' '));
    prose = [];
  };

  for (const rawLine of omissionsSection.split('\n')) {
    const line = rawLine.trim();

    if (line === '') {
      flushProse();
    } else if (/^(?:[-*+]|\d+\.)\s/.test(line) || line.startsWith('|')) {
      flushProse();
      blocks.push(line);
    } else {
      prose.push(line);
    }
  }
  flushProse();

  return blocks
    .flatMap((block) => block.split(/(?<=[.!?])\s+/))
    .map((claim) => withoutCaliforniaAmt(claim.replace(/\s+/g, ' ').trim()))
    .filter((claim) => claim.length > 0);
})();

/** A modelled lever named in that section would make the refusal the passing answer again. */
describe('tax-optimization eval set: what it says the engine cannot compute', () => {
  it('keeps the modelled deductions, the SALT cap, AMT and IRMAA off the omitted list', () => {
    // The deduction (P3-P3), the SALT cap, AMT and IRMAA (P3-P7a) are computed and reported. A
    // guidance line that still lists them makes the corpus grade "the lever is not modelled" as
    // the correct answer when it is now false.
    expect(omittedBullets).not.toContain('Itemized deductions');
    expect(omittedBullets).not.toContain('SALT cap');
    expect(omittedBullets).not.toMatch(/\bAMT\b/);
    expect(omittedBullets).not.toMatch(/\bIRMAA\b/);
    expect(omittedBullets).not.toContain('itemized deductions/SALT');
  });

  it('says in the same section that they are modelled, and how a plan enters them', () => {
    expect(omissionsSection).toContain('**itemized deductions**');
    expect(omissionsSection).toContain('`taxSettings.itemizedDeductions`');
    expect(omissionsSection).toContain('the §164 SALT cap');
    expect(omissionsSection).toContain('**AMT**');
    expect(omissionsSection).toContain('**IRMAA**');
    // The one thing the section must not do is let a reviewer score the refusal as a pass.
    expect(omissionsSection).toContain('`refused-patches` must not be scored as a pass');
  });

  it('names no modelled lever in any list item or table row of the section', () => {
    // A paragraph may say a lever is computed; a *list item* under this heading says it is omitted —
    // whichever words it uses and whichever list syntax carries it.
    expect(omissionListLines.length).toBeGreaterThan(0);

    const named = omissionListLines.filter((line) => MODELLED_LEVER_PATTERNS.some((pattern) => pattern.test(line)));

    expect(named).toEqual([]);
  });

  it('never denies a modelled lever in the section prose', () => {
    // The table above catches a list-shaped omission; this catches a sentence that says so in
    // passing. A lever named in prose is fine — the section names them to say they *are* modelled.
    const denials = omissionClaims.filter(
      (claim) => LEVER_DENIAL.test(claim) && MODELLED_LEVER_PATTERNS.some((pattern) => pattern.test(claim))
    );

    expect(denials).toEqual([]);
  });

  it('keeps ACA on the omitted list, where the tool really cannot answer', () => {
    expect(omittedBullets).toContain('ACA premium tax credit');
  });

  it('reports the deduction and leaves only the ACA cliff unevaluated', () => {
    // The prose above is checked against the tool it describes: `deductions` is a reported figure,
    // `cliffs.aca.supported` is false, and `notComputed` asks for the *marginal* effect of an
    // itemized deduction rather than calling the deduction itself unmodelled.
    const evalCase = TAX_OPTIMIZATION_EVALS[0];
    const toolkit = createChatToolkit({ inputs: evalCase.plan, asOf: EVAL_AS_OF });
    const analytics = JSON.parse(toolkit.execute('getTaxAnalytics', { year: 2030 })) as {
      deductions?: { type?: string };
      cliffs?: { aca?: { supported?: boolean } };
      notComputed?: string[];
    };
    const notComputed = analytics.notComputed ?? [];

    expect(['standard', 'itemized']).toContain(analytics.deductions?.type);
    expect(analytics.cliffs?.aca?.supported).toBe(false);
    expect(notComputed.some((entry) => entry.includes('ACA premium tax credit'))).toBe(true);
    expect(notComputed.some((entry) => entry.includes('The marginal effect of an itemized deduction'))).toBe(true);
    expect(notComputed.some((entry) => entry.includes('itemized deduction') && !entry.includes('marginal'))).toBe(false);
  });

  it('keeps the module header off the stale list too', () => {
    const header = evalSetSource.slice(0, evalSetSource.indexOf('export type EvalGoal'));

    expect(header).not.toContain('itemized deductions/SALT');
    expect(header).not.toContain('AMT/IRMAA');
    expect(header).toContain('`taxSettings.itemizedDeductions`');
    expect(header).toContain('`cliffs.aca.supported` is `false`');
  });

  it('does not let the refused-patches check pass a modelled lever off as unmodelled', () => {
    const check = TAX_OPTIMIZATION_EVAL_CHECKS.find((entry) => entry.id === 'refused-patches');
    if (!check) throw new Error('the refused-patches check is missing');

    // A reviewer reads this property to score the transcript: it has to say that a refusal is
    // wrong for the levers the engine computes, or the old answer keeps scoring as a pass.
    expect(check.property).toContain('Roth conversions through `conversions`');
    expect(check.property).toContain('is never such a refusal');
    expect(check.property).toContain('`taxSettings.itemizedDeductions`');
    expect(check.property).toContain('`nondeductibleBasis`');
  });

  it('gives an unmodelled lever as the example, not a modelled one', () => {
    const check = TAX_OPTIMIZATION_EVAL_CHECKS.find((entry) => entry.id === 'refused-patches');
    if (!check) throw new Error('the refused-patches check is missing');
    const header = evalSetSource.slice(0, evalSetSource.indexOf('export type EvalGoal'));

    // Social Security claiming IS modelled and patchable (`socialSecurity.claimAge`); this corpus
    // simply has no `socialSecurity` fixture. Naming it as the example of an unmodelled lever — in
    // the property a reviewer scores the transcript with, or in this directory's module header —
    // tells that reviewer to pass the answer README.md calls wrong.
    expect(check.property).not.toContain('Social Security claiming');
    expect(header).not.toContain('ACA opt-in cases, Social Security claiming');
    expect(header).toContain('`claimAge`');
    expect(header).toContain('fixture gap');

    // The example it does give is one the prompt itself lists as unmodelled: a state return other
    // than California's, and estate tax ("no estate, trust, business or rental tax, and no
    // multi-state residency").
    expect(check.property).toContain('a state income tax other than California');
    // The prompt wraps this sentence, so the check reads it with whitespace folded.
    expect(TAX_OPTIMIZATION_SKILL_PROMPT.replace(/\s+/g, ' ')).toContain(
      'no estate, trust, business or rental tax, and no multi-state residency'
    );
  });
});

describe('tax-optimization eval rubric', () => {
  it('has uniquely identified checks', () => {
    const ids = TAX_OPTIMIZATION_EVAL_CHECKS.map((check) => check.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(8);
  });

  it('gives every check a rule in the prompt', () => {
    const checkIds = TAX_OPTIMIZATION_EVAL_CHECKS.map((check) => check.id);

    // No check without a rule, and no rule mapped to a check that does not exist.
    expect(Object.keys(RULE_FOR_CHECK).sort()).toEqual([...checkIds].sort());

    for (const check of TAX_OPTIMIZATION_EVAL_CHECKS) {
      const rules = RULE_FOR_CHECK[check.id];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(TAX_OPTIMIZATION_SKILL_PROMPT).toContain(rule);
    }
  });
});
