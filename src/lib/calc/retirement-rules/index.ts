/**
 * Retirement-account rules (parity plan P3-P5) — the pure-maths core.
 *
 * Four rules, each its own module, each a pure function of numbers and dated events:
 *
 * | module | rule | authority |
 * | --- | --- | --- |
 * | `ira-basis` | pro-rata recovery of after-tax basis | IRC §408(d)(2); Form 8606 |
 * | `sepp` | §72(t) substantially equal periodic payments | IRC §72(t)(2)(A)(iv); Notice 2022-6 |
 * | `roth-five-year` | the two Roth five-year clocks, ordering, first-time homebuyer | IRC §408A(d)(1), (d)(2), (d)(3)(F) |
 * | `qcd` | qualified charitable distributions and the RMD | IRC §408(d)(8) |
 *
 * Nothing here reads a clock, a store or the network, and nothing writes to a plan: the engine
 * wiring is a separate item, which is why the modules take dates, ages and amounts as arguments.
 *
 * `sepp-tables` is data rather than a rule: the §1.401(a)(9)-9(b) Single Life Table and the
 * monthly §1274(d) federal mid-term rates, vendored with a citation per value so `sepp` can price a
 * payment without the caller supplying either. It refuses an age or a month it cannot cite.
 */

export { prorateIraDistribution, roundForm8606Ratio, type IraDistributionBasisInputs, type IraDistributionBasisResult } from './ira-basis';

export {
  EARLY_DISTRIBUTION_PENALTY_RATE,
  earlyDistributionPenalty,
  maximumSeppInterestRate,
  seppAnnualAmount,
  seppAnnualAmountFromTables,
  seppAnnuityFactors,
  seppMustContinueUntil,
  seppRateWindow,
  type EarlyDistributionException,
  type SeppEligibleRateMonth,
  type SeppInputs,
  type SeppMethod,
  type SeppRateWindow,
  type SeppTableInputs,
  type SeppTableResult,
} from './sepp';

export {
  MID_TERM_RATES,
  MID_TERM_RATE_SOURCE,
  NEWEST_MID_TERM_RATE_MONTH,
  SINGLE_LIFE_TABLE,
  SINGLE_LIFE_TABLE_OLDEST_AGE,
  SINGLE_LIFE_TABLE_SOURCE,
  SINGLE_LIFE_TABLE_TERMINAL_AGE,
  SINGLE_LIFE_TABLE_YOUNGEST_AGE,
  federalMidTermRate,
  offsetSeppRateMonth,
  parseSeppRateMonth,
  singleLifeExpectancy,
  type SeppRateMonth,
} from './sepp-tables';

export {
  ROTH_FIRST_TIME_HOMEBUYER_LIMIT,
  hasMetRothFiveYearRule,
  rothFiveYearPeriodEnd,
  rothFiveYearPeriodStart,
  rothWithdrawalTreatment,
  type RothEvent,
  type RothWithdrawalReason,
  type RothWithdrawalResult,
} from './roth-five-year';

export { QCD_BASE_LIMIT, QCD_LIMIT_YEARS, QCD_MINIMUM_AGE, qcdAnnualLimit, qualifiedCharitableDistribution, type QcdResult } from './qcd';
