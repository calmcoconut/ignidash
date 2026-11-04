import { describe, it, expect } from 'vitest';

import { TaxableBrokerageAccount, TaxFreeAccount } from './account';
import { createRothIraAccount, createTaxableBrokerageAccount, DEFAULT_ALLOCATION } from './__tests__/test-utils';

describe('zero-balance taxable brokerage account stays finite', () => {
  it('a zero-amount withdrawal from an empty account keeps the cost basis finite', () => {
    const account = new TaxableBrokerageAccount(createTaxableBrokerageAccount({ balance: 0, costBasis: 0 }));

    const result = account.applyWithdrawal(0, 'regular', DEFAULT_ALLOCATION);

    expect(result.realizedGains).toBe(0);
    expect(Number.isFinite(account.getCostBasis())).toBe(true);
    expect(account.getCostBasis()).toBe(0);
  });

  it('an absent cost basis on an empty account (defaults to balance 0) stays finite through a zero withdrawal', () => {
    const { costBasis: _omitted, ...data } = createTaxableBrokerageAccount({ balance: 0 });
    const account = new TaxableBrokerageAccount(data);

    const result = account.applyWithdrawal(0, 'regular', DEFAULT_ALLOCATION);

    expect(result.realizedGains).toBe(0);
    expect(Number.isFinite(account.getCostBasis())).toBe(true);
  });

  it('a positive withdrawal from an empty account is rejected and does not poison the cost basis', () => {
    const account = new TaxableBrokerageAccount(createTaxableBrokerageAccount({ balance: 0, costBasis: 0 }));

    expect(() => account.applyWithdrawal(1000, 'regular', DEFAULT_ALLOCATION)).toThrow('Insufficient funds');
    expect(Number.isFinite(account.getCostBasis())).toBe(true);
  });

  it('a zero-balance account that later receives a contribution tracks basis from there', () => {
    const account = new TaxableBrokerageAccount(createTaxableBrokerageAccount({ balance: 0, costBasis: 0 }));
    account.applyWithdrawal(0, 'regular', DEFAULT_ALLOCATION);
    account.applyContribution(10000, 'self', DEFAULT_ALLOCATION);

    const result = account.applyWithdrawal(4000, 'regular', DEFAULT_ALLOCATION);

    expect(result.realizedGains).toBe(0);
    expect(account.getCostBasis()).toBe(6000);
    expect(account.getBalance()).toBe(6000);
  });
});

describe('zero-balance Roth account stays finite', () => {
  it('a zero-amount withdrawal from an empty Roth IRA yields finite basis and no earnings', () => {
    const account = new TaxFreeAccount(createRothIraAccount({ balance: 0, contributionBasis: 0 }));

    const result = account.applyWithdrawal(0, 'regular', DEFAULT_ALLOCATION);

    expect(result.earningsWithdrawn).toBe(0);
    expect(Number.isFinite(account.getContributionBasis())).toBe(true);
  });
});
