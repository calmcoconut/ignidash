/**
 * Chart mapping for the actual-vs-projected net-worth overlay (P4-P7).
 *
 * `buildNetWorthOverlay` already aligned the journal to the projection and decided what can be
 * plotted; this module only re-shapes that result for Recharts. It is pure on purpose, so the one
 * thing the DOM cannot test — that a marker sits at a fractional interpolated age — is decided
 * here and pinned by tests. No currency formatting happens here either: the axes and tooltips
 * format, this layer carries numbers and labels.
 *
 * Two shapes matter downstream:
 *
 * - ROWS feed the band and the projection line. The band is drawn as two stacked areas, so each
 *   row carries `lower` and the `bandWidth` above it (`upper - lower`), plus the line's own
 *   `projectedNetWorth`. An invisible `lower` area plus a filled `bandWidth` area stack back to
 *   exactly `upper`, which keeps the band correct even where net worth is negative.
 * - MARKERS feed a numeric-axis Scatter, because their `age` is fractional. A categorical axis
 *   (the `<XAxis dataKey="age">` the other charts use) cannot place them, and it fails silently.
 *
 * ONE DATASET, not two. `toOverlayPlotPoints` merges the band rows and the markers into the single
 * array the chart passes to Recharts. This is not a stylistic choice: when any graphical item
 * carries its own `data` prop (a Scatter of markers, say), Recharts derives BOTH the axis domain
 * and the tooltip ticks from that item's data alone and ignores the chart-level data. The band
 * would then be clipped to the span of the journal entries and hovered only near them — again
 * silently. Merging keeps one axis, one tick per point, and matching tooltip indexes.
 */

import type { JournalDatePrecision, NetWorthOverlay } from './net-worth-journal';

/** Which side of the plan an actual landed on. `on-plan` is an exact match. */
export type OverlayMarkerSign = 'ahead' | 'behind' | 'on-plan';

/** One row of the projection band and line. */
export interface NetWorthOverlayChartRow {
  readonly age: number;
  /** Canonical `YYYY-MM-DD` projection date. */
  readonly date: string;
  /** Bottom of the tolerance band. */
  readonly lower: number;
  /** Band height above `lower`; stacked on top of it, so `lower + bandWidth === upper`. */
  readonly bandWidth: number;
  /** Top of the tolerance band. */
  readonly upper: number;
  /** The projection itself, drawn as a line through the band. */
  readonly projectedNetWorth: number;
}

/** One recorded actual, plotted at its interpolated age. */
export interface NetWorthOverlayChartMarker {
  /** Journal entry the marker came from; also a stable React key. */
  readonly entryId: string;
  /** Fractional interpolated age, which is why the chart needs a numeric axis. */
  readonly age: number;
  /** The date as the user recorded it ("2026", "2026-09", "2026-09-15"), at that precision. */
  readonly dateLabel: string;
  readonly actualNetWorth: number;
  readonly projectedNetWorth: number;
  /** `actual - projected`; positive is ahead of the plan. */
  readonly deviation: number;
  readonly sign: OverlayMarkerSign;
}

/** An entry the chart could not plot, shaped for `quiet-notice.tsx`. */
export interface NetWorthOverlayChartIssue {
  readonly id: string;
  readonly message: string;
}

/**
 * One row of the single array the chart hands to Recharts: a band point, optionally carrying the
 * recorded actual at the same age. The band fields are always present because a marker age is
 * inserted as its own row; they are interpolated between the bracketing projection rows so the
 * stacked band and the line keep their exact shape through it.
 */
export interface NetWorthOverlayPlotPoint extends NetWorthOverlayChartRow {
  readonly actualNetWorth?: number;
  readonly dateLabel?: string;
  readonly deviation?: number;
  readonly sign?: OverlayMarkerSign;
  readonly entryId?: string;
}

export interface NetWorthOverlayChartData {
  /** Band and projection rows, oldest first. */
  readonly rows: NetWorthOverlayChartRow[];
  /** Actuals, oldest first. */
  readonly markers: NetWorthOverlayChartMarker[];
  /** Entries that were deliberately not plotted, so the omission is never silent. */
  readonly issues: NetWorthOverlayChartIssue[];
  /** Whether there is a projection to draw at all. */
  readonly hasSeries: boolean;
}

/**
 * Rebuilds the date label from the precision the entry was recorded at.
 *
 * The overlay point carries the canonical end-of-period date plus `precision`, not the raw
 * input, so a year recorded as "2026" must not surface as "2026-12-31".
 *
 * @param date - Canonical end-of-period date (`YYYY-MM-DD`)
 * @param precision - How much of the date was recorded
 * @returns The label at the recorded precision
 */
export function overlayDateLabel(date: string, precision: JournalDatePrecision): string {
  switch (precision) {
    case 'year':
      return date.slice(0, 4);
    case 'month':
      return date.slice(0, 7);
    case 'day':
      return date.slice(0, 10);
  }
}

/**
 * The arithmetic side of the plan an actual landed on. The tolerance band is drawn around the
 * projection separately; this is only the sign of `actual - projected`.
 *
 * @param deviation - `actual - projected`
 * @returns `ahead` when positive, `behind` when negative, `on-plan` when exactly equal
 */
export function overlayMarkerSign(deviation: number): OverlayMarkerSign {
  if (deviation > 0) return 'ahead';
  if (deviation < 0) return 'behind';
  return 'on-plan';
}

/**
 * Re-shapes an overlay into chart rows, markers and notices.
 *
 * @param overlay - Result of `buildNetWorthOverlay`
 * @returns Chart data; an empty overlay yields empty arrays and `hasSeries: false`
 */
export function toOverlayChartData(overlay: NetWorthOverlay): NetWorthOverlayChartData {
  const rows = overlay.band.map((point) => ({
    age: point.age,
    date: point.date,
    lower: point.lower,
    bandWidth: point.upper - point.lower,
    upper: point.upper,
    projectedNetWorth: point.projectedNetWorth,
  }));

  const markers = overlay.points.map((point) => ({
    entryId: point.entryId,
    age: point.age,
    dateLabel: overlayDateLabel(point.date, point.precision),
    actualNetWorth: point.actualNetWorth,
    projectedNetWorth: point.projectedNetWorth,
    deviation: point.deviation,
    sign: overlayMarkerSign(point.deviation),
  }));

  const issues = overlay.issues.map((issue) => ({ id: `${issue.entryId}:${issue.reason}`, message: issue.message }));

  return { rows, markers, issues, hasSeries: rows.length > 0 };
}

/** Ages closer than this are treated as the same x value, so a marker and a row merge. */
const AGE_EPSILON = 1e-9;

/** The band and line values at an age, interpolated between the two bracketing projection rows. */
const bandAtAge = (rows: readonly NetWorthOverlayChartRow[], age: number): Omit<NetWorthOverlayChartRow, 'age'> => {
  const before = rows.filter((row) => row.age <= age).at(-1) ?? rows[0];
  const after = rows.find((row) => row.age >= age) ?? rows[rows.length - 1];

  if (before.age === after.age) return before;

  const weight = (age - before.age) / (after.age - before.age);

  return {
    date: before.date,
    lower: before.lower + weight * (after.lower - before.lower),
    bandWidth: before.bandWidth + weight * (after.bandWidth - before.bandWidth),
    upper: before.upper + weight * (after.upper - before.upper),
    projectedNetWorth: before.projectedNetWorth + weight * (after.projectedNetWorth - before.projectedNetWorth),
  };
};

/**
 * Merges the band rows and the actuals into the single dataset the chart renders.
 *
 * A marker becomes its own row, at its fractional age, with the band and line values interpolated
 * between the rows that bracket it (they lie exactly on the drawn segments, so the band's shape is
 * unchanged). A marker that lands on a projection row is attached to that row instead of adding a
 * duplicate x value.
 *
 * @param rows - Band rows from `toOverlayChartData`
 * @param markers - Markers from `toOverlayChartData`
 * @returns One point per projection row plus one per off-row marker, sorted by age
 */
export function toOverlayPlotPoints(
  rows: readonly NetWorthOverlayChartRow[],
  markers: readonly NetWorthOverlayChartMarker[]
): NetWorthOverlayPlotPoint[] {
  if (rows.length === 0) return [];

  const points: NetWorthOverlayPlotPoint[] = rows.map((row) => ({ ...row }));

  for (const marker of markers) {
    const markerFields = {
      actualNetWorth: marker.actualNetWorth,
      dateLabel: marker.dateLabel,
      deviation: marker.deviation,
      sign: marker.sign,
      entryId: marker.entryId,
    };
    const existing = points.findIndex((point) => Math.abs(point.age - marker.age) <= AGE_EPSILON);

    if (existing >= 0) {
      points[existing] = { ...points[existing], ...markerFields };
    } else {
      points.push({ age: marker.age, ...bandAtAge(rows, marker.age), ...markerFields });
    }
  }

  return points.sort((a, b) => a.age - b.age || (a.entryId ?? '').localeCompare(b.entryId ?? ''));
}
