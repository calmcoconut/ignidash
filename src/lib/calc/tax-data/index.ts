/**
 * Ruleset resolution: `getRules(year)` → the ruleset for that year, or the nearest prior year.
 *
 * Resolution never borrows a *later* year. A table written for 2027 describes law that does not
 * apply to a 2026 return, so using it would be silently wrong; a year with no ruleset at or
 * before it throws instead. Adding a year means adding `years/<year>.ts` and registering it here.
 *
 * The resolver is keyed by jurisdiction from the start, so California (P3-P8) is a new registry
 * entry — `states/CA/<year>.ts` — and nothing in the federal ruleset or its consumers moves.
 * Resolving a jurisdiction that has no registry yet throws, rather than quietly returning
 * federal law.
 */

import type { CaliforniaTaxRuleset, FederalTaxRuleset, Jurisdiction, TaxRuleset, TaxYear } from './types';
import { FEDERAL_2026 } from './years/2026';
import { CALIFORNIA_2025 } from './states/CA/2025';

export { taxYearFor } from './tax-year';

const FEDERAL_RULESETS: ReadonlyMap<TaxYear, FederalTaxRuleset> = new Map([[FEDERAL_2026.year, FEDERAL_2026]]);

/**
 * California's rulesets. 2025 is the latest year the FTB has published, so a 2026 (or later) return
 * resolves the 2025 ruleset by the nearest-prior rule and reports that year back.
 */
const CALIFORNIA_RULESETS: ReadonlyMap<TaxYear, CaliforniaTaxRuleset> = new Map([[CALIFORNIA_2025.year, CALIFORNIA_2025]]);

/** Every jurisdiction's rulesets, by year. A jurisdiction appears once it has a ruleset. */
const RULESET_REGISTRIES: Partial<Record<Jurisdiction, ReadonlyMap<TaxYear, TaxRuleset>>> = {
  federal: FEDERAL_RULESETS,
  CA: CALIFORNIA_RULESETS,
};

/** The newest federal tax year with a ruleset. Used only as a default when no year is supplied. */
export const LATEST_TAX_YEAR: TaxYear = Math.max(...FEDERAL_RULESETS.keys());

function resolve<T extends TaxRuleset>(registry: ReadonlyMap<TaxYear, T>, jurisdiction: Jurisdiction, year: TaxYear): T {
  if (!Number.isInteger(year)) throw new Error(`Tax year must be an integer, received ${year}`);

  const exact = registry.get(year);
  if (exact) return exact;

  let nearestPrior: TaxYear | undefined;
  for (const candidate of registry.keys()) {
    if (candidate <= year && (nearestPrior === undefined || candidate > nearestPrior)) nearestPrior = candidate;
  }

  if (nearestPrior === undefined) {
    const earliest = Math.min(...registry.keys());
    throw new Error(
      `No ${jurisdiction} tax ruleset for ${year} or any earlier year (earliest available: ${earliest}). ` +
        "Add the year before simulating it — a later year's ruleset must never be borrowed backwards."
    );
  }

  return registry.get(nearestPrior)!;
}

/**
 * Resolves the federal ruleset for `year`, falling back to the nearest prior year.
 *
 * @throws when no federal ruleset exists at or before `year`.
 */
export function getRules(year: TaxYear): FederalTaxRuleset;
/** Resolves the `jurisdiction` ruleset for `year`, falling back to the nearest prior year. */
export function getRules(year: TaxYear, jurisdiction: 'federal'): FederalTaxRuleset;
/** Resolves the California ruleset for `year`, falling back to the nearest prior year. */
export function getRules(year: TaxYear, jurisdiction: 'CA'): CaliforniaTaxRuleset;
export function getRules(year: TaxYear, jurisdiction: Jurisdiction): TaxRuleset;
export function getRules(year: TaxYear, jurisdiction: Jurisdiction = 'federal'): TaxRuleset {
  const registry = RULESET_REGISTRIES[jurisdiction];
  if (!registry) {
    throw new Error(`No ${jurisdiction} tax ruleset registry exists. Only ${Object.keys(RULESET_REGISTRIES).join(', ')} are available.`);
  }

  return resolve(registry, jurisdiction, year);
}
