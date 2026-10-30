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
 */

export { prorateIraDistribution, roundForm8606Ratio, type IraDistributionBasisInputs, type IraDistributionBasisResult } from './ira-basis';

export {
  EARLY_DISTRIBUTION_PENALTY_RATE,
  earlyDistributionPenalty,
  maximumSeppInterestRate,
  seppAnnualAmount,
  seppAnnuityFactors,
  seppMustContinueUntil,
  type EarlyDistributionException,
  type SeppInputs,
  type SeppMethod,
} from './sepp';

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
