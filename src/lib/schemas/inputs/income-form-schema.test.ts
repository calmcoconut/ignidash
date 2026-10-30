import { describe, it, expect } from 'vitest';
import { incomeFormSchema, supportsWithholding, defaultWithholding } from './income-form-schema';
import type { IncomeType } from './income-form-schema';

const ALL_INCOME_TYPES: IncomeType[] = ['wage', 'socialSecurity', 'exempt', 'selfEmployment', 'pension'];

describe('supportsWithholding', () => {
  it('should return true for wage and socialSecurity', () => {
    expect(supportsWithholding('wage')).toBe(true);
    expect(supportsWithholding('socialSecurity')).toBe(true);
  });

  it('should return false for other types', () => {
    expect(supportsWithholding('exempt')).toBe(false);
    expect(supportsWithholding('selfEmployment')).toBe(false);
    expect(supportsWithholding('pension')).toBe(false);
  });
});

describe('defaultWithholding', () => {
  it('should return 20 for wage', () => {
    expect(defaultWithholding('wage')).toBe(20);
  });

  it('should return 0 for socialSecurity', () => {
    expect(defaultWithholding('socialSecurity')).toBe(0);
  });

  it('should return undefined for types without withholding', () => {
    expect(defaultWithholding('exempt')).toBeUndefined();
    expect(defaultWithholding('selfEmployment')).toBeUndefined();
    expect(defaultWithholding('pension')).toBeUndefined();
  });

  it('should cover all income types', () => {
    for (const type of ALL_INCOME_TYPES) {
      const result = defaultWithholding(type);
      expect(result === undefined || typeof result === 'number').toBe(true);
    }
  });
});

const validIncome = {
  id: 'test-id',
  name: 'Salary',
  amount: 85000,
  frequency: 'yearly' as const,
  timeframe: {
    start: { type: 'now' as const },
    end: { type: 'atRetirement' as const },
  },
  taxes: { incomeType: 'wage' as const, withholding: 20 },
};

describe('incomeFormSchema', () => {
  it('should accept valid wage income with withholding', () => {
    expect(incomeFormSchema.safeParse(validIncome).success).toBe(true);
  });

  it('should accept exempt income without withholding', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      taxes: { incomeType: 'exempt' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept socialSecurity with valid withholding rate', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      taxes: { incomeType: 'socialSecurity', withholding: 7 },
    });
    expect(result.success).toBe(true);
  });

  it('should coerce string amount', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      amount: '85000',
    });
    expect(result.success).toBe(true);
  });

  it('should reject wage income without withholding', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      taxes: { incomeType: 'wage' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject socialSecurity with invalid withholding rate', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      taxes: { incomeType: 'socialSecurity', withholding: 15 },
    });
    expect(result.success).toBe(false);
  });

  it('should accept selfEmployment income (P3-P4: the gate is gone)', () => {
    // Self-employment income was rejected between Wave 0 and P3-P4 because the engine had no
    // self-employment tax: it would have been taxed as an ordinary wage and under-taxed by ~15.3%.
    // The tax now exists (`computeSelfEmploymentTaxes`), so the form accepts it and charges no
    // withholding (nothing is withheld from a self-employed paycheque — the SE tax is annual).
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      amount: 50000,
      taxes: { incomeType: 'selfEmployment' },
    });
    expect(result.success).toBe(true);
  });

  it('should accept pension income without withholding', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      taxes: { incomeType: 'pension' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject pension income that sets a withholding rate beyond the allowed range', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      taxes: { incomeType: 'pension', withholding: 75 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject positive growth rate with growthLimit <= amount', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      growth: { growthRate: 3, growthLimit: 50000 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative growth rate with growthLimit >= amount', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      growth: { growthRate: -3, growthLimit: 90000 },
    });
    expect(result.success).toBe(false);
  });

  it('should accept growth with no growthLimit', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      growth: { growthRate: 3 },
    });
    expect(result.success).toBe(true);
  });

  it('should reject growthLimit set without growthRate', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      growth: { growthLimit: 100000 },
    });
    expect(result.success).toBe(false);
  });

  it('should reject amount = 0', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      amount: 0,
    });
    expect(result.success).toBe(false);
  });

  it('should reject empty string amount', () => {
    const result = incomeFormSchema.safeParse({
      ...validIncome,
      amount: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('socialSecurity block (P1-P8)', () => {
  it('is optional, so every income written before it existed still validates', () => {
    const result = incomeFormSchema.safeParse({ ...validIncome });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.socialSecurity).toBeUndefined();
  });

  it('accepts a manual PIA and an estimated AIME', () => {
    const manual = incomeFormSchema.safeParse({
      ...validIncome,
      socialSecurity: { mode: 'manual', pia: 2400, claimAge: 67, colaRate: 3 },
    });
    expect(manual.success, JSON.stringify(manual.error?.issues)).toBe(true);

    const estimated = incomeFormSchema.safeParse({
      ...validIncome,
      socialSecurity: { mode: 'estimated', aime: 6000, claimAge: 70 },
    });
    expect(estimated.success, JSON.stringify(estimated.error?.issues)).toBe(true);
  });

  it('requires the amount the mode reads', () => {
    const missingPia = incomeFormSchema.safeParse({ ...validIncome, socialSecurity: { mode: 'manual', claimAge: 67 } });
    expect(missingPia.success).toBe(false);
    if (!missingPia.success) expect(missingPia.error.issues[0].path).toEqual(['socialSecurity', 'pia']);

    const missingAime = incomeFormSchema.safeParse({ ...validIncome, socialSecurity: { mode: 'estimated', claimAge: 67 } });
    expect(missingAime.success).toBe(false);
    if (!missingAime.success) expect(missingAime.error.issues[0].path).toEqual(['socialSecurity', 'aime']);
  });

  it('keeps the claim age inside the statutory 62–70 window', () => {
    for (const claimAge of [61, 71, 67.5]) {
      const result = incomeFormSchema.safeParse({ ...validIncome, socialSecurity: { mode: 'manual', pia: 2000, claimAge } });
      expect(result.success, String(claimAge)).toBe(false);
    }

    for (const claimAge of [62, 67, 70]) {
      const result = incomeFormSchema.safeParse({ ...validIncome, socialSecurity: { mode: 'manual', pia: 2000, claimAge } });
      expect(result.success, String(claimAge)).toBe(true);
    }
  });

  it('rejects an unknown mode', () => {
    const result = incomeFormSchema.safeParse({ ...validIncome, socialSecurity: { mode: 'guessed', pia: 2000, claimAge: 67 } });
    expect(result.success).toBe(false);
  });
});
