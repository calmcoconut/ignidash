'use client';

import { cn } from '@/lib/utils';
import type { HistoricalBacktestNotice as HistoricalBacktestNoticeModel } from '@/lib/utils/historical-backtest-disclosure';

interface HistoricalBacktestNoticeProps {
  notices: readonly HistoricalBacktestNoticeModel[];
  className?: string;
}

/**
 * Quiet explanation of a historical run that wrapped or truncated (display only).
 *
 * Styled like the results page's disclaimer box — muted, bordered, small text — because this is
 * an explanation of what the backtest did, not an alert. Renders nothing when a run neither
 * wrapped nor truncated, so a normal run's surface is unchanged.
 */
export default function HistoricalBacktestNotice({ notices, className }: HistoricalBacktestNoticeProps) {
  if (notices.length === 0) return null;

  return (
    <div
      role="status"
      className={cn('border-border/25 bg-emphasized-background/50 mb-2 flex flex-col gap-1 rounded-md border p-2', className)}
    >
      {notices.map((notice) => (
        <p key={notice.kind} className="text-muted-foreground text-xs/6">
          {notice.message}
        </p>
      ))}
    </div>
  );
}
