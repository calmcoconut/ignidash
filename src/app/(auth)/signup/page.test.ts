import { afterEach, describe, expect, it, vi } from 'vitest';

import SignUpPage from './page';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/signup', () => {
  it('is not reachable while signup is locked', async () => {
    vi.stubEnv('ALLOW_SIGNUP', '');

    // `redirect()` signals by throwing a NEXT_REDIRECT error; the route never renders the form.
    const thrown = await Promise.resolve()
      .then(() => SignUpPage())
      .then(
        () => null,
        (error: unknown) => error as { digest?: string }
      );

    expect(thrown).not.toBeNull();
    expect(String(thrown?.digest)).toContain('NEXT_REDIRECT');
    expect(String(thrown?.digest)).toContain('/signin');
  });

  it('renders when signup is unlocked', () => {
    vi.stubEnv('ALLOW_SIGNUP', 'true');

    expect(() => SignUpPage()).not.toThrow();
  });
});
