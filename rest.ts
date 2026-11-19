// The REST v3 surface: repositories, contents, branches and refs, commits,
// labels, issues, comments and pull requests, in GitHub's shapes.

import {
  HttpError,
  buildCommit,
  createIssue,
  createPull,
  mergePull,
  parseCommit,
  parseTree,
  pullFiles,
  resolveCommit,
  threeWayMerge,
} from './store.ts';
import type { Forge, Issue, Pull, Repository } from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  baseUrl: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function notFound(): HttpError {
  return new HttpError(404, 'Not Found');
}

export function userJson(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: `user-node-${viewer.id}`,
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
  };
}

export function repoJson(forge: Forge, repo: Repository, baseUrl: string): Record<string, unknown> {
  const owner = forge.viewer.login;
  const stamp = forge.isoOf(repo.createdAtSec);
  return {
    id: repo.id,
    node_id: `repo-node-${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userJson(forge),
    html_url: `${baseUrl}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${owner}/${repo.name}`,
    clone_url: `${baseUrl}/${owner}/${repo.name}.git`,
    git_url: '',
    ssh_url: '',
    svn_url: '',
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repository, name: string): Record<string, unknown> {
  let id = 0;
  for (const ch of name) id = (id * 31 + ch.charCodeAt(0)) % 100000000;
  return { id, node_id: `label-node-${id}`, name, color: repo.labels.get(name) ?? '000000', default: false, description: null };
}

export function issueJson(forge: Forge, repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `issue-node-${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(forge),
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.createdAtSec),
    updated_at: forge.isoOf(issue.createdAtSec),
    closed_at: issue.state === 'closed' && issue.closedAtSec > 0 ? forge.isoOf(issue.closedAtSec) : null,
    html_url: '',
    url: '',
  };
}

export function commentJson(forge: Forge, comment: { id: number; body: string; createdAtSec: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `comment-node-${comment.id}`,
    body: comment.body,
    user: userJson(forge),
    created_at: forge.isoOf(comment.createdAtSec),
    updated_at: forge.isoOf(comment.createdAtSec),
    html_url: '',
    url: '',
  };
}

export function pullJson(forge: Forge, repo: Repository, pull: Pull): Record<string, unknown> {
  const owner = forge.viewer.login;
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  let mergeable: boolean | null = null;
  if (pull.state === 'open' && headTip !== undefined && baseTip !== undefined) {
    mergeable = !('conflicts' in threeWayMerge(repo, baseTip, headTip));
  }
  return {
    id: pull.id,
    node_id: `pull-node-${pull.id}`,
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    locked: false,
    user: userJson(forge),
    labels: [],
    draft: false,
    merged: pull.merged,
    merged_at: pull.merged ? forge.isoOf(pull.mergedAtSec) : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: headTip ?? '' },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip ?? '' },
    created_at: forge.isoOf(pull.createdAtSec),
    updated_at: forge.isoOf(pull.createdAtSec),
    closed_at: pull.state === 'closed' ? forge.isoOf(pull.mergedAtSec || pull.createdAtSec) : null,
    html_url: '',
    url: '',
    comments: pull.comments.length,
  };
}

function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(repo: Repository, oid: string): Record<string, unknown> {
  const object = repo.getObject(oid);
  const info = object && object.type === 'commit' ? parseCommit(object.data) : null;
  if (info === null) throw notFound();
  return {
    sha: oid,
    node_id: `commit-node-${oid.slice(0, 12)}`,
    commit: {
      author: identJson(info.author),
      committer: identJson(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: '' },
      comment_count: 0,
    },
    url: '',
    html_url: '',
    parents: info.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: T[], page: Page, makeUrl: (page: number) => string): { slice: T[]; headers: Record<string, string> } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / page.perPage));
  if (page.page < lastPage) {
    headers.Link = `<${makeUrl(page.page + 1)}>; rel="next", <${makeUrl(lastPage)}>; rel="last"`;
  }
  return { slice, headers };
}

function pageUrl(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number): string {
  const params = new URLSearchParams(query);
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  return `${baseUrl}/api/v3/${path}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function treeAtPath(repo: Repository, treeOid: string, segments: string[]): string | null {
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.getObject(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function contentsGet(repo: Repository, path: string, query: URLSearchParams): RestReply {
  const commitOid = resolveCommit(repo, query.get('ref') ?? undefined);
  if (commitOid === null) throw notFound();
  const info = repo.commitOf(commitOid);
  if (info === null) throw notFound();
  const segments = path === '' ? [] : path.split('/');
  if (segments.length > 0) {
    const flat = repo.flattenTree(info.tree);
    const entry = flat.get(path);
    if (entry) {
      const blob = repo.getObject(entry.oid);
      if (!blob) throw notFound();
      const base64 = blob.data.toString('base64').replace(/.{60}(?=.)/g, '$&\n');
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          content: base64,
          name: segments[segments.length - 1],
          path,
          sha: entry.oid,
          size: blob.data.length,
          url: '',
          html_url: '',
          download_url: '',
        },
      };
    }
  }
  const dirOid = treeAtPath(repo, info.tree, segments);
  if (dirOid === null) throw notFound();
  const dirObject = repo.getObject(dirOid);
  if (!dirObject || dirObject.type !== 'tree') throw notFound();
  const entries = parseTree(dirObject.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.getObject(entry.oid)?.data.length ?? 0),
    url: '',
    html_url: '',
    download_url: '',
  }));
  return { status: 200, body: entries };
}

function commitOnBranch(forge: Forge, repo: Repository, branch: string, flat: Map<string, { oid: string; mode: string }>, message: string): string {
  const existingTip = repo.branchTip(branch);
  const fallbackTip = existingTip ?? repo.branchTip(repo.defaultBranch);
  const treeOid = repo.buildTreeFromFlat(flat);
  const at = forge.nowSeconds();
  const ident = forge.identAt(at);
  const commitOid = repo.putObject(
    'commit',
    buildCommit({ tree: treeOid, parents: fallbackTip ? [fallbackTip] : [], author: ident, committer: ident, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

function contentsPut(forge: Forge, repo: Repository, path: string, body: Record<string, unknown>): RestReply {
  if (typeof body.content !== 'string') throw new HttpError(422, 'Validation Failed: content is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const tip = repo.branchTip(branch) ?? repo.branchTip(repo.defaultBranch);
  const flat = tip !== undefined ? repo.flatAtCommit(tip) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  if (existing && body.sha !== existing.oid) {
    throw new HttpError(409, `${path} does not match the sha supplied`);
  }
  const content = Buffer.from(body.content, 'base64');
  const blobOid = repo.putObject('blob', content);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const commitOid = commitOnBranch(forge, repo, branch, flat, message);
  return {
    status: existing ? 200 : 201,
    body: {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', url: '', html_url: '', download_url: '' },
      commit: { sha: commitOid, message, url: '', html_url: '' },
    },
  };
}

function contentsDelete(forge: Forge, repo: Repository, path: string, body: Record<string, unknown>): RestReply {
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const tip = repo.branchTip(branch);
  if (tip === undefined) throw notFound();
  const flat = repo.flatAtCommit(tip);
  const existing = flat.get(path);
  if (!existing) throw notFound();
  if (body.sha !== existing.oid) throw new HttpError(409, `${path} does not match the sha supplied`);
  flat.delete(path);
  const commitOid = commitOnBranch(forge, repo, branch, flat, message);
  return { status: 200, body: { content: null, commit: { sha: commitOid, message, url: '', html_url: '' } } };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function bodyString(body: Record<string, unknown> | undefined, key: string): string {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
}

function labelNamesOf(body: Record<string, unknown> | undefined): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
      names.push((item as { name: string }).name);
    }
  }
  return names;
}

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const { method, segments, query, body } = req;
  const baseUrl = req.baseUrl;
  const self = forge.viewer.login;

  if (segments.length === 0) {
    if (method !== 'GET') throw notFound();
    return {
      status: 200,
      headers: { 'X-OAuth-Scopes': 'repo, user', 'X-Accepted-OAuth-Scopes': 'repo, user' },
      body: {
        current_user_url: `${baseUrl}/api/v3/user`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${baseUrl}/api/v3/repos/{owner}/{repo}/issues/{number}`,
      },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') throw notFound();
    return { status: 200, body: { verifiable_password_authentication: false, installed_version: '1.0.0', ssh_key_fingerprints: {} } };
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') throw notFound();
    return { status: 200, body: userJson(forge) };
  }

  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET' || segments[1] !== self) throw notFound();
    return { status: 200, body: userJson(forge) };
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const page = pageOf(query);
      const { slice, headers } = paginate(forge.listRepos(), page, (p) => pageUrl(baseUrl, 'user/repos', query, p, page.perPage));
      return { status: 200, headers, body: slice.map((repo) => repoJson(forge, repo, baseUrl)) };
    }
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new HttpError(422, 'Validation Failed: name is invalid');
      if (forge.repos.has(name)) {
        throw new HttpError(422, 'Repository creation failed: a repository with this name already exists on this account');
      }
      const repo = forge.createRepo(name, bodyString(body, 'description'), body?.private === true);
      return { status: 201, body: repoJson(forge, repo, baseUrl) };
    }
    throw notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) throw notFound();
  const owner = segments[1];
  const repo = forge.repoFor(owner, segments[2]);
  if (repo === undefined) throw notFound();
  const rest = segments.slice(3);
  const pathOfRest = segments.join('/');

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(forge, repo, baseUrl) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body?.default_branch === 'string' && repo.branchTip(body.default_branch) !== undefined) {
        repo.defaultBranch = body.default_branch;
      }
      return { status: 200, body: repoJson(forge, repo, baseUrl) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repo.name);
      return { status: 204 };
    }
    throw notFound();
  }

  // ---- contents ----
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return contentsGet(repo, path, query);
    if (method === 'PUT') return contentsPut(forge, repo, path, body ?? {});
    if (method === 'DELETE') return contentsDelete(forge, repo, path, body ?? {});
    throw notFound();
  }

  // ---- branches and refs ----
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: branches };
  }
  if (rest[0] === 'branches' && rest.length >= 2 && method === 'GET') {
    const name = rest.slice(1).join('/');
    const tip = repo.branchTip(name);
    if (tip === undefined) throw notFound();
    return { status: 200, body: { name, commit: commitJson(repo, tip), protected: false } };
  }
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length === 2) {
      const all = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, oid]) => ({ ref, node_id: `ref-node-${ref}`, url: '', object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit' } }));
      return { status: 200, body: all };
    }
    if (method === 'GET' && rest.length >= 3) {
      const full = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(full);
      if (oid === undefined) throw notFound();
      return { status: 200, body: { ref: full, node_id: `ref-node-${full}`, url: '', object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit' } } };
    }
    if (method === 'POST' && rest.length === 2) {
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha');
      if (!ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed: ref must start with refs/');
      if (!repo.getObject(sha)) throw new HttpError(422, 'Validation Failed: object does not exist');
      if (repo.refs.has(ref)) throw new HttpError(422, 'Validation Failed: reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, node_id: `ref-node-${ref}`, url: '', object: { sha, type: repo.getObject(sha)?.type ?? 'commit' } } };
    }
    if (method === 'DELETE' && rest.length >= 3) {
      const full = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.delete(full)) throw notFound();
      return { status: 204 };
    }
    throw notFound();
  }

  // ---- commits ----
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const page = pageOf(query);
    const ref = query.get('sha') ?? query.get('branch') ?? undefined;
    const commitOid = resolveCommit(repo, ref);
    if (commitOid === null) return { status: 200, body: [] };
    const list = repo.commitList(commitOid, page.perPage * page.page);
    const { slice, headers } = paginate(list, page, (p) => pageUrl(baseUrl, pathOfRest, query, p, page.perPage));
    return { status: 200, headers, body: slice.map((entry) => commitJson(repo, entry.oid)) };
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    if (!repo.getObject(rest[1])) throw notFound();
    return { status: 200, body: commitJson(repo, rest[1]) };
  }

  // ---- labels ----
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, body: [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)) };
    }
    if (method === 'POST' && rest.length === 1) {
      const name = bodyString(body, 'name');
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
      const color = bodyString(body, 'color') || '000000';
      repo.labels.set(name, color.replace(/^#/, ''));
      return { status: 201, body: labelJson(repo, name) };
    }
    throw notFound();
  }

  // ---- issues ----
  if (rest[0] === 'issues') {
    if (method === 'GET' && rest.length === 1) {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const labelFilter = query.get('labels');
      if (labelFilter) {
        const wanted = labelFilter.split(',').map((s) => s.trim()).filter((s) => s !== '');
        list = list.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(query);
      const { slice, headers } = paginate(list, page, (p) => pageUrl(baseUrl, pathOfRest, query, p, page.perPage));
      return { status: 200, headers, body: slice.map((issue) => issueJson(forge, repo, issue)) };
    }
    if (method === 'POST' && rest.length === 1) {
      const issue = createIssue(forge, repo, {
        title: bodyString(body, 'title'),
        body: bodyString(body, 'body'),
        labels: labelNamesOf(body),
      });
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issueByNumber(number) : undefined;
    if (rest.length === 2 && issue !== undefined) {
      if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        if (body?.state === 'closed' || body?.state === 'open') {
          issue.state = body.state;
          issue.closedAtSec = body.state === 'closed' ? forge.nowSeconds() : 0;
        }
        if (body?.labels !== undefined) {
          const names = labelNamesOf(body);
          for (const name of names) {
            if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist`);
          }
          issue.labels = names;
        }
        return { status: 200, body: issueJson(forge, repo, issue) };
      }
    }
    if (rest.length === 3 && rest[2] === 'comments' && issue !== undefined) {
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map((comment) => commentJson(forge, comment)) };
      }
      if (method === 'POST') {
        const text = bodyString(body, 'body');
        if (text === '') throw new HttpError(422, 'Validation Failed: body is required');
        const comment = { id: forge.nextCommentId(), body: text, createdAtSec: forge.nowSeconds() };
        issue.comments.push(comment);
        return { status: 201, body: commentJson(forge, comment) };
      }
    }
    throw notFound();
  }

  // ---- pull requests ----
  if (rest[0] === 'pulls') {
    if (method === 'GET' && rest.length === 1) {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls
        .filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open' && !pull.merged))
        .sort((a, b) => b.number - a.number);
      const page = pageOf(query);
      const { slice, headers } = paginate(list, page, (p) => pageUrl(baseUrl, pathOfRest, query, p, page.perPage));
      return { status: 200, headers, body: slice.map((pull) => pullJson(forge, repo, pull)) };
    }
    if (method === 'POST' && rest.length === 1) {
      const pull = createPull(forge, repo, {
        title: bodyString(body, 'title'),
        body: bodyString(body, 'body'),
        head: bodyString(body, 'head'),
        base: bodyString(body, 'base') || repo.defaultBranch,
      });
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pullByNumber(number) : undefined;
    if (pull === undefined) throw notFound();
    if (rest.length === 2 && method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
    if (rest.length === 2 && method === 'PATCH') {
      if (typeof body?.title === 'string') pull.title = body.title;
      if (typeof body?.body === 'string') pull.body = body.body;
      if (body?.state === 'closed' || body?.state === 'open') pull.state = body.state;
      return { status: 200, body: pullJson(forge, repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const files = pullFiles(repo, pull).map((file) => ({
        sha: '',
        filename: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.additions + file.deletions,
      }));
      return { status: 200, body: files };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const method2 = typeof body?.merge_method === 'string' ? body.merge_method : 'squash';
      const { sha } = mergePull(forge, repo, pull, method2);
      return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (rest.length === 3 && rest[2] === 'commits' && method === 'GET') {
      const tip = repo.branchTip(pull.headRef);
      if (tip === undefined) return { status: 200, body: [] };
      return { status: 200, body: repo.commitList(tip, 30).map((entry) => commitJson(repo, entry.oid)) };
    }
    throw notFound();
  }

  throw notFound();
}
