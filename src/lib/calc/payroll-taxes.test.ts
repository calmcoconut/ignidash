/**
 * Payroll taxes: hand-worked fixtures, never snapshots.
 *
 * Every expected value below is arithmetic a reader can check with a calculator. The 2026 inputs
 * come from the ruleset itself:
 *
 *   OASDI (Social Security) wage base           $184,500   (SSA 2026 determination, 90 FR 49047)
 *   Employee OASDI rate                          6.2%      (IRC §3101(a))
 *   Employee Medicare rate                       1.45%     (IRC §3101(b))
 *   Additional Medicare Tax rate                 0.9%      (IRC §3101(b)(2))
 *   Additional Medicare thresholds               $200,000 single/HOH, $250,000 MFJ (not indexed)
 *   Self-employment base                         92.35% of net SE earnings (IRC §1402(a)(12))
 *   Self-employment rates                        12.4% + 2.9% (both halves, IRC §1401)
 *   SE tax deduction                              half the tax (IRC §164(f))
 *   California SDI rate, 2026                    1.3%, no wage cap (EDD; SB 951 removed the cap 2024)
 */

import { describe, it, expect } from 'vitest';

import {
  computeCaliforniaSdi,
  computeSelfEmploymentTaxes,
  computeWagePayrollTaxes,
  PayrollTaxProcessor,
  zeroWagePayrollTaxes,
} from './payroll-taxes';
import { getCaliforniaSdi, LATEST_SDI_TAX_YEAR } from './tax-data/california-sdi';
import { getRules } from './tax-data';

const TAX_YEAR = 2026;

describe('California SDI table', () => {
  it('charges 1.3% on every dollar of 2026 wages, with no wage cap', () => {
    const sdi = getCaliforniaSdi(TAX_YEAR);
    expect(sdi.values.rate).toBe(0.013);
    expect(sdi.values.wageCap).toBeNull();
    expect(sdi.resolvedYear).toBe(2026);

    // 1.3% of $500,000 is $6,500 — no cap is applied.
    expect(computeCaliforniaSdi({ wages: 500000, taxYear: TAX_YEAR })).toBeCloseTo(6500);
  });

  it('uses the published 2027 rate rather than falling back to 2026', () => {
    expect(getCaliforniaSdi(2027).values.rate).toBe(0.014);
    expect(getCaliforniaSdi(2027).resolvedYear).toBe(2027);
  });

  it('falls back to the nearest prior rate and says so', () => {
    // No 2028 rate is published yet, so a projection reuses the 2027 row and reports that.
    const future = getCaliforniaSdi(2028);
    expect(future.resolvedYear).toBe(LATEST_SDI_TAX_YEAR);
    expect(future.values.rate).toBe(getCaliforniaSdi(LATEST_SDI_TAX_YEAR).values.rate);
  });

  it('throws rather than borrowing a later rate backwards', () => {
    expect(() => getCaliforniaSdi(2023)).toThrow(/No California SDI rate for 2023/);
  });
});

describe('computeWagePayrollTaxes', () => {
  it('charges exactly at the wage base', () => {
    // $184,500 of wages, single:
    //   OASDI    = 184,500 × 6.2%  = $11,439.00   (the whole base is filled, not a dollar more)
    //   Medicare = 184,500 × 1.45% =  $2,675.25
    //   Addl.    = 0               (below the $200,000 threshold)
    //   SDI      = 184,500 × 1.3%  =  $2,398.50
    //   total                      = $16,512.75
    const taxes = computeWagePayrollTaxes({ wages: 184500, filingStatus: 'single', taxYear: TAX_YEAR });

    expect(taxes.socialSecurity).toBeCloseTo(11439);
    expect(taxes.medicare).toBeCloseTo(2675.25);
    expect(taxes.additionalMedicare).toBe(0);
    expect(taxes.stateDisability).toBeCloseTo(2398.5);
    expect(taxes.total).toBeCloseTo(16512.75);
  });

  it('stops OASDI at the wage base and starts Additional Medicare above the threshold', () => {
    // $250,000 of wages, single:
    //   OASDI    = 184,500 × 6.2%            = $11,439.00   (capped)
    //   Medicare = 250,000 × 1.45%           =  $3,625.00
    //   Addl.    = (250,000 − 200,000) × 0.9% =    $450.00
    //   SDI      = 250,000 × 1.3%            =  $3,250.00
    //   total                                = $18,764.00
    const taxes = computeWagePayrollTaxes({ wages: 250000, filingStatus: 'single', taxYear: TAX_YEAR });

    expect(taxes.socialSecurity).toBeCloseTo(11439);
    expect(taxes.medicare).toBeCloseTo(3625);
    expect(taxes.additionalMedicare).toBeCloseTo(450);
    expect(taxes.stateDisability).toBeCloseTo(3250);
    expect(taxes.total).toBeCloseTo(18764);
  });

  it('turns the Additional Medicare Tax on exactly one dollar above the threshold', () => {
    const atThreshold = computeWagePayrollTaxes({ wages: 200000, filingStatus: 'single', taxYear: TAX_YEAR });
    expect(atThreshold.additionalMedicare).toBe(0);

    // (200,001 − 200,000) × 0.9% = $0.009
    const oneDollarOver = computeWagePayrollTaxes({ wages: 200001, filingStatus: 'single', taxYear: TAX_YEAR });
    expect(oneDollarOver.additionalMedicare).toBeCloseTo(0.009);
  });

  it('uses the married-filing-jointly threshold of $250,000', () => {
    // $300,000 MFJ: (300,000 − 250,000) × 0.9% = $450.00, the same tax a single filer pays at
    // $250,000 but $50,000 of income later.
    const mfj = computeWagePayrollTaxes({ wages: 300000, filingStatus: 'marriedFilingJointly', taxYear: TAX_YEAR });
    expect(mfj.additionalMedicare).toBeCloseTo(450);

    const atThreshold = computeWagePayrollTaxes({ wages: 250000, filingStatus: 'marriedFilingJointly', taxYear: TAX_YEAR });
    expect(atThreshold.additionalMedicare).toBe(0);
  });

  it('pays nothing on zero wages', () => {
    expect(computeWagePayrollTaxes({ wages: 0, filingStatus: 'single', taxYear: TAX_YEAR })).toStrictEqual(zeroWagePayrollTaxes());
  });

  it('reads the wage base from the ruleset instead of a constant', () => {
    // The table is marked indexed, so a future year's ruleset must supply a new base. Until one
    // exists, resolution falls back to 2026 — which is the documented behaviour, not an accident.
    expect(getRules(TAX_YEAR).tables.socialSecurityWageBase.values).toBe(184500);
    expect(getRules(TAX_YEAR).tables.socialSecurityWageBase.indexing).toBe('indexed');
  });
});

describe('PayrollTaxProcessor monthly withholding', () => {
  it('fills the wage base across the year and stops withholding OASDI after it', () => {
    // $20,000 a month for 12 months = $240,000 of wages, single, 2026.
    //   Months 1-9:  20,000 × 6.2% = $1,240.00 of OASDI each (YTD reaches $180,000)
    //   Month 10:    only $4,500 of the $184,500 base is left → 4,500 × 6.2% = $279.00
    //   Months 11-12: base is full → $0.00 of OASDI
    //   OASDI total: 9 × 1,240 + 279 = $11,439.00 = 184,500 × 6.2%   ✔
    const processor = new PayrollTaxProcessor(TAX_YEAR, 'single');
    const monthly: number[] = [];
    const oasdi: number[] = [];

    for (let month = 0; month < 12; month++) {
      const taxes = processor.processMonthlyWages(20000);
      monthly.push(taxes.total);
      oasdi.push(taxes.socialSecurity);
    }

    expect(oasdi.slice(0, 9)).toEqual(new Array(9).fill(1240));
    expect(oasdi[9]).toBeCloseTo(279);
    expect(oasdi[10]).toBe(0);
    expect(oasdi[11]).toBe(0);

    const annual = processor.getAnnualData();
    expect(annual.socialSecurity).toBeCloseTo(11439);
    // Medicare is linear: 240,000 × 1.45% = $3,480.00
    expect(annual.medicare).toBeCloseTo(3480);
    // Additional Medicare starts when YTD wages pass $200,000, i.e. months 11 and 12:
    //   2 × 20,000 × 0.9% = $360.00 = (240,000 − 200,000) × 0.9%
    expect(annual.additionalMedicare).toBeCloseTo(360);
    // SDI has no cap: 240,000 × 1.3% = $3,120.00
    expect(annual.stateDisability).toBeCloseTo(3120);
    expect(annual.total).toBeCloseTo(18399);

    // The twelve monthly deductions add up to the annual function applied to the same total.
    expect(monthly.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(annual.total);
    expect(annual.total).toBeCloseTo(computeWagePayrollTaxes({ wages: 240000, filingStatus: 'single', taxYear: TAX_YEAR }).total);
  });

  it('withholds the same annual amount however the wages are spread across the year', () => {
    const even = new PayrollTaxProcessor(TAX_YEAR, 'single');
    for (let month = 0; month < 12; month++) even.processMonthlyWages(10000);

    // One December bonus on top of a smaller salary: 11 × $1,000 + $109,000 = $120,000.
    const lumpy = new PayrollTaxProcessor(TAX_YEAR, 'single');
    for (let month = 0; month < 11; month++) lumpy.processMonthlyWages(1000);
    lumpy.processMonthlyWages(109000);

    expect(lumpy.getAnnualData().total).toBeCloseTo(even.getAnnualData().total);
    expect(lumpy.getAnnualData().socialSecurity).toBeCloseTo(even.getAnnualData().socialSecurity);
  });

  it('starts a new tax year with a fresh wage base', () => {
    const processor = new PayrollTaxProcessor(TAX_YEAR, 'single');
    processor.processMonthlyWages(184500);
    expect(processor.getAnnualData().socialSecurity).toBeCloseTo(11439);

    processor.startNewYear(2027);
    expect(processor.getYearToDateWages()).toBe(0);
    expect(processor.getAnnualData()).toStrictEqual(zeroWagePayrollTaxes());

    // 2027's published SDI rate (1.4%) applies from the first 2027 paycheque.
    const january = processor.processMonthlyWages(10000);
    expect(january.socialSecurity).toBeCloseTo(620);
    expect(january.stateDisability).toBeCloseTo(140);
  });

  it('charges no payroll tax on an empty pay period', () => {
    const processor = new PayrollTaxProcessor(TAX_YEAR, 'single');
    expect(processor.processMonthlyWages(0)).toStrictEqual(zeroWagePayrollTaxes());
    expect(processor.getYearToDateWages()).toBe(0);
  });
});

describe('computeSelfEmploymentTaxes', () => {
  it('taxes 92.35% of net earnings and deducts half the tax', () => {
    // $100,000 of net self-employment earnings, single, no wages:
    //   base            = 100,000 × 92.35% = $92,350.00
    //   Social Security = 92,350 × 12.4%   = $11,451.40   (below the $184,500 wage base)
    //   Medicare        = 92,350 × 2.9%    =  $2,678.15
    //   Additional      = 0                (base below the $200,000 threshold)
    //   total                              = $14,129.55
    //   half deduction  = $7,064.775       (IRC §164(f), reduces income tax, not SE tax)
    const taxes = computeSelfEmploymentTaxes({
      netEarnings: 100000,
      wages: 0,
      filingStatus: 'single',
      taxYear: TAX_YEAR,
    });

    expect(taxes.taxableEarnings).toBeCloseTo(92350);
    expect(taxes.socialSecurity).toBeCloseTo(11451.4);
    expect(taxes.medicare).toBeCloseTo(2678.15);
    expect(taxes.additionalMedicare).toBe(0);
    expect(taxes.total).toBeCloseTo(14129.55);
    expect(taxes.halfDeduction).toBeCloseTo(7064.775);
  });

  it('shares the OASDI wage base with wages', () => {
    // $180,000 of wages leaves $4,500 of the $184,500 base; $50,000 of net SE earnings gives a
    // base of 50,000 × 92.35% = $46,175, of which only $4,500 is subject to the 12.4% share:
    //   Social Security = 4,500 × 12.4%          =   $558.00
    //   Medicare        = 46,175 × 2.9%          = $1,339.075
    //   Additional      = (180,000 + 46,175 − 200,000) × 0.9%
    //                   = 26,175 × 0.9%          =   $235.575   (all on the SE line: the wages are
    //                                              still below the $200,000 threshold)
    //   total                                    = $2,132.65, half = $1,066.325
    const taxes = computeSelfEmploymentTaxes({
      netEarnings: 50000,
      wages: 180000,
      filingStatus: 'single',
      taxYear: TAX_YEAR,
    });

    expect(taxes.taxableEarnings).toBeCloseTo(46175);
    expect(taxes.socialSecurity).toBeCloseTo(558);
    expect(taxes.medicare).toBeCloseTo(1339.075);
    expect(taxes.additionalMedicare).toBeCloseTo(235.575);
    expect(taxes.total).toBeCloseTo(2132.65);
    expect(taxes.halfDeduction).toBeCloseTo(1066.325);
  });

  it('charges no OASDI once wages have filled the base', () => {
    const taxes = computeSelfEmploymentTaxes({
      netEarnings: 50000,
      wages: 200000,
      filingStatus: 'single',
      taxYear: TAX_YEAR,
    });
    expect(taxes.socialSecurity).toBe(0);
    expect(taxes.medicare).toBeCloseTo(1339.075);
  });

  it('charges the Additional Medicare Tax on wages and SE earnings together', () => {
    // Wages $190,000, net SE $50,000 → SE base $46,175, combined compensation $236,175.
    //   excess over the $200,000 threshold = $36,175
    //   wages alone are below the threshold, so the whole excess lands on the SE line:
    //   36,175 × 0.9% = $325.575
    const seOnly = computeSelfEmploymentTaxes({
      netEarnings: 50000,
      wages: 190000,
      filingStatus: 'single',
      taxYear: TAX_YEAR,
    });
    expect(seOnly.additionalMedicare).toBeCloseTo(325.575);

    // Wages $210,000 → payroll already charged (210,000 − 200,000) × 0.9% = $90.00.
    //   combined excess = 256,175 − 200,000 = $56,175
    //   SE share        = 56,175 − 10,000 = $46,175  →  46,175 × 0.9% = $415.575
    //   together        = $505.575 = 56,175 × 0.9%   ✔
    const withWageExcess = computeSelfEmploymentTaxes({
      netEarnings: 50000,
      wages: 210000,
      filingStatus: 'single',
      taxYear: TAX_YEAR,
    });
    expect(withWageExcess.additionalMedicare).toBeCloseTo(415.575);
    expect(withWageExcess.additionalMedicare + 90).toBeCloseTo(505.575);
  });

  it('charges nothing on zero or negative net earnings', () => {
    const zero = computeSelfEmploymentTaxes({ netEarnings: 0, wages: 0, filingStatus: 'single', taxYear: TAX_YEAR });
    expect(zero.total).toBe(0);
    expect(zero.halfDeduction).toBe(0);

    const loss = computeSelfEmploymentTaxes({ netEarnings: -10000, wages: 0, filingStatus: 'single', taxYear: TAX_YEAR });
    expect(loss.total).toBe(0);
  });

  it('charges no SDI on self-employment income', () => {
    // SDI is an employee withholding: a self-employed earner pays no SDI at all. The SE line has
    // no `stateDisability` field, and the total is only the three federal shares.
    const taxes = computeSelfEmploymentTaxes({
      netEarnings: 250000,
      wages: 0,
      filingStatus: 'single',
      taxYear: TAX_YEAR,
    });
    expect(Object.keys(taxes)).not.toContain('stateDisability');
    expect(taxes.total).toBeCloseTo(taxes.socialSecurity + taxes.medicare + taxes.additionalMedicare);
    // base 230,875 → OASDI on the $184,500 base = 22,878.00; Medicare 6,695.375; addl 277.875
    expect(taxes.socialSecurity).toBeCloseTo(22878);
    expect(taxes.medicare).toBeCloseTo(6695.375);
    expect(taxes.additionalMedicare).toBeCloseTo(277.875);
  });
});
