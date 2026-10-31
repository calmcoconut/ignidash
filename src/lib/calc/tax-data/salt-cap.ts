/**
 * The state-and-local-tax (SALT) deduction cap, by tax year.
 *
 * The cap is not a single ruleset amount: it is a **statutory schedule** with a MAGI phase-down and
 * a sunset, and the schedule applies to a year whether or not that year has a full ruleset yet.
 * Keeping it in its own table (like California SDI) means a 2029 projection gets 2029's cap instead
 * of silently borrowing 2026's.
 *
 * ## Provenance (the statute, not a summary)
 *
 * Public Law 119-21 (the One Big Beautiful Bill Act), §70120, amending IRC §164(b)(6)-(7), read
 * from the enrolled text on govinfo.gov (PLAW-119publ21), 2026-10-30:
 *
 * > `applicable limitation amount` means — (i) in the case of any taxable year beginning in calendar
 * > year 2025, $40,000, (ii) in the case of any taxable year beginning in calendar year 2026,
 * > $40,400, (iii) in the case of any taxable year beginning after calendar year 2026 and before
 * > 2030, 101 percent of the dollar amount in effect … for taxable years beginning in the preceding
 * > calendar year, and (iv) in the case of any taxable year beginning after calendar year 2029,
 * > $10,000.
 *
 * > the applicable limitation amount shall be reduced by 30 percent of the excess (if any) of the
 * > taxpayer's modified adjusted gross income over the threshold amount … (I) 2025, $500,000,
 * > (II) 2026, $505,000, and (III) after 2026, 101 percent of the amount in effect for the preceding
 * > year. … The reduction … shall not result in the applicable limitation amount being less than
 * > $10,000.
 *
 * Two corrections to the plan row (§3-P3), which said "$40k for 2025, rising 1% a year through 2029,
 * phased down above $500k MAGI, back to $10k in 2030": the 2026 cap is **$40,400** (not $40,000) and
 * the 2026 phase-down threshold is **$505,000** (not $500,000), both because the 1% escalator starts
 * in 2026. The rest of the row holds.
 *
 * ## Why `indexing: 'indexed'`
 *
 * The repo's flag means "must be re-issued every year, never copied forward". The 2025-2029 rows
 * escalate 1% a year *by statute* (not by CPI), so they are re-issued annually and are marked
 * `indexed`; the 2030-and-later row is a flat $10,000 fixed by statute, so it is marked `fixed`.
 * The 2026-2029 amounts below are the statute's arithmetic (101% compounding), which is the
 * authority; the IRS publishes rounded dollars for each year as it arrives, and a rounding of cents
 * is immaterial at these magnitudes.
 *
 * A separate return (MFS) uses **half of both amounts** — the cap and the phase-down threshold — per
 * §164(b)(6)-(7): §164(b)(7) applies the limitation to a separate return by reference to one-half of
 * the amounts that would otherwise apply. `saltCapFor` takes the filing status and does the halving
 * from the table, so a ruleset update never has to restate a halved copy of each year's cap.
 *
 * One reading is deliberately left as the supervisor's decision rather than the statute's most
 * expansive one: the $10,000 **floor** of the phase-down is not halved, only the cap and the
 * threshold. A separate return's cap therefore cannot fall below the same $10,000 floor a joint
 * return's cannot. If a future reading halves the floor too, `floorFor` below is the one line to
 * change, and the consequence is a $5,000 floor on separate returns.
 */

import type { FilingStatus } from '@/lib/schemas/inputs/tax-settings-form-schema';

import type { TableMeta, TaxYear } from './types';

/** One year's SALT cap: the amount, the MAGI phase-down, and the floor it cannot go below. */
export interface SaltCapTable {
  /** The cap before the phase-down. */
  readonly cap: number;
  /** MAGI above which the cap phases down; `Infinity` when the year has no phase-down. */
  readonly phaseDownThreshold: number;
  /** Share of the excess MAGI that reduces the cap (0.30, or 0 when there is no phase-down). */
  readonly phaseDownRate: number;
  /** The floor the phase-down cannot breach. */
  readonly floor: number;
}

export interface ResolvedSaltCap extends TableMeta<SaltCapTable> {
  /** The year the row came from; older than the requested year when the schedule falls back. */
  readonly resolvedYear: TaxYear;
}

const SOURCE =
  'IRC §164(b)(6)-(7), added by P.L. 119-21 §70120: $40,000 (2025), $40,400 (2026), +1%/yr through 2029, ' +
  '$10,000 from 2030; phase-down of 30% of MAGI over $500,000 (2025), $505,000 (2026), +1%/yr, floor $10,000.';

const SALT_CAPS: ReadonlyMap<TaxYear, TableMeta<SaltCapTable>> = new Map<TaxYear, TableMeta<SaltCapTable>>([
  [2025, { indexing: 'indexed', source: SOURCE, values: { cap: 40000, phaseDownThreshold: 500000, phaseDownRate: 0.3, floor: 10000 } }],
  [2026, { indexing: 'indexed', source: SOURCE, values: { cap: 40400, phaseDownThreshold: 505000, phaseDownRate: 0.3, floor: 10000 } }],
  [2027, { indexing: 'indexed', source: SOURCE, values: { cap: 40804, phaseDownThreshold: 510050, phaseDownRate: 0.3, floor: 10000 } }],
  [
    2028,
    { indexing: 'indexed', source: SOURCE, values: { cap: 41212.04, phaseDownThreshold: 515150.5, phaseDownRate: 0.3, floor: 10000 } },
  ],
  [
    2029,
    { indexing: 'indexed', source: SOURCE, values: { cap: 41624.1604, phaseDownThreshold: 520302.005, phaseDownRate: 0.3, floor: 10000 } },
  ],
  // 2030 and later: the cap reverts to a flat $10,000 with no phase-down, fixed by statute.
  [2030, { indexing: 'fixed', source: SOURCE, values: { cap: 10000, phaseDownThreshold: Infinity, phaseDownRate: 0, floor: 10000 } }],
]);

/** The newest year the schedule names. */
export const LATEST_SALT_CAP_YEAR: TaxYear = Math.max(...SALT_CAPS.keys());

/**
 * The SALT cap for `year`, falling back to the nearest prior row (never a later one).
 *
 * @throws when `year` is before the first row, rather than inventing a cap.
 */
export function getSaltCap(year: TaxYear): ResolvedSaltCap {
  if (!Number.isInteger(year)) throw new Error(`Tax year must be an integer, received ${year}`);

  let resolvedYear: TaxYear | undefined;
  for (const candidate of SALT_CAPS.keys()) {
    if (candidate <= year && (resolvedYear === undefined || candidate > resolvedYear)) resolvedYear = candidate;
  }

  if (resolvedYear === undefined) {
    const earliest = Math.min(...SALT_CAPS.keys());
    throw new Error(
      `No SALT cap for ${year} or any earlier year (earliest available: ${earliest}). ` +
        "Add the year before simulating it — a later year's cap must never be borrowed backwards."
    );
  }

  return { ...SALT_CAPS.get(resolvedYear)!, resolvedYear };
}

/**
 * The cap and threshold a filing status gets before the phase-down.
 *
 * §164(b)(7) halves both amounts on a separate return; every other status uses the table's own
 * values. Exported so the MFS-versus-MFJ fixture can state the halving without re-deriving it.
 */
export function saltCapAmountsFor(
  values: SaltCapTable,
  filingStatus: FilingStatus
): { cap: number; phaseDownThreshold: number; floor: number } {
  if (filingStatus !== 'marriedFilingSeparately')
    return { cap: values.cap, phaseDownThreshold: values.phaseDownThreshold, floor: values.floor };

  return { cap: values.cap / 2, phaseDownThreshold: values.phaseDownThreshold / 2, floor: values.floor };
}

/**
 * The cap a MAGI actually gets: the year's amount, less 30% of the MAGI over the threshold, but
 * never below the floor.
 *
 * Hand check (2026, single): MAGI $505,000 → $40,400 (no phase-down, the threshold is not exceeded);
 * MAGI $600,000 → 40,400 − 30% × 95,000 = $11,900; MAGI $700,000 → 40,400 − 58,500 = −$18,100, so
 * the floor applies: $10,000.
 *
 * Hand check (2026, married filing separately): the cap is $20,200 and the phase-down threshold
 * $252,500, so MAGI $252,500 → $20,200 (exactly half of a joint filer's $40,400 at $505,000), and
 * MAGI $300,000 → 20,200 − 30% × 47,500 = $5,950, floored at $10,000. The floor is what stops a
 * separate return's cap going below a joint one's — see the note at the top of this file.
 */
export function saltCapFor(
  year: TaxYear,
  magi: number,
  filingStatus: FilingStatus = 'single'
): { cap: number; phaseDown: number; resolvedYear: TaxYear } {
  const resolved = getSaltCap(year);
  const { phaseDownThreshold, phaseDownRate } = resolved.values;
  const amounts = saltCapAmountsFor(resolved.values, filingStatus);

  const phaseDown = Number.isFinite(phaseDownThreshold) ? phaseDownRate * Math.max(0, magi - amounts.phaseDownThreshold) : 0;
  const allowed = Math.max(amounts.floor, amounts.cap - phaseDown);

  return { cap: allowed, phaseDown: amounts.cap - allowed, resolvedYear: resolved.resolvedYear };
}
