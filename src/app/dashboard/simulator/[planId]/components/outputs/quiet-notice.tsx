'use client';

import { cn } from '@/lib/utils';

/** One quiet explanation to render. `id` must be stable and unique within the list. */
export interface QuietNoticeItem {
  readonly id: string;
  readonly message: string;
}

interface QuietNoticeProps {
  notices: readonly QuietNoticeItem[];
  className?: string;
}

/**
 * Quiet explanation of something the results surface did NOT show (display only).
 *
 * Styled like the results page's disclaimer box — muted, bordered, small text — because this is
 * an explanation, not an alert. Two callers share it: a historical run that wrapped or truncated,
 * and journal entries the net-worth overlay deliberately did not plot, so an omission is never
 * silent. Renders nothing when there is nothing to say, so a normal surface is unchanged.
 */
export default function QuietNotice({ notices, className }: QuietNoticeProps) {
  if (notices.length === 0) return null;

  return (
    <div
      role="status"
      className={cn('border-border/25 bg-emphasized-background/50 mb-2 flex flex-col gap-1 rounded-md border p-2', className)}
    >
      {notices.map((notice) => (
        <p key={notice.id} className="text-muted-foreground text-xs/6">
          {notice.message}
        </p>
      ))}
    </div>
  );
}
