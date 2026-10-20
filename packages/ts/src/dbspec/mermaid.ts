// Writes and reads a dbspec document as a standard Mermaid erDiagram (docs/spec/mermaid.md).
// The reference is the Go engine (engine/dbspec/mermaid.go), and the text, document, omitted objects and diagnostics are
// the same bytes as Go. Regex whitespace is written as Go's \s([\t\n\f\r ]).
import { present } from '../present.js';
import { typeText } from './emit.js';
import { byteOrder, Catalog, type DbspecUnsupported, type ITable } from './introspect_catalog.js';
import type { DbspecDiagnostic, DbspecDocument, DbspecSettings, DbspecTable, DbspecType } from './model.js';
import { validName } from './parse.js';
import { sortedBy } from './sort.js';

/** The Mermaid text and what export left out, ordered by table, kind and name. */
export interface DbspecMermaidExport {
  readonly mermaid: string;
  readonly dropped: readonly DbspecUnsupported[];
}

/** The imported document and what import left out, or the `mermaid` diagnostics and no document. */
export type DbspecMermaidImport =
  | { readonly document: DbspecDocument; readonly dropped: readonly DbspecUnsupported[]; readonly diagnostics: readonly [] }
  | { readonly document: null; readonly dropped: null; readonly diagnostics: readonly DbspecDiagnostic[] };

/**
 * Writes one document as a standard Mermaid erDiagram and lists what the
 * diagram cannot hold as [kind, table, name] in table, kind and name order
 * (docs/spec/mermaid.md "Export").
 */
export function exportMermaid(document: DbspecDocument): DbspecMermaidExport {
  const input: unknown = document;
  if (input === null || typeof input !== 'object' || !Array.isArray(Reflect.get(input, 'tables'))) {
    throw new TypeError('exportMermaid takes a parsed dbspec document');
  }
  const dropped: DbspecUnsupported[] = [];
  const report = (kind: string, table: string, name: string, reason: string): void => {
    dropped.push(Object.freeze({ kind, table, name, reason }));
  };
  for (const u of document.uses) {
    report('use', '', u.document, 'export writes the tables of one document; used tables appear only as relationship ends');
    if (u.comments.length > 0) report('comment', '', u.document, 'Mermaid has no comments on use lines');
  }
  for (const g of document.diagrams) {
    report('diagram', '', g.name, 'a dbspec diagram has no Mermaid form');
    if (g.comments.length > 0 || g.closingComments.length > 0 || g.placements.some(p => p.comments.length > 0)) {
      report('comment', '', g.name, 'Mermaid has no diagram comments');
    }
  }
  if (document.closingComments.length > 0) report('comment', '', document.name, 'Mermaid has no comments after the last block');
  const tables: DbspecTable[] = [...document.tables].sort((a, b) => byteOrder(a.name, b.name));
  let out = 'erDiagram\n';
  for (const t of tables) {
    if (t.comments.length > 0 || t.closingComments.length > 0 || t.primaryKey.comments.length > 0 || settingsCommented(t.settings)) {
      report('comment', t.name, t.name, 'Mermaid has no comments on the table, primary key and settings lines');
    }
    out += `    ${t.name} {\n`;
    for (const c of t.columns) {
      if (c.comments.length > 0) report('comment', t.name, c.name, 'Mermaid has no column comments');
      let line = `        ${mermaidType(c.type)} ${c.name}`;
      const keys: string[] = [];
      if (t.primaryKey.columns.includes(c.name)) keys.push('PK');
      if (t.foreignKeys.some(f => f.columns.includes(c.name))) keys.push('FK');
      if (t.uniques.some(u => u.columns.includes(c.name))) keys.push('UK');
      if (keys.length > 0) line += ' ' + keys.join(', ');
      const suffix: string[] = [];
      if (c.nullable) suffix.push('null');
      if (c.identity) suffix.push('identity');
      if (c.default !== null) {
        const literal = c.default.kind === 'now' ? 'now' : c.default.text;
        if (literal.includes('"')) {
          report('default', t.name, c.name, 'a Mermaid comment cannot hold the default, which contains a double quote');
        } else {
          suffix.push('default ' + literal);
        }
      }
      if (suffix.length > 0) line += ` "${suffix.join(' ')}"`;
      out += line + '\n';
    }
    out += '    }\n';
    const keyComment = (name: string, comments: readonly string[]): void => {
      if (comments.length > 0) report('comment', t.name, name, 'Mermaid has no key comments');
    };
    for (const u of t.uniques) {
      report('unique', t.name, u.name, 'Mermaid marks the columns of a unique key with UK but has no key');
      keyComment(u.name, u.comments);
    }
    for (const x of t.indexes) {
      report('index', t.name, x.name, 'Mermaid has no indexes');
      keyComment(x.name, x.comments);
    }
    for (const k of t.checks) {
      report('check', t.name, k.name, 'Mermaid has no checks');
      keyComment(k.name, k.comments);
    }
    for (const f of t.foreignKeys) {
      if (f.onDelete !== 'restrict' || f.onUpdate !== 'restrict') report('foreign_key', t.name, f.name, 'Mermaid has no foreign key actions');
      keyComment(f.name, f.comments);
    }
    if (t.settings !== null) report('settings', t.name, t.name, 'Mermaid has no settings');
  }
  for (const t of tables) {
    for (const f of sortedBy(t.foreignKeys, f => f.name)) {
      const nullable = f.columns.some(name => t.columns.find(c => c.name === name)?.nullable === true);
      const marker = nullable ? '|o--o{' : '||--o{';
      out += `    ${f.table} ${marker} ${t.name} : "${f.name} (${f.columns.join(', ')}) references (${f.references.join(', ')})"\n`;
    }
  }
  const key = (u: DbspecUnsupported): string => `${u.table}\x00${u.kind}\x00${u.name}`;
  dropped.sort((a, b) => byteOrder(key(a), key(b)));
  return Object.freeze({ mermaid: out, dropped: Object.freeze(dropped) });
}

/** Tells whether the opening line, a setting line, or the closing line of a settings block has a comment. */
function settingsCommented(s: DbspecSettings | null): boolean {
  return s !== null && (s.comments.length > 0 || s.closingComments.length > 0 || s.settings.some(x => x.comments.length > 0));
}

/** Mermaid types have no commas, so decimal(p,s) is written as decimal(p-s). */
function mermaidType(t: DbspecType): string {
  return t.kind === 'decimal' ? `decimal(${t.precision}-${t.scale})` : typeText(t);
}

// In Go regexp, \s is [\t\n\f\r ].
const S = '[\\t\\n\\f\\r ]';
const ENTITY_NAME = '([A-Za-z0-9_-]+|"[^"]*")';
const ENTITY_START = new RegExp(`^${ENTITY_NAME}${S}*\\{$`);
const ATTRIBUTE = new RegExp(
  `^([A-Za-z][A-Za-z0-9_()\\[\\]-]*)${S}+([A-Za-z_*][A-Za-z0-9_-]*)((?:${S}+(?:PK|FK|UK)(?:${S}*,${S}*(?:PK|FK|UK))*)?)(?:${S}+"([^"]*)")?$`,
);
const RELATION = new RegExp(
  `^${ENTITY_NAME}${S}+(\\|o|\\|\\||\\}o|\\}\\|)(--|\\.\\.)(o\\||\\|\\||o\\{|\\|\\{)${S}+${ENTITY_NAME}${S}*:${S}*("[^"]*"|[^\\t\\n\\f\\r "]+)$`,
);
const LABEL = /^([a-z][a-z0-9_]*) \(([a-z0-9_, ]+)\) references \(([a-z0-9_, ]+)\)$/;
// Matches text with one space added after the comment. Each part must end with one space, so
// there is exactly one space between the parts. In Go, . matches every character except \n.
const SUFFIX = /^(?:(null) )?(?:(identity) )?(?:default ([^\n]+) )?$/;
/** The kinds of the types without parameters, the first group of KNOWN_TYPE. */
const SIMPLE_KINDS = ['i16', 'i32', 'i64', 'bool', 'f64', 'text', 'bytes', 'uuid', 'date'] as const;
const KNOWN_TYPE = /^(i16|i32|i64|bool|f64|text|bytes|uuid|date)$|^varchar\((\d+)\)$|^(time|datetime)\((\d)\)$|^decimal\((\d+)-(\d+)\)$/;
// The Unicode whitespace that Go strings.TrimSpace removes.
const GO_SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const TRIM_SPACE = new RegExp(`^${GO_SPACE}+|${GO_SPACE}+$`, 'g');

function trimSpace(s: string): string {
  return s.replace(TRIM_SPACE, '');
}

/** Removes all the leading and trailing double quotes, like Go's strings.Trim(s, `"`). */
function trimQuotes(s: string): string {
  return s.replace(/^"+|"+$/g, '');
}

interface MermaidAttribute {
  type: string;
  name: string;
  comment: string;
  keys: string[];
}

interface MermaidEntity {
  name: string;
  attributes: MermaidAttribute[];
}

interface MermaidRelation {
  left: string;
  right: string;
  leftCard: string;
  rightCard: string;
  label: string;
}

/**
 * Reads a standard Mermaid erDiagram into a dbspec document named `name` and
 * lists what it does not carry over (docs/spec/mermaid.md "Import"). A line that
 * does not follow the grammar is a `mermaid` diagnostic at its line.
 */
export function importMermaid(text: string, name: string): DbspecMermaidImport {
  if (typeof text !== 'string') throw new TypeError('Mermaid text must be a string');
  if (typeof name !== 'string') throw new TypeError('dbspec document name must be a string');
  const fail = (line: number, message: string): DbspecMermaidImport =>
    Object.freeze({ document: null, dropped: null, diagnostics: Object.freeze([Object.freeze({ rule: 'mermaid' as const, line, column: 1, message })]) });
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const entities: MermaidEntity[] = [];
  const byName = new Map<string, MermaidEntity>();
  const entity = (raw: string): MermaidEntity => {
    const n = trimQuotes(raw);
    let e = byName.get(n);
    if (e === undefined) {
      e = { name: n, attributes: [] };
      byName.set(n, e);
      entities.push(e);
    }
    return e;
  };
  const relations: MermaidRelation[] = [];
  let open: MermaidEntity | null = null;
  let header = false;
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const line = trimSpace(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line === '' || line.startsWith('%%')) continue;
    if (!header) {
      if (line !== 'erDiagram') return fail(n, 'a Mermaid entity relationship diagram starts with erDiagram');
      header = true;
      continue;
    }
    if (open !== null) {
      if (line === '}') {
        open = null;
        continue;
      }
      const m = ATTRIBUTE.exec(line);
      if (m === null) return fail(n, 'an attribute is <type> <name> [PK|FK|UK, ...] ["comment"]');
      const keys = present(m[3], 'm[3]').split(',').map(k => trimSpace(k)).filter(k => k !== '');
      open.attributes.push({ type: present(m[1], 'm[1]'), name: present(m[2], 'm[2]'), comment: m[4] ?? '', keys });
      continue;
    }
    const start = ENTITY_START.exec(line);
    if (start !== null) {
      open = entity(present(start[1], 'start[1]'));
      continue;
    }
    const r = RELATION.exec(line);
    if (r !== null) {
      relations.push({ left: entity(present(r[1], 'r[1]')).name, leftCard: present(r[2], 'r[2]'), rightCard: present(r[4], 'r[4]'), right: entity(present(r[5], 'r[5]')).name, label: trimQuotes(present(r[6], 'r[6]')) });
      continue;
    }
    return fail(n, 'a line is an entity block, an attribute, a relationship, a %% comment or blank');
  }
  if (!header) return fail(1, 'a Mermaid entity relationship diagram starts with erDiagram');
  if (open !== null) return fail(lines.length, `entity ${open.name} has no closing brace`);

  const c = new Catalog();
  for (const e of entities) {
    if (!validName(e.name)) {
      c.report('table', e.name, e.name, 'the entity name is not a dbspec name');
      continue;
    }
    c.addTable(e.name);
    const t = present(c.table(e.name), 'c.table(e.name)');
    for (const a of e.attributes) {
      if (!validName(a.name)) {
        c.report('column', e.name, a.name, 'the attribute name is not a dbspec name');
        continue;
      }
      const type = importType(a.type);
      if (type === null) {
        c.report('column', e.name, a.name, `type ${a.type} is not a dbspec type`);
        continue;
      }
      const column = { name: a.name, type, nullable: false, identity: false, dflt: '' };
      if (a.comment !== '') {
        const m = SUFFIX.exec(a.comment + ' ');
        if (m !== null) {
          column.nullable = m[1] !== undefined;
          column.identity = m[2] !== undefined;
          column.dflt = m[3] ?? '';
        } else {
          c.report('comment', e.name, a.name, `the comment ${JSON.stringify(a.comment)} is not a dbspec column suffix`);
        }
      }
      t.columns.push(column);
      if (a.keys.includes('PK')) t.primary.push(a.name);
      if (a.keys.includes('UK')) c.report('unique', e.name, a.name, 'Mermaid does not say which UK attributes form one key');
    }
  }
  const columnIn = (t: ITable, n: string) => t.columns.find(col => col.name === n);
  const isFK = (entityName: string, column: string): boolean => {
    const a = present(byName.get(entityName), 'byName.get(entityName)').attributes.find(x => x.name === column);
    return a !== undefined && a.keys.includes('FK');
  };
  const usedFK = new Map<string, Set<string>>();
  for (const r of relations) {
    let parent = r.left;
    let child = r.right;
    let parentCard = r.leftCard;
    let childCard = r.rightCard;
    const manyRight = r.rightCard.endsWith('{');
    const manyLeft = r.leftCard.startsWith('}');
    if (manyLeft === manyRight) {
      c.report('relationship', r.left, r.label, `the relationship to ${r.right} is not one to many`);
      continue;
    }
    if (manyLeft) [parent, child, parentCard, childCard] = [r.right, r.left, r.rightCard, r.leftCard];
    const m = LABEL.exec(r.label);
    const pt = c.table(parent);
    const ct = c.table(child);
    if (m === null || pt === undefined || ct === undefined) {
      c.report('relationship', child, r.label, 'the label does not give the foreign key columns, or an end is not a table');
      continue;
    }
    const cols = splitNames(present(m[2], 'm[2]'));
    const refs = splitNames(present(m[3], 'm[3]'));
    let ok = cols.length === refs.length;
    let nullable = false;
    if (ok) {
      for (const [i, col] of cols.entries()) {
        const cc = columnIn(ct, col);
        if (cc === undefined || !isFK(child, col) || columnIn(pt, present(refs[i], 'refs[i]')) === undefined) {
          ok = false;
          break;
        }
        nullable = nullable || cc.nullable;
      }
    }
    if (!ok) {
      c.report('relationship', child, present(m[1], 'm[1]'), `its columns are not FK attributes of ${child} or its referenced columns are not attributes of ${parent}`);
      continue;
    }
    let wantParent = nullable ? '|o' : '||';
    if (manyLeft) wantParent = wantParent === '|o' ? 'o|' : '||';
    if (parentCard !== wantParent || (childCard !== 'o{' && childCard !== '}o')) {
      c.report('cardinality', child, present(m[1], 'm[1]'), "the cardinalities differ from the ones the foreign key's nullability gives");
    }
    ct.fks.push({ name: present(m[1], 'm[1]'), columns: cols, table: parent, refs, onDelete: 'restrict', onUpdate: 'restrict' });
    let used = usedFK.get(child);
    if (used === undefined) usedFK.set(child, (used = new Set()));
    for (const col of cols) used.add(col);
    const prefix = ct.primary.slice(0, Math.min(cols.length, ct.primary.length));
    const ix = `ix_${child}_${cols.join('_')}`;
    // An index already added by a foreign key on the same column is not added again.
    const indexed = ct.indexes.some(x => x.name === ix);
    if ((prefix.length !== cols.length || prefix.some((p, i) => p !== cols[i])) && !indexed) {
      ct.indexes.push({ name: ix, columns: cols, desc: cols.map(() => false) });
      c.report('index', child, ix, 'Mermaid has no indexes; the foreign key needs one');
    }
  }
  for (const e of entities) {
    for (const a of e.attributes) {
      if (a.keys.includes('FK') && usedFK.get(e.name)?.has(a.name) !== true && c.table(e.name) !== undefined) {
        c.report('foreign_key', e.name, a.name, 'no relationship gives the foreign key of this FK attribute');
      }
    }
  }
  let result: { document: DbspecDocument; unsupported: DbspecUnsupported[] };
  try {
    result = c.document(name);
  } catch (error) {
    // If the catalog cannot make a document (for example, when the document name is not a dbspec name), it is a one-line diagnostic, as in Go.
    return fail(1, error instanceof Error ? error.message : String(error));
  }
  const noDiagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({
    document: result.document,
    dropped: Object.freeze(result.unsupported.map(u => Object.freeze({ ...u }))),
    diagnostics: noDiagnostics,
  });
}

function splitNames(s: string): string[] {
  return s.split(',').map(p => trimSpace(p));
}

/** If the numeric text is a value from lo to hi inclusive, returns that value; otherwise null. A number over nine digits is out of range. */
function within(digits: string, lo: number, hi: number): number | null {
  const significant = digits.replace(/^0+/, '');
  if (significant.length > 9) return null;
  const n = Number(significant);
  return n >= lo && n <= hi ? n : null;
}

/**
 * If the Mermaid type is a dbspec type, returns that type; otherwise null. If the number is outside the dbspec range
 * (varchar 1-16383, time and datetime 0-6, decimal p 1-18 and s 0-p), it is not a dbspec
 * type. Because the range is decided here, key columns also drop out at the same point for every client.
 */
function importType(s: string): DbspecType | null {
  const m = KNOWN_TYPE.exec(s);
  if (m === null) return null;
  if (m[1] !== undefined) return { kind: present(SIMPLE_KINDS.find(k => k === m[1]), `the simple type ${m[1]}`) };
  if (m[2] !== undefined) {
    const length = within(m[2], 1, 16383);
    return length === null ? null : { kind: 'varchar', length };
  }
  if (m[3] !== undefined) {
    const precision = within(present(m[4], 'm[4]'), 0, 6);
    return precision === null ? null : { kind: m[3] === 'time' ? 'time' : 'datetime', precision };
  }
  const precision = within(present(m[5], 'm[5]'), 1, 18);
  const scale = precision === null ? null : within(present(m[6], 'm[6]'), 0, precision);
  return precision === null || scale === null ? null : { kind: 'decimal', precision, scale };
}
