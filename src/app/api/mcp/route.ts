import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import pkg from '../../../../package.json';

/**
 * The MCP endpoint: `POST /api/mcp`, Streamable HTTP, stateless, JSON responses.
 *
 * This route is a thin adapter and holds no secrets and no logic. The bearer token goes, untouched,
 * to the Convex HTTP routes on the site port (`convex/mcp/http_handlers.ts`), which authenticate
 * it, check its scope, rate-limit, run the tool as the token's owner and write the audit row:
 *
 *   GET  /mcp/manifest  → the tools, prompts and resources this token may use
 *   POST /mcp/tool      → { name, input } → { ok: true, result } | { ok: false, error }
 *
 * The site URL is resolved the same way as `src/lib/auth-server.ts`; in the container the
 * entrypoint rewrites the build-time default to loopback.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONVEX_SITE_URL = process.env.SELF_HOSTED_CONVEX_SITE_URL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL!;

export interface McpManifest {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  prompts: { name: string; description: string; text: string }[];
  resources: { uri: string; name: string; description: string; mimeType: string; text: string }[];
}

const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function fetchManifest(
  authorization: string
): Promise<{ ok: true; manifest: McpManifest } | { ok: false; status: number; error: string }> {
  const response = await fetch(`${CONVEX_SITE_URL}/mcp/manifest`, { headers: { authorization }, cache: 'no-store' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, status: response.status, error: body.error ?? `Manifest request failed (${response.status})` };
  }
  return { ok: true, manifest: (await response.json()) as McpManifest };
}

async function callTool(authorization: string, name: string, input: unknown): Promise<CallToolResult> {
  const response = await fetch(`${CONVEX_SITE_URL}/mcp/tool`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };

  if (response.ok && body.ok) {
    return { content: [{ type: 'text', text: JSON.stringify(body.result ?? null, null, 2) }] };
  }
  return { isError: true, content: [{ type: 'text', text: body.error ?? `Tool call failed (${response.status})` }] };
}

function buildServer(authorization: string, manifest: McpManifest): Server {
  const server = new Server({ name: 'ignidash', version: pkg.version }, { capabilities: { tools: {}, prompts: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: 'object' as const },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(authorization, request.params.name, request.params.arguments ?? {})
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: manifest.prompts.map(({ name, description }) => ({ name, description })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = manifest.prompts.find((candidate) => candidate.name === request.params.name);
    if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
    return {
      description: prompt.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text } }],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: manifest.resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = manifest.resources.find((candidate) => candidate.uri === request.params.uri);
    if (!resource) throw new Error(`Unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] };
  });

  return server;
}

async function handle(request: Request): Promise<Response> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return jsonError(401, 'Missing bearer token. Create one in Settings → AI access.');

  const manifest = await fetchManifest(authorization);
  if (!manifest.ok) return jsonError(manifest.status, manifest.error);

  const server = buildServer(authorization, manifest.manifest);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
