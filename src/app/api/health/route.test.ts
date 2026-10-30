import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import pkg from '../../../../package.json';
import { GET, type HealthPayload } from './route';

const ROUTE_SOURCE = readFileSync('src/app/api/health/route.ts', 'utf8');

async function getHealth(): Promise<{ payload: HealthPayload; response: Response }> {
  const response = await GET();
  const payload = (await response.json()) as HealthPayload;
  return { payload, response };
}

describe('/api/health', () => {
  it('carries a version and a process uptime alongside the status', async () => {
    const { payload, response } = await getHealth();

    expect(response.status).toBe(200);
    expect(payload.status).toBe('ok');
    expect(typeof payload.version).toBe('string');
    expect(payload.version).not.toHaveLength(0);
    expect(typeof payload.uptime).toBe('number');
    expect(Number.isFinite(payload.uptime)).toBe(true);
    expect(payload.uptime).toBeGreaterThanOrEqual(0);
  });

  it('reports the package version, not a literal', async () => {
    const { payload } = await getHealth();

    expect(payload.version).toBe(pkg.version);

    // The value has to come from package.json (build-time import), so a version bump moves the
    // payload without anyone editing this route; a hard-coded semver here would rot silently.
    expect(ROUTE_SOURCE).toContain("from '../../../../package.json'");
    expect(ROUTE_SOURCE).not.toMatch(/\b\d+\.\d+\.\d+\b/);
  });

  it('reports process uptime, so a restart is visible', async () => {
    const before = Math.floor(process.uptime());
    const { payload } = await getHealth();

    // Not a wall-clock timestamp and not a constant: it tracks the process.
    expect(payload.uptime).toBeGreaterThanOrEqual(before);
    expect(payload.uptime).toBeLessThan(60 * 60 * 24);
  });

  it('is never cached', async () => {
    const { response } = await getHealth();

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
