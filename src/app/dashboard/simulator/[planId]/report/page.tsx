'use client';

import { usePlanData, usePlanName } from '@/hooks/use-convex-data';
import PageLoading from '@/components/ui/page-loading';

import PlanReportView from './components/plan-report-view';

/**
 * Print-friendly report route (P4-P5): `/dashboard/simulator/<planId>/report`.
 *
 * A page, not a PDF endpoint — the operator opens it and uses the browser's print-to-PDF.
 * That keeps the "no server rendering, no PDF library" boundary: the numbers are the same
 * client-side simulation the results page runs.
 */
export default function PlanReportPage() {
  const { data: inputs, isLoading: inputsAreLoading } = usePlanData();
  const { name: planName, isLoading: planNameIsLoading } = usePlanName();

  if (inputsAreLoading || planNameIsLoading) return <PageLoading message="Preparing report" />;
  if (!inputs) return <PageLoading message="No plan data to report" />;

  return <PlanReportView inputs={inputs} planName={planName ?? 'Plan'} />;
}
