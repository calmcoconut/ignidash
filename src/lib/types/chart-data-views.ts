/**
 * View mode enums for chart series visibility.
 *
 * The ids now live in the metric registry (`src/lib/charts/metric-registry.ts`), which
 * also maps every id onto a registry metric id. This module re-exports them explicitly
 * — one name at a time — so that:
 *
 * - every existing import path keeps working, and
 * - a persisted `dataViews` preference stays valid: the ids are only ever added to,
 *   never renamed or replaced by a generic string type.
 *
 * Ids the registry does not own yet resolve as `status: 'legacy'`; those charts still
 * render through their own switch until P4-P6 migrates them.
 */

export type {
  NetWorthDataView,
  CashFlowDataView,
  TaxesDataView,
  ReturnsDataView,
  ContributionsDataView,
  WithdrawalsDataView,
} from '@/lib/charts/metric-registry';
