/**
 * The SALT cap schedule (P3-P3), hand-worked against IRC §164(b)(6)-(7) as amended by P.L. 119-21
 * §70120. The statute's own amounts: $40,000 (2025), $40,400 (2026), 101% of the prior year through
 * 2029, $10,000 from 2030; the phase-down threshold is $500,000 (2025), $505,000 (2026), 101% after
 * that; the reduction is 30% of the excess and never takes the cap below $10,000.
 */

import { describe, it, expect } from 'vitest';

import { getSaltCap, LATEST_SALT_CAP_YEAR, saltCapAmountsFor, saltCapFor } from './salt-cap';

describe('SALT cap schedule', () => {
  it('names 2026 at the statute’s $40,400 with the $505,000 phase-down threshold', () => {
    const resolved = getSaltCap(2026);

    expect(resolved.values.cap).toBe(40400);
    expect(resolved.values.phaseDownThreshold).toBe(505000);
    expect(resolved.values.phaseDownRate).toBe(0.3);
    expect(resolved.values.floor).toBe(10000);
    expect(resolved.indexing).toBe('indexed');
    expect(resolved.resolvedYear).toBe(2026);
  });

  it('escalates 101% a year through 2029 and reverts to a fixed $10,000 from 2030', () => {
    expect(getSaltCap(2027).values.cap).toBeCloseTo(40804);
    expect(getSaltCap(2028).values.cap).toBeCloseTo(41212.04);
    expect(getSaltCap(2029).values.cap).toBeCloseTo(41624.1604);

    // 2030 is a *fixed* statutory $10,000 with no phase-down: an annual update must copy it forward
    // byte-identical, which is exactly what the `fixed` flag says.
    const reverted = getSaltCap(2030);
    expect(reverted.values.cap).toBe(10000);
    expect(reverted.values.phaseDownRate).toBe(0);
    expect(reverted.indexing).toBe('fixed');
    expect(LATEST_SALT_CAP_YEAR).toBe(2030);

    // A year past the last row keeps the reverted amount rather than inventing a new one.
    expect(getSaltCap(2040).values.cap).toBe(10000);
    expect(getSaltCap(2040).resolvedYear).toBe(2030);
  });

  it('applies no phase-down at or below the threshold, and 30% of the excess above it', () => {
    // 2026: MAGI 505,000 is at the threshold → the full $40,400.
    expect(saltCapFor(2026, 505000)).toMatchObject({ cap: 40400, phaseDown: 0 });
    expect(saltCapFor(2026, 500000).cap).toBeCloseTo(40400);

    // MAGI 600,000 → 40,400 − 30% × (600,000 − 505,000) = 40,400 − 28,500 = $11,900.
    const phased = saltCapFor(2026, 600000);
    expect(phased.cap).toBeCloseTo(11900);
    expect(phased.phaseDown).toBeCloseTo(28500);

    // MAGI 700,000 → 40,400 − 58,500 would be negative, so the $10,000 floor applies.
    const floored = saltCapFor(2026, 700000);
    expect(floored.cap).toBe(10000);
    expect(floored.phaseDown).toBeCloseTo(30400);
  });

  it('refuses a year before the schedule rather than borrowing a later cap', () => {
    expect(() => getSaltCap(2024)).toThrow(/No SALT cap for 2024/);
  });
});

/**
 * IRC §164(b)(7): a married-filing-separately return gets half the joint cap. The statute halves
 * the cap *and* the phase-down threshold but NOT the floor — and that unhalved floor is the whole
 * reason a separate return cannot sink below a joint one. Pinned here because `saltCapAmountsFor`
 * had no test at all and nothing exercised the `marriedFilingSeparately` branch.
 */
describe('SALT cap on a separate return (IRC §164(b)(7))', () => {
  it('halves the cap and threshold but keeps the $10,000 floor unhalved', () => {
    const resolved = getSaltCap(2026);

    expect(saltCapAmountsFor(resolved.values, 'marriedFilingJointly')).toEqual({
      cap: 40400,
      phaseDownThreshold: 505000,
      floor: 10000,
    });
    expect(saltCapAmountsFor(resolved.values, 'marriedFilingSeparately')).toEqual({
      cap: 20200,
      phaseDownThreshold: 252500,
      floor: 10000,
    });
  });

  it('phases a separate return down from its own halved threshold and floors it at $10,000', () => {
    // MAGI 252,500 is exactly the separate threshold → the full halved $20,200.
    expect(saltCapFor(2026, 252500, 'marriedFilingSeparately').cap).toBeCloseTo(20200);

    // MAGI 300,000 → 20,200 − 30% × (300,000 − 252,500) = 20,200 − 14,250 = $5,950, floored to
    // $10,000. `phaseDown` reports the *effective* reduction (cap − allowed), not the raw $14,250.
    // Had the floor been halved along with the cap, the clamp would sit at $5,000 and the cap would
    // fall to $5,950 — so the `cap` assertion below is what makes that regression visible.
    const floored = saltCapFor(2026, 300000, 'marriedFilingSeparately');
    expect(floored.phaseDown).toBeCloseTo(10200);
    expect(floored.cap).toBe(10000);
  });
});
