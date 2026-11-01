import { httpRouter } from 'convex/server';

import { authComponent, createAuth } from './auth';
import { callTool, manifest } from './mcp/http_handlers';

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

http.route({ path: '/mcp/manifest', method: 'GET', handler: manifest });
http.route({ path: '/mcp/tool', method: 'POST', handler: callTool });

export default http;
