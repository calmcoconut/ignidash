'use client';

import { XCircleIcon } from '@heroicons/react/20/solid';

import { cn } from '@/lib/utils';
import type { ImportIssue } from '@/lib/export/plan-envelope';

interface ImportIssuesProps {
  issues: ImportIssue[] | null;
  title?: string;
  className?: string;
}

/**
 * Renders every import problem with the field path that failed.
 *
 * This replaces the old "truncate the message at 250 characters" behaviour: a
 * malformed file now lists each failing field (`plan.incomes[0].name`) instead of
 * showing the first part of one long string.
 */
export default function ImportIssues({ issues, title = 'This file could not be imported', className }: ImportIssuesProps) {
  if (!issues || issues.length === 0) return null;

  return (
    <div role="alert" className={cn('rounded-md bg-red-100 p-4 dark:bg-red-500/15 dark:outline dark:outline-red-500/25', className)}>
      <div className="flex">
        <div className="shrink-0">
          <XCircleIcon aria-hidden="true" className="size-5 text-red-400" />
        </div>
        <div className="ml-3 space-y-2">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">{title}</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-200">
            {issues.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                {issue.path ? (
                  <>
                    <code className="font-mono text-xs break-all">{issue.path}</code>
                    {': '}
                  </>
                ) : null}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
