import { describe, it, expect } from 'vitest';

import { buildHistoricalBacktestNotices, wrappedRangeOf, type HistoricalBacktestContextLike } from './historical-backtest-disclosure';

/** The vendored span the provider reports once a run wraps. */
const vendoredRanges = [
  { startYear: 1990, endYear: 2024 },
  { startYear: 1928, endYear: 2010 },
];

const context = (overrides: HistoricalBacktestContextLike): HistoricalBacktestContextLike => overrides;

describe('historical backtest disclosure', () => {
  it('produces nothing for a run that neither wrapped nor truncated', () => {
    expect(buildHistoricalBacktestNotices(context({ historicalRanges: [{ startYear: 1990, endYear: 2024 }] }))).toEqual([]);
    expect(buildHistoricalBacktestNotices(context({}))).toEqual([]);
    // An explicit `false` is not a wrap.
    expect(buildHistoricalBacktestNotices(context({ historicalWrapped: false }))).toEqual([]);
  });

  it('names the year a truncated run stopped at', () => {
    const notices = buildHistoricalBacktestNotices(
      context({ truncatedAtYear: 2024, historicalRanges: [{ startYear: 1990, endYear: 2024 }] })
    );

    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('truncated');
    expect(notices[0].message).toContain('stopped at 2024');
    expect(notices[0].message).toContain('2024');
    expect(notices[0].message).not.toContain('looped');
  });

  it('names the range a wrapped run looped over', () => {
    const notices = buildHistoricalBacktestNotices(context({ historicalWrapped: true, historicalRanges: vendoredRanges }));

    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe('wrapped');
    // Earliest start to latest end across the visited ranges: the vendored span.
    expect(notices[0].message).toContain('looped');
    expect(notices[0].message).toContain('1928\u20132024');
    expect(notices[0].message).not.toContain('stopped at');
  });

  it('still explains a wrap when the ranges are missing', () => {
    const notices = buildHistoricalBacktestNotices(context({ historicalWrapped: true }));

    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain('looped');
    expect(notices[0].message).not.toContain('(');
    expect(notices[0].message).not.toContain('undefined');
  });

  it('produces both sentences when both flags are present, without contradicting each other', () => {
    const notices = buildHistoricalBacktestNotices(
      context({ historicalWrapped: true, truncatedAtYear: 2024, historicalRanges: vendoredRanges })
    );

    expect(notices.map((notice) => notice.kind)).toEqual(['wrapped', 'truncated']);
    expect(notices[0].message).toContain('1928\u20132024');
    expect(notices[1].message).toContain('stopped at 2024');
    // Each sentence states its own fact; neither claims the other did not happen.
    expect(notices[0].message).not.toContain('stopped');
    expect(notices[1].message).not.toContain('looped');
  });

  it('uses plain numbers, never a formatted currency or percentage', () => {
    const notices = buildHistoricalBacktestNotices(
      context({ historicalWrapped: true, truncatedAtYear: 2011, historicalRanges: vendoredRanges })
    );

    for (const notice of notices) {
      expect(notice.message).not.toContain('$');
      expect(notice.message).not.toContain('%');
    }
  });
});

describe('wrappedRangeOf', () => {
  it('spans the earliest start and the latest end', () => {
    expect(wrappedRangeOf(vendoredRanges)).toEqual({ startYear: 1928, endYear: 2024 });
  });

  it('returns nothing when there are no ranges', () => {
    expect(wrappedRangeOf([])).toBeNull();
    expect(wrappedRangeOf(undefined)).toBeNull();
  });

  it('handles a single range', () => {
    expect(wrappedRangeOf([{ startYear: 1990, endYear: 2024 }])).toEqual({ startYear: 1990, endYear: 2024 });
  });

  it('does not mutate the ranges it reads', () => {
    const snapshot = structuredClone(vendoredRanges);
    wrappedRangeOf(vendoredRanges);
    expect(vendoredRanges).toEqual(snapshot);
  });
});
