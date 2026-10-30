/**
 * California State Disability Insurance (SDI) withholding.
 *
 * SDI is a payroll line, not an income-tax line: it is withheld from wages and is not charged on
 * self-employment income, so it does not belong in the CA income-tax ruleset (P3-P8) or in a
 * federal table. It gets its own small table here so payroll can resolve it per tax year, and so
 * P3-P8 can fold it into `states/CA/<year>.ts` without moving the consumer.
 *
 * ## Provenance (verified, not assumed)
 *
 * California EDD, "Rates and Withholding" (edd.ca.gov/en/payroll_taxes/rates_and_withholding/),
 * read 2026-10-30:
 *
 * - 2024: 1.1% — "Effective January 1, 2024, Senate Bill 951 removes the taxable wage limit and
 *   maximum withholdings for each employee subject to SDI contributions." There is therefore **no
 *   wage cap** from 2024 onward, and `wageCap` is `null` for every year in this table.
 * - 2025: 1.2%
 * - 2026: 1.3% — "The SDI withholding rate for 2026 is 1.3 percent."
 * - 2027: 1.4% — "The SDI withholding rate for 2027 is 1.4 percent." Published at the time of
 *   writing, so a plan that projects past 2026 does not silently reuse 2026's rate.
 *
 * The effective rate is published annually in the fall, so a year the table does not name falls
 * back to the nearest *prior* year (never a later one) exactly like `getRules()`. Each fall's
 * update adds the new row; a projection past the last row is therefore an assumption, and the
 * return value says which year it actually resolved to.
 */

import type { TableMeta, TaxYear } from './types';

/** What a payroll run needs to know about SDI for one tax year. */
export interface CaliforniaSdiTable {
  /** Employee withholding rate, e.g. 0.013 for 2026. */
  readonly rate: number;
  /**
   * The wage cap, or `null` for "every wage is subject". SB 951 removed the cap on 2024-01-01;
   * the field is explicit so no consumer has to remember that.
   */
  readonly wageCap: number | null;
}

const SOURCE =
  'California EDD, "Rates and Withholding" (edd.ca.gov/en/payroll_taxes/rates_and_withholding/), read 2026-10-30; ' +
  'no wage cap since 2024 under SB 951.';

const CALIFORNIA_SDI_RATES: ReadonlyMap<TaxYear, TableMeta<CaliforniaSdiTable>> = new Map<TaxYear, TableMeta<CaliforniaSdiTable>>([
  [2024, { indexing: 'fixed', source: SOURCE, values: { rate: 0.011, wageCap: null } }],
  [2025, { indexing: 'fixed', source: SOURCE, values: { rate: 0.012, wageCap: null } }],
  [2026, { indexing: 'fixed', source: SOURCE, values: { rate: 0.013, wageCap: null } }],
  [2027, { indexing: 'fixed', source: SOURCE, values: { rate: 0.014, wageCap: null } }],
]);

/** The newest year with a published SDI rate. */
export const LATEST_SDI_TAX_YEAR: TaxYear = Math.max(...CALIFORNIA_SDI_RATES.keys());

export interface ResolvedCaliforniaSdi extends TableMeta<CaliforniaSdiTable> {
  /** The year the rate actually came from; older than `year` when the table falls back. */
  readonly resolvedYear: TaxYear;
}

/**
 * Resolves the SDI table for `year`, falling back to the nearest prior published year.
 *
 * @throws when `year` is before the first published rate, rather than inventing one.
 */
export function getCaliforniaSdi(year: TaxYear): ResolvedCaliforniaSdi {
  if (!Number.isInteger(year)) throw new Error(`Tax year must be an integer, received ${year}`);

  let resolvedYear: TaxYear | undefined;
  for (const candidate of CALIFORNIA_SDI_RATES.keys()) {
    if (candidate <= year && (resolvedYear === undefined || candidate > resolvedYear)) resolvedYear = candidate;
  }

  if (resolvedYear === undefined) {
    const earliest = Math.min(...CALIFORNIA_SDI_RATES.keys());
    throw new Error(
      `No California SDI rate for ${year} or any earlier year (earliest available: ${earliest}). ` +
        "Add the year before simulating it — a later year's rate must never be borrowed backwards."
    );
  }

  return { ...CALIFORNIA_SDI_RATES.get(resolvedYear)!, resolvedYear };
}
