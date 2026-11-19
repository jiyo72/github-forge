// A compact GraphQL engine over the forge store: lexer, parser and executor
// covering the operations GitHub clients actually send (viewer, repository,
// issues, pull requests, the create/close/merge/comment mutations, node(id:)
// and the __type introspection probes), plus operation batching.

import {
  addComment,
  createIssue,
  createPull,
  mergePull,
  pullFiles,
  threeWayMerge,
} from './store.ts';
import type { Forge, Issue, Pull, Repository } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      if (j < source.length && (source[j] === 'e' || source[j] === 'E')) {
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  directives: Array<{ name: string; args: Record<string, ValueNode> }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string; directives: Array<{ name: string; args: Record<string, ValueNode> }> }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('unexpected token in GraphQL document');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.next().value;
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('fragment without type condition');
        this.next(); // the type name
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    if (!this.skipPunct('(')) return;
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): Array<{ name: string; args: Record<string, ValueNode> }> {
    const directives: Array<{ name: string; args: Record<string, ValueNode> }> = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.next().value;
      let args: Record<string, ValueNode> = {};
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.next().value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.next();
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition: typeName, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next().value;
      const directives = this.skipDirectives();
      return { kind: 'spread', name, directives };
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    const directives = this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

// ---------------------------------------------------------------------------
// execution context, ids and connections
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

type Source = Record<string, unknown> & { __typename: string };

function connection(typename: string, items: Source[], args: Record<string, unknown>): Source {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const decoded = decodeCursor(args.after);
    if (decoded !== null) start = decoded;
  }
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, i) => ({ __typename: `${typename}Edge`, node, cursor: encodeCursor(start + i + 1) }) as Source);
  return {
    __typename: typename,
    nodes: slice,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
    totalCount: items.length,
  } as Source;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = evalValue(value, ctx.variables);
  return out;
}

function directivesAllow(directives: FieldNode['directives'], ctx: Ctx): boolean {
  for (const directive of directives) {
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(directive.args)) args[key] = evalValue(value, ctx.variables);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// sources and resolvers
// ---------------------------------------------------------------------------

function userSource(ctx: Ctx): Source {
  const viewer = ctx.forge.viewer;
  return {
    __typename: 'User',
    id: globalId('User', viewer.login),
    databaseId: viewer.id,
    login: viewer.login,
    name: viewer.name,
    email: viewer.email,
    avatarUrl: '',
    url: '',
    isViewer: true,
  } as Source;
}

function repoSource(ctx: Ctx, repo: Repository): Source {
  return { __typename: 'Repository', repo } as unknown as Source;
}

function issueSource(ctx: Ctx, repo: Repository, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue } as unknown as Source;
}

function pullSource(ctx: Ctx, repo: Repository, pull: Pull): Source {
  return { __typename: 'PullRequest', repo, pull } as unknown as Source;
}

function commentSource(ctx: Ctx, comment: { id: number; body: string; createdAtSec: number }): Source {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', String(comment.id)),
    databaseId: comment.id,
    body: comment.body,
    author: userSource(ctx),
    createdAt: ctx.forge.isoOf(comment.createdAtSec),
    updatedAt: ctx.forge.isoOf(comment.createdAtSec),
    url: '',
  } as Source;
}

function repoByDatabaseId(ctx: Ctx, id: number): Repository | undefined {
  return ctx.forge.listRepos().find((repo) => repo.id === id);
}

function repoFromGlobalId(ctx: Ctx, id: unknown): Repository {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  const repo = decoded !== null && decoded.type === 'Repository' ? repoByDatabaseId(ctx, Number(decoded.key)) : undefined;
  if (repo === undefined) throw new Error('repository not found');
  return repo;
}

function subjectFromGlobalId(ctx: Ctx, id: unknown): { repo: Repository; issue?: Issue; pull?: Pull } {
  const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
  if (decoded === null) throw new Error('unknown id');
  const [repoId, number] = decoded.key.split(':').map(Number);
  const repo = repoByDatabaseId(ctx, repoId);
  if (repo === undefined) throw new Error('repository not found');
  if (decoded.type === 'Issue') {
    const issue = repo.issueByNumber(number);
    if (issue === undefined) throw new Error('issue not found');
    return { repo, issue };
  }
  if (decoded.type === 'PullRequest') {
    const pull = repo.pullByNumber(number);
    if (pull === undefined) throw new Error('pull request not found');
    return { repo, pull };
  }
  if (decoded.type === 'Repository') return { repo };
  throw new Error('unknown id');
}

function issueOrder(list: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  const sorted = [...list].sort((a, b) => a.number - b.number);
  if (direction !== 'ASC') sorted.reverse();
  return sorted;
}

type Resolver = (ctx: Ctx, source: Source, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => userSource(ctx),
    user: (ctx, _s, args) => (args.login === ctx.forge.viewer.login ? userSource(ctx) : null),
    repository: (ctx, _s, args) => {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? ctx.forge.repoFor(args.owner, args.name) : undefined;
      return repo === undefined ? null : repoSource(ctx, repo);
    },
    node: (ctx, _s, args) => {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (decoded === null) return null;
      if (decoded.type === 'User') return decoded.key === ctx.forge.viewer.login ? userSource(ctx) : null;
      if (decoded.type === 'Repository') {
        const repo = repoByDatabaseId(ctx, Number(decoded.key));
        return repo === undefined ? null : repoSource(ctx, repo);
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        try {
          const subject = subjectFromGlobalId(ctx, args.id);
          return subject.issue ? issueSource(ctx, subject.repo, subject.issue) : pullSource(ctx, subject.repo, subject.pull!);
        } catch {
          return null;
        }
      }
      return null;
    },
    search: (ctx, _s, args) => connection('SearchResultItemConnection', [], args),
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, resetAt: '2027-01-01T00:00:00Z' }) as Source,
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const labels = Array.isArray(input.labelIds) ? [] : undefined;
      void labels;
      const issue = createIssue(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return {
        __typename: 'CreateIssuePayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        issue: issueSource(ctx, repo, issue),
        repository: repoSource(ctx, repo),
      } as Source;
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subject = subjectFromGlobalId(ctx, input.issueId);
      if (subject.issue === undefined) throw new Error('issue not found');
      subject.issue.state = 'closed';
      subject.issue.closedAtSec = ctx.forge.nowSeconds();
      return {
        __typename: 'CloseIssuePayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        issue: issueSource(ctx, subject.repo, subject.issue),
      } as Source;
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(ctx, input.repositoryId);
      const pull = createPull(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      return {
        __typename: 'CreatePullRequestPayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        pullRequest: pullSource(ctx, repo, pull),
      } as Source;
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subject = subjectFromGlobalId(ctx, input.pullRequestId);
      if (subject.pull === undefined) throw new Error('pull request not found');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      mergePull(ctx.forge, subject.repo, subject.pull, method);
      return {
        __typename: 'MergePullRequestPayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        pullRequest: pullSource(ctx, subject.repo, subject.pull),
      } as Source;
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subject = subjectFromGlobalId(ctx, input.subjectId);
      const target = subject.issue ?? subject.pull;
      if (target === undefined) throw new Error('subject cannot take comments');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = addComment(ctx.forge, target, body);
      return {
        __typename: 'AddCommentPayload',
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        commentEdge: { __typename: 'IssueCommentEdge', node: commentSource(ctx, comment), cursor: encodeCursor(comment.id) } as Source,
        subject: subject.issue ? issueSource(ctx, subject.repo, subject.issue) : pullSource(ctx, subject.repo, subject.pull!),
      } as Source;
    },
  },
  Repository: {
    id: (ctx, s) => globalId('Repository', String((s.repo as Repository).id)),
    databaseId: (_ctx, s) => (s.repo as Repository).id,
    name: (_ctx, s) => (s.repo as Repository).name,
    nameWithOwner: (ctx, s) => `${ctx.forge.viewer.login}/${(s.repo as Repository).name}`,
    description: (_ctx, s) => (s.repo as Repository).description,
    isPrivate: (_ctx, s) => (s.repo as Repository).isPrivate,
    owner: (ctx) => userSource(ctx),
    defaultBranchRef: (_ctx, s) => {
      const repo = s.repo as Repository;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/' } as Source;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: (ctx, s) => ctx.forge.isoOf((s.repo as Repository).createdAtSec),
    updatedAt: (ctx, s) => ctx.forge.isoOf((s.repo as Repository).createdAtSec),
    url: () => '',
    issue: (ctx, s, args) => {
      const repo = s.repo as Repository;
      const issue = typeof args.number === 'number' ? repo.issueByNumber(args.number) : undefined;
      return issue === undefined ? null : issueSource(ctx, repo, issue);
    },
    issues: (ctx, s, args) => {
      const repo = s.repo as Repository;
      let list = repo.issues;
      if (Array.isArray(args.states)) {
        const wanted = args.states.map((state) => String(state).toLowerCase());
        list = list.filter((issue) => wanted.includes(issue.state));
      }
      return connection('IssueConnection', issueOrder(list, args).map((issue) => issueSource(ctx, repo, issue)), args);
    },
    pullRequest: (ctx, s, args) => {
      const repo = s.repo as Repository;
      const pull = typeof args.number === 'number' ? repo.pullByNumber(args.number) : undefined;
      return pull === undefined ? null : pullSource(ctx, repo, pull);
    },
    pullRequests: (ctx, s, args) => {
      const repo = s.repo as Repository;
      let list = repo.pulls;
      if (Array.isArray(args.states)) {
        const wanted = args.states.map((state) => String(state));
        list = list.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      const sorted = [...list].sort((a, b) => b.number - a.number);
      return connection('PullRequestConnection', sorted.map((pull) => pullSource(ctx, repo, pull)), args);
    },
    labels: (ctx, s, args) => {
      const repo = s.repo as Repository;
      const items = [...repo.labels.keys()].sort().map(
        (name) => ({ __typename: 'Label', id: globalId('Label', `${repo.id}:${name}`), name, color: repo.labels.get(name) ?? '000000' }) as Source,
      );
      return connection('LabelConnection', items, args);
    },
  },
  Issue: {
    id: (ctx, s) => globalId('Issue', `${(s.repo as Repository).id}:${(s.issue as Issue).number}`),
    databaseId: (_ctx, s) => (s.issue as Issue).id,
    number: (_ctx, s) => (s.issue as Issue).number,
    title: (_ctx, s) => (s.issue as Issue).title,
    body: (_ctx, s) => (s.issue as Issue).body,
    state: (_ctx, s) => (s.issue as Issue).state.toUpperCase(),
    closed: (_ctx, s) => (s.issue as Issue).state === 'closed',
    author: (ctx) => userSource(ctx),
    repository: (ctx, s) => repoSource(ctx, s.repo as Repository),
    labels: (ctx, s, args) => {
      const repo = s.repo as Repository;
      const issue = s.issue as Issue;
      const items = issue.labels.map(
        (name) => ({ __typename: 'Label', id: globalId('Label', `${repo.id}:${name}`), name, color: repo.labels.get(name) ?? '000000' }) as Source,
      );
      return connection('LabelConnection', items, args);
    },
    comments: (ctx, s, args) => {
      const issue = s.issue as Issue;
      return connection('IssueCommentConnection', issue.comments.map((comment) => commentSource(ctx, comment)), args);
    },
    createdAt: (ctx, s) => ctx.forge.isoOf((s.issue as Issue).createdAtSec),
    updatedAt: (ctx, s) => ctx.forge.isoOf((s.issue as Issue).createdAtSec),
    url: () => '',
  },
  PullRequest: {
    id: (ctx, s) => globalId('PullRequest', `${(s.repo as Repository).id}:${(s.pull as Pull).number}`),
    databaseId: (_ctx, s) => (s.pull as Pull).id,
    number: (_ctx, s) => (s.pull as Pull).number,
    title: (_ctx, s) => (s.pull as Pull).title,
    body: (_ctx, s) => (s.pull as Pull).body,
    state: (_ctx, s) => {
      const pull = s.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, s) => (s.pull as Pull).merged,
    mergedAt: (ctx, s) => {
      const pull = s.pull as Pull;
      return pull.merged ? ctx.forge.isoOf(pull.mergedAtSec) : null;
    },
    mergeCommit: (_ctx, s) => {
      const pull = s.pull as Pull;
      return pull.merged ? ({ __typename: 'Commit', oid: pull.mergeCommitSha } as Source) : null;
    },
    headRefName: (_ctx, s) => (s.pull as Pull).headRef,
    baseRefName: (_ctx, s) => (s.pull as Pull).baseRef,
    headRefOid: (_ctx, s) => (s.repo as Repository).branchTip((s.pull as Pull).headRef) ?? '',
    baseRefOid: (_ctx, s) => (s.repo as Repository).branchTip((s.pull as Pull).baseRef) ?? '',
    mergeable: (_ctx, s) => {
      const repo = s.repo as Repository;
      const pull = s.pull as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      const headTip = repo.branchTip(pull.headRef);
      const baseTip = repo.branchTip(pull.baseRef);
      if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
      return 'conflicts' in threeWayMerge(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
    },
    closed: (_ctx, s) => (s.pull as Pull).state === 'closed',
    author: (ctx) => userSource(ctx),
    repository: (ctx, s) => repoSource(ctx, s.repo as Repository),
    files: (ctx, s, args) => {
      const repo = s.repo as Repository;
      const pull = s.pull as Pull;
      const items = pullFiles(repo, pull).map(
        (file) =>
          ({
            __typename: 'PullRequestChangedFile',
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          }) as Source,
      );
      return connection('PullRequestChangedFileConnection', items, args);
    },
    comments: (ctx, s, args) => {
      const pull = s.pull as Pull;
      return connection('IssueCommentConnection', pull.comments.map((comment) => commentSource(ctx, comment)), args);
    },
    createdAt: (ctx, s) => ctx.forge.isoOf((s.pull as Pull).createdAtSec),
    updatedAt: (ctx, s) => ctx.forge.isoOf((s.pull as Pull).createdAtSec),
    url: () => '',
  },
};

// The field sets introspection reports (and unknown-field errors judge by).
const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'user', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'labels', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'closed', 'author', 'labels', 'comments',
    'repository', 'createdAt', 'updatedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'comments',
    'repository', 'author', 'closed', 'createdAt', 'updatedAt', 'url',
  ],
  Label: ['id', 'name', 'color'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'prefix'],
  Commit: ['oid'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeSource(name: string): Source | null {
  if (OBJECT_FIELDS[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: OBJECT_FIELDS[name].map((field) => ({ __typename: '__Field', name: field }) as Source),
      enumValues: null,
    } as Source;
  }
  if (ENUM_VALUES[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: ENUM_VALUES[name].map((value) => ({ __typename: '__EnumValue', name: value }) as Source),
    } as Source;
  }
  return null;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function collectFields(ctx: Ctx, selections: SelectionNode[], typeName: string): Map<string, FieldNode[]> {
  const grouped = new Map<string, FieldNode[]>();
  const visit = (set: SelectionNode[], runtimeType: string): void => {
    for (const selection of set) {
      if (selection.kind === 'field') {
        if (!directivesAllow(selection.directives, ctx)) continue;
        const key = selection.alias ?? selection.name;
        const existing = grouped.get(key);
        if (existing) existing.push(selection);
        else grouped.set(key, [selection]);
      } else if (selection.kind === 'spread') {
        if (!directivesAllow(selection.directives, ctx)) continue;
        const fragment = ctx.fragments.get(selection.name);
        if (fragment) visit(fragment, runtimeType);
      } else {
        if (selection.typeCondition === null || selection.typeCondition === runtimeType) visit(selection.selectionSet, runtimeType);
      }
    }
  };
  visit(selections, typeName);
  return grouped;
}

function executeSelectionSet(ctx: Ctx, source: Source, typeName: string, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const grouped = collectFields(ctx, selections, typeName);
  for (const [responseKey, fields] of grouped) {
    const field = fields[0];
    out[responseKey] = executeField(ctx, source, typeName, field, fields);
  }
  return out;
}

function executeField(ctx: Ctx, source: Source, typeName: string, field: FieldNode, group: FieldNode[]): unknown {
  if (field.name === '__typename') return typeName;
  if (field.name === '__type' && (typeName === 'Query')) {
    const args = evalArgs(field, ctx);
    const found = typeof args.name === 'string' ? typeSource(args.name) : null;
    return complete(ctx, found, field, group);
  }
  if (field.name === '__schema' && typeName === 'Query') {
    const types = [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => typeSource(name));
    return complete(ctx, { __typename: '__Schema', types } as Source, field, group);
  }
  const resolver = RESOLVERS[typeName]?.[field.name];
  const knownFields = OBJECT_FIELDS[typeName];
  let value: unknown;
  if (resolver) {
    try {
      value = resolver(ctx, source, evalArgs(field, ctx));
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  } else if (source !== null && typeof source === 'object' && field.name in source) {
    value = (source as Record<string, unknown>)[field.name];
  } else if (knownFields !== undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  } else if (source !== null && typeof source === 'object') {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  } else {
    return null;
  }
  return complete(ctx, value, field, group);
}

function complete(ctx: Ctx, value: unknown, field: FieldNode, group: FieldNode[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => complete(ctx, item, field, group));
  if (typeof value === 'object') {
    const merged: SelectionNode[] = [];
    for (const node of group) if (node.selectionSet) merged.push(...node.selectionSet);
    const typeName = typeof (value as Source).__typename === 'string' ? (value as Source).__typename : 'Object';
    if (merged.length === 0) return value;
    return executeSelectionSet(ctx, value as Source, typeName, merged);
  }
  return value;
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  const { operations, fragments } = new Parser(lex(query)).parseDocument();
  const operation = operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { forge, variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = { __typename: rootType } as Source;
  const data = executeSelectionSet(ctx, root, rootType, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
