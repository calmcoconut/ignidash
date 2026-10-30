'use client';

import Card from '@/components/ui/card';
import { Subheading } from '@/components/catalyst/heading';
import { cn } from '@/lib/utils';
import { resolveChartCardBody } from '@/lib/charts/metric-table';

/** The two ways a chart card can present a ported metric. */
export type ChartCardView = 'chart' | 'table';

const VIEW_OPTIONS: ReadonlyArray<{ value: ChartCardView; label: string }> = [
  { value: 'chart', label: 'Chart' },
  { value: 'table', label: 'Table' },
];

/**
 * Controlled chart/table toggle (P4-P2).
 *
 * Styled like the existing `TableTypeSelector` pills so the two selectors read the same.
 * It is controlled on purpose: the card owns the state, so the toggle can disappear (and
 * the view fall back to the chart) when the selected view has no registry metric.
 */
function ChartViewToggle({ view, onViewChange }: { view: ChartCardView; onViewChange: (view: ChartCardView) => void }) {
  return (
    <div role="group" aria-label="Chart or table view" className="isolate flex gap-x-1">
      {VIEW_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={view === option.value}
          onClick={() => onViewChange(option.value)}
          className={cn(
            'text-muted-foreground bg-background hover:bg-emphasized-background focus-outline border-border/25 relative inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold focus:z-10',
            { 'text-foreground bg-emphasized-background': view === option.value }
          )}
        >
          <span className="whitespace-nowrap">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

interface ChartCardProps {
  title: string;
  subtitle: string;
  truncateTitle?: boolean;
  className?: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Active presentation. Only meaningful together with `onViewChange`; defaults to the
   * chart, so every card that does not opt in renders exactly as before.
   */
  view?: ChartCardView;
  /** Supplying this renders the chart/table toggle in the card header. */
  onViewChange?: (view: ChartCardView) => void;
  /** Rendered instead of `children` while the table view is active. */
  table?: React.ReactNode;
}

export default function ChartCard({
  title,
  subtitle,
  truncateTitle,
  className = 'my-0',
  controls,
  children,
  view = 'chart',
  onViewChange,
  table,
}: ChartCardProps) {
  // A table view needs both the selection AND a table node; see `resolveChartCardBody`.
  const bodyView = resolveChartCardBody(view, table);
  // Same truthiness test the card used before the toggle existed, so a card that passes
  // no controls still renders no controls wrapper.
  const showControls = Boolean(controls) || onViewChange !== undefined;

  return (
    <Card className={className}>
      {/* The header carries the title plus up to three controls (toggle, select, icon
          button). Wrapping keeps a narrow card from clipping them inside `overflow-hidden`
          at ~375px, where title + controls exceed the card width. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-y-2">
        <Subheading level={3} className={truncateTitle ? 'truncate' : undefined}>
          <span className="mr-2">{title}</span>
          <span className="text-muted-foreground hidden sm:inline">{subtitle}</span>
        </Subheading>
        {showControls && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {onViewChange && <ChartViewToggle view={bodyView} onViewChange={onViewChange} />}
            {controls}
          </div>
        )}
      </div>
      {bodyView === 'table' ? table : children}
    </Card>
  );
}
