// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break, and whether it ends with one (section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line's key at a matching tier (section 5). */
function lineKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in lines at tier (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const keys = o.map((l) => lineKey(l, tier));
  const out: number[] = [];
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (lineKey(lines[i + k]!, tier) !== keys[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of a hunk or chunk body: a context line, an old line or a new line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

/**
 * The lines that replace a match: context lines are the file's own matched lines, and at tier 2 the
 * other lines are re-indented from the old lines' leading whitespace to the file's (section 5).
 */
function buildN(items: BodyLine[], fileLines: string[], at: number, tier: number): string[] {
  const o: string[] = [];
  for (const it of items) if (it.kind !== 'new') o.push(it.text);
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (it.kind === 'old') {
      oi += 1;
    } else if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(p)) {
      out.push(f + it.text.slice(p.length));
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit made, as (old path, new path), in the patch's order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                          */
/* ------------------------------------------------------------------ */

/** One unified hunk. */
interface Hunk {
  /** The hunk header's old start line (1-based). */
  a: number;
  items: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

/** One unified section: one edit. Paths are null for `/dev/null`. */
interface Section {
  oldPath: string | null;
  newPath: string | null;
  /** A `---`/`+++` pair named the paths (it beats `rename from`/`to`). */
  pair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.*) b\/(.*)$/;

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  return p.trim();
}

/** A diff path: `/dev/null` means no file, and a leading `a/` or `b/` is removed. */
function diffPath(raw: string): string | null {
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let { br, lines, final } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    for (const it of h.items) if (it.kind !== 'new') o.push(it.text);
    if (o.length === 0) {
      const ins: string[] = [];
      for (const it of h.items) if (it.kind === 'new') ins.push(it.text);
      const oldLen = lines.length;
      const pos = Math.max(0, Math.min(h.a + d, oldLen));
      const atEnd = pos === oldLen;
      lines.splice(pos, 0, ...ins);
      if (atEnd) final = !h.noEol;
      d += ins.length;
    } else {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const at = best;
      const n = buildN(h.items, lines, at, found.tier);
      const atEnd = at + o.length === lines.length;
      lines.splice(at, o.length, ...n);
      if (atEnd) final = !h.noEol;
      d += n.length - o.length;
    }
  }
  return joinFile(lines, br, final);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pair ? sec.oldPath : (sec.renameFrom ?? sec.oldPath);
    const newP = sec.pair ? sec.newPath : (sec.renameTo ?? sec.newPath);
    if (oldP === null && newP === null) return;
    if ((sec.isCreate || oldP === null) && newP !== null) {
      const p = newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.items.some((it) => it.kind === 'new')) {
          noEol = h.noEolPlus;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.isDelete || newP === null) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (oldPath: string | null, newPath: string | null, pair: boolean): Section => {
    const s: Section = { oldPath, newPath, pair, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  const isPair = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      inHeader = false;
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const items: BodyLine[] = [];
      for (const b of body) {
        if (b === '') items.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') items.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') items.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') items.push({ kind: 'new', text: b.slice(1) });
      }
      let noEol = false;
      let noEolPlus = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const b = body[k]!;
        if (b === '' || b[0] === ' ' || b[0] === '+') {
          noEol = k + 1 < body.length && body[k + 1]![0] === '\\';
          break;
        }
      }
      for (let k = body.length - 1; k >= 0; k--) {
        const b = body[k]!;
        if (b[0] === '+') {
          noEolPlus = k + 1 < body.length && body[k + 1]![0] === '\\';
          break;
        }
      }
      cur.hunks.push({ a, items, noEol, noEolPlus });
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!, false);
      i += 1;
      continue;
    }
    if (isPair(i)) {
      if (cur !== null && inHeader) {
        cur.oldPath = diffPath(headerPath(lines[i]!));
        cur.newPath = diffPath(headerPath(lines[i + 1]!));
        cur.pair = true;
      } else {
        newSection(diffPath(headerPath(lines[i]!)), diffPath(headerPath(lines[i + 1]!)), true);
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l === 'new file mode' || l.startsWith('new file mode ')) cur.isCreate = true;
      else if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                  */
/* ------------------------------------------------------------------ */

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { br, lines: fileLines, final } = splitFile(before);
      const found = findTier(fileLines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const at = found.pos[0]!;
      const items: BodyLine[] = [
        ...oldLines.map((t): BodyLine => ({ kind: 'old' as const, text: t })),
        ...newLines.map((t): BodyLine => ({ kind: 'new' as const, text: t })),
      ];
      const n = buildN(items, fileLines, at, found.tier);
      fileLines.splice(at, oldLines.length, ...n);
      tree.now.set(p, joinFile(fileLines, br, final));
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                            */
/* ------------------------------------------------------------------ */

interface VChunk {
  /** The anchor text, or null for no anchor. */
  anchor: string | null;
  /** The chunk ends with `*** End of File`: it is anchored to the end of the file. */
  eof: boolean;
  items: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** For an Add File section: the file's lines. */
  lines: string[];
  chunks: VChunk[];
  /** The section header's line number, for the no-chunk parse error. */
  lineNo: number;
}

function applyV4AChunks(text: string, chunks: VChunk[], strict: boolean, path: string): string {
  let { br, lines, final } = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundIdx = -1;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && foundIdx < 0; t++) {
        const key = lineKey(ch.anchor, t);
        for (let j = cursor; j < lines.length; j++) {
          if (lineKey(lines[j]!, t) === key) {
            foundIdx = j;
            break;
          }
        }
      }
      if (foundIdx < 0) throw new Fail('no-match', path);
      cursor = foundIdx + 1;
    }
    const o: string[] = [];
    for (const it of ch.items) if (it.kind !== 'new') o.push(it.text);
    if (o.length === 0) {
      const ins: string[] = [];
      for (const it of ch.items) if (it.kind === 'new') ins.push(it.text);
      const pos = ch.eof ? lines.length : cursor;
      lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
    } else {
      let found: { tier: number; pos: number } | null = null;
      const top = strict ? 0 : 2;
      for (let t = 0; t <= top && found === null; t++) {
        for (const p of occurrences(lines, o, t)) {
          if (p < cursor) continue;
          if (ch.eof && p + o.length !== lines.length) continue;
          found = { tier: t, pos: p };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const n = buildN(ch.items, lines, found.pos, found.tier);
      lines.splice(found.pos, o.length, ...n);
      cursor = found.pos + n.length;
    }
  }
  return joinFile(lines, br, final);
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const out = applyV4AChunks(before, sec.chunks, strict, p);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else {
      kind = 'update';
      path = l.slice(17).trim();
    }
    const lineNo = i + 1;
    i += 1;
    const raw: number[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push(i);
      i += 1;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const j of raw) {
        const rl = lines[j]!;
        if (rl === '') content.push('');
        else if (rl[0] === '+') content.push(rl.slice(1));
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push({ kind, path, moveTo: null, lines: content, chunks: [], lineNo });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]! + 1}`);
      sections.push({ kind, path, moveTo: null, lines: [], chunks: [], lineNo });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (k < raw.length && lines[raw[k]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[raw[k]!]!.slice('*** Move to: '.length).trim();
        k += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const j = raw[k]!;
        const rl = lines[j]!;
        if (rl.startsWith('@@')) {
          const anchor = rl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          chunks.push(cur);
        } else if (rl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          cur = null;
        } else if (rl === '' || rl[0] === ' ' || rl[0] === '-' || rl[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (rl === '') cur.items.push({ kind: 'ctx', text: '' });
          else if (rl[0] === ' ') cur.items.push({ kind: 'ctx', text: rl.slice(1) });
          else if (rl[0] === '-') cur.items.push({ kind: 'old', text: rl.slice(1) });
          else cur.items.push({ kind: 'new', text: rl.slice(1) });
        } else {
          throw new Exit2(`error: parse ${j + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind, path, moveTo, lines: [], chunks, lineNo });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (sections 1, 2 and 10)           */
/* ------------------------------------------------------------------ */

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [op, np] of tree.moves) {
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      covered.add(op);
      covered.add(np);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    const changed = [...tree.now.keys()].sort(byteOrder);
    for (const p of changed) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
