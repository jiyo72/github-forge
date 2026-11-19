// HTTP wiring: one server routing the four surfaces (git smart HTTP, REST v3,
// GraphQL, MCP) onto the shared forge store, with the suite's protocol
// discipline — JSON everywhere on the API, a request id on every REST reply,
// bearer-token auth, 404 (never 403) for another owner's repository.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Forge, HttpError } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(text);
}

export function createApp(forge: Forge = new Forge()): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authed = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://forge.local');
    const path = url.pathname;
    const requestId = randomUUID();
    try {
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- git smart HTTP: /{owner}/{repo}.git/... ----
      const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const [, owner, name, endpoint] = gitMatch;
        if (!authed(req)) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('authentication required\n');
          return;
        }
        const repo = forge.repoFor(owner, name);
        if (endpoint === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            res.writeHead(400, { 'content-type': 'text/plain' });
            res.end('unknown service\n');
            return;
          }
          const protocol = req.headers['git-protocol'];
          const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
          const reply = infoRefs(repo, service, wantsV2);
          res.writeHead(reply.status, { 'content-type': reply.contentType });
          res.end(reply.body);
          return;
        }
        const body = await readBody(req);
        const reply = endpoint === 'git-upload-pack' ? uploadPack(repo, body, false) : receivePack(repo, body);
        res.writeHead(reply.status, { 'content-type': reply.contentType });
        res.end(reply.body);
        return;
      }

      // ---- REST v3 ----
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, { 'X-GitHub-Request-Id': requestId });
          return;
        }
        const raw = await readBody(req);
        let body: Record<string, unknown> | undefined;
        if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
          try {
            const parsed: unknown = JSON.parse(raw.toString('utf8'));
            body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'X-GitHub-Request-Id': requestId });
            return;
          }
        }
        const segments = path
          .slice('/api/v3'.length)
          .split('/')
          .filter((segment) => segment !== '')
          .map((segment) => decodeURIComponent(segment));
        const host = req.headers.host ?? '127.0.0.1';
        try {
          const reply = handleRest(forge, { method, segments, query: url.searchParams, body, baseUrl: `http://${host}` });
          sendJson(res, reply.status, reply.body, { 'X-GitHub-Request-Id': requestId, ...(reply.headers ?? {}) });
        } catch (error) {
          if (error instanceof HttpError) {
            sendJson(res, error.status, { message: error.message }, { 'X-GitHub-Request-Id': requestId });
          } else {
            sendJson(res, 500, { message: 'Internal Server Error' }, { 'X-GitHub-Request-Id': requestId });
          }
        }
        return;
      }

      // ---- GraphQL ----
      if (path === '/api/graphql') {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Unauthorized' });
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { errors: [{ message: 'method not allowed' }] });
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
          return;
        }
        const runOne = (entry: unknown): Record<string, unknown> => {
          if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'invalid operation' }] };
          const operation = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
          if (typeof operation.query !== 'string') return { errors: [{ message: 'query is required' }] };
          const variables =
            typeof operation.variables === 'object' && operation.variables !== null
              ? (operation.variables as Record<string, unknown>)
              : {};
          try {
            return executeGraphQL(forge, operation.query, variables, typeof operation.operationName === 'string' ? operation.operationName : undefined);
          } catch (error) {
            return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
          }
        };
        if (Array.isArray(parsed)) {
          sendJson(res, 200, parsed.map(runOne));
        } else {
          sendJson(res, 200, runOne(parsed));
        }
        return;
      }

      // ---- MCP ----
      if (path === '/mcp') {
        if (!authed(req)) {
          sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } });
          return;
        }
        if (method === 'DELETE') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
          return;
        }
        const raw = await readBody(req);
        const reply = handleMcp(forge, raw.toString('utf8'));
        if (reply.payload === null) {
          res.writeHead(reply.status === 200 ? 202 : reply.status);
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.payload);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
  return server;
}
