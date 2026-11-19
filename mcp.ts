// The MCP surface: JSON-RPC 2.0 over streamable HTTP. Both protocol eras are
// served — the modern `server/discover` handshake and the legacy
// `initialize` one — and the tools act on the same store as REST and GraphQL.

import { createIssue, createPull, mergePull } from './store.ts';
import type { Forge, Repository } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function needString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new Error(`missing required argument: ${key}`);
  return value;
}

function repoOf(forge: Forge, args: Record<string, unknown>): Repository {
  const owner = typeof args.owner === 'string' ? args.owner : forge.viewer.login;
  let name = typeof args.repo === 'string' ? args.repo : '';
  if (name === '' && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    name = parts[parts.length - 1];
  }
  const repo = forge.repoFor(owner, name);
  if (repo === undefined) throw new Error(`repository ${owner}/${name} not found`);
  return repo;
}

const STRING = { type: 'string' } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: { name: { ...STRING }, description: { ...STRING }, private: { type: 'boolean' }, owner: { ...STRING } },
    required: ['name'],
    run: (forge, args) => {
      const name = needString(args, 'name');
      if (forge.repos.has(name)) throw new Error(`a repository named ${name} already exists`);
      const repo = forge.createRepo(name, typeof args.description === 'string' ? args.description : '', args.private === true);
      return repoJson(forge, repo, '');
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: { owner: { ...STRING }, repo: { ...STRING } },
    required: ['owner', 'repo'],
    run: (forge, args) => repoJson(forge, repoOf(forge, args), ''),
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: { owner: { ...STRING } },
    required: [],
    run: (forge) => ({ repositories: forge.listRepos().map((repo) => repoJson(forge, repo, '')) }),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: { owner: { ...STRING }, repo: { ...STRING }, title: { ...STRING }, body: { ...STRING } },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const issue = createIssue(forge, repo, {
        title: needString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: { owner: { ...STRING }, repo: { ...STRING }, state: { ...STRING, enum: ['open', 'closed', 'all'] } },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => issueJson(forge, repo, issue));
      return { issues };
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    properties: { owner: { ...STRING }, repo: { ...STRING }, issue_number: { type: 'integer' } },
    required: ['owner', 'repo', 'issue_number'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const issue = repo.issueByNumber(Number(args.issue_number));
      if (issue === undefined) throw new Error('issue not found');
      return issueJson(forge, repo, issue);
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { ...STRING },
      repo: { ...STRING },
      title: { ...STRING },
      head: { ...STRING },
      base: { ...STRING },
      body: { ...STRING },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const pull = createPull(forge, repo, {
        title: needString(args, 'title'),
        body: typeof args.body === 'string' ? args.body : '',
        head: needString(args, 'head'),
        base: needString(args, 'base'),
      });
      return pullJson(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash by default).',
    properties: { owner: { ...STRING }, repo: { ...STRING }, pull_number: { type: 'integer' }, merge_method: { ...STRING } },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const pull = repo.pullByNumber(Number(args.pull_number));
      if (pull === undefined) throw new Error('pull request not found');
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const { sha } = mergePull(forge, repo, pull, method);
      return { merged: true, sha, message: 'Pull Request successfully merged', pull_request: pullJson(forge, repo, pull) };
    },
  },
];

function toolListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: tool.required,
        additionalProperties: true,
      },
    })),
  };
}

interface RpcReply {
  status: number;
  payload: Record<string, unknown> | null;
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

export function handleMcp(forge: Forge, rawBody: string): RpcReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, payload: rpcError(null, -32700, 'Parse error') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, payload: rpcError(null, -32600, 'Invalid Request') };
  }
  const request = parsed as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  const result = (value: unknown): RpcReply => ({
    status: 200,
    payload: isNotification ? null : { jsonrpc: '2.0', id: id ?? null, result: value },
  });

  switch (method) {
    case 'server/discover':
      return result({
        protocolVersion: REVISIONS[0],
        supportedVersions: REVISIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = REVISIONS.includes(asked) ? asked : '2025-11-25';
      return result({ protocolVersion: negotiated, serverInfo: SERVER_INFO, capabilities: { tools: { listChanged: false } } });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result(toolListResult());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return { status: 200, payload: rpcError(id, -32602, `unknown tool: ${name}`) };
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      for (const requiredKey of tool.required) {
        if (args[requiredKey] === undefined || args[requiredKey] === '') {
          return {
            status: 200,
            payload: {
              jsonrpc: '2.0',
              id: id ?? null,
              result: { content: [{ type: 'text', text: `missing required argument: ${requiredKey}` }], isError: true },
            },
          };
        }
      }
      try {
        const value = tool.run(forge, args);
        const text = JSON.stringify(value);
        return result({ content: [{ type: 'text', text }], structuredContent: value, isError: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: 200,
          payload: {
            jsonrpc: '2.0',
            id: id ?? null,
            result: { content: [{ type: 'text', text: message }], isError: true },
          },
        };
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      return { status: 200, payload: rpcError(id, -32601, `method not found: ${method}`) };
  }
}
