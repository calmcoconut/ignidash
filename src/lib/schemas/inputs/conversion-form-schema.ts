/**
 * Roth conversion schedule schema (parity plan P3-P5).
 *
 * A Roth conversion is a transfer of funds from a tax-deferred account (such as a traditional IRA)
 * to a Roth IRA.
 *
 * Each entry in the schedule specifies:
 * - `id`: unique identifier for the conversion rule.
 * - `name`: optional descriptive label.
 * - `fromAccountId`: the source tax-deferred account.
 * - `toAccountId`: the destination Roth account.
 * - timing: `year` (calendar year) or `timePoint` (event or age).
 * - target: either a fixed `amount`, or a `fillToBracket` target rate (and optional jurisdiction).
 *
 * It also carries the **one** rule the editor and the `convex/conversion.ts` mutation share
 * (`conversionsProblems`), so a schedule the dialog accepts is a schedule that mutation writes and
 * vice versa. See the long comment on `conversionProblem` for what it refuses and why.
 */

import { z } from 'zod';

import { timePointSchema } from './income-expenses-shared-schemas';
import { accountTypeForDisplay, isRothAccount, isTraditionalAccount, type AccountInputs } from './account-form-schema';
import { getRules, LATEST_TAX_YEAR } from '../../calc/tax-data';

export const conversionJurisdictionSchema = z.enum(['federal', 'california']);
export type ConversionJurisdiction = z.infer<typeof conversionJurisdictionSchema>;

export const conversionFillToBracketTargetSchema = z.object({
  targetBracketRate: z.number().min(0).max(1),
  jurisdiction: conversionJurisdictionSchema.optional(),
});
export type ConversionFillToBracketTarget = z.infer<typeof conversionFillToBracketTargetSchema>;

/** The stored bounds of a conversion's calendar year; the editor uses the same bounds. */
export const CONVERSION_YEAR_RANGE = { min: 1900, max: 2150 } as const;

const baseConversionFields = {
  id: z.string().min(1),
  name: z.string().optional(),
  fromAccountId: z.string().min(1, 'Source account is required'),
  toAccountId: z.string().min(1, 'Destination account is required'),
  year: z.number().int().min(CONVERSION_YEAR_RANGE.min).max(CONVERSION_YEAR_RANGE.max).optional(),
  timePoint: timePointSchema.optional(),
};

export const conversionWithAmountSchema = z.object({
  ...baseConversionFields,
  amount: z.number().min(0, 'Conversion amount must be non-negative'),
});

export const conversionWithFillToBracketSchema = z.object({
  ...baseConversionFields,
  fillToBracket: z.union([z.number().min(0).max(1), conversionFillToBracketTargetSchema]),
});

export const conversionSchema = z
  .union([conversionWithAmountSchema, conversionWithFillToBracketSchema])
  .refine((data) => data.year !== undefined || data.timePoint !== undefined, {
    message: 'Conversion must specify a year or timePoint',
  });

export type ConversionInputs = z.infer<typeof conversionSchema>;

export const conversionsSchema = z.array(conversionSchema);

/** The five timing kinds the stored `timePoint` union can name (`timePointSchema`'s enum). */
export type ConversionTimingType = z.infer<typeof timePointSchema>['type'];

/**
 * The account facts the rule needs. `AccountInputs` satisfies it, and so does a Convex account
 * document narrowed to these three fields — which is what `convex/conversion.ts` passes.
 */
export interface ConversionAccountLike {
  readonly id: string;
  readonly name: string;
  readonly type: AccountInputs['type'];
}

/**
 * The conversion a rule can be asked about.
 *
 * Structural on purpose: `ConversionInputs` (the Zod union the editor holds) and the Convex
 * document the mutation is handed both fit, so neither side needs a cast and neither can drift into
 * a shape the other does not have.
 */
export interface ConversionRuleInput {
  readonly id: string;
  readonly name?: string | undefined;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly year?: number | undefined;
  readonly timePoint?:
    | {
        readonly type: ConversionTimingType;
        readonly month?: number | undefined;
        readonly year?: number | undefined;
        readonly age?: number | undefined;
        readonly everyNYears?: number | undefined;
        readonly recurrenceYears?: number | undefined;
      }
    | undefined;
  readonly amount?: number | undefined;
  readonly fillToBracket?: number | ConversionFillToBracketTarget | undefined;
}

/**
 * The engine's own tolerance for matching a `fillToBracket` rate to a bracket
 * (`calculateFillToBracketAmount` in `src/lib/calc/taxes.ts`: `Math.abs(b.rate - targetRate) < 0.0001`).
 */
export const FILL_TO_BRACKET_RATE_TOLERANCE = 0.0001;

/**
 * The ordinary-income bracket rates a jurisdiction actually has, read from the vendored rulesets
 * rather than restated — so a rate this refuses is a rate the engine would have to substitute for.
 *
 * Every filing status shares one rate ladder in both registries (federal 2026 and CA 2025), so
 * `single` states the set; a future ruleset that split the ladder by filing status would need this
 * to take the filing status, and the `fillToBracket` message would have to name it too.
 *
 * California is resolved through `LATEST_TAX_YEAR` and the nearest-prior rule, so this never has to
 * know which year the FTB last published.
 */
export function conversionFillToBracketRates(jurisdiction: ConversionJurisdiction = 'federal'): number[] {
  const brackets =
    jurisdiction === 'california'
      ? getRules(LATEST_TAX_YEAR, 'CA').tables.incomeTaxBrackets.values.single
      : getRules(LATEST_TAX_YEAR).tables.incomeTaxBrackets.values.single;

  // Ascending and de-duplicated: the ladder as printed, without a repeated top band.
  return [...new Set(brackets.map((bracket) => bracket.rate))];
}

/** A rate as a percentage with up to four decimals: `0.093` → `9.3%`. */
function asPercent(rate: number): string {
  return `${Number((rate * 100).toFixed(4))}%`;
}

/** The bracket the engine would substitute for `rate`: the first within tolerance, else the nearest. */
function bracketRateTheEngineWouldUse(rate: number, rates: readonly number[]): number {
  const exact = rates.find((candidate) => Math.abs(candidate - rate) < FILL_TO_BRACKET_RATE_TOLERANCE);

  return (
    exact ??
    rates.reduce((previous, candidate) => (Math.abs(candidate - rate) < Math.abs(previous - rate) ? candidate : previous), rates[0])
  );
}

const JURISDICTION_LABEL: Record<ConversionJurisdiction, string> = { federal: 'federal', california: 'California' };

/**
 * Why the timing cannot fire, or `null` when it can.
 *
 * Every branch restates a line of the engine's own filter (`simulation-engine.ts`, the two
 * `activeConversions`/`activeFillConversions` predicates), which is where a stored conversion's
 * timing is read:
 *
 * - `now` fires in the plan's first calendar year; `atRetirement` in the first January the phase is
 *   called retirement; `customAge` on the January the household age rounds to `age`; `customDate`
 *   in the calendar year `year`. Each fires once for a given `id` (`executedConversionIds`).
 * - `atLifeExpectancy` has **no branch**: the filter falls through to `false`, so the row converts
 *   nothing, ever. It is refused here rather than offered, because a control that silently does
 *   nothing is the failure this rule exists to prevent. (It is not a throw, so a plan carrying one
 *   still renders; the refusal is what stops the editor from saving it unchanged.)
 * - A `customAge` without `age` and a `customDate` without `year` are compared to `undefined`, which
 *   never matches, so both are refused for the same reason.
 *
 * The two ranges mirror `timePointSchema` (1900–2100 for a date's year, 0–120 for an age); the
 * dialog validates against that schema directly, so this is the mutation's copy of the same bounds,
 * not a second opinion.
 */
function timingProblem(timePoint: NonNullable<ConversionRuleInput['timePoint']>): string | null {
  switch (timePoint.type) {
    case 'now':
    case 'atRetirement':
      return null;
    case 'atLifeExpectancy':
      return (
        'is timed at life expectancy, which the simulation’s conversion filter never honours: it reads "now", ' +
        '"at retirement", a custom age and a custom year, and a life-expectancy time point matches none of them, ' +
        'so this row would convert nothing. Use "At retirement" or a calendar year instead.'
      );
    case 'customDate':
      if (timePoint.year === undefined) {
        return (
          'is a custom date with no year: the simulation compares that year to the calendar year, so a date ' +
          'without one never matches. Fill in the year.'
        );
      }
      if (!Number.isInteger(timePoint.year) || timePoint.year < 1900 || timePoint.year > 2100) {
        return `names ${timePoint.year} as its custom-date year, but that has to be a whole year between 1900 and 2100.`;
      }
      return null;
    case 'customAge':
      if (timePoint.age === undefined) {
        return (
          'is a custom age with no age: the simulation compares that age to the household age, so an age point ' +
          'without one never matches. Fill in the age.'
        );
      }
      if (!Number.isInteger(timePoint.age) || timePoint.age < 0 || timePoint.age > 120) {
        return `names ${timePoint.age} as its custom age, but that has to be a whole age between 0 and 120.`;
      }
      return null;
  }

  // Unreachable for the closed union above; the Convex validator and `timePointSchema` both reject
  // an unknown `type` before a value reaches this function.
  return null;
}

/**
 * Why one conversion cannot be written, or `null` when it can.
 *
 * Two kinds of reason, both of them facts the stored data decides — no simulation needed, and none of
 * them a modelling question:
 *
 * 1. **The run would throw.** `processConversions` (`src/lib/calc/portfolio.ts`) throws
 *    `Conversion <id>: source account <id> not found` / `destination account <id> not found`, and so
 *    does the `fillToBracket` block in `simulation-engine.ts` before it prices anything. Those throws
 *    happen inside the simulation, which runs during render, and there is no error boundary above it:
 *    a plan that commits one never paints again, and the editor that could undo it is inside the tree
 *    that fails. So a conversion naming an account this plan does not have is refused here, with the
 *    engine's own wording in the message so the two can be recognised as the same fact.
 * 2. **The run would silently do the wrong thing.** None of these throw; each makes the displayed
 *    numbers mean something nobody asked for, which is worse than an error:
 *    - source = destination: the balance leaves and re-enters one account while the amount is still
 *      counted as taxable income, so the tax bill rises and nothing moves;
 *    - a source that is not tax-deferred, or a destination that is not Roth: money is "converted" into
 *      an account with the wrong tax treatment, so the conversion is taxed and the destination still
 *      grows pre-tax;
 *    - both a `year` and a `timePoint`: the engine reads the year first, so the time point is a field
 *      nothing ever looks at;
 *    - neither: the filter returns `false` for every month and the row never fires;
 *    - a `fillToBracket` rate that is not a bracket: `calculateFillToBracketAmount` does not throw,
 *      it fits the amount to the *nearest* bracket, so a 50% target quietly fills the 35% band.
 *
 * What it deliberately does **not** refuse: anything only a run can answer — an account with no
 * balance (the conversion is capped at the balance, and `$0` moves), a year already in the past (it
 * simply never fires), or a conversion that pushes income past a bracket. Those are legitimate
 * modelling inputs whose outcome the results show, so the row copy says what will happen instead of
 * claiming the row is impossible.
 *
 * Messages name the offending row's own values and what to change, and never suggest a figure the
 * rest of this rule would refuse.
 */
export function conversionProblem(conversion: ConversionRuleInput, accounts: readonly ConversionAccountLike[]): string | null {
  const { id, year, timePoint, amount, fillToBracket } = conversion;

  if (id.trim() === '') {
    return 'has no id. The simulation remembers which conversions it has already run by id, so a row without one is not a conversion the plan can record.';
  }

  if (year !== undefined && timePoint !== undefined) {
    return (
      `states both a year (${year}) and a time point (${timePoint.type}). The simulation checks the year first and ` +
      'never looks at the time point, so one of the two would be a field nothing reads. Keep one of them.'
    );
  }

  if (year !== undefined && (!Number.isInteger(year) || year < CONVERSION_YEAR_RANGE.min || year > CONVERSION_YEAR_RANGE.max)) {
    return `names ${year} as its year, but a conversion year is a whole year between ${CONVERSION_YEAR_RANGE.min} and ${CONVERSION_YEAR_RANGE.max}.`;
  }

  if (timePoint !== undefined) {
    const problem = timingProblem(timePoint);
    if (problem !== null) return problem;
  } else if (year === undefined) {
    return (
      'has neither a year nor a time point, so the simulation never runs it: the filter compares the year (or the ' +
      'time point) to the calendar year and this row matches neither. Give it a calendar year, or a time point ' +
      'such as "This year".'
    );
  }

  const source = accounts.find((account) => account.id === conversion.fromAccountId);
  if (!source) {
    return (
      `names ${conversion.fromAccountId} as its source account, and this plan has no such account. The simulation ` +
      'throws on a conversion whose account is gone ("source account … not found") while it renders the plan, so ' +
      'saving this row would leave a plan that cannot be opened. Pick an account that still exists, or remove the row.'
    );
  }

  const destination = accounts.find((account) => account.id === conversion.toAccountId);
  if (!destination) {
    return (
      `names ${conversion.toAccountId} as its destination account, and this plan has no such account. The ` +
      'simulation throws on a conversion whose account is gone ("destination account … not found") while it ' +
      'renders the plan, so saving this row would leave a plan that cannot be opened. Pick an account that still ' +
      'exists, or remove the row.'
    );
  }

  if (source.id === destination.id) {
    return (
      `names ${source.name} as both the source and the destination. The balance would leave and re-enter the same ` +
      'account while the amount still counted as taxable income, so the tax bill would rise and nothing would move. ' +
      'Pick the Roth account the money goes into.'
    );
  }

  if (!isTraditionalAccount(source.type)) {
    return (
      `takes its money out of ${source.name}, which is a ${accountTypeForDisplay(source.type)}, not a tax-deferred ` +
      'account. A Roth conversion moves money from a traditional IRA or an employer plan (IRA, 401(k), 403(b)); ' +
      'take it from one of those.'
    );
  }

  if (!isRothAccount(destination.type)) {
    return (
      `sends its money to ${destination.name}, which is a ${accountTypeForDisplay(destination.type)}, not a Roth ` +
      'account. Pick a Roth IRA, a Roth 401(k) or a Roth 403(b) as the destination.'
    );
  }

  if (amount !== undefined && fillToBracket !== undefined) {
    return (
      'states both a fixed amount and a fill-to-bracket target. The simulation reads the target to decide how much ' +
      'to convert, so the amount would be a field nothing reads. Keep one of them.'
    );
  }

  if (amount !== undefined) {
    if (!Number.isFinite(amount) || amount < 0) {
      return `converts ${amount}, but a conversion amount is a number of dollars and cannot be negative.`;
    }

    return null;
  }

  if (fillToBracket !== undefined) {
    const targetRate = typeof fillToBracket === 'number' ? fillToBracket : fillToBracket.targetBracketRate;
    const jurisdiction: ConversionJurisdiction =
      typeof fillToBracket === 'object' && fillToBracket.jurisdiction ? fillToBracket.jurisdiction : 'federal';
    const label = JURISDICTION_LABEL[jurisdiction];

    if (!Number.isFinite(targetRate) || targetRate < 0 || targetRate > 1) {
      return `asks to fill the ${label} ${targetRate} bracket, but a bracket rate is a decimal between 0 and 1 (22% is 0.22).`;
    }

    const rates = conversionFillToBracketRates(jurisdiction);
    if (!rates.some((candidate) => Math.abs(candidate - targetRate) < FILL_TO_BRACKET_RATE_TOLERANCE)) {
      const substituted = bracketRateTheEngineWouldUse(targetRate, rates);

      return (
        `asks to fill the ${label} ${asPercent(targetRate)} bracket, and there is no ${asPercent(targetRate)} ${label} ` +
        `bracket: the ${label} rates are ${rates.map(asPercent).join(', ')}. The simulation does not refuse it — it fits ` +
        `the amount to the nearest bracket (${asPercent(substituted)}), so the conversion would fill a band you did not ` +
        'choose. Pick one of the rates listed.'
      );
    }

    return null;
  }

  return (
    'has no target: a conversion is either a fixed amount or a fill-to-bracket rate, and the simulation reads the ' +
    'target to decide how much to move. Add one of them.'
  );
}

/**
 * Every reason a whole stored list cannot be written, in row order — empty when it can.
 *
 * The per-row rule is `conversionProblem`; the one thing only the list can decide is identity, because
 * the engine marks a conversion executed by `id`. Two rows sharing an id therefore fire once between
 * them: the second is remembered as done before it ever runs. That is silent, so it is refused.
 */
export function conversionsProblems(
  conversions: readonly ConversionRuleInput[],
  accounts: readonly ConversionAccountLike[]
): { readonly index: number; readonly problem: string }[] {
  const seenIds = new Set<string>();
  const problems: { index: number; problem: string }[] = [];

  conversions.forEach((conversion, index) => {
    const problem = conversionProblem(conversion, accounts);

    if (problem !== null) problems.push({ index, problem });
    else if (seenIds.has(conversion.id)) {
      problems.push({
        index,
        problem: `repeats the id ${conversion.id} of an earlier row. The simulation records which conversions have already run by id, so the second row with that id would never fire. Give this row a new id.`,
      });
    }

    seenIds.add(conversion.id);
  });

  return problems;
}
