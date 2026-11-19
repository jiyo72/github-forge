// Git smart HTTP: ref advertisement, protocol v2 ls-refs and fetch, protocol
// v0 fetch, and receive-pack pushes. The forge speaks the wire protocol
// itself; there is no git binary involved on the server side.

import {
  HttpError,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  parseCommit,
  parsePackets,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
} from './store.ts';
import type { Repository, StoredObject } from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function sortedRefs(repo: Repository): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** One advertisement ref line, with the peeled target for annotated tags. */
function refLine(repo: Repository, name: string, oid: string): string {
  const peeled = repo.peel(oid);
  if (peeled !== null && peeled.oid !== oid && peeled.type === 'commit') {
    return `${oid} ${name}\n${peeled.oid} ${name}^{}\n`;
  }
  return `${oid} ${name}\n`;
}

function v0Advertisement(repo: Repository, service: string): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${repo.headRef()}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headOid = repo.refs.get(repo.headRef());
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  const emit = (line: string): void => {
    if (first) {
      const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
      parts.push(pktLine(`${trimmed}\0${caps}\n`));
      first = false;
    } else {
      parts.push(pktLine(line));
    }
  };
  if (headOid !== undefined) emit(`${headOid} HEAD\n`);
  for (const [name, oid] of sortedRefs(repo)) emit(refLine(repo, name, oid));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(repo: Repository): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  void repo;
  return Buffer.concat(parts);
}

export function infoRefs(repo: Repository | undefined, service: string, wantsV2: boolean): GitReply {
  if (repo === undefined) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
  }
  const body = service === 'git-upload-pack' && wantsV2 ? v2Advertisement(repo) : v0Advertisement(repo, service);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function lsRefs(repo: Repository, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headRef = repo.headRef();
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = repo.peel(oid);
      if (peeled !== null && peeled.oid !== oid) line += ` peeled:${peeled.oid}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  done: boolean;
}

/** Objects the client provably holds: reachable from its haves, grafted at its shallow lines. */
function heldObjects(repo: Repository, req: FetchRequest): Set<string> {
  const held = new Set<string>();
  const shallow = new Set(req.clientShallow);
  const seenCommits = new Set<string>();
  const queue: string[] = [];
  for (const have of req.haves) {
    const commit = repo.peelToCommit(have);
    if (commit !== null) queue.push(commit);
  }
  const addTree = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const object = repo.getObject(oid);
      if (!object || object.type !== 'tree') continue;
      held.add(oid);
      for (const entry of parseTreeEntries(repo, oid)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else held.add(entry.oid);
      }
    }
  };
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = repo.getObject(oid);
    if (!object || object.type !== 'commit') continue;
    held.add(oid);
    const info = parseCommit(object.data);
    addTree(info.tree);
    if (!shallow.has(oid)) queue.push(...info.parents);
  }
  // Tag objects the client named directly are held too.
  for (const have of req.haves) if (repo.getObject(have)) held.add(have);
  return held;
}

function parseTreeEntries(repo: Repository, treeOid: string): Array<{ mode: string; oid: string }> {
  const object = repo.getObject(treeOid);
  if (!object || object.type !== 'tree') return [];
  const entries: Array<{ mode: string; oid: string }> = [];
  let offset = 0;
  while (offset < object.data.length) {
    const space = object.data.indexOf(0x20, offset);
    const nul = object.data.indexOf(0x00, space);
    entries.push({ mode: object.data.toString('ascii', offset, space), oid: object.data.toString('hex', nul + 1, nul + 21) });
    offset = nul + 21;
  }
  return entries;
}

interface FetchPlan {
  send: StoredObject[];
  shallowLines: string[];
  unshallowLines: string[];
}

function planFetch(repo: Repository, req: FetchRequest): FetchPlan {
  const held = heldObjects(repo, req);
  const limit = req.depth;
  const clientShallow = new Set(req.clientShallow);
  const included = new Map<string, StoredObject>();
  const boundary = new Set<string>();
  const seenCommits = new Set<string>();
  // Breadth-first by generation so depth limits cut at the right commits.
  let frontier: string[] = [];
  for (const want of req.wants) {
    const commit = repo.peelToCommit(want);
    if (commit !== null && !frontier.includes(commit)) frontier.push(commit);
    const direct = repo.getObject(want);
    if (direct && direct.type === 'tag') included.set(want, direct);
  }
  let depth = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const object = repo.getObject(oid);
      if (!object || object.type !== 'commit') continue;
      included.set(oid, object);
      const info = parseCommit(object.data);
      const treeObject = repo.getObject(info.tree);
      if (treeObject) {
        const stack: string[] = [info.tree];
        while (stack.length > 0) {
          const treeOid = stack.pop()!;
          if (included.has(treeOid)) continue;
          const tree = repo.getObject(treeOid);
          if (!tree || tree.type !== 'tree') continue;
          included.set(treeOid, tree);
          for (const entry of parseTreeEntries(repo, treeOid)) {
            if (entry.mode === '40000') stack.push(entry.oid);
            else {
              const blob = repo.getObject(entry.oid);
              if (blob) included.set(entry.oid, blob);
            }
          }
        }
      }
      const atLimit = limit !== null && depth + 1 >= limit;
      const grafted = limit === null && clientShallow.has(oid);
      if ((atLimit || grafted) && info.parents.length > 0) boundary.add(oid);
      if (!atLimit && !grafted) next.push(...info.parents);
    }
    frontier = next;
    depth += 1;
  }
  const send: StoredObject[] = [];
  for (const [oid, object] of included) {
    if (!held.has(oid)) send.push(object);
  }
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  for (const oid of boundary) {
    if (!held.has(oid) || clientShallow.has(oid)) shallowLines.push(oid);
  }
  for (const oid of clientShallow) {
    if (included.has(oid) && !boundary.has(oid)) unshallowLines.push(oid);
  }
  return { send, shallowLines, unshallowLines };
}

function fetchV2(repo: Repository, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  const shallowSection = (): void => {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  };
  if (!req.done) {
    // A negotiation round: acknowledgments (and shallow news) only, no pack.
    parts.push(pktLine('acknowledgments\n'));
    const common = req.haves.find((have) => repo.getObject(have) !== undefined);
    if (common !== undefined) {
      parts.push(pktLine(`ACK ${common}\n`));
      parts.push(pktLine('ready\n'));
    } else if (req.haves.length > 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
    if (req.depth !== null || req.clientShallow.length > 0) shallowSection();
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (req.depth !== null || req.clientShallow.length > 0) shallowSection();
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(plan.send), 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repository, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = req.haves.find((have) => repo.getObject(have) !== undefined);
  parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(writePack(plan.send), 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(repo: Repository | undefined, body: Buffer, wantsV2: boolean): GitReply {
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
  let packets;
  try {
    packets = parsePackets(body).packets;
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid pkt-line request\n') };
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet === 'flush' || packet === 'delim' || packet === 'end') lines.push(packet);
    else lines.push(packet.toString('utf8').replace(/\n$/, ''));
  }
  const first = lines.find((line) => line !== 'flush' && line !== 'delim' && line !== 'end') ?? '';
  try {
    if (first.startsWith('command=ls-refs')) {
      const args: string[] = [];
      let inArgs = false;
      for (const line of lines) {
        if (line === 'delim') {
          inArgs = true;
          continue;
        }
        if (line === 'flush' || line === 'end') break;
        if (inArgs) args.push(line);
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
    }
    if (first.startsWith('command=fetch')) {
      const req: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, done: false };
      let inArgs = false;
      for (const line of lines) {
        if (line === 'delim') {
          inArgs = true;
          continue;
        }
        if (line === 'flush' || line === 'end') break;
        if (!inArgs) continue;
        if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) req.clientShallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
        else if (line === 'done') req.done = true;
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, req) };
    }
    // Protocol v0: wants up to the first flush, negotiation up to the second.
    const req: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, done: false };
    let section = 0;
    for (const line of lines) {
      if (line === 'flush') {
        section += 1;
        continue;
      }
      if (line === 'delim' || line === 'end') continue;
      if (section === 0) {
        if (line.startsWith('want ')) req.wants.push(line.slice(5, 45));
      } else {
        if (line.startsWith('have ')) req.haves.push(line.slice(5, 45));
        else if (line.startsWith('shallow ')) req.clientShallow.push(line.slice(8, 48));
        else if (line.startsWith('deepen ')) req.depth = Number(line.slice(7).trim());
        else if (line === 'done') req.done = true;
      }
    }
    void wantsV2;
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, req) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad upload-pack request\n') };
  }
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse pkt-lines up to and including the first flush; a packfile may follow. */
function readCommandList(body: Buffer): { packets: Array<Buffer | 'flush' | 'delim' | 'end'>; next: number } {
  const packets: Array<Buffer | 'flush' | 'delim' | 'end'> = [];
  let cursor = 0;
  while (cursor < body.length) {
    if (cursor + 4 > body.length) throw new Error('truncated pkt-line');
    const header = body.toString('ascii', cursor, cursor + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('invalid pkt-line length');
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push('flush');
      return { packets, next: cursor + 4 };
    }
    if (length === 1) {
      packets.push('delim');
      cursor += 4;
      continue;
    }
    if (length === 2) {
      packets.push('end');
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > body.length) throw new Error('pkt-line length out of range');
    packets.push(body.subarray(cursor + 4, cursor + length));
    cursor += length;
  }
  return { packets, next: cursor };
}

export function receivePack(repo: Repository | undefined, body: Buffer): GitReply {
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
  let parsed;
  try {
    parsed = readCommandList(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid pkt-line request\n') };
  }
  const commands: PushCommand[] = [];
  let capabilities = '';
  const packOffset = parsed.next;
  for (const packet of parsed.packets) {
    if (packet === 'flush' || packet === 'delim' || packet === 'end') continue;
    let text = packet.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (!match) return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid push command\n') };
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }

  let unpackOk = true;
  let unpackDetail = '';
  const packBytes = body.subarray(packOffset);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.getObject(command.newOid)) {
      fail('missing object');
      continue;
    }
    if (current !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      const newCommit = repo.peelToCommit(command.newOid);
      const oldCommit = repo.peelToCommit(current);
      if (newCommit === null || oldCommit === null || !repo.isAncestor(oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const useSideband = capabilities.includes('side-band-64k');
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    if (useSideband) parts.push(...sidebandPackets(pktLine(line), 1));
    else parts.push(pktLine(line));
  }
  if (useSideband) {
    // The demuxed report stream ends with its own flush, carried in band 1;
    // a second, top-level flush then ends the sideband stream itself.
    parts.push(...sidebandPackets(PKT_FLUSH, 1));
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
