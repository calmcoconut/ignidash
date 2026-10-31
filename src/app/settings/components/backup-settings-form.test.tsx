// @vitest-environment jsdom
/**
 * Render smoke test for the Backup & restore card on the settings page.
 *
 * The bug this pins: Headless UI 2.2.9 resolves a `<Description>` only through a `<Field>` parent.
 * Placed directly inside a bare `<Fieldset>` it throws at render time ("You used a <Description />
 * component, but it is not inside a relevant parent"), which takes the whole settings page down —
 * and with it the operator's restore drill (`scripts/backup.sh` / `scripts/restore.sh`). The shape
 * looked correct in JSX, so this test renders the component rather than inspecting it.
 *
 * Convex is mocked at the hook, the way every component test in this repo mocks it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { queries, createPlan, replaceFinances } = vi.hoisted(() => ({
  queries: {
    'plans:listPlans': [{ _id: 'plan-1', name: 'Retirement', isDefault: true }],
    'finances:getAssets': [],
    'finances:getLiabilities': [],
  } as Record<string, unknown>,
  createPlan: vi.fn(),
  replaceFinances: vi.fn(),
}));

vi.mock('@/convex/_generated/api', () => ({
  api: {
    plans: { listPlans: 'plans:listPlans', createPlanWithData: 'plans:createPlanWithData' },
    finances: {
      getAssets: 'finances:getAssets',
      getLiabilities: 'finances:getLiabilities',
      replaceAllFinances: 'finances:replaceAllFinances',
    },
  },
}));

vi.mock('convex/react', () => ({
  useQuery: (ref: string) => queries[ref],
  useMutation: (ref: string) => (ref === 'plans:createPlanWithData' ? createPlan : replaceFinances),
}));

import BackupSettingsForm from './backup-settings-form';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the Backup & restore card', () => {
  it('renders its legend and the sentence that introduces the card', () => {
    render(<BackupSettingsForm showSuccessNotification={vi.fn()} />);

    expect(screen.getByText('Backup & restore')).toBeTruthy();
    expect(screen.getByText(/One plan, or every plan plus the net-worth tracker, as a versioned JSON file/)).toBeTruthy();
  });
});
