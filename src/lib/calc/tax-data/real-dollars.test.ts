/**
 * The real-dollar accessor (parity plan R2).
 *
 * A ruleset's amounts are nominal. An `indexed` table is re-issued every year with CPI-adjusted
 * amounts, so in today's dollars it is constant; a `fixed` table is statute-locked, so in today's
 * dollars it shrinks. Reading a fixed table raw is the same as assuming its threshold rises with
 * inflation forever — the bug this module closes.
 *
 * These tests pin the *mechanism*: which fields move, which never do, and that nothing moves at
 * 0% inflation. The engine-level consequence is pinned in `../inflation-indexing.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { realDollarDivisor, tableValuesInRealDollars, type RealDollarContext } from './real-dollars';
import type { TableMeta } from './types';

/** 3% inflation, `years` after the ruleset year. */
const atThreePercent = (rulesetYear: number, simYear: number): RealDollarContext => ({
  rulesetYear,
  simYear,
  cumulativeInflationIndex: (years) => Math.pow(1.03, years),
});

const divisorAfter31Years = Math.pow(1.03, 31);

describe('real-dollar accessor', () => {
  describe('which tables move', () => {
    it('returns an indexed table by identity, whatever the year', () => {
      const table: TableMeta<{ single: number }> = {
        values: { single: 12400 },
        indexing: 'indexed',
        source: 'test',
      };

      expect(tableValuesInRealDollars(table, atThreePercent(2026, 2057))).toBe(table.values);
      expect(realDollarDivisor(table, atThreePercent(2026, 2057))).toBe(1);
    });

    it('returns a fixed table by identity in its own ruleset year', () => {
      const table: TableMeta<{ single: number }> = {
        values: { single: 25000 },
        indexing: 'fixed',
        dollarFields: ['$'],
        source: 'test',
      };

      expect(tableValuesInRealDollars(table, atThreePercent(2026, 2026))).toBe(table.values);
    });

    it('returns a fixed table by identity at 0% inflation, so a no-inflation plan cannot move', () => {
      const table: TableMeta<{ single: number }> = {
        values: { single: 25000 },
        indexing: 'fixed',
        dollarFields: ['$'],
        source: 'test',
      };

      const zeroInflation: RealDollarContext = {
        rulesetYear: 2026,
        simYear: 2057,
        cumulativeInflationIndex: (years) => Math.pow(1, years),
      };

      expect(tableValuesInRealDollars(table, zeroInflation)).toBe(table.values);
      expect(realDollarDivisor(table, zeroInflation)).toBe(1);
    });
  });

  describe('which fields move', () => {
    it('deflates a named field and leaves a sibling rate alone (NIIT)', () => {
      const table: TableMeta<{ rate: number; thresholds: Record<'a' | 'b', number> }> = {
        values: { rate: 0.038, thresholds: { a: 200000, b: 250000 } },
        indexing: 'fixed',
        dollarFields: ['thresholds'],
        source: 'test',
      };

      const scaled = tableValuesInRealDollars(table, atThreePercent(2026, 2057));

      expect(scaled.rate).toBe(0.038);
      expect(scaled.thresholds.a).toBeCloseTo(200000 / divisorAfter31Years, 6);
      expect(scaled.thresholds.b).toBeCloseTo(250000 / divisorAfter31Years, 6);
    });

    it('deflates tier bounds but not the tier percentage (§86)', () => {
      const table: TableMeta<{
        tiers: Record<'single', readonly { min: number; max: number; taxablePercentage: number }[]>;
        taxableFromFirstDollar: Record<'single', boolean>;
      }> = {
        values: {
          tiers: {
            single: [
              { min: 0, max: 25000, taxablePercentage: 0 },
              { min: 25000, max: 34000, taxablePercentage: 0.5 },
              { min: 34000, max: Infinity, taxablePercentage: 0.85 },
            ],
          },
          taxableFromFirstDollar: { single: false },
        },
        indexing: 'fixed',
        dollarFields: ['tiers.min', 'tiers.max'],
        source: 'test',
      };

      const scaled = tableValuesInRealDollars(table, atThreePercent(2026, 2057));
      const [first, second, third] = scaled.tiers.single;

      expect(first.max).toBeCloseTo(25000 / divisorAfter31Years, 6);
      expect(second.min).toBeCloseTo(25000 / divisorAfter31Years, 6);
      expect(second.max).toBeCloseTo(34000 / divisorAfter31Years, 6);
      expect(third.max).toBe(Infinity);
      // The §86 shares are not money: 50% is 50% in every year.
      expect(second.taxablePercentage).toBe(0.5);
      expect(third.taxablePercentage).toBe(0.85);
      // Non-dollar metadata survives the copy.
      expect(scaled.taxableFromFirstDollar.single).toBe(false);
    });

    it('leaves a rates-only table untouched even when it is fixed', () => {
      const values = { socialSecurity: 0.062, medicare: 0.0145 };
      const table: TableMeta<typeof values> = {
        values,
        indexing: 'fixed',
        dollarFields: [],
        source: 'test',
      };

      // By identity, not merely equal: with no dollar fields there is nothing to walk, so the same
      // object comes back even though the table is `fixed` and the year differs.
      expect(tableValuesInRealDollars(table, atThreePercent(2026, 2057))).toBe(values);
    });

    it('leaves a rate nested beside dollars alone (senior deduction)', () => {
      const table: TableMeta<{ perIndividual: number; phaseOutRate: number; lastTaxYear: number }> = {
        values: { perIndividual: 6000, phaseOutRate: 0.06, lastTaxYear: 2028 },
        indexing: 'fixed',
        dollarFields: ['perIndividual'],
        source: 'test',
      };

      const scaled = tableValuesInRealDollars(table, atThreePercent(2026, 2057));

      expect(scaled.perIndividual).toBeCloseTo(6000 / divisorAfter31Years, 6);
      expect(scaled.phaseOutRate).toBe(0.06);
      expect(scaled.lastTaxYear).toBe(2028);
    });
  });

  describe('refusals', () => {
    it('throws rather than deflate a fixed table that does not say which fields are dollars', () => {
      const table: TableMeta<{ cap: number }> = { values: { cap: 1 }, indexing: 'fixed', source: 'test' };

      expect(() => tableValuesInRealDollars(table, atThreePercent(2026, 2057))).toThrow(/dollarFields/);
    });

    it('throws on a path that does not resolve, instead of silently deflating nothing', () => {
      const table: TableMeta<{ cap: number }> = {
        values: { cap: 1 },
        indexing: 'fixed',
        dollarFields: ['threshold'],
        source: 'test',
      };

      expect(() => tableValuesInRealDollars(table, atThreePercent(2026, 2057))).toThrow(/cannot be resolved/);
    });

    it('refuses to combine the whole-value marker with another path', () => {
      const table: TableMeta<{ a: number; b: number }> = {
        values: { a: 1, b: 2 },
        indexing: 'fixed',
        dollarFields: ['$', 'a'],
        source: 'test',
      };

      expect(() => tableValuesInRealDollars(table, atThreePercent(2026, 2057))).toThrow(/deflate the same dollars twice/);
    });
  });
});
