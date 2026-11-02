/**
 * Social Security full retirement age (vendored, statutory).
 *
 * The full retirement age (FRA) — the age at which an unreduced retirement benefit is payable —
 * is a function of **birth year only**, set by the 1983 Amendments (Social Security Act §216(l),
 * 42 U.S.C. §416(l)) and unchanged since. It rises in two-month steps for the transition cohorts:
 *
 *   1937 or earlier  65
 *   1938 – 1942      65 + 2, 4, 6, 8, 10 months
 *   1943 – 1954      66
 *   1955 – 1959      66 + 2, 4, 6, 8, 10 months
 *   1960 or later    67
 *
 * Source: Social Security Act §216(l) (42 U.S.C. §416(l)) and SSA's published Full Retirement Age
 * schedule (ssa.gov/benefits/retirement/planner). The table is statutory, not indexed, so it is committed rather than
 * fetched, and it does not change from year to year.
 *
 * Ages are carried in **months** internally (an age in years × 12) so the claiming adjustment can
 * be computed month by month, which is how SSA applies it; the public result exposes both.
 */

/** One step of the table: every birth year at or after `fromBirthYear` up to the next step. */
export interface FullRetirementAgeStep {
  readonly fromBirthYear: number;
  /** FRA years past 65 plus months past that year, e.g. `{ years: 66, months: 8 }`. */
  readonly years: number;
  readonly months: number;
}

/**
 * The whole table, oldest first. A lookup takes the **last** step whose `fromBirthYear` is at or
 * before the birth year, so the final step (1960+) is the floor for everyone born later.
 */
export const FULL_RETIREMENT_AGE_TABLE: readonly FullRetirementAgeStep[] = [
  { fromBirthYear: 0, years: 65, months: 0 }, // 1937 and earlier
  { fromBirthYear: 1938, years: 65, months: 2 },
  { fromBirthYear: 1939, years: 65, months: 4 },
  { fromBirthYear: 1940, years: 65, months: 6 },
  { fromBirthYear: 1941, years: 65, months: 8 },
  { fromBirthYear: 1942, years: 65, months: 10 },
  { fromBirthYear: 1943, years: 66, months: 0 }, // through 1954
  { fromBirthYear: 1955, years: 66, months: 2 },
  { fromBirthYear: 1956, years: 66, months: 4 },
  { fromBirthYear: 1957, years: 66, months: 6 },
  { fromBirthYear: 1958, years: 66, months: 8 },
  { fromBirthYear: 1959, years: 66, months: 10 },
  { fromBirthYear: 1960, years: 67, months: 0 }, // 1960 and later
];

/** A full retirement age, in years-and-months and as a count of months. */
export interface FullRetirementAge {
  readonly years: number;
  readonly months: number;
  /** `years * 12 + months` — the form the claiming adjustment uses. */
  readonly totalMonths: number;
}

/**
 * The full retirement age for a birth year.
 *
 * A birth year before 1938 falls on the first step (65); a year after 1960 stays at 67, which is
 * both the last step and the statute's ceiling, so no clamping is needed beyond picking the step.
 */
export function fullRetirementAge(birthYear: number): FullRetirementAge {
  const step = FULL_RETIREMENT_AGE_TABLE.reduce((chosen, candidate) =>
    candidate.fromBirthYear <= birthYear && candidate.fromBirthYear >= chosen.fromBirthYear ? candidate : chosen
  );

  return { years: step.years, months: step.months, totalMonths: step.years * 12 + step.months };
}

/**
 * The full retirement age for a **survivor** benefit (widow or widower), by the survivor's birth year.
 *
 * The survivor schedule is the retirement schedule two cohorts later: the statute phases it in for
 * those attaining age 60 after 1999 rather than age 62 after 1999 (42 U.S.C. §416(l)(1)), so a
 * survivor born in year Y has the retirement FRA of someone born in Y − 2:
 *
 *   1939 or earlier  65
 *   1940 – 1944      65 + 2, 4, 6, 8, 10 months
 *   1945 – 1956      66
 *   1957 – 1961      66 + 2, 4, 6, 8, 10 months
 *   1962 or later    67
 */
export function survivorFullRetirementAge(birthYear: number): FullRetirementAge {
  return fullRetirementAge(birthYear - 2);
}
