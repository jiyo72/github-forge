// The forge's core: an in-memory store holding repositories, their git objects,
// issues, labels and pull requests, plus the git object model and pack codec
// everything else is built on. Objects are content-addressed with git's own
// SHA-1 framing, so bytes the forge writes are byte-identical to real git's.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** An error that maps onto an HTTP status in the GitHub style. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 of "<type> <length>\0" followed by the raw bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ---------------------------------------------------------------------------
// object payloads
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

/** The unix timestamp inside an author/committer line, or 0 when unparsable. */
export function identTimestamp(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line.trim());
  return match ? Number(match[1]) : 0;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git's order (directories sort as name + "/"). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: TagInfo = { object: '', type: '', tag: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
  }
  return info;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (TYPE_TO_CODE[type] << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (never delta-compressed) objects. */
export function writePack(objects: StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git binary delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
}

/**
 * Read a packfile, resolving OFS/REF deltas (a REF delta whose base is absent
 * is looked up through `externalBase`, which is how thin packs are completed).
 * Returns every object keyed by its recomputed id.
 */
export function readPack(pack: Buffer, externalBase?: (oid: string) => StoredObject | undefined): Map<string, StoredObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const size = (() => {
      let value = byte & 0x0f;
      let shift = 4;
      while (byte & 0x80) {
        byte = pack[offset++];
        value += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      }
      return value;
    })();
    const typeCode = (pack[entryOffset] >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0), baseOffset: -1, baseOid: '' };
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (!CODE_TO_TYPE[typeCode]) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, StoredObject>();
  const byOid = new Map<string, StoredObject>();
  const resolveEntry = (entry: RawPackEntry, seen: Set<number>): StoredObject => {
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let object: StoredObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error('ofs-delta base missing from pack');
      const base = resolveEntry(baseEntry, seen);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const base = byOid.get(entry.baseOid) ?? externalBase?.(entry.baseOid);
      if (!base) throw new Error('ref-delta base missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: CODE_TO_TYPE[entry.typeCode], data: entry.data };
    }
    byOid.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of raw) {
    const object = resolveEntry(entry, new Set());
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export const PKT_MAX_PAYLOAD = 65520 - 4;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet = Buffer | 'flush' | 'delim' | 'end';

/** Parse pkt-lines from `offset`; stops at the buffer end. Throws on garbage. */
export function parsePackets(body: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let cursor = offset;
  while (cursor < body.length) {
    if (cursor + 4 > body.length) throw new Error('truncated pkt-line');
    const header = body.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push('flush');
      cursor += 4;
    } else if (length === 1) {
      packets.push('delim');
      cursor += 4;
    } else if (length === 2) {
      packets.push('end');
      cursor += 4;
    } else if (length < 4 || cursor + length > body.length) {
      throw new Error('pkt-line length out of range');
    } else {
      packets.push(body.subarray(cursor + 4, cursor + length));
      cursor += length;
    }
  }
  return { packets, next: cursor };
}

/** Frame bytes as side-band packets on one band, respecting the pkt-line cap. */
export function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

// ---------------------------------------------------------------------------
// domain records
// ---------------------------------------------------------------------------

export interface IssueComment {
  id: number;
  body: string;
  createdAtSec: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAtSec: number;
  closedAtSec: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  createdAtSec: number;
  mergedAtSec: number;
  mergeCommitSha: string;
  comments: IssueComment[];
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

export class Repository {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdAtSec: number;
  readonly objects = new Map<string, StoredObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextNumber = 1;

  constructor(id: number, name: string, description: string, isPrivate: boolean, createdAtSec: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAtSec = createdAtSec;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  /** Follow tag objects until a commit (or another type) is reached. */
  peel(oid: string): { oid: string; type: ObjectType } | null {
    let current = oid;
    for (let hops = 0; hops < 32; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type !== 'tag') return { oid: current, type: object.type };
      current = parseTag(object.data).object;
    }
    return null;
  }

  peelToCommit(oid: string): string | null {
    const peeled = this.peel(oid);
    return peeled !== null && peeled.type === 'commit' ? peeled.oid : null;
  }

  commitOf(oid: string): CommitInfo | null {
    const commitOid = this.peelToCommit(oid);
    if (commitOid === null) return null;
    const object = this.objects.get(commitOid);
    return object ? parseCommit(object.data) : null;
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Every commit reachable from `tip`, newest first (timestamp, then discovery). */
  commitList(tip: string, limit: number): Array<{ oid: string; info: CommitInfo }> {
    const start = this.peelToCommit(tip);
    if (start === null) return [];
    const seen = new Set<string>();
    const found: Array<{ oid: string; info: CommitInfo; order: number }> = [];
    const queue: string[] = [start];
    let order = 0;
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const info = parseCommit(object.data);
      found.push({ oid, info, order: order++ });
      for (const parent of info.parents) queue.push(parent);
    }
    found.sort((a, b) => {
      const byTime = identTimestamp(b.info.committer) - identTimestamp(a.info.committer);
      return byTime !== 0 ? byTime : a.order - b.order;
    });
    return found.slice(0, limit).map(({ oid, info }) => ({ oid, info }));
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const from = this.peelToCommit(descendant);
    const target = this.peelToCommit(ancestor);
    if (from === null || target === null) return false;
    const seen = new Set<string>();
    const queue: string[] = [from];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (oid === target) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return false;
  }

  /** A common ancestor of two commits (the first found walking from `a`), or null. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOf = (tip: string): Set<string> => {
      const set = new Set<string>();
      const start = this.peelToCommit(tip);
      if (start === null) return set;
      const queue: string[] = [start];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (set.has(oid)) continue;
        set.add(oid);
        const object = this.objects.get(oid);
        if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
      }
      return set;
    };
    const fromB = ancestorsOf(b);
    const start = this.peelToCommit(a);
    if (start === null) return null;
    const seen = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (fromB.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    return null;
  }

  /** Flatten a tree into path -> entry, recursing into subtrees. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  flatAtCommit(commitOid: string): Map<string, FlatEntry> {
    const info = this.commitOf(commitOid);
    if (info === null) return new Map();
    return this.flattenTree(info.tree);
  }

  /** Build (and store) nested trees from a flat path map; returns the root tree id. */
  buildTreeFromFlat(flat: Map<string, FlatEntry>): string {
    interface DirNode {
      files: TreeEntry[];
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let next = node.dirs.get(parts[i]);
        if (!next) {
          next = { files: [], dirs: new Map() };
          node.dirs.set(parts[i], next);
        }
        node = next;
      }
      node.files.push({ mode: entry.mode, name: parts[parts.length - 1], oid: entry.oid });
    }
    const emit = (node: DirNode): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
      return this.putObject('tree', buildTree(entries));
    };
    return emit(root);
  }

  issueByNumber(number: number): Issue | undefined {
    return this.issues.find((issue) => issue.number === number);
  }

  pullByNumber(number: number): Pull | undefined {
    return this.pulls.find((pull) => pull.number === number);
  }
}

// ---------------------------------------------------------------------------
// the forge itself
// ---------------------------------------------------------------------------

export interface ViewerIdentity {
  login: string;
  id: number;
  name: string;
  email: string;
}

export class Forge {
  readonly viewer: ViewerIdentity = {
    login: 'adaiversen',
    id: 1000,
    name: 'Ada Iversen',
    email: 'adaiversen@example.invalid',
  };
  readonly repos = new Map<string, Repository>();
  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private clock = 1735689600;

  /** A strictly increasing logical clock (seconds), so ordering is stable. */
  nowSeconds(): number {
    this.clock += 1;
    return this.clock;
  }

  isoOf(seconds: number): string {
    return new Date(seconds * 1000).toISOString();
  }

  identAt(seconds: number): string {
    return `${this.viewer.name} <${this.viewer.email}> ${seconds} +0000`;
  }

  createRepo(name: string, description = '', isPrivate = false): Repository {
    this.repoSeq += 1;
    const repo = new Repository(this.repoSeq, name, description, isPrivate, this.nowSeconds());
    this.repos.set(name, repo);
    return repo;
  }

  /** Repositories belong to the token's login; any other owner is a 404. */
  repoFor(owner: string, name: string): Repository | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(name);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(name);
  }

  listRepos(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextPullId(): number {
    this.pullSeq += 1;
    return this.pullSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }
}

// ---------------------------------------------------------------------------
// shared domain operations (REST, GraphQL and MCP all funnel through these)
// ---------------------------------------------------------------------------

export function createIssue(forge: Forge, repo: Repository, input: { title: string; body?: string; labels?: string[] }): Issue {
  const title = (input.title ?? '').trim();
  if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label "${label}" does not exist`);
  }
  const issue: Issue = {
    id: forge.nextIssueId(),
    number: repo.nextNumber++,
    title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    createdAtSec: forge.nowSeconds(),
    closedAtSec: 0,
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

export function addComment(forge: Forge, target: { comments: IssueComment[] }, body: string): IssueComment {
  const comment: IssueComment = { id: forge.nextCommentId(), body, createdAtSec: forge.nowSeconds() };
  target.comments.push(comment);
  return comment;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

/** Line-level change counts between two blob versions (multiset difference). */
function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const count = (text: string | null): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === null) return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const before = count(oldText);
  const after = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of after) additions += Math.max(0, n - (before.get(line) ?? 0));
  for (const [line, n] of before) deletions += Math.max(0, n - (after.get(line) ?? 0));
  return { additions, deletions };
}

/** The changed-file list of a pull request: merge-base tree versus head tree. */
export function pullFiles(repo: Repository, pull: Pull): FileChange[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = repo.mergeBase(baseTip, headTip) ?? baseTip;
  const before = repo.flatAtCommit(base);
  const after = repo.flatAtCommit(headTip);
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    const oldText = oldEntry ? (repo.getObject(oldEntry.oid)?.data.toString('utf8') ?? null) : null;
    const newText = newEntry ? (repo.getObject(newEntry.oid)?.data.toString('utf8') ?? null) : null;
    const { additions, deletions } = lineCounts(oldText, newText);
    changes.push({
      path,
      status: !oldEntry ? 'added' : !newEntry ? 'deleted' : 'modified',
      additions,
      deletions,
    });
  }
  return changes;
}

/**
 * Three-way flat merge of head into base. Returns the merged flat map, or the
 * list of conflicting paths when both sides changed the same path differently.
 */
export function threeWayMerge(
  repo: Repository,
  baseTip: string,
  headTip: string,
): { merged: Map<string, FlatEntry> } | { conflicts: string[] } {
  const mergeBase = repo.mergeBase(baseTip, headTip);
  const ancestor = mergeBase === null ? new Map<string, FlatEntry>() : repo.flatAtCommit(mergeBase);
  const baseFlat = repo.flatAtCommit(baseTip);
  const headFlat = repo.flatAtCommit(headTip);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set([...ancestor.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const sameAB = a?.oid === b?.oid;
    const sameAH = a?.oid === h?.oid;
    if (sameAB && sameAH) {
      if (b) merged.set(path, b);
    } else if (sameAB) {
      if (h) merged.set(path, h);
    } else if (sameAH) {
      if (b) merged.set(path, b);
    } else if (b?.oid === h?.oid) {
      if (b) merged.set(path, b);
    } else {
      conflicts.push(path);
    }
  }
  return conflicts.length > 0 ? { conflicts } : { merged };
}

export function createPull(
  forge: Forge,
  repo: Repository,
  input: { title: string; body?: string; head: string; base: string },
): Pull {
  const stripOwner = (ref: string): string => {
    const colon = ref.indexOf(':');
    return colon === -1 ? ref : ref.slice(colon + 1);
  };
  const head = stripOwner(input.head ?? '');
  const base = stripOwner(input.base ?? '');
  const headTip = repo.branchTip(head);
  const baseTip = repo.branchTip(base);
  if (headTip === undefined) throw new HttpError(422, `Validation Failed: head branch "${head}" does not exist`);
  if (baseTip === undefined) throw new HttpError(422, `Validation Failed: base branch "${base}" does not exist`);
  if (headTip === baseTip) throw new HttpError(422, 'Validation Failed: no commits between base and head');
  const pull: Pull = {
    id: forge.nextPullId(),
    number: repo.nextNumber++,
    title: input.title ?? '',
    body: input.body ?? '',
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    createdAtSec: forge.nowSeconds(),
    mergedAtSec: 0,
    mergeCommitSha: '',
    comments: [],
  };
  repo.pulls.push(pull);
  return pull;
}

/** Merge a pull request into its base branch; squash and merge are supported. */
export function mergePull(forge: Forge, repo: Repository, pull: Pull, method: string): { sha: string } {
  if (pull.merged) throw new HttpError(405, 'Pull Request is not mergeable');
  if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
  const outcome = threeWayMerge(repo, baseTip, headTip);
  if ('conflicts' in outcome) throw new HttpError(405, 'Pull Request is not mergeable');
  const treeOid = repo.buildTreeFromFlat(outcome.merged);
  const at = forge.nowSeconds();
  const ident = forge.identAt(at);
  let commitData: Buffer;
  if (method === 'merge') {
    commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip, headTip],
      author: ident,
      committer: ident,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
    });
  } else {
    const body = pull.body === '' ? '' : `\n${pull.body}\n`;
    commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message: `${pull.title} (#${pull.number})\n${body}`,
    });
  }
  const sha = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAtSec = at;
  pull.mergeCommitSha = sha;
  return { sha };
}

/** Resolve a ref-ish (branch name, full ref, or object id) to a commit id. */
export function resolveCommit(repo: Repository, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = repo.refs.get(repo.headRef());
    return tip === undefined ? null : repo.peelToCommit(tip);
  }
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid !== undefined) return repo.peelToCommit(oid);
  }
  if (/^[0-9a-f]{40}$/.test(ref) && repo.getObject(ref)) return repo.peelToCommit(ref);
  return null;
}
