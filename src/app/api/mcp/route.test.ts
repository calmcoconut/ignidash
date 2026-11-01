import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The adapter against a stubbed Convex site: it must authenticate through `/mcp/manifest`, list
 * exactly what the manifest offers, and forward tool calls unchanged, turning a Convex-side failure
 * into an MCP tool error rather than a protocol error.
 */

vi.stubEnv('SELF_HOSTED_CONVEX_SITE_URL', 'http://convex.test');

const MANIFEST = {
  tools: [{ name: 'list_plans', description: 'List plans', inputSchema: { type: 'object', properties: {} } }],
  prompts: [{ name: 'setup_interview', description: 'Interview', text: 'Ask about the timeline first.' }],
  resources: [
    { uri: 'ignidash://help/limitations', name: 'Limitations', description: 'Not modeled', mimeType: 'text/markdown', text: '- No x' },
  ],
};

type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[];
let toolResponse: { status: number; body: unknown };
let manifestStatus: number;

beforeEach(() => {
  calls = [];
  toolResponse = { status: 200, body: { ok: true, result: [{ planId: 'p1' }] } };
  manifestStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === 'http://convex.test/mcp/manifest') {
        return manifestStatus === 200
          ? Response.json(MANIFEST)
          : Response.json({ error: 'Invalid or revoked token' }, { status: manifestStatus });
      }
      if (url === 'http://convex.test/mcp/tool') return Response.json(toolResponse.body, { status: toolResponse.status });
      throw new Error(`unexpected fetch ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rpc(method: string, params: Record<string, unknown> = {}, token: string | null = 'ign_test') {
  const { POST } = await import('./route');
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  return POST(
    new Request('http://app.test/api/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  );
}

describe('/api/mcp', () => {
  it('refuses a request without a bearer token before calling Convex', async () => {
    const response = await rpc('tools/list', {}, null);

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('passes a rejected token through as the HTTP status Convex returned', async () => {
    manifestStatus = 401;
    const response = await rpc('tools/list');

    expect(response.status).toBe(401);
    expect(calls[0].init?.headers).toEqual({ authorization: 'Bearer ign_test' });
  });

  it('answers initialize with the server name and its capabilities', async () => {
    const response = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    const body = await response.json();

    expect(body.result.serverInfo.name).toBe('ignidash');
    expect(Object.keys(body.result.capabilities)).toEqual(expect.arrayContaining(['tools', 'prompts', 'resources']));
  });

  it('lists exactly the tools in the manifest', async () => {
    const body = await (await rpc('tools/list')).json();

    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_plans']);
  });

  it('forwards a tool call with its name, arguments and token, and returns the result as JSON text', async () => {
    const body = await (await rpc('tools/call', { name: 'list_plans', arguments: { a: 1 } })).json();

    const toolCall = calls.find((call) => call.url.endsWith('/mcp/tool'))!;
    expect(JSON.parse(toolCall.init!.body as string)).toEqual({ name: 'list_plans', input: { a: 1 } });
    expect((toolCall.init!.headers as Record<string, string>).authorization).toBe('Bearer ign_test');
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text)).toEqual([{ planId: 'p1' }]);
  });

  it('turns a failed or refused tool call into an MCP tool error carrying the message', async () => {
    toolResponse = { status: 403, body: { error: 'This token is read-only' } };
    const body = await (await rpc('tools/call', { name: 'list_plans', arguments: {} })).json();

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe('This token is read-only');
  });

  it('serves prompts and resources from the manifest', async () => {
    const prompt = await (await rpc('prompts/get', { name: 'setup_interview' })).json();
    const resource = await (await rpc('resources/read', { uri: 'ignidash://help/limitations' })).json();

    expect(prompt.result.messages[0].content.text).toBe('Ask about the timeline first.');
    expect(resource.result.contents[0].text).toBe('- No x');
  });
});
