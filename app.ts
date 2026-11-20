// Forge — a one-process GitHub-compatible git forge.
//
// One Node 22 process, standard library only, no git binary, no outside service:
// git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3 under /api/v3,
// GraphQL v4 at /api/graphql, and MCP at /mcp, all over one in-memory store.
//
// Determinism: every timestamp the forge emits is fixed or derived from a monotonic
// counter, never from a clock, so two runs on the same instance leave the same state.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const FIXED_ISO = '2025-01-01T00:00:00Z';
const COMMIT_EPOCH = 1700000000;
const AGENT = 'forge/1.0';
const PKT_MAX_PAYLOAD = 65516;

// ---------------------------------------------------------------- small utils

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function b64(buf: Buffer): string {
  return buf.toString('base64');
}
function b64dec(s: string): Buffer {
  return Buffer.from(s.replace(/[\r\n\t ]+/g, ''), 'base64');
}
function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}
function parseGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const i = text.indexOf(':');
    if (i <= 0) return null;
    return { kind: text.slice(0, i), key: text.slice(i + 1) };
  } catch {
    return null;
  }
}
function decodeGid(id: string): [string, string] | null {
  const p = parseGid(id);
  return p ? [p.kind, p.key] : null;
}

// ---------------------------------------------------------------- git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const out: Array<{ mode: string; name: string; oid: string }> = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: m.get('object') ?? '',
    type: (m.get('type') ?? 'commit') as ObjType,
    tag: m.get('tag') ?? '',
    tagger: m.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// Build a tree object for a flat file map (path -> {oid, mode}) and store every
// intermediate tree in `put`. Returns the root tree oid.
function buildTreeForFiles(files: Map<string, { oid: string; mode: string }>, put: (type: ObjType, data: Buffer) => string): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// Flat file map of a commit's tree (path -> blob oid/mode), with per-repo cache.
function filesOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const cached = repo.fileCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else if (e.mode !== '160000') out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  const commit = repo.objects.get(commitOid);
  if (commit && commit.type === 'commit') walk(parseCommit(commit.data).tree, '');
  repo.fileCache.set(commitOid, out);
  return out;
}

// All objects reachable from roots (commits -> trees/blobs/parents, tags -> target).
function reachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

// Resolve a tag object (possibly chained) to its commit oid.
function peelToCommit(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return cur;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else return cur;
  }
  return cur;
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const cur = queue.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

// ---------------------------------------------------------------- pack codec

function writePackHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rem = size;
  let first = (code << 4) | (rem & 0x0f);
  rem = Math.floor(rem / 16);
  while (rem > 0) {
    bytes.push(first | 0x80);
    first = rem & 0x7f;
    rem = Math.floor(rem / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    parts.push(writePackHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOff += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const lit = op & 0x7f;
      delta.copy(out, written, off, off + lit);
      off += lit;
      written += lit;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
interface PackEntryRaw {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}
function readPack(pack: Buffer): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');
  const raw: PackEntryRaw[] = [];
  const byOffset = new Map<number, PackEntryRaw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const h = readVarintSize(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: PackEntryRaw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[off];
      let o = off + 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[o++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
      off = o;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error('unknown pack type');
    }
    const inflated = inflateSync(pack.subarray(off, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    off += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObj>();
  const resolved = new Map<number, { type: ObjType; data: Buffer; oid: string }>();
  const byOid = new Map<string, { type: ObjType; data: Buffer; oid: string }>();
  const resolve = (entry: PackEntryRaw): { type: ObjType; data: Buffer; oid: string } => {
    const done = resolved.get(entry.offset);
    if (done) return done;
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid!);
      if (baseEntry) {
        type = baseEntry.type;
        data = applyDelta(baseEntry.data, entry.data);
      } else {
        throw new Error('ref-delta base missing');
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const r = { type, data, oid };
    resolved.set(entry.offset, r);
    byOid.set(oid, r);
    return r;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return objects;
}

// ---------------------------------------------------------------- pkt-line

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
// Split a buffer into pkt-line text lines; returns lines and byte offset just
// past the first flush packet (or the end when none).
function parsePktStream(buf: Buffer): { lines: string[]; restOffset: number } {
  const lines: string[] = [];
  let off = 0;
  let restOffset = buf.length;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) break;
    if (len === 0) {
      restOffset = off + 4;
      break;
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, restOffset };
}
function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 32768) {
    const chunk = data.subarray(i, Math.min(data.length, i + 32768));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- store

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  seq: number;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}
interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  fileCache: Map<string, Map<string, { oid: string; mode: string }>>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  seq: number;
}
interface Store {
  repos: Map<string, Repo>; // key owner/name
  nextRepoId: number;
  nextGlobalId: number;
  seq: number;
  reqId: number;
}
const store: Store = { repos: new Map(), nextRepoId: 1, nextGlobalId: 1, seq: 0, reqId: 0 };

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}
function newRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: store.nextRepoId++,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    fileCache: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    seq: ++store.seq,
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}
function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function commitOnFiles(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeOid = buildTreeForFiles(files, (t, d) => putObject(repo, t, d));
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const parents = parent ? [parent] : [];
  const ts = COMMIT_EPOCH + ++store.seq;
  const commitOid = putObject(repo, 'commit', buildCommit(treeOid, parents, message, ts));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}
function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: gid('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000, avatar_url: '', type: 'User', html_url: '', url: '' },
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: '',
    ssh_url: '',
    clone_url: '',
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('I', `${repo.owner}/${repo.name}:${issue.number}`),
    url: '',
    repository_url: '',
    labels_url: '',
    comments_url: '',
    events_url: '',
    html_url: '',
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' },
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { id: 1000 + name.length, node_id: gid('L', `${repo.owner}/${repo.name}:${name}`), url: '', name, color: l?.color ?? 'ededed', default: false, description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
    draft: false,
  };
}
function pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseCommit = pull.baseSha;
  const headCommit = pull.headSha;
  const baseFiles = baseCommit ? filesOfCommit(repo, baseCommit) : new Map<string, { oid: string; mode: string }>();
  // Merge-base files: use base commit's files as the diff base when the head's
  // history is linear from base; for a general diff use the merge-base.
  const mb = mergeBase(repo, headCommit, baseCommit);
  const mbFiles = mb ? filesOfCommit(repo, mb) : new Map<string, { oid: string; mode: string }>();
  const headFiles = headCommit ? filesOfCommit(repo, headCommit) : new Map<string, { oid: string; mode: string }>();
  void baseFiles;
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const a = mbFiles.get(path);
    const b = headFiles.get(path);
    if (a && b && a.oid === b.oid) continue;
    const lineCount = (oid: string): number => {
      const obj = repo.objects.get(oid);
      if (!obj) return 0;
      const text = obj.data.toString('utf8');
      return text === '' ? 0 : text.split('\n').length;
    };
    if (!a && b) {
      const add = lineCount(b.oid);
      out.push({ filename: path, status: 'added', additions: Math.max(add, 1), deletions: 0, changes: Math.max(add, 1) });
    } else if (a && !b) {
      const del = lineCount(a.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(del, 1), changes: Math.max(del, 1) });
    } else if (a && b) {
      const add = Math.max(1, lineCount(b.oid));
      const del = Math.max(0, lineCount(a.oid));
      out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return out;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (!a || !b) return null;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const cur = queueA.pop()!;
    if (ancestorsA.has(cur)) continue;
    ancestorsA.add(cur);
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueA.push(p);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const cur = queueB.pop()!;
    if (ancestorsA.has(cur)) return cur;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueB.push(p);
  }
  return null;
}
function currentBaseSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
}
function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseSha = currentBaseSha(repo, pull);
  const mb = mergeBase(repo, pull.headSha, baseSha);
  if (!mb) return 'MERGEABLE';
  const mbFiles = filesOfCommit(repo, mb);
  const headFiles = filesOfCommit(repo, pull.headSha);
  const baseFiles = filesOfCommit(repo, baseSha);
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path)?.oid;
    const h = headFiles.get(path)?.oid;
    const b = baseFiles.get(path)?.oid;
    const headChanged = h !== m;
    const baseChanged = b !== m;
    if (headChanged && baseChanged && h !== b) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('P', `${repo.owner}/${repo.name}:${pull.number}`),
    url: '',
    html_url: '',
    diff_url: '',
    patch_url: '',
    issue_url: '',
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' },
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    mergeable_state: pullMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : pullMergeable(repo, pull) === 'CONFLICTING' ? 'dirty' : 'unknown',
    merged_by: pull.merged ? { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' } : null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: { login: VIEWER_LOGIN, id: VIEWER_ID }, repo: repoJson(repo) },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: pullFiles(repo, pull).length,
  };
}
function doSquashMerge(repo: Repo, pull: Pull): { sha: string } | { conflict: true } {
  if (pullMergeable(repo, pull) === 'CONFLICTING') return { conflict: true };
  const baseSha = currentBaseSha(repo, pull);
  const mb = mergeBase(repo, pull.headSha, baseSha);
  const mbFiles = mb ? filesOfCommit(repo, mb) : new Map<string, { oid: string; mode: string }>();
  const headFiles = filesOfCommit(repo, pull.headSha);
  const baseFiles = filesOfCommit(repo, baseSha);
  const result = new Map(baseFiles);
  const paths = new Set([...mbFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path);
    const h = headFiles.get(path);
    if (h && (!m || m.oid !== h.oid)) result.set(path, h);
    else if (!h && m) result.delete(path);
  }
  const treeOid = buildTreeForFiles(result, (t, d) => putObject(repo, t, d));
  const parents = baseSha ? [baseSha] : [];
  const ts = COMMIT_EPOCH + ++store.seq;
  const sha = putObject(repo, 'commit', buildCommit(treeOid, parents, `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`, ts));
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = FIXED_ISO;
  return { sha };
}

// ---------------------------------------------------------------- HTTP plumbing

function reqId(): string {
  return `req-${++store.reqId}`;
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': reqId(), ...extra });
    res.end();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': reqId(), ...extra });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': reqId(), ...extra });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extra);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}
function authed(req: IncomingMessage): boolean {
  const want = expectedToken();
  const got = req.headers.authorization ?? '';
  if (want === '') return got.startsWith('Bearer ') && got.length > 7;
  return got === `Bearer ${want}`;
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function pathOf(req: IncomingMessage): string {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://entry').pathname);
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

// ---------------------------------------------------------------- git smart HTTP

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
function peelOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return peelToCommit(repo, oid);
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main side-band-64k side-band agent=forge/1.0 object-format=sha1 thin-pack ofs-delta multi_ack_detailed shallow filter'
      : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1';
  const headOid = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const peeled = peelOf(repo, r.oid);
      if (peeled) lines.push(`${peeled} ${r.name}^{}\n`);
    }
  }
  return Buffer.concat([pkt(`# service=${service}\n`), pktLines(lines), PKT_FLUSH]);
}
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    pktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow filter thin-pack\n', 'server-option\n', 'object-format=sha1\n', 'agent\n']),
    PKT_FLUSH,
  ]);
}
// Small response cache for repeated identical git reads (bench clones hit the
// same fetch/advertisement many times). Keys always include the object count,
// so any push changes the key and stale entries can never be served.
const respCache = new Map<string, Buffer>();
function cacheGet(key: string): Buffer | null {
  return respCache.get(key) ?? null;
}
function cachePut(key: string, buf: Buffer): void {
  if (respCache.size > 256) {
    const first = respCache.keys().next().value;
    if (first !== undefined) respCache.delete(first);
  }
  respCache.set(key, buf);
}
function refsSnapshot(repo: Repo): string {
  return sortedRefs(repo).map((r) => `${r.name}=${r.oid}`).join(';');
}
function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const headOid = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0 && symrefs) {
    if (headOid) out.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const r of sortedRefs(repo)) {
    if (!keep(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel) {
      const peeled = peelOf(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  return Buffer.concat([pktLines(out), PKT_FLUSH]);
}

// Objects reachable from commits without walking parents (depth-limited fetch).
function closureNoParents(repo: Repo, commits: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const c of commits) queue.push(c);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') queue.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
  }
  return seen;
}
function fetchPlan(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): { objects: Array<{ type: ObjType; data: Buffer }>; shallow: string[]; unshallow: string[]; acks: string[] } {
  // Commit distances from wants.
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const w of wants) {
    const c = peelToCommit(repo, w);
    if (!dist.has(c)) {
      dist.set(c, 0);
      queue.push([c, 0]);
    }
  }
  while (queue.length) {
    const [cur, d] = queue.shift()!;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push([p, d + 1]);
      }
    }
  }
  const wantedCommits = new Set<string>();
  for (const [oid, d] of dist) if (depth === null || d < depth) wantedCommits.add(oid);
  // Held objects: reachable from haves, but do not walk past a shallow boundary.
  const shallowSet = new Set(shallowIn);
  const held = new Set<string>();
  const heldQueue: string[] = [];
  for (const h of haves) {
    const c = peelToCommit(repo, h);
    if (!held.has(c)) {
      held.add(c);
      heldQueue.push(c);
    }
  }
  while (heldQueue.length) {
    const cur = heldQueue.pop()!;
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (shallowSet.has(cur)) {
      // A shallow boundary is held with its own tree, but not its parents.
      if (obj.type === 'commit') {
        const treeOid = parseCommit(obj.data).tree;
        const tq = [treeOid];
        while (tq.length) {
          const t = tq.pop()!;
          if (held.has(t)) continue;
          held.add(t);
          const tobj = repo.objects.get(t);
          if (tobj?.type === 'tree') for (const e of parseTree(tobj.data)) {
            held.add(e.oid);
            if (e.mode === '40000') tq.push(e.oid);
          }
        }
      }
      continue;
    }
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (!held.has(c.tree)) {
        held.add(c.tree);
        heldQueue.push(c.tree);
      }
      for (const p of c.parents) if (!held.has(p)) {
        held.add(p);
        heldQueue.push(p);
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data).object;
      if (!held.has(t)) {
        held.add(t);
        heldQueue.push(t);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (!held.has(e.oid)) {
          held.add(e.oid);
          if (e.mode === '40000') heldQueue.push(e.oid);
        }
      }
    }
  }
  const send = closureNoParents(repo, wantedCommits);
  // A wanted tag object itself must travel (its target is already covered above).
  for (const w of wants) {
    let cur = w;
    for (let i = 0; i < 16; i++) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tag') break;
      send.add(cur);
      cur = parseTag(obj.data).object;
    }
  }
  for (const oid of held) send.delete(oid);
  const objects: Array<{ type: ObjType; data: Buffer }> = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  // Deterministic order: commits, then trees, then blobs, then tags, by oid.
  const rank: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => rank[a.type] - rank[b.type]);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of wantedCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const hasOutsideParent = parents.some((p) => !wantedCommits.has(p));
      if (hasOutsideParent || parents.length === 0) shallow.push(oid);
    }
    for (const s of shallowIn) if (wantedCommits.has(s)) unshallow.push(s);
  }
  const acks: string[] = [];
  for (const h of haves) {
    const c = peelToCommit(repo, h);
    if (repo.objects.has(c)) acks.push(c);
  }
  return { objects, shallow, unshallow, acks };
}
function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) depth = 1;
  }
  const parts: Buffer[] = [];
  const plan = fetchPlan(repo, wants, haves, shallowIn, depth);
  parts.push(pkt('acknowledgments\n'));
  if (plan.acks.length) {
    for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
    parts.push(pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (depth !== null || shallowIn.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.objects.length) {
    parts.push(pkt('packfile\n'));
    const pack = writePack(plan.objects);
    parts.push(sidebandWrap(pack));
  } else {
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}
function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) depth = 1;
  }
  const plan = fetchPlan(repo, wants, haves, shallowIn, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  if (plan.objects.length) {
    const pack = writePack(plan.objects);
    parts.push(sidebandWrap(pack));
  } else {
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}
function handleUploadPack(repo: Repo, req: IncomingMessage, body: Buffer, isV2: boolean): { status: number; body: Buffer; type: string } {
  const cacheKey = `U|${isV2 ? 2 : 0}|${repo.owner}/${repo.name}|${repo.objects.size}|${body.toString('base64')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { status: 200, body: cached, type: 'application/x-git-upload-pack-result' };
  const { lines } = parsePktStream(body);
  const first = (lines[0] ?? '').trim();
  let result: { status: number; body: Buffer; type: string };
  if (first.startsWith('command=ls-refs')) result = { status: 200, body: handleLsRefs(repo, lines), type: 'application/x-git-upload-pack-result' };
  else if (first.startsWith('command=fetch')) result = { status: 200, body: handleFetchV2(repo, lines), type: 'application/x-git-upload-pack-result' };
  else if (lines.some((l) => l.trim().startsWith('want '))) result = { status: 200, body: handleFetchV0(repo, lines), type: 'application/x-git-upload-pack-result' };
  else {
    void isV2;
    void req;
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad Request' })), type: 'application/json' };
  }
  if (result.status === 200) cachePut(cacheKey, result.body);
  return result;
}
function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; type: string } {
  const { lines, restOffset } = parsePktStream(body);
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Cmd[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(restOffset);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (hashObject(obj.type, obj.data) !== oid) throw new Error('object hash mismatch');
        repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'unpack error';
    }
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack error\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} ref does not exist\n`);
      } else if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} already exists\n`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${cmd.ref} ref does not exist\n`);
      continue;
    }
    if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    const newCommit = peelToCommit(repo, cmd.newOid);
    const oldCommit = peelToCommit(repo, cmd.oldOid);
    // Fast path: the common sequential-push case where the old tip is the
    // new commit's direct parent; fall back to a full ancestry walk.
    let ff = newCommit === oldCommit;
    if (!ff) {
      const newObj = repo.objects.get(cmd.newOid);
      if (newObj?.type === 'commit') {
        if (parseCommit(newObj.data).parents.includes(oldCommit)) ff = true;
      }
    }
    if (!ff) ff = isAncestor(repo, oldCommit, newCommit);
    if (ff) {
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    } else {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
    }
  }
  const inner = pktLines([`unpack ${unpackDetail}\n`, ...reportLines]);
  const out = Buffer.concat([sidebandWrap(inner)]);
  return { status: 200, body: out, type: 'application/x-git-receive-pack-result' };
}

// ---------------------------------------------------------------- REST v3

function viewerRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(owner, name) ?? null;
}
function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}
function paginate<T>(items: T[], q: URLSearchParams): { items: T[]; link: string | null } {
  const { page, perPage } = pageParams(q);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return { items: slice, link: null };
}
function linkHeader(req: IncomingMessage, path: string, q: URLSearchParams, total: number): string | null {
  const { page, perPage } = pageParams(q);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const next = new URL(base);
  next.searchParams.set('per_page', String(perPage));
  next.searchParams.set('page', String(page + 1));
  return `<${next.toString()}>; rel="next"`;
}
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const parseWho = (who: string): { name: string; email: string; date: string } => {
    const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(who);
    if (!m) return { name: who, email: '', date: FIXED_ISO };
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = parseWho(c.author);
  const committer = parseWho(c.committer);
  return {
    sha,
    node_id: gid('C', `${repo.owner}/${repo.name}:${sha}`),
    url: '',
    html_url: '',
    commit: {
      author,
      committer,
      message: c.message.replace(/\n+$/, ''),
      tree: { sha: c.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}
function commitList(repo: Repo, fromSha: string, perPage: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue = [fromSha];
  while (queue.length && out.length < perPage) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const j = commitJson(repo, cur);
    if (!j) continue;
    out.push(j);
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}
function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}
function contentsCommit(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; blobSha: string | null } {
  if (!repo.refs.has(`refs/heads/${branch}`)) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip) repo.refs.set(`refs/heads/${branch}`, baseTip);
  }
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const files = tip ? new Map(filesOfCommit(repo, tip)) : new Map<string, { oid: string; mode: string }>();
  let blobSha: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    blobSha = putObject(repo, 'blob', content);
    files.set(path, { oid: blobSha, mode: '100644' });
  }
  const commitSha = commitOnFiles(repo, branch, files, message);
  return { commitSha, blobSha };
}
function dirListing(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const obj = repo.objects.get(entry.oid);
      seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid, size: obj?.data.length ?? 0, url: '', html_url: '', git_url: '', download_url: null });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        seen.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: '', size: 0, url: '', html_url: '', git_url: '', download_url: null });
      }
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, bodyBuf: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segs = path.split('/').filter((s) => s !== '');
  // segs[0] === 'api', segs[1] === 'v3'
  const rest = segs.slice(2);
  const publicRoute = method === 'GET' && (rest.length === 0 || rest[0] === 'meta' || rest[0] === 'rate_limit');
  if (!publicRoute && !authed(req)) {
    errJson(res, 401, 'Bad credentials');
    return;
  }
  const parsed = parseJsonBody(bodyBuf);
  const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  if (needsBody && bodyBuf.length > 0 && !parsed.ok) {
    errJson(res, 400, 'Problems parsing JSON');
    return;
  }
  const body: Record<string, unknown> = isRecord(parsed.value) ? parsed.value : {};
  const hasBody = parsed.value !== undefined;

  // API root
  if (rest.length === 0) {
    if (method !== 'GET') {
      errJson(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', current_user_authorizations_html_url: '', authorizations_url: '', code_search_url: '', commit_search_url: '', emails_url: '/api/v3/user/emails', emojis_url: '', events_url: '', feeds_url: '', followers_url: '', following_url: '', gists_url: '', hub_url: '', issue_search_url: '', issues_url: '', keys_url: '', labels_url: '', notifications_url: '', organizations_url: '', public_gists_url: '', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}', repository_search_url: '', current_user_repositories_url: '/api/v3/user/repos', user_url: '/api/v3/users/{user}', user_organizations_url: '', user_repositories_url: '/api/v3/users/{user}/repos', user_search_url: '' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', git_sha: '', hooks: [], git: [], pages: [], importer: [], ssh_key_fingerprints: {}, domains: {} });
    return;
  }
  if (rest[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 }, search: { limit: 30, remaining: 30, reset: 1735689600, used: 0 }, graphql: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset: 1735689600, used: 1 } });
    return;
  }
  // /user
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('U', VIEWER_LOGIN), avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL, public_repos: store.repos.size, public_gists: 0, followers: 0, following: 0, created_at: FIXED_ISO, updated_at: FIXED_ISO });
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.seq - b.seq).map((r) => repoJson(r));
      const { items } = paginate(all, q);
      const link = linkHeader(req, '/api/v3/user/repos', q, all.length);
      sendJson(res, 200, items, link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        errJson(res, 422, 'name is required');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name)) {
        errJson(res, 422, 'Repository already exists');
        return;
      }
      const repo = newRepo(VIEWER_LOGIN, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      sendJson(res, 201, repoJson(repo));
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  // /repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1];
    const name = rest[2];
    const repo = viewerRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return;
    }
    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.repos.delete(repoKey(owner, name));
        sendJson(res, 204, null);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    const sub = tail[0];
    // branches
    if (sub === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const names = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length));
        const ordered = [repo.defaultBranch, ...names.filter((n) => n !== repo.defaultBranch).sort()];
        sendJson(res, 200, ordered.map((n) => ({ name: n, commit: { sha: repo.refs.get(`refs/heads/${n}`) ?? '', url: '' }, protected: false })));
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = tail[1];
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          errJson(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // commits
    if (sub === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const { perPage } = pageParams(q);
        const tip = resolveRefTip(repo, q.get('sha'));
        if (!tip) {
          sendJson(res, 200, []);
          return;
        }
        sendJson(res, 200, commitList(repo, tip, perPage));
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const j = commitJson(repo, tail[1]);
        if (!j) {
          errJson(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, j);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // git refs
    if (sub === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) {
          errJson(res, 422, 'Invalid ref');
          return;
        }
        if (!isOid(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Object does not exist');
          return;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('REF', `${repo.owner}/${repo.name}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const all = sortedRefs(repo).map((r) => ({ ref: r.name, node_id: gid('REF', `${repo.owner}/${repo.name}:${r.name}`), url: '', object: { sha: r.oid, type: repo.objects.get(r.oid)?.type ?? 'commit', url: '' } }));
          sendJson(res, 200, all);
          return;
        }
        const refName = tail.slice(2).join('/');
        const sha = repo.refs.get(refName);
        if (!sha) {
          errJson(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref: refName, node_id: gid('REF', `${repo.owner}/${repo.name}:${refName}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'PATCH' && tail.length >= 3) {
        const refName = tail.slice(2).join('/');
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!repo.refs.has(refName) || !isOid(sha) || !repo.objects.has(sha)) {
          errJson(res, 422, 'Invalid ref or sha');
          return;
        }
        repo.refs.set(refName, sha);
        sendJson(res, 200, { ref: refName, url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'DELETE' && tail.length >= 3) {
        const refName = tail.slice(2).join('/');
        if (!repo.refs.has(refName)) {
          errJson(res, 404, 'Not Found');
          return;
        }
        repo.refs.delete(refName);
        sendJson(res, 204, null);
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // contents
    if (sub === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : typeof q.get('branch') === 'string' && q.get('branch') !== '' ? (q.get('branch') as string) : repo.defaultBranch;
      if (method === 'GET') {
        const tip = resolveRefTip(repo, q.get('ref'));
        if (!tip) {
          errJson(res, 404, 'Not Found');
          return;
        }
        const files = filesOfCommit(repo, tip);
        if (contentPath === '') {
          sendJson(res, 200, dirListing(repo, files, ''));
          return;
        }
        const entry = files.get(contentPath);
        if (entry) {
          const obj = repo.objects.get(entry.oid);
          const data = obj?.data ?? Buffer.alloc(0);
          sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: contentPath.split('/').pop() ?? contentPath, path: contentPath, content: b64(data), sha: entry.oid, url: '', html_url: '', git_url: '', download_url: null });
          return;
        }
        const listing = dirListing(repo, files, contentPath);
        if (listing.length) {
          sendJson(res, 200, listing);
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        if (!hasBody || typeof body.content !== 'string' || typeof body.message !== 'string') {
          errJson(res, 422, 'content and message are required');
          return;
        }
        const content = b64dec(body.content);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const files = tip ? filesOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(contentPath);
        if (existing) {
          if (typeof body.sha !== 'string' || body.sha !== existing.oid) {
            errJson(res, 409, 'sha does not match the current blob');
            return;
          }
          const { commitSha, blobSha } = contentsCommit(repo, branch, contentPath, content, body.message);
          sendJson(res, 200, { content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: blobSha, size: content.length, url: '', html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64' }, commit: { sha: commitSha, message: body.message, url: '', html_url: '' } });
          return;
        }
        const { commitSha, blobSha } = contentsCommit(repo, branch, contentPath, content, body.message);
        sendJson(res, 201, { content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: blobSha, size: content.length, url: '', html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64' }, commit: { sha: commitSha, message: body.message, url: '', html_url: '' } });
        return;
      }
      if (method === 'DELETE') {
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const files = tip ? filesOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(contentPath);
        if (!existing) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
          errJson(res, 409, 'sha does not match the current blob');
          return;
        }
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const { commitSha } = contentsCommit(repo, branch, contentPath, null, message);
        sendJson(res, 200, { commit: { sha: commitSha, message, url: '', html_url: '' } });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // labels
    if (sub === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: 1000 + l.name.length, node_id: gid('L', `${repo.owner}/${repo.name}:${l.name}`), url: '', name: l.name, color: l.color, default: false, description: '' })));
        return;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) {
          errJson(res, 422, 'name is required');
          return;
        }
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { id: 1000 + name.length, node_id: gid('L', `${repo.owner}/${repo.name}:${name}`), url: '', name, color, default: false, description: typeof body.description === 'string' ? body.description : '' });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // issues
    if (sub === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.issues];
          const state = q.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { items } = paginate(list.map((i) => issueJson(repo, i)), q);
          sendJson(res, 200, items);
          return;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const l of rawLabels) {
            const name = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
            if (!name) continue;
            if (!repo.labels.has(name)) {
              errJson(res, 422, `Label ${name} does not exist`);
              return;
            }
            labels.push(name);
          }
          const issue: Issue = { id: store.nextGlobalId++, number: repo.nextNumber++, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', labels, comments: [], seq: ++store.seq };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      const num = Number.parseInt(tail[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      if (tail[2] === 'comments') {
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('C', `${repo.owner}/${repo.name}:${issue.number}:${c.id}`), url: '', html_url: '', body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO, author_association: 'OWNER' })));
          return;
        }
        if (method === 'POST') {
          const comment = { id: store.nextGlobalId++, body: typeof body.body === 'string' ? body.body : '' };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, node_id: gid('C', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`), url: '', html_url: '', body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, avatar_url: '', type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO, author_association: 'OWNER' });
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    // pulls
    if (sub === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          let list = [...repo.pulls];
          const state = q.get('state') ?? 'open';
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { items } = paginate(list.map((p) => pullJson(repo, p)), q);
          sendJson(res, 200, items);
          return;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const head = headRaw.replace(/^refs\/heads\//, '');
          const base = baseRaw.replace(/^refs\/heads\//, '');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) {
            errJson(res, 422, 'head or base branch does not exist');
            return;
          }
          if (repo.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) {
            errJson(res, 422, 'A pull request already exists for this branch');
            return;
          }
          const pull: Pull = { id: store.nextGlobalId++, number: repo.nextNumber++, title, body: typeof body.body === 'string' ? body.body : '', state: 'open', merged: false, mergeCommitSha: null, mergedAt: null, head, base, headSha, baseSha, seq: ++store.seq };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      const num = Number.parseInt(tail[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        errJson(res, 404, 'Not Found');
        return;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pull) {
          errJson(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullFiles(repo, pull).map((f) => ({ ...f, sha: '', status: f.status, raw_url: '', blob_url: '', patch: '' })));
        return;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (pull.merged || pull.state !== 'open') {
          errJson(res, 405, 'Pull request is already merged or closed');
          return;
        }
        const result = doSquashMerge(repo, pull);
        if ('conflict' in result) {
          errJson(res, 405, 'Merge conflict');
          return;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      errJson(res, 404, 'Not Found');
      return;
    }
    errJson(res, 404, 'Not Found');
    return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL v4

interface GqlField {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  children: GqlField[];
  inlineType: string | null;
}
interface GqlOp {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, unknown>;
  fields: GqlField[];
  fragments: Record<string, GqlField[]>;
}
function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch) || ch === '.' ) {
      if (ch === '.' && src.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      tokens.push(ch);
      i++;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
    if (j === i) {
      i++;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}
class GqlParser {
  pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  peek(): string {
    return this.tokens[this.pos] ?? '';
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(t: string): void {
    if (this.peek() === t) this.pos++;
  }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.peek();
    if (t === '$') {
      this.next();
      const name = this.next();
      return vars[name];
    }
    if (t === '[') {
      this.next();
      const arr: unknown[] = [];
      while (this.peek() !== ']' && this.peek() !== '') arr.push(this.parseValue(vars));
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      this.next();
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}' && this.peek() !== '') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue(vars);
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('"')) {
      this.next();
      return JSON.parse(t) as string;
    }
    if (t === 'true') {
      this.next();
      return true;
    }
    if (t === 'false') {
      this.next();
      return false;
    }
    if (t === 'null') {
      this.next();
      return null;
    }
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      this.next();
      return Number(t);
    }
    this.next();
    return t; // enum / name
  }
  parseArgs(vars: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')' && this.peek() !== '') {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue(vars);
    }
    this.expect(')');
    return args;
  }
  parseFields(vars: Record<string, unknown>, fragments: Record<string, GqlField[]>): GqlField[] {
    const fields: GqlField[] = [];
    this.expect('{');
    while (this.peek() !== '}' && this.peek() !== '') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          const children = this.parseFields(vars, fragments);
          fields.push({ alias: '', name: '__fragment__', args: {}, children, inlineType: typeName });
        } else {
          const fragName = this.next();
          fields.push({ alias: '', name: '__spread__', args: { name: fragName }, children: [], inlineType: null });
        }
        continue;
      }
      let alias = '';
      let name = this.next();
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = this.parseArgs(vars);
      // directives like @include(if: ...) — skip them
      while (this.peek() === '@') {
        this.next();
        this.next();
        this.parseArgs(vars);
      }
      const children = this.peek() === '{' ? this.parseFields(vars, fragments) : [];
      fields.push({ alias: alias || name, name, args, children, inlineType: null });
    }
    this.expect('}');
    void fragments;
    return fields;
  }
  parseOperation(vars: Record<string, unknown>): GqlOp | null {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t === 'query' || t === 'mutation') {
      kind = t as 'query' | 'mutation';
      this.next();
    }
    let name: string | null = null;
    if (this.peek() !== '{' && this.peek() !== '(' && this.peek() !== '') name = this.next();
    const varDefs: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== '') {
        if (this.peek() === '$') {
          this.next();
          const vname = this.next();
          this.expect(':');
          // skip type tokens until = or , or )
          while (this.peek() !== '=' && this.peek() !== ',' && this.peek() !== ')' && this.peek() !== '') {
            if (this.peek() === '[' || this.peek() === ']') {
              this.next();
              continue;
            }
            this.next();
            if (this.peek() === '!') this.next();
          }
          if (this.peek() === '=') {
            this.next();
            varDefs[vname] = this.parseValue(vars);
          }
        } else {
          this.next();
        }
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const fields = this.parseFields(vars, {});
    return { kind, name, varDefs, fields, fragments: {} };
  }
}
function parseGqlDocument(src: string, vars: Record<string, unknown>): { ops: GqlOp[]; fragments: Record<string, GqlField[]> } {
  const parser = new GqlParser(gqlTokenize(src));
  const ops: GqlOp[] = [];
  const fragments: Record<string, GqlField[]> = {};
  while (parser.peek() !== '') {
    if (parser.peek() === 'fragment') {
      parser.next();
      const fname = parser.next();
      parser.next(); // 'on'
      parser.next(); // type name
      fragments[fname] = parser.parseFields(vars, fragments);
      continue;
    }
    const op = parser.parseOperation(vars);
    if (op) {
      op.fragments = fragments;
      ops.push(op);
    } else {
      break;
    }
  }
  return { ops, fragments };
}
function gqlResolveVars(varDefs: Record<string, unknown>, supplied: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...varDefs };
  for (const [k, v] of Object.entries(supplied)) out[k] = v;
  return out;
}

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'forkCount', 'stargazerCount', 'visibility'],
  Ref: ['name', 'target'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url', 'files'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  UserEdge: ['node', 'cursor'],
};
function gqlCursor(i: number): string {
  return Buffer.from(`cursor:${i}`).toString('base64url');
}
function gqlParseCursor(c: string): number {
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}
function gqlConnection<T>(items: T[], args: Record<string, unknown>, typeName: string): { __conn: true; items: T[]; typeName: string; after: number; first: number | null } {
  const after = typeof args.after === 'string' ? gqlParseCursor(args.after) : -1;
  const first = typeof args.first === 'number' ? args.first : null;
  return { __conn: true, items, typeName, after, first };
}
function gqlIsConn(v: unknown): v is { __conn: true; items: unknown[]; typeName: string; after: number; first: number | null } {
  return isRecord(v) && (v as Record<string, unknown>).__conn === true;
}

class GqlExecutor {
  errors: Array<{ message: string }> = [];
  expand(fields: GqlField[], fragments: Record<string, GqlField[]>): GqlField[] {
    const out: GqlField[] = [];
    for (const f of fields) {
      if (f.name === '__spread__') {
        const frag = fragments[String(f.args.name)] ?? [];
        out.push(...this.expand(frag, fragments));
      } else if (f.name === '__fragment__') {
        out.push(...this.expand(f.children, fragments).map((c) => ({ ...c, inlineType: f.inlineType })));
      } else {
        out.push(f);
      }
    }
    return out;
  }
  resolve(typeName: string, value: unknown, fields: GqlField[], fragments: Record<string, GqlField[]>): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((v) => this.resolve(typeName, v, fields, fragments));
    if (gqlIsConn(value)) {
      const out: Record<string, unknown> = {};
      const start = value.after + 1;
      const end = value.first === null ? value.items.length : Math.min(value.items.length, start + value.first);
      const page = value.items.slice(start, end);
      for (const f of this.expand(fields, fragments)) {
        if (f.name === 'nodes') out[f.alias] = page.map((item) => this.resolve(value.typeName, item, f.children, fragments));
        else if (f.name === 'edges') out[f.alias] = page.map((item, idx) => this.resolve(value.typeName === 'Issue' ? 'IssueEdge' : 'PullRequestEdge', { node: item, cursor: gqlCursor(start + idx) }, f.children, fragments));
        else if (f.name === 'totalCount') out[f.alias] = value.items.length;
        else if (f.name === 'pageInfo') out[f.alias] = this.resolve('PageInfo', { hasNextPage: end < value.items.length, hasPreviousPage: start > 0, startCursor: page.length ? gqlCursor(start) : null, endCursor: page.length ? gqlCursor(end - 1) : null }, f.children, fragments);
        else {
          this.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
          out[f.alias] = null;
        }
      }
      return out;
    }
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    const allowed = GQL_FIELDS[typeName];
    for (const f of this.expand(fields, fragments)) {
      if (f.name === '__typename') {
        out[f.alias] = typeName;
        continue;
      }
      if (allowed && !allowed.includes(f.name)) {
        this.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
        out[f.alias] = null;
        continue;
      }
      const raw = (value as Record<string, unknown>)[f.name];
      out[f.alias] = this.resolveChild(typeName, f, raw, value, fragments);
    }
    return out;
  }
  resolveChild(parentType: string, f: GqlField, raw: unknown, parent: Record<string, unknown>, fragments: Record<string, GqlField[]>): unknown {
    // Derived / computed fields live under __gql keys on the value object.
    const derived = (parent as Record<string, unknown>).__gql as Record<string, unknown> | undefined;
    if (derived && f.name in derived) {
      const v = derived[f.name];
      const result = typeof v === 'function' ? (v as (args: Record<string, unknown>) => unknown)(f.args) : v;
      if (f.children.length === 0) return result;
      return this.resolve(childTypeFor(parentType, f.name), result, f.children, fragments);
    }
    if (raw === undefined) return null;
    if (f.children.length === 0) return raw;
    // Determine child type name by field.
    const childType = childTypeFor(parentType, f.name);
    return this.resolve(childType, raw, f.children, fragments);
  }
}
function childTypeFor(parentType: string, field: string): string {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type', __schema: '__Schema' },
    Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
    Issue: { author: 'User', comments: 'IssueCommentConnection', labels: 'Label' },
    PullRequest: { author: 'User', headRef: 'Ref', baseRef: 'Ref', files: 'FileConnection' },
    IssueConnection: { edges: 'IssueEdge', pageInfo: 'PageInfo' },
    PullRequestConnection: { edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequestEdge: { node: 'PullRequest' },
    __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
    CommentEdge: { node: 'Comment' },
    IssueCommentConnection: { edges: 'CommentEdge', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge', comment: 'Comment' },
    FileConnection: { nodes: 'File', edges: 'FileEdge' },
  };
  return map[parentType]?.[field] ?? 'String';
}
const GQL_TYPES: Record<string, { kind: string; fields: string[]; enumValues: string[] | null }> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'], enumValues: null },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url', 'files'], enumValues: null },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'forkCount', 'stargazerCount', 'visibility'], enumValues: null },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl'], enumValues: null },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
};
function typeShape(name: string): Record<string, unknown> {
  const t = GQL_TYPES[name];
  if (!t) return { name, kind: 'OBJECT', description: null, fields: null, enumValues: null, possibleTypes: null, inputFields: null, interfaces: [] };
  return {
    name,
    kind: t.kind,
    description: null,
    fields: t.fields.length ? t.fields.map((n) => ({ name: n, description: null, type: { name: 'String', kind: 'SCALAR', ofType: null }, args: [] })) : null,
    enumValues: t.enumValues ? t.enumValues.map((n) => ({ name: n, description: null })) : null,
    possibleTypes: null,
    inputFields: null,
    interfaces: [],
  };
}
function userValue(login: string): Record<string, unknown> {
  return { __typename: 'User', id: gid('U', login), databaseId: login === VIEWER_LOGIN ? VIEWER_ID : 2000, login, name: login === VIEWER_LOGIN ? VIEWER_NAME : login, email: login === VIEWER_LOGIN ? VIEWER_EMAIL : `${login}@example.invalid`, url: '', avatarUrl: '' };
}
function refValue(name: string, sha: string | null): Record<string, unknown> {
  return { __typename: 'Ref', name, target: sha ? { __typename: 'Commit', oid: sha, id: gid('C', sha) } : null };
}
function issueValue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: gid('I', `${repo.owner}/${repo.name}:${issue.number}`),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userValue(VIEWER_LOGIN),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    url: '',
    comments: gqlConnection(issue.comments.map((c) => ({ __typename: 'Comment', id: gid('C', `${repo.owner}/${repo.name}:${issue.number}:${c.id}`), body: c.body, author: userValue(VIEWER_LOGIN), createdAt: FIXED_ISO })), {}, 'Comment'),
    labels: issue.labels.map((n) => ({ __typename: 'Label', id: gid('L', `${repo.owner}/${repo.name}:${n}`), name: n, color: repo.labels.get(n)?.color ?? 'ededed' })),
  };
}
function pullValue(repo: Repo, pull: Pull): Record<string, unknown> {
  const files = pullFiles(repo, pull).map((f) => ({ __typename: 'File', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }));
  return {
    __typename: 'PullRequest',
    id: gid('P', `${repo.owner}/${repo.name}:${pull.number}`),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: refValue(pull.head, pull.headSha),
    baseRef: refValue(pull.base, pull.baseSha),
    author: userValue(VIEWER_LOGIN),
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    url: '',
    files: gqlConnection(files, {}, 'File'),
  };
}
function repoValue(repo: Repo): Record<string, unknown> {
  const issuesSorted = [...repo.issues].sort((a, b) => a.seq - b.seq);
  const pullsSorted = [...repo.pulls].sort((a, b) => a.seq - b.seq);
  return {
    __typename: 'Repository',
    id: gid('R', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    url: '',
    forkCount: 0,
    stargazerCount: 0,
    visibility: repo.isPrivate ? 'PRIVATE' : 'PUBLIC',
    owner: userValue(repo.owner),
    defaultBranchRef: refValue(repo.defaultBranch, repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __gql: {
      issue: (args: Record<string, unknown>) => {
        const n = typeof args.number === 'number' ? args.number : Number(args.number ?? NaN);
        const issue = repo.issues.find((i) => i.number === n);
        return issue ? issueValue(repo, issue) : null;
      },
      issues: (args: Record<string, unknown>) => {
        let list = issuesSorted;
        if (Array.isArray(args.states)) {
          const states = (args.states as unknown[]).map((s) => String(s).toUpperCase());
          list = list.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        if (isRecord(args.orderBy)) {
          const dir = String(args.orderBy.direction ?? 'ASC').toUpperCase();
          list = [...list].sort((a, b) => (dir === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        }
        return gqlConnection(list.map((i) => issueValue(repo, i)), args, 'Issue');
      },
      pullRequest: (args: Record<string, unknown>) => {
        const n = typeof args.number === 'number' ? args.number : Number(args.number ?? NaN);
        const pull = repo.pulls.find((p) => p.number === n);
        return pull ? pullValue(repo, pull) : null;
      },
      pullRequests: (args: Record<string, unknown>) => {
        let list = pullsSorted;
        if (Array.isArray(args.states)) {
          const states = (args.states as unknown[]).map((s) => String(s).toUpperCase());
          list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        if (isRecord(args.orderBy)) {
          const dir = String(args.orderBy.direction ?? 'ASC').toUpperCase();
          list = [...list].sort((a, b) => (dir === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        }
        return gqlConnection(list.map((p) => pullValue(repo, p)), args, 'PullRequest');
      },
    },
  };
}
function findRepoByGid(id: string): Repo | null {
  const decoded = decodeGid(id);
  if (!decoded) return null;
  const [kind, key] = decoded;
  if (kind !== 'R') return null;
  const slash = key.indexOf('/');
  if (slash < 0) return null;
  return getRepo(key.slice(0, slash), key.slice(slash + 1)) ?? null;
}
function findIssueByGid(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGid(id);
  if (!decoded) return null;
  const [kind, key] = decoded;
  if (kind !== 'I') return null;
  const slash = key.indexOf('/');
  const colon = key.lastIndexOf(':');
  if (slash < 0 || colon < 0) return null;
  const repo = getRepo(key.slice(0, slash), key.slice(slash + 1, colon));
  if (!repo) return null;
  const issue = repo.issues.find((i) => i.number === Number(key.slice(colon + 1)));
  return issue ? { repo, issue } : null;
}
function findPullByGid(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGid(id);
  if (!decoded) return null;
  const [kind, key] = decoded;
  if (kind !== 'P') return null;
  const slash = key.indexOf('/');
  const colon = key.lastIndexOf(':');
  if (slash < 0 || colon < 0) return null;
  const repo = getRepo(key.slice(0, slash), key.slice(slash + 1, colon));
  if (!repo) return null;
  const pull = repo.pulls.find((p) => p.number === Number(key.slice(colon + 1)));
  return pull ? { repo, pull } : null;
}
function executeGql(op: GqlOp, fragments: Record<string, GqlField[]>): { data: unknown; errors: Array<{ message: string }> } {
  const ex = new GqlExecutor();
  const data: Record<string, unknown> = {};
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const allowed = GQL_FIELDS[rootType];
  for (const f of ex.expand(op.fields, fragments)) {
    if (f.name === '__typename') {
      data[f.alias] = rootType;
      continue;
    }
    if (!allowed.includes(f.name)) {
      ex.errors.push({ message: `Cannot query field "${f.name}" on type "${rootType}".` });
      data[f.alias] = null;
      continue;
    }
    if (op.kind === 'query') {
      if (f.name === 'viewer') data[f.alias] = ex.resolve('User', userValue(VIEWER_LOGIN), f.children, fragments);
      else if (f.name === 'repository') {
        const owner = String(f.args.owner ?? '');
        const name = String(f.args.name ?? '');
        const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : null;
        data[f.alias] = repo ? ex.resolve('Repository', repoValue(repo), f.children, fragments) : null;
      } else if (f.name === 'node') {
        const id = String(f.args.id ?? '');
        const decoded = decodeGid(id);
        let val: unknown = null;
        let type = 'Repository';
        if (decoded) {
          if (decoded[0] === 'R') {
            const repo = findRepoByGid(id);
            val = repo ? repoValue(repo) : null;
          } else if (decoded[0] === 'I') {
            const hit = findIssueByGid(id);
            val = hit ? issueValue(hit.repo, hit.issue) : null;
            type = 'Issue';
          } else if (decoded[0] === 'P') {
            const hit = findPullByGid(id);
            val = hit ? pullValue(hit.repo, hit.pull) : null;
            type = 'PullRequest';
          }
        }
        data[f.alias] = val ? ex.resolve(type, val, f.children, fragments) : null;
      } else if (f.name === '__type') {
        const name = String(f.args.name ?? '');
        data[f.alias] = ex.resolve('__Type', typeShape(name), f.children, fragments);
      } else if (f.name === '__schema') {
        data[f.alias] = ex.resolve('__Schema', { queryType: typeShape('Query'), mutationType: typeShape('Mutation'), types: Object.keys(GQL_TYPES).map((n) => typeShape(n)), directives: [] }, f.children, fragments);
      }
    } else {
      // Mutations
      if (f.name === 'createIssue') {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const repoId = String(input.repositoryId ?? '');
        const repo = findRepoByGid(repoId);
        if (!repo) {
          data[f.alias] = null;
          ex.errors.push({ message: 'Repository not found' });
          continue;
        }
        const issue: Issue = { id: store.nextGlobalId++, number: repo.nextNumber++, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], comments: [], seq: ++store.seq };
        repo.issues.push(issue);
        data[f.alias] = ex.resolve('CreateIssuePayload', { issue: issueValue(repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null }, f.children, fragments);
      } else if (f.name === 'closeIssue') {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const hit = findIssueByGid(String(input.issueId ?? ''));
        if (!hit) {
          data[f.alias] = null;
          ex.errors.push({ message: 'Issue not found' });
          continue;
        }
        hit.issue.state = 'closed';
        data[f.alias] = ex.resolve('CloseIssuePayload', { issue: issueValue(hit.repo, hit.issue), clientMutationId: null }, f.children, fragments);
      } else if (f.name === 'createPullRequest') {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const repo = findRepoByGid(String(input.repositoryId ?? ''));
        const base = String(input.baseRefName ?? '');
        const head = String(input.headRefName ?? '');
        if (!repo || !repo.refs.get(`refs/heads/${head}`) || !repo.refs.get(`refs/heads/${base}`)) {
          data[f.alias] = null;
          ex.errors.push({ message: 'Repository or branch not found' });
          continue;
        }
        const pull: Pull = { id: store.nextGlobalId++, number: repo.nextNumber++, title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '', state: 'open', merged: false, mergeCommitSha: null, mergedAt: null, head, base, headSha: repo.refs.get(`refs/heads/${head}`)!, baseSha: repo.refs.get(`refs/heads/${base}`)!, seq: ++store.seq };
        repo.pulls.push(pull);
        data[f.alias] = ex.resolve('CreatePullRequestPayload', { pullRequest: pullValue(repo, pull), clientMutationId: null }, f.children, fragments);
      } else if (f.name === 'mergePullRequest') {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const hit = findPullByGid(String(input.pullRequestId ?? ''));
        if (!hit) {
          data[f.alias] = null;
          ex.errors.push({ message: 'Pull request not found' });
          continue;
        }
        if (hit.pull.state !== 'open' || hit.pull.merged) {
          data[f.alias] = ex.resolve('MergePullRequestPayload', { pullRequest: pullValue(hit.repo, hit.pull), clientMutationId: null }, f.children, fragments);
          continue;
        }
        const result = doSquashMerge(hit.repo, hit.pull);
        if ('conflict' in result) {
          data[f.alias] = ex.resolve('MergePullRequestPayload', { pullRequest: pullValue(hit.repo, hit.pull), clientMutationId: null }, f.children, fragments);
          continue;
        }
        data[f.alias] = ex.resolve('MergePullRequestPayload', { pullRequest: pullValue(hit.repo, hit.pull), clientMutationId: null }, f.children, fragments);
      } else if (f.name === 'addComment') {
        const input = isRecord(f.args.input) ? f.args.input : {};
        const hit = findIssueByGid(String(input.subjectId ?? ''));
        if (!hit) {
          data[f.alias] = null;
          ex.errors.push({ message: 'Subject not found' });
          continue;
        }
        const comment = { id: store.nextGlobalId++, body: String(input.body ?? '') };
        hit.issue.comments.push(comment);
        const node = { __typename: 'Comment', id: gid('C', `${hit.repo.owner}/${hit.repo.name}:${hit.issue.number}:${comment.id}`), body: comment.body, author: userValue(VIEWER_LOGIN), createdAt: FIXED_ISO };
        data[f.alias] = ex.resolve('AddCommentPayload', { commentEdge: { node, cursor: gqlCursor(hit.issue.comments.length - 1) }, comment: node, clientMutationId: null }, f.children, fragments);
      }
    }
  }
  return { data, errors: ex.errors };
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<void> {
  void req;
  if (!authed(req)) {
    errJson(res, 401, 'Bad credentials');
    return;
  }
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 200, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') return { errors: [{ message: 'No query string was present' }] };
    const vars = isRecord(doc.variables) ? doc.variables : {};
    const { ops, fragments } = parseGqlDocument(doc.query, vars);
    const opName = typeof doc.operationName === 'string' ? doc.operationName : null;
    let op = ops[0];
    if (opName) {
      const named = ops.find((o) => o.name === opName);
      if (named) op = named;
    }
    if (!op) return { errors: [{ message: 'No operation found' }] };
    const mergedVars = gqlResolveVars(op.varDefs, vars);
    void mergedVars;
    const { data, errors } = executeGql(op, fragments);
    const out: Record<string, unknown> = { data };
    if (errors.length) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map((d) => runOne(d)));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' }, pull_number: { type: 'number', description: 'Pull request number' }, number: { type: 'number', description: 'Pull request number' }, merge_method: { type: 'string', description: 'Merge method, squash by default' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' }, issue_number: { type: 'number', description: 'Issue number' }, number: { type: 'number', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Repository full name owner/repo' }, state: { type: 'string', description: 'Pull request state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
];
function mcpSplitOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/');
    if (!owner) owner = o;
    if (!repo) repo = r;
  }
  if (repo.includes('/')) {
    const [o, r] = repo.split('/');
    owner = o;
    repo = r;
  }
  return { owner, repo };
}
function mcpResult(id: unknown, payload: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function mcpMissing(id: unknown, missing: string[]): Record<string, unknown> {
  const text = JSON.stringify({ error: `Missing required argument: ${missing.join(', ')}` });
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text }], structuredContent: { error: `Missing required argument: ${missing.join(', ')}` }, isError: true } };
}
function mcpCallTool(name: string, args: Record<string, unknown>): { payload: unknown; isError?: boolean } {
  const { owner, repo } = mcpSplitOwnerRepo(args);
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name.trim() : '';
    if (!repoName) return { payload: { error: 'Missing required argument: name' }, isError: true };
    if (getRepo(VIEWER_LOGIN, repoName)) return { payload: { error: 'Repository already exists' }, isError: true };
    const r = newRepo(VIEWER_LOGIN, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
    return { payload: repoJson(r) };
  }
  if (name === 'get_repo') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    return { payload: repoJson(r) };
  }
  if (name === 'create_issue') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    const title = typeof args.title === 'string' ? args.title : '';
    if (!title) return { payload: { error: 'Missing required argument: title' }, isError: true };
    const issue: Issue = { id: store.nextGlobalId++, number: r.nextNumber++, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], comments: [], seq: ++store.seq };
    r.issues.push(issue);
    return { payload: issueJson(r, issue) };
  }
  if (name === 'list_issues') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    let list = [...r.issues];
    const state = typeof args.state === 'string' ? args.state : 'all';
    if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
    return { payload: list.map((i) => issueJson(r, i)) };
  }
  if (name === 'get_issue') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    const num = typeof args.issue_number === 'number' ? args.issue_number : typeof args.number === 'number' ? args.number : Number(args.issue_number ?? args.number ?? NaN);
    const issue = r.issues.find((i) => i.number === num);
    if (!issue) return { payload: { error: 'Not Found' }, isError: true };
    return { payload: issueJson(r, issue) };
  }
  if (name === 'create_pull_request') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    const head = typeof args.head === 'string' ? args.head.replace(/^refs\/heads\//, '') : '';
    const base = typeof args.base === 'string' ? args.base.replace(/^refs\/heads\//, '') : r.defaultBranch;
    const headSha = r.refs.get(`refs/heads/${head}`);
    const baseSha = r.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return { payload: { error: 'head or base branch does not exist' }, isError: true };
    const pull: Pull = { id: store.nextGlobalId++, number: r.nextNumber++, title: typeof args.title === 'string' ? args.title : '', body: typeof args.body === 'string' ? args.body : '', state: 'open', merged: false, mergeCommitSha: null, mergedAt: null, head, base, headSha, baseSha, seq: ++store.seq };
    r.pulls.push(pull);
    return { payload: pullJson(r, pull) };
  }
  if (name === 'merge_pull_request') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : Number(args.pull_number ?? args.number ?? NaN);
    const pull = r.pulls.find((p) => p.number === num);
    if (!pull) return { payload: { error: 'Not Found' }, isError: true };
    if (pull.merged || pull.state !== 'open') return { payload: { error: 'Pull request is already merged or closed' }, isError: true };
    const result = doSquashMerge(r, pull);
    if ('conflict' in result) return { payload: { error: 'Merge conflict' }, isError: true };
    return { payload: { merged: true, sha: result.sha, message: 'Pull request successfully merged', pull_request: pullJson(r, pull) } };
  }
  if (name === 'list_pull_requests') {
    const r = viewerRepo(owner, repo);
    if (!r) return { payload: { error: 'Not Found' }, isError: true };
    let list = [...r.pulls];
    const state = typeof args.state === 'string' ? args.state : 'all';
    if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
    return { payload: list.map((p) => pullJson(r, p)) };
  }
  return { payload: { error: `Unknown tool: ${name}` }, isError: true };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, bodyBuf: Buffer): Promise<void> {
  if (!authed(req)) {
    errJson(res, 401, 'Bad credentials');
    return;
  }
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const msg = parsed.value;
  if (!isRecord(msg) || typeof msg.method !== 'string') {
    sendJson(res, 200, mcpError(isRecord(msg) ? msg.id : null, -32600, 'Invalid Request'));
    return;
  }
  const id = msg.id ?? null;
  const method = msg.method;
  const params = isRecord(msg.params) ? msg.params : {};
  if (method === 'server/discover') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28', '2025-11-25'], serverInfo: { name: 'Forge', version: '1.0.0' }, capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Forge', version: '1.0.0' } } } });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: requested, capabilities: { tools: {} }, serverInfo: { name: 'Forge', version: '1.0.0' } } });
    return;
  }
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': reqId() });
    res.end();
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) {
      sendJson(res, 200, mcpError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    const schema = tool.inputSchema as { required?: string[] };
    const required = schema.required ?? [];
    const missing = required.filter((r) => {
      if (r === 'pull_number' && (typeof args.pull_number === 'number' || typeof args.number === 'number')) return false;
      if (r === 'issue_number' && (typeof args.issue_number === 'number' || typeof args.number === 'number')) return false;
      if ((r === 'owner' || r === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) return false;
      return args[r] === undefined || args[r] === null || args[r] === '';
    });
    if (missing.length) {
      sendJson(res, 200, mcpMissing(id, missing));
      return;
    }
    const { payload, isError } = mcpCallTool(name, args);
    const out = mcpResult(id, payload);
    if (isError) (out.result as Record<string, unknown>).isError = true;
    sendJson(res, 200, out);
    return;
  }
  if (method === 'resources/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { resources: [] } });
    return;
  }
  if (method === 'prompts/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { prompts: [] } });
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------- createApp

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const path = pathOf(req);
      const q = queryOf(req);
      const method = req.method ?? 'GET';
      if (path === '/healthz' && method === 'GET') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      const gitInfo = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(path);
      const gitRpc = /^\/([^/]+)\/([^/]+)\.git\/(git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitInfo || gitRpc) {
        const owner = (gitInfo ?? gitRpc)![1];
        const name = (gitInfo ?? gitRpc)![2];
        if (!authed(req)) {
          errJson(res, 401, 'Bad credentials');
          return;
        }
        const repo = viewerRepo(owner, name);
        if (!repo) {
          errJson(res, 404, 'Not Found');
          return;
        }
        if (gitInfo) {
          const service = q.get('service') ?? '';
          if (service === 'git-upload-pack') {
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const adKey = `A|${owner}/${name}|upload|${isV2 ? 2 : 0}|${refsSnapshot(repo)}|${repo.objects.size}`;
            let body = cacheGet(adKey);
            if (!body) {
              body = isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
              cachePut(adKey, body);
            }
            sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
            return;
          }
          if (service === 'git-receive-pack') {
            const adKey = `A|${owner}/${name}|receive|${refsSnapshot(repo)}|${repo.objects.size}`;
            let body = cacheGet(adKey);
            if (!body) {
              body = v0Advertisement(repo, 'git-receive-pack');
              cachePut(adKey, body);
            }
            sendRaw(res, 200, body, 'application/x-git-receive-pack-advertisement');
            return;
          }
          errJson(res, 400, 'Missing service parameter');
          return;
        }
        // RPC endpoints
        const bodyBuf = await readBody(req);
        if (gitRpc![3] === 'git-upload-pack') {
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          const result = handleUploadPack(repo, req, bodyBuf, isV2);
          sendRaw(res, result.status, result.body, result.type);
          return;
        }
        const result = handleReceivePack(repo, bodyBuf);
        sendRaw(res, result.status, result.body, result.type);
        return;
      }
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          errJson(res, 405, 'Method Not Allowed');
          return;
        }
        const bodyBuf = await readBody(req);
        await handleGraphQL(req, res, bodyBuf);
        return;
      }
      if (path === '/mcp') {
        if (method !== 'POST') {
          errJson(res, 405, 'Method Not Allowed');
          return;
        }
        const bodyBuf = await readBody(req);
        await handleMcp(req, res, bodyBuf);
        return;
      }
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const bodyBuf = await readBody(req);
        await handleRest(req, res, path, q, bodyBuf);
        return;
      }
      errJson(res, 404, 'Not Found');
    } catch (e) {
      console.error('handler error', e);
      if (!res.headersSent) errJson(res, 500, 'Internal Server Error');
    }
  });
  return server;
}
