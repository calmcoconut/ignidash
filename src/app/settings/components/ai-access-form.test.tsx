// @vitest-environment jsdom
/**
 * The AI access card, rendered: it must mount inside the settings layout (catalyst fieldsets throw
 * at render time when misnested), show a new token exactly once with a connect command that
 * carries it, and list the existing tokens without ever having their secret.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { queries, createToken, revokeToken } = vi.hoisted(() => ({
  queries: {
    'mcp/tokens:listTokens': [
      { _id: 't1', name: 'Laptop', prefix: 'ign_abcd', scope: 'write', createdAt: 1, lastUsedAt: undefined, revokedAt: undefined },
    ],
    'mcp/tokens:listAudit': [{ _id: 'a1', tokenName: 'Laptop', tool: 'list_plans', ok: true, at: 2 }],
  } as Record<string, unknown>,
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock('@/convex/_generated/api', () => ({
  api: {
    mcp: {
      tokens: {
        listTokens: 'mcp/tokens:listTokens',
        listAudit: 'mcp/tokens:listAudit',
        createToken: 'mcp/tokens:createToken',
        revokeToken: 'mcp/tokens:revokeToken',
      },
    },
  },
}));

vi.mock('convex/react', () => ({
  useQuery: (ref: string) => queries[ref],
  useMutation: (ref: string) => (ref === 'mcp/tokens:createToken' ? createToken : revokeToken),
}));

import AiAccessForm from './ai-access-form';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiAccessForm', () => {
  it('renders the token list and the recent calls', () => {
    render(<AiAccessForm showSuccessNotification={vi.fn()} />);

    expect(screen.getAllByText('Laptop').length).toBeGreaterThan(0);
    expect(screen.getByText(/ign_abcd/)).toBeTruthy();
    expect(screen.getByText('list_plans')).toBeTruthy();
  });

  it('creates a token with the chosen name and scope, then shows it once with a connect command', async () => {
    createToken.mockResolvedValue({ tokenId: 't2', token: 'ign_SECRETVALUE', prefix: 'ign_SECR' });
    render(<AiAccessForm showSuccessNotification={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'Desktop' } });
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'read' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    await waitFor(() => expect(createToken).toHaveBeenCalledWith({ name: 'Desktop', scope: 'read' }));
    const tokenField = (await screen.findByLabelText(/Your new token/)) as HTMLInputElement;
    expect(tokenField.value).toBe('ign_SECRETVALUE');
    const command = screen.getByLabelText('Connect Claude Code') as HTMLInputElement;
    expect(command.value).toContain('/api/mcp');
    expect(command.value).toContain('Authorization: Bearer ign_SECRETVALUE');
  });
});
