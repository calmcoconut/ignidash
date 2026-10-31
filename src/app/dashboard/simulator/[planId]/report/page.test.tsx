// @vitest-environment jsdom
/**
 * The print-friendly report route (P4-P5).
 *
 * The page's whole job is to wait for the plan and hand it to the report view; the view is stubbed
 * here so the test is about the wiring, not the layout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { SimulatorInputs } from '@/lib/schemas/inputs/simulator-schema';

const { pageState, viewProps } = vi.hoisted(() => ({
  pageState: {} as {
    planData: { data: SimulatorInputs | null; isLoading: boolean };
    planName: { name: string | undefined; isLoading: boolean };
  },
  viewProps: [] as Array<{ inputs: SimulatorInputs; planName: string }>,
}));

vi.mock('@/hooks/use-convex-data', () => ({
  usePlanData: () => pageState.planData,
  usePlanName: () => pageState.planName,
}));
vi.mock('./components/plan-report-view', () => ({
  default: ({ inputs, planName }: { inputs: SimulatorInputs; planName: string }) => {
    viewProps.push({ inputs, planName });
    return <p>{`report for ${planName}`}</p>;
  },
}));

import PlanReportPage from './page';

const inputs = { timeline: { birthYear: 1990 } } as unknown as SimulatorInputs;

beforeEach(() => {
  pageState.planData = { data: inputs, isLoading: false };
  pageState.planName = { name: 'Retire early', isLoading: false };
  viewProps.length = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the report route', () => {
  it('waits for the plan data before rendering the report', () => {
    pageState.planData = { data: null, isLoading: true };
    render(<PlanReportPage />);

    expect(screen.getByRole('status').textContent).toContain('Preparing report');
    expect(viewProps).toHaveLength(0);
  });

  it('waits for the plan name too', () => {
    pageState.planName = { name: undefined, isLoading: true };
    render(<PlanReportPage />);

    expect(screen.getByRole('status').textContent).toContain('Preparing report');
    expect(viewProps).toHaveLength(0);
  });

  it('says so when there is no plan to report', () => {
    pageState.planData = { data: null, isLoading: false };
    render(<PlanReportPage />);

    expect(screen.getByRole('status').textContent).toContain('No plan data to report');
    expect(viewProps).toHaveLength(0);
  });

  it('hands the plan and its name to the report view', () => {
    render(<PlanReportPage />);

    expect(viewProps).toStrictEqual([{ inputs, planName: 'Retire early' }]);
    expect(screen.getByText('report for Retire early')).toBeTruthy();
  });

  it('falls back to a neutral name when the plan has none', () => {
    pageState.planName = { name: undefined, isLoading: false };
    render(<PlanReportPage />);

    expect(viewProps[0].planName).toBe('Plan');
  });
});
