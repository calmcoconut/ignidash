import pkg from '../../../../package.json';

/**
 * Liveness/readiness payload for the single container.
 *
 * `version` is the app's own release version, taken from `package.json` at build time, so a
 * rollback or an upgrade is visible in `docker inspect`/the Unraid Docker tab without trusting a
 * hand-maintained string. `uptime` is seconds since this Node process started: a restart resets
 * it, a hang leaves it climbing while `/api/health` stops answering — which is what separates
 * "the container restarted" from "the app is wedged".
 *
 * The compose healthcheck and the Unraid template probe this route together with the backend's
 * `/version`, so a healthy answer here alone does not mean a healthy container.
 */
export const dynamic = 'force-dynamic';

export interface HealthPayload {
  status: 'ok';
  /** App release version, from package.json. */
  version: string;
  /** Whole seconds since the app process started. */
  uptime: number;
}

export async function GET(): Promise<Response> {
  const payload: HealthPayload = {
    status: 'ok',
    version: pkg.version,
    uptime: Math.floor(process.uptime()),
  };

  return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
}
