import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Structural checks for the Unraid template.
 *
 * These are not a substitute for importing the template on a real Unraid box (this repo has no
 * Docker daemon), but they keep the file honest: every env var the compose file passes, the
 * ports, the stateful path and the healthcheck have to be present, and the XML has to be
 * well-formed enough that Unraid's parser will accept it.
 */

const TEMPLATE = readFileSync('unraid/ignidash.xml', 'utf8');
const COMPOSE = readFileSync('docker-compose.yml', 'utf8');

interface TemplateConfig {
  name: string;
  target: string;
  type: string;
  defaultValue: string;
  value: string;
  mask: string;
  required: string;
}

/** Parses the `<Config …>value</Config>` entries (attributes are flat, so a regex is enough). */
function configs(): TemplateConfig[] {
  return [...TEMPLATE.matchAll(/<Config\b([^>]*)>([^<]*)<\/Config>/g)].map(([, attributes, value]) => {
    const attribute = (name: string) => {
      const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
      return match ? match[1] : '';
    };
    return {
      name: attribute('Name'),
      target: attribute('Target'),
      type: attribute('Type'),
      defaultValue: attribute('Default'),
      value,
      mask: attribute('Mask'),
      required: attribute('Required'),
    };
  });
}

/** The env keys docker-compose sets explicitly for the container. */
function composeEnvironmentKeys(): string[] {
  const block = /environment:\n([\s\S]*?)\n {4}[a-z]/.exec(COMPOSE);
  if (!block) return [];
  return [...block[1].matchAll(/^\s+- ([A-Z0-9_]+)=/gm)].map((match) => match[1]);
}

describe('the Unraid template', () => {
  it('is a Container v2 template with the single-container image', () => {
    expect(TEMPLATE.startsWith('<?xml version="1.0"?>')).toBe(true);
    expect(TEMPLATE).toMatch(/<Container version="2">/);
    expect(TEMPLATE.trimEnd().endsWith('</Container>')).toBe(true);

    const repository = /<Repository>([^<]+)<\/Repository>/.exec(TEMPLATE)?.[1];
    expect(repository).toBe('ghcr.io/calmcoconut/ignidash:latest');
  });

  it('carries no unescaped ampersand or angle bracket in text', () => {
    // `&&` in the health command must be `&amp;&amp;`, or Unraid's XML parse fails.
    const illegalEntity = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g;
    expect(TEMPLATE.match(illegalEntity) ?? []).toHaveLength(0);
  });

  it('publishes the three ports the browser needs', () => {
    const ports = configs().filter((config) => config.type === 'Port');

    expect(ports.map((port) => [port.target, port.defaultValue])).toEqual([
      ['3000', '3030'],
      ['3210', '3210'],
      ['3211', '3211'],
    ]);
    for (const port of ports) expect(port.required, `${port.target} must be a required field`).toBe('true');
    expect(TEMPLATE).toContain('<WebUI>http://[IP]:[PORT:3030]/</WebUI>');
  });

  it('mounts the stateful Convex data path on an editable appdata default', () => {
    const [appdata] = configs().filter((config) => config.type === 'Path');

    expect(appdata.target).toBe('/convex/data');
    expect(appdata.defaultValue).toBe('/mnt/user/appdata/ignidash');
    expect(appdata.value).toBe('/mnt/user/appdata/ignidash');
    expect(appdata.mask).toBe('false');
    expect(appdata.required).toBe('true');
  });

  it('carries the healthcheck for both processes', () => {
    const extra = /<ExtraParams>([\s\S]*?)<\/ExtraParams>/.exec(TEMPLATE)?.[1] ?? '';

    expect(extra).toContain('--health-cmd=');
    expect(extra).toContain('http://127.0.0.1:3210/version');
    expect(extra).toContain('http://127.0.0.1:3000/api/health');
    expect(extra).toContain('--health-interval=15s');
    expect(extra).toContain('--health-retries=5');
    expect(extra).toContain('--health-start-period=60s');
  });

  it('passes every environment variable the compose file sets', () => {
    const variables = new Set(
      configs()
        .filter((config) => config.type === 'Variable')
        .map((config) => config.target)
    );
    const composeKeys = composeEnvironmentKeys();

    expect(composeKeys.length).toBeGreaterThan(5);
    for (const key of composeKeys) {
      // NODE_ENV is baked into the image by the Dockerfile, not set per container.
      if (key === 'NODE_ENV') continue;
      expect(variables, `template is missing ${key} from docker-compose.yml`).toContain(key);
    }
  });

  it('exposes the vars an operator has to provide or may want to change', () => {
    const variables = configs().filter((config) => config.type === 'Variable');
    const targets = variables.map((config) => config.target);

    for (const key of [
      'SITE_URL',
      'NEXT_PUBLIC_CONVEX_URL',
      'NEXT_PUBLIC_CONVEX_SITE_URL',
      'BETTER_AUTH_SECRET',
      'ALLOW_SIGNUP',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ENDPOINT',
      'OPENAI_CHAT_MODEL',
      'OPENAI_INSIGHTS_MODEL',
    ]) {
      expect(targets, `template is missing ${key}`).toContain(key);
    }

    // Secrets are masked; an empty default means the operator must fill it in.
    for (const secret of ['BETTER_AUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'OPENAI_API_KEY']) {
      const config = variables.find((entry) => entry.target === secret);
      expect(config?.mask, `${secret} must be masked`).toBe('true');
      expect(config?.defaultValue, `${secret} must not ship a value`).toBe('');
    }

    // The two URLs the operator sees first default to the container's own ports.
    expect(variables.find((entry) => entry.target === 'SITE_URL')?.defaultValue).toBe('http://[IP]:[PORT:3030]');
    expect(variables.find((entry) => entry.target === 'NEXT_PUBLIC_CONVEX_URL')?.defaultValue).toBe('http://[IP]:[PORT:3210]');
  });

  it('labels every field, and marks only the bootstrap and optional knobs as not required', () => {
    const all = configs();

    for (const config of all) expect(config.name, `unnamed Config for ${config.target}`).not.toBe('');

    const required = new Set(all.filter((config) => config.required === 'true').map((config) => config.target));
    for (const target of ['3000', '3210', '3211', '/convex/data', 'SITE_URL', 'BETTER_AUTH_SECRET']) {
      expect(required, `${target} should be required`).toContain(target);
    }
    expect(required).not.toContain('ALLOW_SIGNUP');
    expect(required).not.toContain('OPENAI_API_KEY');
  });

  it('has an icon, an overview and a description pointing at this repository', () => {
    const icon = /<Icon>([^<]+)<\/Icon>/.exec(TEMPLATE)?.[1] ?? '';

    expect(icon).toMatch(/^https:\/\/raw\.githubusercontent\.com\/calmcoconut\/ignidash\//);
    expect(TEMPLATE).toMatch(/<Overview>[^<]{40,}<\/Overview>/);
    expect(TEMPLATE).toMatch(/<Description>[\s\S]{80,}<\/Description>/);
    expect(TEMPLATE).toMatch(/<Category>[^<]+<\/Category>/);
    expect(TEMPLATE).toContain('/mnt/user/appdata/ignidash');
  });
});
